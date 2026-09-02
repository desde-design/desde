import { describe, expect, it } from 'vitest'
import type { IconManifest, IconSetSource } from '../core'
import { InMemoryIconSetRegistry } from './registry'

function fakeSource(opts: {
  id: string
  packageName: string
  icons: Array<{
    id: string
    displayName?: string
    category?: string
    tags?: string[]
  }>
}): IconSetSource {
  const icons: IconManifest[] = opts.icons.map((i) => ({
    id: i.id,
    displayName: i.displayName ?? i.id,
    category: i.category,
    tags: i.tags ?? [],
    ref: { kind: 'named-component-import', exportName: i.id, importPath: opts.packageName },
    preview: { kind: 'svg', markup: '<svg/>' },
  }))
  return {
    id: opts.id,
    displayName: opts.id,
    framework: 'vue3',
    usagePattern: { kind: 'named-component-import', packageName: opts.packageName },
    listIcons: async () => icons,
    getIcon: async (id) => icons.find((i) => i.id === id) ?? null,
  }
}

describe('InMemoryIconSetRegistry', () => {
  it('registers and lists sources in insertion order', () => {
    const reg = new InMemoryIconSetRegistry()
    reg.register(fakeSource({ id: 'a', packageName: '@a/icons', icons: [] }))
    reg.register(fakeSource({ id: 'b', packageName: '@b/icons', icons: [] }))

    const list = reg.list()
    expect(list.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('throws when re-registering the same id', () => {
    const reg = new InMemoryIconSetRegistry()
    reg.register(fakeSource({ id: 'a', packageName: '@a/icons', icons: [] }))
    expect(() =>
      reg.register(fakeSource({ id: 'a', packageName: '@a2/icons', icons: [] })),
    ).toThrow(/already has a source/)
  })

  it('looks up by id', () => {
    const reg = new InMemoryIconSetRegistry()
    const src = fakeSource({ id: 'a', packageName: '@a/icons', icons: [] })
    reg.register(src)
    expect(reg.get('a')).toBe(src)
    expect(reg.get('missing')).toBeNull()
  })

  it('findOwnerOfPackage matches named-component-import package', () => {
    const reg = new InMemoryIconSetRegistry()
    const acme = fakeSource({ id: 'acme-icons', packageName: '@acme/icons', icons: [] })
    const lucide = fakeSource({ id: 'lucide', packageName: 'lucide-vue-next', icons: [] })
    reg.register(acme)
    reg.register(lucide)

    expect(reg.findOwnerOfPackage('@acme/icons')).toBe(acme)
    expect(reg.findOwnerOfPackage('lucide-vue-next')).toBe(lucide)
    expect(reg.findOwnerOfPackage('react-icons')).toBeNull()
  })

  it('searchIcons matches across id, displayName, category, tags', async () => {
    const reg = new InMemoryIconSetRegistry()
    reg.register(
      fakeSource({
        id: 'acme-icons',
        packageName: '@acme/icons',
        icons: [
          { id: 'DataObjectIcon', displayName: 'Data object', category: 'solid' },
          { id: 'TrashIcon', displayName: 'Trash', category: 'solid', tags: ['delete', 'remove'] },
          { id: 'KeyIcon', displayName: 'Key', category: 'solid' },
        ],
      }),
    )

    expect((await reg.searchIcons('data')).map((h) => h.icon.id)).toEqual(['DataObjectIcon'])
    expect((await reg.searchIcons('delete')).map((h) => h.icon.id)).toEqual(['TrashIcon'])
    expect((await reg.searchIcons('SOLID')).map((h) => h.icon.id).sort()).toEqual([
      'DataObjectIcon',
      'KeyIcon',
      'TrashIcon',
    ])
  })

  it('searchIcons returns empty for empty/whitespace queries', async () => {
    const reg = new InMemoryIconSetRegistry()
    reg.register(
      fakeSource({
        id: 'a',
        packageName: '@a/icons',
        icons: [{ id: 'X' }],
      }),
    )

    expect(await reg.searchIcons('')).toEqual([])
    expect(await reg.searchIcons('   ')).toEqual([])
  })

  it('searchIcons reports the originating sourceId on each hit', async () => {
    const reg = new InMemoryIconSetRegistry()
    reg.register(
      fakeSource({ id: 'first', packageName: '@a/icons', icons: [{ id: 'AlphaIcon' }] }),
    )
    reg.register(
      fakeSource({ id: 'second', packageName: '@b/icons', icons: [{ id: 'AlphaIcon' }] }),
    )

    const hits = await reg.searchIcons('alpha')
    expect(hits.map((h) => h.sourceId).sort()).toEqual(['first', 'second'])
  })
})
