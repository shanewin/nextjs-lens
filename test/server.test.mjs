import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerNextjsTools } from '../dist/stacks/nextjs.js'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { FIXTURES, fixture } from './helpers.mjs'

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const NEXTJS_TOOLS = [
  'list_routes', 'get_route_tree', 'map_client_boundaries', 'audit_route_auth', 'find_server_actions',
  'find_unused_exports', 'analyze_data_fetching', 'audit_next_config', 'analyze_middleware', 'audit_env_files',
]

describe('server startup', () => {
  it('exits with an explanation when no Next.js app is found', () => {
    const run = spawnSync(process.execPath, [SERVER], { env: { ...process.env, PROJECT_PATH: FIXTURES }, input: '', encoding: 'utf8', timeout: 20_000 })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /No Next\.js app found/)
  })

  it('exits when PROJECT_PATH is missing', () => {
    const env = { ...process.env }
    delete env.PROJECT_PATH
    const run = spawnSync(process.execPath, [SERVER], { env, input: '', encoding: 'utf8', timeout: 20_000 })
    assert.equal(run.status, 1)
    assert.match(run.stderr, /PROJECT_PATH environment variable is required/)
  })
})

describe('server over MCP (monorepo root with .nextjs-lens.json)', () => {
  let client

  before(async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, PROJECT_PATH: fixture('mono') }, stderr: 'pipe' })
    client = new Client({ name: 'nextjs-lens-test', version: '1.0.0' })
    await client.connect(transport)
  })

  after(async () => {
    await client?.close()
  })

  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args })
    return JSON.parse(response.content[0].text)
  }

  it('registers all Next.js tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const tool of NEXTJS_TOOLS) assert.ok(names.includes(tool), `missing ${tool}`)
  })

  it('sends instructions that name only real tools, including every security audit tool', async () => {
    const instructions = client.getInstructions()
    const { tools } = await client.listTools()
    const names = new Set(tools.map(t => t.name))
    const mentioned = instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g)
    for (const name of mentioned) assert.ok(names.has(name), `instructions mention unknown tool ${name}`)
    for (const name of ['audit_route_auth', 'find_server_actions', 'map_client_boundaries', 'analyze_middleware', 'audit_env_files', 'audit_next_config']) {
      assert.ok(mentioned.includes(name), `instructions omit ${name}`)
    }
  })

  it('reports the chosen app and loaded rules in the status resource', async () => {
    const status = await client.readResource({ uri: 'lens://status' })
    const text = status.contents[0].text
    assert.match(text, /analyzing Next\.js app at apps\/site/)
    assert.match(text, /Rules: loaded from .*\.nextjs-lens\.json \(0 exemptions, 1 severity overrides, 1 ignore patterns, 0 auth functions\)/)
  })

  it('exposes knowledge files as resources, one per docs page', async () => {
    const { resources } = await client.listResources()
    const uris = resources.map(r => r.uri)
    for (const uri of ['lens://knowledge/nextjs/community.md', 'lens://knowledge/nextjs/docs/index.md', 'lens://knowledge/nextjs/docs/proxy.md']) {
      assert.ok(uris.includes(uri), `missing ${uri}`)
    }
    const index = await client.readResource({ uri: 'lens://knowledge/nextjs/docs/index.md' })
    assert.match(index.contents[0].text, /lens:\/\/knowledge\/nextjs\/docs\/caching\.md/)
  })

  it('applies ignore patterns to tool results', async () => {
    const result = await call('find_unused_exports')
    assert.deepEqual(result.unused_exports, [])
    assert.deepEqual(result.rules_applied, { exempted: 0, severity_overridden: 0, ignored: 1 })
  })

  it('returns a summary by default and the full result on request', async () => {
    const summary = await call('map_client_boundaries')
    assert.equal(summary.detail, 'summary')
    assert.equal(summary.client_bundle_files, undefined)
    assert.equal(typeof summary.counts.client_bundle_files, 'number')

    const full = await call('map_client_boundaries', { detail: 'full' })
    assert.equal(full.detail, undefined)
    assert.ok(Array.isArray(full.client_bundle_files))
  })

  it('applies severity overrides to tool results', async () => {
    const result = await call('map_client_boundaries')
    const leak = result.findings.find(f => f.detail.includes('"pg"'))
    assert.equal(leak.severity, 'medium')
    assert.equal(leak.original_severity, 'high')
  })
})

describe('server with authFunctions in a legacy .codebase-lens.json', () => {
  let client
  let dir

  before(async () => {
    // A copy of the app fixture with a route guarded by a helper the tool can't recognize on its own
    dir = mkdtempSync(join(tmpdir(), 'lens-auth-functions-'))
    cpSync(fixture('app'), dir, { recursive: true })
    writeFileSync(join(dir, 'src', 'lib', 'guards.ts'), [
      'export async function makeSureLoggedIn(request: Request) {',
      "  const token = new URL(request.url).searchParams.get('t')",
      "  if (!token || token.length < 32) throw new Response('Unauthorized', { status: 401 })",
      '}',
      '',
    ].join('\n'))
    mkdirSync(join(dir, 'src', 'app', 'api', 'custom'), { recursive: true })
    writeFileSync(join(dir, 'src', 'app', 'api', 'custom', 'route.ts'), [
      "import { makeSureLoggedIn } from '@/lib/guards'",
      '',
      'export async function POST(request: Request) {',
      '  await makeSureLoggedIn(request)',
      '  return Response.json({ ok: true })',
      '}',
      '',
    ].join('\n'))
    // The pre-rename file name, which must keep working
    writeFileSync(join(dir, '.codebase-lens.json'), JSON.stringify({ authFunctions: ['makeSureLoggedIn'] }))

    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, PROJECT_PATH: dir }, stderr: 'pipe' })
    client = new Client({ name: 'nextjs-lens-test', version: '1.0.0' })
    await client.connect(transport)
  })

  after(async () => {
    await client?.close()
  })

  it('does not recognize the custom guard without the config', async () => {
    const tools = []
    registerNextjsTools({ register: t => tools.push(t) }, dir)
    const { endpoints } = await tools.find(t => t.name === 'audit_route_auth').execute({})
    assert.equal(endpoints.find(e => e.path === '/api/custom').status, 'unprotected')
  })

  it('treats calls to configured auth functions as auth checks', async () => {
    const response = await client.callTool({ name: 'audit_route_auth', arguments: { detail: 'full' } })
    const { endpoints } = JSON.parse(response.content[0].text)
    const custom = endpoints.find(e => e.path === '/api/custom')
    assert.equal(custom.status, 'protected')
    assert.ok(custom.signals.some(s => s.evidence === 'makeSureLoggedIn()'))
  })

  it('reports the configured auth functions in the status resource', async () => {
    const status = await client.readResource({ uri: 'lens://status' })
    assert.match(status.contents[0].text, /1 auth functions/)
  })
})
