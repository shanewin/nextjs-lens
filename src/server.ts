#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

import type { ToolRegistration, PropertySchema, ToolCollector } from './core/types.js'
import { applyRules, describeRules, loadRules } from './core/rules.js'
import { resolveNextApp } from './core/workspace.js'
import { registerNextjsTools } from './stacks/nextjs.js'
import { registerFileTools } from './scanners/files.js'
import { registerImportTools } from './scanners/imports.js'
import { registerStyleTools } from './scanners/styles.js'

// ---------------------------------------------------------------------------
// JSON Schema → Zod converter
// ---------------------------------------------------------------------------

function propertyToZod(prop: PropertySchema): z.ZodTypeAny {
  switch (prop.type) {
    case 'string': {
      let s: z.ZodTypeAny = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string()
      if (prop.description) s = s.describe(prop.description)
      return s
    }
    case 'number': {
      let n = z.number()
      if (prop.description) n = n.describe(prop.description)
      return n
    }
    case 'boolean': {
      let b = z.boolean()
      if (prop.description) b = b.describe(prop.description)
      return b
    }
    case 'array': {
      const items = prop.items ? propertyToZod(prop.items) : z.unknown()
      let a = z.array(items)
      if (prop.description) a = a.describe(prop.description)
      return a
    }
    default:
      return z.unknown()
  }
}

function buildZodShape(
  properties: Record<string, PropertySchema>,
  required: string[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, prop] of Object.entries(properties)) {
    let field = propertyToZod(prop)
    if (!required.includes(key)) {
      if (prop.default !== undefined) {
        field = field.default(prop.default)
      } else {
        field = field.optional()
      }
    }
    shape[key] = field
  }
  return shape
}

// ---------------------------------------------------------------------------
// Collect tools
// ---------------------------------------------------------------------------

const PROJECT_PATH = process.env.PROJECT_PATH
if (!PROJECT_PATH) {
  console.error('ERROR: PROJECT_PATH environment variable is required.')
  console.error('Set it to the root of the project you want to analyze.')
  console.error('')
  console.error('Example .mcp.json:')
  console.error(JSON.stringify({
    mcpServers: {
      'nextjs-lens': {
        command: 'npx',
        args: ['-y', 'nextjs-lens'],
        env: { PROJECT_PATH: '/path/to/your/project' },
      },
    },
  }, null, 2))
  process.exit(1)
}

const root = resolve(PROJECT_PATH)

const tools: ToolRegistration[] = []
const collector: ToolCollector = {
  register(tool: ToolRegistration) {
    tools.push(tool)
  },
}

// 1. Always register generic scanners
registerFileTools(collector, root)
registerImportTools(collector, root)
registerStyleTools(collector, root)

// 2. Locate the Next.js app (PROJECT_PATH, NEXTJS_LENS_APP, or a monorepo's main app) and register its tools
// CODEBASE_LENS_APP is the pre-rename name, still honored
const resolution = resolveNextApp(root, process.env.NEXTJS_LENS_APP || process.env.CODEBASE_LENS_APP || undefined)
if (!resolution.ok) {
  console.error(`ERROR: ${resolution.error}`)
  process.exit(1)
}
const appRoot = resolution.appRoot
registerNextjsTools(collector, appRoot)

// 3. Project rules (.nextjs-lens.json in PROJECT_PATH or the app directory)
const loadedRules = loadRules([root, appRoot])
const rules = loadedRules.rules
if (loadedRules.error) console.error(`nextjs-lens: ${loadedRules.path}: ${loadedRules.error}`)

const detectionSummary = [`Next.js app: ${appRoot}`, resolution.note].filter(Boolean).join('\n\n')

// ---------------------------------------------------------------------------
// Create MCP server
// ---------------------------------------------------------------------------

