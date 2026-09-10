/**
 * Tailwind class parser/serializer for the inspector's structured
 * sections (Spacing, Border, Color, Typography).
 *
 * **Why we parse classes back from a flat string list.** The bridge
 * gives us the live `classes` array off the selected element. The
 * inspector wants to show "padding = 4" not "p-4 px-2 pt-3 mr-1
 * rounded-md hover:bg-amber-200" — so we extract the structured
 * value, render a friendlier control, and on change emit a class
 * diff back through the existing `onClassesEdit` pipeline.
 *
 * **Scope of V1.** Cover the common designer-facing properties:
 *   - Spacing: padding, margin, gap (all-sides + per-axis variants)
 *   - Borders: width, radius, style, color
 *   - Colors: background, text, border-color
 *   - Typography: font size, weight, leading, tracking, alignment
 *
 * **Out of scope for V1.**
 *   - Responsive variants (`md:p-4`, `sm:hidden`) — left in the
 *     class list untouched. Designer can use the freeform Classes
 *     input for those.
 *   - State variants (`hover:`, `focus:`) — same.
 *   - Arbitrary values (`p-[10px]`, `bg-[#abc]`) — preserved on
 *     read; explicitly settable as a future enhancement.
 *   - Negative values (`-m-2`) — preserved on read; UI only emits
 *     non-negative values for now.
 *
 * The functions here are pure and synchronous so they can run inside
 * `useMemo` per render without performance concerns.
 */

/**
 * A diff to apply to a class list. Removed classes come out first;
 * added classes get appended (deduplicated against the post-removal
 * list). Used by every "set this property" interaction.
 */
export interface ClassMutation {
  remove: string[]
  add: string[]
}

/**
 * Apply a {@link ClassMutation} to a class list. Pure; returns a new
 * array. Order is preserved for unmodified classes; new classes go at
 * the end. Duplicates in `add` are filtered against the post-removal
 * list so we don't grow the list spuriously.
 */
export function applyClassMutation(
  classes: readonly string[],
  mutation: ClassMutation,
): string[] {
  const removeSet = new Set(mutation.remove)
  const next = classes.filter((c) => !removeSet.has(c))
  for (const cls of mutation.add) {
    if (cls.length > 0 && !next.includes(cls)) next.push(cls)
  }
  return next
}

// ── Variant axis (responsive breakpoints + interaction states) ─────
//
// The structured controls edit ONE variant context at a time. Breakpoint
// is a global viewport control (mobile/tablet/desktop, à la Webflow);
// state (hover/focus/dark) is a flat list in the inspector. The two
// compose into a Tailwind prefix (`md:hover:`).
//
// The trick that keeps every parser/mutator variant-agnostic: we
// `stripVariant` the class list down to the active context's base-form
// utilities BEFORE parsing, then `prefixMutation` the resulting diff back
// into variant-space. `applyClassMutation` against the FULL list then
// only ever touches that one context — base and sibling variants survive.

/** Responsive breakpoints, mobile-first ascending. */
export const BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"] as const
export type Breakpoint = (typeof BREAKPOINTS)[number]

/** Interaction/mode states surfaced as the flat state list. */
export const STATES = ["hover", "focus", "dark"] as const
export type VariantState = (typeof STATES)[number]

/** Active breakpoint context. `base` = no responsive prefix. */
export type ActiveBreakpoint = "base" | Breakpoint
/** Active state context. `default` = no state prefix. */
export type ActiveState = "default" | VariantState

/**
 * Compose the canonical Tailwind variant prefix for a (breakpoint, state)
 * pair. Tailwind's canonical order is responsive-then-state (`md:hover:`);
 * we emit that order so generated classes match how the parser strips them.
 * Returns `""` for base + default.
 */
export function composeVariant(
  breakpoint: ActiveBreakpoint = "base",
  state: ActiveState = "default",
): string {
  const parts: string[] = []
  if (breakpoint !== "base") parts.push(breakpoint)
  if (state !== "default") parts.push(state)
  return parts.join(":")
}

/**
 * Split a class into its variant chain + utility, treating only
 * bracket-depth-0 colons as variant separators so colons inside arbitrary
 * values (`text-[color:red]`, `bg-[var(--x)]`) are NOT mistaken for
 * variants. The utility is the final segment; everything before it is the
 * variant chain.
 */
export function parseVariantChain(cls: string): {
  variants: string[]
  utility: string
} {
  const segments: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < cls.length; i++) {
    const ch = cls[i]
    if (ch === "[" || ch === "(") depth++
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1)
    else if (ch === ":" && depth === 0) {
      segments.push(cls.slice(start, i))
      start = i + 1
    }
  }
  segments.push(cls.slice(start))
  const utility = segments.pop() ?? cls
  return { variants: segments, utility }
}

/**
 * Return the base-form (prefix-stripped) classes that belong to the active
 * variant. `variant === ""` selects classes with NO variant prefix. The
 * returned utilities feed the existing variant-agnostic parsers unchanged.
 */
export function stripVariant(
  classes: readonly string[],
  variant: string,
): string[] {
  const out: string[] = []
  for (const cls of classes) {
    const { variants, utility } = parseVariantChain(cls)
    if (variants.join(":") === variant) out.push(utility)
  }
  return out
}

/**
 * Re-apply `variant` as a prefix to BOTH sides of a base mutation, so the
 * diff stays in variant-space. Applied against the full class list,
 * `applyClassMutation` then only removes/adds that context's classes —
 * base and sibling variants are untouched. No-op for the base context.
 */
export function prefixMutation(
  mutation: ClassMutation,
  variant: string,
): ClassMutation {
  if (variant === "") return mutation
  const prefix = (cls: string) => (cls.length > 0 ? `${variant}:${cls}` : cls)
  return {
    remove: mutation.remove.map(prefix),
    add: mutation.add.map(prefix),
  }
}

