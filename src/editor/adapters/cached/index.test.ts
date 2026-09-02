/**
 * Tests for `CachedManifestSource` — the version-keyed persist layer.
 * Uses a fake inner source with a call counter to assert extraction runs
 * exactly once per `package@version@extractorVersion`, and a real tmpdir
 * for the on-disk artifact.
 */
import {
  existsSync,
  mkdtempSync,
  promises as fs,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ComponentManifest,
  ComponentManifestSource,
} from '../../core'
import {
  CACHE_DIR_NAME,
  CachedManifestSource,
  EXTRACTOR_VERSION,
  fingerprintFile,
  patchCachedComponent,
  readCachedComponent,
  resolvePackageVersion,
} from './index'

function manifest(name: string): ComponentManifest {
  return {
    id: `vue-flow:${name}`,
    name,
    framework: 'vue3',
    designSystem: 'vue-flow',
    importPath: '@vue-flow/core',
    props: [],
  }
}

/** Fake source that counts how many times extraction ran. */
class FakeSource implements ComponentManifestSource {
  readonly id = 'vue-flow-core-vue-dts'
  readonly framework = 'vue3' as const
  readonly designSystem = 'vue-flow'
  calls = 0
  invalidated = 0
  constructor(private readonly manifests: ComponentManifest[]) {}
  async listComponents(): Promise<ComponentManifest[]> {
    this.calls += 1
    return this.manifests
  }
  async getComponent(name: string): Promise<ComponentManifest | null> {
    return this.manifests.find((m) => m.name === name) ?? null
  }
  invalidate(): void {
    this.invalidated += 1
  }
}

let cacheDir: string
beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'manifest-cache-'))
})
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

function make(inner: ComponentManifestSource, version = '1.0.0') {
  return new CachedManifestSource({ inner, cacheDir, key: '@vue-flow/core', version })
}

