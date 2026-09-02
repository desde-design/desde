/**
 * Tests for the pure cascade-ownership evaluator. No DOM, no bridge — every
 * input is a plain `StyleOrigin` fixture like the bridge's walker returns.
 */
import { describe, expect, it } from 'vitest'
import type { StyleOrigin } from '@/types/bridge'
import type { CascadeSinglePropertySpec } from './cascade-outcome'
import {
  cssValueCarriesValue,
  declarationCarriesValue,
  declarationIsImportant,
  describeCascadeWinner,
  evaluateCascadeOutcome,
  evaluateCascadeVerification,
  wouldLoseToImportant,
} from './cascade-outcome'

const FIRST_PARTY = { href: 'http://x/src/App.vue' }
const LIBRARY = {
  href: 'http://x/node_modules/@acme/design-system/dist/style.css',
  package: '@acme/design-system',
}

function origin(over: Partial<StyleOrigin> = {}): StyleOrigin {
  return {
    property: 'background-color',
    computedValue: 'rgb(247, 247, 247)',
    winningRule: null,
    varChain: [],
    ...over,
  }
}

function rule(over: Partial<NonNullable<StyleOrigin['winningRule']>> = {}) {
  return {
    selector: '.ui-card',
    stylesheet: LIBRARY,
    declaration: 'background-color: #f7f7f7',
    specificity: [0, 1, 0] as [number, number, number],
    ...over,
  }
}

describe('declarationIsImportant', () => {
  it('detects the !important flag the walker preserves', () => {
    expect(declarationIsImportant('color: red !important')).toBe(true)
    expect(declarationIsImportant('color: red ! important')).toBe(true)
    expect(declarationIsImportant('color: red')).toBe(false)
  })

  it('does not false-positive on a value containing the word', () => {
    expect(declarationIsImportant('content: "important"')).toBe(false)
  })
})