/**
 * Apply a section's scoped-next class list back onto the FULL list,
 * order-preservingly. The structured sections are variant-agnostic: they
 * receive `stripVariant`-ed classes and emit the next scoped list. This
 * diffs old-vs-next *within the variant context* and applies only that
 * delta (re-prefixed) to the full list — so base + sibling variants keep
 * their position and only the edited context's classes change. Used as
 * the single choke point that threads the variant axis through every
 * section without each section knowing about variants.
 */
export function applyScopedChange(
  fullClasses: readonly string[],
  variant: string,
  scopedBefore: readonly string[],
  scopedNext: readonly string[],
): string[] {
  const beforeSet = new Set(scopedBefore)
  const nextSet = new Set(scopedNext)
  const remove = scopedBefore.filter((c) => !nextSet.has(c))
  const add = scopedNext.filter((c) => !beforeSet.has(c))
  return applyClassMutation(
    fullClasses,
    prefixMutation({ remove, add }, variant),
  )
}

/**
 * Which recognized breakpoints / states appear anywhere in the class
 * list's variant chains. Drives the "this context has overrides" badges
 * on the breakpoint control and the state list.
 */
export function presentVariants(classes: readonly string[]): {
  breakpoints: Breakpoint[]
  states: VariantState[]
} {
  const bps = new Set<string>()
  const sts = new Set<string>()
  for (const cls of classes) {
    for (const v of parseVariantChain(cls).variants) {
      bps.add(v)
      sts.add(v)
    }
  }
  return {
    breakpoints: BREAKPOINTS.filter((b) => bps.has(b)),
    states: STATES.filter((s) => sts.has(s)),
  }
}

/**
 * A `<Select>` option. The structured controls render fixed option sets,
 * but a parsed value can be outside that set (numeric leading `6`,
 * arbitrary `[13px]`). {@link withArbitraryOption} injects the current
 * value as a synthetic option so Radix can display it without losing it.
 */
export interface SelectOption {
  value: string
  label: string
}

/**
 * Ensure `current` is selectable: if it isn't `null`/`"__unset"` and isn't
 * already one of `options`, prepend it as its own option (labelled with the
 * value, so `[13px]` shows literally). Keeps out-of-set parsed values
 * visible and editable instead of silently reading as "—".
 */
export function withArbitraryOption(
  options: readonly SelectOption[],
  current: string | null | undefined,
): SelectOption[] {
  if (
    current == null ||
    current === "__unset" ||
    options.some((o) => o.value === current)
  ) {
    return [...options]
  }
  return [{ value: current, label: current }, ...options]
}

// ── Tailwind v4 spacing scale ──────────────────────────────────────

/**
 * Tailwind's default spacing scale. The values designers pick from in
 * the inspector. We keep them as a list (not a continuous number)
 * because Tailwind doesn't ship classes for arbitrary integers — only
 * the scale steps below resolve to a built-in utility.
 *
 * Half-steps (`0.5`, `1.5`, `2.5`, `3.5`) are included because they're
 * common in tight UIs (4-pixel grids etc.).
 */
export const SPACING_SCALE: readonly number[] = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5,
  4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16,
  20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64,
  72, 80, 96,
]

/**
 * Format a scale step into the suffix Tailwind expects. `0.5` → `0.5`,
 * `4` → `4`. Returns the raw string used in classes like `p-{x}`.
 */
function formatStep(step: number): string {
  return Number.isInteger(step) ? String(step) : String(step)
}

/**
 * Snap an arbitrary number to the nearest valid spacing-scale step.
 * Used by number-input controls so designers can type "5" and get
 * `p-5`. Numbers outside the scale (e.g., 100) snap to the closest
 * available step (96).
 */
export function snapToSpacingScale(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  let closest = SPACING_SCALE[0]
  let diff = Math.abs(n - closest)
  for (const step of SPACING_SCALE) {
    const d = Math.abs(n - step)
    if (d < diff) {
      diff = d
      closest = step
    }
  }
  return closest
}

// ── Spacing parsers ────────────────────────────────────────────────

/**
 * The structured value extracted from a class list for ONE spacing
 * property (padding / margin / gap). The parser surfaces both the
 * "all-sides" shorthand value AND any per-side overrides so the UI
 * can render mixed states (e.g., "padding: mixed (px-4 pt-2 pb-6)").
 *
 * `step` is the numeric scale value of the LAST matching class
 * (so the displayed value reflects what wins in the cascade);
 * `raws` is every matching class for that side, so the mutator
 * removes ALL of them — not just one — when the designer commits a
 * change. Without this, a class list like `p-2 p-4` (which can
 * happen if a prior edit left a duplicate) would only have the
 * second match removed and leave the first behind, producing a
 * stale state on save (codex P2).
 */
export interface SpacingSides {
  /** All-sides shorthand (`p-{n}` / `m-{n}` / `gap-{n}`). */
  all: { step: number; raws: string[] } | null
  /** X-axis (`px-{n}` / `mx-{n}` / `gap-x-{n}`). */
  x: { step: number; raws: string[] } | null
  /** Y-axis (`py-{n}` / `my-{n}` / `gap-y-{n}`). */
  y: { step: number; raws: string[] } | null
  top: { step: number; raws: string[] } | null
  right: { step: number; raws: string[] } | null
  bottom: { step: number; raws: string[] } | null
  left: { step: number; raws: string[] } | null
  /**
   * Classes the parser saw but couldn't decompose (responsive,
   * state-variant, arbitrary-value, negative). Preserved on edit so
   * we don't accidentally strip them.
   */
  preservedRaw: string[]
}

const EMPTY_SIDES: SpacingSides = {
  all: null,
  x: null,
  y: null,
  top: null,
  right: null,
  bottom: null,
  left: null,
  preservedRaw: [],
}

