/**
 * Unit coverage for the style-provenance cascade walker (Layer 0 of
 * tasks/inspector-style-provenance.md). Runs in jsdom against fixture
 * `<style>` sheets — which expose `cssRules`, custom properties, and
 * preserved `var(...)` values (probed), so the cascade + var-chain logic is
 * exercised end-to-end without a browser. `getComputedStyle` resolution is
 * NOT relied on (jsdom doesn't resolve the cascade); the winning rule +
 * var-chain come purely from stylesheet walking.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  dependsOnTransientState,
  getStyleProvenance,
  parsePackage,
  splitSelectorList,
  stylesheetSourceHint,
  transientStatePseudoClass,
} from './style-provenance'

function setup(css: string, html: string): Element {
  document.head.innerHTML = `<style>${css}</style>`
  document.body.innerHTML = html
  const el = document.querySelector('[data-target]')
  if (!el) throw new Error('fixture needs a [data-target] element')
  return el
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('getStyleProvenance — winning rule', () => {
  it('resolves a library class rule + its token chain (the UiEmptyState case)', () => {
    const el = setup(
      `:root { --acme-color-background-disabled: #f7f7f7; }
       .acme-empty-state { background-color: var(--acme-color-background-disabled); }`,
      `<div data-target class="acme-empty-state"></div>`,
    )
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule).not.toBeNull()
    expect(bg.winningRule!.selector).toBe('.acme-empty-state')
    expect(bg.winningRule!.declaration).toBe(
      'background-color: var(--acme-color-background-disabled)',
    )
    expect(bg.varChain).toHaveLength(1)
    expect(bg.varChain[0]).toMatchObject({
      name: '--acme-color-background-disabled',
      value: '#f7f7f7',
      definedAt: { selector: ':root' },
    })
  })

  it('is property-polymorphic — same shape for padding via a space token (UiCard)', () => {
    const el = setup(
      `:root { --acme-space-medium: 16px; }
       .acme-card { padding-top: var(--acme-space-medium); }`,
      `<div data-target class="acme-card"></div>`,
    )
    const { 'padding-top': pad } = getStyleProvenance(el, ['padding-top'])
    expect(pad.winningRule!.selector).toBe('.acme-card')
    expect(pad.varChain[0]).toMatchObject({ name: '--acme-space-medium', value: '16px' })
  })

  it('walks multiple properties in one call', () => {
    const el = setup(
      `.x { color: red; border-color: blue; }`,
      `<div data-target class="x"></div>`,
    )
    const origins = getStyleProvenance(el, ['color', 'border-color'])
    expect(origins['color'].winningRule!.declaration).toBe('color: red')
    expect(origins['border-color'].winningRule!.declaration).toBe('border-color: blue')
  })
})

describe('getStyleProvenance — cascade resolution', () => {
  it('higher specificity wins over a less specific match', () => {
    const el = setup(
      `.box { color: red; }
       div.box { color: blue; }`,
      `<div data-target class="box"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.selector).toBe('div.box')
    expect(color.winningRule!.declaration).toBe('color: blue')
  })

  it('equal specificity → later source order wins', () => {
    const el = setup(
      `.box { color: red; }
       .box { color: green; }`,
      `<div data-target class="box"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: green')
  })

  it('an id selector beats any number of classes', () => {
    const el = setup(
      `.a.b.c { color: red; }
       #t { color: gold; }`,
      `<div data-target id="t" class="a b c"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.selector).toBe('#t')
    expect(color.winningRule!.specificity).toEqual([1, 0, 0])
  })

  it('returns winningRule null when no rule declares the property', () => {
    const el = setup(`.x { color: red; }`, `<div data-target class="x"></div>`)
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule).toBeNull()
    expect(bg.varChain).toEqual([])
  })

  it('matches one part of a comma selector list', () => {
    const el = setup(
      `.other, .target-class { color: teal; }`,
      `<div data-target class="target-class"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.selector).toBe('.target-class')
  })
})

describe('getStyleProvenance — cascade origin (important / layer / inheritance)', () => {
  it('honors !important over a higher-specificity normal rule', () => {
    const el = setup(
      `.box { color: red !important; }
       #id { color: blue; }`,
      `<div data-target id="id" class="box"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // #id is more specific, but the important .box declaration wins.
    expect(color.winningRule!.selector).toBe('.box')
    expect(color.winningRule!.declaration).toBe('color: red !important')
  })

  it('treats an unlayered rule as winning over a layered one (Tailwind v4 shape)', () => {
    const el = setup(
      `@layer base { .x { color: red; } }
       .x { color: green; }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // Unlayered beats layered even though both are `.x` at equal specificity.
    expect(color.winningRule!.declaration).toBe('color: green')
  })

  it('a later-declared cascade layer outranks an earlier one', () => {
    const el = setup(
      `@layer a { .x { color: red; } }
       @layer b { .x { color: blue; } }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: blue')
  })

  it('keeps a reopened named layer at its original position (split layer)', () => {
    // `a` is reopened after `b`, but a layer stays where first declared — so
    // `b` still outranks BOTH `a` blocks. A naive per-block counter would let
    // the second `a` win.
    const el = setup(
      `@layer a { .x { color: red; } }
       @layer b { .x { color: blue; } }
       @layer a { .x { color: orange; } }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: blue')
  })

  it('distinguishes nested layers that share a local name (foo.bar vs baz.bar)', () => {
    // baz.bar must NOT inherit foo.bar's earlier rank; within baz, bar is
    // declared after qux, so baz.bar wins → blue. (Local-name dedup would
    // wrongly let baz.qux/green win.)
    const el = setup(
      `@layer foo { @layer bar { .x { color: red; } } }
       @layer baz { @layer qux { .x { color: green; } } @layer bar { .x { color: blue; } } }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: blue')
  })

  // ── the `!important` layer REVERSAL ────────────────────────────────────
  // Real CSS flips layer precedence for important declarations: the EARLIEST
  // layer wins and unlayered-important is weakest. Each expectation below was
  // measured in real Chromium first (`tasks/scripts/important-layer-measure.mts`)
  // — never derived from the spec text alone — and the same cases are gated
  // against the real bundle in `tasks/scripts/style-provenance-smoke.mts` §4.

  it('an !important unlayered rule LOSES to an !important layered one', () => {
    // The Tailwind-v4 / design-system shape: `@layer components` important CSS
    // beats editor's unlayered `[data-desde-src]` important override. Getting
    // this backwards is a false PASS in the cascade verifier.
    const el = setup(
      `@layer components { .btn { color: red !important; } }
       .btn { color: green !important; }`,
      `<div data-target class="btn"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: red !important')
  })

  it('an EARLIER !important layer outranks a later one', () => {
    const el = setup(
      `@layer a { .x { color: red !important; } }
       @layer b { .x { color: blue !important; } }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: red !important')
  })

  it('!important layer rank dominates specificity (in the reversed direction)', () => {
    const el = setup(
      `@layer a { .x { color: red !important; } }
       @layer b { html body div#id.x { color: blue !important; } }`,
      `<div data-target id="id" class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // The far more specific rule loses because its layer is later.
    expect(color.winningRule!.selector).toBe('.x')
  })

  it('an !important layered rule beats a far more specific !important unlayered one', () => {
    const el = setup(
      `@layer a { .x { color: red !important; } }
       html body div#id.x { color: blue !important; }`,
      `<div data-target id="id" class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.selector).toBe('.x')
  })

  it('still resolves by specificity among !important rules WITHIN one layer', () => {
    // The reversal is about layers only — inside a single layer the ordinary
    // specificity comparison must survive untouched.
    const el = setup(
      `@layer a {
         .x { color: red !important; }
         html body div#id.x { color: blue !important; }
       }`,
      `<div data-target id="id" class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: blue !important')
  })

  it('an !important rule in the WEAKEST layer still beats an unlayered normal one', () => {
    // Importance is compared before layers, so the reversal must not let a
    // normal declaration outrank an important one.
    const el = setup(
      `@layer a { .x { color: red !important; } }
       .x { color: green; }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.declaration).toBe('color: red !important')
  })

  it('resolves an inherited custom property by ancestor PROXIMITY, not global specificity', () => {
    // The nearer ancestor (.container, specificity [0,1,0]) must beat the
    // farther ancestor (div.theme-dark, specificity [0,1,1]). A global
    // specificity compare would wrongly pick the farther div.theme-dark.
    const el = setup(
      `div.theme-dark { --t: black; }
       .container { --t: white; }
       .x { color: var(--t); }`,
      `<div class="theme-dark"><div class="container"><span data-target class="x"></span></div></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.varChain[0]).toMatchObject({ value: 'white', definedAt: { selector: '.container' } })
  })
})

describe('getStyleProvenance — inherited properties', () => {
  it('resolves an inherited typography value from the nearest ancestor', () => {
    const el = setup(
      `:root { --acme-font-weight-semibold: 600; }
       .acme-button { font-weight: var(--acme-font-weight-semibold); }`,
      `<button class="acme-button"><span data-target>Label</span></button>`,
    )
    const { 'font-weight': fw } = getStyleProvenance(el, ['font-weight'])
    expect(fw.inherited).toBe(true)
    expect(fw.winningRule!.selector).toBe('.acme-button')
    expect(fw.varChain[0]).toMatchObject({ name: '--acme-font-weight-semibold', value: '600' })
  })

  it('prefers an element-level rule over an inherited one (not flagged inherited)', () => {
    const el = setup(
      `.parent { color: red; }
       .child { color: blue; }`,
      `<div class="parent"><span data-target class="child">Hi</span></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inherited).toBeUndefined()
    expect(color.winningRule!.declaration).toBe('color: blue')
  })

  it('skips an intermediate `inherit` rule and resolves to the real authoring ancestor', () => {
    const el = setup(
      `.grandparent { color: red; }
       .parent { color: inherit; }`,
      `<div class="grandparent"><div class="parent"><span data-target>Hi</span></div></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inherited).toBe(true)
    // .parent just forwards; the real source is .grandparent.
    expect(color.winningRule!.selector).toBe('.grandparent')
    expect(color.winningRule!.declaration).toBe('color: red')
  })

  it('forwards an explicit `inherit` on the element itself to an ancestor', () => {
    const el = setup(
      `.parent { color: green; }
       .self { color: inherit; }`,
      `<div class="parent"><span data-target class="self">Hi</span></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inherited).toBe(true)
    expect(color.winningRule!.declaration).toBe('color: green')
  })

  it('does NOT inherit a non-inherited property (background-color stays null)', () => {
    const el = setup(
      `.parent { background-color: red; }`,
      `<div class="parent"><span data-target>Hi</span></div>`,
    )
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule).toBeNull()
  })
})

describe('getStyleProvenance — var chain', () => {
  it('follows a multi-hop var chain (--a → var(--b) → value)', () => {
    const el = setup(
      `:root { --b: blue; --a: var(--b); }
       .x { color: var(--a); }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.varChain.map((v) => v.name)).toEqual(['--a', '--b'])
    expect(color.varChain[1].value).toBe('blue')
  })

  it('prefers a class-scoped token definition over :root (theming)', () => {
    const el = setup(
      `:root { --t: #aaa; }
       .theme-dark { --t: #000; }
       .x { color: var(--t); }`,
      `<div class="theme-dark"><span data-target class="x"></span></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // The class-scoped (.theme-dark, inherited via closest) definition wins
    // over the lower-specificity :root one.
    expect(color.varChain[0]).toMatchObject({
      value: '#000',
      definedAt: { selector: '.theme-dark' },
    })
  })

  it('is cycle-safe (--a → var(--b) → var(--a))', () => {
    const el = setup(
      `:root { --a: var(--b); --b: var(--a); }
       .x { color: var(--a); }`,
      `<div data-target class="x"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // Must terminate; the chain records each var at most once.
    const names = color.varChain.map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('getStyleProvenance — token usage count (blast radius)', () => {
  it('counts consumer declaration sites of the root token, excluding its definition', () => {
    const el = setup(
      `:root { --brand: #3b82f6; }
       .a { color: var(--brand); }
       .b { border-color: var(--brand); }
       .c { background: var(--brand); }`,
      `<div data-target class="a"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // 3 consumers (.a/.b/.c); the :root definition is not a reference.
    expect(color.tokenUsageCount).toBe(3)
  })

  it('does not prefix-match a longer token name', () => {
    const el = setup(
      `:root { --acme-color: red; --acme-color-bg: blue; }
       .a { color: var(--acme-color); }
       .b { background: var(--acme-color-bg); }`,
      `<div data-target class="a"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // Only `.a` references --acme-color; `.b`'s --acme-color-bg must not count.
    expect(color.tokenUsageCount).toBe(1)
  })

  it('counts an alias (--other: var(--root)) as a use', () => {
    const el = setup(
      `:root { --root: #000; --alias: var(--root); }
       .a { color: var(--root); }`,
      `<div data-target class="a"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    // `.a` + the `--alias` declaration both reference --root.
    expect(color.tokenUsageCount).toBe(2)
  })

  it('omits tokenUsageCount when the value is not token-driven', () => {
    const el = setup(`.a { color: red; }`, `<div data-target class="a"></div>`)
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.tokenUsageCount).toBeUndefined()
  })
})

describe('getStyleProvenance — inline styles', () => {
  it('reports an inline style override on the element', () => {
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green !important"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inline).toEqual({ value: 'green', important: true })
  })

  it('omits inline when the element has no inline value for the property', () => {
    const el = setup(`.x { color: red; }`, `<div data-target class="x"></div>`)
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inline).toBeUndefined()
  })

  // ── inline.fromPreview (the injected preview-shim query) ────────────────
  // The real producer is `overridePreview.isPreviewStampedProperty`
  // (src/bridge/override-preview.ts), gated live in
  // tasks/scripts/style-provenance-smoke.mts §5. Here the query is stubbed to
  // pin the walker's half of the contract.

  it('flags an inline declaration the preview layer reports as its own shim', () => {
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green !important"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'], {
      isPreviewStampedProperty: (node, property) => node === el && property === 'color',
    })
    expect(color.inline).toEqual({ value: 'green', important: true, fromPreview: true })
  })

  it('leaves fromPreview ABSENT for an authored inline declaration', () => {
    // Same shape as the shim (inline + !important) but the preview layer
    // disclaims it — this is the author-written case the previous shell-side
    // property-name heuristic wrongly discounted.
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green !important"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'], {
      isPreviewStampedProperty: () => false,
    })
    expect(color.inline).toEqual({ value: 'green', important: true })
    expect(color.inline!.fromPreview).toBeUndefined()
  })

  it('omits fromPreview entirely when no preview query is injected (back-compat)', () => {
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green !important"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.inline).toEqual({ value: 'green', important: true })
  })

  it('degrades to absent (never throws) when the injected query throws', () => {
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'], {
      isPreviewStampedProperty: () => {
        throw new Error('preview layer exploded')
      },
    })
    expect(color.inline).toEqual({ value: 'green', important: false })
  })

  it('reports fromPreview per property, not per element', () => {
    const el = setup(
      `.x { color: red; }`,
      `<div data-target class="x" style="color: green !important; margin-top: 4px !important"></div>`,
    )
    const origins = getStyleProvenance(el, ['color', 'margin-top'], {
      isPreviewStampedProperty: (_node, property) => property === 'color',
    })
    expect(origins['color'].inline!.fromPreview).toBe(true)
    expect(origins['margin-top'].inline!.fromPreview).toBeUndefined()
  })
})

// Phase 3 live finding 4: the walker named a `:hover` rule as the winning
// source for a property whose `computedValue` was the resting value. The
// `element.matches()` gate cannot prevent it — when the user clicks an element
// to inspect it, the cursor is ON that element, so `:hover` genuinely matches
// for the whole inspection. Provenance must answer for the element AT REST.
describe('dependsOnTransientState', () => {
  it('flags the interaction-state pseudo-classes', () => {
    // The exact live selector, from @acme/design-system.
    expect(
      dependsOnTransientState(
        '.ui-button.primary[data-v-2f66f2ee]:hover:not(:disabled):not([disabled]):not(:focus):not(:active)',
      ),
    ).toBe(true)
    expect(dependsOnTransientState('.a:focus')).toBe(true)
    expect(dependsOnTransientState('.a:focus-visible')).toBe(true)
    expect(dependsOnTransientState('.a:focus-within')).toBe(true)
    expect(dependsOnTransientState('.a:active')).toBe(true)
    expect(dependsOnTransientState('#main:target')).toBe(true)
    expect(dependsOnTransientState('.a:HOVER')).toBe(true)
  })

  it('does NOT flag durable state or structural pseudo-classes', () => {
    // These describe the element the user is looking at, so the rule that
    // matches them IS the style on screen.
    for (const sel of [
      '.a:checked',
      '.a:disabled',
      '.a:required',
      '.a:first-child',
      '.a:nth-child(2n + 1)',
      '.a:empty',
      '.a:last-of-type',
      'a:visited',
    ]) {
      expect(dependsOnTransientState(sel)).toBe(false)
    }
  })

  it('does NOT flag a NEGATED transient state — that selector matches at rest', () => {
    expect(dependsOnTransientState('.a:not(:hover)')).toBe(false)
    expect(dependsOnTransientState('.a:not(:is(:hover, :focus))')).toBe(false)
    expect(dependsOnTransientState('.a:not(:focus):not(:active)')).toBe(false)
  })

  it('flags a POSITIVE nested transient state', () => {
    expect(dependsOnTransientState('.card:has(:hover)')).toBe(true)
    expect(dependsOnTransientState('.card:is(.a:hover, .b)')).toBe(true)
    // …and a doubly-negated one is positive again.
    expect(dependsOnTransientState('.a:not(:not(:hover))')).toBe(true)
  })

  it('never reads a colon inside an attribute selector as a pseudo-class', () => {
    expect(
      dependsOnTransientState('[data-desde-src="src/components/Navbar.vue:12:9"][data-v-abc]'),
    ).toBe(false)
    expect(dependsOnTransientState('[data-state=":hover"]')).toBe(false)
    expect(dependsOnTransientState('[data-state=":hover"]:focus')).toBe(true)
  })

  it('handles pseudo-ELEMENTS and escaped colons in class names', () => {
    expect(dependsOnTransientState('.a::before')).toBe(false)
    // Tailwind's `hover:` variant escapes the colon in the class name; the
    // REAL state comes from the trailing `:hover`, and only that.
    expect(dependsOnTransientState('.hover\\:bg-red-500')).toBe(false)
    expect(dependsOnTransientState('.hover\\:bg-red-500:hover')).toBe(true)
  })
})

describe('getStyleProvenance — resting state (finding 4)', () => {
  it('keeps a DURABLE-state rule as the winner', () => {
    // The other half of finding 4's fix: excluding transient state must not
    // exclude a state the user can see. jsdom matches `:checked` off the
    // property, so this runs end-to-end through the walker.
    const el = setup(
      `.box { background-color: rgb(1, 1, 1); }
       .box:checked { background-color: rgb(2, 2, 2); }`,
      `<input type="checkbox" data-target class="box" checked>`,
    )
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule!.selector).toBe('.box:checked')
  })

  it('does not report a transient-state rule even when it is the most specific', () => {
    // NOTE: jsdom reports `:hover` as never matching, so `matchingSelectors`
    // already drops this rule here — the gate that a hovered element cannot
    // produce a `:hover` winner is the LIVE one in
    // tasks/scripts/style-provenance-smoke.mts §7, where Playwright really
    // hovers the element. This case pins the resting answer.
    const el = setup(
      `.btn { background-color: rgb(0, 68, 244); }
       .btn.primary[data-v-x]:hover:not(:disabled) { background-color: rgb(0, 48, 204); }`,
      `<button data-target class="btn primary" data-v-x></button>`,
    )
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule!.selector).toBe('.btn')
  })

  it('ignores a token redefined under a transient state', () => {
    const el = setup(
      `:root { --brand: rgb(1, 1, 1); }
       .card:hover { --brand: rgb(2, 2, 2); }
       .card { color: var(--brand); }`,
      `<div data-target class="card"></div>`,
    )
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.varChain[0]).toMatchObject({
      name: '--brand',
      value: 'rgb(1, 1, 1)',
      definedAt: { selector: ':root' },
    })
  })
})

// N1: the resting-rule fix left `computedValue` a LIVE sample, so a hovered
// element paired a resting declaration with a hovered value and — for a
// hover-only property — `winningRule: null` with a real opaque colour. The
// walker now says so. jsdom never matches `:hover`, but it DOES match `:focus`
// on `document.activeElement`, so the drop-and-record path is exercisable here
// with a real transient state; the `:hover` shape is gated live in
// tasks/scripts/style-provenance-smoke.mts §7.
describe('getStyleProvenance — transientRuleApplies', () => {
  it('flags the transient state when a focus rule outranks the resting winner', () => {
    const el = setup(
      `.btn { background-color: rgb(0, 68, 244); }
       .btn.primary:focus { background-color: rgb(0, 48, 204); }`,
      `<button data-target class="btn primary"></button>`,
    )
    ;(el as HTMLElement).focus()
    expect(el.matches(':focus')).toBe(true)
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    // The resting rule is still the reported winner — that half is unchanged.
    expect(bg.winningRule!.selector).toBe('.btn')
    expect(bg.transientRuleApplies).toEqual({ pseudoClass: ':focus' })
  })

  it('flags it when the property is declared ONLY under a transient state', () => {
    // The `a.nav-item-link` case: `winningRule: null` beside a real colour read
    // "no rule declares this", which was indistinguishable from broken.
    const el = setup(
      `.link:focus { background-color: rgb(224, 228, 234); }`,
      `<a href="#" data-target class="link"></a>`,
    )
    ;(el as HTMLElement).focus()
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule).toBeNull()
    expect(bg.transientRuleApplies).toEqual({ pseudoClass: ':focus' })
  })

  it('is ABSENT when no transient rule currently matches', () => {
    const el = setup(
      `.btn { background-color: rgb(0, 68, 244); }
       .btn:focus { background-color: rgb(0, 48, 204); }`,
      `<button data-target class="btn"></button>`,
    )
    // Never focused → the `:focus` rule doesn't match → nothing to explain.
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule!.selector).toBe('.btn')
    expect(bg.transientRuleApplies).toBeUndefined()
  })

  it('is ABSENT when the matching transient rule would lose anyway', () => {
    // A transient rule that loses the cascade changes nothing on screen, so
    // reporting it would be noise, not an explanation.
    const el = setup(
      `.btn:focus { background-color: rgb(0, 48, 204); }
       .btn.primary[data-v-x] { background-color: rgb(0, 68, 244); }`,
      `<button data-target class="btn primary" data-v-x></button>`,
    )
    ;(el as HTMLElement).focus()
    expect(el.matches(':focus')).toBe(true)
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    expect(bg.winningRule!.selector).toBe('.btn.primary[data-v-x]')
    expect(bg.transientRuleApplies).toBeUndefined()
  })

  it('names the transient pseudo-class from a compound Acme DS-shaped selector', () => {
    const el = setup(
      `.k-btn { color: rgb(0, 68, 244); }
       .k-btn.primary[data-v-x]:focus-within:not(:disabled) { color: rgb(0, 48, 204); }`,
      `<button data-target class="k-btn primary" data-v-x><span></span></button>`,
    )
    ;(el as HTMLElement).focus()
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.transientRuleApplies).toEqual({ pseudoClass: ':focus-within' })
  })
})

describe('transientStatePseudoClass', () => {
  it('returns the first positively-depended-on transient state, lower-cased', () => {
    expect(
      transientStatePseudoClass(
        '.ui-button.primary[data-v-2f66f2ee]:hover:not(:disabled):not([disabled])',
      ),
    ).toBe('hover')
    expect(transientStatePseudoClass('.a:FOCUS-VISIBLE')).toBe('focus-visible')
    expect(transientStatePseudoClass('.card:has(:active)')).toBe('active')
  })

  it('returns null for a selector with no positive transient dependency', () => {
    expect(transientStatePseudoClass('.a:not(:hover)')).toBeNull()
    expect(transientStatePseudoClass('.a:checked')).toBeNull()
    expect(transientStatePseudoClass('[data-desde-src="src/App.vue:1:1"]')).toBeNull()
  })
})

describe('splitSelectorList', () => {
  it('splits top-level commas only, preserving :is()/:not() argument lists', () => {
    expect(splitSelectorList('.a, .b')).toEqual(['.a', '.b'])
    expect(splitSelectorList(':is(.a, .b) .c, .d')).toEqual([':is(.a, .b) .c', '.d'])
    expect(splitSelectorList('[data-x="a,b"], .c')).toEqual(['[data-x="a,b"]', '.c'])
  })
})

describe('parsePackage', () => {
  it('extracts scoped and unscoped npm package names from node_modules hrefs', () => {
    expect(
      parsePackage('http://localhost/node_modules/@acme/design-system/dist/style.css'),
    ).toBe('@acme/design-system')
    expect(parsePackage('http://localhost/node_modules/normalize.css/normalize.css')).toBe(
      'normalize.css',
    )
  })

  it('returns undefined for first-party / non-node_modules hrefs', () => {
    expect(parsePackage('http://localhost/src/styles/app.css')).toBeUndefined()
    expect(parsePackage('<style>')).toBeUndefined()
  })
})

/**
 * N3 — the source-hint fallback. Vite dev serves EVERY first-party stylesheet as
 * an injected `<style>` (CSS imported from JS), so `sheet.href` is null and the
 * ref carried only the synthetic `'<style>'` marker: the shell could not resolve
 * the file, so the token scope — the remedy the cascade-failure copy recommends —
 * was unreachable on any Vite dev substrate. The bridge now reports the owner
 * node's `data-vite-dev-id`.
 */
