/**
 * Tests for the bounded shorthand → longhand expansion the cascade oracle uses.
 */
import { describe, expect, it } from 'vitest'
import {
  EXPANDABLE_SHORTHANDS,
  expandStyleDeclarations,
} from './style-shorthands'

describe('expandStyleDeclarations', () => {
  it('expands a single-value padding shorthand to its four longhands', () => {
    // `p-4` → `{ padding: '1rem' }`. The blind spot: a library rule declaring
    // only `padding-left` is never a candidate in the walk for `padding`.
    expect(expandStyleDeclarations({ padding: '1rem' })).toEqual([
      { property: 'padding-bottom', value: '1rem' },
      { property: 'padding-left', value: '1rem' },
      { property: 'padding-right', value: '1rem' },
      { property: 'padding-top', value: '1rem' },
    ])
  })

  it('drops the shorthand itself — it is fully represented by its longhands', () => {
    const props = expandStyleDeclarations({ margin: '0.5rem' }).map(
      (d) => d.property,
    )
    expect(props).not.toContain('margin')
    expect(props).toHaveLength(4)
  })

  it('expands gap to its two longhands', () => {
    expect(expandStyleDeclarations({ gap: '1rem' })).toEqual([
      { property: 'column-gap', value: '1rem' },
      { property: 'row-gap', value: '1rem' },
    ])
  })

  it('expands the border trio and border-radius', () => {
    const props = expandStyleDeclarations({
      'border-width': '1px',
      'border-style': 'solid',
      'border-color': '#ef4444',
      'border-radius': '9999px',
    }).map((d) => d.property)
    expect(props).toHaveLength(16)
    expect(props).toContain('border-top-width')
    expect(props).toContain('border-left-style')
    expect(props).toContain('border-bottom-color')
    expect(props).toContain('border-bottom-left-radius')
  })

  it('leaves a non-shorthand declaration untouched', () => {
    expect(expandStyleDeclarations({ 'background-color': '#ef4444' })).toEqual([
      { property: 'background-color', value: '#ef4444' },
    ])
  })

  it('sorts deterministically regardless of key insertion order', () => {
    const a = expandStyleDeclarations({ color: 'red', 'font-weight': '700' })
    const b = expandStyleDeclarations({ 'font-weight': '700', color: 'red' })
    expect(a).toEqual(b)
    expect(a.map((d) => d.property)).toEqual(['color', 'font-weight'])
  })

  // ── The refusals: each must degrade to today's behavior, never a wrong verdict.
  it('DECLINES to expand a multi-component shorthand (degrades, not guesses)', () => {
    // The box-model distribution rules are exactly the general shorthand
    // modelling this module refuses to own.
    expect(expandStyleDeclarations({ padding: '1rem 2rem' })).toEqual([
      { property: 'padding', value: '1rem 2rem' },
    ])
  })

  it('DECLINES to expand a var() shorthand — CSSOM serializes its longhands as empty', () => {
    // `border-[var(--brand)]` → `border-color: var(--brand)`. Expanding it would
    // make our OWN rule stop answering for `border-top-color` (a pending-
    // substitution value serializes as `''` per longhand), and the oracle would
    // report a perfectly good edit as overridden.
    expect(expandStyleDeclarations({ 'border-color': 'var(--brand)' })).toEqual([
      { property: 'border-color', value: 'var(--brand)' },
    ])
  })

  it('does not mistake a var() INSIDE a multi-value function for a plain value', () => {
    expect(
      expandStyleDeclarations({ 'border-color': 'rgb(var(--rgb) / 1)' }),
    ).toEqual([{ property: 'border-color', value: 'rgb(var(--rgb) / 1)' }])
  })

  it('counts a function as ONE component (rgb(1, 2, 3) is expandable)', () => {
    expect(
      expandStyleDeclarations({ 'border-color': 'rgb(239, 68, 68)' }).map(
        (d) => d.property,
      ),
    ).toHaveLength(4)
  })

  // ── Shorthand + its own longhand in one edit (`p-4 pl-2`).
  it('keeps an explicitly-set longhand in the set but drops its ambiguous value', () => {
    // Which value wins depends on their order inside the emitted rule body,
    // which is not modelled — so ownership is verified and the value is not.
    const out = expandStyleDeclarations({ padding: '1rem', 'padding-left': '0.5rem' })
    expect(out).toEqual([
      { property: 'padding-bottom', value: '1rem' },
      { property: 'padding-left' },
      { property: 'padding-right', value: '1rem' },
      { property: 'padding-top', value: '1rem' },
    ])
  })

  it('handles an empty declaration map', () => {
    expect(expandStyleDeclarations({})).toEqual([])
  })

  it('declares a non-empty longhand list for every shorthand in the map', () => {
    // Structural sanity only. The DRIFT gate — "the resolver has started emitting
    // a shorthand this map does not cover" — cannot live here: pinning
    // `Object.keys(EXPANDABLE_SHORTHANDS)` against a hardcoded copy of itself
    // pins the map to itself and passes unchanged when a new emission appears. It
    // lives next to the resolver instead, driving real classes through
    // `resolveTailwindClass`:
    // `src/components/editor/tailwind-declarations.test.ts` § "cascade-oracle
    // drift gate".
    const seen = new Set<string>()
    for (const [shorthand, longhands] of Object.entries(EXPANDABLE_SHORTHANDS)) {
      expect(longhands.length, shorthand).toBeGreaterThan(1)
      for (const longhand of longhands) {
        // A longhand must not itself be a shorthand in the map, and must not be
        // claimed by two shorthands — either would make expansion order matter.
        expect(EXPANDABLE_SHORTHANDS[longhand], longhand).toBeUndefined()
        expect(seen.has(longhand), longhand).toBe(false)
        seen.add(longhand)
      }
    }
  })
})