describe('CachedManifestSource', () => {
  it('extracts once on miss, then serves later instances from disk', async () => {
    const inner = new FakeSource([manifest('VueFlow'), manifest('Pane')])
    const a = make(inner)
    expect((await a.listComponents()).map((m) => m.name).sort()).toEqual([
      'Pane',
      'VueFlow',
    ])
    expect(inner.calls).toBe(1)

    // A fresh wrapper over a fresh inner (same key/version) reads the file.
    const inner2 = new FakeSource([])
    const b = make(inner2)
    expect((await b.listComponents()).map((m) => m.name).sort()).toEqual([
      'Pane',
      'VueFlow',
    ])
    expect(inner2.calls).toBe(0)
  })

  it('memoizes within a single instance (single-flight)', async () => {
    const inner = new FakeSource([manifest('VueFlow')])
    const s = make(inner)
    await Promise.all([s.listComponents(), s.getComponent('VueFlow'), s.listComponents()])
    expect(inner.calls).toBe(1)
  })

  it('re-extracts when the package version changes', async () => {
    const inner1 = new FakeSource([manifest('VueFlow')])
    await make(inner1, '1.0.0').listComponents()
    expect(inner1.calls).toBe(1)

    const inner2 = new FakeSource([manifest('VueFlow')])
    await make(inner2, '1.1.0').listComponents()
    expect(inner2.calls).toBe(1) // different version → miss → re-extract

    // Both version artifacts coexist on disk.
    expect(readdirSync(cacheDir).length).toBe(2)
  })

  it('re-extracts when the context fingerprint changes', async () => {
    const inner1 = new FakeSource([manifest('VueFlow')])
    await new CachedManifestSource({
      inner: inner1,
      cacheDir,
      key: '@vue-flow/core',
      version: '1.0.0',
      context: 'tsconfigA',
    }).listComponents()
    expect(inner1.calls).toBe(1)

    // Same package@version, different tsconfig fingerprint → miss.
    const inner2 = new FakeSource([manifest('VueFlow')])
    await new CachedManifestSource({
      inner: inner2,
      cacheDir,
      key: '@vue-flow/core',
      version: '1.0.0',
      context: 'tsconfigB',
    }).listComponents()
    expect(inner2.calls).toBe(1)
    expect(readdirSync(cacheDir).length).toBe(2) // distinct artifacts
  })

  it('treats an extractor-version mismatch as a miss', async () => {
    const inner = new FakeSource([manifest('VueFlow')])
    const s = make(inner)
    await s.listComponents()
    const file = readdirSync(cacheDir)[0]
    // Rewrite the artifact with a stale extractorVersion.
    const stale = {
      schema: 1,
      extractorVersion: EXTRACTOR_VERSION + 1,
      sourceId: inner.id,
      packageVersion: '1.0.0',
      context: '',
      manifests: [manifest('Stale')],
    }
    writeFileSync(path.join(cacheDir, file), JSON.stringify(stale))

    const inner2 = new FakeSource([manifest('VueFlow')])
    const names = (await make(inner2).listComponents()).map((m) => m.name)
    expect(names).toEqual(['VueFlow']) // ignored stale, re-extracted
    expect(inner2.calls).toBe(1)
  })

  it('tolerates a corrupt cache file by re-extracting', async () => {
    const inner = new FakeSource([manifest('VueFlow')])
    const s = make(inner)
    await s.listComponents()
    writeFileSync(path.join(cacheDir, readdirSync(cacheDir)[0]), 'not json{')

    const inner2 = new FakeSource([manifest('VueFlow')])
    expect((await make(inner2).listComponents()).map((m) => m.name)).toEqual([
      'VueFlow',
    ])
    expect(inner2.calls).toBe(1)
  })

  it('does not persist an empty extraction (lets the next boot retry)', async () => {
    const inner = new FakeSource([])
    await make(inner).listComponents()
    expect(readdirSync(cacheDir)).toEqual([]) // nothing written
  })

  it('is transparent: id / framework / designSystem mirror the inner', () => {
    const inner = new FakeSource([])
    const s = make(inner)
    expect(s.id).toBe(inner.id)
    expect(s.framework).toBe('vue3')
    expect(s.designSystem).toBe('vue-flow')
  })

  it('getComponent resolves by name from the cache', async () => {
    const inner = new FakeSource([manifest('VueFlow'), manifest('Pane')])
    const s = make(inner)
    expect((await s.getComponent('Pane'))?.name).toBe('Pane')
    expect(await s.getComponent('Nope')).toBeNull()
  })

  it('invalidate() clears memo and forwards to the inner', async () => {
    const inner = new FakeSource([manifest('VueFlow')])
    const s = make(inner)
    await s.listComponents()
    s.invalidate()
    expect(inner.invalidated).toBe(1)
    // After invalidate the in-memory map is dropped, but the disk artifact
    // still exists, so a re-read hits disk (inner not called again).
    await s.listComponents()
    expect(inner.calls).toBe(1)
  })

  it('writes a single artifact and reuses it (no duplicate files)', async () => {
    const inner = new FakeSource([manifest('VueFlow')])
    await make(inner).listComponents()
    await make(new FakeSource([])).listComponents()
    expect(readdirSync(cacheDir).length).toBe(1)
    expect(existsSync(cacheDir)).toBe(true)
  })
})

describe('onCacheEvent', () => {
  it('reports miss then hit across two instances sharing a cache file', async () => {
    const events: string[] = []
    const opts = {
      inner: new FakeSource([manifest('UiButton')]),
      cacheDir,
      key: 'pkg',
      version: '1.0.0',
      onCacheEvent: (e: 'hit' | 'miss') => events.push(e),
    }
    await new CachedManifestSource(opts).listComponents()
    await new CachedManifestSource(opts).listComponents()
    expect(events).toEqual(['miss', 'hit'])
  })
})