describe('evaluateCascadeOutcome — pt-src owner (Vue scoped-css-override)', () => {
  it('wins when the winning selector carries our data-desde-src anchor', () => {
    const o = origin({
      winningRule: rule({
        selector: '[data-desde-src="src/App.vue:12:4"][data-v-abc123] .ui-card-title',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: red !important',
      }),
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: true })
  })

  it('reports overridden, naming the library winner, when a foreign rule wins', () => {
    const o = origin({ winningRule: rule({ declaration: 'background-color: #f7f7f7 !important' }) })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.ui-card',
      winnerPackage: '@acme/design-system',
      winnerImportant: true,
    })
  })

  it('reports no-rule when nothing declares the property', () => {
    expect(
      evaluateCascadeOutcome(origin(), { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: false, reason: 'no-rule' })
  })

  it('reports overridden when an inline !important declaration outranks our rule', () => {
    const o = origin({
      winningRule: rule({ selector: '[data-desde-src="src/App.vue:12:4"]', stylesheet: FIRST_PARTY }),
      inline: { value: 'blue', important: true },
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: true,
    })
  })

  it('treats a missing origin as no-rule rather than throwing', () => {
    expect(
      evaluateCascadeOutcome(undefined, { property: 'color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: false, reason: 'no-rule' })
  })
})

// codex P1 (false pass): ownership is unchanged when the SAME rule already owned
// the property, so a repeat edit (pick red, then pick blue) passed on the very
// first poll even when the DOM still showed red. `expectedDeclarationValue` adds
// the value dimension — authored-vs-authored, never a computed comparison.
describe('evaluateCascadeOutcome — pt-src value dimension (codex P1)', () => {
  const OUR_SELECTOR = '[data-desde-src="src/App.vue:12:4"][data-v-abc123]'
  const ours = (declaration: string) =>
    origin({ winningRule: rule({ selector: OUR_SELECTOR, stylesheet: FIRST_PARTY, declaration }) })

  it('wins when our rule carries the expected value', () => {
    expect(
      evaluateCascadeOutcome(ours('background-color: rgb(59, 130, 246) !important'), {
        property: 'background-color',
        owner: { kind: 'pt-src' },
        expectedDeclarationValue: '#3b82f6',
      }),
    ).toEqual({ won: true })
  })

  it('is NOT won when our rule still carries the previous value', () => {
    // The repeat-edit failure: red is still in the declaration, blue was asked
    // for. Ownership is identical either way, so only the value can tell.
    expect(
      evaluateCascadeOutcome(ours('background-color: rgb(239, 68, 68) !important'), {
        property: 'background-color',
        owner: { kind: 'pt-src' },
        expectedDeclarationValue: '#3b82f6',
      }),
    ).toEqual({ won: false, reason: 'stale-value', winnerSelector: OUR_SELECTOR })
  })

  it('reports stale-value, never overridden — nobody outranked us', () => {
    // `overridden` maps to `css-overridden`, whose remedy is "escalate the
    // scope". Advising that here would send the user after a rule that doesn't
    // exist: our own rule owns the property.
    const out = evaluateCascadeOutcome(ours('color: rgb(1, 1, 1) !important'), {
      property: 'color',
      owner: { kind: 'pt-src' },
      expectedDeclarationValue: '#222222',
    })
    expect(out.won).toBe(false)
    expect(out.won === false && out.reason).toBe('stale-value')
    expect(out.won === false && out.reason).not.toBe('overridden')
  })

  it('is ownership-only when no expected value is supplied (unchanged behavior)', () => {
    expect(
      evaluateCascadeOutcome(ours('background-color: rgb(239, 68, 68) !important'), {
        property: 'background-color',
        owner: { kind: 'pt-src' },
      }),
    ).toEqual({ won: true })
  })

  it('still reports overridden (not stale-value) when a foreign rule wins', () => {
    // The value dimension must not swallow a genuine cascade loss.
    expect(
      evaluateCascadeOutcome(origin({ winningRule: rule() }), {
        property: 'background-color',
        owner: { kind: 'pt-src' },
        expectedDeclarationValue: '#3b82f6',
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.ui-card',
      winnerPackage: '@acme/design-system',
      winnerImportant: false,
    })
  })

})

// The `classes` owner is OWNERSHIP-ONLY, deliberately. Phase 2 briefly gave it the
// value dimension (compare against a plain literal, decline on a `var()`), which
// was wrong in kind: the declaration belongs to Tailwind and we hold only a MODEL
// of the utility, so a mismatch says our model drifted, not that the edit failed.
// The `var()` decline did not bound it either — Tailwind v3 emits plain literals
// for every customizable scale, so a customized theme produces a confident,
// wrongly-worded `stale-value` on an edit that landed.
describe('evaluateCascadeOutcome — classes owner ignores an expected value', () => {
  const utility = (declaration: string, selector = '.border-2') =>
    origin({ winningRule: rule({ selector, stylesheet: FIRST_PARTY, declaration }) })
  const spec = (expectedDeclarationValue?: string): CascadeSinglePropertySpec => ({
    property: 'border-width',
    owner: { kind: 'classes', classes: ['border-2'] },
    ...(expectedDeclarationValue ? { expectedDeclarationValue } : {}),
  })

  it('wins when the utility declares the literal we resolved', () => {
    expect(evaluateCascadeOutcome(utility('border-width: 2px'), spec('2px'))).toEqual({
      won: true,
    })
  })

  it('STILL wins when the utility declares a different literal (our model drifted)', () => {
    // The false alarm this closes: a v3 substrate with
    // `theme.extend.spacing['4'] = '1.125rem'` emits `.p-4 { padding: 1.125rem }`
    // while our resolver models `1rem`. Ownership is intact and the edit landed;
    // reporting `stale-value` would claim OUR declaration is stale — it is not
    // ours, and nothing is stale.
    expect(evaluateCascadeOutcome(utility('border-width: 1px'), spec('2px'))).toEqual({
      won: true,
    })
  })

  it('wins regardless of whether the utility routes through a var()', () => {
    for (const declaration of [
      'background-color: var(--color-red-500)',
      'background-color: rgb(239 68 68 / var(--tw-bg-opacity))',
      'border-style: var(--tw-border-style)',
      'background-color: #ef4444',
    ]) {
      expect(
        evaluateCascadeOutcome(utility(declaration, '.bg-red-500'), {
          property: 'background-color',
          owner: { kind: 'classes', classes: ['bg-red-500'] },
          expectedDeclarationValue: '#3b82f6',
        }),
      ).toEqual({ won: true })
    }
  })

  it('is ownership-only when no expected value is supplied', () => {
    expect(evaluateCascadeOutcome(utility('border-width: 1px'), spec())).toEqual({
      won: true,
    })
  })

  it('still reports overridden when a foreign rule wins', () => {
    // Dropping the value dimension must not weaken the ownership verdict.
    expect(evaluateCascadeOutcome(origin({ winningRule: rule() }), spec('2px'))).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.ui-card',
      winnerPackage: '@acme/design-system',
      winnerImportant: false,
    })
  })
})

// codex P2 (false pass, same class as P1): the `inline` owner passed on the mere
// PRESENCE of an inline declaration. A repeat edit (red → blue) or a stale HMR
// leaves the previous `style={{}}` declaration in place, so presence was
// unchanged while the DOM still rendered the old value. `origin.inline.value` is
// read off the element via CSSOM (`readInline`), i.e. the same serialized form
// `canonicalizeCssValue` normalizes — so this is the authored-vs-specified
// comparison, not the computed one the oracle avoids.
describe('evaluateCascadeOutcome — inline value dimension (codex P2)', () => {
  const inlineSpec = (expectedDeclarationValue?: string): CascadeSinglePropertySpec => ({
    property: 'background-color',
    owner: { kind: 'inline' },
    ...(expectedDeclarationValue ? { expectedDeclarationValue } : {}),
  })

  it('wins when the inline declaration carries the expected value', () => {
    // Authored `#3b82f6`, read back as the rgb() form CSSOM reports.
    expect(
      evaluateCascadeOutcome(
        origin({ inline: { value: 'rgb(59, 130, 246)', important: false } }),
        inlineSpec('#3b82f6'),
      ),
    ).toEqual({ won: true })
  })

  it('is NOT won when the inline declaration still carries the previous value', () => {
    // THE FIX: pre-P2 this returned `{ won: true }` on presence alone.
    expect(
      evaluateCascadeOutcome(
        origin({ inline: { value: 'rgb(239, 68, 68)', important: false } }),
        inlineSpec('#3b82f6'),
      ),
    ).toEqual({ won: false, reason: 'stale-value', winnerSelector: 'inline style' })
  })

  it('reports stale-value, never overridden — nobody outranked us', () => {
    // `overridden` maps to `css-overridden`, whose remedy is "escalate the
    // scope". Wrong advice here: our own inline declaration owns the property.
    const out = evaluateCascadeOutcome(
      origin({ inline: { value: 'rgb(1, 1, 1)', important: false } }),
      { property: 'color', owner: { kind: 'inline' }, expectedDeclarationValue: '#222222' },
    )
    expect(out.won).toBe(false)
    expect(out.won === false && out.reason).toBe('stale-value')
    expect(out.won === false && out.reason).not.toBe('overridden')
  })

  it('declines to compare when either side is un-canonicalizable — ownership decides', () => {
    // `oklch()` / `color-mix()` re-serialize in ways this module does not model,
    // so a mismatch there is not evidence of staleness. Fail SAFE: ownership
    // alone decides, exactly as before P2.
    expect(
      evaluateCascadeOutcome(
        origin({ inline: { value: 'rgb(59, 130, 246)', important: false } }),
        inlineSpec('oklch(0.6 0.2 250)'),
      ),
    ).toEqual({ won: true })
    expect(
      evaluateCascadeOutcome(
        origin({ inline: { value: 'color-mix(in srgb, red, blue)', important: false } }),
        inlineSpec('#3b82f6'),
      ),
    ).toEqual({ won: true })
  })

  it('is ownership-only when no expected value is supplied (unchanged behavior)', () => {
    expect(
      evaluateCascadeOutcome(
        origin({ inline: { value: 'rgb(239, 68, 68)', important: false } }),
        inlineSpec(),
      ),
    ).toEqual({ won: true })
  })

  it('still reports overridden (not stale-value) when an !important rule outranks us', () => {
    // The value dimension must not swallow a genuine cascade loss, and the
    // override diagnosis must keep precedence over the value one.
    expect(
      evaluateCascadeOutcome(
        origin({
          inline: { value: 'rgb(239, 68, 68)', important: false },
          winningRule: rule({ declaration: 'background-color: #f7f7f7 !important' }),
        }),
        inlineSpec('#3b82f6'),
      ),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.ui-card',
      winnerPackage: '@acme/design-system',
      winnerImportant: true,
    })
  })

  it('still wins on an INHERITED property when the value matches', () => {
    // `inherited` means nothing on the element authored a stylesheet
    // declaration — our inline one renders regardless. The value dimension must
    // not disturb that (it would false-fail every React inline edit of an
    // inherited property).
    expect(
      evaluateCascadeOutcome(
        origin({
          property: 'color',
          inherited: true,
          inline: { value: 'rgb(59, 130, 246)', important: false },
          winningRule: rule({ selector: '.parent', declaration: 'color: #111 !important' }),
        }),
        { property: 'color', owner: { kind: 'inline' }, expectedDeclarationValue: '#3b82f6' },
      ),
    ).toEqual({ won: true })
  })

  it('reports no-rule (not stale-value) when there is no inline declaration at all', () => {
    expect(
      evaluateCascadeOutcome(origin(), inlineSpec('#3b82f6')),
    ).toEqual({ won: false, reason: 'no-rule' })
  })
})

