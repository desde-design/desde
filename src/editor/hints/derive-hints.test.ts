import { describe, expect, it, vi } from 'vitest'
import {
  buildProbeMountSpec,
  deriveHintsForComponent,
  dropCollidingHints,
  isStringProp,
  resolveMatch,
  type ProbeFn,
} from './derive-hints'
import type { ComponentManifest, ComponentPropManifest, RenderingHint } from '../core/manifest'
import type { ProbeObservation, ProbeObservationMatch } from './probe-driver'

function prop(over: Partial<ComponentPropManifest> = {}): ComponentPropManifest {
  return {
    name: 'label',
    type: 'string',
    required: false,
    control: { kind: 'text' },
    ...over,
  }
}

function manifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: 'acme-ds:UiButton',
    name: 'UiButton',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    props: [],
    ...over,
  }
}

describe('isStringProp', () => {
  it('accepts control.kind "text" only', () => {
    expect(isStringProp(prop({ control: { kind: 'text' } }))).toBe(true)
    expect(isStringProp(prop({ control: { kind: 'finite-choice' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'token' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'boolean' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'number' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'function' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'object' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'array' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'slot' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'event' } }))).toBe(false)
    expect(isStringProp(prop({ control: { kind: 'unknown' } }))).toBe(false)
  })
})

describe('buildProbeMountSpec', () => {
  it('builds one sentinel per string prop (index order) plus a trailing slot sentinel', () => {
    const m = manifest({
      props: [
        prop({ name: 'label', control: { kind: 'text' } }),
        prop({ name: 'size', control: { kind: 'finite-choice' } }),
        prop({ name: 'placeholder', control: { kind: 'text' } }),
      ],
    })
    const spec = buildProbeMountSpec(m, 'abc123')
    expect(spec.importPath).toBe('@acme/design-system')
    expect(spec.exportName).toBe('UiButton')
    expect(spec.props).toEqual({
      label: 'PT_SENTINEL_0_abc123',
      placeholder: 'PT_SENTINEL_1_abc123',
    })
    // Slot sentinel index continues after the string props, not the raw prop count.
    expect(spec.slotText).toBe('PT_SENTINEL_2_abc123')
  })

  it('still probes the default slot when there are zero string props', () => {
    const m = manifest({ props: [prop({ name: 'disabled', control: { kind: 'boolean' } })] })
    const spec = buildProbeMountSpec(m, 'xyz')
    expect(spec.props).toEqual({})
    expect(spec.slotText).toBe('PT_SENTINEL_0_xyz')
  })

  it('two different components with the same suffix never collide (index-based, per-mount)', () => {
    const a = buildProbeMountSpec(manifest({ props: [prop({ name: 'label' })] }), 'S')
    const b = buildProbeMountSpec(
      manifest({ name: 'UiInput', props: [prop({ name: 'placeholder' })] }),
      'S',
    )
    expect(a.props.label).toBe(b.props.placeholder) // same index+suffix -> same string, by design
    // ...but that's fine: probes run one mount at a time (Task 2's ProbePage
    // lifecycle), so there's never cross-component sentinel bleed within a
    // single evaluate() call.
  })
})

describe('resolveMatch', () => {
  const m = (selector: string, field: ProbeObservationMatch['field'] = 'textContent') => ({
    selector,
    field,
  })

  it('returns null for no matches', () => {
    expect(resolveMatch([])).toBeNull()
  })

  it('returns the single match unchanged', () => {
    expect(resolveMatch([m('.foo')])).toEqual(m('.foo'))
  })

  it('prefers the descendant over :root when both matched (textContent rollup case)', () => {
    const root = m(':root')
    const descendant = m('label.title')
    expect(resolveMatch([root, descendant])).toEqual(descendant)
    expect(resolveMatch([descendant, root])).toEqual(descendant)
  })

  it('picks the one distinct non-root element even with two field matches on it', () => {
    const root = m(':root')
    const textMatch = m('span.badge', 'textContent')
    const attrMatch = m('span.badge', 'attribute')
    const resolved = resolveMatch([root, textMatch, attrMatch])
    expect(resolved).toEqual(textMatch) // first non-root match wins
  })

  it('is ambiguous (null) when two DISTINCT non-root elements both matched', () => {
    expect(resolveMatch([m('.a'), m('.b')])).toBeNull()
    expect(resolveMatch([m(':root'), m('.a'), m('.b')])).toBeNull()
  })

  it('falls back to the first match when every match is at :root', () => {
    const textAtRoot = m(':root', 'textContent')
    const attrAtRoot = m(':root', 'attribute')
    expect(resolveMatch([textAtRoot, attrAtRoot])).toEqual(textAtRoot)
  })
})

