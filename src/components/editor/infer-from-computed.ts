/**
 * Computed-style → Tailwind-utility inference. The right-rail inspector
 * sections (Spacing / Color / Border / Typography) read class-list-derived
 * values out of the selected element. When the substrate styles the
 * element via component-internal CSS — Acme DS, CSS modules, plain
 * stylesheets — the class list carries no Tailwind utility for that
 * property and the controls render empty even though the user can see
 * the styling in the iframe.
 *
 * This module fills that gap by snapping the bridge-reported computed
 * styles (`getComputedStyle`-shape values like `"16px"`,
 * `"rgb(34, 197, 94)"`, `"0.875rem"`) to the nearest Tailwind step. The
 * inferred value carries `raws: []` so when the designer commits an
 * edit, no class is removed (there was none) — only the new utility is
 * added. The downstream apply-scoped-css-override path makes that
 * utility win via `:deep()` + `@apply`, regardless of whether the
 * substrate ships Tailwind.
 *
 * **What this is NOT.** This is not a perfect round-trip — a computed
 * `padding: 13px` snaps to `p-3` (12px) for display, not because the
 * user wanted `p-3` but because the inspector has to choose ONE step on
 * the closed Tailwind scale. The hint text labels the value as
 * `"(computed)"` so the designer understands the source.
 */

import {
  BORDER_RADII,
  BORDER_STYLES,
  BORDER_WIDTHS,
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_VALUES,
  SPACING_SCALE,
  TEXT_ALIGNMENTS,
  TRACKING_VALUES,
} from "./tailwind-classes"
import {
  TAILWIND_COLOR_FAMILIES,
  TAILWIND_COLOR_HEX,
  TAILWIND_COLOR_SHADES,
  TAILWIND_SPECIAL_COLORS,
  type ColorProperty,
  type ColorValue,
} from "./tailwind-colors"

// ── Length parsing ──────────────────────────────────────────────────

/**
 * Parse a CSS length value to pixels. Handles `px`, `rem`, `em` (treated
 * as rem — the inspector doesn't have access to the element's own
 * font-size context, and Tailwind utilities use rem anyway), and unitless
 * `0`. Returns null for everything else (calc, percentages, `auto`).
 */
function parseLengthPx(value: string | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed === "0") return 0
  // px
  const px = /^(-?\d+(?:\.\d+)?)px$/i.exec(trimmed)
  if (px) return parseFloat(px[1])
  // rem / em — assume 16px root font size (CSS default)
  const rem = /^(-?\d+(?:\.\d+)?)r?em$/i.exec(trimmed)
  if (rem) return parseFloat(rem[1]) * 16
  return null
}

// ── Spacing inference ────────────────────────────────────────────────

const SPACING_PX = SPACING_SCALE.map((step) => ({ step, px: step * 4 }))

function snapPxToSpacingStep(px: number): number | null {
  if (px < 0) return null
  let bestStep: number | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const { step, px: stepPx } of SPACING_PX) {
    const diff = Math.abs(stepPx - px)
    if (diff < bestDiff) {
      bestDiff = diff
      bestStep = step
    }
  }
  // Reject snapping when the gap is so large the result would mislead.
  // Tailwind's largest step is 96 (384px); anything beyond is clearly
  // off-scale and we'd rather show empty than a wildly wrong value.
  if (bestDiff > 4) return null
  return bestStep
}

/**
 * Derive an all-sides spacing step from a computed-style map. Returns
 * the snapped step iff every side resolves to the same step — otherwise
 * the property has mixed values and the inspector's all-sides input
 * shouldn't claim ownership. Mixed cases fall through; the per-side
 * controls would be the right place to surface them, but V1 only ships
 * the all-sides fields.
 */
export function inferSpacingAllSides(
  computedStyles: Record<string, string> | undefined,
  kind: "padding" | "margin",
): number | null {
  if (!computedStyles) return null
  const top = parseLengthPx(computedStyles[`${kind}-top`])
  const right = parseLengthPx(computedStyles[`${kind}-right`])
  const bottom = parseLengthPx(computedStyles[`${kind}-bottom`])
  const left = parseLengthPx(computedStyles[`${kind}-left`])
  if (top === null || right === null || bottom === null || left === null) {
    return null
  }
  if (top !== right || right !== bottom || bottom !== left) return null
  return snapPxToSpacingStep(top)
}