// The bare-value comparison every value-verified owner routes through. The
// `inline` owner hands it `origin.inline.value` directly (no `property:` prefix
// to strip), so it is tested on its own as well as through
// `declarationCarriesValue`.
describe('cssValueCarriesValue', () => {
  it('compares a bare value with no property prefix', () => {
    expect(cssValueCarriesValue('rgb(239, 68, 68)', '#ef4444')).toBe(true)
    expect(cssValueCarriesValue('rgb(239, 68, 68)', '#3b82f6')).toBe(false)
    expect(cssValueCarriesValue('1rem', '1rem')).toBe(true)
  })

  it('does not mis-parse a colon inside the value as a property separator', () => {
    // The reason the inline owner uses this helper rather than
    // `declarationCarriesValue`: a bare `url(...)` value carries a colon.
    expect(cssValueCarriesValue('url(http://x/a.png)', 'url(http://x/a.png)')).toBe(true)
  })

  it('DECLINES (returns true) when the ACTUAL side is un-canonicalizable', () => {
    // Fail safe in both directions: an unmodelled form on either side means the
    // comparison carries no information, so it must not manufacture a miss.
    expect(cssValueCarriesValue('color-mix(in srgb, red, blue)', '#3b82f6')).toBe(true)
    expect(cssValueCarriesValue('oklch(0.6 0.2 250)', '#3b82f6')).toBe(true)
    expect(cssValueCarriesValue('rgb(1, 2, 3)', 'hsl(0 100% 50%)')).toBe(true)
    expect(cssValueCarriesValue('rgb(1, 2, 3)', '')).toBe(true)
  })
})

// The declaration the walker reports is CSSOM-serialized
// (`rule.style.getPropertyValue`), NOT raw stylesheet text: measured in real
// Chromium, `#ef4444` comes back as `rgb(239, 68, 68)`. A naive substring test
// would therefore fail EVERY hex colour edit — the exact false-failure mode this
// canonicalization exists to prevent.
describe('declarationCarriesValue', () => {
  it('matches an authored hex against the rgb() form CSSOM reports', () => {
    expect(declarationCarriesValue('background-color: rgb(239, 68, 68)', '#ef4444')).toBe(true)
    expect(declarationCarriesValue('background-color: rgb(239, 68, 68)', '#EF4444')).toBe(true)
    expect(declarationCarriesValue('background-color: rgb(255, 0, 0)', '#f00')).toBe(true)
  })

  it('rejects a different colour', () => {
    expect(declarationCarriesValue('background-color: rgb(239, 68, 68)', '#3b82f6')).toBe(false)
  })

  it('tolerates the !important suffix the walker appends', () => {
    expect(
      declarationCarriesValue('background-color: rgb(239, 68, 68) !important', '#ef4444'),
    ).toBe(true)
  })

  it('normalizes alpha precision and drops a fully opaque alpha', () => {
    // Chromium reports 3 decimals for some 8-digit hex alphas, and collapses
    // `#rrggbbff` to rgb() — neither is worth replicating exactly, so both sides
    // are rounded to 2 decimals and opaque rgba() collapses to rgb().
    expect(declarationCarriesValue('color: rgba(255, 0, 0, 0.667)', '#f00a')).toBe(true)
    expect(declarationCarriesValue('color: rgb(239, 68, 68)', '#ef4444ff')).toBe(true)
    expect(declarationCarriesValue('color: rgba(239, 68, 68, 0.5)', '#ef444480')).toBe(true)
  })

  it('matches values that round-trip verbatim, and identifiers case-insensitively', () => {
    expect(declarationCarriesValue('padding: 1rem', '1rem')).toBe(true)
    expect(declarationCarriesValue('background-color: transparent', 'transparent')).toBe(true)
    expect(declarationCarriesValue('color: currentcolor', 'currentColor')).toBe(true)
    expect(declarationCarriesValue('color: var(--acme-color-text)', 'var(--acme-color-text)')).toBe(
      true,
    )
    expect(declarationCarriesValue('font-weight: 600', '600')).toBe(true)
    expect(declarationCarriesValue('font-weight: 600', '700')).toBe(false)
  })

  it('treats a zero length as equal with or without its unit', () => {
    expect(declarationCarriesValue('padding: 0px', '0')).toBe(true)
    expect(declarationCarriesValue('padding: 0', '0px')).toBe(true)
    expect(declarationCarriesValue('padding: 10px', '0')).toBe(false)
  })

  it('matches one component of a shorthand declaration', () => {
    expect(declarationCarriesValue('padding: 1rem 2rem', '2rem')).toBe(true)
    expect(declarationCarriesValue('margin: 0 auto', '0')).toBe(true)
    expect(declarationCarriesValue('padding: 1rem 2rem', '3rem')).toBe(false)
  })

  it('DECLINES (returns true) for value forms whose serialization it cannot model', () => {
    // `hsl(0 100% 50%)` comes back as `rgb(255, 0, 0)`; rather than false-fail a
    // good edit, the value check opts out and ownership decides. Fail safe.
    expect(declarationCarriesValue('color: rgb(255, 0, 0)', 'hsl(0 100% 50%)')).toBe(true)
    expect(declarationCarriesValue('width: 42px', 'calc(100% - 8px)')).toBe(true)
    expect(declarationCarriesValue('color: rgb(1, 2, 3)', '')).toBe(true)
  })
})

describe('evaluateCascadeOutcome — inline owner (React jsx-style inline mode)', () => {
  it('wins when the element carries the inline declaration', () => {
    const o = origin({ inline: { value: 'red', important: false } })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'inline' } }),
    ).toEqual({ won: true })
  })

  it('loses to an !important stylesheet rule even though inline is set', () => {
    const o = origin({
      inline: { value: 'red', important: false },
      winningRule: rule({ declaration: 'background-color: #f7f7f7 !important' }),
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'inline' } }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.ui-card',
      winnerPackage: '@acme/design-system',
      winnerImportant: true,
    })
  })

  it('reports no-rule when no inline declaration is present', () => {
    expect(
      evaluateCascadeOutcome(origin(), { property: 'color', owner: { kind: 'inline' } }),
    ).toEqual({ won: false, reason: 'no-rule' })
  })
})