describe('deriveHintsForComponent', () => {
  it('refuses (ok:false) when the manifest has no importPath', async () => {
    const probe: ProbeFn = vi.fn()
    const result = await deriveHintsForComponent(manifest({ importPath: undefined }), probe, 'S')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/importPath/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('emits a generated+verified dom hint per matched sentinel, source echoed from the observation', async () => {
    const m = manifest({
      props: [
        prop({ name: 'label', control: { kind: 'text' } }),
        prop({ name: 'placeholder', control: { kind: 'text' } }),
      ],
    })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [{ selector: ':root', field: 'textContent' }],
        },
        {
          sentinel: 'PT_SENTINEL_1_S',
          propOrSlot: { kind: 'prop', name: 'placeholder' },
          matches: [{ selector: 'input', field: 'attribute', attribute: 'placeholder' }],
        },
        {
          // default slot — no match found in the rendered DOM.
          sentinel: 'PT_SENTINEL_2_S',
          propOrSlot: { kind: 'slot', name: 'default' },
          matches: [],
        },
      ],
    }
    const probe: ProbeFn = vi.fn(async () => observation)

    const result = await deriveHintsForComponent(m, probe, 'S')
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([
      {
        kind: 'dom',
        source: { kind: 'prop', name: 'label' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'literal',
        provenance: 'generated',
        verified: true,
      },
      {
        kind: 'dom',
        source: { kind: 'prop', name: 'placeholder' },
        domTarget: { selector: 'input', field: 'attribute', attribute: 'placeholder' },
        editability: 'literal',
        provenance: 'generated',
        verified: true,
      },
    ])
    expect(probe).toHaveBeenCalledWith({
      importPath: '@acme/design-system',
      exportName: 'UiButton',
      props: { label: 'PT_SENTINEL_0_S', placeholder: 'PT_SENTINEL_1_S' },
      slotText: 'PT_SENTINEL_2_S',
    })
  })

  it('resolves an ambiguous multi-match finding to no hint (silent skip)', async () => {
    const m = manifest({ props: [prop({ name: 'label' })] })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [
            { selector: '.a', field: 'textContent' },
            { selector: '.b', field: 'textContent' },
          ],
        },
      ],
    }
    const result = await deriveHintsForComponent(m, async () => observation, 'S')
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([])
  })

  it('surfaces a mount failure as ok:false with the observation reason', async () => {
    const m = manifest()
    const probe: ProbeFn = vi.fn(async () => ({
      ok: false,
      reason: 'component failed to mount: TypeError in setup()',
      findings: [],
    }))
    const result = await deriveHintsForComponent(m, probe, 'S')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/TypeError/)
    expect(result.hints).toEqual([])
  })

  it('catches a probe that throws and reports it as a failure, never rejecting', async () => {
    const m = manifest()
    const probe: ProbeFn = vi.fn(async () => {
      throw new Error('page crashed')
    })
    const result = await deriveHintsForComponent(m, probe, 'S')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/page crashed/)
  })

  it('C1: drops BOTH hints when two DIFFERENT props/slots resolve to the identical selector (cross-prop collision)', async () => {
    // Two sibling `div.msg` elements: prop "first" and prop "second" each
    // independently resolve to a distinct-but-identically-selectored
    // element. Emitting both as verified hints would let attribution's
    // findDomHit silently pick whichever comes first at click time.
    const m = manifest({
      props: [prop({ name: 'first' }), prop({ name: 'second' })],
    })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'first' },
          matches: [{ selector: 'div.msg', field: 'textContent' }],
        },
        {
          sentinel: 'PT_SENTINEL_1_S',
          propOrSlot: { kind: 'prop', name: 'second' },
          matches: [{ selector: 'div.msg', field: 'textContent' }],
        },
        {
          sentinel: 'PT_SENTINEL_2_S',
          propOrSlot: { kind: 'slot', name: 'default' },
          matches: [],
        },
      ],
    }
    const result = await deriveHintsForComponent(m, async () => observation, 'S')
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([])
  })

  it('emits a kind:"forward" hint (not dom) when the observation reports the match was owned by a child component', async () => {
    // KInput forwards its `label` prop into KLabel's default slot — this is
    // the measured KInput/KLabel case documented in probe-driver.ts's
    // `ProbeOwnership` doc comment. A forward hint is what makes
    // `walkForward` (`src/editor/attribution/attribute.ts`) able to hop from
    // a click on KLabel's DOM back up to KInput's `label` prop.
    const m = manifest({ props: [prop({ name: 'label' })] })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [
            {
              selector: 'label.k-label',
              field: 'textContent',
              ownedByChild: { component: 'KLabel', childSlot: 'default' },
            },
          ],
        },
      ],
    }
    const result = await deriveHintsForComponent(m, async () => observation, 'S')
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([
      {
        kind: 'forward',
        source: { kind: 'prop', name: 'label' },
        forwardTo: { component: 'KLabel', childSlot: 'default' },
        provenance: 'generated',
        verified: true,
      },
    ])
  })

  it('emits a kind:"dom" hint (not forward) when the match has no ownedByChild — the component rendered it itself', async () => {
    const m = manifest({ props: [prop({ name: 'label' })] })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [{ selector: ':root', field: 'textContent' }],
        },
      ],
    }
    const result = await deriveHintsForComponent(m, async () => observation, 'S')
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([
      {
        kind: 'dom',
        source: { kind: 'prop', name: 'label' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'literal',
        provenance: 'generated',
        verified: true,
      },
    ])
  })

  it('a forward hint carries provenance:"generated" + verified:true and NO domTarget', async () => {
    // Both hint kinds share `RenderingHintProvenance`, but only `kind:'dom'`
    // hints carry a `domTarget` — see `RenderingHint`'s union in
    // `src/editor/core/manifest.ts`. This pins the RUNTIME shape (not just
    // the type) so a future branch can't leak a stale domTarget through.
    const m = manifest({ props: [prop({ name: 'icon' })] })
    const observation: ProbeObservation = {
      ok: true,
      findings: [
        {
          sentinel: 'PT_SENTINEL_0_S',
          propOrSlot: { kind: 'prop', name: 'icon' },
          matches: [
            {
              selector: 'span.chip',
              field: 'textContent',
              ownedByChild: { component: 'KChip', childProp: 'text' },
            },
          ],
        },
      ],
    }
    const result = await deriveHintsForComponent(m, async () => observation, 'S')
    expect(result.hints).toHaveLength(1)
    const hint = result.hints[0]
    expect(hint.kind).toBe('forward')
    expect(hint.provenance).toBe('generated')
    expect(hint.verified).toBe(true)
    expect(hint).not.toHaveProperty('domTarget')
    if (hint.kind === 'forward') {
      expect(hint.forwardTo).toEqual({ component: 'KChip', childProp: 'text' })
    }
  })
})

