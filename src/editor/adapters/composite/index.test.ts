/**
 * Tests for `CompositeManifestSource`. Uses tiny in-memory stub sources
 * so we test orchestration semantics without dragging the real Storybook
 * or Vue-source parsers into the unit-test path.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  ComponentManifest,
  ComponentManifestSource,
} from '../../core'
import { CompositeManifestSource } from './index'

function stubManifest(
  name: string,
  patch: Partial<ComponentManifest> = {},
): ComponentManifest {
  return {
    id: `stub.${name.toLowerCase()}`,
    name,
    framework: 'vue3',
    designSystem: 'stub',
    props: [],
    slots: [],
    events: [],
    ...patch,
  }
}

class StubSource implements ComponentManifestSource {
  readonly framework = 'vue3' as const
  readonly designSystem: string

  constructor(
    public readonly id: string,
    private readonly manifests: ComponentManifest[],
  ) {
    this.designSystem = 'stub'
  }

  async listComponents(): Promise<ComponentManifest[]> {
    return [...this.manifests]
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    return this.manifests.find((m) => m.name === name) ?? null
  }
}

class ThrowingSource implements ComponentManifestSource {
  readonly id = 'throwing'
  readonly framework = 'vue3' as const
  readonly designSystem = 'stub'

  async listComponents(): Promise<ComponentManifest[]> {
    throw new Error('list-boom')
  }

  async getComponent(_: string): Promise<ComponentManifest | null> {
    throw new Error('get-boom')
  }
}

describe('CompositeManifestSource', () => {
  it('resolves a component from the first source that has it', async () => {
    const a = new StubSource('a', [stubManifest('Button', { id: 'a.button' })])
    const b = new StubSource('b', [stubManifest('Card', { id: 'b.card' })])
    const composite = new CompositeManifestSource({ sources: [a, b] })
    const button = await composite.getComponent('Button')
    expect(button?.id).toBe('a.button')
    const card = await composite.getComponent('Card')
    expect(card?.id).toBe('b.card')
  })

  describe('rendering-hint composition', () => {
    const hint = {
      kind: 'dom' as const,
      source: { kind: 'prop' as const, name: 'label' },
      domTarget: { selector: ':root', field: 'textContent' as const },
    }

    it('overlays rendering hints from a later source onto the props winner', async () => {
      // The props winner (full-fidelity, e.g. vue-dts-meta) has no hints;
      // a lower-priority source (e.g. bundled Acme DS) carries them.
      const propsWinner = new StubSource('props', [
        stubManifest('UiLabel', { id: 'props.klabel', props: [{ name: 'label' } as never] }),
      ])
      const hintSource = new StubSource('hints', [
        stubManifest('UiLabel', { id: 'hints.klabel', rendering: [hint] }),
      ])
      const composite = new CompositeManifestSource({ sources: [propsWinner, hintSource] })
      const m = await composite.getComponent('UiLabel')
      expect(m?.id).toBe('props.klabel') // props provenance stays with the winner
      expect(m?.props).toHaveLength(1)
      expect(m?.rendering).toEqual([hint]) // hints recovered from the later source
    })

    it('does not overlay when the props winner already has hints', async () => {
      const winnerHint = { ...hint, source: { kind: 'prop' as const, name: 'winner' } }
      const a = new StubSource('a', [stubManifest('UiLabel', { id: 'a', rendering: [winnerHint] })])
      const b = new StubSource('b', [stubManifest('UiLabel', { id: 'b', rendering: [hint] })])
      const composite = new CompositeManifestSource({ sources: [a, b] })
      const m = await composite.getComponent('UiLabel')
      expect(m?.id).toBe('a')
      expect(m?.rendering).toEqual([winnerHint]) // first source's hints win
    })

    it('returns the winner unchanged when no source has hints', async () => {
      const a = new StubSource('a', [stubManifest('UiLabel', { id: 'a' })])
      const b = new StubSource('b', [stubManifest('UiLabel', { id: 'b' })])
      const composite = new CompositeManifestSource({ sources: [a, b] })
      const m = await composite.getComponent('UiLabel')
      expect(m?.id).toBe('a')
      expect(m?.rendering).toBeUndefined()
    })

    it('consults later sources when the props winner has no hints (behavior change)', async () => {
      const aGet = vi.fn(async () => stubManifest('UiLabel', { id: 'a' })) // no hints
      const bGet = vi.fn(async () =>
        stubManifest('UiLabel', {
          id: 'b',
          rendering: [{ kind: 'dom', source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }],
        }),
      )
      const sources: ComponentManifestSource[] = [
        { id: 'a', framework: 'vue3', designSystem: 'a', getComponent: aGet, listComponents: async () => [] },
        { id: 'b', framework: 'vue3', designSystem: 'b', getComponent: bGet, listComponents: async () => [] },
      ]
      const composite = new CompositeManifestSource({ sources })
      const m = await composite.getComponent('UiLabel')
      expect(aGet).toHaveBeenCalledOnce()
      expect(bGet).toHaveBeenCalledOnce() // consulted for hint recovery
      expect(m?.id).toBe('a')
      expect(m?.rendering).toHaveLength(1)
    })

    it('I2: never grafts rendering hints from a DIFFERENT package onto the props winner (cross-package name collision)', async () => {
      // Two unrelated packages both happen to export a "Button" — the props
      // winner is package A's (a different designSystem/importPath than
      // package B's hint source). Grafting B's hints onto A's props winner
      // would silently pair the wrong prop schema with the wrong DOM sites.
      const propsWinner = new StubSource('lib-a-props', [
        stubManifest('Button', {
          id: 'lib-a.button',
          designSystem: 'lib-a',
          importPath: '@lib-a/ui',
          props: [{ name: 'label' } as never],
        }),
      ])
      const hintSourceFromOtherPackage = new StubSource('lib-b-hints', [
        stubManifest('Button', {
          id: 'lib-b.button',
          designSystem: 'lib-b',
          importPath: '@lib-b/ui',
          rendering: [hint],
        }),
      ])
      const composite = new CompositeManifestSource({
        sources: [propsWinner, hintSourceFromOtherPackage],
      })
      const m = await composite.getComponent('Button')
      expect(m?.id).toBe('lib-a.button') // props provenance stays with the winner
      expect(m?.rendering).toBeUndefined() // NOT grafted — no identity match
    })

    it('I2: overlays when designSystem AND importPath both match (real UiInput scenario)', async () => {
      // Mirrors the real UiInput scenario: the vue-dts-meta auto-scan props
      // winner and the hand-authored acme-ds-static hint source both
      // stamp `designSystem: 'acme-ds'` AND the identical `importPath`
      // ('@acme/design-system' — the auto-scan uses the raw scanned package
      // name, `Acme DSManifestSource` uses a matching literal constant).
      // Equal, non-empty importPath is itself a positive identity match —
      // this doesn't even need the designSystem fallback.
      const propsWinner = new StubSource('vue-dts-meta', [
        stubManifest('UiInput', {
          id: 'dts.kinput',
          designSystem: 'acme-ds',
          importPath: '@acme/design-system',
          props: [{ name: 'placeholder' } as never],
        }),
      ])
      const handAuthoredHints = new StubSource('acme-ds-static', [
        stubManifest('UiInput', {
          id: 'static.kinput',
          designSystem: 'acme-ds',
          importPath: '@acme/design-system',
          rendering: [hint],
        }),
      ])
      const composite = new CompositeManifestSource({
        sources: [propsWinner, handAuthoredHints],
      })
      const m = await composite.getComponent('UiInput')
      expect(m?.id).toBe('dts.kinput')
      expect(m?.rendering).toEqual([hint])
    })

    it('I2: does NOT overlay when designSystem matches but both sides declare DIFFERENT non-empty importPaths (per-package collision guard)', async () => {
      // Regression for a real hazard with per-package `HintsCacheManifestSource`
      // instances: two DIFFERENT npm packages can be re-stamped under the
      // same `designSystem` id (e.g. via `PACKAGE_OVERRIDES` grouping
      // `@acme/ui-public/*` sub-packages, or two forks/internal libraries
      // both labeled 'acme-ds'). If both manifests name a concrete,
      // differing importPath, that's a positive signal they are NOT the
      // same component — matching designSystem must not override it, or
      // the earlier package's hints graft onto the later package's props
      // winner and attribution emits selectors for the wrong package.
      const propsWinner = new StubSource('pkg-a-props', [
        stubManifest('UiInput', {
          id: 'pkg-a.kinput',
          designSystem: 'acme-ds',
          importPath: '@acme-fork-a/design-system',
          props: [{ name: 'placeholder' } as never],
        }),
      ])
      const hintSourceFromOtherPackage = new StubSource('pkg-b-hints', [
        stubManifest('UiInput', {
          id: 'pkg-b.kinput',
          designSystem: 'acme-ds',
          importPath: '@acme-fork-b/design-system',
          rendering: [hint],
        }),
      ])
      const composite = new CompositeManifestSource({
        sources: [propsWinner, hintSourceFromOtherPackage],
      })
      const m = await composite.getComponent('UiInput')
      expect(m?.id).toBe('pkg-a.kinput') // props provenance stays with the winner
      expect(m?.rendering).toBeUndefined() // NOT grafted — conflicting importPath wins over matching designSystem
    })

    it('I2: falls back to designSystem match when one side has no importPath at all', async () => {
      // The importPath comparison is only authoritative when BOTH sides
      // declare one. When one side omits it (common for first-party /
      // legacy sources), the designSystem fallback still applies.
      const propsWinner = new StubSource('vue-dts-meta', [
        stubManifest('UiInput', {
          id: 'dts.kinput',
          designSystem: 'acme-ds',
          // no importPath
          props: [{ name: 'placeholder' } as never],
        }),
      ])
      const handAuthoredHints = new StubSource('acme-ds-static', [
        stubManifest('UiInput', {
          id: 'static.kinput',
          designSystem: 'acme-ds',
          importPath: '@acme/design-system',
          rendering: [hint],
        }),
      ])
      const composite = new CompositeManifestSource({
        sources: [propsWinner, handAuthoredHints],
      })
      const m = await composite.getComponent('UiInput')
      expect(m?.id).toBe('dts.kinput')
      expect(m?.rendering).toEqual([hint])
    })

    it('I2: still overlays when neither side sets designSystem/importPath but both are the SAME default stub value (no false negative)', async () => {
      // Guards against over-tightening: when both sides genuinely share an
      // identity signal (even a shared default), the overlay must still work.
      const propsWinner = new StubSource('props', [
        stubManifest('UiLabel', { id: 'props.klabel', props: [{ name: 'label' } as never] }),
      ])
      const hintSource = new StubSource('hints', [
        stubManifest('UiLabel', { id: 'hints.klabel', rendering: [hint] }),
      ])
      const composite = new CompositeManifestSource({ sources: [propsWinner, hintSource] })
      const m = await composite.getComponent('UiLabel')
      expect(m?.rendering).toEqual([hint])
    })
  })

  it('first source wins on duplicate component names (getComponent)', async () => {
    const a = new StubSource('a', [stubManifest('Button', { id: 'a.button' })])
    const b = new StubSource('b', [stubManifest('Button', { id: 'b.button' })])
    const composite = new CompositeManifestSource({ sources: [a, b] })
    const button = await composite.getComponent('Button')
    expect(button?.id).toBe('a.button')
  })

  describe('getComponentCandidates', () => {
    it('returns every source\'s match, in source-priority order — not just getComponent\'s winner', async () => {
      const a = new StubSource('a', [stubManifest('Button', { id: 'a.button' })])
      const b = new StubSource('b', [stubManifest('Button', { id: 'b.button' })])
      const composite = new CompositeManifestSource({ sources: [a, b] })
      const candidates = await composite.getComponentCandidates('Button')
      expect(candidates.map((c) => c.id)).toEqual(['a.button', 'b.button'])
    })

    it('returns an empty array when no source has the component', async () => {
      const a = new StubSource('a', [stubManifest('Button')])
      const composite = new CompositeManifestSource({ sources: [a] })
      expect(await composite.getComponentCandidates('DoesNotExist')).toEqual([])
    })

    it('skips a throwing source and still returns the others', async () => {
      const onSourceError = vi.fn()
      const a = new ThrowingSource()
      const b = new StubSource('b', [stubManifest('Button', { id: 'b.button' })])
      const composite = new CompositeManifestSource({ sources: [a, b], onSourceError })
      const candidates = await composite.getComponentCandidates('Button')
      expect(candidates.map((c) => c.id)).toEqual(['b.button'])
      expect(onSourceError).toHaveBeenCalledWith('throwing', 'getComponent', expect.any(Error))
    })
  })

  it('returns null when no source has the component', async () => {
    const a = new StubSource('a', [stubManifest('Button')])
    const composite = new CompositeManifestSource({ sources: [a] })
    expect(await composite.getComponent('DoesNotExist')).toBeNull()
  })

  it('listComponents merges across sources, first-source-wins on duplicates', async () => {
    const a = new StubSource('a', [
      stubManifest('Button', { id: 'a.button' }),
      stubManifest('Card', { id: 'a.card' }),
    ])
    const b = new StubSource('b', [
      stubManifest('Card', { id: 'b.card' }), // shadowed
      stubManifest('Modal', { id: 'b.modal' }),
    ])
    const composite = new CompositeManifestSource({ sources: [a, b] })
    const list = await composite.listComponents()
    expect(list.map((m) => `${m.name}:${m.id}`).sort()).toEqual([
      'Button:a.button',
      'Card:a.card', // a wins
      'Modal:b.modal',
    ])
  })

  it('skips a throwing source on getComponent and tries the next', async () => {
    const onSourceError = vi.fn()
    const a = new ThrowingSource()
    const b = new StubSource('b', [stubManifest('Button', { id: 'b.button' })])
    const composite = new CompositeManifestSource({
      sources: [a, b],
      onSourceError,
    })
    const result = await composite.getComponent('Button')
    expect(result?.id).toBe('b.button')
    expect(onSourceError).toHaveBeenCalledOnce()
    expect(onSourceError).toHaveBeenCalledWith(
      'throwing',
      'getComponent',
      expect.any(Error),
    )
  })

  it('skips a throwing source on listComponents and continues', async () => {
    const onSourceError = vi.fn()
    const a = new ThrowingSource()
    const b = new StubSource('b', [stubManifest('Button')])
    const composite = new CompositeManifestSource({
      sources: [a, b],
      onSourceError,
    })
    const list = await composite.listComponents()
    expect(list.map((m) => m.name)).toEqual(['Button'])
    expect(onSourceError).toHaveBeenCalledWith(
      'throwing',
      'listComponents',
      expect.any(Error),
    )
  })

  it('returns null after all sources have been tried unsuccessfully', async () => {
    const a = new ThrowingSource()
    const b = new StubSource('b', [stubManifest('Other')])
    const composite = new CompositeManifestSource({
      sources: [a, b],
      onSourceError: () => {},
    })
    expect(await composite.getComponent('Missing')).toBeNull()
  })

  it('short-circuits getComponent when the props winner already carries rendering hints', async () => {
    // A winner WITH hints can't be improved by later sources, so the
    // scan stops. (A hint-LESS winner keeps scanning to recover hints —
    // see the "rendering-hint composition" block.)
    const aGet = vi.fn(async () =>
      stubManifest('Button', {
        id: 'a.button',
        rendering: [
          { kind: 'dom', source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } },
        ],
      }),
    )
    const bGet = vi.fn(async () => stubManifest('Button', { id: 'b.button' }))
    const sources: ComponentManifestSource[] = [
      {
        id: 'a',
        framework: 'vue3',
        designSystem: 'a',
        getComponent: aGet,
        listComponents: async () => [],
      },
      {
        id: 'b',
        framework: 'vue3',
        designSystem: 'b',
        getComponent: bGet,
        listComponents: async () => [],
      },
    ]
    const composite = new CompositeManifestSource({ sources })
    await composite.getComponent('Button')
    expect(aGet).toHaveBeenCalledOnce()
    expect(bGet).not.toHaveBeenCalled()
  })

  it('inherits framework from the first source by default', async () => {
    const a = new StubSource('a', [])
    const composite = new CompositeManifestSource({ sources: [a] })
    expect(composite.framework).toBe('vue3')
    expect(composite.designSystem).toBe('composite')
  })

  it('honors explicit framework / designSystem overrides', async () => {
    const a = new StubSource('a', [])
    const composite = new CompositeManifestSource({
      sources: [a],
      framework: 'react',
      designSystem: 'acme',
    })
    expect(composite.framework).toBe('react')
    expect(composite.designSystem).toBe('acme')
  })

  it('handles an empty source list gracefully', async () => {
    const composite = new CompositeManifestSource({ sources: [] })
    expect(await composite.getComponent('X')).toBeNull()
    expect(await composite.listComponents()).toEqual([])
    // Default framework when no sources to inherit from.
    expect(composite.framework).toBe('vue3')
  })

  describe('deprioritizeCandidate', () => {
    // The measured case: an icon package exports `Link` and sorts before the
    // router package that actually provides the app's Link.
    const icons = new StubSource('icons', [
      stubManifest('Link', { id: 'icons.link', importPath: 'icon-pkg' }),
    ])
    const router = new StubSource('router', [
      stubManifest('Link', { id: 'router.link', importPath: 'router-pkg' }),
    ])

    it('steps past a demoted candidate to the next accepted one', async () => {
      const composite = new CompositeManifestSource({
        sources: [icons, router],
        deprioritizeCandidate: (m) => m.importPath === 'icon-pkg',
      })
      expect((await composite.getComponent('Link'))?.id).toBe('router.link')
    })

    it('keeps source order when every candidate is demoted (never null)', async () => {
      const composite = new CompositeManifestSource({
        sources: [icons, router],
        deprioritizeCandidate: () => true,
      })
      expect((await composite.getComponent('Link'))?.id).toBe('icons.link')
    })

    it('still overlays rendering hints onto an all-demoted fallback winner', async () => {
      const hintful = new StubSource('hints', [
        stubManifest('Link', {
          id: 'hints.link',
          importPath: 'icon-pkg',
          rendering: [
            {
              kind: 'dom',
              source: { kind: 'prop', name: 'label' },
              domTarget: { selector: ':root', field: 'textContent' },
            },
          ],
        }),
      ])
      const composite = new CompositeManifestSource({
        sources: [icons, hintful],
        deprioritizeCandidate: () => true,
      })
      const link = await composite.getComponent('Link')
      expect(link?.id).toBe('icons.link')
      expect(link?.rendering).toHaveLength(1)
    })

    it('is not consulted at all when omitted (unchanged first-source-wins)', async () => {
      const composite = new CompositeManifestSource({ sources: [icons, router] })
      expect((await composite.getComponent('Link'))?.id).toBe('icons.link')
    })

    it('does not affect listComponents', async () => {
      const composite = new CompositeManifestSource({
        sources: [icons, router],
        deprioritizeCandidate: (m) => m.importPath === 'icon-pkg',
      })
      const all = await composite.listComponents()
      expect(all.map((m) => m.id)).toEqual(['icons.link'])
    })
  })

  it('uses default console.warn logger when onSourceError omitted', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const composite = new CompositeManifestSource({
        sources: [new ThrowingSource()],
      })
      await composite.getComponent('X')
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
