import { relative } from 'node:path'
import type { ToolCollector } from '../../core/types.js'
import { readFileSafe, walkFiles } from '../../core/helpers.js'
import { findWorkspace } from '../../core/workspace.js'
import { baseName, getExports, parseFile, SOURCE_EXTS, type ExportInfo } from './ast.js'
import { projectGraph } from './graph.js'
import { HTTP_METHODS } from './routes.js'

// Exports Next.js itself consumes, keyed by file base name
const APP_FILE_EXPORTS = new Set([
  'default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', 'generateStaticParams',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'experimental_ppr',
  ...HTTP_METHODS,
])
const METADATA_FILE_EXPORTS = new Set(['default', 'alt', 'size', 'contentType', 'generateImageMetadata', 'generateSitemaps', 'runtime', 'revalidate', 'dynamic'])
const METADATA_FILES = /^(opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\d*$/
const PAGES_EXPORTS = new Set(['default', 'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'getInitialProps', 'config', 'reportWebVitals'])
const ROOT_ENTRY_EXPORTS: Record<string, Set<string>> = {
  middleware: new Set(['middleware', 'default', 'config']),
  proxy: new Set(['proxy', 'default', 'config']),
  instrumentation: new Set(['register', 'onRequestError']),
  'instrumentation-client': new Set(['onRouterTransitionStart']),
}

// Matched against the app-relative path with a leading slash. These files are entry points (run by test
// runners, scripts, or tooling), so they count as importers but are never reported as unused themselves.
const ENTRY_POINT_FILE = /(\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$)|\/(__tests__|__mocks__|__checks__|e2e|playwright|cypress|tests?|scripts)\//

function frameworkExports(file: string, appDir: string | null, pagesDir: string | null): Set<string> | null {
  const base = baseName(file)
  if (appDir && file.startsWith(appDir + '/')) {
    if (METADATA_FILES.test(base)) return METADATA_FILE_EXPORTS
    if (['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'forbidden', 'unauthorized', 'route', 'default'].includes(base)) return APP_FILE_EXPORTS
  }
  if (pagesDir && file.startsWith(pagesDir + '/')) return PAGES_EXPORTS
  const parent = file.split('/').slice(-2, -1)[0]
  if (Object.hasOwn(ROOT_ENTRY_EXPORTS, base) && (parent === 'src' || !file.includes('/src/'))) return ROOT_ENTRY_EXPORTS[base]
  return null
}

export function registerUnusedTools(tools: ToolCollector, root: string, appDir: string | null, pagesDir: string | null): void {
  tools.register({
    name: 'find_unused_exports',
    description:
      'Project-wide dead export detection that understands Next.js. Builds the full import graph (tsconfig path aliases, index files, ' +
      'dynamic import(), next/dynamic) and follows re-export chains (`export { x } from`, `export * from`) so barrel files do not hide usage. ' +
      'Never flags exports Next.js consumes by convention (default page/layout exports, metadata, generateStaticParams, route segment config, ' +
      'HTTP method handlers, getServerSideProps, middleware config, metadata image files). Reports unused exports and files nothing imports.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Only report results under this directory, e.g. "src/components" (optional)' },
        include_types: { type: 'boolean', description: 'Also report unused type/interface exports (default false)' },
      },
      required: [],
    },
    execute: async (args: { directory?: string; include_types?: boolean }) => {
      const graph = projectGraph(root)
      const { resolver, files } = graph
      const exportsByFile = new Map<string, ExportInfo[]>()
      const importers = new Map<string, Set<string>>()
      const used = new Map<string, Set<string>>() // file -> used export names ('*' = everything)
      for (const f of files) {
        const sf = parseFile(f)
        if (sf) exportsByFile.set(f, getExports(sf))
      }

      const markUsed = (file: string, name: string, seen = new Set<string>()): void => {
        const key = `${file}\0${name}`
        if (seen.has(key)) return
        seen.add(key)
        const set = used.get(file) ?? new Set<string>()
        set.add(name)
        used.set(file, set)
        const exps = exportsByFile.get(file) ?? []
        const sf = parseFile(file)
        if (!sf) return
        // Follow re-exports so usage through barrels reaches the real declaration
        for (const e of exps) {
          if (!e.from) continue
          const target = resolver.resolve(e.from, file)
          if (!target) continue
          if (e.kind === 'star') {
            if (name === '*' || !exps.some(x => x.name === name && x.kind !== 'star')) markUsed(target, name, seen)
          } else if (name === '*' || e.name === name) {
            // `export { a as b } from`: find the original name from the import side of the declaration
            const orig = graph.importsOf(file).find(i => i.specifier === e.from && i.line === e.line)?.names
            const origName = orig && orig.length === 1 ? orig[0] : e.name
            markUsed(target, name === '*' ? '*' : origName, seen)
          }
        }
      }

      // Exports Next.js consumes by convention count as used even when a route file re-exports them from elsewhere:
      // `export { POST } from '@/server/handlers/webhook'` marks the handler as used.
      for (const [file, exps] of exportsByFile) {
        const framework = frameworkExports(file, appDir, pagesDir)
        if (!framework) continue
        for (const e of exps) if (e.from && framework.has(e.name)) markUsed(file, e.name)
      }

      // In a monorepo, other packages can import the app by its package name (e.g. @acme/web/components/x).
      // Those files count as importers only; they are never reported. A text pre-filter keeps this cheap.
      const workspace = findWorkspace(root)
      const appPkgName = workspace ? [...workspace.packages.values()].find(p => p.dir === root)?.name : undefined
      const externalImporters = new Set<string>()
      if (workspace && appPkgName) {
        for (const pkg of workspace.packages.values()) {
          if (pkg.dir === root || pkg.dir.startsWith(root + '/') || root.startsWith(pkg.dir + '/')) continue
          for (const f of walkFiles(pkg.dir, SOURCE_EXTS)) {
            if (!f.endsWith('.d.ts') && readFileSafe(f)?.includes(appPkgName)) externalImporters.add(f)
          }
        }
      }

      for (const f of [...files, ...externalImporters]) {
        for (const imp of graph.importsOf(f)) {
          const target = imp.resolved
          if (!target || target === f) continue
          importers.set(target, (importers.get(target) ?? new Set()).add(f))
          // Re-export declarations are handled by markUsed when the barrel's export is used
          const isReexport = (exportsByFile.get(f) ?? []).some(e => e.from === imp.specifier && e.line === imp.line)
          if (isReexport) continue
          for (const name of imp.sideEffect ? [] : imp.names) markUsed(target, name)
        }
      }

      const scope = args.directory ? root + '/' + args.directory.replace(/^\.?\/|\/$/g, '') + '/' : null
      const unusedExports: { file: string; name: string; kind: string; line: number }[] = []
      const unusedFiles: string[] = []

      for (const [file, exps] of exportsByFile) {
        if (scope && !file.startsWith(scope)) continue
        const relPath = relative(root, file)
        if (ENTRY_POINT_FILE.test('/' + relPath)) continue
        // Root-level files are configs and framework entry points (next.config, proxy, instrumentation, …)
        if (!relPath.includes('/')) continue
        const framework = frameworkExports(file, appDir, pagesDir)
        const u = used.get(file) ?? new Set<string>()
        if (u.has('*')) continue

        const hasImporters = importers.has(file)
        if (!hasImporters && !framework && exps.length > 0) {
          unusedFiles.push(relative(root, file))
          continue
        }
        for (const e of exps) {
          if (e.kind === 'star') continue
          if (e.typeOnly && !args.include_types) continue
          if (framework?.has(e.name)) continue
          if (u.has(e.name)) continue
          unusedExports.push({ file: relative(root, file), name: e.name, kind: e.kind, line: e.line })
        }
      }

      return {
        scanned_files: files.length,
        workspace_importer_files: externalImporters.size,
        unused_export_count: unusedExports.length,
        unused_exports: unusedExports,
        unimported_files: unusedFiles.sort(),
        caveats: [
          'Imports from files outside the scanned source dirs (e.g. root-level scripts, next.config, tests outside src) are not seen.',
          'String-based references (e.g. dynamic require with computed paths, MDX imports) are not tracked.',
        ],
      }
    },
  })
}
