import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import type { ToolCollector } from '../../core/types.js'
import {
  bodyDirectives, fileDirective, getExports, lineOf, parseFile,
  type ExportInfo, type Resolver,
} from './ast.js'
import { projectGraph } from './graph.js'
import { buildAppTree, HTTP_METHODS, resolveAppRoutes, resolvePagesRoutes, type Finding } from './routes.js'

// ---------------------------------------------------------------------------
// Auth signal detection
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_CALLS = [
  'auth', 'getServerSession', 'getSession', 'currentUser', 'getUser', 'getAuth', 'getToken', 'getCurrentUser', 'getKindeServerSession',
  'requireAuth', 'requireUser', 'requireAdmin', 'requireSession', 'withAuth', 'withApiAuthRequired', 'withPageAuthRequired',
  'protect', 'authenticate', 'isAuthenticated', 'checkAuth', 'ensureAuth', 'verifySession', 'validateRequest', 'getIronSession',
]
const WEBHOOK_SIGNATURE_CALLS = ['constructEvent', 'constructEventAsync', 'verifySignature', 'verifyWebhook', 'verify']

export interface AuthSignal {
  kind: 'auth-call' | 'wrapper' | 'header-check' | 'webhook-signature' | 'secret-check' | 'delegated'
  evidence: string
  line: number
}

// Header names that are credentials wherever they're read
const CREDENTIAL_HEADER = /^(authorization|x-api-key|api-key)$/i
// Names that suggest a credential only when read from headers or cookies
const CREDENTIAL_NAME = /signature|secret|token|hmac/i

/**
 * Is `receiver.get(arg)` reading a credential? Authorization/API-key headers count by name. Signature, secret, and token
 * values count only when read from something header- or cookie-like (`request.headers`, `headersList`, `cookieStore`), so
 * lookups such as `container.get(ServiceModule.token)` don't. CSRF tokens never count: they stop cross-site requests,
 * not anonymous callers.
 */
function isCredentialRead(sf: ts.SourceFile, callee: ts.Expression, arg: ts.Expression): boolean {
  const argText = ts.isStringLiteralLike(arg) ? arg.text : arg.getText(sf)
  if (/csrf/i.test(argText)) return false
  if (ts.isStringLiteralLike(arg) && CREDENTIAL_HEADER.test(arg.text)) return true
  const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf) : ''
  if (!/header|cookie/i.test(receiver)) return false
  if (ts.isStringLiteralLike(arg)) return CREDENTIAL_NAME.test(arg.text)
  return (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) && /SECRET|SIGNATURE|TOKEN|API_?KEY|AUTH/i.test(argText)
}

/** One side of a comparison is a secret: process.env.CRON_SECRET, or a SCREAMING_CASE constant like WEBHOOK_SECRET. */
function isSecretOperand(sf: ts.SourceFile, e: ts.Expression): boolean {
  if (/process\.env\.\w*(SECRET|TOKEN|KEY|PASSWORD)\w*/i.test(e.getText(sf))) return true
  return ts.isIdentifier(e) && /^[A-Z0-9_]*(SECRET|TOKEN)[A-Z0-9_]*$/.test(e.text)
}