describe('evaluateCascadeOutcome — classes owner (utility-class mode)', () => {
  it('wins when the winning selector is one of the classes we added', () => {
    const o = origin({
      winningRule: rule({ selector: '.bg-red-500', stylesheet: FIRST_PARTY }),
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-red-500', 'p-4'] },
      }),
    ).toEqual({ won: true })
  })

  it('matches a compound selector that includes our class', () => {
    const o = origin({
      winningRule: rule({ selector: '.card > .bg-red-500:hover', stylesheet: FIRST_PARTY }),
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-red-500'] },
      }),
    ).toEqual({ won: true })
  })

  it('does not match a class that is merely a prefix of the winner', () => {
    const o = origin({ winningRule: rule({ selector: '.bg-red-500-dark', stylesheet: FIRST_PARTY }) })
    const out = evaluateCascadeOutcome(o, {
      property: 'background-color',
      owner: { kind: 'classes', classes: ['bg-red-500'] },
    })
    expect(out.won).toBe(false)
  })

  // codex round 3, P2: Tailwind CSS-escapes any class name whose characters
  // are illegal in a bare identifier before emitting the selector — a
  // fractional utility (`w-1/2` → `.w-1\/2`), an arbitrary value
  // (`bg-[var(--token)]` → `.bg-\[var\(--token\)\]`), or a variant prefix
  // (`sm:hidden` → `.sm\:hidden`). The matcher must see through the escaping
  // or every such edit reports a false `overridden` — the worst outcome for
  // this feature, since it tells the user to escalate scope for an edit that
  // already won.
  it('matches a fractional utility class through its escaped slash', () => {
    const o = origin({ winningRule: rule({ selector: '.w-1\\/2', stylesheet: FIRST_PARTY }) })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'width',
        owner: { kind: 'classes', classes: ['w-1/2'] },
      }),
    ).toEqual({ won: true })
  })

  it('matches an arbitrary-value class through its escaped brackets and parens', () => {
    const o = origin({
      winningRule: rule({
        selector: '.bg-\\[var\\(--token\\)\\]',
        stylesheet: FIRST_PARTY,
      }),
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-[var(--token)]'] },
      }),
    ).toEqual({ won: true })
  })

  it('matches a variant-prefixed class through its escaped colon', () => {
    const o = origin({ winningRule: rule({ selector: '.sm\\:hidden', stylesheet: FIRST_PARTY }) })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'display',
        owner: { kind: 'classes', classes: ['sm:hidden'] },
      }),
    ).toEqual({ won: true })
  })

  it('matches a variant-prefixed class through a hex CSS escape', () => {
    // `\3a ` is the CSS hex escape for `:` (0x3a), with the trailing space as
    // the escape terminator (consumed, not part of the token) — an
    // equivalent, if less common, way tooling can emit the same selector as
    // the backslash form above.
    const o = origin({ winningRule: rule({ selector: '.sm\\3a hidden', stylesheet: FIRST_PARTY }) })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'display',
        owner: { kind: 'classes', classes: ['sm:hidden'] },
      }),
    ).toEqual({ won: true })
  })

  it('does not let an escaped delimiter inside one class fuse into a match for another', () => {
    // `.foo\.bar` is a SINGLE class literally named `foo.bar` (escaped dot),
    // not the compound selector `.foo.bar` (two classes `foo` and `bar`).
    // Unescaping the whole selector before searching would blur that
    // distinction; a search for `bar` alone must still miss.
    const o = origin({ winningRule: rule({ selector: '.foo\\.bar', stylesheet: FIRST_PARTY }) })
    const out = evaluateCascadeOutcome(o, {
      property: 'background-color',
      owner: { kind: 'classes', classes: ['bar'] },
    })
    expect(out.won).toBe(false)
  })
})

describe('evaluateCascadeOutcome — a normal inline declaration beats normal rules', () => {
  // Cascade order, ascending: normal rule → normal inline → important rule →
  // important inline. A `won: true` here while a normal inline actually renders
  // is the exact silent failure this module exists to catch.
  const normalInline = { value: 'blue', important: false }

  it('reports overridden for a token owner when a normal inline holds the property', () => {
    const o = origin({
      inline: normalInline,
      winningRule: rule({ selector: '.consumer', stylesheet: FIRST_PARTY }),
      varChain: [
        {
          name: '--brand-bg',
          value: '#fff',
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
      ],
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'token', token: '--brand-bg' },
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: false,
    })
  })

  it('reports overridden for a classes owner when a normal inline holds the property', () => {
    const o = origin({
      inline: normalInline,
      winningRule: rule({ selector: '.bg-red-500', stylesheet: FIRST_PARTY }),
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-red-500'] },
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: false,
    })
  })

  it('still wins for a pt-src owner, whose rule always carries !important', () => {
    const o = origin({
      inline: normalInline,
      winningRule: rule({
        selector: '[data-desde-src="src/App.vue:12:4"][data-v-abc123]',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: red !important',
      }),
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: true })
  })

  it('wins for a token owner when the var-using rule is itself !important', () => {
    const o = origin({
      inline: normalInline,
      winningRule: rule({
        selector: '.consumer',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: var(--brand-bg) !important',
      }),
      varChain: [
        {
          name: '--brand-bg',
          value: '#fff',
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
      ],
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'token', token: '--brand-bg' },
      }),
    ).toEqual({ won: true })
  })

  it('names the inline declaration, not the foreign rule, when both are present', () => {
    // Finding-2 regression guard: reporting `.ui-card` here would send the user
    // to escalate scope against a rule that is not what renders.
    const o = origin({ inline: normalInline, winningRule: rule() })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-red-500'] },
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: false,
    })
  })
})

describe('evaluateCascadeOutcome — token owner', () => {
  it('wins when the rendered value still flows through the patched token', () => {
    const o = origin({
      winningRule: rule(),
      varChain: [
        {
          name: '--acme-color-background-disabled',
          value: '#f7f7f7',
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
      ],
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'token', token: '--acme-color-background-disabled' },
      }),
    ).toEqual({ won: true })
  })

  it('reports overridden when the winning value no longer references the token', () => {
    const o = origin({ winningRule: rule({ selector: '.override', stylesheet: FIRST_PARTY }) })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'token', token: '--acme-color-background-disabled' },
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.override',
      winnerPackage: undefined,
      winnerImportant: false,
    })
  })
})

