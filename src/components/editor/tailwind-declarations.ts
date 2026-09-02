/**
 * Tailwind utility class → raw CSS declaration resolver.
 *
 * **Why this exists.** The inspector's color/border sections emit
 * Tailwind v4 utility classes (`bg-emerald-800`, `border-4`, etc.)
 * regardless of whether the prototype substrate actually has Tailwind
 * installed. When it doesn't (e.g. our dogfood `ai-gateway-prototype`
 * is plain Vue + Acme DS with no Tailwind), the iframe has no rule
 * defining `.bg-emerald-800` — the class lands on the element but
 * renders nothing, and the Phase G `@apply ...` rule written by the
 * scoped-css-override applicator silently fails to compile too.
 *
 * The fix is to resolve those utility classes to raw declarations on
 * the shell side and emit them through both the live-preview path
 * (bridge applies inline with !important) and the save path
 * (`ScopedCssOverrideEdit.declarations` instead of `applyClasses`).
 * Plain CSS works in any substrate.
 *
 * **Coverage.** V1 covers what the color and border sections emit:
 * bg / text / border colors (palette + specials), border widths,
 * border styles, border radii. Spacing / typography utilities are
 * follow-ups; their inspector sections continue to emit class lists
 * that work iff Tailwind is installed in the substrate, and degrade
 * the same way as before (limitation flagged honestly in the panel).
 */

import {
  TAILWIND_COLOR_FAMILIES,
  TAILWIND_COLOR_HEX,
  TAILWIND_COLOR_SHADES,
} from "./tailwind-colors"
import {
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_VALUES,
  SPACING_SCALE,
  TEXT_ALIGNMENTS,
  TRACKING_VALUES,
} from "./tailwind-classes"

const COLOR_FAMILIES = TAILWIND_COLOR_FAMILIES.join("|")
const COLOR_SHADES = TAILWIND_COLOR_SHADES.join("|")
const COLOR_PALETTE_RE = new RegExp(
  `^(bg|text|border)-(${COLOR_FAMILIES})-(${COLOR_SHADES})$`,
)
const COLOR_SPECIAL_RE =
  /^(bg|text|border)-(white|black|transparent|current|inherit)$/
// Tailwind v4 arbitrary-value class referencing a CSS custom property:
// `bg-[var(--acme-color-background-primary)]`. Resolves to the var()
// reference itself — the substrate's CSS cascade does the lookup at
// runtime via the design-token package's `:root` declarations.
const COLOR_TOKEN_RE =
  /^(bg|text|border)-\[var\(\s*(--[a-z0-9-]+)\s*\)\]$/i

const SPECIAL_TO_VALUE: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  transparent: "transparent",
  current: "currentColor",
  inherit: "inherit",
}

const COLOR_PROPERTY: Record<"bg" | "text" | "border", string> = {
  bg: "background-color",
  text: "color",
  border: "border-color",
}

// Tailwind v4 default border-radius scale (rems).
const BORDER_RADIUS_VALUES: Record<string, string> = {
  none: "0",
  sm: "0.125rem",
  default: "0.25rem",
  md: "0.375rem",
  lg: "0.5rem",
  xl: "0.75rem",
  "2xl": "1rem",
  "3xl": "1.5rem",
  full: "9999px",
}

// `border` (no suffix) maps to 1px in Tailwind v4 defaults.
const BORDER_WIDTH_VALUES: Record<string, string> = {
  "0": "0",
  "1": "1px",
  "2": "2px",
  "4": "4px",
  "8": "8px",
}

const BORDER_STYLES = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "none",
])

// ── Spacing ─────────────────────────────────────────────
// Tailwind v4 default scale: each step is 0.25rem.
const SPACING_VALUES: Record<string, string> = Object.fromEntries(
  SPACING_SCALE.map((n) => [String(n), n === 0 ? "0" : `${n * 0.25}rem`]),
)

