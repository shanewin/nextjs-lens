import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walkFiles } from '../../core/helpers.js'
import type { ToolCollector } from '../../core/types.js'
import { fileDirective, getExports, literalExport, nextMajorVersion, parseFile } from './ast.js'

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

const SPECIAL_FILES = [
  'page', 'layout', 'template', 'loading', 'error', 'global-error',
  'not-found', 'forbidden', 'unauthorized', 'route', 'default',
] as const
type SpecialFile = typeof SPECIAL_FILES[number]

const CODE_EXT = /\.(tsx|ts|jsx|js)$/
const PAGE_EXT = /\.(tsx|ts|jsx|js|mdx|md)$/

const SEGMENT_CONFIG_KEYS = ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration']

// ---------------------------------------------------------------------------
// Segment tree
// ---------------------------------------------------------------------------

export type SegmentKind =
  | 'root' | 'static' | 'dynamic' | 'catch-all' | 'optional-catch-all'
  | 'group' | 'parallel' | 'intercepting'

export interface SegmentNode {
  name: string
  dir: string
  /** URL path up to and including this segment (Next.js bracket notation) */
  path: string
  kind: SegmentKind
  files: Partial<Record<SpecialFile, string>>
  children: SegmentNode[]
}

function classifySegment(name: string): { kind: SegmentKind; urlPart: string } | null {
  if (name.startsWith('_')) return null // private folder
  if (/^\(\.{1,3}\)|^(\(\.\.\))+/.test(name)) {
    return { kind: 'intercepting', urlPart: name.replace(/^(\(\.{1,3}\))+/, '') }
  }
  if (/^\(.+\)$/.test(name)) return { kind: 'group', urlPart: '' }
  if (name.startsWith('@')) return { kind: 'parallel', urlPart: '' }
  if (/^\[\[\.\.\..+\]\]$/.test(name)) return { kind: 'optional-catch-all', urlPart: name }
  if (/^\[\.\.\..+\]$/.test(name)) return { kind: 'catch-all', urlPart: name }
  if (/^\[.+\]$/.test(name)) return { kind: 'dynamic', urlPart: name }
  return { kind: 'static', urlPart: decodeURIComponent(name) }
}

function joinUrl(base: string, part: string): string {
  if (!part) return base
  return base === '/' ? `/${part}` : `${base}/${part}`
}

export function buildAppTree(appDir: string): SegmentNode {
  const build = (dir: string, name: string, path: string, kind: SegmentKind): SegmentNode => {
    const node: SegmentNode = { name, dir, path, kind, files: {}, children: [] }
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return node }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const cls = classifySegment(e.name)
        if (!cls) continue
        node.children.push(build(full, e.name, joinUrl(path, cls.urlPart), cls.kind))
      } else if (e.isFile()) {
        const base = e.name.replace(PAGE_EXT, '')
        if (!(SPECIAL_FILES as readonly string[]).includes(base)) continue
        const ext = base === 'page' ? PAGE_EXT : CODE_EXT
        if (!ext.test(e.name)) continue
        node.files[base as SpecialFile] ??= full
      }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    return node
  }
  return build(appDir, 'app', '/', 'root')
}

// ---------------------------------------------------------------------------
// Resolved routes (one per page.* / route.*), with inherited boundaries
// ---------------------------------------------------------------------------

export interface ResolvedRoute {
  path: string
  type: 'page' | 'route' | 'slot-page' | 'intercepting-page'
  file: string
  methods?: string[]
  params: string[]
  slot?: string
  layouts: string[]
  templates: string[]
  loading: string | null
  error: string | null
  not_found: string | null
  global_error: string | null
  segment_config: { file: string; key: string; value: string | number | boolean }[]
  effective_revalidate: number | false | null
}

