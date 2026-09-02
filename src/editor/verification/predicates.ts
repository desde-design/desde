/**
 * Predicate registry — the deterministic JUDGE of the L3a verification ladder
 * (Tier-2 edit verification P2).
 *
 * A fuzzy / NL edit goal ("make this fit the content width", "align this with
 * that header", "enough contrast") can't be checked with a string-exact DOM
 * read-back (L2). P2 compiles such a goal to one or more of these **measurable
 * predicates**, which a `*judge*` deterministically over `Measurements` read
 * off the live DOM (`READ_MEASUREMENTS`).
 *
 * Load-bearing boundary: every function here is **pure** — no LLM, no I/O, no
 * imports beyond the wire type. The LLM only *picks* which predicate(s) a goal
 * maps to (`translate-goal.ts`); it never evaluates one. Keep that seam clean.
 *
 * Spec: tasks/editor-edit-verification.md (P2, decision 2 — all six up front).
 */

import type { Measurements } from '@/types/bridge'

export type { Measurements } from '@/types/bridge'

/** The six predicates a goal may compile to (decision 2). */
export type PredicateName =
  | 'noOverflow'
  | 'fitsViewport'
  | 'aligned'
  | 'bboxMatches'
  | 'contrastRatio'
  | 'textEquals'

/**
 * Result of judging one predicate. `indeterminate` means the inputs couldn't
 * support a verdict (e.g. a transparent background for `contrastRatio`); the
 * verifier treats an all-indeterminate goal as `skipped` rather than a false
 * fail — we never claim to verify what we can't measure.
 */
export interface PredicateOutcome {
  pass: boolean
  detail: string
  indeterminate?: boolean
}

/** Alignment edge/axis for `aligned`. */
export type AlignAxis =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'centerX'
  | 'centerY'

// Default tolerances (px). Geometry from getBoundingClientRect is sub-pixel;
// a small tolerance absorbs rounding without masking real misalignment.
const OVERFLOW_TOL = 1
const VIEWPORT_TOL = 1
const ALIGN_TOL = 2
const BBOX_TOL = 4
/** WCAG AA for normal-size text. */
const DEFAULT_CONTRAST_MIN = 4.5

const round = (n: number): number => Math.round(n * 100) / 100

// ─── Geometry predicates ────────────────────────────────────────────

/**
 * No horizontal/vertical content overflow — the element is wide/tall enough
 * for its own content. Maps "fit the content width", "no scroll", "don't clip".
 * `scrollWidth <= clientWidth` (+tol) on both axes.
 */
export function noOverflow(m: Measurements): PredicateOutcome {
  // Inline elements (and `display: contents`) have no layout box of their own —
  // the browser reports clientWidth/scrollWidth as 0, so the comparison below
  // would false-pass even on visibly clipped text. Can't measure overflow here.
  const display = m.computedStyle.display
  if (display === 'inline' || display === 'contents' || (m.clientWidth === 0 && m.clientHeight === 0)) {
    return { pass: false, indeterminate: true, detail: `element has no measurable layout box (display: ${display}). Overflow not measurable; wrap it in a block-level box to size to content` }
  }
  const overX = m.scrollWidth - m.clientWidth
  const overY = m.scrollHeight - m.clientHeight
  const pass = overX <= OVERFLOW_TOL && overY <= OVERFLOW_TOL
  if (pass) {
    return { pass: true, detail: `no overflow (scroll ${m.scrollWidth}×${m.scrollHeight} ≤ client ${m.clientWidth}×${m.clientHeight})` }
  }
  const axes: string[] = []
  if (overX > OVERFLOW_TOL) axes.push(`x by ${round(overX)}px`)
  if (overY > OVERFLOW_TOL) axes.push(`y by ${round(overY)}px`)
  return { pass: false, detail: `content overflows ${axes.join(' and ')}` }
}

/**
 * The element's bounding box sits within the iframe viewport — "fit on screen",
 * "no off-screen", "no horizontal scroll of the page".
 */
export function fitsViewport(m: Measurements): PredicateOutcome {
  const { bbox, viewport } = m
  const overflows: string[] = []
  if (bbox.left < -VIEWPORT_TOL) overflows.push(`left edge ${round(bbox.left)}`)
  if (bbox.top < -VIEWPORT_TOL) overflows.push(`top edge ${round(bbox.top)}`)
  if (bbox.right > viewport.width + VIEWPORT_TOL) overflows.push(`right edge ${round(bbox.right)} > ${viewport.width}`)
  if (bbox.bottom > viewport.height + VIEWPORT_TOL) overflows.push(`bottom edge ${round(bbox.bottom)} > ${viewport.height}`)
  if (overflows.length === 0) {
    return { pass: true, detail: `within viewport ${viewport.width}×${viewport.height}` }
  }
  return { pass: false, detail: `extends past viewport: ${overflows.join(', ')}` }
}

