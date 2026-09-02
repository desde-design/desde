/**
 * Tests for `detectDrift` — the structural drift rules run right after
 * `attribute()`. Each case is a synthetic `AttributionContext` +
 * `AttributionResult` + `owningManifest`, mirroring `attribute.test.ts`'s
 * fixture style. No bridge, no DOM.
 *
 * Precision-first: the four excluded refusal shapes each get their own
 * "produces nothing" case, not just the rule that fires.
 */

import { describe, expect, it } from 'vitest'
import type { ComponentManifest } from '../core'
import { detectDrift } from './detect-drift'
import type { AttributionContext, AttributionResult } from './types'

// ──────────────── Fixtures ────────────────

const KLABEL_WITH_TRUSTED_HINTS: ComponentManifest = {
  id: 'acme-ds.ui-label',
  name: 'UiLabel',
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@acme/design-system',
  props: [{ name: 'info', type: 'string', required: false, control: { kind: 'text' } }],
  rendering: [
    {
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
    },
  ],
}

const KLABEL_NO_HINTS: ComponentManifest = {
  id: 'acme-ds.ui-label',
  name: 'UiLabel',
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@acme/design-system',
  props: [],
}

const KLABEL_UNTRUSTED_ONLY: ComponentManifest = {
  ...KLABEL_WITH_TRUSTED_HINTS,
  rendering: [
    {
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
      provenance: 'inferred',
      verified: false,
    },
  ],
}

const KLABEL_WITH_UNEDITABLE_HINT: ComponentManifest = {
  ...KLABEL_WITH_TRUSTED_HINTS,
  rendering: [
    {
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'uneditable',
      uneditableReason: 'Library-internal.',
    },
  ],
}

function refuse(reason = 'refused'): AttributionResult {
  return { kind: 'refuse', reason }
}

function directProp(): AttributionResult {
  return {
    kind: 'direct',
    targetFile: 'form.vue',
    sourceLoc: { file: 'form.vue', line: 1, column: 1 },
    editKind: 'prop',
    propName: 'label',
    currentValue: 'Path',
    valueType: 'string',
  }
}

function contextClicking(selector: string): AttributionContext {
  return {
    clickedElement: { selectorWithinMountRoot: selector, textContent: 'Path' },
    componentChain: [
      {
        name: 'UiLabel',
        importPath: '@acme/design-system',
        consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
        consumerVnodeProps: { info: { kind: 'literal', value: 'hint' } },
      },
      { name: 'AIGatewayModelCreate' },
    ],
  }
}

// ──────────────── hint-miss: fires ────────────────