const EQUALITY_OPERATORS = [
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

// How many helper calls deep to look for auth evidence: handler → requirePermission() → auth()
const MAX_HELPER_DEPTH = 2

/** Lets auth detection follow calls into helpers imported from other modules. */
export interface HelperContext {
  root: string
  /** File containing the code being inspected, for resolving its imports */
  file: string
  resolver: Resolver
  /** module + export name + depth → auth evidence found there (shared, so each helper is parsed once) */
  cache: Map<string, AuthSignal[]>
}

// One cache per tool run, keyed by that run's auth-call set (created fresh on every run). The resolver is shared across
// runs, so keying by it would reuse results computed with different auth_functions or before a helper file changed.
const helperCaches = new WeakMap<Set<string>, Map<string, AuthSignal[]>>()

export function helperContext(root: string, file: string, resolver: Resolver, authCalls: Set<string>): HelperContext {
  if (!helperCaches.has(authCalls)) helperCaches.set(authCalls, new Map())
  return { root, file, resolver, cache: helperCaches.get(authCalls)! }
}

/** Auth evidence inside an imported function, e.g. `requirePermission` from '@/lib/permissions'. */
function importedHelperSignals(sf: ts.SourceFile, local: string, authCalls: Set<string>, depth: number, ctx: HelperContext): AuthSignal[] {
  const binding = importBinding(sf, local)
  const target = binding ? ctx.resolver.resolve(binding.specifier, ctx.file) : null
  if (!binding || !target) return []
  const key = `${target}\0${binding.name}\0${depth}`
  if (ctx.cache.has(key)) return ctx.cache.get(key)!
  ctx.cache.set(key, []) // guards against import cycles while this helper is being inspected
  const targetSf = parseFile(target)
  const exp = targetSf ? getExports(targetSf).find(e => e.name === binding.name && e.fn) : undefined
  const signals = targetSf && exp?.fn
    ? findAuthSignals(targetSf, exp.fn, authCalls, depth + 1, { ...ctx, file: target })
      .map(s => (s.evidence.includes(' (in ') ? s : { ...s, evidence: `${s.evidence} (in ${relative(ctx.root, target)})` }))
    : []
  ctx.cache.set(key, signals)
  return signals
}

/**
 * Look for auth evidence inside a node, following calls into same-file functions and, when `ctx` is given,
 * into functions imported from other modules (up to MAX_HELPER_DEPTH calls deep).
 */
export function findAuthSignals(sf: ts.SourceFile, node: ts.Node, authCalls: Set<string>, depth = 0, ctx?: HelperContext): AuthSignal[] {
  const out: AuthSignal[] = []
  const localFns = depth < MAX_HELPER_DEPTH ? collectLocalFunctions(sf) : new Map<string, ts.Node>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression)
      const text = n.expression.getText(sf)
      if (name && authCalls.has(name)) out.push({ kind: 'auth-call', evidence: `${text}()`, line: lineOf(sf, n) })
      else if (/\.auth\.getUser$|\.auth\.getSession$|\.auth\.getClaims$/.test(text)) out.push({ kind: 'auth-call', evidence: `${text}()`, line: lineOf(sf, n) })
      else if (name && ((WEBHOOK_SIGNATURE_CALLS.includes(name) && /webhook|stripe|svix|signature|jwt|jose/i.test(sf.text)) || ['createHmac', 'timingSafeEqual'].includes(name))) {
        out.push({ kind: 'webhook-signature', evidence: `${text}()`, line: lineOf(sf, n) })
      } else if (name === 'get' && n.arguments[0] && isCredentialRead(sf, n.expression, n.arguments[0])) {
        out.push({ kind: 'header-check', evidence: `${text}(${n.arguments[0].getText(sf)})`, line: lineOf(sf, n) })
      } else if (name && depth < MAX_HELPER_DEPTH && localFns.has(name)) {
        const inner = findAuthSignals(sf, localFns.get(name)!, authCalls, depth + 1, ctx)
        out.push(...inner.map(s => ({ ...s, evidence: `${name}() → ${s.evidence}` })))
      } else if (ctx && depth < MAX_HELPER_DEPTH && ts.isIdentifier(n.expression)) {
        const inner = importedHelperSignals(sf, n.expression.text, authCalls, depth, ctx)
        out.push(...inner.map(s => ({ ...s, evidence: `${name}() → ${s.evidence}` })))
      }
    }
    if (ts.isBinaryExpression(n) && EQUALITY_OPERATORS.includes(n.operatorToken.kind) && (isSecretOperand(sf, n.left) || isSecretOperand(sf, n.right))) {
      out.push({ kind: 'secret-check', evidence: n.getText(sf).slice(0, 80), line: lineOf(sf, n) })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

// Handlers built by frameworks that enforce auth per procedure/resolver, or that are auth endpoints themselves
const DELEGATING_FACTORIES: Record<string, string> = {
  createNextApiHandler: 'tRPC checks auth per procedure',
  fetchRequestHandler: 'tRPC checks auth per procedure',
  createNextRouteHandler: 'tRPC checks auth per procedure',
  createYoga: 'GraphQL Yoga checks auth per resolver',
  startServerAndCreateNextHandler: 'Apollo Server checks auth per resolver',
  NextAuth: 'Auth.js endpoint; sign-in and callback routes are public by design',
  toNextJsHandler: 'Better Auth endpoint; sign-in and callback routes are public by design',
}

function delegationSignal(sf: ts.SourceFile, node: ts.Node | undefined): AuthSignal | null {
  if (!node) return null
  let found: AuthSignal | null = null
  const visit = (n: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression)
      // hasOwn, not DELEGATING_FACTORIES[name]: `toString` and friends exist on every object
      if (name && Object.hasOwn(DELEGATING_FACTORIES, name)) found = { kind: 'delegated', evidence: `${name}(): ${DELEGATING_FACTORIES[name]}`, line: lineOf(sf, n) }
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** `export const GET = wrap(handler)` or `export const GET = handler` where `handler` is imported: its module and exported name. */
function importedHandler(sf: ts.SourceFile, init: ts.Expression | undefined): { specifier: string; name: string } | null {
  const locals: string[] = []
  const collect = (e: ts.Expression | undefined): void => {
    if (!e) return
    if (ts.isIdentifier(e)) locals.push(e.text)
    else if (ts.isCallExpression(e)) e.arguments.forEach(a => collect(a))
    else if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) collect(e.expression)
  }
  collect(init)
  for (const local of locals) {
    const binding = importBinding(sf, local)
    if (binding) return binding
  }
  return null
}

/** The module and exported name behind an imported local binding, or null if `local` isn't imported. */
function importBinding(sf: ts.SourceFile, local: string): { specifier: string; name: string } | null {
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause || s.importClause.isTypeOnly) continue
    if (s.importClause.name?.text === local) return { specifier: s.moduleSpecifier.text, name: 'default' }
    const nb = s.importClause.namedBindings
    if (nb && ts.isNamedImports(nb)) {
      const el = nb.elements.find(e => e.name.text === local)
      if (el) return { specifier: s.moduleSpecifier.text, name: (el.propertyName ?? el.name).text }
    }
  }
  return null
}