/**
 * Build a regex that matches simple Tailwind spacing classes for a
 * given property prefix. Matches `<prefix>-<step>` where step is a
 * member of the spacing scale. Skips responsive / state / negative /
 * arbitrary forms.
 */
function spacingRegex(prefix: string): RegExp {
  const steps = SPACING_SCALE.map((s) => formatStep(s).replace(".", "\\."))
  // Anchor: nothing before the prefix (no `:` or `-`), step at the
  // very end of the class. Matches `p-4` but not `hover:p-4` or `-p-4`.
  return new RegExp(`^${prefix}-(${steps.join("|")})$`)
}

/**
 * Parse padding classes out of a class list. Emits a {@link SpacingSides}
 * with whichever sides were set; everything else is in `preservedRaw`.
 */
const PADDING_PREFIXES: SpacingPrefixMap = {
  all: "p",
  x: "px",
  y: "py",
  top: "pt",
  right: "pr",
  bottom: "pb",
  left: "pl",
}

const MARGIN_PREFIXES: SpacingPrefixMap = {
  all: "m",
  x: "mx",
  y: "my",
  top: "mt",
  right: "mr",
  bottom: "mb",
  left: "ml",
}

export function parsePadding(classes: readonly string[]): SpacingSides {
  return parseSpacing(classes, PADDING_PREFIXES)
}

export function parseMargin(classes: readonly string[]): SpacingSides {
  return parseSpacing(classes, MARGIN_PREFIXES)
}

export function parseGap(classes: readonly string[]): SpacingSides {
  // Gap doesn't have per-side, only per-axis. Map per-side to null
  // and only fill all/x/y.
  const result = parseSpacing(classes, {
    all: "gap",
    x: "gap-x",
    y: "gap-y",
    top: "__never_matches_top",
    right: "__never_matches_right",
    bottom: "__never_matches_bottom",
    left: "__never_matches_left",
  })
  return result
}

interface SpacingPrefixMap {
  all: string
  x: string
  y: string
  top: string
  right: string
  bottom: string
  left: string
}

function parseSpacing(
  classes: readonly string[],
  prefixes: SpacingPrefixMap,
): SpacingSides {
  const out: SpacingSides = { ...EMPTY_SIDES, preservedRaw: [] }
  const reAll = spacingRegex(prefixes.all)
  const reX = spacingRegex(prefixes.x)
  const reY = spacingRegex(prefixes.y)
  const reT = spacingRegex(prefixes.top)
  const reR = spacingRegex(prefixes.right)
  const reB = spacingRegex(prefixes.bottom)
  const reL = spacingRegex(prefixes.left)

  for (const cls of classes) {
    const matched =
      tryAssign(cls, reAll, "all", out) ||
      tryAssign(cls, reX, "x", out) ||
      tryAssign(cls, reY, "y", out) ||
      tryAssign(cls, reT, "top", out) ||
      tryAssign(cls, reR, "right", out) ||
      tryAssign(cls, reB, "bottom", out) ||
      tryAssign(cls, reL, "left", out)
    if (matched) continue
    // Not a simple match — does it LOOK like a class for this
    // property family (responsive / state / arbitrary)? If so,
    // preserve it on the side. Otherwise leave it alone (it's some
    // other family, the parser doesn't own it).
    if (looksRelated(cls, prefixes)) {
      out.preservedRaw.push(cls)
    }
  }
  return out
}

function tryAssign(
  cls: string,
  re: RegExp,
  side: keyof Omit<SpacingSides, "preservedRaw">,
  out: SpacingSides,
): boolean {
  const m = re.exec(cls)
  if (!m) return false
  const step = parseFloat(m[1])
  // Accumulate ALL matching classes for this side. The displayed
  // step reflects the LAST match (cascade-correct), but every match
  // ends up in `raws` so the mutator removes them all on commit
  // (codex P2 fix: a class list with `p-2 p-4` previously dropped
  // only `p-4` on remove and left `p-2` stale).
  const existing = out[side]
  if (existing) {
    out[side] = { step, raws: [...existing.raws, cls] }
  } else {
    out[side] = { step, raws: [cls] }
  }
  return true
}

function looksRelated(cls: string, prefixes: SpacingPrefixMap): boolean {
  // Match patterns like `md:p-4`, `hover:px-2`, `-m-2`, `p-[10px]`.
  // Anything that contains the prefix as a recognizable token but
  // didn't match the strict simple form.
  const allPrefixes = [
    prefixes.all, prefixes.x, prefixes.y,
    prefixes.top, prefixes.right, prefixes.bottom, prefixes.left,
  ]
  for (const p of allPrefixes) {
    if (cls.startsWith(p + "-") || cls.startsWith("-" + p + "-")) return true
    // Responsive / state variant prefix?
    if (cls.includes(":" + p + "-") || cls.includes(":-" + p + "-")) return true
  }
  return false
}

// ── Spacing mutators ───────────────────────────────────────────────

/**
 * Build a mutation that sets the all-sides padding to `step` (or
 * clears it when `step === null`). Removes ALL existing padding
 * classes the parser owns (per-side, per-axis, all-sides) so the
 * resulting state matches the designer's intent: "I set padding =
 * 4 → I want `p-4`, not `p-4 + lingering pt-2`."
 *
 * Preserved classes (responsive / state / arbitrary) stay put — the
 * mutation never touches them.
 */
export function setPaddingAll(
  current: SpacingSides,
  step: number | null,
): ClassMutation {
  return setSpacingAll(current, step, "p")
}

export function setMarginAll(
  current: SpacingSides,
  step: number | null,
): ClassMutation {
  return setSpacingAll(current, step, "m")
}

export function setGapAll(
  current: SpacingSides,
  step: number | null,
): ClassMutation {
  return setSpacingAll(current, step, "gap")
}

