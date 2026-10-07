import { relative } from 'node:path'
import ts from 'typescript'
import type { ToolCollector } from '../../core/types.js'
import { fileDirective, getExports, parseFile } from './ast.js'
import { projectGraph, type ProjectGraph } from './graph.js'
import { buildAppTree, type Finding, type SegmentNode } from './routes.js'

// Node builtins with no browser fallback. Next.js polyfills process, path, crypto, os, zlib, buffer, stream, util,
// events, http(s), assert, querystring, … for client bundles (webpack-config.ts `fallback`), so those are safe.
const SERVER_ONLY_BUILTINS = new Set([
  'fs', 'fs/promises', 'child_process', 'net', 'tls', 'dns', 'dgram', 'cluster', 'worker_threads',
  'module', 'readline', 'repl', 'inspector', 'v8', 'async_hooks', 'perf_hooks', 'http2',
])
// Packages that must never end up in the browser bundle
const SERVER_ONLY_PACKAGES = [
  'server-only', 'next/headers',
  '@prisma/client', 'prisma', 'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'ioredis', 'redis', 'bcrypt', 'bcryptjs', 'argon2',
  'jsonwebtoken', 'nodemailer', 'stripe', 'firebase-admin', '@aws-sdk/client-s3', 'sharp', 'drizzle-orm/node-postgres', '@vercel/postgres',
]
// Hooks/APIs that require a Client Component
const CLIENT_ONLY_IMPORTS: Record<string, string[]> = {
  react: ['useState', 'useEffect', 'useLayoutEffect', 'useReducer', 'useRef', 'useContext', 'useTransition', 'useOptimistic', 'useActionState', 'useSyncExternalStore', 'useImperativeHandle', 'useInsertionEffect', 'createContext'],
  'react-dom': ['useFormStatus'],
  'next/navigation': ['useRouter', 'usePathname', 'useSearchParams', 'useParams', 'useSelectedLayoutSegment', 'useSelectedLayoutSegments'],
}
const BROWSER_GLOBALS = new Set(['window', 'document', 'localStorage', 'sessionStorage', 'navigator'])
const BROWSER_GUARD = /typeof\s+(window|document|localStorage|sessionStorage|navigator|globalThis\.window)\b|\b(isBrowser|isClient|isClientSide|inBrowser|IS_BROWSER|IS_CLIENT|canUseDOM)\b|!\s*(isServer|IS_SERVER|isSSR|isServerSide)\b/

// App Router files rendered as Server Components unless marked 'use client'
const SERVER_ENTRY_FILES = ['page', 'layout', 'template', 'loading', 'not-found', 'forbidden', 'unauthorized', 'default'] as const

type Env = 'server' | 'client'

interface FileFacts {
  directive: string | null
  imports: { resolved: string | null; specifier: string; line: number; typeOnly: boolean; names: string[] | null }[]
  /** For pure barrel files (only re-exports): what each exported name points at. Null for any other file. */
  barrel: { name: string; originalName: string; resolved: string | null; line: number; typeOnly: boolean }[] | null
  clientApis: string[]          // hooks / createContext used
  browserGlobals: string[]      // top-of-render browser globals referenced
  privateEnvVars: string[]      // process.env.X without NEXT_PUBLIC_
}

/**
 * What happens when client code imports a server-only module. The 'server-only' marker, next/headers, and Node builtins
 * without a browser fallback make `next build` fail, so nothing ships; other server packages get bundled for the browser.
 */
function describeLeak(file: string, spec: string, chain: string[]): { detail: string; effect: 'build-fails' | 'ships-to-browser' } {
  const path = chain.join(' → ')
  const fix = 'Keep it on the server: load the data in a Server Component or server action and pass the result down.'
  const bare = spec.replace(/^node:/, '')
  if (bare === 'server-only') {
    return { effect: 'build-fails', detail: `Server-only module ${file} (it imports "server-only") is imported by client code, so \`next build\` fails and it never reaches the browser: ${path}. ${fix}` }
  }
  if (bare === 'next/headers' || bare.startsWith('next/headers/')) {
    return { effect: 'build-fails', detail: `Server-only module "next/headers" (used by ${file}) is imported by client code, so \`next build\` fails: ${path}. ${fix}` }
  }
  if (SERVER_ONLY_BUILTINS.has(bare)) {
    return { effect: 'build-fails', detail: `Server-only module "${spec}" (Node builtin with no browser version, used by ${file}) is imported by client code, so the client build breaks: ${path}. ${fix}` }
  }
  return { effect: 'ships-to-browser', detail: `Server-only module "${spec}" (used by ${file}) is pulled into the client bundle: ${path}. Depending on the package, the build fails or server code ships to the browser. ${fix}` }
}