// Routes that are normally public on purpose. An unprotected match is still listed, but reported as info.
const PUBLIC_BY_DESIGN: [RegExp, string][] = [
  [/(^|\/)(health|healthz|healthcheck|status|ping|ready|readiness|liveness|version)$/, 'health or status check'],
  [/(^|\/)csrf(-token)?$/, 'CSRF token endpoint'],
  [/(^|\/)(og|og-image|opengraph-image|twitter-image|robots|sitemap|manifest|favicon|icon|logo|avatar)(\/|$)/, 'public metadata or image'],
  [/(^|\/)(auth|oauth)\/(.*\/)?(login|signin|sign-in|signup|sign-up|register|forgot-password|reset-password|verify-email|magic-link|callback|token|refresh-?token)$/, 'authentication flow'],
]

/** Why an unprotected route is probably meant to be public, or null. Dynamic segments are ignored. */
function publicByDesign(path: string): string | null {
  const normalized = path.toLowerCase().replace(/\/\[[^\]]+\]/g, '')
  return PUBLIC_BY_DESIGN.find(([pattern]) => pattern.test(normalized))?.[1] ?? null
}

/**
 * Auth evidence for one exported route handler. When the handler lives in another module (a re-export
 * (`export { default } from 'pkg/webhook'`) or an imported function passed to a wrapper), follow it there.
 */