describe('patchCachedComponent / readCachedComponent', () => {
  function writeRawCache(file: string, overrides: Partial<CacheFileShape> = {}): void {
    const payload: CacheFileShape = {
      schema: 1,
      extractorVersion: EXTRACTOR_VERSION,
      sourceId: 'acme-ds-vue-dts',
      packageVersion: '9.0.0',
      context: '',
      manifests: [manifest('UiButton'), manifest('UiInput')],
      ...overrides,
    }
    writeFileSync(file, JSON.stringify(payload))
  }

  interface CacheFileShape {
    schema: 1
    extractorVersion: number
    sourceId: string
    packageVersion: string
    context: string
    manifests: ComponentManifest[]
  }

  it('readCachedComponent finds a component by name, null when absent', () => {
    const file = path.join(cacheDir, 'pkg@1.0.0@v1.json')
    writeRawCache(file)
    expect(readCachedComponent(file, 'UiButton')?.name).toBe('UiButton')
    expect(readCachedComponent(file, 'Nope')).toBeNull()
  })

  it('readCachedComponent returns null for a missing or corrupt file', () => {
    expect(readCachedComponent(path.join(cacheDir, 'missing.json'), 'UiButton')).toBeNull()
    const corrupt = path.join(cacheDir, 'corrupt.json')
    writeFileSync(corrupt, 'not json{')
    expect(readCachedComponent(corrupt, 'UiButton')).toBeNull()
  })

  it('replaces one component in place, preserving every sibling entry and file-level field', () => {
    const file = path.join(cacheDir, 'pkg@1.0.0@v1.json')
    writeRawCache(file)
    const patched = { ...manifest('UiButton'), props: [{ name: 'variant' } as never] }

    const ok = patchCachedComponent(file, patched)

    expect(ok).toBe(true)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as CacheFileShape
    expect(raw.schema).toBe(1)
    expect(raw.extractorVersion).toBe(EXTRACTOR_VERSION)
    expect(raw.sourceId).toBe('acme-ds-vue-dts')
    expect(raw.packageVersion).toBe('9.0.0')
    expect(raw.manifests.map((m) => m.name).sort()).toEqual(['UiButton', 'UiInput'])
    const kbutton = raw.manifests.find((m) => m.name === 'UiButton')
    expect(kbutton?.props).toEqual([{ name: 'variant' }])
    // Sibling untouched.
    expect(raw.manifests.find((m) => m.name === 'UiInput')).toEqual(manifest('UiInput'))
  })

  it('appends a component that was not previously cached', () => {
    const file = path.join(cacheDir, 'pkg@1.0.0@v1.json')
    writeRawCache(file)
    const ok = patchCachedComponent(file, manifest('UiNewThing'))
    expect(ok).toBe(true)
    const names = (JSON.parse(readFileSync(file, 'utf8')) as CacheFileShape).manifests.map((m) => m.name)
    expect(names.sort()).toEqual(['UiButton', 'UiInput', 'UiNewThing'])
  })

  it('writes atomically via tmp+rename (no leftover tmp file)', () => {
    const file = path.join(cacheDir, 'pkg@1.0.0@v1.json')
    writeRawCache(file)
    patchCachedComponent(file, manifest('UiButton'))
    const leftover = readdirSync(cacheDir).filter((f) => f.includes('.tmp'))
    expect(leftover).toEqual([])
  })

  it('returns false (never throws) for a missing cache file', () => {
    const missing = path.join(cacheDir, 'does-not-exist.json')
    expect(patchCachedComponent(missing, manifest('UiButton'))).toBe(false)
    expect(existsSync(missing)).toBe(false)
  })

  it('returns false (never throws) for a corrupt cache file, without writing', () => {
    const file = path.join(cacheDir, 'corrupt.json')
    writeFileSync(file, 'not json{')
    expect(patchCachedComponent(file, manifest('UiButton'))).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('not json{') // untouched
  })

  it('returns false for a schema/extractorVersion mismatch', () => {
    const file = path.join(cacheDir, 'stale.json')
    writeRawCache(file, { extractorVersion: EXTRACTOR_VERSION + 1 })
    expect(patchCachedComponent(file, manifest('UiButton'))).toBe(false)
  })
})

describe('resolvePackageVersion / CACHE_DIR_NAME / fingerprintFile', () => {
  it('exports CACHE_DIR_NAME', () => {
    expect(CACHE_DIR_NAME).toBe('.desde/manifests')
  })
  it('resolves a package version from package.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cached-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '2.3.4' }))
    expect(resolvePackageVersion(root)).toBe('2.3.4')
    expect(resolvePackageVersion(path.join(root, 'missing'))).toBeNull()
  })
  it('fingerprints file bytes and returns empty string on failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cached-'))
    const f = path.join(root, 'tsconfig.json')
    await fs.writeFile(f, '{"a":1}')
    const fp1 = fingerprintFile(f)
    expect(fp1).toMatch(/^[0-9a-f]{40}$/)
    await fs.writeFile(f, '{"a":2}')
    expect(fingerprintFile(f)).not.toBe(fp1)
    expect(fingerprintFile(path.join(root, 'nope.json'))).toBe('')
  })
})
