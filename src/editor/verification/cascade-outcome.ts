/**
 * Cascade-ownership evaluation (pure).
 *
 * A style edit can land in source, parse, and write successfully while still
 * having no visible effect — because a competing CSS rule wins the cascade for
 * that property. Comparing computed values against the authored literal does
 * not catch this reliably (`red` computes to `rgb(255, 0, 0)`; `1rem` to
 * `16px`), so the oracle here asks a different question: *who owns this
 * property now?* If the owner is the rule the edit wrote, the edit took
 * effect. If it is someone else, we can name them.
 *
 * Ownership alone is not enough in one specific shape: a REPEAT edit of a
 * property our own rule already owned leaves ownership unchanged, so it would
 * pass whether or not the new value landed.
 * `CascadeSinglePropertySpec.expectedDeclarationValue` closes that for the lanes
 * where it can be checked exactly — comparing our authored value against the
 * specified value of the declaration WE wrote (the `[data-desde-src]` rule, the
 * element's inline style, or the token's definition site), never against a
 * computed value. The `classes` owner is excluded: Tailwind authors that
 * declaration, so a comparison there checks our model of a utility, not the edit.
 *
 * Two layers, because a style edit sets several properties at once:
 *  - `evaluateCascadeOutcome` — ONE property, one owner. The primitive.
 *  - `evaluateCascadeVerification` — every property the edit set, collapsed into
 *    one verdict. A single unowned property fails the edit, and the aggregate
 *    names the most actionable loss. Verifying one representative property was a
 *    documented v1 approximation that false-passed a half-landed edit.
 *
 * Inputs are plain `StyleOrigin` values — exactly what the bridge's cascade
 * walker (`src/bridge/style-provenance.ts`, real Selectors-L4 specificity via
 * `@bramus/specificity`) already returns over `GET_STYLE_PROVENANCE`. Nothing
 * here touches the DOM, so the whole evaluator is unit-testable.
 */

import type { StyleOrigin } from '@/types/bridge'

/**
 * How to recognize the rule an edit wrote, per style lane:
 *  - `pt-src`  — Vue `scoped-css-override`: the emitted selector is anchored on
 *                `[data-desde-src="file:line:col"]`, which survives Vue's scoped
 *                compilation (it only appends `[data-v-hash]`) and `:deep()`
 *                expansion, so a substring test on the anchor is exact enough.
 *  - `inline`  — React `jsx-style` inline mode: the declaration lands in the
 *                element's `style={{}}`, reported as `origin.inline`.
 *  - `classes` — utility-class mode: ownership means the winning selector
 *                references one of the classes the edit added.
 *  - `token`   — a token-value edit: ownership means the rendered value still
 *                resolves through the patched custom property.
 */
export type CascadeOwner =
  | { kind: 'pt-src' }
  | { kind: 'inline' }
  | { kind: 'classes'; classes: string[] }
  | { kind: 'token'; token: string }

/**
 * The per-property input to {@link evaluateCascadeOutcome} — one property, one
 * owner. A style edit almost always sets several properties at once; the
 * aggregate over all of them is {@link CascadeExpectationSpec} /
 * {@link evaluateCascadeVerification}, which builds one of these per property.
 */