/**
 * Derive the four per-side spacing steps independently from computed
 * styles. Each side is nullable — used by the inspector's per-side inputs
 * so an Acme DS-styled element with asymmetric padding (mixed via
 * component-internal CSS) shows each side's actual value instead of an
 * empty "mixed" field. Mirrors {@link inferSpacingAllSides} but without
 * the all-four-must-match constraint.
 */
export function inferSpacingSides(
  computedStyles: Record<string, string> | undefined,
  kind: "padding" | "margin",
): { top: number | null; right: number | null; bottom: number | null; left: number | null } {
  const side = (name: string): number | null => {
    const px = parseLengthPx(computedStyles?.[`${kind}-${name}`])
    return px === null ? null : snapPxToSpacingStep(px)
  }
  return {
    top: side("top"),
    right: side("right"),
    bottom: side("bottom"),
    left: side("left"),
  }
}

/**
 * Derive a single gap step. Tailwind v4's bridge sends `gap` (column-gap
 * is the canonical fallback) — we read whichever the bridge surfaces.
 * Returns null when row/column gap differ so the all-axis input doesn't
 * hide that fact.
 */
export function inferGapAllAxes(
  computedStyles: Record<string, string> | undefined,
): number | null {
  if (!computedStyles) return null
  const row = parseLengthPx(
    computedStyles["row-gap"] ?? computedStyles["gap"],
  )
  const col = parseLengthPx(
    computedStyles["column-gap"] ?? computedStyles["gap"],
  )
  if (row === null || col === null) return null
  if (row !== col) return null
  return snapPxToSpacingStep(row)
}

// ── Color inference ──────────────────────────────────────────────────

interface RGB {
  r: number
  g: number
  b: number
  a: number
}

/**
 * "No color is applied" sentinels — values that should leave the chip
 * blank rather than render as a custom swatch. `transparent` is handled
 * upstream (it parses to alpha-0 and becomes the transparent special);
 * it's listed here only as a guard for the unparsed path.
 */
function isNoColorSentinel(value: string): boolean {
  const v = value.trim().toLowerCase()
  return (
    v === "" ||
    v === "none" ||
    v === "transparent" ||
    v === "initial" ||
    v === "inherit" ||
    v === "unset" ||
    v === "revert" ||
    v === "auto" ||
    v === "currentcolor"
  )
}

function parseColorString(value: string | undefined): RGB | null {
  if (!value) return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 }
  // rgb(r g b) or rgb(r, g, b) or rgba(...) — accept both legacy and modern.
  const rgb = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:[\s,/]+([0-9.]+%?))?\s*\)$/i.exec(
    trimmed,
  )
  if (rgb) {
    const [, r, g, b, a] = rgb
    return {
      r: parseFloat(r),
      g: parseFloat(g),
      b: parseFloat(b),
      a: a === undefined ? 1 : a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a),
    }
  }
  // hsl(h s% l%) / hsl(h, s%, l%) / hsla(...). Design tokens are
  // frequently authored in HSL (shadcn theme vars, package tokens), so we
  // resolve them to RGB to compare against the computed background.
  const hsl =
    /^hsla?\(\s*([0-9.]+)(?:deg)?[\s,]+([0-9.]+)%[\s,]+([0-9.]+)%(?:[\s,/]+([0-9.]+%?))?\s*\)$/i.exec(
      trimmed,
    )
  if (hsl) {
    const [, h, s, l, a] = hsl
    const { r, g, b } = hslToRgb(parseFloat(h), parseFloat(s) / 100, parseFloat(l) / 100)
    return {
      r,
      g,
      b,
      a: a === undefined ? 1 : a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a),
    }
  }
  // #rgb / #rrggbb / #rrggbbaa
  const hex = /^#([0-9a-f]{3,8})$/i.exec(trimmed)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1,
      }
    }
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      }
    }
    if (h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
      }
    }
  }
  return null
}

function hexToRgb(hex: string): RGB | null {
  return parseColorString(hex)
}

/** HSL (h in degrees, s/l in 0..1) → 0..255 RGB. */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360 / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(channel(hue + 1 / 3) * 255),
    g: Math.round(channel(hue) * 255),
    b: Math.round(channel(hue - 1 / 3) * 255),
  }
}