// codex R4 (false pass, third instance of the P1/P2 class): the `token` owner
// passed as soon as the var chain still CONTAINED the patched token — which a
// repeat token edit (#ef4444 → #3b82f6) or a stale HMR never changes, so
// verification reported a pass while the element still resolved through the old
// definition. `StyleVarChainEntry.value` is that definition read back by the
// walker, so the value IS available on the chain entry.
describe('evaluateCascadeOutcome — token value dimension (codex R4)', () => {
  const TOKEN = '--brand-bg'
  /** Our token still owns the property; `value` is its definition-site value. */
  const withToken = (value: string) =>
    origin({
      winningRule: rule({
        selector: '.consumer',
        stylesheet: FIRST_PARTY,
        declaration: `background-color: var(${TOKEN})`,
      }),
      varChain: [
        { name: TOKEN, value, definedAt: { selector: ':root', stylesheet: FIRST_PARTY } },
      ],
    })
  const tokenSpec = (expectedDeclarationValue?: string): CascadeSinglePropertySpec => ({
    property: 'background-color',
    owner: { kind: 'token', token: TOKEN },
    ...(expectedDeclarationValue ? { expectedDeclarationValue } : {}),
  })

  it('wins when the token definition carries the expected value', () => {
    // Custom properties are NOT type-parsed by CSSOM, so the definition reads
    // back verbatim as authored — canonicalization on both sides makes hex
    // spelling irrelevant either way.
    expect(evaluateCascadeOutcome(withToken('#3b82f6'), tokenSpec('#3b82f6'))).toEqual({
      won: true,
    })
    expect(evaluateCascadeOutcome(withToken('rgb(59, 130, 246)'), tokenSpec('#3b82f6'))).toEqual({
      won: true,
    })
  })

  it('is NOT won when the token definition still carries the previous value', () => {
    // THE FALSE PASS: the chain still contains `--brand-bg`, so ownership is
    // unchanged; only the definition's value can tell that blue never landed.
    expect(evaluateCascadeOutcome(withToken('#ef4444'), tokenSpec('#3b82f6'))).toEqual({
      won: false,
      reason: 'stale-value',
      winnerSelector: TOKEN,
    })
  })

  it('reports stale-value, never overridden — nobody outranked us', () => {
    // `overridden` maps to `css-overridden`, whose remedy is "escalate the
    // scope". Wrong advice here: our own token still owns the property, it
    // simply holds the old value.
    const out = evaluateCascadeOutcome(withToken('#ef4444'), tokenSpec('#3b82f6'))
    expect(out.won).toBe(false)
    expect(out.won === false && out.reason).toBe('stale-value')
    expect(out.won === false && out.reason).not.toBe('overridden')
  })

  it('DECLINES for a chained token definition — ownership alone decides', () => {
    // `--brand-bg: var(--red-500)`: the concrete value is a hop further down the
    // chain, so this entry can never carry the authored literal. `var` is in the
    // modelled-function set, so the shared predicate would compare and MISS —
    // reporting every good chained-token edit as stale. Declining is the
    // fail-safe.
    expect(evaluateCascadeOutcome(withToken('var(--red-500)'), tokenSpec('#3b82f6'))).toEqual({
      won: true,
    })
    expect(
      evaluateCascadeOutcome(withToken('var(--red-500, #ef4444)'), tokenSpec('#3b82f6')),
    ).toEqual({ won: true })
  })

  it('DECLINES for an un-canonicalizable value on either side', () => {
    // Same fail-safe as the other two owners: a function whose serialization
    // `canonicalizeCssValue` does not model must never manufacture a miss.
    expect(evaluateCascadeOutcome(withToken('#ef4444'), tokenSpec('oklch(0.7 0.1 250)'))).toEqual({
      won: true,
    })
    expect(
      evaluateCascadeOutcome(withToken('color-mix(in srgb, red, blue)'), tokenSpec('#3b82f6')),
    ).toEqual({ won: true })
  })

  it('DECLINES on an empty definition value — absent evidence, not a mismatch', () => {
    expect(evaluateCascadeOutcome(withToken('   '), tokenSpec('#3b82f6'))).toEqual({ won: true })
  })

  it('is ownership-only when no expected value is supplied (unchanged behavior)', () => {
    expect(evaluateCascadeOutcome(withToken('#ef4444'), tokenSpec())).toEqual({ won: true })
  })

  it('still reports overridden when the chain no longer references our token', () => {
    // The value dimension must not swallow a genuine cascade loss: the chain
    // lookup fails first, so the winner is named as before.
    expect(
      evaluateCascadeOutcome(
        origin({ winningRule: rule({ selector: '.override', stylesheet: FIRST_PARTY }) }),
        tokenSpec('#3b82f6'),
      ),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.override',
      winnerPackage: undefined,
      winnerImportant: false,
    })
  })

  it('matches the token entry by NAME, not by chain position', () => {
    // The owner names the ROOT the edit patched (`handleTokenStyleEdit` uses
    // `varChain[varChain.length - 1]`), so an alias hop ahead of it must not be
    // the one whose value gets compared.
    const o = origin({
      winningRule: rule({
        selector: '.consumer',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: var(--alias)',
      }),
      varChain: [
        {
          name: '--alias',
          value: `var(${TOKEN})`,
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
        { name: TOKEN, value: '#ef4444', definedAt: { selector: ':root', stylesheet: FIRST_PARTY } },
      ],
    })
    expect(evaluateCascadeOutcome(o, tokenSpec('#3b82f6'))).toEqual({
      won: false,
      reason: 'stale-value',
      winnerSelector: TOKEN,
    })
    expect(evaluateCascadeOutcome(o, tokenSpec('#ef4444'))).toEqual({ won: true })
  })

  it('still wins through an INHERITED origin when the definition matches', () => {
    // The token owner's deliberate exception to the `inherited` guard (an
    // ancestor resolving through the patched token IS the edit taking effect)
    // must survive the value dimension — and must still catch a stale value.
    const inheritedOrigin = (value: string) =>
      origin({
        property: 'color',
        inherited: true,
        winningRule: rule({
          selector: '.card',
          stylesheet: FIRST_PARTY,
          declaration: 'color: var(--brand-fg)',
        }),
        varChain: [
          {
            name: '--brand-fg',
            value,
            definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
          },
        ],
      })
    const spec = (v: string): CascadeSinglePropertySpec => ({
      property: 'color',
      owner: { kind: 'token', token: '--brand-fg' },
      expectedDeclarationValue: v,
    })
    expect(evaluateCascadeOutcome(inheritedOrigin('#3b82f6'), spec('#3b82f6'))).toEqual({
      won: true,
    })
    expect(evaluateCascadeOutcome(inheritedOrigin('#ef4444'), spec('#3b82f6'))).toEqual({
      won: false,
      reason: 'stale-value',
      winnerSelector: '--brand-fg',
    })
  })
})