describe('detectDrift — hint-miss', () => {
  it('fires when the manifest has trusted hints but none matched the clicked element', () => {
    const context = contextClicking('.unmatched-selector')
    const signals = detectDrift({
      context,
      result: refuse('No rendering hint matched the clicked element'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })

    expect(signals).toHaveLength(1)
    expect(signals[0]).toMatchObject({
      kind: 'hint-miss',
      component: 'UiLabel',
      importPath: '@acme/design-system',
      designSystem: 'acme-ds',
      detail: '.unmatched-selector',
    })
    expect(typeof signals[0].at).toBe('string')
    expect(Number.isNaN(Date.parse(signals[0].at))).toBe(false)
  })

  // ──────────────── EXCLUDED shape 1: no-hints-authored ────────────────
  it('does NOT fire for a no-hints-authored refusal (empty rendering array)', () => {
    const context = contextClicking(':root')
    const signals = detectDrift({
      context,
      result: refuse('No rendering hints for UiLabel'),
      owningManifest: KLABEL_NO_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  it('does NOT fire when every hint is untrusted (behaves like no hints)', () => {
    const context = contextClicking(':root')
    const signals = detectDrift({
      context,
      result: refuse('No rendering hints for UiLabel'),
      owningManifest: KLABEL_UNTRUSTED_ONLY,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  // ──────────────── EXCLUDED shape 2: uneditable hint ────────────────
  it('does NOT fire for an `uneditable` hint refusal (dom hit WAS found)', () => {
    const context = contextClicking(':root') // matches the uneditable hint's domTarget
    const signals = detectDrift({
      context,
      result: refuse('UiLabel is marked uneditable'),
      owningManifest: KLABEL_WITH_UNEDITABLE_HINT,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  // ──────────────── EXCLUDED shape 3: unmanifested-parent chain break ────────────────
  it('does NOT fire for an unmanifested-parent chain break (dom hit WAS found)', () => {
    const context = contextClicking(':root') // matches KLABEL_WITH_TRUSTED_HINTS' domTarget
    const signals = detectDrift({
      context,
      result: refuse(
        'Cannot attribute deterministically: the immediate parent component has no rendering manifest',
      ),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  // ──────────────── EXCLUDED shape 4: prop-not-set-at-call-site ────────────────
  it('does NOT fire for a prop-not-set-at-call-site refusal (dom hit WAS found)', () => {
    const context = contextClicking(':root')
    const signals = detectDrift({
      context,
      result: refuse('UiLabel.info is not currently set at the call site.'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  it('does NOT fire when the result is not a refuse', () => {
    const context = contextClicking('.unmatched-selector')
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  it('does NOT fire when there is no owning manifest at all', () => {
    const context = contextClicking('.unmatched-selector')
    const signals = detectDrift({
      context,
      result: refuse('No rendering hints for UiLabel'),
      owningManifest: null,
    })
    expect(signals.filter((s) => s.kind === 'hint-miss')).toHaveLength(0)
  })

  // ──────────────── importPath fallback (repair identity) ────────────────
  it('falls back to the manifest importPath when the runtime chain entry has none (pre-compiled library shape)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: '.unmatched-selector' },
      componentChain: [
        { name: 'UiLabel' }, // no importPath — __file stripped, as for a pre-compiled library
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const signals = detectDrift({
      context,
      result: refuse('No rendering hint matched the clicked element'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS, // importPath: '@acme/design-system'
    })
    const sig = signals.find((s) => s.kind === 'hint-miss')
    expect(sig).toMatchObject({ importPath: '@acme/design-system' })
  })

  it('emits importPath undefined (no crash) when both the chain entry and the manifest lack one', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: '.unmatched-selector' },
      componentChain: [{ name: 'UiLabel' }],
    }
    const manifestNoImportPath: ComponentManifest = { ...KLABEL_WITH_TRUSTED_HINTS, importPath: undefined }
    const signals = detectDrift({
      context,
      result: refuse('No rendering hint matched the clicked element'),
      owningManifest: manifestNoImportPath,
    })
    const sig = signals.find((s) => s.kind === 'hint-miss')
    expect(sig).toBeDefined()
    expect(sig?.importPath).toBeUndefined()
  })
})

// ──────────────── unknown-component ────────────────

describe('detectDrift — unknown-component', () => {
  it('fires when owningManifest is null and the chain entry has an importPath', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [{ name: 'MysteryWidget', importPath: '@acme/ui' }],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: 'unknown-component',
        component: 'MysteryWidget',
        importPath: '@acme/ui',
      }),
    )
  })

  it('does NOT fire when owningManifest is null and the chain entry has no importPath at all (no package evidence, e.g. a bare local root)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [{ name: 'InternalWidget' }], // no importPath, no consumerSourceLoc
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'unknown-component')).toHaveLength(0)
  })

  it('does NOT fire for a first-party ROOT component (file-path importPath, no consumerSourceLoc, no manifest) — regression for the old consumerSourceLoc-undefined branch misreporting app roots as an unknown library', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        { name: 'App', importPath: 'src/App.vue' }, // root: nothing calls it, so no consumerSourceLoc
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'unknown-component')).toHaveLength(0)
  })

  it('does NOT fire for a user-authored local component with a call site and no importPath', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'MyLocalCard',
          consumerSourceLoc: { file: 'app.vue', line: 10, column: 2 },
        },
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'unknown-component')).toHaveLength(0)
  })

  it('does NOT fire when a manifest was found', () => {
    const context = contextClicking(':root')
    const signals = detectDrift({
      context,
      result: refuse(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'unknown-component')).toHaveLength(0)
  })

  it('does NOT fire for a plain DOM click with no owning component (empty chain)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals).toHaveLength(0)
  })

  // ──────────────── importPath shape gate (package specifier vs. file path) ────────────────
  it('does NOT fire for a first-party component whose importPath is a SOURCE FILE PATH (bridge readImportPath\'s non-node_modules shape), even with no manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'Foo',
          importPath: 'src/components/Foo.vue', // readImportPath's file-path branch, NOT a package specifier
          consumerSourceLoc: { file: 'app.vue', line: 5, column: 3 },
        },
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'unknown-component')).toHaveLength(0)
  })

  it('fires for a bare package specifier importPath (e.g. `@acme/design-system`)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'MysteryWidget',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'app.vue', line: 5, column: 3 },
        },
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals).toContainEqual(
      expect.objectContaining({ kind: 'unknown-component', component: 'MysteryWidget', importPath: '@acme/design-system' }),
    )
  })

  it('fires for a scoped-package-with-subpath importPath (e.g. `@acme/ui/components`) — still a package, not a file path', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'MysteryWidget',
          importPath: '@acme/ui/components',
          consumerSourceLoc: { file: 'app.vue', line: 5, column: 3 },
        },
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals).toContainEqual(
      expect.objectContaining({ kind: 'unknown-component', component: 'MysteryWidget', importPath: '@acme/ui/components' }),
    )
  })
})

