import { join, relative } from 'node:path'
import ts from 'typescript'
import type { ToolCollector } from '../../core/types.js'
import {
  bodyDirectives, fileDirective, getExports, getImports, lineOf, literalExport, nextMajorVersion, parseFile, type Resolver,
} from './ast.js'
import { projectGraph } from './graph.js'
import { buildAppTree, resolveAppRoutes, type Finding } from './routes.js'

// How far to follow a route's imports looking for data helpers (route → lib/data.ts → lib/session.ts → …)
const MAX_IMPORT_DEPTH = 3
const CACHING_CALLS = ['cacheLife', 'unstable_cacheLife', 'cacheTag', 'unstable_cacheTag', 'unstable_cache', 'revalidateTag', 'revalidatePath', 'updateTag']
const DYNAMIC_CALLS = ['cookies', 'headers', 'draftMode', 'connection']
/** Pseudo-function holding code that runs when the module loads (including object literals of methods) */
const MODULE_SCOPE = '#module'

interface FetchCall { file: string; line: number; url: string; cache: string | null; revalidate: string | null; tags: string | null }

/** What running one export touches: its function body plus same-file functions it calls, plus module-scope code */
interface ExportUse {
  apis: string[]
  fetches: FetchCall[]
  /** module → exported names called ('default', a named export, or '*' for a whole namespace) */
  importCalls: Map<string, Set<string>>
}

interface ModuleFacts {
  fetches: FetchCall[]
  caching: string[]
  /** Dynamic APIs anywhere in the file; a route file counts all of them */
  dynamicApis: string[]
  /** Resolved project modules this file imports at runtime */
  imports: string[]
  /** Everything this file calls or renders from its imports, anywhere in the file */
  calledImports: Map<string, Set<string>>
  exportUses: Map<string, ExportUse>
  /** `export { a as b } from './x'` → b: { module: x, name: a } */
  reexports: Map<string, { module: string; name: string }>
  starReexports: string[]
  /** 'use client' / 'use server' modules don't run during server rendering of the route, so they aren't followed */
  boundary: boolean
}

function containsFunction(e: ts.Expression): boolean {
  let x = e
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression
  if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return true
  // cache(async () => …), unstable_cache(fn, …)
  return ts.isCallExpression(x) && x.arguments.some(a => containsFunction(a))
}

/** The top-level function a statement defines, or MODULE_SCOPE for everything else. */
function statementOwner(s: ts.Statement): string {
  if (ts.isFunctionDeclaration(s)) return s.name?.text ?? '#default'
  if (ts.isVariableStatement(s) && s.declarationList.declarations.length === 1) {
    const d = s.declarationList.declarations[0]
    if (ts.isIdentifier(d.name) && d.initializer && containsFunction(d.initializer)) return d.name.text
  }
  if (ts.isExportAssignment(s) && !ts.isIdentifier(s.expression)) return '#default'
  return MODULE_SCOPE
}

interface Uses { apis: Set<string>; fetches: FetchCall[]; importCalls: Map<string, Set<string>>; localCalls: Set<string> }

function addName(map: Map<string, Set<string>>, module: string, name: string): void {
  const names = map.get(module) ?? new Set<string>()
  names.add(name)
  map.set(module, names)
}