describe('evaluateCascadeOutcome — inherited origins (final-review I2)', () => {
  // `inherited: true` means NO rule matched the element itself; `winningRule`
  // describes an ANCESTOR's rule. Crediting it would pass an edit that did
  // nothing — the review's scenario: a colour set on a card, then a different
  // colour set on a <span> inside it whose write never landed.
  const ancestorPtSrc = rule({
    selector: '[data-desde-src="src/components/Card.vue:8:3"]',
    stylesheet: FIRST_PARTY,
    declaration: 'color: rgb(1, 2, 3) !important',
  })

  it('does not credit an ancestor data-desde-src rule to a pt-src owner', () => {
    const o = origin({ property: 'color', winningRule: ancestorPtSrc, inherited: true })
    expect(evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'pt-src' } })).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '[data-desde-src="src/components/Card.vue:8:3"]',
      winnerPackage: undefined,
      winnerImportant: true,
    })
  })

  it('does not credit an ancestor rule carrying our class to a classes owner', () => {
    const o = origin({
      property: 'color',
      winningRule: rule({
        selector: '.text-red-500',
        stylesheet: FIRST_PARTY,
        declaration: 'color: rgb(239, 68, 68)',
      }),
      inherited: true,
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'color',
        owner: { kind: 'classes', classes: ['text-red-500'] },
      }),
    ).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.text-red-500',
      winnerPackage: undefined,
      winnerImportant: false,
    })
  })

  it('reports no-rule for an inherited origin with no winning rule at all', () => {
    const o = origin({ property: 'color', inherited: true })
    expect(evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'pt-src' } })).toEqual({
      won: false,
      reason: 'no-rule',
    })
  })

  it('names the inline declaration when an inherited !important ancestor rule is present', () => {
    // The narrow shape the inline pre-check skips (ancestor rule !important,
    // inline normal): the inline declaration is still what renders, because any
    // declaration on the element beats an inherited value.
    const o = origin({
      property: 'color',
      winningRule: ancestorPtSrc,
      inherited: true,
      inline: { value: 'blue', important: false },
    })
    expect(evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'pt-src' } })).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: false,
    })
  })

  it('TOKEN EXCEPTION: an ancestor resolving through the patched token still wins', () => {
    // A token edit patches a custom property; an ancestor resolving the value
    // through it is the edit taking effect, not a miss.
    const o = origin({
      property: 'color',
      inherited: true,
      winningRule: rule({
        selector: '.card',
        stylesheet: FIRST_PARTY,
        declaration: 'color: var(--brand-fg)',
      }),
      varChain: [
        {
          name: '--brand-fg',
          value: '#123456',
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
      ],
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'token', token: '--brand-fg' } }),
    ).toEqual({ won: true })
  })

  it('INLINE OWNER: an inherited flag does not deny our own inline declaration', () => {
    // `origin.inline` is read off the EDITED element only (ancestor inline is
    // not traced), so it can never be an ancestor's. Denying it here would fail
    // every successful React inline edit of an inherited property.
    const o = origin({
      property: 'color',
      inherited: true,
      winningRule: ancestorPtSrc,
      inline: { value: 'rgb(9, 9, 9)', important: false },
    })
    expect(evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'inline' } })).toEqual({
      won: true,
    })
  })
})

