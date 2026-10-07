import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { readFileSafe, walkFiles } from '../../core/helpers.js'
import { findWorkspace, type Workspace } from '../../core/workspace.js'

export const SOURCE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']

// ---------------------------------------------------------------------------
// Parsing (cached by path + mtime so repeated tool calls stay fast)
// ---------------------------------------------------------------------------

const cache = new Map<string, { mtime: number; sf: ts.SourceFile }>()

export function parseFile(path: string): ts.SourceFile | null {
  let mtime: number
  try { mtime = statSync(path).mtimeMs } catch { return null }
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime) return hit.sf
  const text = readFileSafe(path)
  if (text === null) return null
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX
    : path.endsWith('.ts') ? ts.ScriptKind.TS
    : ts.ScriptKind.JSX // JSX kind also parses plain JS
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  cache.set(path, { mtime, sf })
  return sf
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

/** File-level directive ('use client' / 'use server' / 'use cache'), per the prologue rules. */
export function fileDirective(sf: ts.SourceFile): string | null {
  return prologue(sf.statements).find(d => d.startsWith('use ')) ?? null
}

/** Directives at the top of a function body. */
export function bodyDirectives(fn: ts.FunctionLikeDeclaration): string[] {
  if (!fn.body || !ts.isBlock(fn.body)) return []
  return prologue(fn.body.statements)
}

function prologue(statements: ts.NodeArray<ts.Statement>): string[] {
  const out: string[] = []
  for (const s of statements) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) out.push(s.expression.text)
    else break
  }
  return out
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ExportInfo {
  name: string              // exported name ('default' for default exports)
  kind: 'function' | 'variable' | 'class' | 'type' | 'reexport' | 'star'
  line: number
  typeOnly: boolean
  /** Function-like node backing this export, when resolvable in-file. */
  fn?: ts.FunctionLikeDeclaration
  /** Initializer for `export const x = <expr>` */
  init?: ts.Expression
  /** Module specifier for re-exports */
  from?: string
  /** For re-exports: the name in the source module (`export { default as Loader } from` → 'default'; `export * as ns` → '*') */
  originalName?: string
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === kind))
}

function unwrapFn(expr: ts.Expression | undefined, sf: ts.SourceFile, seen = new Set<string>()): ts.FunctionLikeDeclaration | undefined {
  let e = expr
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression
  if (!e) return undefined
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e
  // Wrapped handlers: export const GET = withAuth(async (req) => ...) or withAuth(handler)
  if (ts.isCallExpression(e)) {
    for (const a of e.arguments) {
      const inner = unwrapFn(a, sf, seen)
      if (inner) return inner
    }
  }
  // A name referring to a same-file function: `handler` in defaultResponder(handler), or `export const GET = handler`
  if (ts.isIdentifier(e) && !seen.has(e.text)) {
    seen.add(e.text)
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === e.text && s.body) return s
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === e.text) return unwrapFn(d.initializer, sf, seen)
        }
      }
    }
  }
  return undefined
}

/** Find a top-level local declaration by name (for `export { x as GET }` and `export default x`). */
function findLocal(sf: ts.SourceFile, name: string): { fn?: ts.FunctionLikeDeclaration; init?: ts.Expression; kind: ExportInfo['kind'] } | null {
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { fn: s, kind: 'function' }
    if (ts.isClassDeclaration(s) && s.name?.text === name) return { kind: 'class' }
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          const fn = unwrapFn(d.initializer, sf)
          return { fn, init: d.initializer, kind: fn ? 'function' : 'variable' }
        }
      }
    }
  }
  return null
}