function handlerSignals(root: string, file: string, sf: ts.SourceFile, exp: ExportInfo, authCalls: Set<string>, resolver: Resolver, depth = 0): AuthSignal[] {
  const signals: AuthSignal[] = []
  const wrap = wrapperSignal(sf, exp.init, authCalls)
  if (wrap) signals.push(wrap)
  const delegated = delegationSignal(sf, exp.init ?? exp.fn)
  if (delegated) signals.push(delegated)
  if (exp.fn) signals.push(...findAuthSignals(sf, exp.fn, authCalls, 0, helperContext(root, file, resolver, authCalls)))
  if (signals.length || depth >= 3) return signals

  const target = exp.from ? { specifier: exp.from, name: exp.originalName ?? exp.name } : importedHandler(sf, exp.init)
  if (!target) return signals
  const targetFile = resolver.resolve(target.specifier, file)
  const targetSf = targetFile ? parseFile(targetFile) : null
  const targetExp = targetSf ? getExports(targetSf).find(e => e.name === target.name) : undefined
  if (!targetFile || !targetSf || !targetExp) return signals
  return handlerSignals(root, targetFile, targetSf, targetExp, authCalls, resolver, depth + 1)
    .map(s => s.evidence.includes(' (in ') ? s : { ...s, evidence: `${s.evidence} (in ${relative(root, targetFile)})` })
}

function collectLocalFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const map = new Map<string, ts.Node>()
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) map.set(s.name.text, s.body)
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          map.set(d.name.text, d.initializer.body)
        }
      }
    }
  }
  return map
}

/** Does the export's initializer wrap the handler in an auth HOF? e.g. `export const GET = withAuth(async () => ...)` */
function wrapperSignal(sf: ts.SourceFile, init: ts.Expression | undefined, authCalls: Set<string>): AuthSignal | null {
  let e = init
  while (e && ts.isCallExpression(e)) {
    const name = calleeName(e.expression)
    if (name && (authCalls.has(name) || /^with\w*(Auth|Session|User|Admin|Protect)/i.test(name))) {
      return { kind: 'wrapper', evidence: `${name}(...)`, line: lineOf(sf, e) }
    }
    e = e.arguments[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Middleware / proxy
// ---------------------------------------------------------------------------

export interface MiddlewareInfo {
  file: string
  kind: 'middleware' | 'proxy'
  matchers: string[] | null   // null = runs on every route
  /** `config.runtime` or `export const runtime`, when set to a string */
  runtime: string | null
  hasAuthLogic: boolean
  signals: AuthSignal[]
}

/**
 * Hand-rolled middleware auth: reads a session-like cookie AND redirects to a login page or responds 401/403.
 * A cookie read plus any redirect (e.g. a `return-to` cookie) is not enough.
 */
function sessionCookieGate(sf: ts.SourceFile): boolean {
  let readsSessionCookie = false
  let denies = false
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf)
      const arg = n.arguments[0]
      if (/cookies(\(\)\)?)?\.(get|has)$/.test(callee) && arg && ts.isStringLiteralLike(arg) && /session|auth|token|jwt|\bsid\b|logged/i.test(arg.text)) {
        readsSessionCookie = true
      }
      if (/(NextResponse|Response)\.redirect$/.test(callee) && arg && /login|signin|sign-in|sign_in|auth/i.test(arg.getText(sf))) denies = true
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'status' && /^40[13]$/.test(n.initializer.getText(sf))) denies = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return readsSessionCookie && denies
}