/**
 * Two elements share an edge or centerline on the given axis — "align this with
 * X", "line these up". Tolerance-banded.
 */
export function aligned(
  a: Measurements,
  b: Measurements,
  axis: AlignAxis,
  tol = ALIGN_TOL,
): PredicateOutcome {
  const coord = (m: Measurements): number => {
    switch (axis) {
      case 'left':
        return m.bbox.left
      case 'right':
        return m.bbox.right
      case 'top':
        return m.bbox.top
      case 'bottom':
        return m.bbox.bottom
      case 'centerX':
        return m.bbox.left + m.bbox.width / 2
      case 'centerY':
        return m.bbox.top + m.bbox.height / 2
    }
  }
  const av = coord(a)
  const bv = coord(b)
  const delta = Math.abs(av - bv)
  const pass = delta <= tol
  return {
    pass,
    detail: pass
      ? `aligned on ${axis} (Δ ${round(delta)}px ≤ ${tol})`
      : `not aligned on ${axis}: ${round(av)} vs ${round(bv)} (Δ ${round(delta)}px > ${tol})`,
  }
}

/**
 * Two elements have matching boxes — "match the size of X", "same dimensions".
 * Compares width/height (and, when both fall outside tol, reports position too)
 * within `tol` px.
 */
export function bboxMatches(
  a: Measurements,
  b: Measurements,
  tol = BBOX_TOL,
): PredicateOutcome {
  const dw = Math.abs(a.bbox.width - b.bbox.width)
  const dh = Math.abs(a.bbox.height - b.bbox.height)
  const pass = dw <= tol && dh <= tol
  if (pass) {
    return { pass: true, detail: `box matches within ${tol}px (Δw ${round(dw)}, Δh ${round(dh)})` }
  }
  const parts: string[] = []
  if (dw > tol) parts.push(`width ${round(a.bbox.width)} vs ${round(b.bbox.width)} (Δ ${round(dw)})`)
  if (dh > tol) parts.push(`height ${round(a.bbox.height)} vs ${round(b.bbox.height)} (Δ ${round(dh)})`)
  return { pass: false, detail: `box differs: ${parts.join(', ')}` }
}

// ─── Contrast predicate (WCAG) ──────────────────────────────────────

interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Parse a getComputedStyle color (`rgb(r, g, b)` / `rgba(r, g, b, a)` — the
 * only forms getComputedStyle emits). Returns null on anything else.
 */
export function parseCssColor(value: string): Rgb | null {
  const m = value.trim().match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i,
  )
  if (!m) return null
  const r = Number(m[1])
  const g = Number(m[2])
  const b = Number(m[3])
  let a = 1
  if (m[4] != null) {
    a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
  }
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null
  return { r, g, b, a }
}

/** WCAG relative luminance of an sRGB color (alpha ignored — caller resolves). */
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two opaque colors (1–21). */
export function contrastRatioValue(fg: Rgb, bg: Rgb): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Text/background contrast meets a WCAG minimum — "enough contrast",
 * "readable", "accessible color". `min` defaults to 4.5 (AA normal text).
 *
 * Honest about its limits: a transparent background can't be resolved from a
 * single element's computed style, so it returns `indeterminate` (→ the
 * verifier skips, never false-fails) rather than guessing white.
 */
export function contrastRatio(
  m: Measurements,
  min = DEFAULT_CONTRAST_MIN,
): PredicateOutcome {
  const fg = parseCssColor(m.computedStyle.color)
  const bg = parseCssColor(m.computedStyle.backgroundColor)
  if (!fg || !bg) {
    return { pass: false, indeterminate: true, detail: `could not parse colors (color=${m.computedStyle.color}, bg=${m.computedStyle.backgroundColor})` }
  }
  // Any non-opaque channel makes the *effective* color depend on whatever is
  // composited behind this element — which a single element's computed style
  // can't tell us. Judging the raw RGB as if opaque would be a false verdict
  // (e.g. rgba(0,0,0,.5) text scored as full black), so we skip honestly.
  if (bg.a < 1 || fg.a < 1) {
    const which = bg.a < 1 && fg.a < 1 ? 'text and background are' : bg.a < 1 ? 'background is' : 'text color is'
    return { pass: false, indeterminate: true, detail: `${which} translucent on this element. Contrast not measurable here (depends on what is behind it)` }
  }
  // Element opacity washes out the rendered colors but getComputedStyle still
  // reports them opaque — judging the raw RGBs would false-pass a faded/disabled
  // state. Can't resolve the composited result from one element → skip honestly.
  const opacity = parseFloat(m.computedStyle.opacity)
  if (Number.isFinite(opacity) && opacity < 1) {
    return { pass: false, indeterminate: true, detail: `element opacity is ${opacity}. Rendered contrast is reduced and not measurable from computed colors alone` }
  }
  const ratio = contrastRatioValue(fg, bg)
  const pass = ratio >= min
  return {
    pass,
    detail: pass
      ? `contrast ${round(ratio)}:1 ≥ ${min}:1`
      : `contrast ${round(ratio)}:1 below ${min}:1`,
  }
}

