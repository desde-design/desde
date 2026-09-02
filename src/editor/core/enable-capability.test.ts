import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { declaredExtensionIds, enableCapability } from './enable-capability'
import { loadExtensions } from './extensions-config'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pt-enable-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const mcpPath = () => join(root, '.mcp.json')
const readRaw = async () => JSON.parse(await fs.readFile(mcpPath(), 'utf8')) as Record<string, unknown>

describe('enableCapability', () => {
  it('creates .mcp.json when absent and writes the catalog spec', async () => {
    const r = await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    expect(r.ok).toBe(true)
    const raw = await readRaw()
    const figma = (raw.mcpServers as Record<string, { command: string }>).figma
    expect(figma.command).toBe('npx')
  })

  it('writes ${VAR} UNinterpolated so a live secret is never committed', async () => {
    await enableCapability({
      repoRoot: root,
      capabilityId: 'figma',
      env: { FIGMA_API_KEY: 'figd_super_secret' },
    })
    const text = await fs.readFile(mcpPath(), 'utf8')
    expect(text).toContain('${FIGMA_API_KEY}')
    expect(text).not.toContain('figd_super_secret')
  })

  it('reports the missing env var instead of refusing', async () => {
    // The entry is valid and works the moment the var is exported; the loader
    // now skips just that entry rather than failing.
    const r = await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    expect(r.ok && r.envMissing).toBe('FIGMA_API_KEY')
  })

  it('reports no missing env when it is already exported', async () => {
    const r = await enableCapability({
      repoRoot: root,
      capabilityId: 'figma',
      env: { FIGMA_API_KEY: 'set' },
    })
    expect(r.ok && r.envMissing).toBeNull()
  })

  it('preserves unrelated servers and unknown top-level keys', async () => {
    // Claude Code reads this same file; clobbering its entries would be a
    // hostile act on a shared file.
    await fs.writeFile(
      mcpPath(),
      JSON.stringify({ mcpServers: { playwright: { command: 'pw' } }, someFutureKey: 42 }, null, 2),
    )
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const raw = await readRaw()
    expect(raw.someFutureKey).toBe(42)
    expect(Object.keys(raw.mcpServers as object).sort()).toEqual(['figma', 'playwright'])
  })

  it('refuses an unknown capability id — specs only ever come from source', async () => {
    const r = await enableCapability({ repoRoot: root, capabilityId: 'evil', env: {} })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('unknown-capability')
  })

  it('refuses when already enabled rather than silently rewriting', async () => {
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const again = await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    expect(!again.ok && again.code).toBe('already-enabled')
  })

  it('refuses rather than clobbering an unparseable .mcp.json', async () => {
    await fs.writeFile(mcpPath(), '{ this is not json')
    const r = await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    expect(!r.ok && r.code).toBe('unparseable')
    // The user's file is untouched.
    expect(await fs.readFile(mcpPath(), 'utf8')).toBe('{ this is not json')
  })

  it('leaves no temp file behind', async () => {
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const entries = await fs.readdir(root)
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([])
  })

  it('produces a file the real loader accepts, end to end', async () => {
    // The whole point: what we write must be what loadExtensions reads.
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const loaded = await loadExtensions({
      worktreeRoot: root,
      env: { FIGMA_API_KEY: 'set' },
    })
    expect(loaded.ok).toBe(true)
    expect(loaded.ok && loaded.extensions.map((e) => e.id)).toEqual(['figma'])
    expect(loaded.ok && loaded.extensions[0]!.mcpServer.env).toEqual({ FIGMA_API_KEY: 'set' })
  })

  it('a written entry whose env is unset skips cleanly instead of failing the load', async () => {
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const loaded = await loadExtensions({ worktreeRoot: root, env: {} })
    expect(loaded.ok).toBe(true)
    expect(loaded.ok && loaded.extensions).toEqual([])
    expect(loaded.ok && loaded.warnings.join(' ')).toMatch(/FIGMA_API_KEY/)
  })
  it('refuses when mcpServers is malformed, rather than replacing it', async () => {
    // The loader reports this same shape as a config error; overwriting would
    // destroy whatever the user meant to write.
    await fs.writeFile(mcpPath(), JSON.stringify({ mcpServers: ['nope'] }))
    const r = await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    expect(!r.ok && r.code).toBe('unparseable')
    expect(JSON.parse(await fs.readFile(mcpPath(), 'utf8')).mcpServers).toEqual(['nope'])
  })
})

describe('declaredExtensionIds', () => {
  it('reports an entry that is written but SKIPPED for an unset ${VAR}', async () => {
    // "Declared" and "live" genuinely differ here. The panel needs declared,
    // or a written-but-inert Figma shows as off with an Enable button that 409s.
    await enableCapability({ repoRoot: root, capabilityId: 'figma', env: {} })
    const loaded = await loadExtensions({ worktreeRoot: root, env: {} })
    expect(loaded.ok && loaded.extensions).toEqual([])
    expect(await declaredExtensionIds(root)).toEqual(['figma'])
  })

  it('returns [] when there is no config', async () => {
    expect(await declaredExtensionIds(root)).toEqual([])
  })

  it('returns [] for a malformed config rather than throwing', async () => {
    await fs.writeFile(mcpPath(), '{ not json')
    expect(await declaredExtensionIds(root)).toEqual([])
  })
})