describe('stylesheetSourceHint / stylesheetRef', () => {
  it('reads the hint off a bare node and ignores nodes that declare none', () => {
    document.head.innerHTML =
      `<style id="hinted" data-vite-dev-id="/repo/src/style.css"></style>` +
      `<style id="plain"></style>`
    expect(stylesheetSourceHint(document.getElementById('hinted'))).toBe(
      '/repo/src/style.css',
    )
    expect(stylesheetSourceHint(document.getElementById('plain'))).toBeUndefined()
    expect(stylesheetSourceHint(null)).toBeUndefined()
    // A non-Element owner (ProcessingInstruction) has no getAttribute.
    expect(
      stylesheetSourceHint(document.createProcessingInstruction('x', 'y')),
    ).toBeUndefined()
  })

  it('carries the hint on every ref an href-less sheet produces', () => {
    document.head.innerHTML = `<style data-vite-dev-id="/repo/src/tokens.css">
      :root { --brand: #ffffff; }
      .btn { background-color: var(--brand); }
    </style>`
    document.body.innerHTML = `<div data-target class="btn"></div>`
    const el = document.querySelector('[data-target]')!
    const { 'background-color': bg } = getStyleProvenance(el, ['background-color'])
    // Both the winning rule's sheet and the token's definition site.
    expect(bg.winningRule!.stylesheet).toEqual({
      href: '<style>',
      sourceHint: '/repo/src/tokens.css',
    })
    expect(bg.varChain[0].definedAt.stylesheet.sourceHint).toBe('/repo/src/tokens.css')
    // href stays the synthetic marker — the hint is additive, not a rename.
    expect(bg.winningRule!.stylesheet.href).toBe('<style>')
  })

  it('omits the hint entirely when the owner node declares none (today’s payload)', () => {
    const el = setup(`.btn { color: red; }`, `<div data-target class="btn"></div>`)
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.stylesheet).toEqual({ href: '<style>' })
    expect('sourceHint' in color.winningRule!.stylesheet).toBe(false)
  })

  it('parses the package out of a node_modules hint, so library CSS injected as a <style> is still recognised', () => {
    document.head.innerHTML = `<style data-vite-dev-id="/repo/node_modules/@acme/design-system/dist/style.css">
      .ui-button { color: red; }
    </style>`
    document.body.innerHTML = `<div data-target class="ui-button"></div>`
    const el = document.querySelector('[data-target]')!
    const { color } = getStyleProvenance(el, ['color'])
    expect(color.winningRule!.stylesheet).toEqual({
      href: '<style>',
      package: '@acme/design-system',
      sourceHint: '/repo/node_modules/@acme/design-system/dist/style.css',
    })
  })
})