// ──────────────── unknown-props ────────────────

describe('detectDrift — unknown-props', () => {
  it('fires with sorted, capped detail when consumer props are absent from the manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: {
            zeta: { kind: 'literal', value: '1' },
            gamma: { kind: 'literal', value: '1' },
            info: { kind: 'literal', value: 'known' }, // in manifest — excluded
            alpha: { kind: 'literal', value: '1' },
            beta: { kind: 'literal', value: '1' },
            delta: { kind: 'literal', value: '1' },
            epsilon: { kind: 'literal', value: '1' }, // 6th unknown — capped out
          },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    const sig = signals.find((s) => s.kind === 'unknown-props')
    expect(sig).toBeDefined()
    expect(sig?.detail).toBe('alpha, beta, delta, epsilon, gamma')
  })

  it('excludes platform/global props (class, style, key, ref, on*)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: {
            class: { kind: 'literal', value: 'x' },
            style: { kind: 'literal', value: 'x' },
            key: { kind: 'literal', value: 'x' },
            ref: { kind: 'literal', value: 'x' },
            onClick: { kind: 'literal', value: 'x' },
          },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'unknown-props')).toHaveLength(0)
  })

  it('excludes data-*/aria-* and standard HTML global attrs (id, title, role, tabindex) — regression for false unknown-props on every real component', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: {
            'data-testid': { kind: 'literal', value: 'x' },
            'aria-label': { kind: 'literal', value: 'x' },
            id: { kind: 'literal', value: 'x' },
            title: { kind: 'literal', value: 'x' },
            role: { kind: 'literal', value: 'x' },
            tabindex: { kind: 'literal', value: 'x' },
          },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'unknown-props')).toHaveLength(0)
  })

  it('still fires on a genuinely unknown prop alongside excluded global attrs', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: {
            'data-testid': { kind: 'literal', value: 'x' },
            id: { kind: 'literal', value: 'x' },
            mysteryProp: { kind: 'literal', value: 'x' },
          },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    const sig = signals.find((s) => s.kind === 'unknown-props')
    expect(sig?.detail).toBe('mysteryProp')
  })

  it('does NOT fire when there is no owning manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        { name: 'Mystery', consumerVnodeProps: { extra: { kind: 'literal', value: 'x' } } },
      ],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'unknown-props')).toHaveLength(0)
  })

  it('does NOT fire when consumerVnodeProps is absent', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [{ name: 'UiLabel', importPath: '@acme/design-system' }],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'unknown-props')).toHaveLength(0)
  })

  it('does NOT fire when every consumer prop is declared on the manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: { info: { kind: 'literal', value: 'known' } },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'unknown-props')).toHaveLength(0)
  })

  // ──────────────── importPath fallback (repair identity) ────────────────
  it('falls back to the manifest importPath when the runtime chain entry has none (pre-compiled library shape)', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        {
          name: 'UiLabel', // no importPath — __file stripped, as for a pre-compiled library
          consumerVnodeProps: { mysteryProp: { kind: 'literal', value: 'x' } },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS, // importPath: '@acme/design-system'
    })
    const sig = signals.find((s) => s.kind === 'unknown-props')
    expect(sig).toMatchObject({ importPath: '@acme/design-system' })
  })

  it('emits importPath undefined (no crash) when both the chain entry and the manifest lack one', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root' },
      componentChain: [
        { name: 'UiLabel', consumerVnodeProps: { mysteryProp: { kind: 'literal', value: 'x' } } },
      ],
    }
    const manifestNoImportPath: ComponentManifest = { ...KLABEL_WITH_TRUSTED_HINTS, importPath: undefined }
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: manifestNoImportPath,
    })
    const sig = signals.find((s) => s.kind === 'unknown-props')
    expect(sig).toBeDefined()
    expect(sig?.importPath).toBeUndefined()
  })
})