function setSpacingAll(
  current: SpacingSides,
  step: number | null,
  prefix: string,
): ClassMutation {
  const remove: string[] = []
  for (const side of ["all", "x", "y", "top", "right", "bottom", "left"] as const) {
    const v = current[side]
    if (v) remove.push(...v.raws)
  }
  const add: string[] = []
  if (step !== null) {
    add.push(`${prefix}-${formatStep(step)}`)
  }
  return { remove, add }
}

// ── Per-side spacing (Figma-style mixed editing) ───────────────────

export type SpacingSide = "top" | "right" | "bottom" | "left"

/** Effective per-side spacing after applying the all → axis → side cascade. */
export interface ResolvedSpacingSides {
  top: number | null
  right: number | null
  bottom: number | null
  left: number | null
}

/**
 * Collapse a {@link SpacingSides} into the four effective per-side values
 * by applying the Tailwind cascade: a per-side class (`pt-2`) wins over its
 * axis (`py-3`), which wins over the all-sides shorthand (`p-4`). A side
 * with no owning class resolves to `null` (unset — inherits whatever the
 * substrate's own CSS provides). This is what the per-side inputs display
 * and what {@link setSpacingSide} edits against.
 */
export function resolveSpacingSides(current: SpacingSides): ResolvedSpacingSides {
  const pick = (side: SpacingSide, axis: "x" | "y"): number | null =>
    current[side]?.step ?? current[axis]?.step ?? current.all?.step ?? null
  return {
    top: pick("top", "y"),
    right: pick("right", "x"),
    bottom: pick("bottom", "y"),
    left: pick("left", "x"),
  }
}

/**
 * Serialize four resolved sides back to the MINIMAL Tailwind class set:
 * all-equal → `p-{n}`; symmetric axes → `px-{n} py-{n}`; otherwise the
 * fewest per-side/per-axis classes needed. Unset sides (`null`) emit no
 * class so they keep inheriting the substrate's own styling.
 */
function serializeSides(
  sides: ResolvedSpacingSides,
  p: SpacingPrefixMap,
): string[] {
  const { top, right, bottom, left } = sides
  const allEqual =
    top !== null && top === right && right === bottom && bottom === left
  if (allEqual) return [`${p.all}-${formatStep(top)}`]

  const add: string[] = []
  // X axis (left / right).
  if (left !== null && left === right) {
    add.push(`${p.x}-${formatStep(left)}`)
  } else {
    if (left !== null) add.push(`${p.left}-${formatStep(left)}`)
    if (right !== null) add.push(`${p.right}-${formatStep(right)}`)
  }
  // Y axis (top / bottom).
  if (top !== null && top === bottom) {
    add.push(`${p.y}-${formatStep(top)}`)
  } else {
    if (top !== null) add.push(`${p.top}-${formatStep(top)}`)
    if (bottom !== null) add.push(`${p.bottom}-${formatStep(bottom)}`)
  }
  return add
}

/**
 * Set ONE side to `step` (or clear it with `null`), re-deriving the
 * minimal class set from the cascade-resolved current state. Removes every
 * owned class (all/axis/side) and re-emits — so editing one side never
 * leaves a stale shorthand behind.
 */
function setSpacingSide(
  current: SpacingSides,
  side: SpacingSide,
  step: number | null,
  p: SpacingPrefixMap,
): ClassMutation {
  const resolved = resolveSpacingSides(current)
  resolved[side] = step
  const remove: string[] = []
  for (const s of ["all", "x", "y", "top", "right", "bottom", "left"] as const) {
    const v = current[s]
    if (v) remove.push(...v.raws)
  }
  return { remove, add: serializeSides(resolved, p) }
}

export function setPaddingSide(
  current: SpacingSides,
  side: SpacingSide,
  step: number | null,
): ClassMutation {
  return setSpacingSide(current, side, step, PADDING_PREFIXES)
}

export function setMarginSide(
  current: SpacingSides,
  side: SpacingSide,
  step: number | null,
): ClassMutation {
  return setSpacingSide(current, side, step, MARGIN_PREFIXES)
}

// ── Border helpers ─────────────────────────────────────────────────

/**
 * V1 border width values designers can pick from. `0` means "no
 * border" (`border-0`); `1` is the bare `border` keyword (Tailwind's
 * default 1px); 2/4/8 are the standard width steps.
 */
export const BORDER_WIDTHS: readonly number[] = [0, 1, 2, 4, 8]

/**
 * V1 border radius sizes. `none` clears; `default` is the bare
 * `rounded` keyword. Per-corner radii are escape-hatched to the
 * Classes input.
 */
export const BORDER_RADII: readonly string[] = [
  "none", "sm", "default", "md", "lg", "xl", "2xl", "3xl", "full",
]

/** V1 border styles. */
export const BORDER_STYLES: readonly string[] = [
  "solid", "dashed", "dotted", "double", "none",
]

interface BorderWidthEntry {
  value: number
  raws: string[]
}
interface BorderRadiusEntry {
  value: string
  raws: string[]
}

/**
 * Per-side border widths (Figma-style mixed editing). `x`/`y` are the
 * Tailwind axis shorthands (`border-x-2` → left+right); the four physical
 * sides are the per-side classes (`border-t-2`). The all-sides width lives
 * on {@link BorderValue.width}. Logical sides (`border-s`/`border-e`) stay
 * in `preservedRaw`.
 */
export interface BorderWidthSides {
  x?: BorderWidthEntry
  y?: BorderWidthEntry
  top?: BorderWidthEntry
  right?: BorderWidthEntry
  bottom?: BorderWidthEntry
  left?: BorderWidthEntry
}

/**
 * Per-corner / per-side border radii. The four corners are the per-corner
 * classes (`rounded-tl-md`); the four sides are the side shorthands
 * (`rounded-t-md` → top-left + top-right). The all-corners radius lives on
 * {@link BorderValue.radius}. Logical corners (`rounded-ss` etc.) stay in
 * `preservedRaw`.
 */