function isBareOrBuiltin(spec: string): string | null {
  const s = spec.replace(/^node:/, '')
  if (SERVER_ONLY_BUILTINS.has(s)) return spec
  return SERVER_ONLY_PACKAGES.find(p => s === p || s.startsWith(p + '/')) ?? null
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p
  return null
}

function functionName(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text
  const p = fn.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  // const useX = memoize(() => ...)
  if (p && ts.isCallExpression(p) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text
  return null
}

/** Inside a custom hook definition (useX)? Then the hook's caller decides where it runs, not this file. */
function isInsideHookDefinition(node: ts.Node): boolean {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    if (/^use[A-Z0-9]/.test(functionName(fn) ?? '')) return true
  }
  return false
}

/**
 * A browser global evaluated when the module loads (not inside a function, not a declared name, not typeof-guarded).
 * Those throw during server rendering; references inside functions only run if called.
 */
function isModuleScopeGlobalReference(node: ts.Identifier): boolean {
  const p = node.parent
  if (!p) return false
  if (ts.isTypeOfExpression(p) || ts.isTypeQueryNode(p)) return false
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false
  if ((ts.isBindingElement(p) || ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)
    || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return false
  if (ts.isBindingElement(p) && p.propertyName === node) return false
  for (let a: ts.Node | undefined = p; a && !ts.isSourceFile(a); a = a.parent) {
    if (ts.isFunctionLike(a) || ts.isClassLike(a)) return false
    // Any `typeof window/document/…` check or a conventional flag (isBrowser, !isServer, …) means "in a browser",
    // so it guards every browser global. Only the condition counts, not the guarded body.
    const condition = ts.isIfStatement(a) ? a.expression
      : ts.isConditionalExpression(a) ? a.condition
      : ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? a.left
      : null
    if (condition && BROWSER_GUARD.test(condition.getText())) return false
  }
  return true
}

function collectFacts(file: string, graph: ProjectGraph): FileFacts | null {
  const sf = parseFile(file)
  if (!sf) return null
  const imports = graph.importsOf(file).map(i => ({
    resolved: i.resolved,
    specifier: i.specifier,
    line: i.line,
    typeOnly: i.typeOnly,
    // null = the importer may use anything the module provides (namespace, dynamic, or side-effect import)
    names: i.sideEffect || i.dynamic || i.names.includes('*') || i.names.length === 0 ? null : i.names,
  }))

  // A pure barrel only forwards other modules, so importing one name from it pulls in just that name's module
  const pureBarrel = sf.statements.length > 0 && sf.statements.every(s =>
    (ts.isExportDeclaration(s) && !!s.moduleSpecifier) ||
    (ts.isImportDeclaration(s) && !!s.importClause?.isTypeOnly) ||
    ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) ||
    (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)))
  const barrel = pureBarrel
    ? getExports(sf).filter(e => e.from).map(e => ({
      name: e.kind === 'star' ? '*' : e.name,
      originalName: e.kind === 'star' ? '*' : e.originalName ?? e.name,
      resolved: graph.resolver.resolve(e.from!, file),
      line: e.line,
      typeOnly: e.typeOnly,
    }))
    : null

  // Which local names are client-only imports?
  const clientLocals = new Map<string, string>()
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue
    const list = Object.hasOwn(CLIENT_ONLY_IMPORTS, s.moduleSpecifier.text) ? CLIENT_ONLY_IMPORTS[s.moduleSpecifier.text] : undefined
    const nb = s.importClause?.namedBindings
    if (!list || !nb || !ts.isNamedImports(nb)) continue
    for (const el of nb.elements) {
      const orig = (el.propertyName ?? el.name).text
      if (list.includes(orig)) clientLocals.set(el.name.text, orig)
    }
  }

  // Module-scope imports/declarations shadow browser globals at module scope, e.g. `import { localStorage } from './webstorage'`.
  // Function-local names (`const { window } = opts`) don't affect module scope, which is the only scope reported.
  const declaredNames = new Set<string>()
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declaredNames.add(name.text)
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name)
  }
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause) {
      if (s.importClause.name) declaredNames.add(s.importClause.name.text)
      const nb = s.importClause.namedBindings
      if (nb && ts.isNamespaceImport(nb)) declaredNames.add(nb.name.text)
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) declaredNames.add(el.name.text)
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) addBinding(d.name)
    } else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) {
      declaredNames.add(s.name.text)
    }
  }

  const clientApis = new Set<string>()
  const browserGlobals = new Set<string>()
  const privateEnvVars = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const api = ts.isIdentifier(callee) && clientLocals.has(callee.text) ? clientLocals.get(callee.text)!
        // React.useState(...)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React'
          && CLIENT_ONLY_IMPORTS.react.includes(callee.name.text) ? callee.name.text
        : null
      // createContext fails at import in the react-server build; hooks only fail when a component calls them during render
      if (api && (api === 'createContext' || !isInsideHookDefinition(node))) clientApis.add(api)
    }
    if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text) && !declaredNames.has(node.text) && isModuleScopeGlobalReference(node)) {
      browserGlobals.add(node.text)
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(sf) === 'process.env' && !node.name.text.startsWith('NEXT_PUBLIC_') && node.name.text !== 'NODE_ENV') {
      privateEnvVars.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return { directive: fileDirective(sf), imports, barrel, clientApis: [...clientApis], browserGlobals: [...browserGlobals], privateEnvVars: [...privateEnvVars] }
}

