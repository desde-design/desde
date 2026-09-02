/**
 * Tests for the manifest-first attribution function. Each case is a
 * synthetic `AttributionContext` plus a synthetic `ManifestLookup` that
 * stands in for the registry. No bridge, no DOM, no Vue — pure logic
 * exercise so we can iterate on the algorithm before the bridge wiring
 * is in place.
 *
 * The validation cases map back to the numbered set in
 * `tasks/attribution-rewrite.md` §Validation set. Cases without a
 * dedicated test here are deferred to Phase 2c (bindings, scoping) or
 * Phase 2e (live-iframe validation).
 */

import { describe, expect, it } from 'vitest'
import type { ComponentManifest } from '../core'
import { attribute, MAX_FORWARD_DEPTH } from './attribute'
import { detectDrift } from './detect-drift'
import type { AttributionContext, ManifestLookup } from './types'

// ──────────────── Test fixtures ────────────────

/** Minimal hand-rolled manifest set matching the rendering-hints.ts shape. */
const KLABEL_MANIFEST: ComponentManifest = {
  id: 'acme-ds.ui-label',
  name: 'UiLabel',
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@acme/design-system',
  props: [],
  rendering: [
    {
      kind: 'dom',
      source: { kind: 'slot', name: 'default' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
    },
    {
      kind: 'dom',
      source: { kind: 'prop', name: 'info' },
      domTarget: { selector: '.label-tooltip [role="tooltip"]', field: 'textContent' },
      editability: 'literal',
    },
  ],
}

const KINPUT_MANIFEST: ComponentManifest = {
  id: 'acme-ds.ui-input',
  name: 'UiInput',
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@acme/design-system',
  props: [],
  rendering: [
    {
      kind: 'forward',
      source: { kind: 'prop', name: 'label' },
      forwardTo: { component: 'UiLabel', childSlot: 'default' },
    },
    {
      kind: 'dom',
      source: { kind: 'prop', name: 'placeholder' },
      domTarget: { selector: 'input.ui-input', field: 'attribute', attribute: 'placeholder' },
      editability: 'literal',
    },
  ],
}

/** Map-based ManifestLookup for tests. Returns null for unknown names. */
function makeLookup(manifests: ComponentManifest[]): ManifestLookup {
  const byName = new Map(manifests.map((m) => [m.name, m]))
  return {
    getByName: (name: string) => byName.get(name) ?? null,
  }
}

// ──────────────── Case 2: direct user-code <UiLabel>foo</UiLabel> ────────────────

describe('attribute() — case 2: direct user-code UiLabel slot', () => {
  it('resolves slot text to the consumer call site', () => {
    // Source: <UiLabel :info="...">Additional base paths</UiLabel> at form.vue:70:21.
    // Click "Additional base paths" → owning instance is UiLabel,
    // clicked element matches the default-slot dom hint (:root).
    // No ancestor has a forward hint targeting UiLabel.default, so the
    // slot terminates at the leaf's own call site (UiLabel's vnode stamp).
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Additional base paths',
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
          consumerVnodeProps: {
            info: { kind: 'literal', value: 'A list of paths…' },
          },
        },
        // Parent is the user SFC; no manifest, no forward hint.
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))

    expect(result).toEqual({
      kind: 'direct',
      targetFile: 'form.vue',
      sourceLoc: { file: 'form.vue', line: 70, column: 21 },
      editKind: 'slot',
      slotName: 'default',
      currentValue: 'Additional base paths',
      valueType: 'string',
      renders: { selector: ':root', field: 'textContent' },
    })
  })
})

// ──────────────── Case 1: <UiInput label="Path"> forward chain ────────────────

describe('attribute() — case 1: <UiInput label="Path"> via internal UiLabel', () => {
  it('walks the forward chain from UiLabel.default to UiInput.label', () => {
    // Source: <UiInput label="Path" :label-attributes="{info: '…'}"> at form.vue:55:11.
    // The rendered "Path" text lives inside UiInput's internal UiLabel.
    // Click "Path" → owning instance is UiLabel, clicked element matches
    // UiLabel's default-slot dom hint. Walk up: UiInput's manifest has a
    // forward hint (label prop → UiLabel.default slot). Forward terminates
    // at UiInput.label literal; resolve at UiInput's call site.
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Path',
      },
      componentChain: [
        // Innermost: the internal UiLabel rendered by UiInput. No
        // consumerSourceLoc because user code didn't author this
        // <UiLabel> tag — UiInput's template did. UiInput's own template
        // is what put this UiLabel here, so renderedByParent is true.
        { name: 'UiLabel', importPath: '@acme/design-system', renderedByParent: true },
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 55, column: 11 },
          consumerVnodeProps: {
            label: { kind: 'literal', value: 'Path' },
          },
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, KINPUT_MANIFEST]))

    expect(result).toEqual({
      kind: 'direct',
      targetFile: 'form.vue',
      sourceLoc: { file: 'form.vue', line: 55, column: 11 },
      editKind: 'prop',
      propName: 'label',
      currentValue: 'Path',
      valueType: 'string',
      renders: { selector: ':root', field: 'textContent' },
    })
  })

  it('refuses when the forwarded prop is missing from the call site', () => {
    // Same setup as above but the consumer didn't pass `label`. The
    // forward hint still matches, but there's nothing to edit at the
    // call site — surface honestly rather than silently failing.
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: '' },
      componentChain: [
        // UiInput's own template rendered this UiLabel, same as the
        // passing case above — the forward hop must still be allowed so
        // this test reaches "prop missing at UiInput's call site", not a
        // different refusal.
        { name: 'UiLabel', importPath: '@acme/design-system', renderedByParent: true },
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 55, column: 11 },
          consumerVnodeProps: {}, // no label
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, KINPUT_MANIFEST]))

    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('UiInput.label')
      expect(result.reason).toContain('not currently set')
    }
  })
})