export function resolveAppRoutes(root: string, tree: SegmentNode): ResolvedRoute[] {
  const out: ResolvedRoute[] = []
  const rel = (p: string | undefined) => (p ? relative(root, p) : null)
  const globalError = tree.files['global-error'] ?? null

  const walk = (node: SegmentNode, chain: SegmentNode[]): void => {
    const full = [...chain, node]
    for (const kind of ['page', 'route'] as const) {
      const file = node.files[kind]
      if (!file) continue

      const slotNode = full.find(n => n.kind === 'parallel')
      const intercepting = full.some(n => n.kind === 'intercepting')
      const nearest = (f: SpecialFile) => rel([...full].reverse().find(n => n.files[f])?.files[f])

      const config: ResolvedRoute['segment_config'] = []
      for (const n of full) {
        // Ancestors contribute only their layout; the leaf contributes its layout and this page/route
        const segmentFiles = n === node ? [n.files.layout, file] : [n.files.layout]
        for (const f of segmentFiles) {
          if (!f || !CODE_EXT.test(f)) continue
          const sf = parseFile(f)
          if (!sf) continue
          for (const key of SEGMENT_CONFIG_KEYS) {
            const value = literalExport(sf, key)
            if (value !== null) config.push({ file: relative(root, f), key, value })
          }
        }
      }
      // Next.js uses the lowest revalidate in the segment chain; `false` only if nothing sets a number
      const revalidates = config.filter(c => c.key === 'revalidate').map(c => c.value)
      const numeric = revalidates.filter((v): v is number => typeof v === 'number')
      const effective = numeric.length ? Math.min(...numeric) : revalidates.includes(false) ? false : null

      let methods: string[] | undefined
      if (kind === 'route') {
        const sf = parseFile(file)
        methods = sf ? getExports(sf).map(e => e.name).filter(n => HTTP_METHODS.includes(n)) : []
      }

      out.push({
        path: node.path,
        type: kind === 'route' ? 'route' : slotNode ? 'slot-page' : intercepting ? 'intercepting-page' : 'page',
        file: relative(root, file),
        methods,
        params: full.filter(n => ['dynamic', 'catch-all', 'optional-catch-all'].includes(n.kind))
          .map(n => n.name.replace(/[[\].]/g, '')),
        slot: slotNode?.name,
        // Layouts/templates in a segment wrap that segment's page (so the node itself is included); they never wrap route handlers
        layouts: kind === 'page' ? full.filter(n => n.files.layout).map(n => rel(n.files.layout)!) : [],
        templates: kind === 'page' ? full.filter(n => n.files.template).map(n => rel(n.files.template)!) : [],
        loading: kind === 'page' ? nearest('loading') : null,
        error: kind === 'page' ? nearest('error') : null,
        not_found: kind === 'page' ? nearest('not-found') : null,
        global_error: kind === 'page' ? rel(globalError ?? undefined) : null,
        segment_config: config,
        effective_revalidate: effective,
      })
    }
    for (const child of node.children) walk(child, full)
  }

  walk(tree, [])
  return out
}

// ---------------------------------------------------------------------------
// Structural findings
// ---------------------------------------------------------------------------

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  detail: string
  file?: string
  /** URL path the finding is about; .nextjs-lens.json route patterns match this, never the detail text */
  route?: string
  /** For findings that list many routes: the routes, with `summary` being the detail text before the list */
  routes?: string[]
  summary?: string
}

export function auditAppTree(root: string, tree: SegmentNode, routes: ResolvedRoute[]): Finding[] {
  const findings: Finding[] = []
  const rel = (p: string) => relative(root, p)
  const nextMajor = nextMajorVersion(root)

  const visit = (node: SegmentNode, hasLayoutAbove: boolean): void => {
    const f = node.files
    if (f.page && f.route && node.kind !== 'parallel') {
      findings.push({ severity: 'high', detail: `page and route handler in the same segment "${node.path}": Next.js rejects this at build time`, file: rel(f.route), route: node.path })
    }
    for (const boundary of ['error', 'global-error'] as const) {
      const file = f[boundary]
      if (!file) continue
      const sf = parseFile(file)
      if (sf && fileDirective(sf) !== 'use client') {
        findings.push({ severity: 'high', detail: `${boundary} boundary must be a Client Component: add 'use client'`, file: rel(file), route: node.path })
      }
    }
    for (const entry of ['page', 'layout'] as const) {
      const file = f[entry]
      if (!file || !CODE_EXT.test(file)) continue
      const sf = parseFile(file)
      if (!sf || fileDirective(sf) !== 'use client') continue
      const serverOnly = getExports(sf).map(e => e.name).filter(n => ['metadata', 'generateMetadata', 'generateStaticParams', 'viewport', 'generateViewport'].includes(n))
      if (serverOnly.length) {
        findings.push({ severity: 'high', detail: `'use client' ${entry} exports ${serverOnly.join(', ')}: these are only allowed in Server Components and fail the build`, file: rel(file), route: node.path })
      }
    }
    if (node.kind === 'parallel' && !f.default) {
      // Next.js 16 made default.js mandatory for every slot; earlier versions only 404 on a hard navigation
      findings.push(nextMajor !== null && nextMajor >= 16
        ? {
          severity: 'high',
          detail: `Parallel slot ${node.name} has no default.*: Next.js 16 fails the build without one; add a default.tsx that returns null or calls notFound()`,
          file: rel(node.dir),
          route: node.path,
        }
        : {
          severity: 'medium',
          detail: `Parallel slot ${node.name} has no default.*: hard navigation to sub-routes the slot doesn't match will 404, and Next.js 16 builds fail without it`,
          file: rel(node.dir),
          route: node.path,
        })
    }
    if (f.page && !hasLayoutAbove && !f.layout) {
      findings.push({ severity: 'high', detail: `Page at "${node.path}" has no root layout above it`, file: rel(f.page), route: node.path })
    }
    for (const child of node.children) visit(child, hasLayoutAbove || !!f.layout)
  }
  visit(tree, false)

  // Two route groups resolving to the same URL
  const byPath = new Map<string, string[]>()
  for (const r of routes) {
    if (r.type !== 'page' && r.type !== 'route') continue
    byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.file])
  }
  for (const [path, files] of byPath) {
    if (files.length > 1) findings.push({ severity: 'high', detail: `Multiple files resolve to "${path}": ${files.join(', ')}`, route: path })
  }

  const noErrorBoundary = routes.filter(r => r.type === 'page' && !r.error)
  if (noErrorBoundary.length) {
    const summary = 'Pages with no error.* boundary in their segment chain (errors fall through to global-error or the default error page)'
    const routes = noErrorBoundary.map(r => r.path)
    findings.push({ severity: 'info', detail: `${summary}: ${routes.join(', ')}`, summary, routes })
  }
  return findings
}

