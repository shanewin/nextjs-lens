# nextjs-lens

[![npm](https://img.shields.io/npm/v/nextjs-lens)](https://www.npmjs.com/package/nextjs-lens)

An MCP server that gives Claude Code (or any MCP client) deep insight into Next.js projects.

Claude can read a `page.tsx` file on its own. What it can't easily do is hold the whole app in its head: which layout wraps which page, where `'use client'` pulls a subtree into the browser bundle, which route handlers skip auth, or which exports nothing imports. nextjs-lens parses your project with the TypeScript compiler API and answers those questions directly.

## Why

We asked Claude Code "Do a full security audit. What are all the security issues?" about a Next.js test app with 90 source files and 27 planted security issues:

| Config | Issues found (of 27) | Wrong claims | Cost | Time |
|--------|---------------------|--------------|------|------|
| Haiku 4.5 alone | 12 | 5 | $0.11 | 60s |
| **Haiku 4.5 + nextjs-lens** | **20** | **1.3** | **$0.05** | **27s** |
| Opus 5.5 alone | 20 | 0.3 | $0.77 | 132s |
| **Opus 5.5 + nextjs-lens** | **21** | **0.3** | **$0.37** | **60s** |

Haiku with nextjs-lens found as many issues as Opus without it, at one-fifteenth the cost and in a fifth of the time. Opus with nextjs-lens found the most, at half the cost and time of Opus alone. Without tools, Haiku made about five wrong claims per audit, such as auth checks it said were bypassed (they fail closed) and CSRF holes that Next.js already blocks. With tools, that dropped to one or two.

Averages of 3 runs per config, with nextjs-lens 0.4.0 (October 2026). The "+ nextjs-lens" runs were told to use the tools; models rarely reach for MCP tools on their own. Answers were graded blind against the app's answer key, with every claim checked against the source.

## How it works

```
Your Next.js project
    ↓ PROJECT_PATH
nextjs-lens (MCP server over stdio)
    ├── Next.js tools (AST-based; PROJECT_PATH must be a Next.js app or a monorepo containing one)
    ├── Generic scanners (files, search, imports, styles)
    └── Knowledge resources (official docs + community gotchas)
```

## Quick Start

### 1. Add to your project

Requires Node.js 20.11 or later. From your project root, add it to Claude Code with one command:

```bash
claude mcp add nextjs-lens --scope project -e PROJECT_PATH="$PWD" -- npx -y nextjs-lens
```

Or create `.mcp.json` in your project root yourself:

```json
{
  "mcpServers": {
    "nextjs-lens": {
      "command": "npx",
      "args": ["-y", "nextjs-lens"],
      "env": {
        "PROJECT_PATH": "/absolute/path/to/your/project"
      }
    }
  }
}
```

To run from source instead (for development, or to refresh the bundled Next.js docs):

```bash
git clone https://github.com/shanewin/nextjs-lens.git
cd nextjs-lens
npm install
npm run fetch-docs   # pull the latest Next.js docs (optional)
npm run build
```

Then use `"command": "node"` and `"args": ["/absolute/path/to/nextjs-lens/dist/server.js"]` in `.mcp.json`.

In a monorepo, point `PROJECT_PATH` at the repo root: nextjs-lens analyzes the Next.js app with the most routes. To choose a different app, set `"NEXTJS_LENS_APP": "apps/admin"` (a path relative to `PROJECT_PATH`) in `env`. If no Next.js app is found, the server exits with an error explaining why.

To tune findings for your project (exempt public routes, raise severities, ignore legacy files), add a [`.nextjs-lens.json`](#project-rules) file.

This project was previously called codebase-lens. Existing `.codebase-lens.json` files and the `CODEBASE_LENS_APP` variable still work.

### 2. Use it

Open Claude Code in your project. The tools are available automatically. Try:

- "Show me the route tree with which layouts and error boundaries apply to each page"
- "Where does 'use client' pull server code into the client bundle?"
- "Which API route handlers don't check auth?"
- "Find exports nothing imports"
- "Audit my next.config and middleware for security issues"

## Tools Reference

### Next.js (loaded when `next.config.*` exists or `next` is in package.json)

Every tool parses source with the TypeScript compiler API (`ts.createSourceFile`), not regex. That means it handles multi-line exports, `export const GET = withAuth(...)`, `export { handler as POST }`, re-export barrels, and tsconfig path aliases.

Results are compact by default so they fit comfortably in Claude's context on large apps: counts, every finding, and one-line lists. Pass `detail: "full"` to any Next.js tool for complete per-item data (layout chains, file lists, auth evidence, fetch options).

**Whole-app analysis**

| Tool | What it does |
|------|-------------|
| `get_route_tree` | App Router segment tree with inheritance resolved: the layout chain, templates, and the loading / error / not-found boundary that actually applies to each page, plus merged route segment config. Flags page+route conflicts, error boundaries without `'use client'`, parallel slots without `default`, missing root layouts, and route groups that collide on the same URL. |
| `map_client_boundaries` | Walks the real import graph from every page and layout to find where `'use client'` starts the client tree. Reports which files ship to the browser, which stay on the server, and which run in both. Flags server-only code (`server-only`, Node builtins, DB/secret SDKs) in the client bundle, listing every client import chain that reaches them, private `process.env` reads in client code, and hooks used in Server Components. Pass `file` to see why one file runs where it does. |
| `audit_route_auth` | Per-method auth coverage for every route handler and Pages API route: auth calls, auth wrappers, credential header checks, shared-secret comparisons, and webhook signature checks. Follows auth helpers in the same file or imported from other modules, and handlers defined in other modules (re-exports, imported functions passed to wrappers). Handlers built with tRPC, GraphQL, or Auth.js are marked delegated rather than unprotected, and routes that are usually public by design (health checks, CSRF tokens, sign-in flows, OG images) are reported as info. Evaluates the middleware/proxy matcher against real routes to separate endpoints protected in the handler, protected only by middleware, and unprotected. |
| `find_unused_exports` | Dead exports and unimported files. Follows barrel re-exports and dynamic imports, and ignores the exports Next.js consumes by convention (default exports, `metadata`, `generateStaticParams`, HTTP handlers, segment config, …). |

**Focused audits**

| Tool | What it does |
|------|-------------|
| `list_routes` | Flat list of App Router + Pages Router routes with HTTP methods |
| `find_server_actions` | Every server action (module-level and inline `'use server'`) with auth checks, input validation, and importers. Unauthenticated actions are graded: destroying data is critical, exporting data is high, cache-only revalidation is low |
| `analyze_middleware` | Parsed matcher config, auth logic, and exactly which routes middleware/proxy runs on and which it skips. On Next.js 16, migration advice that accounts for the Edge runtime (proxy only runs on Node.js) |
| `analyze_data_fetching` | Per-route segment config, `fetch` cache options, `'use cache'`, `cacheLife`/`cacheTag`, dynamic APIs (followed into imported data helpers, with the file each came from), and the inferred rendering mode. On Next.js 16, flags the deprecated single-argument `revalidateTag` |
| `audit_next_config` | Statically evaluates next.config (unwrapping plugin wrappers) and flags secrets in `env`, wildcard image hosts, ignored build errors, source maps, and missing security headers |
| `audit_env_files` | Secret-looking `NEXT_PUBLIC_` vars, env files not covered by .gitignore (high when they contain secrets), `.env.example` templates and monorepo-root env files, and public vars used in code but defined nowhere |

### Generic (always available)

| Tool | What it does |
|------|-------------|
| `list_project_files` | List files matching extensions with sizes |
| `read_file` | Read any file (100KB limit) |
| `search_content` | Regex search across the codebase |
| `trace_imports` | Build a dependency graph from any file |
| `search_styles` | Find hardcoded colors/spacing escaping the design system |

## Project Rules

Add `.nextjs-lens.json` to `PROJECT_PATH` (or to the analyzed app's directory) to adapt findings to your project:

```json
{
  "authFunctions": ["makeSureLoggedIn", "requireOrgMember"],
  "exempt": ["/api/public/*", "/api/search"],
  "severity": {
    "src/app/api/cron/*": "critical",
    "src/app/api/billing/webhook": "critical"
  },
  "ignore": ["src/lib/legacy/*", "src/components/Unused.tsx"]
}
```

| Key | Effect |
|-----|--------|
| `exempt` | Drops findings whose file or route matches. A finding that lists many routes (such as "route handlers not matched by middleware") loses only the exempt routes. |
| `severity` | Reports matching findings at `critical`, `high`, `medium`, `low`, or `info`. The original level is kept in `original_severity`. |
| `ignore` | Removes matching files from `find_unused_exports` results. |
| `authFunctions` | Names of your own auth check functions. `audit_route_auth`, `find_server_actions`, and `analyze_middleware` treat calls to them as auth checks, alongside the built-in list (`auth()`, `getServerSession`, `currentUser`, …) and any helper that calls one of those. |

Patterns match file paths (relative to the app directory) or URL routes:

- `src/app/api/cron/*` or `/api/public/*`: everything under that prefix
- `*` matches within one path segment, `**` across segments
- A plain path matches itself and anything inside it, so `src/app/api/billing/webhook` covers its `route.ts`

Rules match a finding's `file` and `route` fields, never its message text. Results that rules changed include a `rules_applied` count. Problems in the file (invalid JSON, unknown keys, unsupported severities) are logged to stderr and shown in the `lens://status` resource.

## Policy Checks

Write down which code may import what, and check it in CI. Add `nextjs-lens.policy.json` to the project root (or the app directory):

```json
{
  "version": 1,
  "mode": "warn",
  "rules": {
    "client-bundle": [
      { "name": "database stays on the server", "module": ["@prisma/client", "@acme/db"], "message": "Load data in a server component and pass it down" },
      { "import": "src/server/**" }
    ],
    "forbidden-imports": [
      { "module": "stripe", "allowedIn": ["src/server/billing/**"] },
      { "module": "next/router", "from": "src/app/**", "message": "Use next/navigation in the App Router" }
    ]
  }
}
```

```bash
npx nextjs-lens check /path/to/project          # readable report
npx nextjs-lens check /path/to/project --json   # machine-readable, includes exit_code
```

From a source checkout, `npm run check -- /path/to/project` does the same (add `--silent` before `check` when piping `--json`).

| Rule | Checks |
|------|--------|
| `client-bundle` | Nothing it names reaches the browser through any chain of imports from a `'use client'` module. Follows the same import walk as `map_client_boundaries`: type-only imports, `'use server'` action references, and unused barrel re-exports don't count. Each violation points at the import to fix and lists every chain to it. |
| `forbidden-imports` | Only allowed files import something: importers matching `from` are violations, or importers outside `allowedIn` are (an empty `allowedIn` means nowhere). Covers imports, re-exports, and dynamic `import()`. |

Each rule entry needs a target, either `module` (package names) or `import` (file globs, matched after resolving path aliases). The other fields are optional:

- `module` names match exactly; `"pkg/*"` matches the package's subpaths, so list both to cover either.
- `except` lists importer globs the rule never applies to, such as data-loading files next to UI code.
- `severity` is `error` (default) or `warn`, and `message` is shown with each violation.
- Files inside an `import` glob may import each other.
- `forbidden-imports` only: `includeTypeOnly` also checks type-only imports, and `includeTests` also checks test, story, and mock files.

Globs are relative to the app directory and use the same patterns as project rules.

`mode` decides the exit code, and it can only be set in the policy file, so protect that file with `CODEOWNERS`:

| Exit code | When |
|-----------|------|
| 0 | No error-severity violations outside the baseline, or `mode` is `warn` or `off` |
| 1 | `mode` is `enforce` and there is at least one error-severity violation that isn't in the baseline |
| 2 | The check could not run: no policy file, an invalid policy or baseline (every problem is listed), or no Next.js app |

The policy file fails closed: an unknown key, a misspelled rule name, or a bad value makes the whole policy invalid instead of quietly skipping that rule.

### Baselines

An existing app usually breaks a new policy in a few places already. A baseline records those, so you can switch to `enforce` right away and fail only on new violations:

```bash
npx nextjs-lens check /path/to/project --update-baseline   # record every current violation in nextjs-lens.baseline.json
npx nextjs-lens check /path/to/project --prune-baseline    # remove violations that have been fixed; never adds new ones
```

Commit `nextjs-lens.baseline.json` next to the policy file and protect it with `CODEOWNERS` too, since adding an entry allows a violation. Violations are matched by rule, file, and what they import, not by line number, so unrelated edits don't make known violations look new. A second offending import of the same thing in the same file is still new.

Each report lists new violations in full, known ones in a short list, and baseline entries that no longer occur, so the baseline can shrink as code is fixed. An invalid baseline file stops the check (exit code 2) instead of being ignored; `--update-baseline` regenerates it. Renaming a rule makes its baselined violations new, since the rule name is part of the match.

Rollout: start in `warn` mode to see what the policy reports, fix or `except` what's wrong, record the rest with `--update-baseline`, then switch to `enforce`.

### Inline exceptions

To allow one specific violation, say why in a comment on the line above the import, or at the end of the import's first line:

```ts
// lens-allow client-bundle: only imports an error message constant, no server code
import { INVALID_TOKEN_ERROR } from '@acme/lib/server/turnstile'

import { db } from '@/server/db' // lens-allow "No server code in routes": removed in #1234
```

Name the rule by type (`forbidden-imports`, `client-bundle`) or by its `name` in quotes. Other `//` comment lines may sit between the exception and the import.

- The reason is required. A comment without one doesn't apply, and the report says so.
- Every applied exception is listed in the report with its reason, so reviewers see them.
- Comments that no longer match a violation are listed as unused, so they don't pile up.
- Allowed violations are never written to the baseline. Removing the comment makes the violation fail again.

Use exceptions for decisions about a single import, and `except` in the policy for whole groups of files.

### Pull request annotations (SARIF)

`--sarif <file>` also writes the violations that count (not baselined, not allowed by an exception) in [SARIF](https://sarifweb.azurewebsites.net/), which GitHub code scanning shows on pull requests at the offending line. Run the check against the repository root so the paths line up.

```yaml
# .github/workflows/nextjs-lens.yml
name: nextjs-lens
on: [pull_request]
permissions:
  contents: read
  security-events: write
jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npx -y nextjs-lens@0.4 check . --sarif nextjs-lens.sarif
      - uses: github/codeql-action/upload-sarif@v3
        if: always() && hashFiles('nextjs-lens.sarif') != ''
        with:
          sarif_file: nextjs-lens.sarif
```

The check step fails the job in `enforce` mode; the upload runs either way. Code scanning is free for public repositories; private repositories need GitHub Advanced Security. Without it, the check step's log still shows every violation.

## Knowledge Resources

Markdown knowledge files are exposed as MCP resources that Claude can read:

- **`knowledge/nextjs/docs/`**: selected official Next.js docs pages (routing, Server and Client Components, route handlers, proxy, data security, caching, environment variables, the version 16 upgrade guide), one resource per page, plus `docs/index.md` listing them. `npm run fetch-docs` refreshes them from nextjs.org's Markdown versions; don't edit them by hand.
- **`knowledge/nextjs/community.md`**: security checklist, Next.js 16 changes, gotchas, and patterns the official docs don't cover well. **This is where contributors add the most value.** PRs welcome.

## Architecture

```
src/
├── cli.ts                 # The nextjs-lens command: starts the MCP server, or runs `check`
├── server.ts              # MCP entry point, app resolution, rules, tool registration
├── core/
│   ├── types.ts           # ToolRegistration, ToolCollector interfaces
│   ├── helpers.ts         # safePath, walkFiles, file utilities
│   ├── rules.ts           # .nextjs-lens.json loading and matching
│   ├── policy.ts          # nextjs-lens.policy.json loading and validation
│   ├── check.ts           # Runs policy rules and builds the check report
│   ├── checkCli.ts        # `nextjs-lens check` arguments and output
│   ├── baseline.ts        # nextjs-lens.baseline.json: known violations
│   ├── exceptions.ts      # // lens-allow inline exceptions
│   ├── sarif.ts           # SARIF output for GitHub code scanning
│   ├── runner.ts          # Runs every Next.js tool with timings (snapshot script)
│   └── workspace.ts       # Finds the Next.js app (PROJECT_PATH, NEXTJS_LENS_APP, or monorepo workspaces)
├── scanners/              # Generic tools
│   ├── files.ts           # File listing, reading, searching
│   ├── imports.ts         # Import/dependency tracing
│   └── styles.ts          # Design system compliance checking
└── stacks/
    ├── nextjs.ts          # Registers the Next.js tools; config, middleware, and env audits
    └── nextjs/
        ├── ast.ts         # Parsing, exports/imports, module resolution (tsconfig paths and extends, workspaces)
        ├── graph.ts       # Shared, cached import graph used by every tool
        ├── routes.ts      # Route tree and route list
        ├── boundaries.ts  # Server/client boundary map
        ├── auth.ts        # Route handler auth and server actions
        ├── unused.ts      # Unused exports
        ├── fetching.ts    # Data fetching and caching
        ├── forbidden.ts   # forbidden-imports policy rule
        ├── clientBundle.ts # client-bundle policy rule
        └── snapshot.ts    # Snapshot normalization and diffing
test/                      # node --test suites and fixture apps
knowledge/nextjs/          # Docs + community knowledge (MCP resources)
scripts/                   # check.mjs (policy check), snapshot.mjs (real-app regression check), fetch-docs.ts
```

## Development

```bash
npm test   # compiles, then runs node --test against the fixture apps in test/fixtures
```

`test/fixtures/app` (a single Next.js app) and `test/fixtures/mono` (a workspace monorepo) contain planted issues. The tests assert what each tool must find there and what it must not flag. CI runs the suite on Node 20 and 22.

Fixtures only cover the cases someone thought of, so also check a large real app before a release:

```bash
npm run snapshot -- /path/to/a/real/nextjs/app            # first run saves a snapshot; later runs print what changed
npm run snapshot -- /path/to/a/real/nextjs/app --update   # accept the current results
```

The report lists endpoint auth status flips, added and removed findings, changed counts, and tools that got much slower. It exits with 1 when anything changed. Snapshots are saved in `.lens-snapshots/` (gitignored), since they depend on your local checkout.

## License

MIT