/**
 * Utility prefix → the CSS property (or properties) it sets.
 *
 * Exported so the cascade-oracle drift gate
 * (`tailwind-declarations.test.ts` § "cascade-oracle drift gate") can build its
 * corpus from the resolver's OWN data: a family added here automatically enters
 * the corpus, so a new emitted property trips the pinned property set instead of
 * silently re-opening the shorthand/longhand blind spot in
 * `src/editor/verification/style-shorthands.ts`.
 */
export const SPACING_PREFIXES: Readonly<Record<string, string | string[]>> = {
  // Padding
  p: "padding",
  px: ["padding-left", "padding-right"],
  py: ["padding-top", "padding-bottom"],
  pt: "padding-top",
  pr: "padding-right",
  pb: "padding-bottom",
  pl: "padding-left",
  // Margin
  m: "margin",
  mx: ["margin-left", "margin-right"],
  my: ["margin-top", "margin-bottom"],
  mt: "margin-top",
  mr: "margin-right",
  mb: "margin-bottom",
  ml: "margin-left",
  // Flex / grid gap. `gap-x-` / `gap-y-` resolve through the explicit
  // entry; the loop tries the longer prefix first (see resolveSpacing).
  gap: "gap",
  "gap-x": "column-gap",
  "gap-y": "row-gap",
}

// Order matters: longer prefixes first so `gap-x-4` doesn't get parsed
// as prefix=`gap` + step=`x-4`.
const SPACING_PREFIX_ORDER = Object.keys(SPACING_PREFIXES).sort(
  (a, b) => b.length - a.length,
)

function resolveSpacing(className: string): Record<string, string> | null {
  for (const prefix of SPACING_PREFIX_ORDER) {
    if (!className.startsWith(`${prefix}-`)) continue
    const stepKey = className.slice(prefix.length + 1)
    const value = SPACING_VALUES[stepKey]
    if (value === undefined) continue
    const props = SPACING_PREFIXES[prefix]
    if (Array.isArray(props)) {
      const out: Record<string, string> = {}
      for (const p of props) out[p] = value
      return out
    }
    return { [props]: value }
  }
  return null
}

// ── Typography ──────────────────────────────────────────
// Tailwind v4 default font-size + line-height pairs (font-size co-emits
// the matched line-height; designers can still override via leading-*).
const FONT_SIZE_VALUES: Record<string, { size: string; leading: string }> = {
  xs: { size: "0.75rem", leading: "1rem" },
  sm: { size: "0.875rem", leading: "1.25rem" },
  base: { size: "1rem", leading: "1.5rem" },
  lg: { size: "1.125rem", leading: "1.75rem" },
  xl: { size: "1.25rem", leading: "1.75rem" },
  "2xl": { size: "1.5rem", leading: "2rem" },
  "3xl": { size: "1.875rem", leading: "2.25rem" },
  "4xl": { size: "2.25rem", leading: "2.5rem" },
  "5xl": { size: "3rem", leading: "1" },
  "6xl": { size: "3.75rem", leading: "1" },
  "7xl": { size: "4.5rem", leading: "1" },
  "8xl": { size: "6rem", leading: "1" },
  "9xl": { size: "8rem", leading: "1" },
}

const FONT_WEIGHT_VALUES: Record<string, string> = {
  thin: "100",
  extralight: "200",
  light: "300",
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  extrabold: "800",
  black: "900",
}

const LEADING_VALUES_MAP: Record<string, string> = {
  none: "1",
  tight: "1.25",
  snug: "1.375",
  normal: "1.5",
  relaxed: "1.625",
  loose: "2",
}

const TRACKING_VALUES_MAP: Record<string, string> = {
  tighter: "-0.05em",
  tight: "-0.025em",
  normal: "0em",
  wide: "0.025em",
  wider: "0.05em",
  widest: "0.1em",
}