// ---------------------------------------------------------------------------
// ASCII rendering
// ---------------------------------------------------------------------------

export function renderTree(tree: SegmentNode, pathFilter?: string): string {
  const lines: string[] = []
  const matches = (n: SegmentNode): boolean =>
    !pathFilter || n.path.startsWith(pathFilter) || pathFilter.startsWith(n.path) || n.children.some(matches)

  const label = (n: SegmentNode): string => {
    const kind = n.kind === 'static' || n.kind === 'root' ? '' : ` [${n.kind}]`
    const files = SPECIAL_FILES.filter(f => n.files[f])
    return `${n.kind === 'root' ? '/' : n.name}${kind}${files.length ? `  (${files.join(', ')})` : ''}`
  }

  const render = (n: SegmentNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    lines.push(isRoot ? label(n) : `${prefix}${isLast ? '└── ' : '├── '}${label(n)}`)
    const kids = n.children.filter(matches)
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ')
    kids.forEach((c, i) => render(c, childPrefix, i === kids.length - 1, false))
  }
  render(tree, '', true, true)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Pages Router
// ---------------------------------------------------------------------------

export function resolvePagesRoutes(root: string, pagesDir: string): { path: string; type: string; file: string }[] {
  return walkFiles(pagesDir, ['.tsx', '.ts', '.jsx', '.js', '.mdx', '.md'])
    .filter(f => !f.endsWith('.d.ts'))
    .map(f => {
      const fromPages = relative(pagesDir, f).replace(PAGE_EXT, '')
      const special = ['_app', '_document', '_error'].includes(fromPages)
      const path = '/' + fromPages.replace(/(^|\/)index$/, '')
      return {
        path: special ? `(${fromPages})` : path === '/' ? '/' : path.replace(/\/$/, ''),
        type: special ? 'pages-special' : fromPages.startsWith('api/') ? 'pages-api' : 'pages-page',
        file: relative(root, f),
      }
    })
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerRouteTools(tools: ToolCollector, root: string, appDir: string | null, pagesDir: string | null): void {

  tools.register({
    name: 'list_routes',
    description:
      'Flat list of every route in the Next.js app: App Router pages and route handlers (with HTTP methods parsed from the AST, ' +
      'including `export const GET = ...` and `export { handler as POST }`), parallel-slot and intercepting pages, and Pages Router pages/API routes.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter: "page", "api", or "all" (default "all")', enum: ['page', 'api', 'all'] },
      },
      required: [],
    },
    execute: async (args: { type?: string }) => {
      const filter = args.type ?? 'all'
      const routes: { path: string; type: string; file: string; methods?: string[]; size: number }[] = []
      if (appDir) {
        for (const r of resolveAppRoutes(root, buildAppTree(appDir))) {
          const isApi = r.type === 'route'
          if (filter === 'api' && !isApi) continue
          if (filter === 'page' && isApi) continue
          routes.push({ path: r.path, type: r.type, file: r.file, methods: r.methods, size: statSync(join(root, r.file)).size })
        }
      }
      if (pagesDir) {
        for (const r of resolvePagesRoutes(root, pagesDir)) {
          const isApi = r.type === 'pages-api'
          if (filter === 'api' && !isApi) continue
          if (filter === 'page' && (isApi || r.type === 'pages-special')) continue
          routes.push({ ...r, size: statSync(join(root, r.file)).size })
        }
      }
      return { count: routes.length, routes }
    },
  })

  tools.register({
    name: 'get_route_tree',
    description:
      'App Router segment tree with inheritance resolved. For every page, shows the exact layout chain (outer → inner), templates, ' +
      'and which loading, error, not-found, and global-error boundary actually applies; merges route segment config across the chain ' +
      '(effective revalidate = lowest in chain). Flags structural problems: page + route conflicts, error boundaries missing \'use client\', ' +
      'parallel slots without default, pages without a root layout, and route groups colliding on the same URL.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Only include routes under this URL prefix, e.g. "/dashboard" (optional)' },
      },
      required: [],
    },
    execute: async (args: { path?: string }) => {
      if (!appDir) return { error: 'No app/ or src/app/ directory found: this tool covers the App Router only' }
      const tree = buildAppTree(appDir)
      const all = resolveAppRoutes(root, tree)
      const routes = args.path ? all.filter(r => r.path.startsWith(args.path!)) : all
      return {
        app_dir: relative(root, appDir),
        tree: renderTree(tree, args.path),
        routes,
        findings: auditAppTree(root, tree, all),
      }
    },
  })
}