describe('evaluateCascadeOutcome — shim immunity (Phase 3 live finding 1)', () => {
  // `inline.fromPreview === true` is the bridge saying "this inline declaration
  // is MY live-preview stamp" — by construction never a competing author
  // declaration. Live evidence (Phase 3, § Scenario 3): on the
  // mutation-disambiguation path the shim is never released, so every one of the
  // verifier's ~29 reads carried `inline: { important: true, fromPreview: true }`
  // and the oracle false-failed an edit all seven v-for rows visibly rendered.
  const shim = { value: 'rgb(245, 158, 11)', important: true, fromPreview: true }
  const ourRule = rule({
    selector: '[data-desde-src="src/components/LegacyAIGatewayCard.vue:52:7"][data-v-3f2228e0]',
    stylesheet: FIRST_PARTY,
    declaration: 'background-color: rgb(245, 158, 11) !important',
  })

  it('PT-SRC OWNER: our landed rule still wins while the shim is held', () => {
    const o = origin({ winningRule: ourRule, inline: shim })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: true })
  })

  it('PT-SRC OWNER: the shim is skipped even when our rule is ordinary-weight', () => {
    // The pre-fix code only survived an inline declaration when OUR rule was
    // `!important`; a normal inline shim beat a normal rule of ours. Skipping
    // the shim outright has to hold on both weights.
    const o = origin({
      winningRule: rule({
        selector: '[data-desde-src="src/App.vue:3:1"]',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: rgb(1, 2, 3)',
      }),
      inline: { value: 'rgb(1, 2, 3)', important: false, fromPreview: true },
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: true })
  })

  it('PT-SRC OWNER: the value dimension reads OUR declaration, never the shim', () => {
    // The false pass immunity must not open: the shim carries the NEW value
    // while our rule still carries the old one (write not landed / HMR pending)
    // → `stale-value`, not `won`.
    const o = origin({
      winningRule: rule({
        selector: '[data-desde-src="src/App.vue:3:1"]',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: rgb(239, 68, 68) !important',
      }),
      inline: { value: 'rgb(59, 130, 246)', important: true, fromPreview: true },
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'pt-src' },
        expectedDeclarationValue: '#3b82f6',
      }),
    ).toEqual({
      won: false,
      reason: 'stale-value',
      winnerSelector: '[data-desde-src="src/App.vue:3:1"]',
    })
  })

  it('CLASSES OWNER: our utility rule still wins while the shim is held', () => {
    const o = origin({
      winningRule: rule({
        selector: '.bg-amber-500',
        stylesheet: FIRST_PARTY,
        declaration: 'background-color: rgb(245, 158, 11)',
      }),
      inline: shim,
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'classes', classes: ['bg-amber-500'] },
      }),
    ).toEqual({ won: true })
  })

  it('TOKEN OWNER: the patched token still wins while the shim is held', () => {
    const o = origin({
      property: 'color',
      winningRule: rule({
        selector: '.ui-badge',
        declaration: 'color: var(--brand-fg)',
      }),
      varChain: [
        {
          name: '--brand-fg',
          value: '#3b82f6',
          definedAt: { selector: ':root', stylesheet: FIRST_PARTY },
        },
      ],
      inline: { value: 'rgb(59, 130, 246)', important: true, fromPreview: true },
    })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'color',
        owner: { kind: 'token', token: '--brand-fg' },
      }),
    ).toEqual({ won: true })
  })

  it('INLINE OWNER: a shim-only declaration is NOT verifiable, and never a pass', () => {
    // This owner's evidence IS the element's inline declaration, and the shim
    // occupies the same slot — so a `fromPreview` declaration proves the
    // preview, not the persisted edit. Reported as `preview-shim`, which
    // `verifyCascade` turns into `skipped`.
    const o = origin({ inline: shim })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'inline' } }),
    ).toEqual({ won: false, reason: 'preview-shim', winnerSelector: 'inline style' })
  })

  it('INLINE OWNER: a shim-only declaration does not pass its value check either', () => {
    const o = origin({ inline: { ...shim, value: 'rgb(59, 130, 246)' } })
    expect(
      evaluateCascadeOutcome(o, {
        property: 'background-color',
        owner: { kind: 'inline' },
        expectedDeclarationValue: '#3b82f6',
      }),
    ).toEqual({ won: false, reason: 'preview-shim', winnerSelector: 'inline style' })
  })

  it('INLINE OWNER: an AUTHORED inline declaration is unaffected', () => {
    const o = origin({ inline: { value: 'rgb(59, 130, 246)', important: false } })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'inline' } }),
    ).toEqual({ won: true })
  })

  it('an AUTHORED inline !important still beats a stylesheet owner', () => {
    // The immunity is keyed on the flag, not on `important` — an author's own
    // inline `!important` must still be reported as the winner.
    const o = origin({
      winningRule: ourRule,
      inline: { value: 'rgb(200, 0, 0)', important: true },
    })
    expect(
      evaluateCascadeOutcome(o, { property: 'background-color', owner: { kind: 'pt-src' } }),
    ).toEqual({ won: false, reason: 'overridden', winnerSelector: 'inline style', winnerImportant: true })
  })

  it('INHERITED: a shim is not named as the winner over the ancestor rule', () => {
    const o = origin({
      property: 'color',
      inherited: true,
      winningRule: rule({
        selector: '.card',
        declaration: 'color: rgb(1, 2, 3) !important',
      }),
      inline: { value: 'rgb(9, 9, 9)', important: true, fromPreview: true },
    })
    expect(evaluateCascadeOutcome(o, { property: 'color', owner: { kind: 'pt-src' } })).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: '.card',
      winnerPackage: '@acme/design-system',
      winnerImportant: true,
    })
  })

  it('AGGREGATE: an un-measurable property never masks a real loss', () => {
    const shimmed = origin({ property: 'color', inline: shim })
    const lost = origin({
      property: 'background-color',
      // An authored (non-preview) inline declaration that a library
      // `!important` rule really does outrank → a genuine `overridden` loss.
      winningRule: rule({ declaration: 'background-color: #f7f7f7 !important' }),
      inline: { value: 'rgb(1, 1, 1)', important: false },
    })
    const v = evaluateCascadeVerification(
      { color: shimmed, 'background-color': lost },
      {
        owner: { kind: 'inline' },
        properties: [{ property: 'color' }, { property: 'background-color' }],
      },
    )
    expect(v.won).toBe(false)
    expect(v.lost).toEqual(['color', 'background-color'])
    expect(v.failing?.property).toBe('background-color')
    expect(v.failing?.outcome.reason).toBe('overridden')
  })
})

describe('wouldLoseToImportant', () => {
  it('is true when the current winner is !important (our rule is always !important too)', () => {
    expect(
      wouldLoseToImportant(
        origin({ winningRule: rule({ declaration: 'background-color: #f7f7f7 !important' }) }),
      ),
    ).toBe(true)
  })

  it('is true when an inline !important declaration holds the property', () => {
    expect(wouldLoseToImportant(origin({ inline: { value: 'red', important: true } }))).toBe(true)
  })

  it('is false for an ordinary-weight winner, however specific', () => {
    expect(
      wouldLoseToImportant(
        origin({ winningRule: rule({ selector: '#a .b .c', specificity: [1, 2, 0] }) }),
      ),
    ).toBe(false)
  })

  it('is false when nothing declares the property', () => {
    expect(wouldLoseToImportant(origin())).toBe(false)
  })

  // Phase 3 live finding 3: after an edit lands, the `!important` winner IS
  // editor's own `[data-desde-src]` rule — so a repeat edit of the same property
  // was interrupted with "the current value is set with !important, an override
  // here may not win". Backwards: our own rule is exactly what WILL take effect.
  it('is false when the !important winner is COMPOSER’S OWN landed override', () => {
    expect(
      wouldLoseToImportant(
        origin({
          winningRule: rule({
            selector: '[data-desde-src="src/components/LegacyAIGatewayCard.vue:52:7"][data-v-3f2228e0]',
            stylesheet: FIRST_PARTY,
            declaration: 'background-color: rgb(245, 158, 11) !important',
          }),
        }),
      ),
    ).toBe(false)
  })

  it('is still true for a FOREIGN !important winner on the same element', () => {
    expect(
      wouldLoseToImportant(
        origin({
          winningRule: rule({
            selector: '.provider-badge[data-v-3f2228e0]',
            stylesheet: FIRST_PARTY,
            declaration: 'background-color: rgb(249, 250, 251) !important',
          }),
        }),
      ),
    ).toBe(true)
  })

  it('is still true for an author-written inline !important, whatever the winner', () => {
    // The `[data-desde-src]` discount covers the STYLESHEET winner only; an inline
    // `!important` really does outrank the next override. (The preview shim is
    // excluded upstream by `excludePreviewInline`, not here.)
    expect(
      wouldLoseToImportant(
        origin({
          winningRule: rule({
            selector: '[data-desde-src="src/App.vue:3:1"]',
            stylesheet: FIRST_PARTY,
            declaration: 'background-color: rgb(1, 2, 3) !important',
          }),
          inline: { value: 'rgb(200, 0, 0)', important: true },
        }),
      ),
    ).toBe(true)
  })
})