export interface CascadeSinglePropertySpec {
  /** CSS property the edit set, e.g. `background-color`. */
  property: string
  owner: CascadeOwner
  /**
   * OPTIONAL value dimension, `pt-src` (codex P1), `inline` (codex P2) and
   * `token` (codex R4) owners.
   *
   * Ownership alone is a *false pass* for a REPEAT edit of a property our own
   * rule already owns: pick red, then pick blue, and the `[data-desde-src]` rule
   * still wins on the very first poll — so the oracle reports `won` while the
   * DOM may still be showing red, and every iterate-on-a-colour loop verifies
   * as "pass" regardless of outcome. The `inline` owner has the identical hole:
   * the previous `style={{}}` declaration authored in source is still present,
   * so mere presence passes while the old value renders. So does `token`: the
   * rendered value still resolves *through* the patched custom property no
   * matter what that property is now set to.
   *
   * When set, ownership is necessary but no longer sufficient: the declaration
   * we own must also carry this value, or the outcome is `stale-value` (see
   * `cssValueCarriesValue`). Scoped to the owners whose declaration is the one
   * WE author, so the comparison is authored-vs-specified for the same
   * declaration: `pt-src` (`apply-scoped-css-override-edit.ts` splices the
   * resolved declarations verbatim), `inline` (the React `jsx-style` inline
   * lane writes `style={{}}`, and `origin.inline.value` is that declaration
   * read straight off the element via CSSOM), and `token` (the `token-value`
   * applicator rewrites the custom property at its definition site, and
   * `StyleVarChainEntry.value` is that definition read back by the walker).
   *
   * **`classes` is deliberately EXCLUDED — that owner is ownership-only.** The
   * shell does resolve the utility itself (`resolveTailwindClasses`), so it holds
   * a value; but that value is our MODEL of what the utility means, and the
   * declaration belongs to Tailwind. Comparing the two compares two models of the
   * same thing rather than verifying the edit: a mismatch means our model drifted,
   * not that the edit failed. Concretely, a v3 substrate with
   * `theme.extend.spacing['4'] = '1.125rem'` emits `.p-4 { padding: 1.125rem }` —
   * a plain literal, so no `var()` decline saves us — and our model says `1rem`,
   * producing a `stale-value` verdict whose wording claims *our* declaration is
   * stale. Doubly wrong, since it is not our declaration and nothing is stale. v3
   * emits literals for every customizable scale (spacing, radii, font sizes and
   * weights, border widths), so this is routine rather than exotic. A value
   * supplied for a `classes` owner is therefore ignored, not honoured. See
   * `tasks/editor-edit-verification.md` § limitations.
   */
  expectedDeclarationValue?: string
}

/** One property's expectation within a {@link CascadeExpectationSpec}. */
export interface CascadePropertyExpectation {
  property: string
  /** See {@link CascadeSinglePropertySpec.expectedDeclarationValue}. */
  expectedDeclarationValue?: string
}

/**
 * What an `EditExpectation` carries for a style/token edit: the owner, plus
 * EVERY property the edit set. For the owners whose declaration we author
 * (`pt-src`, `inline`) the caller has already expanded shorthands to their
 * longhands (`expandStyleDeclarations`); the `classes` owner carries the
 * utility's authored property set unexpanded, because a Tailwind shorthand
 * routing through a custom property does not answer for its own longhands. The
 * owner gate lives in `src/hooks/cascade-target-for-style-edit.ts`.
 *
 * Verifying one representative property was a documented v1 approximation with
 * two false-pass shapes, both of which a per-property competitor produces:
 * apply Tailwind `border` (writing `border-style: solid !important` AND
 * `border-width: 1px !important`) to an element already carrying
 * `style="border-width: 0 !important"`, and sampling `border-style` reports a
 * pass while the border is invisible. That splits the verdict on the Vue
 * `pt-src` lane too, not just React's `classes` lane — a single rule of ours can
 * still lose one property to a per-property inline declaration.
 */
export interface CascadeExpectationSpec {
  owner: CascadeOwner
  /** Every property to verify. Empty means there is nothing to check. */
  properties: readonly CascadePropertyExpectation[]
}

export type CascadeOutcome =
  | { won: true }
  | {
      won: false
      /**
       * `overridden`    — someone else owns it.
       * `no-rule`       — nobody declares it.
       * `stale-value`   — OUR rule owns it but still carries the old value: the
       *                   write didn't land, or HMR hasn't applied it yet. Not a
       *                   cascade loss (nobody outranked us), so it must never be
       *                   reported as `css-overridden` — telling the user to
       *                   escalate scope would be wrong advice.
       * `preview-shim`  — NOT A VERDICT. Editor's own live-preview declaration
       *                   (`inline.fromPreview`) occupies the very slot this
       *                   owner's evidence lives in, so ownership cannot be
       *                   measured yet. Only the `inline` owner can produce it
       *                   (for a stylesheet owner the shim is simply skipped —
       *                   see {@link evaluateCascadeOutcome}), and `verifyCascade`
       *                   turns it into `skipped`, never a `fail`: a verdict we
       *                   cannot substantiate is not a verdict.
       */
      reason: 'overridden' | 'no-rule' | 'stale-value' | 'preview-shim'
      /** Selector of the winner, or `'inline style'` for an inline winner. */
      winnerSelector?: string
      /** npm package when the winner ships from `node_modules`. */
      winnerPackage?: string
      winnerImportant?: boolean
    }

/** The anchor attribute every Vue scoped-css-override selector is built on. */
const PT_SRC_ANCHOR = 'data-desde-src'