// ──────────────── Case 9: placeholder via dom-attribute hint ────────────────

describe('attribute() — case 9: <UiInput placeholder="…"> attribute', () => {
  it('resolves placeholder attribute click to UiInput.placeholder prop', () => {
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: 'input.ui-input',
        attributeName: 'placeholder',
        attributeValue: 'e.g. /api/v1',
      },
      componentChain: [
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 88, column: 9 },
          consumerVnodeProps: {
            placeholder: { kind: 'literal', value: 'e.g. /api/v1' },
          },
        },
      ],
    }
    const result = attribute(context, makeLookup([KINPUT_MANIFEST]))

    expect(result).toEqual({
      kind: 'direct',
      targetFile: 'form.vue',
      sourceLoc: { file: 'form.vue', line: 88, column: 9 },
      editKind: 'prop',
      propName: 'placeholder',
      currentValue: 'e.g. /api/v1',
      valueType: 'string',
      renders: { selector: 'input.ui-input', field: 'attribute', attribute: 'placeholder' },
    })
  })
})

// ──────────────── Case 7: library-internal text (refuse honestly) ────────────────

describe('attribute() — case 7: library-internal hardcoded text', () => {
  it('refuses with a useful reason when no manifest exists', () => {
    // Click on text rendered by a library component we have no manifest
    // for. Surface honestly — no silent failure.
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Search' },
      componentChain: [{ name: 'SomeUnknownComponent' }],
    }
    const result = attribute(context, makeLookup([]))

    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('No rendering hints for SomeUnknownComponent')
    }
  })

  it('refuses when manifest exists but no hint matches the selector', () => {
    // Manifest is present but the clicked element doesn't match any
    // hint — e.g., the user clicked deep into internal markup that
    // the manifest doesn't (yet) describe as editable.
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: '.ui-input-icon-wrapper', textContent: '' },
      componentChain: [
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 55, column: 11 },
          consumerVnodeProps: {},
        },
      ],
    }
    const result = attribute(context, makeLookup([KINPUT_MANIFEST]))

    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('No rendering hint matched')
      expect(result.reason).toContain('.ui-input-icon-wrapper')
    }
  })
})

// ──────────────── Case 2 slot text comes from clickedElement.textContent ────────────────

describe('attribute() — slot currentValue from clickedElement.textContent', () => {
  // Regression for codex review P1 #3: previously slot results returned
  // currentValue: '' as a placeholder, which would make the downstream
  // applySlotTextEdit refuse with "before is empty after trimming."
  // The real value lives on clicked.textContent — thread it through.
  it('populates currentValue from raw textContent (whitespace preserved) for slot terminals', () => {
    // Faithfulness regression for codex round-2 P2: passing the raw
    // textContent through to the inspector preserves intentional
    // padding (`<UiLabel>  Padded  </UiLabel>`). applySlotTextEdit is
    // whitespace-preserving on rewrite, so display faithfulness
    // doesn't cost edit correctness.
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: '   Additional base paths   ',
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
          consumerVnodeProps: {},
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      expect(result.currentValue).toBe('   Additional base paths   ')
    }
  })

  it('refuses when slot text is empty', () => {
    // applySlotTextEdit refuses empty `before`; surface that explicitly
    // here rather than producing a result the downstream applicator
    // will reject silently.
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: '   ' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
          consumerVnodeProps: {},
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('empty rendered text')
    }
  })

  it('prefers ownText over textContent for slot terminals (info-tooltip over-capture)', () => {
    // Phase 2e case 2: `<UiLabel :info="…">Paths</UiLabel>` renders the
    // slot text "Paths" as a direct text node AND the info tooltip as a
    // sibling element inside the same <label>, so textContent
    // over-captures ("PathsA list of paths that match…"). The slot-text
    // applicator matches `before` against the source between the tags
    // ("Paths"), so currentValue MUST be the direct-text-only value.
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'PathsA list of paths that match this route.',
        ownText: 'Paths',
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 313, column: 17 },
          consumerVnodeProps: {},
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      expect(result.editKind).toBe('slot')
      expect(result.currentValue).toBe('Paths')
    }
  })

  it('refuses (no textContent fallback) when ownText is defined but empty', () => {
    // An empty ownText means the slot content is entirely nested
    // elements (e.g. only an icon, no literal text). Falling back to
    // textContent would re-introduce the over-capture bug, so refuse.
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Tooltip text from a nested element',
        ownText: '',
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
          consumerVnodeProps: {},
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('empty rendered text')
    }
  })
})

// ──────────────── Prop-to-prop forward chain ────────────────

