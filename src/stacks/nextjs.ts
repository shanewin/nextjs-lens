import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { walkFiles } from '../core/helpers.js'
import type { ToolCollector } from '../core/types.js'
import { findWorkspace } from '../core/workspace.js'
import { findDir, getImports, lineOf, parseFile } from './nextjs/ast.js'
import { projectGraph } from './nextjs/graph.js'
import { readMiddleware, matcherMatches, registerAuthTools } from './nextjs/auth.js'
import { registerBoundaryTools } from './nextjs/boundaries.js'
import { buildAppTree, registerRouteTools, resolveAppRoutes, type Finding } from './nextjs/routes.js'
import { registerDataFetchingTools } from './nextjs/fetching.js'
import { SUMMARIES } from './nextjs/summaries.js'
import { registerUnusedTools } from './nextjs/unused.js'

const SECRET_ENV_NAME = /SECRET|PRIVATE|PASSWORD|PASSWD|SERVICE_ROLE|CREDENTIAL|(ADMIN|MASTER|WRITE|ACCESS|SERVER|SIGNING|ENCRYPTION)_?(KEY|TOKEN)|DATABASE_URL|CONNECTION_STRING/i

function nextVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    return ({ ...pkg.dependencies, ...pkg.devDependencies }['next'] as string | undefined) ?? null
  } catch { return null }
}

function majorVersion(range: string | null): number | null {
  const m = range?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}

// ---------------------------------------------------------------------------
// next.config evaluation (literal-only, never executes user code)
// ---------------------------------------------------------------------------

type ConfigValue = string | number | boolean | null | ConfigValue[] | { [k: string]: ConfigValue } | { $expr: string }

function toValue(sf: ts.SourceFile, e: ts.Expression): ConfigValue {
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isNumericLiteral(e)) return Number(e.text)
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false
  if (e.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return toValue(sf, e.expression)
  if (ts.isArrayLiteralExpression(e)) return e.elements.map(el => toValue(sf, el as ts.Expression))
  if (ts.isObjectLiteralExpression(e)) {
    const obj: { [k: string]: ConfigValue } = {}
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) obj[p.name.getText(sf).replace(/^['"]|['"]$/g, '')] = toValue(sf, p.initializer)
      else if (ts.isShorthandPropertyAssignment(p)) obj[p.name.text] = { $expr: p.name.text }
      else if (ts.isMethodDeclaration(p)) obj[p.name.getText(sf)] = { $expr: p.getText(sf).slice(0, 2000) }
    }
    return obj
  }
  return { $expr: e.getText(sf).slice(0, 2000) }
}

/** Find the object literal the config file exports, unwrapping plugin HOFs and local variables. */
function findConfigObject(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const locals = new Map<string, ts.Expression>()
  let exported: ts.Expression | undefined
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer)
    } else if (ts.isExportAssignment(s)) {
      exported = s.expression
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(sf) === 'module.exports') {
      exported = s.expression.right
    }
  }
  const seen = new Set<ts.Node>()
  const unwrap = (e: ts.Expression | undefined): ts.ObjectLiteralExpression | null => {
    if (!e || seen.has(e)) return null
    seen.add(e)
    if (ts.isObjectLiteralExpression(e)) return e
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return unwrap(e.expression)
    if (ts.isIdentifier(e)) return unwrap(locals.get(e.text))
    if (ts.isCallExpression(e)) {
      // withX(config) or withX(opts)(config): try the last argument first
      for (const a of [...e.arguments].reverse()) { const r = unwrap(a); if (r) return r }
      return unwrap(e.expression)
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      // export default (phase) => ({ ... }) or => { return {...} }
      if (!ts.isBlock(e.body)) return unwrap(e.body)
      for (const st of e.body.statements) if (ts.isReturnStatement(st)) { const r = unwrap(st.expression); if (r) return r }
    }
    return null
  }
  return unwrap(exported)
}