export interface BorderRadiusParts {
  top?: BorderRadiusEntry
  right?: BorderRadiusEntry
  bottom?: BorderRadiusEntry
  left?: BorderRadiusEntry
  topLeft?: BorderRadiusEntry
  topRight?: BorderRadiusEntry
  bottomRight?: BorderRadiusEntry
  bottomLeft?: BorderRadiusEntry
}

export interface BorderValue {
  width: { value: number; raws: string[] } | null
  radius: { value: string; raws: string[] } | null
  style: { value: string; raws: string[] } | null
  /** Per-side widths (`border-t-2`, `border-x`), cascade-resolved by the UI. */
  widthSides: BorderWidthSides
  /** Per-corner / per-side radii (`rounded-tl-md`, `rounded-t`). */
  radiusParts: BorderRadiusParts
  /** Responsive / state / logical-side / arbitrary, preserved untouched. */
  preservedRaw: string[]
}

/**
 * Build the regex set up-front so each parse call doesn't re-compile.
 * Border width: `border` alone OR `border-<int>` where int is one of
 * the allowed widths. Style: `border-<style>` where style is one of
 * the keywords. Radius: `rounded` alone OR `rounded-<size>`. The
 * tighter regexes specifically EXCLUDE the color shapes Phase B
 * owns (`border-{family}-{shade}`).
 */
const BORDER_WIDTH_RE = (() => {
  const ints = BORDER_WIDTHS.filter((n) => n !== 1)
    .map((n) => String(n))
    .join("|")
  return new RegExp(`^border(?:-(${ints}))?$`)
})()
const BORDER_STYLE_RE = new RegExp(`^border-(${BORDER_STYLES.join("|")})$`)
const BORDER_RADIUS_SIZES = BORDER_RADII.filter((s) => s !== "default").join("|")
const BORDER_RADIUS_RE = new RegExp(`^rounded(?:-(${BORDER_RADIUS_SIZES}))?$`)
// Per-side widths: `border-t` / `border-t-2` / `border-x` … (clean V1 steps
// only). Bare → 1. Arbitrary / off-scale per-side values fall through to
// BORDER_PRESERVE_RE so they're surfaced, not silently dropped.
const BORDER_WIDTH_SIDE_RE = (() => {
  const ints = BORDER_WIDTHS.filter((n) => n !== 1)
    .map((n) => String(n))
    .join("|")
  return new RegExp(`^border-(t|r|b|l|x|y)(?:-(${ints}))?$`)
})()
// Per-corner radii: `rounded-tl` / `rounded-tl-md` …. Bare → default.
const BORDER_RADIUS_CORNER_RE = new RegExp(
  `^rounded-(tl|tr|br|bl)(?:-(${BORDER_RADIUS_SIZES}))?$`,
)
// Per-side radii (side shorthands): `rounded-t` / `rounded-t-md` …. Each
// side shorthand covers its two corners (`rounded-t` → top-left + top-right).
const BORDER_RADIUS_SIDE_RE = new RegExp(
  `^rounded-(t|r|b|l)(?:-(${BORDER_RADIUS_SIZES}))?$`,
)

const BORDER_WIDTH_SIDE_KEYS: Record<string, keyof BorderWidthSides> = {
  t: "top", r: "right", b: "bottom", l: "left", x: "x", y: "y",
}
const BORDER_RADIUS_SIDE_KEYS: Record<string, keyof BorderRadiusParts> = {
  t: "top", r: "right", b: "bottom", l: "left",
}
const BORDER_RADIUS_CORNER_KEYS: Record<string, keyof BorderRadiusParts> = {
  tl: "topLeft", tr: "topRight", br: "bottomRight", bl: "bottomLeft",
}

/**
 * Preservation regex — fires on classes that LOOK like border / rounded
 * utilities the simple width/style/radius selects don't own (per-side
 * width including logical s/e, per-corner including logical ss/se/es/ee,
 * responsive / state variants, arbitrary values). The anchor `(?:$|-)`
 * after the side/corner group prevents false matches on size keywords
 * — `rounded-sm` reads as `rounded-(sm)` (a size, owned by the radius
 * select) rather than `rounded-s` followed by `m` (codex P2 round 2:
 * the previous `[trblxy](-\d+)?` form silently dropped logical-side
 * widths and logical-corner radii from the preserved-class hint).
 */