describe('attribute() — prop-to-prop forward chains', () => {
  // Regression for codex review P1 #1: previously attribute() only
  // walked forward chains for slot sources; prop sources resolved
  // immediately at the owning component, dropping any prop->prop
  // forward (e.g., MyCard forwards `title` to internal UiInput's `label`).
  const MY_CARD_MANIFEST: ComponentManifest = {
    id: 'first-party.my-card',
    name: 'MyCard',
    framework: 'vue3',
    designSystem: 'first-party',
    importPath: 'src/components/MyCard.vue',
    props: [],
    rendering: [
      {
        kind: 'forward',
        source: { kind: 'prop', name: 'title' },
        forwardTo: { component: 'UiInput', childProp: 'label' },
      },
    ],
  }

  it('walks MyCard.title -> UiInput.label -> UiLabel.default for a click on label text', () => {
    // <MyCard title="Hello" /> at App.vue:5:3
    //   internal: <UiInput :label="title" /> (UiInput's call site is inside MyCard)
    //     internal: <UiLabel>{{ label }}</UiLabel> (UiLabel's call site is inside UiInput)
    // Click "Hello" -> chain: [UiLabel, UiInput, MyCard, App].
    // Walk: UiLabel.slot:default -> UiInput forward label->UiLabel.default
    //       (label is on UiInput, but UiInput's label is bound to `title`
    //        which is MyCard's prop) -> MyCard forward title->UiInput.label
    //       -> terminal at MyCard call site with literal title="Hello".
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Hello' },
      componentChain: [
        // UiLabel rendered by UiInput (no user call site)
        { name: 'UiLabel', importPath: '@acme/design-system', renderedByParent: true },
        // UiInput rendered by MyCard. The consumer's vnode for UiInput
        // here represents MyCard's internal `<UiInput :label="title">`
        // -- but for the forward-chain test we don't need the binding
        // detail; the chain keeps walking past it.
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          // MyCard's own template rendered this UiInput.
          renderedByParent: true,
          consumerVnodeProps: {
            // label is bound to title; we keep walking past this entry
            // because MyCard's forward hint claims UiInput.label.
            label: { kind: 'binding', value: 'Hello', expression: 'title' },
          },
        },
        // MyCard authored at App.vue:5:3 with literal title="Hello"
        {
          name: 'MyCard',
          importPath: 'src/components/MyCard.vue',
          consumerSourceLoc: { file: 'App.vue', line: 5, column: 3 },
          consumerVnodeProps: {
            title: { kind: 'literal', value: 'Hello' },
          },
        },
        { name: 'App' },
      ],
    }
    const result = attribute(
      context,
      makeLookup([KLABEL_MANIFEST, KINPUT_MANIFEST, MY_CARD_MANIFEST]),
    )
    expect(result).toEqual({
      kind: 'direct',
      targetFile: 'App.vue',
      sourceLoc: { file: 'App.vue', line: 5, column: 3 },
      editKind: 'prop',
      propName: 'title',
      currentValue: 'Hello',
      valueType: 'string',
      renders: { selector: ':root', field: 'textContent' },
    })
  })

  it('walks a prop-to-prop forward when the owning component dom hint is a prop', () => {
    // Same shape but the user clicks the placeholder attribute -- the
    // owning dom hint is sourced from a prop, and we still need to
    // walk for prop-to-prop forwards on the way up.
    const PLACEHOLDER_FORWARD_CARD: ComponentManifest = {
      id: 'first-party.placeholder-card',
      name: 'PlaceholderCard',
      framework: 'vue3',
      designSystem: 'first-party',
      importPath: 'src/components/PlaceholderCard.vue',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'prop', name: 'hint' },
          forwardTo: { component: 'UiInput', childProp: 'placeholder' },
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: 'input.ui-input',
        attributeName: 'placeholder',
        attributeValue: 'e.g. /api',
      },
      componentChain: [
        // Owning UiInput renders the <input>; its placeholder is bound
        // to MyCard's `hint` prop. The forward chain continues up.
        // PlaceholderCard's own template rendered this UiInput.
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          renderedByParent: true,
          consumerVnodeProps: {
            placeholder: { kind: 'binding', value: 'e.g. /api', expression: 'hint' },
          },
        },
        {
          name: 'PlaceholderCard',
          importPath: 'src/components/PlaceholderCard.vue',
          consumerSourceLoc: { file: 'App.vue', line: 9, column: 3 },
          consumerVnodeProps: {
            hint: { kind: 'literal', value: 'e.g. /api' },
          },
        },
      ],
    }
    const result = attribute(
      context,
      makeLookup([KINPUT_MANIFEST, PLACEHOLDER_FORWARD_CARD]),
    )
    expect(result).toEqual({
      kind: 'direct',
      targetFile: 'App.vue',
      sourceLoc: { file: 'App.vue', line: 9, column: 3 },
      editKind: 'prop',
      propName: 'hint',
      currentValue: 'e.g. /api',
      valueType: 'string',
      renders: { selector: 'input.ui-input', field: 'attribute', attribute: 'placeholder' },
    })
  })
})

// ──────────────── Walk stops at immediate parent, never skips ────────────────

describe('attribute() — walk only checks immediate parent, never iterates past no-manifest intermediates', () => {
  // Regression for codex round-2 P1: previous implementation iterated
  // through ALL higher ancestors looking for forwards, matching against
  // chain[i-1].name. When an intermediate ancestor had no manifest,
  // the iteration would skip it and ask chain[i+1] about its forward
  // to chain[i] — a DIFFERENT parent-child relationship than the one
  // being walked. This produced wrong attribution by matching a higher
  // ancestor's forward against the wrong child boundary.
  it('terminates at the leaf call site when the immediate parent has no manifest, even if a higher ancestor would have matched a different boundary', () => {
    // chain: [UiLabel @ form.vue:70:21, NoManifestMiddle, Outer]
    // UiLabel: dom hint default slot.
    // Outer: forward hint default -> NoManifestMiddle.default
    //        (would falsely match against chain[i-1] under the old code).
    const OUTER: ComponentManifest = {
      id: 'first-party.outer',
      name: 'Outer',
      framework: 'vue3',
      designSystem: 'first-party',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'slot', name: 'default' },
          forwardTo: { component: 'NoManifestMiddle', childSlot: 'default' },
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Hello' },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
        },
        // No manifest at all for the intermediate.
        { name: 'NoManifestMiddle' },
        // Outer would falsely claim the slot under the old (iterative)
        // walk — but it shouldn't, because its forward describes its
        // relationship to NoManifestMiddle (its direct child), not to
        // UiLabel (two levels down).
        {
          name: 'Outer',
          importPath: 'src/components/Outer.vue',
          consumerSourceLoc: { file: 'App.vue', line: 99, column: 1 },
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, OUTER]))
    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      // Correct: terminates at UiLabel's own call site, NOT at Outer's.
      expect(result.targetFile).toBe('form.vue')
      expect(result.sourceLoc).toEqual({ file: 'form.vue', line: 70, column: 21 })
      expect(result.editKind).toBe('slot')
    }
  })
})