function rgbDistance(a: RGB, b: RGB): number {
  // Euclidean in RGB. Cheap, good enough to find "is this basically the
  // same Tailwind step." Perceptual color spaces would be more accurate
  // but this isn't picking visual matches across families — it's
  // identifying values the user almost certainly typed in.
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

const COLOR_MATCH_THRESHOLD = 24

/** A design token reduced to what color-matching needs (name + value). */
export interface InferColorToken {
  name: string
  value: string
}

/**
 * How close (RGB euclidean) a computed color must be to a design
 * token's resolved value before we label it as that token. Tight on
 * purpose — tokens should land near-exact (only HSL→RGB rounding and
 * the browser's own rounding stand between them), and a loose match
 * would mislabel an arbitrary themed color as a token it isn't.
 */
const TOKEN_MATCH_THRESHOLD = 10

/**
 * Map a computed color string to a named value the inspector can show.
 * Returns:
 *  - `null` when the value is missing or unparseable — the control
 *    stays empty rather than claim a wrong value.
 *  - `{ kind: "special", name }` for transparent (alpha 0) or exact
 *    white/black matches.
 *  - `{ kind: "token", tokenName }` when the color lands on one of the
 *    supplied design tokens (preferred — a named, grounded value).
 *  - `{ kind: "palette", family, shade }` for the closest Tailwind hit
 *    within the palette threshold.
 *  - `{ kind: "custom", css }` when the color parsed but matches none of
 *    the above — a themed / arbitrary value. The swatch renders the
 *    actual color so the chip isn't blank for token-driven backgrounds
 *    (e.g. shadcn `bg-secondary`).
 *
 * Always sets `raws: []` — class-set values come from the regular parser
 * with their actual raws; this fallback synthesizes a value from the
 * computed style and there are no class names to remove on edit.
 */
export function inferColor(
  computedStyles: Record<string, string> | undefined,
  property: ColorProperty,
  tokens?: readonly InferColorToken[],
): ColorValue {
  if (!computedStyles) return null
  const cssProperty =
    property === "bg"
      ? "background-color"
      : property === "text"
        ? "color"
        : "border-color"
  // Border-color is sided in computed styles when the bridge surfaces
  // them individually. Try the shorthand first, then the top-edge as a
  // representative when only sided values are present.
  const value =
    computedStyles[cssProperty] ??
    (property === "border" ? computedStyles["border-top-color"] : undefined)
  if (value === undefined) return null
  const rgb = parseColorString(value)
  if (!rgb) {
    // Couldn't reduce it to RGB (modern formats the matcher doesn't
    // model — `oklch(…)`, `color(srgb …)`, named colors), or it's a
    // "no color" sentinel. A sentinel stays blank; anything else is a
    // real, browser-renderable color → surface it as a custom swatch so
    // the chip reflects what's applied instead of going empty. This is
    // the common Tailwind-v4 case: the palette compiles to oklch.
    if (isNoColorSentinel(value)) return null
    return { kind: "custom", css: value.trim(), raws: [] }
  }
  if (rgb.a === 0) {
    return { kind: "special", name: "transparent", raws: [] }
  }
  // Specials (white/black) — exact match before palette walk.
  for (const name of TAILWIND_SPECIAL_COLORS) {
    const hex = TAILWIND_COLOR_HEX[name]
    if (!hex) continue
    const target = hexToRgb(hex)
    if (!target) continue
    if (rgbDistance(rgb, target) < 1) {
      return { kind: "special", name, raws: [] }
    }
  }
  // Design tokens — prefer a named token when the computed color lands
  // on one. Checked before the palette so a token that happens to equal
  // a Tailwind step still reads as the (more meaningful) token.
  if (tokens && tokens.length > 0) {
    let bestToken: { name: string; distance: number } | null = null
    for (const token of tokens) {
      const target = parseColorString(token.value)
      if (!target) continue
      const distance = rgbDistance(rgb, target)
      if (!bestToken || distance < bestToken.distance) {
        bestToken = { name: token.name, distance }
      }
    }
    if (bestToken && bestToken.distance <= TOKEN_MATCH_THRESHOLD) {
      return { kind: "token", tokenName: bestToken.name, raws: [] }
    }
  }
  let best: { family: string; shade: number; distance: number } | null = null
  for (const family of TAILWIND_COLOR_FAMILIES) {
    for (const shade of TAILWIND_COLOR_SHADES) {
      const hex = TAILWIND_COLOR_HEX[`${family}-${shade}`]
      if (!hex) continue
      const target = hexToRgb(hex)
      if (!target) continue
      const distance = rgbDistance(rgb, target)
      if (!best || distance < best.distance) {
        best = { family, shade, distance }
      }
    }
  }
  if (best && best.distance <= COLOR_MATCH_THRESHOLD) {
    return {
      kind: "palette",
      family: best.family,
      shade: best.shade,
      raws: [],
    }
  }
  // Parsed but matched nothing nameable — surface the real color so the
  // chip reflects the applied background instead of going blank.
  return { kind: "custom", css: value.trim(), raws: [] }
}

// ── Border inference ─────────────────────────────────────────────────

const BORDER_RADIUS_PX: Record<string, number> = {
  none: 0,
  sm: 2,
  default: 4,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  "3xl": 24,
  full: 9999,
}

function snapPxToBorderWidth(px: number): number | null {
  // Ignore widths above 12px — the V1 step list tops out at 8 and a
  // 200px shadow-style border isn't something the select can represent
  // without misleading.
  if (px < 0 || px > 12) return null
  let best = BORDER_WIDTHS[0]
  let bestDiff = Math.abs(best - px)
  for (const w of BORDER_WIDTHS) {
    const diff = Math.abs(w - px)
    if (diff < bestDiff) {
      bestDiff = diff
      best = w
    }
  }
  // Conservative threshold: don't snap a 5px border to 4 silently if
  // there's a closer step. The list is sparse, so >2px diff means the
  // user definitely picked an off-scale value.
  if (bestDiff > 2) return null
  return best
}

function snapPxToBorderRadius(px: number): string | null {
  // Treat ≥ 9000px as `full` (bridges typically report `9999px`).
  if (px >= 9000) return "full"
  if (px < 0) return null
  let best: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const key of BORDER_RADII) {
    if (key === "full") continue
    const target = BORDER_RADIUS_PX[key]
    if (target === undefined) continue
    const diff = Math.abs(target - px)
    if (diff < bestDiff) {
      bestDiff = diff
      best = key
    }
  }
  if (bestDiff > 4) return null
  return best
}