/**
 * Is this the selector of a rule COMPOSER wrote — i.e. a scoped-css-override,
 * whose selector is always built on the `[data-desde-src="file:line:col"]` anchor?
 *
 * The one identification, used by both consumers so they can never disagree:
 * the `pt-src` owner's ownership test, and `wouldLoseToImportant`'s pre-flight
 * (which must not warn that our own landed `!important` rule might beat the
 * next edit — it is the thing that WILL take effect).
 */
export function selectorIsScopedOverride(selector: string): boolean {
  return selector.includes(PT_SRC_ANCHOR)
}

const NO_RULE: CascadeOutcome = { won: false, reason: 'no-rule' }

/**
 * Not-yet-measurable: editor's own preview declaration is sitting in the slot
 * this owner's evidence lives in. `winnerSelector` names it for diagnostics
 * only — `verifyCascade` reports `skipped`, never a failure.
 */
const PREVIEW_SHIM: CascadeOutcome = {
  won: false,
  reason: 'preview-shim',
  winnerSelector: 'inline style',
}

/**
 * Whether an authored declaration carries `!important`. The walker formats
 * declarations as `${property}: ${value}${priority ? ' !' + priority : ''}`
 * (`src/bridge/style-provenance.ts:183`), so the flag is preserved verbatim.
 * Anchored on a `!` to avoid matching the bare word inside a value.
 */
export function declarationIsImportant(declaration: string): boolean {
  return /!\s*important\b/i.test(declaration)
}

/**
 * `String.fromCodePoint`, but declining to throw on an out-of-range CSS hex
 * escape rather than crashing the whole match.
 */
function safeFromCodePoint(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ''
  }
}

/** Characters that end a class token when they appear UNESCAPED. */
const CLASS_TOKEN_DELIMITER = /[.:#[\]()>+~\s,]/

/**
 * Extract every class-selector token (`.token`) from a CSS selector,
 * resolving CSS escapes as we go so an escaped delimiter character (`\.`,
 * `\:`, `\[`, `\]`, `\(`, `\)`, `\/`, or a hex escape like `\3a `) inside a
 * class name is treated as a literal character of that token, never as a
 * token boundary.
 *
 * This is the load-bearing difference from a whole-string unescape-then-
 * search: Tailwind's escaping means a class like `bg-[var(--token)]` or
 * `w-1/2` is emitted with backslash-escaped punctuation
 * (`.bg-\[var\(--token\)\]`, `.w-1\/2`). Unescaping the ENTIRE selector first
 * and then substring-searching it would risk a false merge — e.g. an
 * escaped dot inside a single class (`.foo\.bar`, one class literally named
 * `foo.bar`) would, once unescaped to `.foo.bar`, look exactly like the
 * compound selector `.foo.bar` (two classes) and spuriously match a
 * search for a class named merely `bar`. Consuming escapes inside the same
 * token-building pass — so an escaped delimiter never causes a new token to
 * start — closes that off entirely; token boundaries only ever fall on a
 * RAW, unescaped delimiter.
 *
 * Deliberately not a full selector parser: it does not understand quoted
 * attribute-selector values (`[data-x="a.b"]`), so a literal `.` inside one
 * could be misread as a class boundary — out of scope here, and no worse
 * than the substring match this replaces.
 */
function extractClassTokens(selector: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < selector.length) {
    if (selector[i] !== '.') {
      i++
      continue
    }
    i++ // skip the leading dot
    let token = ''
    while (i < selector.length) {
      const ch = selector[i]
      if (ch === '\\') {
        i++
        const hex = /^[0-9a-fA-F]{1,6}/.exec(selector.slice(i))?.[0]
        if (hex) {
          i += hex.length
          // A single trailing whitespace char terminates the hex escape and
          // is consumed, not emitted (CSS Syntax §4.3.7).
          if (i < selector.length && /[ \t\n\r\f]/.test(selector[i])) i++
          token += safeFromCodePoint(parseInt(hex, 16))
        } else if (i < selector.length) {
          token += selector[i]
          i++
        }
        continue
      }
      if (CLASS_TOKEN_DELIMITER.test(ch)) break
      token += ch
      i++
    }
    if (token) tokens.push(token)
  }
  return tokens
}

/**
 * Whether `selector` references `className` as a whole class token —
 * escape-tolerant (see `extractClassTokens`) and exact (no prefix/substring
 * match: `bg-red-500-dark` must not match a search for `bg-red-500`).
 */
function selectorUsesClass(selector: string, className: string): boolean {
  return extractClassTokens(selector).includes(className)
}