export function readMiddleware(root: string, authCalls: Set<string>): MiddlewareInfo | null {
  for (const base of ['proxy', 'middleware']) {
    for (const dir of ['src', '']) {
      for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.mjs']) {
        const p = join(root, dir, base + ext)
        if (!existsSync(p)) continue
        const sf = parseFile(p)
        if (!sf) continue
        let matchers: string[] | null = null
        const config = getExports(sf).find(e => e.name === 'config' && e.init)
        if (config?.init && ts.isObjectLiteralExpression(config.init)) {
          const prop = config.init.properties.find(pr => ts.isPropertyAssignment(pr) && pr.name.getText(sf) === 'matcher') as ts.PropertyAssignment | undefined
          if (prop) matchers = matcherStrings(prop.initializer)
        }
        const runtimeProp = config?.init && ts.isObjectLiteralExpression(config.init)
          ? config.init.properties.find(pr => ts.isPropertyAssignment(pr) && pr.name.getText(sf) === 'runtime') as ts.PropertyAssignment | undefined
          : undefined
        const runtimeExpr = runtimeProp?.initializer ?? getExports(sf).find(e => e.name === 'runtime' && e.init)?.init
        const runtime = runtimeExpr && ts.isStringLiteralLike(runtimeExpr) ? runtimeExpr.text : null
        const signals = findAuthSignals(sf, sf, authCalls, 0, helperContext(root, p, projectGraph(root).resolver, authCalls))
        return { file: relative(root, p), kind: base as 'middleware' | 'proxy', matchers, runtime, hasAuthLogic: signals.length > 0 || sessionCookieGate(sf), signals }
      }
    }
  }
  return null
}

function matcherStrings(e: ts.Expression): string[] {
  if (ts.isStringLiteralLike(e)) return [e.text]
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.flatMap(el => {
      if (ts.isStringLiteralLike(el)) return [el.text]
      if (ts.isObjectLiteralExpression(el)) {
        const src = el.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'source') as ts.PropertyAssignment | undefined
        return src && ts.isStringLiteralLike(src.initializer) ? [src.initializer.text] : []
      }
      return []
    })
  }
  return []
}

/** Approximate path-to-regexp matching used by middleware matchers. */
export function matcherMatches(matcher: string, path: string): boolean {
  // Turn route params into a concrete sample so '/dashboard/[id]' tests as '/dashboard/x'
  const sample = path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, 'x/y').replace(/\[[^\]]+\]/g, 'x')
  let re = ''
  for (let i = 0; i < matcher.length; i++) {
    const ch = matcher[i]
    if (ch === ':') {
      const m = matcher.slice(i).match(/^:(\w+)(\([^)]*\))?([*+?])?/)!
      const group = m[2] ? m[2].slice(1, -1) : '[^/]+'
      if (m[3] === '*') { re = re.replace(/\/$/, '') + `(?:/${group})*`; }
      else if (m[3] === '+') { re += `${group}(?:/${group})*` }
      else if (m[3] === '?') { re = re.replace(/\/$/, '') + `(?:/${group})?` }
      else re += group
      i += m[0].length - 1
    } else if (ch === '(') {
      const close = matchParen(matcher, i)
      re += matcher.slice(i, close + 1)
      i = close
    } else if (/[.+?^${}|[\]\\]/.test(ch)) {
      re += ch === '.' ? '\\.' : `\\${ch}`
    } else if (ch === '*') {
      re += '.*'
    } else {
      re += ch
    }
  }
  try { return new RegExp(`^${re}/?$`).test(sample) } catch { return false }
}