export function getExports(sf: ts.SourceFile): ExportInfo[] {
  const out: ExportInfo[] = []
  for (const s of sf.statements) {
    const exported = hasModifier(s, ts.SyntaxKind.ExportKeyword)
    const isDefault = hasModifier(s, ts.SyntaxKind.DefaultKeyword)

    if (ts.isFunctionDeclaration(s) && exported) {
      out.push({ name: isDefault ? 'default' : s.name?.text ?? 'default', kind: 'function', line: lineOf(sf, s), typeOnly: false, fn: s })
    } else if (ts.isClassDeclaration(s) && exported) {
      out.push({ name: isDefault ? 'default' : s.name?.text ?? 'default', kind: 'class', line: lineOf(sf, s), typeOnly: false })
    } else if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) {
        const names = ts.isIdentifier(d.name) ? [d.name.text] : bindingNames(d.name)
        for (const name of names) {
          const fn = ts.isIdentifier(d.name) ? unwrapFn(d.initializer, sf) : undefined
          out.push({ name, kind: fn ? 'function' : 'variable', line: lineOf(sf, d), typeOnly: false, fn, init: d.initializer })
        }
      }
    } else if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && exported) {
      out.push({ name: s.name.text, kind: ts.isEnumDeclaration(s) ? 'variable' : 'type', line: lineOf(sf, s), typeOnly: !ts.isEnumDeclaration(s) })
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      // export default <expr>
      let fn = unwrapFn(s.expression, sf)
      let init: ts.Expression | undefined = s.expression
      if (!fn && ts.isIdentifier(s.expression)) {
        const local = findLocal(sf, s.expression.text)
        fn = local?.fn
        init = local?.init ?? init
      }
      out.push({ name: 'default', kind: fn ? 'function' : 'variable', line: lineOf(sf, s), typeOnly: false, fn, init })
    } else if (ts.isExportDeclaration(s)) {
      const from = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : undefined
      if (!s.exportClause) {
        out.push({ name: '*', kind: 'star', line: lineOf(sf, s), typeOnly: s.isTypeOnly, from })
      } else if (ts.isNamedExports(s.exportClause)) {
        for (const el of s.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text
          const typeOnly = s.isTypeOnly || el.isTypeOnly
          if (from) {
            out.push({ name: el.name.text, originalName: local, kind: 'reexport', line: lineOf(sf, el), typeOnly, from })
          } else {
            const found = findLocal(sf, local)
            out.push({ name: el.name.text, kind: found?.kind ?? 'variable', line: lineOf(sf, el), typeOnly, fn: found?.fn, init: found?.init })
          }
        }
      } else {
        // export * as ns from '...'
        out.push({ name: s.exportClause.name.text, originalName: '*', kind: 'reexport', line: lineOf(sf, s), typeOnly: s.isTypeOnly, from })
      }
    }
  }
  return out
}

function bindingNames(pattern: ts.BindingName): string[] {
  if (ts.isIdentifier(pattern)) return [pattern.text]
  return pattern.elements.flatMap(el => ts.isOmittedExpression(el) ? [] : bindingNames(el.name))
}

/** Literal value of `export const <name> = ...` (string/number/boolean), for route segment config. */
export function literalExport(sf: ts.SourceFile, name: string): string | number | boolean | null {
  const exp = getExports(sf).find(e => e.name === name && e.init)
  if (!exp?.init) return null
  const e = exp.init
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isNumericLiteral(e)) return Number(e.text)
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false
  return e.getText(sf)
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ImportInfo {
  specifier: string
  names: string[]        // imported names: 'default', '*', or named (original, not local alias)
  typeOnly: boolean
  sideEffect: boolean
  dynamic: boolean
  line: number
}