describe('describeCascadeWinner', () => {
  it('names the package when the winner is library CSS', () => {
    expect(
      describeCascadeWinner({
        won: false,
        reason: 'overridden',
        winnerSelector: '.ui-card',
        winnerPackage: '@acme/design-system',
        winnerImportant: true,
      }),
    ).toBe('`.ui-card !important` in @acme/design-system')
  })

  it('omits the package for a first-party winner', () => {
    expect(
      describeCascadeWinner({
        won: false,
        reason: 'overridden',
        winnerSelector: '.local',
        winnerImportant: false,
      }),
    ).toBe('`.local`')
  })

  it('describes the no-rule case', () => {
    expect(describeCascadeWinner({ won: false, reason: 'no-rule' })).toBe(
      'no CSS rule declares this property',
    )
  })

  it('describes a win', () => {
    expect(describeCascadeWinner({ won: true })).toBe('the edited rule')
  })

  it('describes the stale-value case as ours, not as a foreign winner', () => {
    expect(
      describeCascadeWinner({
        won: false,
        reason: 'stale-value',
        winnerSelector: '[data-desde-src="src/App.vue:12:4"]',
      }),
    ).toBe('the edited rule, still carrying the previous value')
  })
})

// Phase 2: the aggregate. Verifying one representative property was a documented
// v1 approximation with a concrete false pass — a per-property competitor can
// beat us on a property we did not sample even when our rule is a single block.
describe('evaluateCascadeVerification (Phase 2 — every property)', () => {
  const OUR_SELECTOR = '[data-desde-src="src/App.vue:3:2"]'
  const ours = (property: string, value: string) =>
    origin({
      property,
      winningRule: rule({
        selector: OUR_SELECTOR,
        stylesheet: FIRST_PARTY,
        declaration: `${property}: ${value} !important`,
      }),
    })
  const theirs = (property: string, value: string) =>
    origin({
      property,
      winningRule: rule({ declaration: `${property}: ${value} !important` }),
    })
  const owner = { kind: 'pt-src' as const }

  it('wins only when EVERY property is owned', () => {
    const v = evaluateCascadeVerification(
      {
        'border-style': ours('border-style', 'solid'),
        'border-width': ours('border-width', '1px'),
      },
      { owner, properties: [{ property: 'border-style' }, { property: 'border-width' }] },
    )
    expect(v.won).toBe(true)
    expect(v.lost).toEqual([])
    expect(v.failing).toBeUndefined()
    expect(v.properties).toHaveLength(2)
  })

  it('a SINGLE losing property fails the whole edit, and is named', () => {
    const v = evaluateCascadeVerification(
      {
        'border-style': ours('border-style', 'solid'),
        'border-width': origin({
          property: 'border-width',
          winningRule: rule({
            selector: OUR_SELECTOR,
            stylesheet: FIRST_PARTY,
            declaration: 'border-width: 1px !important',
          }),
          inline: { value: '0', important: true },
        }),
      },
      { owner, properties: [{ property: 'border-style' }, { property: 'border-width' }] },
    )
    expect(v.won).toBe(false)
    expect(v.lost).toEqual(['border-width'])
    expect(v.failing?.property).toBe('border-width')
    expect(v.failing?.outcome).toEqual({
      won: false,
      reason: 'overridden',
      winnerSelector: 'inline style',
      winnerImportant: true,
    })
  })

  it('reports the OVERRIDDEN loss ahead of a merely stale one', () => {
    // A named competing winner changes what the user should do (escalate the
    // scope); a sibling that has not HMR\'d yet must not mask it.
    const v = evaluateCascadeVerification(
      {
        'color': ours('color', 'rgb(1, 1, 1)'),
        'background-color': theirs('background-color', '#f7f7f7'),
      },
      {
        owner,
        properties: [
          // The stale one sorts FIRST, so spec order alone would report it.
          { property: 'color', expectedDeclarationValue: '#222222' },
          { property: 'background-color' },
        ],
      },
    )
    expect(v.lost).toEqual(['color', 'background-color'])
    expect(v.failing?.property).toBe('background-color')
    expect(v.failing?.outcome.won === false && v.failing.outcome.reason).toBe(
      'overridden',
    )
  })

  it('breaks a same-reason tie on spec order', () => {
    const v = evaluateCascadeVerification(
      {
        'border-width': theirs('border-width', '0'),
        'border-style': theirs('border-style', 'none'),
      },
      { owner, properties: [{ property: 'border-width' }, { property: 'border-style' }] },
    )
    expect(v.failing?.property).toBe('border-width')
  })

  it('treats a missing origin key as no-rule for that property', () => {
    const v = evaluateCascadeVerification(
      { 'border-style': ours('border-style', 'solid') },
      { owner, properties: [{ property: 'border-style' }, { property: 'border-width' }] },
    )
    expect(v.won).toBe(false)
    expect(v.failing?.property).toBe('border-width')
    expect(v.failing?.outcome).toEqual({ won: false, reason: 'no-rule' })
  })

  it('is not a pass when there is nothing to verify', () => {
    const v = evaluateCascadeVerification({}, { owner, properties: [] })
    expect(v.won).toBe(false)
    expect(v.failing).toBeUndefined()
    expect(v.properties).toEqual([])
  })

  it('tolerates an undefined origins map (nothing read yet)', () => {
    const v = evaluateCascadeVerification(undefined, {
      owner,
      properties: [{ property: 'color' }],
    })
    expect(v.won).toBe(false)
    expect(v.failing?.outcome).toEqual({ won: false, reason: 'no-rule' })
  })

  it('applies the value dimension PER PROPERTY', () => {
    // One property fresh, one stale — the stale one decides, and it decides as
    // `stale-value` (ours) rather than `overridden` (somebody else\'s).
    const v = evaluateCascadeVerification(
      {
        'border-style': ours('border-style', 'solid'),
        'border-width': ours('border-width', '4px'),
      },
      {
        owner,
        properties: [
          { property: 'border-style', expectedDeclarationValue: 'solid' },
          { property: 'border-width', expectedDeclarationValue: '1px' },
        ],
      },
    )
    expect(v.won).toBe(false)
    expect(v.failing?.property).toBe('border-width')
    expect(v.failing?.outcome).toEqual({
      won: false,
      reason: 'stale-value',
      winnerSelector: OUR_SELECTOR,
    })
  })
})