function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return i
  }
  return s.length - 1
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const DESTRUCTIVE_NAME = /delete|remove|destroy|drop|purge|wipe|erase|truncate/i
// Call names that destroy records. Generic `.remove()` is excluded: it's common for lists, sets, and DOM nodes.
const DESTRUCTIVE_CALL = /^(delete|deleteMany|deleteOne|destroy|destroyAll|drop|dropTable|truncate|purge)$/i
const DESTRUCTIVE_SQL = /\b(DELETE\s+FROM|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i

/** Evidence that a function destroys data: a delete-style call, destructive SQL, or a destructive function name. */
function destructiveEvidence(sf: ts.SourceFile, node: ts.Node, name: string): string | null {
  let evidence: string | null = null
  const visit = (n: ts.Node): void => {
    if (evidence) return
    if (ts.isCallExpression(n) && DESTRUCTIVE_CALL.test(calleeName(n.expression) ?? '')) evidence = `${n.expression.getText(sf)}()`
    else if (ts.isStringLiteralLike(n) && DESTRUCTIVE_SQL.test(n.text)) evidence = `SQL "${n.text.slice(0, 60)}"`
    ts.forEachChild(n, visit)
  }
  visit(node)
  return evidence ?? (DESTRUCTIVE_NAME.test(name) ? `name "${name}"` : null)
}

const DATA_EXPORT_NAME = /export|download|dump|backup/i
const CACHE_CALLS = new Set(['revalidatePath', 'revalidateTag', 'updateTag', 'expirePath', 'expireTag', 'refresh'])

/** An action whose name says it hands data back to the caller (exportData, downloadInvoices, …). */
function dataExportEvidence(name: string): string | null {
  return DATA_EXPORT_NAME.test(name) ? `name "${name}"` : null
}

/** True when every call in the action is a cache revalidation, e.g. `async function refreshList() { revalidatePath('/list') }`. */
function isCacheOnly(node: ts.Node): boolean {
  const calls: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) calls.push(calleeName(n.expression) ?? '')
    ts.forEachChild(n, visit)
  }
  visit(node)
  return calls.length > 0 && calls.every(c => CACHE_CALLS.has(c))
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

function authCallSet(extra?: string): Set<string> {
  return new Set([...DEFAULT_AUTH_CALLS, ...(extra ?? '').split(',').map(s => s.trim()).filter(Boolean)])
}

const EXTRA_PATTERNS_PARAM = {
  type: 'string',
  description: 'Comma-separated names of project-specific auth functions to treat as auth checks, e.g. "requireOrgMember,assertAdmin" (optional). Names listed in .nextjs-lens.json authFunctions are always included.',
}