// ──────────────── renderedByParent guard: slot content isn't a render ────────────────

describe('attribute() — renderedByParent guard (slot content vs. forward hint)', () => {
  // Both frameworks report the SAME nesting `.parent` whether that parent
  // rendered the child from its own template, or merely received the child
  // as slot/children content the user wrote somewhere else. The component
  // chain alone can't tell those apart.
  //
  // `renderedByParent` is a runtime fact instead of an inference: it's
  // supplied by `FrameworkRuntimeAdapter.getRenderOwnerInstance` (Vue
  // `vnode.ctx`; React `fiber._debugOwner`), and `walkForward` hops ONLY
  // when it reads exactly `true`. An earlier cut of this guard compared
  // source paths instead (`authoredInsideParent`, now deleted) and was
  // wrong twice: a `data-desde-src` stamp can be INHERITED through a
  // framework's attribute fallthrough onto a component that did not author
  // it, and the definition-file path it compared against doesn't exist at
  // all on React. See the guard in `walkForward` for the full write-up;
  // these tests pin the new field's three states directly.

  it('THE HEADLINE: renderedByParent: false refuses the hop — a user-authored <KButton> inside a slot resolves at its OWN call site, not at the forward-hint target', () => {
    // Measured live bug: KEmptyState.actionButtonText -> KButton.default is
    // a real, verified forward hint. AIGatewayListEmptyState.vue puts a
    // user-written <KButton>New AI Gateway</KButton> inside KEmptyState's
    // #action slot. Without the guard, clicking the button text retargets
    // the edit onto KEmptyState's `action-button-text` prop and the button
    // the user actually clicked is never touched. Before forward hints
    // existed, the walk terminated here (correctly) — this guard restores
    // that behavior in the forward-hint world.
    const KBUTTON_MANIFEST: ComponentManifest = {
      id: 'kongponents.k-button',
      name: 'KButton',
      framework: 'vue3',
      designSystem: 'kongponents',
      importPath: '@kong/kongponents',
      props: [],
      rendering: [
        {
          kind: 'dom',
          source: { kind: 'slot', name: 'default' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
        },
      ],
    }
    const KEMPTYSTATE_MANIFEST: ComponentManifest = {
      id: 'kongponents.k-empty-state',
      name: 'KEmptyState',
      framework: 'vue3',
      designSystem: 'kongponents',
      importPath: '@kong/kongponents',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'prop', name: 'actionButtonText' },
          forwardTo: { component: 'KButton', childSlot: 'default' },
          provenance: 'generated',
          verified: true,
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'New AI Gateway',
        ownText: 'New AI Gateway',
      },
      componentChain: [
        // The user's own <KButton>New AI Gateway</KButton>, written inside
        // AIGatewayListEmptyState.vue and handed to KEmptyState's #action
        // slot. `.parent` is KEmptyState (Vue's whole-subtree patching),
        // but KEmptyState did NOT render this tag — the user's own file
        // did — so the adapter reports renderedByParent: false.
        {
          name: 'KButton',
          importPath: '@kong/kongponents',
          renderedByParent: false,
          consumerSourceLoc: {
            file: 'src/views/AIGatewayListEmptyState.vue',
            line: 12,
            column: 9,
          },
          consumerVnodeProps: {},
        },
        {
          name: 'KEmptyState',
          importPath: '@kong/kongponents',
          consumerSourceLoc: {
            file: 'src/views/AIGatewayListShell.vue',
            line: 20,
            column: 5,
          },
          consumerVnodeProps: {
            actionButtonText: { kind: 'literal', value: 'New AI Gateway' },
          },
        },
      ],
    }
    const result = attribute(context, makeLookup([KBUTTON_MANIFEST, KEMPTYSTATE_MANIFEST]))

    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      // Resolved at the user's OWN KButton call site...
      expect(result.targetFile).toBe('src/views/AIGatewayListEmptyState.vue')
      expect(result.sourceLoc).toEqual({
        file: 'src/views/AIGatewayListEmptyState.vue',
        line: 12,
        column: 9,
      })
      // ...and critically, NOT hijacked onto KEmptyState's forwarded prop.
      expect(result.propName).not.toBe('actionButtonText')
      expect(result.editKind).toBe('slot')
      expect(result.slotName).toBe('default')
    }
  })

  it('legitimate forward hop still works: renderedByParent: true allows the hop through a library-internal child with no call site', () => {
    // Contrast case (this is harness case 1, re-asserted here so a future
    // change to the guard can't quietly break it): UiLabel here has NO
    // consumerSourceLoc at all — it's genuinely library-internal, rendered
    // by UiInput's own template, not handed in as slot content, and the
    // adapter confirms it with renderedByParent: true. The forward hop from
    // UiLabel.default -> UiInput.label must still resolve at UiInput's call
    // site.
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Path' },
      componentChain: [
        // Library-internal: UiInput's own template rendered this UiLabel.
        // No consumerSourceLoc — no user file authored this tag.
        { name: 'UiLabel', importPath: '@acme/design-system', renderedByParent: true },
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 55, column: 11 },
          consumerVnodeProps: {
            label: { kind: 'literal', value: 'Path' },
          },
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, KINPUT_MANIFEST]))

    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      expect(result.targetFile).toBe('form.vue')
      expect(result.sourceLoc).toEqual({ file: 'form.vue', line: 55, column: 11 })
      expect(result.editKind).toBe('prop')
      expect(result.propName).toBe('label')
    }
  })

  it('renderedByParent undefined (unknown) also refuses the hop, same as false — a lost signal must not risk editing the wrong source', () => {
    // WHY unknown refuses instead of allowing: the two ways to get this
    // wrong don't cost the same. Refusing on an unknown signal costs one
    // hint — the click degrades to the heuristic/LLM lane, same as a
    // component with no manifest at all. Allowing on an unknown signal
    // risks silently splicing an edit into a component the click never
    // actually rendered through — a WRONG deterministic edit, which is
    // worse than falling back. `undefined` shows up for real: a production
    // Vue build, an unsupported substrate, or an older bridge build that
    // predates this field all report "I don't know" rather than "false".
    const LEAF_MANIFEST: ComponentManifest = {
      id: 'first-party.leaf-component',
      name: 'LeafComponent',
      framework: 'vue3',
      designSystem: 'first-party',
      props: [],
      rendering: [
        {
          kind: 'dom',
          source: { kind: 'slot', name: 'default' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
        },
      ],
    }
    const MIDDLE_MANIFEST: ComponentManifest = {
      id: 'first-party.middle-wrapper',
      name: 'MiddleWrapper',
      framework: 'vue3',
      designSystem: 'first-party',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'prop', name: 'caption' },
          forwardTo: { component: 'LeafComponent', childSlot: 'default' },
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Hi there' },
      componentChain: [
        // renderedByParent intentionally OMITTED (not false — genuinely
        // absent), modelling an adapter that could not determine
        // ownership. LeafComponent still needs its own call site to
        // resolve at, distinct from MiddleWrapper's file, so this test can
        // tell "resolved at the child" apart from "hijacked to the parent".
        {
          name: 'LeafComponent',
          consumerSourceLoc: { file: 'src/components/SomeOtherFile.vue', line: 2, column: 1 },
        },
        {
          name: 'MiddleWrapper',
          consumerSourceLoc: { file: 'src/components/MiddleWrapper.vue', line: 3, column: 1 },
          consumerVnodeProps: { caption: { kind: 'literal', value: 'Hi there' } },
        },
      ],
    }
    const result = attribute(context, makeLookup([LEAF_MANIFEST, MIDDLE_MANIFEST]))

    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      // Resolved at LeafComponent's OWN call site...
      expect(result.targetFile).toBe('src/components/SomeOtherFile.vue')
      expect(result.sourceLoc).toEqual({
        file: 'src/components/SomeOtherFile.vue',
        line: 2,
        column: 1,
      })
      expect(result.editKind).toBe('slot')
      // ...and NOT hijacked onto MiddleWrapper's forwarded `caption` prop.
      expect(result.propName).not.toBe('caption')
    }
  })
})

