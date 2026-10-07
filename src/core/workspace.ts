import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { readFileSafe, walkFiles } from './helpers.js'

export interface NextAppCandidate {
  /** Absolute path to the app directory */
  path: string
  /** Path relative to the monorepo root */
  relPath: string
  /** Number of App Router page/route files plus Pages Router files: used to pick the main app */
  routeFiles: number
  /** Total source files: breaks ties between apps with the same route count */
  sourceFiles: number
}

const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts', 'next.config.cjs']

export function isNextApp(dir: string): boolean {
  if (NEXT_CONFIGS.some(n => existsSync(join(dir, n)))) return true
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    return !!({ ...pkg.dependencies, ...pkg.devDependencies }['next'])
  } catch { return false }
}

/** Workspace globs from package.json (npm/yarn/bun) and pnpm-workspace.yaml. */
function workspacePatterns(root: string, fallback = true): string[] {
  const patterns: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages
    if (Array.isArray(ws)) patterns.push(...ws)
  } catch { /* no package.json */ }

  const pnpm = readFileSafe(join(root, 'pnpm-workspace.yaml'))
  if (pnpm) {
    // Only the `packages:` list, up to the next top-level key
    const section = pnpm.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
    for (const m of section.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)) patterns.push(m[1])
  }

  // Turborepo/Nx repos without a workspaces field still tend to use these
  if (patterns.length === 0 && fallback) patterns.push('apps/*', 'packages/*')
  return patterns.filter(p => !p.startsWith('!'))
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => join(dir, e.name))
  } catch { return [] }
}

/** Minimal workspace glob expansion: literal segments, `*` (one level), `**` (any depth, capped). */
function expand(root: string, pattern: string): string[] {
  const segments = pattern.replace(/^\.\//, '').replace(/\/$/, '').split('/').filter(Boolean)
  let current = [root]
  for (const seg of segments) {
    const next: string[] = []
    for (const dir of current) {
      if (seg === '**') {
        const stack: [string, number][] = [[dir, 0]]
        while (stack.length) {
          const [d, depth] = stack.pop()!
          next.push(d)
          if (depth < 4) for (const child of listDirs(d)) stack.push([child, depth + 1])
        }
      } else if (seg.includes('*')) {
        const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
        next.push(...listDirs(dir).filter(d => re.test(d.split('/').pop()!)))
      } else if (existsSync(join(dir, seg))) {
        next.push(join(dir, seg))
      }
    }
    current = next
  }
  return current
}

function countRouteFiles(app: string): number {
  let count = 0
  for (const dir of ['app', 'src/app']) {
    count += walkFiles(join(app, dir), ['.tsx', '.ts', '.jsx', '.js', '.mdx'])
      .filter(f => /\/(page|route)\.[^/]+$/.test(f)).length
  }
  for (const dir of ['pages', 'src/pages']) {
    count += walkFiles(join(app, dir), ['.tsx', '.ts', '.jsx', '.js', '.mdx']).length
  }
  return count
}

// ---------------------------------------------------------------------------
// Workspace packages (for resolving `@scope/pkg` imports without node_modules)
// ---------------------------------------------------------------------------

export interface WorkspacePackage {
  name: string
  dir: string
  json: Record<string, any>
}

export interface Workspace {
  root: string
  packages: Map<string, WorkspacePackage>
}

const workspaceCache = new Map<string, Workspace | null>()

/** The monorepo containing `startDir` (nearest ancestor, inclusive, with a workspaces config), or null. */
export function findWorkspace(startDir: string): Workspace | null {
  if (workspaceCache.has(startDir)) return workspaceCache.get(startDir)!
  let dir = startDir
  let wsRoot: string | null = null
  while (true) {
    if (workspacePatterns(dir, false).length > 0) { wsRoot = dir; break }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  let result: Workspace | null = null
  if (wsRoot) {
    const packages = new Map<string, WorkspacePackage>()
    for (const pattern of workspacePatterns(wsRoot, false)) {
      for (const pkgDir of expand(wsRoot, pattern)) {
        try {
          const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'))
          if (typeof json.name === 'string' && !packages.has(json.name)) packages.set(json.name, { name: json.name, dir: pkgDir, json })
        } catch { /* not a package */ }
      }
    }
    result = { root: wsRoot, packages }
  }
  workspaceCache.set(startDir, result)
  return result
}

// ---------------------------------------------------------------------------
// App resolution
// ---------------------------------------------------------------------------

export type NextAppResolution =
  | { ok: true; appRoot: string; note: string | null }
  | { ok: false; error: string }

/**
 * Decide which Next.js app to analyze: the NEXTJS_LENS_APP override if given, else PROJECT_PATH itself,
 * else (in a monorepo) the workspace app with the most routes.
 */
export function resolveNextApp(projectPath: string, override?: string): NextAppResolution {
  const root = resolve(projectPath)
  if (override) {
    const overridePath = resolve(root, override)
    if (!isNextApp(overridePath)) {
      const found = findNextApps(root)
      return {
        ok: false,
        error: `NEXTJS_LENS_APP="${override}" is not a Next.js app (no next.config.* and no "next" dependency).` +
          (found.length ? ` Next.js apps found: ${found.map(a => a.relPath).join(', ')}.` : ''),
      }
    }
    return {
      ok: true,
      appRoot: overridePath,
      note: overridePath === root ? null : `Analyzing Next.js app at ${relative(root, overridePath)} (NEXTJS_LENS_APP). Tool file paths are relative to that directory.`,
    }
  }

  if (isNextApp(root)) return { ok: true, appRoot: root, note: null }

  const [chosen, ...others] = findNextApps(root)
  if (!chosen) {
    return {
      ok: false,
      error: `No Next.js app found at ${root} or in its workspaces. Set PROJECT_PATH to a Next.js app (a directory with next.config.* or "next" in package.json), or to the root of a monorepo that contains one.`,
    }
  }
  return {
    ok: true,
    appRoot: chosen.path,
    note:
      `Monorepo: analyzing Next.js app at ${chosen.relPath}, the app with the most routes (${chosen.routeFiles} route files). ` +
      (others.length ? `Other Next.js apps: ${others.map(a => `${a.relPath} (${a.routeFiles} route files)`).join(', ')}. Set NEXTJS_LENS_APP to analyze one of these instead. ` : '') +
      'Tool file paths are relative to that app directory.',
  }
}

/** Next.js apps inside a monorepo, most routes first. */
export function findNextApps(root: string): NextAppCandidate[] {
  const seen = new Set<string>()
  const apps: NextAppCandidate[] = []
  for (const pattern of workspacePatterns(root)) {
    for (const dir of expand(root, pattern)) {
      if (seen.has(dir) || dir === root) continue
      seen.add(dir)
      if (isNextApp(dir)) {
        apps.push({
          path: dir,
          relPath: relative(root, dir),
          routeFiles: countRouteFiles(dir),
          sourceFiles: walkFiles(dir, ['.tsx', '.ts', '.jsx', '.js', '.mdx']).length,
        })
      }
    }
  }
  return apps.sort((a, b) => b.routeFiles - a.routeFiles || b.sourceFiles - a.sourceFiles || a.relPath.localeCompare(b.relPath))
}