export function registerAuthTools(tools: ToolCollector, root: string, appDir: string | null, pagesDir: string | null): void {

  tools.register({
    name: 'audit_route_auth',
    description:
      'Auth coverage audit for every API endpoint: App Router route handlers (per exported HTTP method, including `export const POST = withAuth(...)` ' +
      'and `export { handler as GET }`) and Pages Router API routes. Inspects each handler body with the TypeScript AST for auth calls ' +
      '(auth(), getServerSession, currentUser, supabase.auth.getUser, …), auth wrappers, Authorization/API-key header checks, and webhook signature ' +
      'verification, following calls into same-file helpers. Cross-references the middleware/proxy matcher to show which endpoints are only protected ' +
      'by middleware. Follows auth helpers imported from other modules, and handlers defined in other modules (re-exports and imported functions passed to wrappers), recognizes ' +
      'signature and shared-secret checks, and marks tRPC/GraphQL/Auth.js handlers as delegated (auth happens per procedure, or the route ' +
      'is the auth endpoint). Unprotected mutations (POST/PUT/PATCH/DELETE) are high severity; unprotected routes that are usually public ' +
      'by design (health checks, CSRF tokens, sign-in flows, OG images) are reported as info with the reason.',
    parameters: {
      type: 'object',
      properties: { auth_functions: EXTRA_PATTERNS_PARAM },
      required: [],
    },
    execute: async (args: { auth_functions?: string }) => {
      const authCalls = authCallSet(args.auth_functions)
      const mw = readMiddleware(root, authCalls)
      const resolver = projectGraph(root).resolver
      const coveredByMiddleware = (path: string) =>
        !!mw?.hasAuthLogic && (mw.matchers === null || mw.matchers.some(m => matcherMatches(m, path)))

      const endpoints: {
        path: string; method: string; file: string; line: number
        status: 'protected' | 'delegated' | 'middleware-only' | 'unprotected'
        signals: AuthSignal[]
        /** For unprotected routes that are usually public on purpose: why */
        likely_public: string | null
      }[] = []

      const classify = (path: string, method: string, file: string, line: number, signals: AuthSignal[]) => {
        const status = signals.some(s => s.kind !== 'delegated') ? 'protected'
          : signals.length ? 'delegated'
          : coveredByMiddleware(path) ? 'middleware-only'
          : 'unprotected'
        endpoints.push({ path, method, file, line, status, signals, likely_public: status === 'unprotected' ? publicByDesign(path) : null })
      }

      if (appDir) {
        for (const r of resolveAppRoutes(root, buildAppTree(appDir)).filter(r => r.type === 'route')) {
          const sf = parseFile(join(root, r.file))
          if (!sf) continue
          for (const exp of getExports(sf).filter(e => HTTP_METHODS.includes(e.name))) {
            classify(r.path, exp.name, r.file, exp.line, handlerSignals(root, join(root, r.file), sf, exp, authCalls, resolver))
          }
        }
      }
      if (pagesDir) {
        for (const r of resolvePagesRoutes(root, pagesDir).filter(r => r.type === 'pages-api')) {
          const sf = parseFile(join(root, r.file))
          if (!sf) continue
          const def = getExports(sf).find(e => e.name === 'default')
          classify(r.path, 'ANY', r.file, def?.line ?? 1, def ? handlerSignals(root, join(root, r.file), sf, def, authCalls, resolver) : [])
        }
      }

      const findings: Finding[] = []
      for (const e of endpoints) {
        const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(e.method)
        if (e.status === 'unprotected') {
          findings.push({
            severity: e.likely_public ? 'info' : mutation ? 'high' : 'low',
            detail: `${e.method} ${e.path} has no auth check in the handler and is not covered by ${mw ? `${mw.kind} matcher` : 'any middleware/proxy'}` +
              (e.likely_public ? `; likely public by design (${e.likely_public}), so confirm it exposes nothing sensitive` : ''),
            file: `${e.file}:${e.line}`,
            route: e.path,
          })
        } else if (e.status === 'middleware-only' && mutation) {
          findings.push({
            severity: 'medium',
            detail: `${e.method} ${e.path} relies solely on ${mw!.kind} for auth: a matcher change or CVE-2025-29927-style bypass leaves it open; check auth in the handler too`,
            file: `${e.file}:${e.line}`,
            route: e.path,
          })
        }
      }
      if (mw && !mw.hasAuthLogic) {
        findings.push({ severity: 'info', detail: `${mw.file} has no recognizable auth logic, so it does not count as protection`, file: mw.file })
      }

      const summary = {
        total: endpoints.length,
        protected: endpoints.filter(e => e.status === 'protected').length,
        delegated: endpoints.filter(e => e.status === 'delegated').length,
        middleware_only: endpoints.filter(e => e.status === 'middleware-only').length,
        unprotected: endpoints.filter(e => e.status === 'unprotected').length,
        likely_public: endpoints.filter(e => e.likely_public).length,
      }
      return { summary, middleware: mw, endpoints, findings }
    },
  })

  tools.register({
    name: 'find_server_actions',
    description:
      'Find every Server Action via the AST: exports of \'use server\' modules (functions, arrow consts, `export { x }`) and inline functions with a ' +
      '\'use server\' body directive. For each action: auth checks in the body (following same-file helpers), input validation ' +
      '(zod/valibot/yup parse), and which client/server files import it. Actions are public POST endpoints, so missing auth is flagged per action.',
    parameters: {
      type: 'object',
      properties: { auth_functions: EXTRA_PATTERNS_PARAM },
      required: [],
    },
    execute: async (args: { auth_functions?: string }) => {
      const authCalls = authCallSet(args.auth_functions)
      const graph = projectGraph(root)
      const { resolver, files } = graph

      const actions: {
        name: string; file: string; line: number; type: 'module' | 'inline'
        auth: AuthSignal[]; destructive: string | null; data_export: string | null; cache_only: boolean
        validates_input: boolean; used_by: string[]
      }[] = []
      const validation = (sf: ts.SourceFile, node: ts.Node) => {
        let found = false
        const visit = (n: ts.Node): void => {
          if (found) return
          if (ts.isCallExpression(n) && /^(parse|safeParse|parseAsync|safeParseAsync|validate|validateSync)$/.test(calleeName(n.expression) ?? '')) found = true
          ts.forEachChild(n, visit)
        }
        visit(node)
        return found
      }

      for (const file of files) {
        const sf = parseFile(file)
        if (!sf) continue
        const rel = relative(root, file)
        if (fileDirective(sf) === 'use server') {
          for (const exp of getExports(sf)) {
            if (exp.typeOnly || !exp.fn) continue
            actions.push({
              name: exp.name, file: rel, line: exp.line, type: 'module',
              auth: findAuthSignals(sf, exp.fn, authCalls, 0, helperContext(root, file, resolver, authCalls)), destructive: destructiveEvidence(sf, exp.fn, exp.name),
              data_export: dataExportEvidence(exp.name), cache_only: isCacheOnly(exp.fn),
              validates_input: validation(sf, exp.fn), used_by: [],
            })
          }
        }
        const visit = (n: ts.Node): void => {
          if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && bodyDirectives(n).includes('use server')) {
            const name = ts.isFunctionDeclaration(n) && n.name ? n.name.text
              : ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : '(anonymous)'
            actions.push({
              name, file: rel, line: lineOf(sf, n), type: 'inline',
              auth: findAuthSignals(sf, n, authCalls, 0, helperContext(root, file, resolver, authCalls)), destructive: destructiveEvidence(sf, n, name),
              data_export: dataExportEvidence(name), cache_only: isCacheOnly(n),
              validates_input: validation(sf, n), used_by: [],
            })
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }

      // Who imports each module-level action?
      const byFile = new Map<string, typeof actions>()
      for (const a of actions.filter(a => a.type === 'module')) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a])
      if (byFile.size) {
        for (const file of files) {
          for (const imp of graph.importsOf(file)) {
            const acts = imp.resolved && byFile.get(relative(root, imp.resolved))
            if (!acts) continue
            for (const a of acts) {
              if (imp.names.includes(a.name) || imp.names.includes('*')) a.used_by.push(relative(root, file))
            }
          }
        }
      }

      // Unauthenticated actions, graded by what an anonymous caller could do with them
      const unauthenticated = (a: (typeof actions)[number]): Finding => {
        const file = `${a.file}:${a.line}`
        if (a.destructive) {
          return { severity: 'critical', detail: `Server action ${a.name} destroys data (${a.destructive}) with no auth check: anyone can call it via POST with its action ID`, file }
        }
        if (a.data_export) {
          return { severity: 'high', detail: `Server action ${a.name} exports data (${a.data_export}) with no auth check: anyone can call it via POST and receive the result`, file }
        }
        if (a.cache_only) {
          return { severity: 'low', detail: `Server action ${a.name} has no auth check, but it only revalidates cached data: an anonymous caller can at most force a cache refresh`, file }
        }
        return { severity: 'medium', detail: `Server action ${a.name} has no auth check: it is callable by anyone via POST with its action ID`, file }
      }
      const findings: Finding[] = actions.filter(a => a.auth.length === 0).map(unauthenticated)
      for (const a of actions.filter(a => !a.validates_input && !a.cache_only)) {
        findings.push({ severity: 'low', detail: `Server action ${a.name} does not validate its input with a schema parse`, file: `${a.file}:${a.line}` })
      }
      findings.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])
      return { count: actions.length, actions, findings }
    },
  })
}