// Shown to the model even when the tools themselves are deferred, so it knows which ones to load by name
const INSTRUCTIONS = [
  'nextjs-lens answers whole-app questions about this Next.js project from its parsed source. Prefer it over reading files one by one.',
  'Security audit: run all of audit_route_auth, find_server_actions, map_client_boundaries (server code imported by client code), ' +
    'analyze_middleware, audit_env_files, and audit_next_config.',
  'Structure and rendering: get_route_tree, list_routes, analyze_data_fetching. Dead code: find_unused_exports.',
  'Findings come from static analysis: read the cited file before reporting anything the finding does not state.',
].join('\n')

const server = new McpServer({
  name: 'nextjs-lens',
  version: '0.4.0',
}, { instructions: INSTRUCTIONS })

// Tools with a summarizer get a `detail` parameter: a compact summary by default, the complete result on request
const DETAIL_PARAM: PropertySchema = {
  type: 'string',
  enum: ['summary', 'full'],
  default: 'summary',
  description: "'summary' (default): counts, all findings, and compact lists sized for large apps. 'full': every per-item field.",
}

// Register each collected tool
for (const tool of tools) {
  const properties = tool.summarize ? { ...tool.parameters.properties, detail: DETAIL_PARAM } : tool.parameters.properties
  const description = tool.summarize
    ? `${tool.description} Returns a compact summary by default; pass detail: 'full' for complete per-item data.`
    : tool.description
  const hasProperties = Object.keys(properties).length > 0
  const shape = hasProperties
    ? buildZodShape(properties, tool.parameters.required)
    : undefined

  const handler = async (args: any) => {
    try {
      const { detail, ...toolArgs } = args ?? {}
      // Auth functions declared in .nextjs-lens.json apply to every call of a tool that accepts auth_functions
      if (rules.authFunctions.length && tool.parameters.properties.auth_functions) {
        const passed = typeof toolArgs.auth_functions === 'string' ? toolArgs.auth_functions.split(',') : []
        toolArgs.auth_functions = [...new Set([...rules.authFunctions, ...passed].map(s => s.trim()).filter(Boolean))].join(',')
      }
      const raw = await tool.execute(toolArgs)
      // Rules first, so summaries count and list only what survives exemptions and ignores
      const ruled = applyRules(raw, rules)
      const result = tool.summarize && detail !== 'full' && !ruled?.error
        ? { ...tool.summarize(ruled), ...(ruled?.rules_applied ? { rules_applied: ruled.rules_applied } : {}), detail: 'summary' }
        : ruled
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      }
    }
  }

  if (shape) {
    server.tool(tool.name, description, shape, handler)
  } else {
    server.tool(tool.name, description, handler)
  }
}

// Register a meta resource with detection info
server.resource(
  'nextjs-lens:status',
  'lens://status',
  { mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: `# nextjs-lens Status\n\nProject: ${root}\n\n${detectionSummary}\n\nTools loaded: ${tools.length}\n\nRules: ${describeRules(loadedRules)}\n\n## Available Tools\n${tools.map(t => `- **${t.name}**: ${t.description.split('.')[0]}`).join('\n')}\n`,
    }],
  }),
)

// ---------------------------------------------------------------------------
// Register knowledge files as MCP resources
// ---------------------------------------------------------------------------
// Knowledge files live in knowledge/nextjs/ and come in two flavors:
//   - docs/*.md: official docs pages, one per file plus docs/index.md (run npm run fetch-docs)
//   - community.md: human-maintained best practices and gotchas

const knowledgeDir = join(import.meta.dirname, '..', 'knowledge', 'nextjs')
const knowledgeFiles = existsSync(knowledgeDir)
  ? readdirSync(knowledgeDir, { recursive: true, encoding: 'utf-8' }).filter(f => f.endsWith('.md')).map(f => f.split('\\').join('/')).sort()
  : []

for (const file of knowledgeFiles) {
  const filePath = join(knowledgeDir, file)

  server.resource(
    `knowledge:nextjs:${file.replace(/\.md$/, '').split('/').join(':')}`,
    `lens://knowledge/nextjs/${file}`,
    { mimeType: 'text/markdown' },
    async (uri) => {
      const text = readFileSync(filePath, 'utf-8')
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text,
        }],
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