export interface InferredBorder {
  width: number | null
  style: string | null
  radius: string | null
}

/**
 * Derive border width / style / radius from computed styles. Each field
 * is independently nullable — a 1px solid border with no rounding hits
 * `{ width: 1, style: "solid", radius: null }`. The inspector fills the
 * "—" choice when null.
 */
export function inferBorder(
  computedStyles: Record<string, string> | undefined,
): InferredBorder {
  const out: InferredBorder = { width: null, style: null, radius: null }
  if (!computedStyles) return out

  // Border width — only infer when all four sides match. The single-axis
  // selects can't represent an asymmetric border, and lying about it
  // would surprise the designer on edit.
  const top = parseLengthPx(computedStyles["border-top-width"])
  const right = parseLengthPx(computedStyles["border-right-width"])
  const bottom = parseLengthPx(computedStyles["border-bottom-width"])
  const left = parseLengthPx(computedStyles["border-left-width"])
  if (
    top !== null &&
    right !== null &&
    bottom !== null &&
    left !== null &&
    top === right &&
    right === bottom &&
    bottom === left &&
    top > 0
  ) {
    out.width = snapPxToBorderWidth(top)
  }

  // Border style — same all-four-sides constraint.
  const tStyle = computedStyles["border-top-style"]
  const rStyle = computedStyles["border-right-style"]
  const bStyle = computedStyles["border-bottom-style"]
  const lStyle = computedStyles["border-left-style"]
  if (
    tStyle &&
    tStyle === rStyle &&
    rStyle === bStyle &&
    bStyle === lStyle &&
    BORDER_STYLES.includes(tStyle)
  ) {
    // `none` is technically representable but redundant with width=0;
    // skip emitting it as a fallback so the select stays at "—" when
    // there's no border at all.
    out.style = tStyle === "none" ? null : tStyle
  }

  // Border radius — bridge can emit shorthand or per-corner. Try the
  // shorthand first; fall back to top-left as representative.
  const radiusValue =
    computedStyles["border-radius"] ?? computedStyles["border-top-left-radius"]
  const radiusPx = parseLengthPx(radiusValue)
  if (radiusPx !== null && radiusPx > 0) {
    out.radius = snapPxToBorderRadius(radiusPx)
  }

  return out
}