const BORDER_PRESERVE_RE =
  /^(?:border-(?:t|r|b|l|x|y|s|e)(?:$|-)|rounded-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee)(?:$|-)|.*:border|.*:rounded|-border-|-rounded-|border-\[|rounded-\[)/

/**
 * Parse border-related classes (width/radius/style only — color is
 * Phase B's territory). Color classes (`border-amber-500`) are
 * IGNORED here so we don't collide with the color section's
 * authoritative state.
 */
export function parseBorder(classes: readonly string[]): BorderValue {
  const out: BorderValue = {
    width: null,
    radius: null,
    style: null,
    widthSides: {},
    radiusParts: {},
    preservedRaw: [],
  }

  for (const cls of classes) {
    const widthMatch = BORDER_WIDTH_RE.exec(cls)
    if (widthMatch) {
      // Bare `border` → width 1; otherwise capture group has the int.
      const value = widthMatch[1] ? parseInt(widthMatch[1], 10) : 1
      out.width = out.width
        ? { value, raws: [...out.width.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    const widthSideMatch = BORDER_WIDTH_SIDE_RE.exec(cls)
    if (widthSideMatch) {
      const key = BORDER_WIDTH_SIDE_KEYS[widthSideMatch[1]]
      const value = widthSideMatch[2] ? parseInt(widthSideMatch[2], 10) : 1
      const prev = out.widthSides[key]
      out.widthSides[key] = prev
        ? { value, raws: [...prev.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    const styleMatch = BORDER_STYLE_RE.exec(cls)
    if (styleMatch) {
      const value = styleMatch[1]
      out.style = out.style
        ? { value, raws: [...out.style.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    const radiusMatch = BORDER_RADIUS_RE.exec(cls)
    if (radiusMatch) {
      const value = radiusMatch[1] ?? "default"
      out.radius = out.radius
        ? { value, raws: [...out.radius.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    const radiusCornerMatch = BORDER_RADIUS_CORNER_RE.exec(cls)
    if (radiusCornerMatch) {
      const key = BORDER_RADIUS_CORNER_KEYS[radiusCornerMatch[1]]
      const value = radiusCornerMatch[2] ?? "default"
      const prev = out.radiusParts[key]
      out.radiusParts[key] = prev
        ? { value, raws: [...prev.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    const radiusSideMatch = BORDER_RADIUS_SIDE_RE.exec(cls)
    if (radiusSideMatch) {
      const key = BORDER_RADIUS_SIDE_KEYS[radiusSideMatch[1]]
      const value = radiusSideMatch[2] ?? "default"
      const prev = out.radiusParts[key]
      out.radiusParts[key] = prev
        ? { value, raws: [...prev.raws, cls] }
        : { value, raws: [cls] }
      continue
    }
    // Anything that LOOKS like border / rounded but didn't match a
    // structured form (logical-side `border-s`, arbitrary value,
    // responsive / state variant, negative) is preserved.
    if (BORDER_PRESERVE_RE.test(cls)) {
      out.preservedRaw.push(cls)
    }
  }
  return out
}

export function setBorderWidth(
  current: BorderValue,
  width: number | null,
): ClassMutation {
  // Setting the all-sides width resets every per-side override too, so the
  // single value the designer picked actually takes hold on all four sides.
  const remove = collectWidthRaws(current)
  if (width === null) return { remove, add: [] }
  return { remove, add: [borderWidthClass("border", width)] }
}

export function setBorderStyle(
  current: BorderValue,
  style: string | null,
): ClassMutation {
  const remove = current.style ? [...current.style.raws] : []
  if (style === null) return { remove, add: [] }
  return { remove, add: [`border-${style}`] }
}

export function setBorderRadius(
  current: BorderValue,
  radius: string | null,
): ClassMutation {
  // As with width: the all-corners radius wipes per-corner / per-side
  // overrides so it applies uniformly.
  const remove = collectRadiusRaws(current)
  if (radius === null) return { remove, add: [] }
  return { remove, add: [borderRadiusClass("rounded", radius)] }
}

// ── Per-side border width / per-corner radius (Figma-style mixed editing) ──

export type BorderSide = "top" | "right" | "bottom" | "left"
export type BorderCorner = "topLeft" | "topRight" | "bottomRight" | "bottomLeft"

export interface ResolvedBorderWidthSides {
  top: number | null
  right: number | null
  bottom: number | null
  left: number | null
}
export interface ResolvedBorderRadiusCorners {
  topLeft: string | null
  topRight: string | null
  bottomRight: string | null
  bottomLeft: string | null
}

/** Class for a width on a given prefix: `1` → bare keyword, else `prefix-n`. */
function borderWidthClass(prefix: string, value: number): string {
  return value === 1 ? prefix : `${prefix}-${value}`
}
/** Class for a radius on a given prefix: `default` → bare, else `prefix-size`. */
function borderRadiusClass(prefix: string, value: string): string {
  return value === "default" ? prefix : `${prefix}-${value}`
}

function collectWidthRaws(current: BorderValue): string[] {
  const remove: string[] = []
  if (current.width) remove.push(...current.width.raws)
  for (const k of ["x", "y", "top", "right", "bottom", "left"] as const) {
    const v = current.widthSides[k]
    if (v) remove.push(...v.raws)
  }
  return remove
}
function collectRadiusRaws(current: BorderValue): string[] {
  const remove: string[] = []
  if (current.radius) remove.push(...current.radius.raws)
  for (const k of [
    "top", "right", "bottom", "left",
    "topLeft", "topRight", "bottomRight", "bottomLeft",
  ] as const) {
    const v = current.radiusParts[k]
    if (v) remove.push(...v.raws)
  }
  return remove
}

/**
 * Collapse per-side widths into four effective values via the Tailwind
 * cascade: per-side (`border-t-2`) wins over axis (`border-x-2`), which wins
 * over the all-sides width (`border-2`). Unowned sides resolve to `null`.
 */
export function resolveBorderWidthSides(
  current: BorderValue,
): ResolvedBorderWidthSides {
  const all = current.width?.value ?? null
  const pick = (side: BorderSide, axis: "x" | "y"): number | null =>
    current.widthSides[side]?.value ?? current.widthSides[axis]?.value ?? all
  return {
    top: pick("top", "y"),
    right: pick("right", "x"),
    bottom: pick("bottom", "y"),
    left: pick("left", "x"),
  }
}

/**
 * Collapse radius parts into four effective corners. Per-corner
 * (`rounded-tl-md`) wins over a side shorthand (`rounded-t-md`), which wins
 * over the all-corners radius. Where two side shorthands cover the same
 * corner the Tailwind emission order (t, r, b, l — later wins) decides:
 * for top-left, `rounded-l` beats `rounded-t`.
 */
export function resolveBorderRadiusCorners(
  current: BorderValue,
): ResolvedBorderRadiusCorners {
  const p = current.radiusParts
  const all = current.radius?.value ?? null
  return {
    topLeft: p.topLeft?.value ?? p.left?.value ?? p.top?.value ?? all,
    topRight: p.topRight?.value ?? p.right?.value ?? p.top?.value ?? all,
    bottomRight: p.bottomRight?.value ?? p.bottom?.value ?? p.right?.value ?? all,
    bottomLeft: p.bottomLeft?.value ?? p.left?.value ?? p.bottom?.value ?? all,
  }
}

/** Serialize four resolved widths to the minimal class set (mirrors padding). */
function serializeBorderWidthSides(sides: ResolvedBorderWidthSides): string[] {
  const { top, right, bottom, left } = sides
  const allEqual =
    top !== null && top === right && right === bottom && bottom === left
  if (allEqual) return [borderWidthClass("border", top)]

  const add: string[] = []
  if (left !== null && left === right) {
    add.push(borderWidthClass("border-x", left))
  } else {
    if (left !== null) add.push(borderWidthClass("border-l", left))
    if (right !== null) add.push(borderWidthClass("border-r", right))
  }
  if (top !== null && top === bottom) {
    add.push(borderWidthClass("border-y", top))
  } else {
    if (top !== null) add.push(borderWidthClass("border-t", top))
    if (bottom !== null) add.push(borderWidthClass("border-b", bottom))
  }
  return add
}

/**
 * Serialize four resolved corners. All-equal collapses to `rounded`; else
 * each non-null corner emits its own class. Corner shorthands overlap on the
 * side axes, so (unlike padding's x/y pairing) we don't collapse to
 * `rounded-t` — emitting a side shorthand would double-set the shared corner.
 */
function serializeBorderRadiusCorners(
  corners: ResolvedBorderRadiusCorners,
): string[] {
  const { topLeft, topRight, bottomRight, bottomLeft } = corners
  const allEqual =
    topLeft !== null &&
    topLeft === topRight &&
    topRight === bottomRight &&
    bottomRight === bottomLeft
  if (allEqual) return [borderRadiusClass("rounded", topLeft)]

  const add: string[] = []
  if (topLeft !== null) add.push(borderRadiusClass("rounded-tl", topLeft))
  if (topRight !== null) add.push(borderRadiusClass("rounded-tr", topRight))
  if (bottomRight !== null) add.push(borderRadiusClass("rounded-br", bottomRight))
  if (bottomLeft !== null) add.push(borderRadiusClass("rounded-bl", bottomLeft))
  return add
}

/** Set ONE border-width side (or clear with `null`), re-deriving minimally. */
export function setBorderWidthSide(
  current: BorderValue,
  side: BorderSide,
  width: number | null,
): ClassMutation {
  const resolved = resolveBorderWidthSides(current)
  resolved[side] = width
  return {
    remove: collectWidthRaws(current),
    add: serializeBorderWidthSides(resolved),
  }
}

/** Set ONE border-radius corner (or clear with `null`), re-deriving minimally. */
export function setBorderRadiusCorner(
  current: BorderValue,
  corner: BorderCorner,
  radius: string | null,
): ClassMutation {
  const resolved = resolveBorderRadiusCorners(current)
  resolved[corner] = radius
  return {
    remove: collectRadiusRaws(current),
    add: serializeBorderRadiusCorners(resolved),
  }
}

// ── Typography helpers ─────────────────────────────────────────────

/** Tailwind v4 default font-size scale. */
export const FONT_SIZES: readonly string[] = [
  "xs", "sm", "base", "lg", "xl",
  "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl",
]

/** Font weights, ordered light → heavy. */
export const FONT_WEIGHTS: readonly string[] = [
  "thin", "extralight", "light", "normal",
  "medium", "semibold", "bold", "extrabold", "black",
]

/** Font families Tailwind ships as utilities. */
export const FONT_FAMILIES: readonly string[] = ["sans", "serif", "mono"]

/**
 * Line-height (leading) values. Named values are V1; numeric leading
 * (`leading-{n}` where n is on the spacing scale) is preserved on
 * parse but not surfaced in the V1 select.
 */
export const LEADING_VALUES: readonly string[] = [
  "none", "tight", "snug", "normal", "relaxed", "loose",
]

/** Letter-spacing (tracking) values. */
export const TRACKING_VALUES: readonly string[] = [
  "tighter", "tight", "normal", "wide", "wider", "widest",
]

/**
 * Text alignment values. `start` / `end` honor `direction: rtl`;
 * `left` / `right` are physical. Both shown.
 */
export const TEXT_ALIGNMENTS: readonly string[] = [
  "left", "center", "right", "justify", "start", "end",
]

export interface TypographyValue {
  size: { value: string; raws: string[] } | null
  weight: { value: string; raws: string[] } | null
  family: { value: string; raws: string[] } | null
  leading: { value: string; raws: string[] } | null
  tracking: { value: string; raws: string[] } | null
  align: { value: string; raws: string[] } | null
  preservedRaw: string[]
}

/** Pre-compiled regexes — same hygiene as the Border section. */
const FONT_SIZE_RE = new RegExp(`^text-(${FONT_SIZES.join("|")})$`)
const FONT_WEIGHT_RE = new RegExp(`^font-(${FONT_WEIGHTS.join("|")})$`)
const FONT_FAMILY_RE = new RegExp(`^font-(${FONT_FAMILIES.join("|")})$`)
const LEADING_RE = new RegExp(`^leading-(${LEADING_VALUES.join("|")})$`)
const TRACKING_RE = new RegExp(`^tracking-(${TRACKING_VALUES.join("|")})$`)
const TEXT_ALIGN_RE = new RegExp(`^text-(${TEXT_ALIGNMENTS.join("|")})$`)

// Representable-but-non-named forms the controls now surface accurately
// (rather than dumping into `preservedRaw` with a leaky hint).
//   • numeric leading:    leading-6, leading-3.5
//   • arbitrary value:    text-[13px], leading-[1.6], tracking-[0.1em]
// The arbitrary token is captured WITH its brackets so the matching
// setter (`text-${value}`) round-trips it verbatim. The size-arbitrary
// matcher requires a numeric/length-looking inner value so it never
// steals a color (`text-[#abc]`, `text-[var(--x)]`) from the Color
// section.
const FONT_SIZE_ARBITRARY_RE = /^text-(\[-?\.?\d[^\]]*\])$/
const LEADING_NUMERIC_RE = /^leading-(\d[\d.]*)$/
const LEADING_ARBITRARY_RE = /^leading-(\[[^\]]*\])$/
const TRACKING_ARBITRARY_RE = /^tracking-(\[[^\]]*\])$/

/**
 * Match preserved typography variants the controls still don't own
 * (e.g. negative tracking). Numeric leading, arbitrary values, and
 * font-family are now captured into their fields, so they're no longer
 * listed here.
 */
const TYPOGRAPHY_PRESERVE_RE = /^(?:tracking-\[?-|font-\[)/

export function parseTypography(classes: readonly string[]): TypographyValue {
  const out: TypographyValue = {
    size: null,
    weight: null,
    family: null,
    leading: null,
    tracking: null,
    align: null,
    preservedRaw: [],
  }

  type ValueField = "size" | "weight" | "family" | "leading" | "tracking" | "align"
  const assign = (field: ValueField, value: string, cls: string) => {
    const existing = out[field]
    out[field] = existing
      ? { value, raws: [...existing.raws, cls] }
      : { value, raws: [cls] }
  }

  for (const cls of classes) {
    // Order matters: strict named matchers first, then numeric/arbitrary.
    let match = FONT_SIZE_RE.exec(cls) ?? FONT_SIZE_ARBITRARY_RE.exec(cls)
    if (match) {
      assign("size", match[1], cls)
      continue
    }
    match = TEXT_ALIGN_RE.exec(cls)
    if (match) {
      assign("align", match[1], cls)
      continue
    }
    match = FONT_FAMILY_RE.exec(cls)
    if (match) {
      assign("family", match[1], cls)
      continue
    }
    match = FONT_WEIGHT_RE.exec(cls)
    if (match) {
      assign("weight", match[1], cls)
      continue
    }
    match =
      LEADING_RE.exec(cls) ??
      LEADING_NUMERIC_RE.exec(cls) ??
      LEADING_ARBITRARY_RE.exec(cls)
    if (match) {
      assign("leading", match[1], cls)
      continue
    }
    match = TRACKING_RE.exec(cls) ?? TRACKING_ARBITRARY_RE.exec(cls)
    if (match) {
      assign("tracking", match[1], cls)
      continue
    }
    if (TYPOGRAPHY_PRESERVE_RE.test(cls)) {
      out.preservedRaw.push(cls)
    }
  }
  return out
}

export function setFontSize(
  current: TypographyValue,
  size: string | null,
): ClassMutation {
  const remove = current.size ? [...current.size.raws] : []
  if (size === null) return { remove, add: [] }
  return { remove, add: [`text-${size}`] }
}

export function setFontWeight(
  current: TypographyValue,
  weight: string | null,
): ClassMutation {
  const remove = current.weight ? [...current.weight.raws] : []
  if (weight === null) return { remove, add: [] }
  return { remove, add: [`font-${weight}`] }
}

export function setFontFamily(
  current: TypographyValue,
  family: string | null,
): ClassMutation {
  const remove = current.family ? [...current.family.raws] : []
  if (family === null) return { remove, add: [] }
  return { remove, add: [`font-${family}`] }
}

export function setLeading(
  current: TypographyValue,
  leading: string | null,
): ClassMutation {
  const remove = current.leading ? [...current.leading.raws] : []
  if (leading === null) return { remove, add: [] }
  return { remove, add: [`leading-${leading}`] }
}

export function setTracking(
  current: TypographyValue,
  tracking: string | null,
): ClassMutation {
  const remove = current.tracking ? [...current.tracking.raws] : []
  if (tracking === null) return { remove, add: [] }
  return { remove, add: [`tracking-${tracking}`] }
}

export function setTextAlign(
  current: TypographyValue,
  align: string | null,
): ClassMutation {
  const remove = current.align ? [...current.align.raws] : []
  if (align === null) return { remove, add: [] }
  return { remove, add: [`text-${align}`] }
}

// ── Shadow helpers ─────────────────────────────────────────────────

/**
 * Tailwind v4 box-shadow scale. `none` is the explicit `shadow-none`
 * utility (clears an inherited shadow); the inspector's "—" option
 * removes the class entirely. We deliberately don't surface a bare
 * `shadow` keyword — it isn't a v4 utility — nor shadow COLOR utilities
 * (`shadow-blue-500`), which are preserved untouched.
 */
export const SHADOWS: readonly string[] = [
  "none", "2xs", "xs", "sm", "md", "lg", "xl", "2xl",
]

export interface ShadowValue {
  value: { value: string; raws: string[] } | null
  /** Shadow color / arbitrary / variant utilities, preserved untouched. */
  preservedRaw: string[]
}

const SHADOW_RE = new RegExp(`^shadow-(${SHADOWS.join("|")})$`)
/**
 * Preserve shadow utilities the size select doesn't own: color shadows
 * (`shadow-blue-500`), arbitrary values (`shadow-[…]`), inset/ring
 * shadows, and responsive / state variants. Runs only after SHADOW_RE
 * misses, so plain `shadow-md` never reaches it.
 */
const SHADOW_PRESERVE_RE =
  /^(?:shadow-|inset-shadow-|.*:shadow-|.*:inset-shadow-)/

export function parseShadow(classes: readonly string[]): ShadowValue {
  const out: ShadowValue = { value: null, preservedRaw: [] }
  for (const cls of classes) {
    const m = SHADOW_RE.exec(cls)
    if (m) {
      out.value = out.value
        ? { value: m[1], raws: [...out.value.raws, cls] }
        : { value: m[1], raws: [cls] }
      continue
    }
    if (SHADOW_PRESERVE_RE.test(cls)) out.preservedRaw.push(cls)
  }
  return out
}

export function setShadow(
  current: ShadowValue,
  shadow: string | null,
): ClassMutation {
  const remove = current.value ? [...current.value.raws] : []
  if (shadow === null) return { remove, add: [] }
  return { remove, add: [`shadow-${shadow}`] }
}