// ──────────────── selector-ambiguous (Phase 5 Task 3) ────────────────

describe('detectDrift — selector-ambiguous', () => {
  it('fires when a trusted dom hit matches but soleMatchWithinMountRoot is false', () => {
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Path',
        soleMatchWithinMountRoot: false,
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
          consumerVnodeProps: { info: { kind: 'literal', value: 'hint' } },
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const signals = detectDrift({
      context,
      result: refuse('multiple elements match'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: 'selector-ambiguous',
        component: 'UiLabel',
        importPath: '@acme/design-system',
        designSystem: 'acme-ds',
        detail: ':root',
      }),
    )
  })

  it('does NOT fire when soleMatchWithinMountRoot is true', () => {
    const context = contextClicking(':root')
    context.clickedElement.soleMatchWithinMountRoot = true
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'selector-ambiguous')).toHaveLength(0)
  })

  it('does NOT fire when soleMatchWithinMountRoot is undefined (unknown — no regression)', () => {
    const context = contextClicking(':root')
    const signals = detectDrift({
      context,
      result: directProp(),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'selector-ambiguous')).toHaveLength(0)
  })

  it('does NOT fire when the flag is false but no trusted dom hit matched the selector', () => {
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: '.unmatched-selector',
        soleMatchWithinMountRoot: false,
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: refuse('No rendering hint matched'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    expect(signals.filter((s) => s.kind === 'selector-ambiguous')).toHaveLength(0)
  })

  it('does NOT fire when there is no owning manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', soleMatchWithinMountRoot: false },
      componentChain: [{ name: 'Mystery' }],
    }
    const signals = detectDrift({ context, result: refuse(), owningManifest: null })
    expect(signals.filter((s) => s.kind === 'selector-ambiguous')).toHaveLength(0)
  })
})

// ──────────────── multiple signals ────────────────

describe('detectDrift — independent rules can co-fire', () => {
  it('emits both hint-miss and unknown-props for the same click when both conditions hold', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: '.nope' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerVnodeProps: { mystery: { kind: 'literal', value: '1' } },
        },
      ],
    }
    const signals = detectDrift({
      context,
      result: refuse('no hint matched'),
      owningManifest: KLABEL_WITH_TRUSTED_HINTS,
    })
    const kinds = signals.map((s) => s.kind).sort()
    expect(kinds).toEqual(['hint-miss', 'unknown-props'])
  })
})