function get(obj: ConfigValue | undefined, path: string): ConfigValue | undefined {
  let cur: any = obj
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || '$expr' in cur) return undefined
    cur = cur[k]
  }
  return cur
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Register every Next.js analysis tool for the app at `root`. */
export function registerNextjsTools(tools: ToolCollector, appRoot: string): void {
  // Tools compare and join absolute paths, so normalize a relative root up front
  const root = resolve(appRoot)
  // Every Next.js tool returns a compact summary by default; complete results stay available with detail: 'full'
  const collector = tools
  tools = { register: tool => collector.register(Object.hasOwn(SUMMARIES, tool.name) ? { ...tool, summarize: SUMMARIES[tool.name] } : tool) }
  const appDir = findDir(root, ['src/app', 'app'])
  const pagesDir = findDir(root, ['src/pages', 'pages'])

  registerRouteTools(tools, root, appDir, pagesDir)
  registerBoundaryTools(tools, root, appDir)
  registerAuthTools(tools, root, appDir, pagesDir)
  registerUnusedTools(tools, root, appDir, pagesDir)
  registerDataFetchingTools(tools, root, appDir)

  // ---- Tool: audit_next_config ----
  tools.register({
    name: 'audit_next_config',
    description:
      'Parse next.config.{ts,mjs,js} with the TypeScript AST (unwrapping plugin wrappers like withBundleAnalyzer(config) and phase functions) ' +
      'into a structured config object, then flag misconfigurations: secrets in `env`, wildcard image remotePatterns, SVG without CSP, ' +
      'ignored type/lint errors, production source maps, wildcard serverActions.allowedOrigins, and missing security headers.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const name = ['next.config.ts', 'next.config.mts', 'next.config.mjs', 'next.config.js', 'next.config.cjs'].find(n => existsSync(join(root, n)))
      if (!name) return { error: 'No next.config file found' }
      const sf = parseFile(join(root, name))
      if (!sf) return { error: `Could not read ${name}` }
      const obj = findConfigObject(sf)
      if (!obj) return { file: name, error: 'Could not statically locate the exported config object', content: sf.text.slice(0, 5000) }

      const config = toValue(sf, obj)
      const findings: (Finding & { category: string })[] = []
      const add = (severity: Finding['severity'], category: string, detail: string) => findings.push({ severity, category, detail, file: name })

      if (get(config, 'poweredByHeader') !== false) add('low', 'security', 'poweredByHeader is not false; responses advertise X-Powered-By: Next.js')
      if (get(config, 'reactStrictMode') === false) add('low', 'best-practice', 'reactStrictMode explicitly disabled')

      const env = get(config, 'env')
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        const secretish = Object.keys(env).filter(k => /SECRET|PRIVATE|PASSWORD|TOKEN|SERVICE_ROLE|API_KEY/i.test(k))
        if (secretish.length) add('high', 'security', `env inlines ${secretish.join(', ')} into the JS bundle at build time: these reach the browser if referenced client-side`)
      }

      const patterns = get(config, 'images.remotePatterns')
      if (Array.isArray(patterns) && patterns.some(p => typeof p === 'object' && p && !Array.isArray(p) && (get(p, 'hostname') === '**' || get(p, 'hostname') === '*'))) {
        add('medium', 'security', 'images.remotePatterns allows any hostname: the image optimizer can be used as an open proxy')
      }
      if (Array.isArray(get(config, 'images.domains'))) add('low', 'deprecation', 'images.domains is deprecated: use images.remotePatterns')
      if (get(config, 'images.dangerouslyAllowSVG') === true && get(config, 'images.contentSecurityPolicy') === undefined) {
        add('medium', 'security', 'images.dangerouslyAllowSVG without images.contentSecurityPolicy: SVGs can carry scripts')
      }
      if (get(config, 'typescript.ignoreBuildErrors') === true) add('medium', 'reliability', 'typescript.ignoreBuildErrors ships code that fails type checking')
      if (get(config, 'eslint.ignoreDuringBuilds') === true) add('low', 'reliability', 'eslint.ignoreDuringBuilds is enabled')
      if (get(config, 'productionBrowserSourceMaps') === true) add('medium', 'security', 'productionBrowserSourceMaps exposes original source to anyone in production')

      for (const path of ['experimental.serverActions.allowedOrigins', 'serverActions.allowedOrigins']) {
        const origins = get(config, path)
        if (Array.isArray(origins) && origins.some(o => o === '*' || (typeof o === 'string' && o.startsWith('*')))) {
          add('medium', 'security', `${path} contains a wildcard: weakens the Origin/Host CSRF check for server actions`)
        }
      }

      // Security headers are often built by helpers (e.g. getCspHeader() in lib/csp), so also search the modules
      // next.config and middleware/proxy import directly.
      const mw = readMiddleware(root, new Set())
      const resolver = projectGraph(root).resolver
      const headerSources: { file: string; text: string }[] = [{ file: name, text: JSON.stringify(get(config, 'headers') ?? '') }]
      for (const entry of [name, mw?.file].filter((f): f is string => !!f)) {
        const entrySf = parseFile(join(root, entry))
        if (!entrySf) continue
        if (entry !== name) headerSources.push({ file: entry, text: entrySf.text })
        for (const imp of getImports(entrySf)) {
          if (imp.typeOnly) continue
          const target = resolver.resolve(imp.specifier, join(root, entry))
          const importedSf = target ? parseFile(target) : null
          if (importedSf) headerSources.push({ file: relative(root, target!), text: importedSf.text })
        }
      }
      const securityHeaders: Record<string, string | null> = {}
      for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options']) {
        securityHeaders[h] = headerSources.find(src => src.text.includes(h))?.file ?? null
        if (!securityHeaders[h]) {
          add('info', 'security', `${h} not found in next.config headers(), ${mw?.file ?? 'middleware/proxy'}, or the modules they import` +
            (h === 'Strict-Transport-Security' ? ' (Vercel and many hosts add HSTS automatically)' : ''))
        }
      }

      return {
        file: name,
        next_version: nextVersion(root),
        keys: Object.keys(config as object),
        security_headers_found_in: securityHeaders,
        config,
        findings,
      }
    },
  })

  // ---- Tool: analyze_middleware ----
  tools.register({
    name: 'analyze_middleware',
    description:
      'Analyze middleware.ts / proxy.ts via the AST: parsed matcher config (string, array, or { source } objects), auth logic, ' +
      'redirect/rewrite usage, and, by evaluating each matcher against the real App Router route list, exactly which pages and ' +
      'route handlers the middleware runs on and which it skips. On Next.js 16, gives middleware-to-proxy migration advice that accounts for the Edge runtime.',
    parameters: {
      type: 'object',
      properties: {
        auth_functions: { type: 'string', description: 'Comma-separated names of project-specific auth functions to treat as auth logic (optional). Names listed in .nextjs-lens.json authFunctions are always included.' },
      },
      required: [],
    },
    execute: async (args: { auth_functions?: string }) => {
      const mw = readMiddleware(root, new Set(['auth', 'getToken', 'getSession', 'getUser', 'verifySession', 'jwtVerify', 'verify', ...(args.auth_functions ?? '').split(',').map(n => n.trim()).filter(Boolean)]))
      const major = majorVersion(nextVersion(root))
      if (!mw) return { exists: false, note: `No ${major && major >= 16 ? 'proxy' : 'middleware'} file found in project root or src/` }

      const sf = parseFile(join(root, mw.file))!
      const responses: { call: string; line: number }[] = []
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && /^(NextResponse|Response)\.(redirect|rewrite|next|json)$/.test(n.expression.getText(sf))) {
          responses.push({ call: n.expression.getText(sf), line: lineOf(sf, n) })
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)

      const routes = appDir ? resolveAppRoutes(root, buildAppTree(appDir)).filter(r => r.type === 'page' || r.type === 'route') : []
      const covered = routes.filter(r => mw.matchers === null || mw.matchers.some(m => matcherMatches(m, r.path)))
      const skipped = routes.filter(r => !covered.includes(r))

      const findings: Finding[] = []
      if (mw.matchers === null) findings.push({ severity: 'low', detail: 'No matcher: runs on every request including static assets and images', file: mw.file })
      if (!mw.hasAuthLogic) findings.push({ severity: 'info', detail: `No recognizable auth logic in ${mw.kind}`, file: mw.file })
      // Next.js 16: middleware is deprecated in favor of proxy, but proxy only runs on Node.js and rejects a runtime option.
      // Middleware without runtime: 'nodejs' runs on the Edge runtime, so renaming it changes where it runs.
      if (major !== null && major >= 16) {
        const onEdge = mw.runtime === null || /edge/.test(mw.runtime)
        if (mw.kind === 'middleware' && !onEdge) {
          findings.push({ severity: 'low', detail: 'Next.js 16 renamed middleware to proxy: rename the file to proxy.ts, the export to proxy, and remove the runtime option (proxy always runs on Node.js and rejects it)', file: mw.file })
        } else if (mw.kind === 'middleware') {
          findings.push({
            severity: 'info',
            detail: `middleware is deprecated in Next.js 16, but this file runs on the Edge runtime (${mw.runtime ? `runtime: '${mw.runtime}'` : 'the middleware default'}) and proxy only supports Node.js: rename to proxy.ts only if Node.js is acceptable, otherwise keep middleware for now`,
            file: mw.file,
          })
        } else if (mw.runtime !== null) {
          findings.push({ severity: 'high', detail: `proxy files can't set a runtime: Next.js throws on runtime: '${mw.runtime}'; remove it (proxy always runs on Node.js)`, file: mw.file })
        }
      }
      const skippedRoutes = skipped.filter(r => r.type === 'route')
      if (mw.hasAuthLogic && skippedRoutes.length) {
        const summary = `Route handlers not matched by ${mw.kind} (need their own auth)`
      const handlerPaths = skippedRoutes.map(r => r.path)
      findings.push({ severity: 'info', detail: `${summary}: ${handlerPaths.join(', ')}`, summary, routes: handlerPaths })
      }

      return {
        file: mw.file,
        kind: mw.kind,
        matchers: mw.matchers,
        auth_signals: mw.signals,
        has_auth_logic: mw.hasAuthLogic,
        responses,
        runs_on: covered.map(r => `${r.type === 'route' ? 'API' : 'page'} ${r.path}`),
        skips: skipped.map(r => `${r.type === 'route' ? 'API' : 'page'} ${r.path}`),
        findings,
      }
    },
  })

  // ---- Tool: audit_env_files ----
  tools.register({
    name: 'audit_env_files',
    description:
      'Inventory .env* files and flag secret-looking NEXT_PUBLIC_ variables (inlined into the browser bundle), env files not covered by .gitignore, ' +
      'and NEXT_PUBLIC_ variables referenced in code but defined in no env file.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const envFileNames = [
        '.env', '.env.local', '.env.development', '.env.development.local',
        '.env.production', '.env.production.local', '.env.test', '.env.test.local',
      ]
      const templateNames = ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.dist']
      // In a monorepo, env files often live at the workspace root (loaded via dotenv-cli, turbo, or a symlink)
      const workspaceRoot = findWorkspace(root)?.root
      const dirs = [root, ...(workspaceRoot && workspaceRoot !== root ? [workspaceRoot] : [])]
      const envFiles: { file: string; template: boolean; vars: string[]; public_vars: string[]; suspicious: string[] }[] = []
      const defined = new Set<string>()
      for (const dir of dirs) {
        for (const name of [...envFileNames, ...templateNames]) {
          const p = join(dir, name)
          if (!existsSync(p)) continue
          const vars = readFileSync(p, 'utf-8').split('\n')
            .map(l => l.trim().replace(/^export\s+/, ''))
            .filter(l => l && !l.startsWith('#') && l.includes('='))
            .map(l => l.slice(0, l.indexOf('=')).trim())
          vars.forEach(v => defined.add(v))
          const pub = vars.filter(v => v.startsWith('NEXT_PUBLIC_'))
          envFiles.push({
            file: relative(root, p),
            template: templateNames.includes(name),
            vars,
            public_vars: pub,
            // Bare _KEY/_TOKEN/_SITEKEY names are usually public client keys (analytics, captcha, publishable), so only
            // names that say secret/private/admin-level are flagged
            suspicious: pub.filter(v => SECRET_ENV_NAME.test(v.slice(12))),
          })
        }
      }

      const gitignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf-8').split('\n').map(l => l.trim()) : []
      const ignored = (name: string) => gitignore.some(g => {
        if (!g || g.startsWith('#')) return false
        const re = new RegExp('^/?' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
        return re.test(name)
      })

      const findings: Finding[] = []
      for (const f of envFiles) {
        if (f.suspicious.length) {
          findings.push({
            severity: 'high',
            detail: f.template
              ? `Template defines secret-looking public vars ${f.suspicious.join(', ')}: any deployment that fills them in ships them to the browser`
              : `Secret-looking public vars are shipped to the browser: ${f.suspicious.join(', ')}`,
            file: f.file,
          })
        }
        // .gitignore is checked relative to the app, so only for env files in the app directory itself.
        // .local files hold secrets by convention; Next.js allows committing .env/.env.development/.env.production
        // with non-secret defaults, so those are high only when they contain secret-looking vars.
        if (!f.template && !f.file.includes('/') && !ignored(f.file)) {
          const secrets = f.vars.filter(v => SECRET_ENV_NAME.test(v))
          if (f.file.endsWith('.local') || secrets.length) {
            findings.push({
              severity: 'high',
              detail: `${f.file} is not covered by .gitignore${secrets.length ? ` and contains secret-looking vars: ${secrets.join(', ')}` : ''}`,
              file: f.file,
            })
          } else {
            findings.push({ severity: 'low', detail: `${f.file} is not covered by .gitignore: fine for non-secret defaults, but keep secrets in .env*.local`, file: f.file })
          }
        }
      }

      // NEXT_PUBLIC_ references in code with no definition
      const referenced = new Set<string>()
      const srcRoots = [findDir(root, ['src']) ?? root]
      for (const dir of srcRoots) {
        for (const file of walkFiles(dir, ['.ts', '.tsx', '.js', '.jsx'])) {
          for (const m of (readFileSync(file, 'utf-8').match(/process\.env\.(NEXT_PUBLIC_\w+)/g) ?? [])) referenced.add(m.slice(12))
        }
      }
      const missing = [...referenced].filter(v => !defined.has(v))
      if (envFiles.length && missing.length) {
        findings.push({ severity: 'low', detail: `NEXT_PUBLIC_ vars referenced in code but not defined in any .env file (inlined as undefined at build): ${missing.join(', ')}` })
      }

      const note = envFiles.length === 0
        ? `No .env files or templates found in ${dirs.map(d => relative(root, d) || '.').join(' or ')}`
        : envFiles.every(f => f.template)
          ? 'Only env templates found: real values are likely supplied by the host; results are based on the templates'
          : undefined
      return { env_files: envFiles, ...(note ? { note } : {}), findings }
    },
  })
}
