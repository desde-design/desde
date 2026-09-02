import { describe, expect, it } from 'vitest'
import type { ComponentManifest, ComponentManifestSource } from '@/editor/core/manifest'
import { computeCoverage } from './coverage'

function manifest(name: string, propNames: string[]): ComponentManifest {
  return {
    name,
    props: propNames.map((p) => ({ name: p })),
  } as unknown as ComponentManifest
}

function source(manifests: ComponentManifest[]): ComponentManifestSource {
  return {
    id: 'fake',
    framework: 'vue3',
    designSystem: 'fake',
    listComponents: async () => manifests,
    getComponent: async (n) => manifests.find((m) => m.name === n) ?? null,
  }
}

describe('computeCoverage', () => {
  it('tallies extracted (has props) vs empty (no props)', async () => {
    const r = await computeCoverage(
      source([manifest('KButton', ['label', 'size']), manifest('KIcon', []), manifest('KCard', ['title'])]),
    )
    expect(r.extracted).toBe(2)
    expect(r.empty).toBe(1)
    expect(r.discovered).toBe(3) // no discoveredNames → discovered = listed
    expect(r.failedComponents).toEqual([])
    expect(r.sampleProps.KButton).toEqual(['label', 'size'])
  })

  it('reports failedComponents from discoveredNames not present in the listing', async () => {
    const r = await computeCoverage(source([manifest('KButton', ['label'])]), {
      discoveredNames: ['KButton', 'KBroken', 'KAlsoBroken'],
    })
    expect(r.discovered).toBe(3)
    expect(r.extracted).toBe(1)
    expect(r.failedComponents.sort()).toEqual(['KAlsoBroken', 'KBroken'])
  })

  it('caps sampleProps by component + prop limits', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      manifest(`C${i}`, Array.from({ length: 12 }, (_, j) => `p${j}`)),
    )
    const r = await computeCoverage(source(many), { sampleLimit: 2, propSampleLimit: 3 })
    expect(Object.keys(r.sampleProps)).toHaveLength(2)
    expect(r.sampleProps.C0).toHaveLength(3)
  })

  it('handles an all-empty source', async () => {
    const r = await computeCoverage(source([manifest('A', []), manifest('B', [])]))
    expect(r).toMatchObject({ discovered: 2, extracted: 0, empty: 2 })
    expect(r.sampleProps).toEqual({})
  })
})
