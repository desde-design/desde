/**
 * End-to-end integration test for the V1.4 manifest pipeline.
 *
 * Constructs the same `CompositeManifestSource([LocalVue, Storybook,
 * <library>])` shape the CLI's manifest route assembles and verifies that
 * each source resolves the components it owns AND that priority order works
 * for cross-source name conflicts. The library slot is a small in-memory
 * source rather than a real adapter: what is under test is the composite's
 * orchestration, not any one library's extraction.
 *
 * This is the test that catches regressions where a code change to one
 * source-of-truth path silently breaks the others. Per-source unit
 * tests cover their own internals; this one covers the orchestration
 * end-to-end.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompositeManifestSource } from './index'
import { LocalVueManifestSource } from '../local-vue'
import { StorybookManifestSource } from '../storybook'
import type { ComponentManifest, ComponentManifestSource } from '../../core'

const LOCAL_VUE_FIXTURES = path.resolve(
  __dirname,
  '../local-vue/__fixtures__',
)
const STORYBOOK_FIXTURES = path.resolve(
  __dirname,
  '../storybook/__fixtures__',
)

/**
 * Stand-in for an installed design-system library source (in production
 * this slot is filled by the `library-dts-auto-scan` step). Two components,
 * one of which carries a finite-choice prop so the assertions below have
 * something real to check.
 */
function libraryManifest(name: string): ComponentManifest {
  return {
    id: `acme-ds.${name.toLowerCase()}`,
    name,
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    props: [
      {
        name: 'appearance',
        type: 'string',
        required: false,
        control: { kind: 'finite-choice', options: [
          { value: 'primary', label: 'Primary' },
          { value: 'secondary', label: 'Secondary' },
        ] },
      },
    ],
    slots: [],
    events: [],
  }
}

const LIBRARY_COMPONENTS = ['AcmeButton', 'AcmeDropdown']

function buildLibrarySource(): ComponentManifestSource {
  return {
    id: 'acme-ds',
    framework: 'vue3',
    designSystem: 'acme-ds',
    listComponents: async () => LIBRARY_COMPONENTS.map(libraryManifest),
    getComponent: async (name: string) =>
      LIBRARY_COMPONENTS.includes(name) ? libraryManifest(name) : null,
  }
}

function buildPipeline() {
  const localVue = new LocalVueManifestSource({
    componentFiles: [
      path.join(LOCAL_VUE_FIXTURES, 'ProtoCatalogCard.vue'),
      path.join(LOCAL_VUE_FIXTURES, 'SimpleProps.vue'),
    ],
  })
  const storybook = new StorybookManifestSource({
    storyFiles: [
      path.join(STORYBOOK_FIXTURES, 'Button.stories.ts'),
      path.join(STORYBOOK_FIXTURES, 'SeparateMeta.stories.ts'),
    ],
    designSystem: 'storybook',
  })
  return new CompositeManifestSource({
    sources: [localVue, storybook, buildLibrarySource()],
  })
}

describe('Composite pipeline (LocalVue + Storybook + library)', () => {
  it('resolves a first-party Vue component via LocalVueManifestSource', async () => {
    const pipeline = buildPipeline()
    const m = await pipeline.getComponent('ProtoCatalogCard')
    expect(m).not.toBeNull()
    expect(m?.designSystem).toBe('first-party')
    expect(m?.props.find((p) => p.name === 'variant')?.control.kind).toBe(
      'finite-choice',
    )
  })

  it('resolves a Storybook-only component via StorybookManifestSource', async () => {
    const pipeline = buildPipeline()
    const m = await pipeline.getComponent('Button')
    expect(m).not.toBeNull()
    expect(m?.designSystem).toBe('storybook')
    expect(
      m?.props.find((p) => p.name === 'appearance')?.control.options?.length,
    ).toBe(4)
  })

  it('resolves a library component via the library source', async () => {
    const pipeline = buildPipeline()
    const m = await pipeline.getComponent('AcmeDropdown')
    expect(m).not.toBeNull()
    expect(m?.designSystem).toBe('acme-ds')
    expect(m?.props.find((p) => p.name === 'appearance')).toBeDefined()
  })

  it('returns null for components no source has', async () => {
    const pipeline = buildPipeline()
    expect(await pipeline.getComponent('NobodyKnowsThis')).toBeNull()
  })

  it('listComponents merges across all three sources without duplicates', async () => {
    const pipeline = buildPipeline()
    const list = await pipeline.listComponents()
    const names = list.map((m) => m.name).sort()
    // First-party fixtures
    expect(names).toContain('ProtoCatalogCard')
    expect(names).toContain('SimpleProps')
    // Storybook fixtures
    expect(names).toContain('Button')
    expect(names).toContain('Card')
    // Library
    expect(names).toContain('AcmeButton')
    expect(names).toContain('AcmeDropdown')
    // No duplicates
    expect(new Set(names).size).toBe(names.length)
  })

  it('honors source priority on a cross-source name conflict', async () => {
    // Synthesize a conflict: a stub source claiming the name "AcmeButton"
    // listed BEFORE the library source. The composite must return the
    // stub's manifest, not the library's.
    const stub = {
      id: 'stub',
      framework: 'vue3' as const,
      designSystem: 'overrider',
      listComponents: async () => [
        {
          id: 'overrider.acme-button',
          name: 'AcmeButton',
          framework: 'vue3' as const,
          designSystem: 'overrider',
          props: [],
          slots: [],
          events: [],
        },
      ],
      getComponent: async (name: string) =>
        name === 'AcmeButton'
          ? {
              id: 'overrider.acme-button',
              name: 'AcmeButton',
              framework: 'vue3' as const,
              designSystem: 'overrider',
              props: [],
              slots: [],
              events: [],
            }
          : null,
    }
    const pipeline = new CompositeManifestSource({
      sources: [stub, buildLibrarySource()],
    })
    const m = await pipeline.getComponent('AcmeButton')
    expect(m?.designSystem).toBe('overrider')
  })

  it('survives one source throwing on getComponent', async () => {
    const broken = {
      id: 'broken',
      framework: 'vue3' as const,
      designSystem: 'broken',
      listComponents: async () => {
        throw new Error('list-broken')
      },
      getComponent: async () => {
        throw new Error('get-broken')
      },
    }
    const pipeline = new CompositeManifestSource({
      sources: [
        broken,
        new LocalVueManifestSource({
          componentFiles: [path.join(LOCAL_VUE_FIXTURES, 'SimpleProps.vue')],
        }),
      ],
      onSourceError: () => {},
    })
    const m = await pipeline.getComponent('SimpleProps')
    expect(m?.name).toBe('SimpleProps')
  })
})