// ─── Text predicate ─────────────────────────────────────────────────

/** Collapse whitespace + trim — DOM text vs literal comparison. */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Apply a CSS `text-transform` keyword to a string. Used by `textEquals` to
 * normalize BOTH sides, so a casing transform never decides the comparison.
 * `uppercase`/`lowercase` are exact; `capitalize` is a close approximation
 * (CSS uppercases the first letter of each word, leaving the rest). Any other
 * value (`none`, `full-width`, …) is the identity. Symmetric application is
 * what matters — both sides pass through the same function — so an approximate
 * `capitalize` still matches correctly.
 */
export function applyTextTransform(s: string, transform: string): string {
  switch ((transform || '').trim()) {
    case 'uppercase':
      return s.toUpperCase()
    case 'lowercase':
      return s.toLowerCase()
    case 'capitalize':
      // Uppercase the first letter after any non-alphanumeric boundary — CSS
      // `capitalize` breaks on punctuation too ("save-now" → "Save-Now"), not
      // just whitespace. The rest is left untouched, matching CSS. (Locale-
      // sensitive casing — e.g. Turkish i/İ — is NOT followed; default-locale
      // toUpperCase is used. Negligible outside `lang`-tagged non-Latin pages.)
      return s.replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase())
    default:
      return s
  }
}

/**
 * The element's text equals an expected literal — "make it say Y". Genuinely
 * deterministic (the LLM only supplies the expected literal from the goal).
 *
 * Compares AUTHORED text content (`m.textContent` — what the edit changes), then
 * applies the element's own CSS `text-transform` to BOTH the observed text and
 * the expected literal. That dissolves the casing ambiguity: a button whose
 * source is "save" but renders "SAVE" via `text-transform: uppercase` passes
 * whether the goal is phrased "save" or "SAVE", because both sides are
 * uppercased before comparison. (We don't read rendered `innerText` — it
 * corrupts casing AND leaks clip-based sr-only text, verified empirically.)
 */
export function textEquals(m: Measurements, expected: string): PredicateOutcome {
  const transform = m.computedStyle.textTransform
  const observed = normalizeText(applyTextTransform(m.textContent, transform))
  const want = normalizeText(applyTextTransform(expected, transform))
  const pass = observed === want
  return {
    pass,
    detail: pass
      ? `text equals ${JSON.stringify(want)}`
      : `text is ${JSON.stringify(observed)}, expected ${JSON.stringify(want)}`,
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────

/**
 * Args a translated predicate may carry. `other` is a SELECTOR the verifier
 * resolves to a secondary `Measurements` before dispatch (for the two-element
 * predicates). The scalar args come straight from the goal via the LLM.
 */
export interface PredicateArgs {
  /** Secondary element selector — required by `aligned` / `bboxMatches`. */
  other?: string
  axis?: AlignAxis
  tol?: number
  min?: number
  expected?: string
}

/** Whether a predicate needs a second element (`args.other`). */
export function needsSecondElement(name: PredicateName): boolean {
  return name === 'aligned' || name === 'bboxMatches'
}

/**
 * Judge one predicate over the primary element's measurements (`a`) and, for
 * the two-element predicates, a secondary element's (`b`). Pure — `a`/`b` are
 * already-fetched measurements, so the dispatcher does no I/O. Returns an
 * `indeterminate` outcome when an arg is missing rather than throwing, so a
 * bad translation degrades to a skip, not a crash.
 */
export function evaluatePredicate(
  name: PredicateName,
  args: PredicateArgs,
  a: Measurements,
  b?: Measurements | null,
): PredicateOutcome {
  switch (name) {
    case 'noOverflow':
      return noOverflow(a)
    case 'fitsViewport':
      return fitsViewport(a)
    case 'aligned':
      if (!b) return { pass: false, indeterminate: true, detail: `aligned: secondary element not found (${args.other ?? 'no selector'})` }
      if (!args.axis) return { pass: false, indeterminate: true, detail: `aligned: missing axis` }
      return aligned(a, b, args.axis, args.tol)
    case 'bboxMatches':
      if (!b) return { pass: false, indeterminate: true, detail: `bboxMatches: secondary element not found (${args.other ?? 'no selector'})` }
      return bboxMatches(a, b, args.tol)
    case 'contrastRatio':
      return contrastRatio(a, args.min)
    case 'textEquals':
      if (args.expected == null) return { pass: false, indeterminate: true, detail: `textEquals: missing expected text` }
      return textEquals(a, args.expected)
    default: {
      // Exhaustiveness guard — an unknown predicate name degrades to a skip.
      const _never: never = name
      return { pass: false, indeterminate: true, detail: `unknown predicate: ${String(_never)}` }
    }
  }
}