/**
 * Per-side border widths from computed styles — the fallback the per-side
 * width editor shows for sides with no owning Tailwind class. Each side is
 * snapped to the nearest V1 step (or `null` when off-scale / absent).
 */
export function inferBorderWidthSides(
  computedStyles: Record<string, string> | undefined,
): { top: number | null; right: number | null; bottom: number | null; left: number | null } {
  const side = (name: string): number | null => {
    const px = parseLengthPx(computedStyles?.[`border-${name}-width`])
    return px === null ? null : snapPxToBorderWidth(px)
  }
  return {
    top: side("top"),
    right: side("right"),
    bottom: side("bottom"),
    left: side("left"),
  }
}

/**
 * Per-corner border radii from computed styles — the fallback the per-corner
 * radius editor shows for corners with no owning Tailwind class.
 */
export function inferBorderRadiusCorners(
  computedStyles: Record<string, string> | undefined,
): { topLeft: string | null; topRight: string | null; bottomRight: string | null; bottomLeft: string | null } {
  const corner = (name: string): string | null => {
    const px = parseLengthPx(computedStyles?.[`border-${name}-radius`])
    return px === null || px <= 0 ? null : snapPxToBorderRadius(px)
  }
  return {
    topLeft: corner("top-left"),
    topRight: corner("top-right"),
    bottomRight: corner("bottom-right"),
    bottomLeft: corner("bottom-left"),
  }
}

// ── Typography inference ────────────────────────────────────────────

const FONT_SIZE_PX: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
  "6xl": 60,
  "7xl": 72,
  "8xl": 96,
  "9xl": 128,
}

const FONT_WEIGHT_NUMERIC: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
}

const LEADING_NUMERIC: Record<string, number> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
}

const TRACKING_EM: Record<string, number> = {
  tighter: -0.05,
  tight: -0.025,
  normal: 0,
  wide: 0.025,
  wider: 0.05,
  widest: 0.1,
}

function snapFontSize(px: number): string | null {
  let best: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const key of FONT_SIZES) {
    const target = FONT_SIZE_PX[key]
    if (target === undefined) continue
    const diff = Math.abs(target - px)
    if (diff < bestDiff) {
      bestDiff = diff
      best = key
    }
  }
  // 2px is the gap between adjacent V4 sizes (xs=12, sm=14, base=16) —
  // beyond that the user's value isn't really on the scale.
  if (bestDiff > 1.5) return null
  return best
}

function snapFontWeight(weight: number): string | null {
  let best: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const key of FONT_WEIGHTS) {
    const target = FONT_WEIGHT_NUMERIC[key]
    const diff = Math.abs(target - weight)
    if (diff < bestDiff) {
      bestDiff = diff
      best = key
    }
  }
  if (bestDiff > 50) return null
  return best
}

function snapLeading(
  lineHeight: string | undefined,
  fontSizePx: number | null,
): string | null {
  if (!lineHeight) return null
  const trimmed = lineHeight.trim().toLowerCase()
  if (trimmed === "normal") return "normal"
  // Unitless multiplier — directly comparable to LEADING_NUMERIC.
  const unitless = /^([0-9.]+)$/.exec(trimmed)
  if (unitless) {
    const ratio = parseFloat(unitless[1])
    return snapToLeadingRatio(ratio)
  }
  // Length form ("24px", "1.5rem") — convert to ratio iff we have the
  // font size to divide by. Without it, we can't normalize against
  // LEADING_NUMERIC ratios.
  const px = parseLengthPx(trimmed)
  if (px !== null && fontSizePx !== null && fontSizePx > 0) {
    return snapToLeadingRatio(px / fontSizePx)
  }
  return null
}

function snapToLeadingRatio(ratio: number): string | null {
  let best: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const key of LEADING_VALUES) {
    const target = LEADING_NUMERIC[key]
    if (target === undefined) continue
    const diff = Math.abs(target - ratio)
    if (diff < bestDiff) {
      bestDiff = diff
      best = key
    }
  }
  if (bestDiff > 0.1) return null
  return best
}

function snapTracking(
  letterSpacing: string | undefined,
  fontSizePx: number | null,
): string | null {
  if (!letterSpacing) return null
  const trimmed = letterSpacing.trim().toLowerCase()
  if (trimmed === "normal" || trimmed === "0" || trimmed === "0px") {
    return "normal"
  }
  // em — direct match.
  const em = /^(-?[0-9.]+)em$/.exec(trimmed)
  if (em) {
    return snapToTrackingEm(parseFloat(em[1]))
  }
  // px — divide by font size to normalize.
  const px = parseLengthPx(trimmed)
  if (px !== null && fontSizePx !== null && fontSizePx > 0) {
    return snapToTrackingEm(px / fontSizePx)
  }
  return null
}

