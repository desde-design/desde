import { describe, expect, it } from 'vitest'
import type { IconManifest, IconSetSource } from '../core'
import { findIconByTag, findIconInRegistry, type SerializedIconSetShape } from './find-icon'

function icon(opts: { id: string; packageName: string }): IconManifest {
  return {
    id: opts.id,
    displayName: opts.id,
    tags: [],
    ref: { kind: 'named-component-import', exportName: opts.id, importPath: opts.packageName },
    preview: { kind: 'svg', markup: '<svg/>' },
  }
}

function setShape(opts: { id: string; packageName: string; icons: string[] }): SerializedIconSetShape {
  return {
    id: opts.id,
    usagePattern: { kind: 'named-component-import', packageName: opts.packageName },
    icons: opts.icons.map((name) => icon({ id: name, packageName: opts.packageName })),
  }
}

function fakeSource(shape: SerializedIconSetShape): IconSetSource {
  return {
    id: shape.id,
    displayName: shape.id,
    framework: 'vue3',
    usagePattern: shape.usagePattern,
    listIcons: async () => [...shape.icons],
    getIcon: async (id) => shape.icons.find((i) => i.id === id) ?? null,
  }
}

describe('findIconByTag', () => {
  const acme = setShape({
    id: 'acme-icons',
    packageName: '@acme/icons',
    icons: ['DataObjectIcon', 'AddIcon', 'TrashIcon'],
  })
  const lucide = setShape({
    id: 'lucide-vue-next',
    packageName: 'lucide-vue-next',
    icons: ['DataObjectIcon', 'KeyIcon'],
  })

  it('returns null for empty tag', () => {
    expect(findIconByTag({ tag: '', sets: [acme] })).toBeNull()
  })

  it('returns null when no set claims the tag', () => {
    expect(findIconByTag({ tag: 'NotARealIcon', sets: [acme, lucide] })).toBeNull()
  })

  it('returns the matching icon with sourceId', () => {
    const hit = findIconByTag({ tag: 'AddIcon', sets: [acme] })
    expect(hit).toEqual({
      sourceId: 'acme-icons',
      icon: expect.objectContaining({ id: 'AddIcon' }),
    })
  })

  it('returns the first match in registration order for cross-set collisions', () => {
    // the package listed first; DataObjectIcon exists in both → acme wins.
    expect(findIconByTag({ tag: 'DataObjectIcon', sets: [acme, lucide] })?.sourceId).toBe(
      'acme-icons',
    )
    // Reverse order → lucide wins.
    expect(findIconByTag({ tag: 'DataObjectIcon', sets: [lucide, acme] })?.sourceId).toBe(
      'lucide-vue-next',
    )
  })

  it('skips sets that do not use named-component-import', () => {
    const cssClass: SerializedIconSetShape = {
      id: 'bootstrap-icons',
      usagePattern: { kind: 'css-class', tagName: 'i', classPrefix: 'bi-' },
      icons: [
        {
          id: 'trash',
          displayName: 'Trash',
          tags: [],
          ref: { kind: 'css-class', className: 'bi-trash' },
          preview: { kind: 'svg', markup: '<svg/>' },
        },
      ],
    }
    expect(findIconByTag({ tag: 'trash', sets: [cssClass] })).toBeNull()
  })
})

describe('findIconInRegistry', () => {
  it('returns null when no source claims the tag', async () => {
    const sources = [
      fakeSource(
        setShape({ id: 'acme-icons', packageName: '@acme/icons', icons: ['AddIcon'] }),
      ),
    ]
    expect(await findIconInRegistry('NotAnIcon', sources)).toBeNull()
  })

  it('returns the matching icon from the first source that has it', async () => {
    const sources = [
      fakeSource(
        setShape({ id: 'acme-icons', packageName: '@acme/icons', icons: ['DataObjectIcon'] }),
      ),
      fakeSource(
        setShape({
          id: 'lucide-vue-next',
          packageName: 'lucide-vue-next',
          icons: ['DataObjectIcon'],
        }),
      ),
    ]
    const hit = await findIconInRegistry('DataObjectIcon', sources)
    expect(hit?.sourceId).toBe('acme-icons')
  })
})