function serverEntries(tree: SegmentNode): string[] {
  const out: string[] = []
  const walk = (n: SegmentNode): void => {
    for (const f of SERVER_ENTRY_FILES) if (n.files[f] && !/\.mdx?$/.test(n.files[f]!)) out.push(n.files[f]!)
    n.children.forEach(walk)
  }
  walk(tree)
  return out
}

export interface BoundaryAnalysis {
  envs: Map<string, Set<Env>>
  /** Client-environment import edges, reversed: file → files that import it in the client bundle */
  clientImporters: Map<string, Set<string>>
  /** For each (file, env), the file that first pulled it in (for chain reconstruction) */
  parents: Map<string, string | null>
  boundaries: { from: string; to: string; line: number }[]
  facts: Map<string, FileFacts>
  entries: string[]
}

export function analyzeBoundaries(root: string, appDir: string): BoundaryAnalysis {
  const graph = projectGraph(root)
  const facts = new Map<string, FileFacts>()
  const getFacts = (f: string) => {
    if (!facts.has(f)) facts.set(f, collectFacts(f, graph)!)
    return facts.get(f)
  }

  const envs = new Map<string, Set<Env>>()
  const parents = new Map<string, string | null>()
  const boundaries: BoundaryAnalysis['boundaries'] = []
  const clientImporters = new Map<string, Set<string>>()
  const entries = serverEntries(buildAppTree(appDir))

  // BFS over (file, env, names requested from it). Names only matter for pure barrels; null = everything.
  const queue: [string, Env, string | null, string[] | null][] = entries.map(e => [e, 'server', null, null])
  const barrelNamesSeen = new Set<string>()
  const barrelFullySeen = new Set<string>()
  while (queue.length) {
    const [file, incomingEnv, parent, names] = queue.shift()!
    const f = getFacts(file)
    if (!f) continue
    // A 'use client' module switches the subtree to client; a 'use server' module imported by client code
    // becomes an action reference, so its imports stay on the server.
    const env: Env = f.directive === 'use client' ? 'client' : incomingEnv
    if (incomingEnv === 'client' && f.directive === 'use server') continue
    const set = envs.get(file) ?? new Set<Env>()
    const firstVisit = !set.has(env)
    if (firstVisit) {
      // A page/layout that is itself 'use client' is a boundary at the router level
      if (parent === null && env === 'client') boundaries.push({ from: '(App Router)', to: relative(root, file), line: 1 })
      set.add(env)
      envs.set(file, set)
      const key = `${file}\0${env}`
      if (!parents.has(key)) parents.set(key, parent)
    }

    let edges: { resolved: string; line: number; names: string[] | null }[]
    const envKey = `${file}\0${env}`
    if (f.barrel && names && !barrelFullySeen.has(envKey)) {
      // Follow only the re-exports that supply the requested names (through `export *` when not named directly)
      const fresh = names.filter(n => !barrelNamesSeen.has(`${envKey}\0${n}`))
      if (!fresh.length) continue
      fresh.forEach(n => barrelNamesSeen.add(`${envKey}\0${n}`))
      edges = []
      for (const n of fresh) {
        const live = f.barrel.filter(r => !r.typeOnly && r.resolved)
        const direct = live.filter(r => r.name === n)
        const via = direct.length ? direct : live.filter(r => r.name === '*')
        for (const r of via) {
          edges.push({ resolved: r.resolved!, line: r.line, names: r.originalName === '*' ? (r.name === '*' ? [n] : null) : [r.originalName] })
        }
      }
    } else {
      if (f.barrel) {
        if (barrelFullySeen.has(envKey)) continue
        barrelFullySeen.add(envKey)
      } else if (!firstVisit) {
        continue
      }
      edges = f.imports.filter(i => !i.typeOnly && i.resolved).map(i => ({ resolved: i.resolved!, line: i.line, names: i.names }))
    }

    for (const edge of edges) {
      if (env === 'client') {
        const importers = clientImporters.get(edge.resolved) ?? new Set<string>()
        importers.add(file)
        clientImporters.set(edge.resolved, importers)
      }
      const target = getFacts(edge.resolved)
      if (env === 'server' && target?.directive === 'use client') {
        boundaries.push({ from: relative(root, file), to: relative(root, edge.resolved), line: edge.line })
      }
      queue.push([edge.resolved, env, file, edge.names])
    }
  }
  return { envs, clientImporters, parents, boundaries, facts, entries }
}