describe('dropCollidingHints', () => {
  function domHint(over: Partial<Extract<RenderingHint, { kind: 'dom' }>> = {}): RenderingHint {
    return {
      kind: 'dom',
      source: { kind: 'prop', name: 'label' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
      provenance: 'generated',
      verified: true,
      ...over,
    }
  }

  it('passes through hints at distinct sites unchanged', () => {
    const a = domHint({ source: { kind: 'prop', name: 'a' }, domTarget: { selector: '.a', field: 'textContent' } })
    const b = domHint({ source: { kind: 'prop', name: 'b' }, domTarget: { selector: '.b', field: 'textContent' } })
    expect(dropCollidingHints([a, b])).toEqual([a, b])
  })

  it('drops BOTH hints when two distinct sources claim the identical (selector, field, attribute) site', () => {
    const a = domHint({ source: { kind: 'prop', name: 'a' }, domTarget: { selector: '.msg', field: 'textContent' } })
    const b = domHint({ source: { kind: 'prop', name: 'b' }, domTarget: { selector: '.msg', field: 'textContent' } })
    expect(dropCollidingHints([a, b])).toEqual([])
  })

  it('does not treat matching selector but different attribute as a collision', () => {
    const a = domHint({
      source: { kind: 'prop', name: 'a' },
      domTarget: { selector: 'input', field: 'attribute', attribute: 'placeholder' },
    })
    const b = domHint({
      source: { kind: 'prop', name: 'b' },
      domTarget: { selector: 'input', field: 'attribute', attribute: 'aria-label' },
    })
    expect(dropCollidingHints([a, b])).toEqual([a, b])
  })

  it('collapses a same-source duplicate at the same site to one entry (unchanged dedupe behavior)', () => {
    const a = domHint({ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } })
    const duplicate = domHint({ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } })
    expect(dropCollidingHints([a, duplicate])).toEqual([a])
  })

  it('leaves non-dom (forward) hints untouched', () => {
    const forward: RenderingHint = {
      kind: 'forward',
      source: { kind: 'prop', name: 'label' },
      forwardTo: { component: 'UiLabel', childSlot: 'default' },
    }
    expect(dropCollidingHints([forward])).toEqual([forward])
  })

  function forwardHint(
    over: Partial<Extract<RenderingHint, { kind: 'forward' }>> = {},
  ): RenderingHint {
    return {
      kind: 'forward',
      source: { kind: 'prop', name: 'label' },
      forwardTo: { component: 'KLabel', childSlot: 'default' },
      provenance: 'generated',
      verified: true,
      ...over,
    }
  }

  it('drops BOTH forward hints when two distinct sources forward to the identical (component, childSlot) destination', () => {
    const a = forwardHint({ source: { kind: 'prop', name: 'label' } })
    const b = forwardHint({ source: { kind: 'prop', name: 'title' } })
    expect(dropCollidingHints([a, b])).toEqual([])
  })

  it('collapses a same-source duplicate forward hint at the same destination to one entry', () => {
    const a = forwardHint()
    const duplicate = forwardHint()
    expect(dropCollidingHints([a, duplicate])).toEqual([a])
  })

  it('keeps both forward hints when they forward to different children (distinct destinations)', () => {
    const a = forwardHint({
      source: { kind: 'prop', name: 'label' },
      forwardTo: { component: 'KLabel', childSlot: 'default' },
    })
    const b = forwardHint({
      source: { kind: 'prop', name: 'icon' },
      forwardTo: { component: 'KIcon', childProp: 'name' },
    })
    expect(dropCollidingHints([a, b])).toEqual([a, b])
  })

  it('never treats a dom hint and a forward hint as colliding, even with the same source name', () => {
    // siteKey prefixes dom/forward keys distinctly ('dom\0...' vs 'fwd\0...')
    // precisely so this can't happen — a dom hint's selector and a forward
    // hint's destination are never comparable.
    const dom = domHint({ source: { kind: 'prop', name: 'label' } })
    const forward = forwardHint({ source: { kind: 'prop', name: 'label' } })
    expect(dropCollidingHints([dom, forward])).toEqual([dom, forward])
  })
})