function overriddenBy(rule: NonNullable<StyleOrigin['winningRule']>): CascadeOutcome {
  return {
    won: false,
    reason: 'overridden',
    winnerSelector: rule.selector,
    winnerPackage: rule.stylesheet.package,
    winnerImportant: declarationIsImportant(rule.declaration),
  }
}

function overriddenByInline(important: boolean): CascadeOutcome {
  return {
    won: false,
    reason: 'overridden',
    winnerSelector: 'inline style',
    winnerImportant: important,
  }
}

/**
 * The declaration we own still carries the previous value. `winnerSelector` is
 * our own rule's selector, `'inline style'` when we own it inline, or the custom
 * property's name when the stale declaration is a token definition.
 */
function staleValue(winnerSelector: string): CascadeOutcome {
  return { won: false, reason: 'stale-value', winnerSelector }
}

/**
 * Canonicalize a CSS value so an authored literal can be compared against a
 * declaration read back off a stylesheet rule.
 *
 * This is NOT the general computed-value comparison this module deliberately
 * avoids. A *computed* value has been resolved against layout and inheritance
 * (`1rem` → `16px`, `currentColor` → the parent's colour), which is why the
 * oracle never compares against one. A stylesheet rule's *specified* value is a
 * different animal: the walker builds `declaration` from
 * `rule.style.getPropertyValue(property)` (`src/bridge/style-provenance.ts`),
 * which preserves the authored spelling except for a short, enumerable set of
 * CSSOM normalizations — measured against real Chromium, not assumed:
 *
 *   `#ef4444`      → `rgb(239, 68, 68)`        (hex colours serialize to rgb())
 *   `#ef4444ff`    → `rgb(239, 68, 68)`        (opaque alpha is dropped)
 *   `#ef444480`    → `rgba(239, 68, 68, 0.5)`
 *   `#f00a`        → `rgba(255, 0, 0, 0.667)`  (alpha precision is engine-specific)
 *   `currentColor` → `currentcolor`            (identifiers are lowercased)
 *   `0`            → `0px`                     (a zero length gains its unit)
 *
 * Everything the style lanes actually author round-trips verbatim otherwise:
 * `transparent`, `var(--token)`, `1rem`, `9999px`, `600`, `1.5`, `-0.025em`,
 * `center`, `dashed`, `rgb(…)`. Normalization is applied to BOTH sides (it is
 * idempotent), so the comparison never depends on which side was serialized —
 * and alpha is rounded rather than replicated, since its serialized precision
 * differs by engine.
 */
function canonicalizeCssValue(value: string): string {
  let v = value.replace(/!\s*important\b/gi, '').trim().toLowerCase()
  // Hex → the rgb()/rgba() form CSSOM reports.
  v = v.replace(/#([0-9a-f]{3,8})(?![0-9a-z])/g, (whole, digits: string) =>
    hexToRgbFunction(digits) ?? whole,
  )
  // Collapse whitespace, and drop it around commas, so `rgb(1, 2, 3)` and
  // `rgb(1,2,3)` compare equal AND read as one whitespace-separated token.
  v = v.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',')
  // Round alpha to 2 decimals on both sides (Chromium reports 3 for some hex
  // alphas), and collapse a fully opaque rgba() to rgb() the way CSSOM does.
  v = v.replace(
    /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g,
    (_whole, r: string, g: string, b: string, a: string) => {
      const alpha = Math.round(Number(a) * 100) / 100
      return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
    },
  )
  // A zero length is the same declaration with or without its unit.
  v = v.replace(/(?<![\w.%-])0(?:px|rem|em|%|vh|vw|pt|ch|ex)(?![\w.%-])/g, '0')
  return v
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → `rgb(…)` / `rgba(…)`, else null. */
function hexToRgbFunction(digits: string): string | null {
  const expand =
    digits.length === 3 || digits.length === 4
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits
  if (expand.length !== 6 && expand.length !== 8) return null
  const byte = (at: number): number => parseInt(expand.slice(at, at + 2), 16)
  const [r, g, b] = [byte(0), byte(2), byte(4)]
  if (expand.length === 6) return `rgb(${r},${g},${b})`
  // Alpha is normalized by the rgba() pass in `canonicalizeCssValue` (which also
  // collapses `…,1)` back to rgb(), matching CSSOM's treatment of `#rrggbbff`).
  return `rgba(${r},${g},${b},${byte(6) / 255})`
}