// ──────────────── Refuse message points at the right fix ────────────────

describe('attribute() — refuse messages name the real fix', () => {
  // Regression for codex round-4 P2 #1: when the walk stopped at an
  // unmanifested intermediate parent AND the leaf had no source
  // position (library component rendered through a transparent
  // wrapper), the refuse message said "vnode has no source position"
  // — misleading the user toward investigating the leaf instead of
  // adding a manifest for the wrapper.
  it('blames the unmanifested intermediate when termination is due to a missing parent manifest', () => {
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'X' },
      componentChain: [
        // Library leaf — no consumerSourceLoc (rendered by a wrapper
        // we don't have a manifest for).
        { name: 'UiLabel', importPath: '@acme/design-system' },
        // The unmanifested intermediate that breaks the chain.
        { name: 'MyTransparentWrapper' },
        // A higher ancestor (irrelevant to the message because we
        // never reach it due to the unmanifested intermediate).
        {
          name: 'OuterCard',
          consumerSourceLoc: { file: 'App.vue', line: 9, column: 1 },
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('MyTransparentWrapper')
      expect(result.reason).toContain('no rendering manifest')
      expect(result.reason).toContain('add a manifest')
    }
  })
})

// ──────────────── Depth bound catches self-referencing forwards ────────────────

describe('attribute() — depth bound catches malformed manifests', () => {
  it('terminates with refuse when forward hints self-reference indefinitely', () => {
    // Synthetic: manifest forwards its own slot to itself.
    // Self-referencing forwards don't make sense but shouldn't loop.
    const SELF_REF: ComponentManifest = {
      id: 'test.self-ref',
      name: 'SelfRef',
      framework: 'vue3',
      designSystem: 'acme-ds',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'slot', name: 'default' },
          forwardTo: { component: 'SelfRef', childSlot: 'default' },
        },
        {
          kind: 'dom',
          source: { kind: 'slot', name: 'default' },
          domTarget: { selector: ':root', field: 'textContent' },
        },
      ],
    }
    // Chain length derived from MAX_FORWARD_DEPTH so the test continues
    // to exercise the depth cap if the cap is raised in the future.
    // (Without this derivation, a fixed length 80 would silently stop
    // asserting the cap once MAX_FORWARD_DEPTH bumps past 80.)
    //
    // renderedByParent: true on every entry — the self-referencing manifest
    // models a component that nests itself, each level genuinely rendering
    // the next, so the walk must be ALLOWED to keep hopping. That's the
    // point of this test: the depth bound is what stops it, not the
    // renderedByParent guard refusing early.
    const componentChain = Array.from(
      { length: MAX_FORWARD_DEPTH + 16 },
      () => ({ name: 'SelfRef', renderedByParent: true }),
    )
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'x' },
      componentChain,
    }
    const result = attribute(context, makeLookup([SELF_REF]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('max depth')
    }
  })
})