export function getImports(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = []
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const clause = s.importClause
      const names: string[] = []
      let allTypes = !!clause?.isTypeOnly
      if (clause) {
        if (clause.name) names.push('default')
        const nb = clause.namedBindings
        if (nb && ts.isNamespaceImport(nb)) names.push('*')
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) names.push((el.propertyName ?? el.name).text)
          if (!clause.isTypeOnly && !clause.name && nb.elements.length > 0 && nb.elements.every(el => el.isTypeOnly)) allTypes = true
        }
      }
      out.push({ specifier: s.moduleSpecifier.text, names, typeOnly: allTypes, sideEffect: !clause, dynamic: false, line: lineOf(sf, s) })
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      const names = s.exportClause && ts.isNamedExports(s.exportClause)
        ? s.exportClause.elements.map(el => (el.propertyName ?? el.name).text)
        : ['*']
      out.push({ specifier: s.moduleSpecifier.text, names, typeOnly: s.isTypeOnly, sideEffect: false, dynamic: false, line: lineOf(sf, s) })
    }
  }

  // Dynamic import('x') and next/dynamic(() => import('x')) anywhere in the file
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteralLike(arg)) {
        out.push({ specifier: arg.text, names: ['*'], typeOnly: false, sideEffect: false, dynamic: true, line: lineOf(sf, node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ---------------------------------------------------------------------------
// Module resolution (tsconfig/jsconfig paths + relative)
// ---------------------------------------------------------------------------

export interface Resolver {
  resolve(specifier: string, fromFile: string): string | null
}

interface PathsConfig {
  /** Absolute baseUrl */
  baseUrl?: string
  paths?: Record<string, string[]>
  /** Directory of the tsconfig that declared `paths` */
  pathsBase?: string
}

/** Locate the file a tsconfig `extends` entry points at: a relative path, a workspace package, or node_modules. */
function resolveExtends(spec: string, fromFile: string): string | null {
  const asConfig = (p: string): string | null => {
    if (existsSync(p) && statSync(p).isFile()) return p
    if (existsSync(`${p}.json`)) return `${p}.json`
    if (existsSync(join(p, 'tsconfig.json'))) return join(p, 'tsconfig.json')
    return null
  }
  if (spec.startsWith('.') || spec.startsWith('/')) return asConfig(resolve(dirname(fromFile), spec))

  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  const sub = spec.slice(name.length).replace(/^\//, '')
  const pkg = findWorkspace(dirname(fromFile))?.packages.get(name)
  if (pkg) return asConfig(join(pkg.dir, sub || 'tsconfig.json'))
  for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
    const hit = asConfig(join(dir, 'node_modules', spec))
    if (hit) return hit
    if (dirname(dir) === dir) return null
  }
}

/** baseUrl/paths from a tsconfig, following `extends` (string or array); the child's values replace the parent's. */
function readPathsConfig(file: string, seen = new Set<string>()): PathsConfig {
  if (seen.has(file)) return {}
  seen.add(file)
  const { config } = ts.readConfigFile(file, ts.sys.readFile) // tolerates comments + trailing commas
  if (!config) return {}

  let merged: PathsConfig = {}
  const ext = config.extends
  for (const spec of Array.isArray(ext) ? ext : ext ? [ext] : []) {
    const target = typeof spec === 'string' ? resolveExtends(spec, file) : null
    if (target) merged = { ...merged, ...readPathsConfig(target, seen) }
  }
  const opts = config.compilerOptions ?? {}
  if (opts.baseUrl) merged.baseUrl = resolve(dirname(file), opts.baseUrl)
  if (opts.paths) { merged.paths = opts.paths; merged.pathsBase = dirname(file) }
  return merged
}

export function createResolver(root: string): Resolver {
  let baseUrl = root
  let hasBaseUrl = false
  const paths: [string, string[]][] = []
  let pathsBase = root
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    const cfg = readPathsConfig(p)
    if (cfg.baseUrl) { baseUrl = cfg.baseUrl; hasBaseUrl = true }
    for (const [k, v] of Object.entries(cfg.paths ?? {})) {
      if (Array.isArray(v)) paths.push([k, v as string[]])
    }
    // TypeScript resolves `paths` against baseUrl when set, otherwise against the tsconfig that declares them
    pathsBase = cfg.baseUrl ?? cfg.pathsBase ?? root
    break
  }
  // Longest alias first so '@/components/*' beats '@/*'
  paths.sort((a, b) => b[0].length - a[0].length)
  const workspace = findWorkspace(root)

  const memo = new Map<string, string | null>()

  return {
    resolve(specifier, fromFile) {
      const key = specifier.startsWith('.') ? `${dirname(fromFile)}\0${specifier}` : specifier
      if (memo.has(key)) return memo.get(key)!
      let result: string | null = null
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
        result = tryFile(resolve(dirname(fromFile), specifier))
      } else {
        for (const [alias, targets] of paths) {
          const star = alias.endsWith('*')
          const prefix = star ? alias.slice(0, -1) : alias
          if (star ? !specifier.startsWith(prefix) : specifier !== alias) continue
          const rest = star ? specifier.slice(prefix.length) : ''
          for (const t of targets) {
            result = tryFile(resolve(pathsBase, t.replace('*', rest)))
            if (result) break
          }
          if (result) break
        }
        // With baseUrl set, TypeScript also resolves bare specifiers against it: `app/api/x` → <baseUrl>/app/api/x
        if (!result && hasBaseUrl) result = tryFile(resolve(baseUrl, specifier))
        // Monorepo packages (including the app importing itself by package name), in place of node_modules
        if (!result && workspace) result = resolveWorkspacePackage(workspace, specifier)
      }
      memo.set(key, result)
      return result
    },
  }
}

/** Pick a file target from a package.json exports value: string, fallback array, or condition object. */
function pickExportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const v of value) { const t = pickExportTarget(v); if (t) return t }
    return null
  }
  if (value && typeof value === 'object') {
    // Source-first: prefer conditions that point at runtime code over type declarations
    for (const cond of ['source', 'import', 'module', 'default', 'require', 'node', 'browser', 'types']) {
      if (cond in value) { const t = pickExportTarget((value as Record<string, unknown>)[cond]); if (t) return t }
    }
  }
  return null
}