function collectModuleFacts(root: string, file: string, resolver: Resolver): ModuleFacts {
  const empty: ModuleFacts = {
    fetches: [], caching: [], dynamicApis: [], imports: [], calledImports: new Map(),
    exportUses: new Map(), reexports: new Map(), starReexports: [], boundary: false,
  }
  const sf = parseFile(file)
  if (!sf || /\.mdx?$/.test(file)) return empty

  const rel = relative(root, file)
  const directive = fileDirective(sf)
  const caching = new Set<string>()
  const dynamicApis = new Set<string>()
  const fetches: FetchCall[] = []

  if (directive === 'use cache') caching.add("'use cache' (file)")
  const nextLocals = new Set<string>()
  for (const imp of getImports(sf)) {
    if (imp.specifier === 'react' && imp.names.includes('cache')) caching.add('React cache()')
    if (imp.specifier === 'next/headers' || imp.specifier === 'next/server') imp.names.forEach(n => nextLocals.add(n))
  }

  // Local binding → the module and exported name it refers to
  const bindings = new Map<string, { module: string; name: string }>()
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || !s.importClause || s.importClause.isTypeOnly) continue
    const module = resolver.resolve(s.moduleSpecifier.text, file)
    if (!module) continue
    if (s.importClause.name) bindings.set(s.importClause.name.text, { module, name: 'default' })
    const nb = s.importClause.namedBindings
    if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, { module, name: '*' })
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) if (!el.isTypeOnly) bindings.set(el.name.text, { module, name: (el.propertyName ?? el.name).text })
    }
  }

  const ownerNames = new Set(sf.statements.map(statementOwner).filter(o => o !== MODULE_SCOPE))
  const uses = new Map<string, Uses>()
  const usesOf = (owner: string): Uses => {
    if (!uses.has(owner)) uses.set(owner, { apis: new Set(), fetches: [], importCalls: new Map(), localCalls: new Set() })
    return uses.get(owner)!
  }

  /** `helper()`, `ns.helper()`, `<Component />`, `<ui.Button />` */
  const recordUse = (u: Uses, target: ts.Node): void => {
    let node: ts.Node = target
    const props: string[] = []
    while (ts.isPropertyAccessExpression(node)) { props.unshift(node.name.text); node = node.expression }
    if (!ts.isIdentifier(node)) return
    const binding = bindings.get(node.text)
    if (binding) addName(u.importCalls, binding.module, binding.name === '*' ? props[0] ?? '*' : binding.name)
    else if (ownerNames.has(node.text)) u.localCalls.add(node.text)
  }

  const prop = (o: ts.Expression | undefined, key: string): ts.Expression | undefined =>
    o && ts.isObjectLiteralExpression(o)
      ? (o.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === key) as ts.PropertyAssignment | undefined)?.initializer
      : undefined

  const visit = (n: ts.Node, u: Uses): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && bodyDirectives(n).some(d => d.startsWith('use cache'))) {
      caching.add(`'${bodyDirectives(n).find(d => d.startsWith('use cache'))}' (function)`)
    }
    if (ts.isCallExpression(n)) {
      recordUse(u, n.expression)
      const callee = n.expression.getText(sf)
      if (callee === 'fetch') {
        const opts = n.arguments[1]
        const next = prop(opts, 'next')
        const call: FetchCall = {
          file: rel,
          line: lineOf(sf, n),
          url: n.arguments[0]?.getText(sf).slice(0, 120) ?? '',
          cache: prop(opts, 'cache')?.getText(sf) ?? null,
          revalidate: prop(next, 'revalidate')?.getText(sf) ?? null,
          tags: prop(next, 'tags')?.getText(sf) ?? null,
        }
        fetches.push(call)
        u.fetches.push(call)
      }
      if (CACHING_CALLS.includes(callee)) caching.add(`${callee}()`)
      if (DYNAMIC_CALLS.includes(callee) && nextLocals.has(callee)) {
        dynamicApis.add(`${callee}()`)
        u.apis.add(`${callee}()`)
      }
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) recordUse(u, n.tagName)
    const readsSearchParams =
      (ts.isIdentifier(n) && n.text === 'searchParams' && ts.isBindingElement(n.parent)) ||
      (ts.isPropertyAccessExpression(n) && n.name.text === 'searchParams' && n.expression.getText(sf) === 'props')
    if (readsSearchParams) {
      dynamicApis.add('searchParams')
      u.apis.add('searchParams')
    }
    ts.forEachChild(n, child => visit(child, u))
  }
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s)) visit(s, usesOf(statementOwner(s)))
  }

  const closure = (owner: string): ExportUse => {
    const apis = new Set<string>()
    const ownerFetches: FetchCall[] = []
    const importCalls = new Map<string, Set<string>>()
    const pending = [owner, MODULE_SCOPE]
    const done = new Set<string>()
    while (pending.length) {
      const current = pending.pop()!
      if (done.has(current)) continue
      done.add(current)
      const u = uses.get(current)
      if (!u) continue
      u.apis.forEach(a => apis.add(a))
      ownerFetches.push(...u.fetches)
      for (const [module, names] of u.importCalls) names.forEach(n => addName(importCalls, module, n))
      u.localCalls.forEach(l => pending.push(l))
    }
    return { apis: [...apis], fetches: ownerFetches, importCalls }
  }

  const exportUses = new Map<string, ExportUse>()
  const reexports = new Map<string, { module: string; name: string }>()
  const starReexports: string[] = []
  for (const exp of getExports(sf)) {
    if (exp.typeOnly) continue
    const module = exp.from ? resolver.resolve(exp.from, file) : null
    if (exp.kind === 'star') { if (module) starReexports.push(module); continue }
    if (exp.from) { if (module) reexports.set(exp.name, { module, name: exp.originalName ?? exp.name }); continue }
    const statement = exp.fn ? sf.statements.find(s => s.pos <= exp.fn!.pos && exp.fn!.end <= s.end) : undefined
    exportUses.set(exp.name, closure(statement ? statementOwner(statement) : MODULE_SCOPE))
  }

  const calledImports = new Map<string, Set<string>>()
  for (const u of uses.values()) {
    for (const [module, names] of u.importCalls) names.forEach(n => addName(calledImports, module, n))
  }

  const imports = getImports(sf)
    .filter(i => !i.typeOnly && !i.dynamic)
    .map(i => resolver.resolve(i.specifier, file))
    .filter((f): f is string => !!f)

  return {
    fetches,
    caching: [...caching],
    dynamicApis: [...dynamicApis],
    imports,
    calledImports,
    exportUses,
    reexports,
    starReexports,
    boundary: directive === 'use client' || directive === 'use server',
  }
}