// ──────────────── isSimpleIdentifier rejects exotic bindings ────────────────

// ──────────────── Trust gate: provenance/verified ────────────────

describe('attribute() — trust gate filters untrusted hints', () => {
  // Regression coverage for the Phase 4 rendering-hints trust gate:
  // hand-authored hints (no `provenance` field, as exercised by every
  // KLABEL_MANIFEST/KINPUT_MANIFEST case above) are trusted unconditionally;
  // `provenance: 'generated' | 'inferred'` hints are trusted ONLY when
  // `verified: true`. An all-untrusted `rendering` array must behave
  // byte-identically to `rendering` being absent — same refuse reason.

  it('refuses on a generated+unverified dom hint, same reason as no hints at all', () => {
    const GENERATED_UNVERIFIED: ComponentManifest = {
      id: 'acme.button',
      name: 'AcmeButton',
      framework: 'vue3',
      designSystem: 'acme',
      props: [],
      rendering: [
        {
          kind: 'dom',
          source: { kind: 'slot', name: 'default' },
          domTarget: { selector: ':root', field: 'textContent' },
          provenance: 'generated',
          verified: false,
        },
      ],
    }
    const noHintsManifest: ComponentManifest = {
      id: 'acme.button-nohints',
      name: 'AcmeButtonNoHints',
      framework: 'vue3',
      designSystem: 'acme',
      props: [],
    }
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Click me' },
      componentChain: [{ name: 'AcmeButton' }],
    }
    const result = attribute(context, makeLookup([GENERATED_UNVERIFIED]))
    expect(result.kind).toBe('refuse')

    // Same refuse reason as a manifest with no `rendering` at all.
    const baselineContext: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Click me' },
      componentChain: [{ name: 'AcmeButtonNoHints' }],
    }
    const baseline = attribute(baselineContext, makeLookup([noHintsManifest]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse' && baseline.kind === 'refuse') {
      expect(result.reason).toBe(
        baseline.reason.replace('AcmeButtonNoHints', 'AcmeButton'),
      )
    }
  })

  it('attributes deterministically on a generated+verified dom hint', () => {
    const GENERATED_VERIFIED: ComponentManifest = {
      id: 'acme.button',
      name: 'AcmeButton',
      framework: 'vue3',
      designSystem: 'acme',
      props: [],
      rendering: [
        {
          kind: 'dom',
          source: { kind: 'slot', name: 'default' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
          provenance: 'generated',
          verified: true,
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Click me' },
      componentChain: [
        {
          name: 'AcmeButton',
          consumerSourceLoc: { file: 'App.vue', line: 3, column: 1 },
        },
      ],
    }
    const result = attribute(context, makeLookup([GENERATED_VERIFIED]))
    expect(result.kind).toBe('direct')
    if (result.kind === 'direct') {
      expect(result.editKind).toBe('slot')
      expect(result.currentValue).toBe('Click me')
    }
  })

  it('chain refuses when the FORWARD-target parent only has an inferred+unverified hint', () => {
    // UiLabel (hand-authored, trusted) renders the clicked text via its
    // default-slot dom hint. The parent (AcmeCard) has a forward hint
    // claiming UiLabel.default -- but it's `provenance: 'inferred'` and
    // unverified, so the trust gate must treat AcmeCard as if it had NO
    // rendering hints at all, terminating the walk at UiLabel's own call
    // site (via the 'unmanifested-parent' path) rather than hopping up
    // to AcmeCard.
    const ACME_CARD_INFERRED_UNVERIFIED: ComponentManifest = {
      id: 'first-party.acme-card',
      name: 'AcmeCard',
      framework: 'vue3',
      designSystem: 'first-party',
      importPath: 'src/components/AcmeCard.vue',
      props: [],
      rendering: [
        {
          kind: 'forward',
          source: { kind: 'prop', name: 'title' },
          forwardTo: { component: 'UiLabel', childSlot: 'default' },
          provenance: 'inferred',
          verified: false,
        },
      ],
    }
    const context: AttributionContext = {
      clickedElement: { selectorWithinMountRoot: ':root', textContent: 'Hello' },
      componentChain: [
        // UiLabel itself has no consumerSourceLoc — rendered by AcmeCard's
        // template, not authored directly by the user.
        { name: 'UiLabel', importPath: '@acme/design-system' },
        {
          name: 'AcmeCard',
          importPath: 'src/components/AcmeCard.vue',
          consumerSourceLoc: { file: 'App.vue', line: 5, column: 3 },
          consumerVnodeProps: { title: { kind: 'literal', value: 'Hello' } },
        },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, ACME_CARD_INFERRED_UNVERIFIED]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      // Terminates via the unmanifested-parent path (trust gate makes
      // AcmeCard's rendering invisible), NOT by resolving AcmeCard's
      // `title` prop.
      expect(result.reason).toContain('AcmeCard')
      expect(result.reason).toContain('no rendering manifest')
    }
  })
})

describe('attribute() — bindings with exotic expressions route to LLM', () => {
  // Regression for codex P1 (binding classification) — make sure the
  // simple-identifier regex doesn't accept optional chaining, nullish
  // coalescing, or other expressions that aren't safe to treat as
  // pure refs.
  it.each([
    ['someRef', 'cross-file'],
    ['user.name', 'cross-file'],
    ['user.profile.displayName', 'cross-file'],
    ['x ?? "default"', 'llm'],
    ['x?.name', 'llm'],
    ['x + y', 'llm'],
    ['fn(x)', 'llm'],
    ['x[0]', 'llm'],
    ['cond ? a : b', 'llm'],
    ['`hello ${x}`', 'llm'],
    ['', 'llm'],
  ])('classifies binding %j as %s', (expression, expectedKind) => {
    const context: AttributionContext = {
      clickedElement: {
        selectorWithinMountRoot: 'input.ui-input',
        attributeName: 'placeholder',
        attributeValue: 'x',
      },
      componentChain: [
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 1, column: 1 },
          consumerVnodeProps: {
            placeholder: {
              kind: 'binding',
              value: 'x',
              expression,
              bindingLoc: { file: 'form.vue', line: 2, column: 1 },
            },
          },
        },
      ],
    }
    const result = attribute(context, makeLookup([KINPUT_MANIFEST]))
    expect(result.kind).toBe(expectedKind)
  })
})