/** Resolve a subpath ('.' or './x') through a package.json `exports` field, including `*` patterns. */
function resolveExportsField(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return subpath === '.' ? pickExportTarget(exportsField) : null
  if (!exportsField || typeof exportsField !== 'object') return null
  const map = exportsField as Record<string, unknown>
  const keys = Object.keys(map)
  // Top-level condition object (no './' keys) describes the '.' export
  if (!keys.some(k => k.startsWith('.'))) return subpath === '.' ? pickExportTarget(map) : null
  if (subpath in map) return pickExportTarget(map[subpath])
  for (const key of keys) {
    const star = key.indexOf('*')
    if (star === -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const target = pickExportTarget(map[key])
      if (target) return target.replace(/\*/g, subpath.slice(prefix.length, subpath.length - suffix.length))
    }
  }
  return null
}

function resolveWorkspacePackage(workspace: Workspace, specifier: string): string | null {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  const pkg = workspace.packages.get(name)
  if (!pkg) return null
  const sub = specifier.slice(name.length) // '' or '/path'
  const candidates: string[] = []
  const fromExports = pkg.json.exports ? resolveExportsField(pkg.json.exports, sub ? `.${sub}` : '.') : null
  if (fromExports) candidates.push(fromExports)
  if (sub) {
    candidates.push(sub.slice(1), `src${sub}`)
  } else {
    for (const field of ['source', 'module', 'main', 'types']) if (typeof pkg.json[field] === 'string') candidates.push(pkg.json[field])
    candidates.push('index', 'src/index')
  }
  for (const c of candidates) {
    const abs = resolve(pkg.dir, c)
    // Built entry points (dist/*.js) usually don't exist in a fresh clone: fall back to the source file
    const hit = tryFile(abs) ?? tryFile(abs.replace(/\/dist\//, '/src/').replace(/(\.d)?\.(c|m)?[jt]s$/, ''))
    if (hit && !hit.endsWith('.d.ts')) return hit
  }
  return null
}

function tryFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base
  // Allow './foo.js' specifiers that point at foo.ts (TS ESM convention)
  const stripped = base.replace(/\.(m|c)?jsx?$/, '')
  for (const b of stripped !== base ? [stripped, base] : [base]) {
    for (const ext of SOURCE_EXTS) if (existsSync(b + ext)) return b + ext
  }
  for (const ext of SOURCE_EXTS) {
    const idx = join(base, `index${ext}`)
    if (existsSync(idx)) return idx
  }
  return null
}

// ---------------------------------------------------------------------------
// Project layout
// ---------------------------------------------------------------------------

export function findDir(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const d = join(root, c)
    try { if (statSync(d).isDirectory()) return d } catch { /* missing */ }
  }
  return null
}

// Top-level directories that never contain importable app source
const NON_SOURCE_DIRS = new Set(['public', 'coverage', 'out', 'test-results', 'playwright-report', 'storybook-static'])

/**
 * All source files in the app: root-level files plus every top-level directory (or just src/ when it exists),
 * excluding node_modules, dot dirs, dist and build (via walkFiles) and known non-source dirs.
 */
export function projectSourceFiles(root: string): string[] {
  const hasSrc = findDir(root, ['src']) !== null
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const files: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(root, e.name)
    if (e.isDirectory()) {
      if (NON_SOURCE_DIRS.has(e.name)) continue
      // With src/, app code lives there; other top-level dirs are tooling (scripts, e2e, …)
      if (hasSrc && e.name !== 'src') continue
      files.push(...walkFiles(full, SOURCE_EXTS))
    } else if (e.isFile() && SOURCE_EXTS.some(ext => e.name.endsWith(ext))) {
      files.push(full)
    }
  }
  return files.filter(f => !f.endsWith('.d.ts'))
}

/** Major version of the `next` dependency in the app's package.json ("^16.2.3" → 16), or null if it can't be read. */
export function nextMajorVersion(root: string): number | null {
  const text = readFileSafe(join(root, 'package.json'))
  if (!text) return null
  try {
    const pkg = JSON.parse(text)
    const range = { ...pkg.dependencies, ...pkg.devDependencies }.next
    const m = typeof range === 'string' ? range.match(/(\d+)/) : null
    return m ? Number(m[1]) : null
  } catch { return null }
}

export const ROUTE_FILE_EXT = /\.(tsx|ts|jsx|js|mdx|md)$/

export function baseName(file: string): string {
  return (file.split('/').pop() ?? '').replace(ROUTE_FILE_EXT, '')
}