/**
 * Every distinct import chain from a 'use client' module down to `target`, following client-bundle import edges
 * backwards and stopping at the first 'use client' file on each path (that's where the fix goes).
 */
export function clientChainsTo(root: string, a: BoundaryAnalysis, target: string, limit = 25): { chains: string[][]; truncated: boolean } {
  const chains: string[][] = []
  let truncated = false
  const walk = (file: string, below: string[]): void => {
    if (chains.length >= limit) { truncated = true; return }
    const path = [file, ...below]
    const importers = a.clientImporters.get(file)
    if (a.facts.get(file)?.directive === 'use client' || !importers?.size) {
      chains.push(path.map(f => relative(root, f)))
      return
    }
    for (const importer of importers) {
      if (!path.includes(importer)) walk(importer, path)
    }
  }
  walk(target, [])
  return { chains, truncated }
}

function chainTo(root: string, a: BoundaryAnalysis, file: string, env: Env): string[] {
  const chain: string[] = []
  let cur: string | null = file
  let curEnv: Env = env
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    chain.unshift(relative(root, cur))
    let parent: string | null | undefined = a.parents.get(`${cur}\0${curEnv}`)
    // The parent of a 'use client' boundary file lives in the server env
    if (parent === undefined && curEnv === 'client') { curEnv = 'server'; parent = a.parents.get(`${cur}\0server`) }
    if (parent && curEnv === 'client' && a.facts.get(cur)?.directive === 'use client' && !a.envs.get(parent)?.has('client')) curEnv = 'server'
    cur = parent ?? null
  }
  return chain
}