// ──────────────── Case 3: nested-object prop + multi-level selector ────────────────

describe('attribute() — case 3: labelAttributes.info (nested-object / multi-level selector)', () => {
  // `<UiInput :label-attributes="{ info: '…' }">` renders the info text via
  // UiInput's internal UiLabel's tooltip. Two V1 limitations make this
  // refuse — and refusing cleanly (rather than mis-editing) is the
  // correct, validated behavior until the deferred features land:
  //
  //   1. The user clicks the info ICON, whose canonical single-token
  //      selector (`span.info-icon.kui-icon.tooltip-trigger-icon`, from the
  //      live ai-gateway-prototype) does NOT equal UiLabel's multi-level
  //      info hint selector `.label-tooltip [role="tooltip"]`. V1 matches
  //      selectors by exact equality, so no dom hint matches → refuse.
  //   2. Even if the selector matched, `labelAttributes.info` is a
  //      nested-object prop. The bridge ships only flat string/number/
  //      boolean props, and `classifyPropValue` resolves top-level props
  //      only — so there is no nested-object edit target in V1.
  //
  // Target outcome (deferred): a `direct`/`cross-file` edit into the object
  // literal's `info` key. Tracked in tasks/attribution-rewrite.md.
  it('refuses when the clicked info-icon selector matches no rendering hint', () => {
    const context: AttributionContext = {
      clickedElement: {
        // The rendered info-tooltip trigger icon inside UiInput's UiLabel.
        selectorWithinMountRoot: 'span.info-icon.kui-icon.tooltip-trigger-icon',
        textContent: '',
      },
      componentChain: [
        // Owning instance is the library-internal UiLabel (rendered by
        // UiInput); it has no user source position.
        { name: 'UiLabel', importPath: '@acme/design-system' },
        { name: 'UiInput', importPath: '@acme/design-system' },
        { name: 'AIGatewayProviderCreate' },
      ],
    }
    const result = attribute(context, makeLookup([KLABEL_MANIFEST, KINPUT_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      // The refusal points at the unmatched selector (limitation 1), which
      // is the actionable signal for "needs a multi-level matcher / a hint
      // for this element".
      expect(result.reason).toContain('No rendering hint matched')
      expect(result.reason).toContain('span.info-icon')
    }
  })
})

// ──────────────── Case 6 guard: v-for iteration bindings never become cross-file:ref ────────────────

describe('attribute() — case 6: v-for iteration variable bindings route off the cross-file:ref path', () => {
  // A binding like `:label="option.label"` inside `v-for="option in options"`
  // is a member-access expression that `isSimpleIdentifier` accepts — but
  // `option` is a loop variable with no standalone definition, so a
  // `cross-file: ref` result would point the edit at a non-existent
  // declaration. The `loopVariableRoots` signal (populated by the bridge
  // when v-for scope is detectable) keeps these off the deterministic path.

  function vForBindingContext(opts: {
    expression: string
    loopVariableRoots?: string[]
  }): AttributionContext {
    return {
      clickedElement: {
        selectorWithinMountRoot: 'input.ui-input',
        attributeName: 'placeholder',
        attributeValue: 'x',
      },
      componentChain: [
        {
          name: 'UiInput',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 1, column: 1 },
          consumerVnodeProps: {
            placeholder: {
              kind: 'binding',
              value: 'x',
              expression: opts.expression,
              bindingLoc: { file: 'form.vue', line: 2, column: 1 },
              ...(opts.loopVariableRoots
                ? { loopVariableRoots: opts.loopVariableRoots }
                : {}),
            },
          },
        },
      ],
    }
  }

  it('routes a v-for member-access binding to LLM, not cross-file:ref', () => {
    const result = attribute(
      vForBindingContext({ expression: 'option.label', loopVariableRoots: ['option'] }),
      makeLookup([KINPUT_MANIFEST]),
    )
    expect(result.kind).toBe('llm')
    if (result.kind === 'llm') {
      expect(result.reason).toContain('v-for')
      expect(result.reason).toContain('option')
    }
  })

  it('routes a bare v-for identifier binding to LLM too', () => {
    const result = attribute(
      vForBindingContext({ expression: 'item', loopVariableRoots: ['item'] }),
      makeLookup([KINPUT_MANIFEST]),
    )
    expect(result.kind).toBe('llm')
  })

  it('still classifies member-access as cross-file:ref when NOT a loop variable (no regression)', () => {
    // Same expression shape, but no loopVariableRoots signal → unchanged
    // behavior: a normal ref/member-access stays cross-file:ref.
    const result = attribute(
      vForBindingContext({ expression: 'user.name' }),
      makeLookup([KINPUT_MANIFEST]),
    )
    expect(result.kind).toBe('cross-file')
  })

  it('does not guard a binding whose root only coincidentally shares a substring', () => {
    // `optionLabel` (one identifier) must NOT be guarded by a loop var
    // named `option` — the root is `optionLabel`, not `option`.
    const result = attribute(
      vForBindingContext({ expression: 'optionLabel', loopVariableRoots: ['option'] }),
      makeLookup([KINPUT_MANIFEST]),
    )
    expect(result.kind).toBe('cross-file')
  })
})

// ──────────────── Phase 5 Task 3: click-time selector uniqueness ────────────────

describe('attribute() — soleMatchWithinMountRoot (click-time selector uniqueness)', () => {
  function slotContext(soleMatchWithinMountRoot: boolean | undefined): AttributionContext {
    return {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Additional base paths',
        ...(soleMatchWithinMountRoot !== undefined ? { soleMatchWithinMountRoot } : {}),
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
  }

  it('refuses (does not return direct) when a trusted dom hit matches but the flag is explicitly false', () => {
    const result = attribute(slotContext(false), makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('multiple elements')
      expect(result.reason.toLowerCase()).toContain('stale')
    }
  })

  it('keeps today\'s behavior (direct) when the flag is true', () => {
    const result = attribute(slotContext(true), makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('direct')
  })

  it('keeps today\'s behavior (direct) when the flag is undefined (older bridge / no mount root)', () => {
    const result = attribute(slotContext(undefined), makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('direct')
  })
})

// ──────────────── Phase 5 Task 3 adjudication: uneditable precedes ambiguity ────────────────

describe('attribute() — uneditable refusal precedes selector-ambiguity refusal', () => {
  const KLABEL_UNEDITABLE_MANIFEST: ComponentManifest = {
    ...KLABEL_MANIFEST,
    rendering: [
      {
        kind: 'dom',
        source: { kind: 'slot', name: 'default' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'uneditable',
        uneditableReason: 'UiLabel default slot is library-internal and not editable.',
      },
    ],
  }

  function slotContext(soleMatchWithinMountRoot: boolean | undefined): AttributionContext {
    return {
      clickedElement: {
        selectorWithinMountRoot: ':root',
        textContent: 'Additional base paths',
        ...(soleMatchWithinMountRoot !== undefined ? { soleMatchWithinMountRoot } : {}),
      },
      componentChain: [
        {
          name: 'UiLabel',
          importPath: '@acme/design-system',
          consumerSourceLoc: { file: 'form.vue', line: 70, column: 21 },
        },
        { name: 'AIGatewayModelCreate' },
      ],
    }
  }

  it('surfaces the uneditable reason (not the ambiguity reason) when a hint is BOTH uneditable AND ambiguous', () => {
    const result = attribute(slotContext(false), makeLookup([KLABEL_UNEDITABLE_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toBe('UiLabel default slot is library-internal and not editable.')
      expect(result.reason).not.toContain('multiple elements')
    }
  })

  it('surfaces the ambiguity reason when the hint is editable but ambiguous (ambiguous-only)', () => {
    // KLABEL_MANIFEST's default-slot hint is editability: 'literal' (not
    // uneditable), so this is the ambiguous-only case from the earlier
    // describe block, re-asserted here to pin against regression from the
    // ordering swap.
    const result = attribute(slotContext(false), makeLookup([KLABEL_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toContain('multiple elements')
    }
  })

  it('surfaces the uneditable reason, unchanged, when the hint is uneditable-only (not ambiguous)', () => {
    const result = attribute(slotContext(true), makeLookup([KLABEL_UNEDITABLE_MANIFEST]))
    expect(result.kind).toBe('refuse')
    if (result.kind === 'refuse') {
      expect(result.reason).toBe('UiLabel default slot is library-internal and not editable.')
    }
  })

  it('detectDrift still emits selector-ambiguous when the hint is BOTH uneditable AND ambiguous', () => {
    // attribute()'s result kind is 'refuse' either way in this case, but
    // detectDrift's selector-ambiguous rule doesn't branch on WHY attribute()
    // refused — it independently re-checks the same structural condition
    // (trusted dom hit found + soleMatchWithinMountRoot === false). Confirms
    // the ordering swap in attribute() doesn't silently drop this signal.
    const context = slotContext(false)
    const result = attribute(context, makeLookup([KLABEL_UNEDITABLE_MANIFEST]))
    expect(result.kind).toBe('refuse') // sanity: uneditable reason won inside attribute()

    const signals = detectDrift({
      context,
      result,
      owningManifest: KLABEL_UNEDITABLE_MANIFEST,
    })
    expect(signals).toContainEqual(
      expect.objectContaining({ kind: 'selector-ambiguous', component: 'UiLabel', detail: ':root' }),
    )
  })
})
