import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APP, SITE, runTool } from './helpers.mjs'

const leakChains = findings => findings
  .filter(f => f.detail.startsWith('Server-only module'))
  .map(f => f.chain.join(' → '))
  .sort()

describe('map_client_boundaries', () => {
  it('reports every client import chain into server-only code', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    assert.deepEqual(leakChains(findings), [
      'src/components/ClientCounter.tsx → src/lib/db.ts',
      'src/components/ClientStats.tsx → src/lib/stats.ts → src/lib/db.ts',
    ])
  })

  it('says a module marked server-only fails the build instead of shipping', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    const leak = findings.find(f => f.chain?.join(' → ') === 'src/components/ClientCounter.tsx → src/lib/db.ts')
    assert.equal(leak.effect, 'build-fails')
    assert.match(leak.detail, /src\/lib\/db\.ts \(it imports "server-only"\).*`next build` fails and it never reaches the browser/)
    assert.doesNotMatch(leak.detail, /reaches the client bundle/)
  })

  it('follows only the barrel re-exports that were imported', async () => {
    const result = await runTool(APP, 'map_client_boundaries')
    // (marketing)/layout.tsx imports { Button } from a barrel that also re-exports a client widget using db
    assert.ok(!result.client_bundle_files.includes('src/components/ui/HeavyWidget.tsx'))
    assert.ok(!result.findings.some(f => (f.chain ?? []).includes('src/components/ui/HeavyWidget.tsx')))
  })

  it('flags hooks called by Server Components, but not hook definitions', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    assert.ok(findings.some(f => f.file === 'src/components/ServerWithHook.tsx' && f.severity === 'high'))
    assert.ok(!findings.some(f => f.file === 'src/lib/useThing.ts'))
  })

  it('flags only unguarded, unshadowed module-scope browser globals', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    const browser = findings.find(f => f.file === 'src/lib/browser.ts')
    assert.match(browser.detail, /References window, document at module scope/)
    assert.ok(!findings.some(f => ['src/lib/prefs.ts', 'src/lib/storage.ts'].includes(f.file)), 'local localStorage wrapper')
  })

  it('does not flag Node builtins that Next.js polyfills for the browser', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    assert.ok(!findings.some(f => /"(node:process|path)"/.test(f.detail)))
  })

  it('reports private env reads only in client-only files', async () => {
    const { findings } = await runTool(APP, 'map_client_boundaries')
    const env = findings.filter(f => f.detail.includes('env var'))
    assert.deepEqual(env.map(f => [f.severity, f.file]), [['low', 'src/components/ClientCounter.tsx']])
  })

  it('follows workspace packages into the client bundle', async () => {
    const { findings } = await runTool(SITE, 'map_client_boundaries')
    assert.deepEqual(leakChains(findings), ['components/Counter.tsx → ../../packages/db/index.ts'])
    assert.match(findings[0].detail, /"pg"/)
    assert.equal(findings[0].effect, 'ships-to-browser')
  })
})
