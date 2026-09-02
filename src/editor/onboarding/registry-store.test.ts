import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalRegistryStore, REGISTRY_FILE_PATH } from './registry-store'
import type { RegisteredDesignSystem } from './types'

function entry(overrides: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: 'acme-ds',
    source: { kind: 'installed', package: '@acme/design-system' },
    package: '@acme/design-system',
    version: '9.0.0',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    dtsRoots: ['dist/types/components'],
    addedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pt-registry-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('LocalRegistryStore', () => {
  it('lists empty when no file exists', async () => {
    const store = new LocalRegistryStore(root)
    expect(await store.list()).toEqual([])
  })

  it('add → list round-trips the entry and creates the .desde file', async () => {
    const store = new LocalRegistryStore(root)
    const e = entry()
    await store.add(e)
    expect(await store.list()).toEqual([e])
    // Persisted under the prototype root at the documented path.
    const raw = await readFile(join(root, REGISTRY_FILE_PATH), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(parsed.designSystems).toHaveLength(1)
  })

  it('add replaces an entry with the same id (idempotent re-add / refresh)', async () => {
    const store = new LocalRegistryStore(root)
    await store.add(entry({ version: '9.0.0' }))
    await store.add(entry({ version: '9.1.0' }))
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].version).toBe('9.1.0')
  })

  it('keeps distinct ids side by side', async () => {
    const store = new LocalRegistryStore(root)
    await store.add(entry({ id: 'acme-ds' }))
    await store.add(entry({ id: 'radix', package: '@radix-ui/react-switch', framework: 'react', designSystem: 'radix', importPath: '@radix-ui/react-switch' }))
    const ids = (await store.list()).map((e) => e.id).sort()
    expect(ids).toEqual(['acme-ds', 'radix'])
  })

  it('remove drops by id', async () => {
    const store = new LocalRegistryStore(root)
    await store.add(entry({ id: 'a' }))
    await store.add(entry({ id: 'b' }))
    await store.remove('a')
    expect((await store.list()).map((e) => e.id)).toEqual(['b'])
  })

  it('fails soft to empty on a malformed file (never breaks manifest serving)', async () => {
    await mkdir(join(root, '.desde'), { recursive: true })
    await writeFile(join(root, REGISTRY_FILE_PATH), '{ not valid json', 'utf8')
    const store = new LocalRegistryStore(root)
    expect(await store.list()).toEqual([])
  })

  it('filters out half-formed entries (hand-edited / partial write)', async () => {
    await mkdir(join(root, '.desde'), { recursive: true })
    await writeFile(
      join(root, REGISTRY_FILE_PATH),
      JSON.stringify({
        version: 1,
        designSystems: [
          entry({ id: 'good' }),
          { id: 'bad', package: '@x/y' }, // missing required fields
        ],
      }),
      'utf8',
    )
    const store = new LocalRegistryStore(root)
    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual(['good'])
  })

  it('rejects an entry whose dtsRoots is not a string[] (would crash .map downstream)', async () => {
    await mkdir(join(root, '.desde'), { recursive: true })
    await writeFile(
      join(root, REGISTRY_FILE_PATH),
      JSON.stringify({
        version: 1,
        designSystems: [
          entry({ id: 'good' }),
          entry({ id: 'bad-string', dtsRoots: 'dist/types' as unknown as string[] }),
          entry({ id: 'bad-mixed', dtsRoots: ['ok', 5] as unknown as string[] }),
        ],
      }),
      'utf8',
    )
    const store = new LocalRegistryStore(root)
    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual(['good'])
  })
})