export function registerBoundaryTools(tools: ToolCollector, root: string, appDir: string | null): void {
  tools.register({
    name: 'map_client_boundaries',
    description:
      'Security and build check for the Server/Client Component boundary: finds database clients, secret SDKs, and server-only modules ' +
      'imported by client code, and says whether each one breaks the build or ships to the browser. Use it in any security audit. ' +
      'Maps the boundary across the App Router by walking the real import graph from every page/layout/template ' +
      '(resolving tsconfig path aliases), finds each place a Server Component imports a \'use client\' module, and computes which files ' +
      'end up in the client bundle, which render only on the server, and which run in both. Flags server-only code (server-only, node builtins, ' +
      'DB/secret SDKs, next/headers) pulled into the client bundle with the full import chain, private process.env reads in client-only code, ' +
      'React hooks called by components that render as Server Components, module-scope browser globals, and \'use client\' placed on layouts.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Explain one file: which environments it runs in and the import chain that puts it there (optional)' },
      },
      required: [],
    },
    execute: async (args: { file?: string }) => {
      if (!appDir) return { error: 'No app/ or src/app/ directory found: boundaries only exist in the App Router' }
      const a = analyzeBoundaries(root, appDir)
      const rel = (f: string) => relative(root, f)

      if (args.file) {
        const wanted = args.file.replace(/^\.\//, '')
        const abs = [...a.envs.keys()].find(f => rel(f) === wanted)
        if (!abs) return { file: args.file, reachable: false, note: 'Not reachable from any App Router page/layout (unused, Pages Router, or only imported via type imports)' }
        const envs = [...a.envs.get(abs)!]
        return {
          file: args.file,
          directive: a.facts.get(abs)?.directive ?? null,
          environments: envs,
          chains: Object.fromEntries(envs.map(e => [e, chainTo(root, a, abs, e)])),
        }
      }

      const clientFiles: string[] = []
      const serverOnly: string[] = []
      const shared: string[] = []
      const findings: (Finding & { chain?: string[]; effect?: 'build-fails' | 'ships-to-browser' })[] = []

      for (const [file, set] of a.envs) {
        const f = a.facts.get(file)!
        if (set.has('client') && set.has('server')) shared.push(rel(file))
        else if (set.has('client')) clientFiles.push(rel(file))
        else serverOnly.push(rel(file))

        if (set.has('client')) {
          for (const imp of f.imports) {
            if (imp.typeOnly) continue
            const pkg = !imp.resolved ? isBareOrBuiltin(imp.specifier) : null
            if (pkg) {
              // One finding per client chain: each 'use client' entry point needs its own fix
              const { chains, truncated } = clientChainsTo(root, a, file)
              for (const chain of chains) {
                findings.push({ severity: 'high', ...describeLeak(rel(file), imp.specifier, chain), file: `${rel(file)}:${imp.line}`, chain })
              }
              if (truncated) {
                findings.push({ severity: 'info', detail: `More client import chains reach ${rel(file)} than the ${chains.length} listed`, file: rel(file) })
              }
            }
          }
          // Files shared with the server are skipped: reading server env there is valid, and Next.js never inlines it
          if (f.privateEnvVars.length && !set.has('server')) {
            findings.push({ severity: 'low', detail: `Client-only file reads non-NEXT_PUBLIC_ env var(s) ${f.privateEnvVars.join(', ')}: always undefined in the browser`, file: rel(file), chain: chainTo(root, a, file, 'client') })
          }
        }
        if (set.has('server') && f.directive !== 'use client') {
          if (f.clientApis.length) {
            findings.push({ severity: 'high', detail: `Uses ${f.clientApis.join(', ')} but renders as a Server Component: add 'use client' or move the hook into a client child`, file: rel(file), chain: chainTo(root, a, file, 'server') })
          }
        }
        if (f.directive === 'use client' && /\/layout\.(t|j)sx?$/.test(file)) {
          findings.push({ severity: 'medium', detail: `'use client' on a layout makes every nested page's shared UI client-rendered: push the directive down to the interactive leaf`, file: rel(file) })
        }
      }

      // Every reachable module is also evaluated on the server (Client Components are SSR'd), so module-scope browser globals throw
      for (const [file, set] of a.envs) {
        const f = a.facts.get(file)!
        if (f.browserGlobals.length) {
          findings.push({ severity: 'high', detail: `References ${f.browserGlobals.join(', ')} at module scope: throws when the module is evaluated during server rendering`, file: rel(file), chain: chainTo(root, a, file, set.has('server') ? 'server' : 'client') })
        }
      }

      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
      findings.sort((x, y) => order[x.severity] - order[y.severity])

      return {
        entry_points: a.entries.length,
        boundaries: a.boundaries,
        client_bundle_files: clientFiles.sort(),
        server_only_files: serverOnly.sort(),
        shared_files: shared.sort(),
        findings,
      }
    },
  })
}