/**
 * Value forms whose authored spelling is known to survive CSSOM serialization
 * (once canonicalized above). Anything else — `hsl()`, `oklch()`, `color-mix()`,
 * `calc()` — is re-serialized in ways this module does not model (`hsl(0 100%
 * 50%)` comes back as `rgb(255, 0, 0)`), so the value check DECLINES on those
 * rather than risk reporting a good edit as stale. None of the current style
 * lanes author them; this is the fail-safe for the ones that might.
 */
function isComparableValue(canonical: string): boolean {
  for (const match of canonical.matchAll(/([a-z][a-z-]*)\(/g)) {
    const fn = match[1]
    if (fn !== 'var' && fn !== 'rgb' && fn !== 'rgba') return false
  }
  return true
}

/**
 * THE one value comparison in this module (every value-verified owner routes
 * through it): does the CSS value `actualValue` carry `expectedValue`?
 *
 * `actualValue` is a bare value — a rule's `getPropertyValue` result, or
 * `origin.inline.value` read off the element — and both sides are canonicalized
 * before comparing. Matches on the whole value, or on one whitespace-separated
 * component of it: a shorthand (`padding: 1rem 2rem`) carries our value as one
 * component.
 *
 * DECLINES (returns true) when either side is empty or carries a function whose
 * serialization `canonicalizeCssValue` does not model. Absent evidence must
 * never manufacture a miss — the caller then falls back to ownership alone.
 */
export function cssValueCarriesValue(
  actualValue: string,
  expectedValue: string,
): boolean {
  const want = canonicalizeCssValue(expectedValue)
  if (!want || !isComparableValue(want)) return true
  const actual = canonicalizeCssValue(actualValue)
  if (!isComparableValue(actual)) return true
  if (actual === want) return true
  return actual.split(' ').includes(want)
}

/**
 * Can a var-chain entry's definition-site value be compared against the literal
 * a token edit authored? No in two shapes, and both DECLINE (ownership alone
 * decides) rather than risk a false `stale-value`:
 *
 *  - **empty** — the walker found a definition but read no value back. Absent
 *    evidence, not a mismatch.
 *  - **itself a `var(...)`** — a CHAINED token (`--brand-bg: var(--red-500)`).
 *    The concrete value lives a hop further down the chain, so this entry can
 *    never carry the authored literal; comparing would report every good edit as
 *    stale. We deliberately do NOT walk the chain further: which hop the edit
 *    patched is what ownership already established, and a deeper hop's value is
 *    somebody else's definition. Note `var` IS in `isComparableValue`'s modelled
 *    set (a rule declaring `color: var(--x)` compares fine), so the shared
 *    predicate would not decline on its own — this check is why.
 */
function tokenValueIsComparable(value: string): boolean {
  const v = value.trim()
  return v.length > 0 && !/var\s*\(/i.test(v)
}

/**
 * `cssValueCarriesValue` against a declaration as the walker formats it
 * (`property: value[ !important]`) — strip the property name, then compare.
 */
export function declarationCarriesValue(
  declaration: string,
  expectedValue: string,
): boolean {
  const colon = declaration.indexOf(':')
  return cssValueCarriesValue(
    colon >= 0 ? declaration.slice(colon + 1) : declaration,
    expectedValue,
  )
}

/**
 * Does the rule the edit wrote own `spec.property` on this element?
 *
 * Note the asymmetry between owners: for a stylesheet-rule owner an inline
 * `!important` declaration always outranks us, whereas an inline owner is
 * itself only beaten by an `!important` stylesheet rule. That mirrors the real
 * cascade, and the walker gives us both facts directly.
 *
 * `origin.inherited === true` is load-bearing (final-review I2): it means NO
 * rule matched the element itself and `winningRule` describes an ANCESTOR's
 * rule (`src/bridge/style-provenance.ts` — the flag is only set on the
 * ancestor-walk branch). Since every rule we emit matches the edited element
 * by construction, an inherited winner can never be ours, so crediting it
 * would pass an edit that did nothing. See the per-owner handling below; the
 * `token` owner is the deliberate exception.
 *
 * SHIM IMMUNITY (Phase 3 live finding 1). `origin.inline.fromPreview === true`
 * means the inline declaration is editor's OWN live-preview stamp
 * (`applyClassOverride` in `src/bridge/override-preview.ts`, recorded by the
 * layer that stamped it) — by construction never a competing author
 * declaration. So it is skipped entirely in the inline-outranks-stylesheet-rule
 * reasoning, as though it were not in the DOM. Before this the oracle measured
 * our own shim: on the mutation-disambiguation path — which, unlike the other
 * lanes, does not release the override before verifying — every successful
 * `[data-desde-src]` edit false-failed with "`inline style !important` wins the
 * cascade" while all seven v-for rows visibly rendered the new value. Fixing it
 * structurally here makes the oracle immune regardless of release timing, in
 * every lane, instead of resting on sequencing that only some lanes honour.
 *
 * The `inline` OWNER is the case that must not become a false pass in the
 * process: there the shim and the persisted `style={{}}` declaration occupy the
 * SAME slot, so a `fromPreview` declaration is not evidence of the edit — it is
 * evidence of the preview. That owner therefore reports `preview-shim`
 * ("not yet verifiable", which keeps the poll loop running and ends as
 * `skipped`), never `won`.
 */
export function evaluateCascadeOutcome(
  origin: StyleOrigin | undefined | null,
  spec: CascadeSinglePropertySpec,
): CascadeOutcome {
  if (!origin) return NO_RULE
  const { winningRule, inherited } = origin
  // Editor's own preview stamp is not a competing declaration — discount it
  // everywhere below. `undefined` here means "no AUTHORED inline declaration",
  // which is exactly what the cascade reasoning needs to weigh.
  const inline = origin.inline?.fromPreview === true ? undefined : origin.inline

  if (spec.owner.kind === 'inline') {
    // Our evidence IS the element's inline declaration, and the preview stamps
    // that same slot — so while the shim is present we cannot tell the
    // persisted edit from the preview of it. Not verifiable ≠ verified.
    if (origin.inline?.fromPreview === true) return PREVIEW_SHIM
    // Ownership here comes from `origin.inline`, which the walker reads off
    // the EDITED ELEMENT only (an ancestor's inline style is explicitly not
    // traced), so an inherited winner can't be mistaken for ours and there is
    // no false-`won` to guard against. What `inherited` DOES tell us is that
    // nothing on the element authored a stylesheet declaration — so
    // `winningRule` is an ancestor's and must not be weighed against our
    // inline declaration at all: a declaration on the element always beats an
    // inherited value, `!important` or not. (Treating `inherited` as "not
    // ours" here — as it is for the stylesheet-rule owners — would report a
    // false FAILURE for every successful React inline edit of an inherited
    // property, e.g. `color` on an element with no color rule of its own.)
    if (!inline) return NO_RULE
    if (
      !inherited &&
      winningRule &&
      declarationIsImportant(winningRule.declaration) &&
      !inline.important
    ) {
      return overriddenBy(winningRule)
    }
    // THE VALUE DIMENSION (codex P2) — the same false pass the `pt-src` owner
    // closes in P1, in the shape this owner has it: presence of an inline
    // declaration is unchanged by a REPEAT edit (red → blue) or a stale HMR, so
    // presence alone reported `won` while the old value still rendered.
    // `inline.value` comes off the element via CSSOM (`readInline`), i.e. the
    // serialized form `canonicalizeCssValue` was built to normalize — this is
    // the authored-vs-specified comparison, not the computed one the oracle
    // avoids. A declined comparison leaves ownership to decide, as before.
    if (
      spec.expectedDeclarationValue &&
      !cssValueCarriesValue(inline.value, spec.expectedDeclarationValue)
    ) {
      return staleValue('inline style')
    }
    return { won: true }
  }

  // Every other owner is a stylesheet rule, so an inline declaration on the
  // same property can outrank it. Cascade order, ascending: normal rule →
  // normal inline → important rule → important inline. So a *normal* inline
  // beats every normal-weight rule, and only an `!important` rule of ours
  // survives one. `winningRule` is the rule the walker picked among
  // stylesheets — when it is ours, its priority is what we weigh against
  // inline; when it is not, we are losing anyway.
  //
  // Getting this wrong in the permissive direction (reporting `won` while a
  // normal inline actually renders) would silently re-create the bug this
  // module exists to catch, so the check is deliberately conservative.
  if (inline) {
    const ourRuleIsImportant =
      !!winningRule && declarationIsImportant(winningRule.declaration)
    if (inline.important || !ourRuleIsImportant) {
      return overriddenByInline(inline.important)
    }
  }

  if (spec.owner.kind === 'token') {
    // Deliberately BEFORE the `inherited` guard below: a token edit patches a
    // custom property, and an ancestor resolving the rendered value through
    // that patched token IS the token edit taking effect. Inheritance is a
    // success mode here, not a miss.
    const { token } = spec.owner as Extract<CascadeOwner, { kind: 'token' }>
    const entry = origin.varChain.find((e) => e.name === token)
    if (entry) {
      // THE VALUE DIMENSION (codex R4) — the same false pass P1/P2 closed for
      // the other two owners we author. The chain still containing our token is
      // unchanged by a REPEAT token edit (#ef4444 → #3b82f6) or a stale HMR, so
      // ownership alone reported `won` while the element still resolved through
      // the OLD definition. `entry.value` is that definition read back by the
      // walker (`rule.style.getPropertyValue(name)` in
      // `src/bridge/style-provenance.ts` § findVarDefinition) — the same
      // authored-vs-specified comparison, not the computed one the oracle
      // avoids. Custom properties are not type-parsed by CSSOM, so a hex
      // definition round-trips VERBATIM rather than as `rgb()` (the live smoke
      // harness reads `--acme-color-background-disabled` back as `#f7f7f7` out of
      // real Chromium); canonicalization is idempotent and applied to both
      // sides, so either spelling compares equal. A declined comparison leaves
      // ownership to decide, as before.
      if (
        spec.expectedDeclarationValue &&
        tokenValueIsComparable(entry.value) &&
        !cssValueCarriesValue(entry.value, spec.expectedDeclarationValue)
      ) {
        return staleValue(token)
      }
      return { won: true }
    }
    return winningRule ? overriddenBy(winningRule) : NO_RULE
  }

  // `pt-src` / `classes` owners: our rule always matches the edited element,
  // so an inherited winner is by definition somebody else's rule on an
  // ancestor. Name it rather than crediting ourselves (final-review I2).
  // Reachable with `inline` set only in the narrow "ancestor rule is
  // !important, inline is normal" shape the block above skips — the inline
  // declaration is still what renders (any declaration on the element beats an
  // inherited value), so name that.
  if (inherited) {
    if (inline) return overriddenByInline(inline.important)
    return winningRule ? overriddenBy(winningRule) : NO_RULE
  }

  if (!winningRule) return NO_RULE

  const ours =
    spec.owner.kind === 'pt-src'
      ? selectorIsScopedOverride(winningRule.selector)
      : spec.owner.classes.some((cls) => selectorUsesClass(winningRule.selector, cls))

  if (!ours) return overriddenBy(winningRule)

  // THE VALUE DIMENSION (codex P1). Ownership is unchanged when the SAME rule
  // already owned the property before this edit — pick red, then pick blue —
  // so ownership alone would report `won` on the first poll while the DOM may
  // still show red. When the caller told us which declaration value to expect,
  // our own rule still carrying the old one is a stale render, NOT a cascade
  // loss: nobody outranked us, so `css-overridden` (→ "escalate scope") would
  // be wrong advice.
  //
  // Scoped to `pt-src`: we splice that declaration ourselves, so the two sides
  // describe the same declaration. The `classes` owner is deliberately
  // OWNERSHIP-ONLY — see {@link CascadeSinglePropertySpec.expectedDeclarationValue}
  // — so an expected value handed in for it is ignored here rather than trusted.
  if (
    spec.owner.kind === 'pt-src' &&
    spec.expectedDeclarationValue &&
    !declarationCarriesValue(winningRule.declaration, spec.expectedDeclarationValue)
  ) {
    return staleValue(winningRule.selector)
  }

  return { won: true }
}

/** One property's verdict inside a {@link CascadeVerification}. */
export interface CascadePropertyOutcome {
  property: string
  outcome: CascadeOutcome
}

/**
 * The aggregate verdict for a style edit: every property it set, evaluated
 * independently, collapsed into ONE result.
 *
 * A pass requires EVERY verified property to be owned — a single loss is a
 * failure, because the user's "it didn't work" is about the visible result and a
 * half-applied border is not a success.
 */
export interface CascadeVerification {
  /** True only when every verified property is owned (and carries its value). */
  won: boolean
  /** Per-property verdicts, in spec order. */
  properties: readonly CascadePropertyOutcome[]
  /** Names of every property that did not land, in spec order. */
  lost: readonly string[]
  /**
   * The property to report, when `won` is false: the most ACTIONABLE loss rather
   * than merely the first. `overridden` outranks `stale-value` outranks
   * `no-rule`, because a named competing winner is the one verdict that changes
   * what the user should do (escalate the scope), and it must not be masked by a
   * sibling property that merely hasn't HMR'd yet. Ties break on spec order.
   *
   * Absent only when there was nothing to verify (an empty property list).
   */
  failing?: {
    property: string
    outcome: Extract<CascadeOutcome, { won: false }>
  }
}

/** Report priority: lower sorts first. See {@link CascadeVerification.failing}. */
const REASON_PRIORITY: Record<
  Extract<CascadeOutcome, { won: false }>['reason'],
  number
> = {
  overridden: 0,
  'stale-value': 1,
  'no-rule': 2,
  // LAST on purpose: `preview-shim` is "not measurable yet", and it must never
  // mask a sibling property that really did lose. It only ever surfaces as the
  // reported outcome when every loss is un-measurable — which `verifyCascade`
  // then reports as `skipped`.
  'preview-shim': 3,
}

/**
 * Evaluate every property in `spec` against the provenance map the bridge
 * returned for them (one `GET_STYLE_PROVENANCE` round-trip covers all of them —
 * it already takes a property array).
 *
 * `origins` may be undefined (nothing read yet) or missing individual keys; a
 * missing key is passed to the per-property evaluator as `undefined`, which it
 * already reports as `no-rule`.
 */
export function evaluateCascadeVerification(
  origins: Readonly<Record<string, StyleOrigin>> | undefined,
  spec: CascadeExpectationSpec,
): CascadeVerification {
  const properties: CascadePropertyOutcome[] = spec.properties.map((p) => ({
    property: p.property,
    outcome: evaluateCascadeOutcome(origins?.[p.property], {
      property: p.property,
      owner: spec.owner,
      ...(p.expectedDeclarationValue
        ? { expectedDeclarationValue: p.expectedDeclarationValue }
        : {}),
    }),
  }))
  const losses = properties.filter(
    (p): p is { property: string; outcome: Extract<CascadeOutcome, { won: false }> } =>
      !p.outcome.won,
  )
  if (losses.length === 0) {
    return { won: spec.properties.length > 0, properties, lost: [] }
  }
  // Stable-sort a copy by report priority; `lost` keeps spec order.
  const ranked = losses
    .map((loss, index) => ({ loss, index }))
    .sort(
      (a, b) =>
        REASON_PRIORITY[a.loss.outcome.reason] -
          REASON_PRIORITY[b.loss.outcome.reason] || a.index - b.index,
    )
  return {
    won: false,
    properties,
    lost: losses.map((l) => l.property),
    failing: ranked[0].loss,
  }
}

/**
 * Pre-flight: would a freshly emitted scoped override lose to what is already
 * there? Our generated rules always carry `!important`
 * (`src/editor/edit-service/apply-scoped-css-override-edit.ts:153-166`), so
 * any ordinary-weight winner loses to us regardless of specificity — the only
 * thing that can still beat us is another `!important` declaration. That makes
 * this predicate exact for the common case without needing a specificity
 * comparator on the shell side.
 *
 * OUR OWN LANDED RULE IS NOT A THREAT (Phase 3 live finding 3). Once an edit has
 * landed, the `!important` winner for that property IS editor's own
 * `[data-desde-src] … !important` rule — so a repeat edit of the same property was
 * interrupted by "The current value is set with `!important`, so an override at
 * this element may not win", which is precisely backwards: the next override
 * replaces that rule and will take effect. A winner whose selector carries the
 * `data-desde-src` anchor is therefore not counted, via the same
 * {@link selectorIsScopedOverride} identification the `pt-src` owner uses.
 *
 * (The preview shim is a separate exclusion, applied by the CALL SITE:
 * `excludePreviewInline` in `style-scope-decision.ts` drops a `fromPreview`
 * inline declaration before this predicate sees it. This one stays pure and
 * keeps honouring an AUTHOR-written inline `!important`.)
 */
export function wouldLoseToImportant(origin: StyleOrigin): boolean {
  if (origin.inline?.important) return true
  const rule = origin.winningRule
  if (!rule) return false
  if (selectorIsScopedOverride(rule.selector)) return false
  return declarationIsImportant(rule.declaration)
}

/** Human-readable winner, for failure detail and toasts. */
export function describeCascadeWinner(outcome: CascadeOutcome): string {
  if (outcome.won) return 'the edited rule'
  if (outcome.reason === 'no-rule') return 'no CSS rule declares this property'
  if (outcome.reason === 'stale-value') {
    return 'the edited rule, still carrying the previous value'
  }
  if (outcome.reason === 'preview-shim') {
    return "editor's own live preview, still applied to this property"
  }
  const selector = outcome.winnerImportant
    ? `${outcome.winnerSelector} !important`
    : outcome.winnerSelector
  return outcome.winnerPackage ? `\`${selector}\` in ${outcome.winnerPackage}` : `\`${selector}\``
}