function snapToTrackingEm(em: number): string | null {
  let best: string | null = null
  let bestDiff = Number.POSITIVE_INFINITY
  for (const key of TRACKING_VALUES) {
    const target = TRACKING_EM[key]
    if (target === undefined) continue
    const diff = Math.abs(target - em)
    if (diff < bestDiff) {
      bestDiff = diff
      best = key
    }
  }
  if (bestDiff > 0.015) return null
  return best
}

export interface InferredTypography {
  size: string | null
  weight: string | null
  leading: string | null
  tracking: string | null
  align: string | null
}

export function inferTypography(
  computedStyles: Record<string, string> | undefined,
): InferredTypography {
  const out: InferredTypography = {
    size: null,
    weight: null,
    leading: null,
    tracking: null,
    align: null,
  }
  if (!computedStyles) return out

  const fontSizePx = parseLengthPx(computedStyles["font-size"])
  if (fontSizePx !== null) {
    out.size = snapFontSize(fontSizePx)
  }

  const weightRaw = computedStyles["font-weight"]
  if (weightRaw) {
    const numeric = parseFloat(weightRaw)
    if (Number.isFinite(numeric)) {
      out.weight = snapFontWeight(numeric)
    }
  }

  out.leading = snapLeading(computedStyles["line-height"], fontSizePx)
  out.tracking = snapTracking(computedStyles["letter-spacing"], fontSizePx)

  const align = computedStyles["text-align"]
  if (align && TEXT_ALIGNMENTS.includes(align)) {
    out.align = align
  }

  return out
}

// ── Shadow inference ─────────────────────────────────────────────────

/**
 * Reference blur radius (px) for each Tailwind v4 shadow preset. The
 * computed `box-shadow` rarely round-trips to a named preset exactly
 * (a theme can customize the scale), so we snap the largest blur radius
 * to the nearest preset — same "pick one step on a closed scale" deal
 * as spacing/border inference. Gives the control a sensible editable
 * starting point when the shadow comes from component CSS, not a class.
 */
const SHADOW_REFERENCE_BLUR: readonly { size: string; blur: number }[] = [
  { size: "2xs", blur: 0 },
  { size: "xs", blur: 2 },
  { size: "sm", blur: 3 },
  { size: "md", blur: 6 },
  { size: "lg", blur: 15 },
  { size: "xl", blur: 25 },
  { size: "2xl", blur: 50 },
]

/**
 * Snap a computed `box-shadow` to the nearest Tailwind preset size, or
 * `null` when there's no shadow. The bridge filters `box-shadow: none`
 * out of the surfaced styles, so a present value means a real shadow.
 */
export function inferShadow(
  computedStyles: Record<string, string> | undefined,
): string | null {
  if (!computedStyles) return null
  const value = computedStyles["box-shadow"]
  if (!value || value.trim() === "" || value.trim() === "none") return null
  const blur = largestBlurPx(value)
  if (blur === null) return "sm"
  let best = SHADOW_REFERENCE_BLUR[0]
  for (const ref of SHADOW_REFERENCE_BLUR) {
    if (Math.abs(ref.blur - blur) < Math.abs(best.blur - blur)) best = ref
  }
  return best.size
}

/**
 * The largest blur radius (3rd length) across a (possibly layered)
 * computed `box-shadow`. Layers are comma-separated, but `rgba(...)`
 * colors also contain commas, so we split on top-level commas only.
 */
function largestBlurPx(boxShadow: string): number | null {
  let max: number | null = null
  for (const layer of splitTopLevelCommas(boxShadow)) {
    const lengths = layer.match(/-?\d*\.?\d+px/g)
    if (!lengths || lengths.length < 3) continue
    const blur = parseFloat(lengths[2])
    if (!Number.isNaN(blur)) max = max === null ? blur : Math.max(max, blur)
  }
  return max
}

/** Split on commas that aren't nested inside parentheses (e.g. `rgba(…)`). */
function splitTopLevelCommas(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "," && depth === 0) {
      out.push(input.slice(start, i))
      start = i + 1
    }
  }
  out.push(input.slice(start))
  return out
}