export function registerDataFetchingTools(tools: ToolCollector, root: string, appDir: string | null): void {
  tools.register({
    name: 'analyze_data_fetching',
    description:
      'Per-route rendering and caching analysis from the AST. For every App Router page, layout, and route handler: route segment config, ' +
      'fetch() calls with their cache / next.revalidate / next.tags options, \'use cache\' (file or function level), cacheLife/cacheTag, ' +
      'unstable_cache, React cache(), and dynamic API usage (cookies, headers, draftMode, connection, searchParams), with an inferred ' +
      `rendering mode. Follows the functions each route actually calls into imported helpers, up to ${MAX_IMPORT_DEPTH} modules deep ` +
      '(through re-exports, stopping at \'use client\' and \'use server\' modules). Dynamic APIs reached through those calls are definite ' +
      '(dynamic_apis); ones in helpers the route only imports are possible (possible_dynamic_apis) and never raise severity. ' +
      'On Next.js 16, also flags the deprecated single-argument revalidateTag(tag) anywhere in the app.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Only include routes under this URL prefix (optional)' } },
      required: [],
    },
    execute: async (args: { path?: string }) => {
      if (!appDir) return { error: 'No app/ directory found' }
      const graph = projectGraph(root)
      const resolver = graph.resolver
      const factsCache = new Map<string, ModuleFacts>()
      const factsFor = (file: string): ModuleFacts => {
        if (!factsCache.has(file)) factsCache.set(file, collectModuleFacts(root, file, resolver))
        return factsCache.get(file)!
      }

      const results: {
        path: string; file: string
        segment_config: Record<string, string | number | boolean>
        fetches: FetchCall[]
        caching: string[]
        dynamic_apis: string[]
        possible_dynamic_apis: string[]
        followed_modules: number
        rendering: string
      }[] = []

      const seenTargets = new Set<string>()
      const targets: { path: string; file: string }[] = []
      for (const r of resolveAppRoutes(root, buildAppTree(appDir))) {
        if (args.path && !r.path.startsWith(args.path)) continue
        for (const f of [r.file, ...r.layouts]) if (!seenTargets.has(f)) { seenTargets.add(f); targets.push({ path: r.path, file: f }) }
      }

      for (const t of targets) {
        const abs = join(root, t.file)
        const sf = parseFile(abs)
        if (!sf || /\.mdx?$/.test(t.file)) continue

        const segment: Record<string, string | number | boolean> = {}
        for (const key of ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime']) {
          const v = literalExport(sf, key)
          if (v !== null) segment[key] = v
        }

        // Everything in the route file itself is definite. From there, follow imports by exported name: a name the route
        // calls (or renders) makes that export's code definite; an import that is never called is only possible.
        const own = factsFor(abs)
        const definite = new Set(own.dynamicApis)
        const possible = new Set<string>()
        const definiteFetches: FetchCall[] = [...own.fetches]
        const possibleFetches: FetchCall[] = []
        const caching = new Set(own.caching)
        const followedModules = new Set<string>()
        const done = new Set<string>()
        type Edge = { dep: string; name: string | null }
        let frontier: Edge[] = [
          ...[...own.calledImports].flatMap(([dep, names]) => [...names].map(name => ({ dep, name }))),
          ...own.imports.filter(dep => !own.calledImports.has(dep)).map(dep => ({ dep, name: null as string | null })),
        ]

        for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length; depth++) {
          const next: Edge[] = []
          for (const { dep, name } of frontier) {
            const key = `${dep}\0${name ?? '?'}`
            if (done.has(key)) continue
            done.add(key)
            const facts = factsFor(dep)
            if (facts.boundary) continue
            const via = relative(root, dep)
            if (!followedModules.has(dep)) {
              followedModules.add(dep)
              facts.caching.forEach(c => caching.add(`${c} via ${via}`))
            }
            // searchParams is a page prop; a helper module can't read the route's searchParams
            const viaLabels = (apis: string[]) => apis.filter(a => a !== 'searchParams').map(a => `${a} via ${via}`)

            if (name === null) {
              viaLabels(facts.dynamicApis).forEach(a => possible.add(a))
              possibleFetches.push(...facts.fetches)
              next.push(...facts.imports.map(d => ({ dep: d, name: null })))
              continue
            }
            const exportUses = name === '*' ? [...facts.exportUses.values()] : facts.exportUses.has(name) ? [facts.exportUses.get(name)!] : null
            if (exportUses) {
              for (const use of exportUses) {
                viaLabels(use.apis).forEach(a => definite.add(a))
                definiteFetches.push(...use.fetches)
                for (const [module, names] of use.importCalls) names.forEach(n => next.push({ dep: module, name: n }))
              }
            } else if (facts.reexports.has(name)) {
              const target = facts.reexports.get(name)!
              next.push({ dep: target.module, name: target.name })
            } else if (facts.starReexports.length) {
              facts.starReexports.forEach(module => next.push({ dep: module, name }))
            } else {
              // An export shape we can't attribute (e.g. a class member): keep its evidence, but only as possible
              viaLabels(facts.dynamicApis).forEach(a => possible.add(a))
              possibleFetches.push(...facts.fetches)
            }
          }
          frontier = next
        }

        const possibleApis = [...possible].filter(api => !definite.has(api))
        const uncached = (f: FetchCall) => /no-store/.test(f.cache ?? '') || f.revalidate === '0'
        const definitelyDynamic = definite.size > 0 || definiteFetches.some(uncached)
        const possiblyDynamic = possibleApis.length > 0 || possibleFetches.some(uncached)
        // Forced segment config wins: under force-static, dynamic APIs return empty values instead of making the route dynamic
        const rendering =
          segment.dynamic === 'force-dynamic' ? 'dynamic (per request)'
          : segment.dynamic === 'force-static' || segment.dynamic === 'error' ? 'static (forced)'
          : definitelyDynamic ? 'dynamic (per request)'
          : possiblyDynamic ? 'likely dynamic (imported helpers use dynamic APIs or uncached fetches)'
          : typeof segment.revalidate === 'number' && segment.revalidate > 0 ? `ISR (revalidate ${segment.revalidate}s)`
          : 'static'

        const fetchKeys = new Set<string>()
        const fetches = [...definiteFetches, ...possibleFetches].filter(f => {
          const k = `${f.file}:${f.line}`
          if (fetchKeys.has(k)) return false
          fetchKeys.add(k)
          return true
        })

        if (Object.keys(segment).length || fetches.length || caching.size || definite.size || possibleApis.length) {
          results.push({
            path: t.path, file: t.file, segment_config: segment, fetches, caching: [...caching],
            dynamic_apis: [...definite], possible_dynamic_apis: possibleApis, followed_modules: followedModules.size, rendering,
          })
        }
      }

      const findings: Finding[] = []
      const major = nextMajorVersion(root)
      for (const r of results) {
        const mode = r.segment_config.dynamic
        if (mode === 'force-static' && r.dynamic_apis.length) {
          findings.push({ severity: 'medium', detail: `dynamic = 'force-static' but uses ${r.dynamic_apis.join(', ')}: these return empty values at build time`, file: r.file, route: r.path })
        }
        if (mode === 'error' && r.dynamic_apis.length) {
          findings.push({ severity: 'high', detail: `dynamic = 'error' with ${r.dynamic_apis.join(', ')}: the build will fail`, file: r.file, route: r.path })
        }
        if ((mode === 'force-static' || mode === 'error') && r.possible_dynamic_apis.length) {
          findings.push({
            severity: 'info',
            detail: `dynamic = '${mode}' and imports helpers that use ${r.possible_dynamic_apis.join(', ')} without calling them here: ` +
              `if they run during render they ${mode === 'error' ? 'fail the build' : 'return empty values at build time'}`,
            file: r.file,
            route: r.path,
          })
        }
        if (major !== null && major >= 15 && r.fetches.some(f => f.file === r.file && f.cache === null && f.revalidate === null) && !r.segment_config.revalidate && !r.caching.length) {
          findings.push({ severity: 'info', detail: 'fetch() without cache options is uncached by default since Next.js 15', file: r.file, route: r.path })
        }
      }
      // Next.js 16 deprecates revalidateTag(tag) without a cacheLife profile: a TypeScript error that expires the tag immediately
      if (major !== null && major >= 16) {
        for (const file of graph.files) {
          const sf = parseFile(file)
          if (!sf || !sf.text.includes('revalidateTag')) continue
          const locals = new Set<string>()
          for (const s of sf.statements) {
            if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== 'next/cache') continue
            const nb = s.importClause?.namedBindings
            if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 'revalidateTag') locals.add(el.name.text)
            }
          }
          if (!locals.size) continue
          const visit = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && locals.has(n.expression.text) && n.arguments.length === 1) {
              findings.push({
                severity: 'low',
                detail: `${n.getText(sf).slice(0, 80)} uses the deprecated single-argument form: on Next.js 16 it expires the tag immediately (like { expire: 0 }) and is a TypeScript error; pass a cacheLife profile such as 'max', or use updateTag in a Server Action`,
                file: `${relative(root, file)}:${lineOf(sf, n)}`,
              })
            }
            ts.forEachChild(n, visit)
          }
          visit(sf)
        }
      }

      return { count: results.length, files: results, findings }
    },
  })
}