const TEXT_ALIGN_VALUES = new Set(TEXT_ALIGNMENTS)
const FONT_SIZE_KEYS = new Set(FONT_SIZES)
const FONT_WEIGHT_KEYS = new Set(FONT_WEIGHTS)
const LEADING_KEYS = new Set(LEADING_VALUES)
const TRACKING_KEYS = new Set(TRACKING_VALUES)

/**
 * Resolve one Tailwind class to its CSS declarations. Returns null
 * for classes outside the V1 coverage (so the caller can decide how
 * to fall back — e.g. trust that the substrate has the class wired).
 */
export function resolveTailwindClass(
  className: string,
): Record<string, string> | null {
  // ── Colors ──────────────────────────────────────────────
  const palette = COLOR_PALETTE_RE.exec(className)
  if (palette) {
    const [, prop, family, shade] = palette
    const hex = TAILWIND_COLOR_HEX[`${family}-${shade}`]
    if (!hex) return null
    return { [COLOR_PROPERTY[prop as "bg" | "text" | "border"]]: hex }
  }
  const special = COLOR_SPECIAL_RE.exec(className)
  if (special) {
    const [, prop, name] = special
    const value = SPECIAL_TO_VALUE[name]
    if (!value) return null
    return { [COLOR_PROPERTY[prop as "bg" | "text" | "border"]]: value }
  }
  const tokenMatch = COLOR_TOKEN_RE.exec(className)
  if (tokenMatch) {
    const [, prop, tokenName] = tokenMatch
    return {
      [COLOR_PROPERTY[prop as "bg" | "text" | "border"]]: `var(${tokenName})`,
    }
  }

  // ── Border styles ───────────────────────────────────────
  // Match BEFORE border-width — `border-solid` etc. would otherwise
  // be misread as a width by the lone `border` regex below.
  if (className.startsWith("border-")) {
    const styleSuffix = className.slice("border-".length)
    if (BORDER_STYLES.has(styleSuffix)) {
      return { "border-style": styleSuffix }
    }
  }

  // ── Border widths ───────────────────────────────────────
  // Bare `border` = 1px; `border-{n}` = {n}px for n ∈ {0,2,4,8}.
  // Adding a width when no border-style is set would render nothing
  // (default is `none`), so we co-emit `border-style: solid` for any
  // non-zero width. This mirrors Tailwind's preflight behavior, which
  // sets `border-style: solid` globally via `*, ::before, ::after`.
  if (className === "border") {
    return { "border-width": "1px", "border-style": "solid" }
  }
  if (className.startsWith("border-")) {
    const widthSuffix = className.slice("border-".length)
    const width = BORDER_WIDTH_VALUES[widthSuffix]
    if (width !== undefined) {
      const out: Record<string, string> = { "border-width": width }
      if (widthSuffix !== "0") out["border-style"] = "solid"
      return out
    }
  }

  // ── Border radii ────────────────────────────────────────
  if (className === "rounded") {
    return { "border-radius": BORDER_RADIUS_VALUES.default }
  }
  if (className.startsWith("rounded-")) {
    const radiusSuffix = className.slice("rounded-".length)
    const radius = BORDER_RADIUS_VALUES[radiusSuffix]
    if (radius !== undefined) return { "border-radius": radius }
  }

  // ── Typography ──────────────────────────────────────────
  // Order: try the strict `text-{align}` and `text-{size}` matches
  // before the `text-` prefix is misread as a color (color regex above
  // already handles palette/specials, so only size/align reach here).
  if (className.startsWith("text-")) {
    const suffix = className.slice("text-".length)
    if (FONT_SIZE_KEYS.has(suffix)) {
      const fs = FONT_SIZE_VALUES[suffix]
      // Co-emit line-height to mirror Tailwind's bundled font-size
      // utility output. A subsequent `leading-*` class overrides this
      // (resolveTailwindClasses applies later classes' decls last).
      return { "font-size": fs.size, "line-height": fs.leading }
    }
    if (TEXT_ALIGN_VALUES.has(suffix)) {
      return { "text-align": suffix }
    }
  }
  if (className.startsWith("font-")) {
    const suffix = className.slice("font-".length)
    if (FONT_WEIGHT_KEYS.has(suffix)) {
      return { "font-weight": FONT_WEIGHT_VALUES[suffix] }
    }
  }
  if (className.startsWith("leading-")) {
    const suffix = className.slice("leading-".length)
    if (LEADING_KEYS.has(suffix)) {
      return { "line-height": LEADING_VALUES_MAP[suffix] }
    }
  }
  if (className.startsWith("tracking-")) {
    const suffix = className.slice("tracking-".length)
    if (TRACKING_KEYS.has(suffix)) {
      return { "letter-spacing": TRACKING_VALUES_MAP[suffix] }
    }
  }

  // ── Flex alignment + width (direct-manip align/size control) ────
  // So the bridge live-preview + the scoped-css-override save path get raw
  // declarations for the utilities AlignSizeSection emits — and so non-Tailwind
  // substrates (which can't rely on the class itself) render the change.
  if (className.startsWith("justify-")) {
    const v = JUSTIFY_CONTENT_VALUES[className.slice("justify-".length)]
    if (v) return { "justify-content": v }
  }
  if (className.startsWith("items-")) {
    const v = ALIGN_ITEMS_VALUES[className.slice("items-".length)]
    if (v) return { "align-items": v }
  }
  if (className.startsWith("w-")) {
    const v = resolveWidth(className.slice("w-".length))
    if (v) return { width: v }
  }

  // ── Spacing (padding / margin / gap) ────────────────────
  // Try last so the more specific `text-` / `border-` / `rounded-`
  // matches above always win, and the spacing prefix loop only deals
  // with class names that aren't already claimed.
  const spacing = resolveSpacing(className)
  if (spacing) return spacing

  return null
}

const JUSTIFY_CONTENT_VALUES: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
  normal: "normal",
  stretch: "stretch",
}
const ALIGN_ITEMS_VALUES: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
}
const WIDTH_KEYWORDS: Record<string, string> = {
  full: "100%",
  auto: "auto",
  fit: "fit-content",
  screen: "100vw",
  min: "min-content",
  max: "max-content",
  px: "1px",
}
const WIDTH_FRACTIONS: Record<string, string> = {
  "1/2": "50%",
  "1/3": "33.333333%",
  "2/3": "66.666667%",
  "1/4": "25%",
  "2/4": "50%",
  "3/4": "75%",
}

/** Resolve a `w-{suffix}` width utility to a CSS value. Covers keywords,
 *  fractions, and the numeric spacing scale (`w-64` → `16rem`). */
function resolveWidth(suffix: string): string | null {
  if (suffix in WIDTH_KEYWORDS) return WIDTH_KEYWORDS[suffix]
  if (suffix in WIDTH_FRACTIONS) return WIDTH_FRACTIONS[suffix]
  // Numeric spacing-scale width (`w-{n}` → n × 0.25rem), n integer or `.5`.
  if (/^\d+(\.5)?$/.test(suffix)) {
    const n = parseFloat(suffix)
    if (Number.isFinite(n)) return `${n * 0.25}rem`
  }
  return null
}

/**
 * Resolve a list of class names to a merged declaration map.
 * Later classes win on the same property — mirrors CSS cascade for
 * the synthetic case where all rules have equal specificity. Classes
 * outside V1 coverage are silently skipped; the caller is expected to
 * also keep the className list in sync (so substrates with Tailwind
 * still get coverage from utilities we don't resolve).
 */
export function resolveTailwindClasses(
  classes: readonly string[],
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const cls of classes) {
    const decls = resolveTailwindClass(cls)
    if (!decls) continue
    Object.assign(merged, decls)
  }
  return merged
}
