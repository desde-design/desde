/**
 * Tailwind v4 default color palette + parser/mutator for color
 * classes (`bg-…`, `text-…`, `border-…`).
 *
 * **Why we hardcode the palette.** Tailwind v4's classes compile to
 * CSS variables like `--color-amber-50` whose values are set by the
 * generated theme stylesheet. In principle the inspector could read
 * those at runtime via `getComputedStyle(document.documentElement)`,
 * but that's flaky: we'd need to query inside the iframe (the
 * inspector is in the shell), and the values can shift if the
 * substrate's theme is customized. Hardcoding the V4 defaults gives
 * the swatch picker a reliable visual reference; the actual runtime
 * color in the iframe is whatever Tailwind compiled, which the
 * preview iframe shows correctly via the emitted class.
 *
 * The palette below is Tailwind v4.0 defaults (April 2025). When V5
 * ships or the substrate customizes its theme, swatch-vs-iframe
 * disagreement is a polish item — the class string is what matters
 * for the source edit.
 */

export type ColorProperty = "bg" | "text" | "border"

/**
 * The 22 default Tailwind color families plus the special values
 * (`white`, `black`, `transparent`, `current`, `inherit`).
 *
 * Order matters for the swatch grid: cool greys first, then warm
 * greys, then the chromatic spectrum running roughly red→rose.
 */
export const TAILWIND_COLOR_FAMILIES: readonly string[] = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime",
  "green", "emerald", "teal", "cyan", "sky",
  "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
]

export const TAILWIND_COLOR_SHADES: readonly number[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
]

export const TAILWIND_SPECIAL_COLORS: readonly string[] = [
  "white", "black", "transparent", "current", "inherit",
]

/**
 * Default V4 palette → hex lookup. Compact map keyed by `<family>-<shade>`.
 * Used by the inspector's swatch preview. Specials map to representative
 * solid swatches; `current` and `inherit` show as a transparent placeholder
 * since their resolved color depends on context.
 */
export const TAILWIND_COLOR_HEX: Readonly<Record<string, string>> = Object.freeze({
  // Greys
  "slate-50": "#f8fafc", "slate-100": "#f1f5f9", "slate-200": "#e2e8f0", "slate-300": "#cbd5e1", "slate-400": "#94a3b8", "slate-500": "#64748b", "slate-600": "#475569", "slate-700": "#334155", "slate-800": "#1e293b", "slate-900": "#0f172a", "slate-950": "#020617",
  "gray-50": "#f9fafb", "gray-100": "#f3f4f6", "gray-200": "#e5e7eb", "gray-300": "#d1d5db", "gray-400": "#9ca3af", "gray-500": "#6b7280", "gray-600": "#4b5563", "gray-700": "#374151", "gray-800": "#1f2937", "gray-900": "#111827", "gray-950": "#030712",
  "zinc-50": "#fafafa", "zinc-100": "#f4f4f5", "zinc-200": "#e4e4e7", "zinc-300": "#d4d4d8", "zinc-400": "#a1a1aa", "zinc-500": "#71717a", "zinc-600": "#52525b", "zinc-700": "#3f3f46", "zinc-800": "#27272a", "zinc-900": "#18181b", "zinc-950": "#09090b",
  "neutral-50": "#fafafa", "neutral-100": "#f5f5f5", "neutral-200": "#e5e5e5", "neutral-300": "#d4d4d4", "neutral-400": "#a3a3a3", "neutral-500": "#737373", "neutral-600": "#525252", "neutral-700": "#404040", "neutral-800": "#262626", "neutral-900": "#171717", "neutral-950": "#0a0a0a",
  "stone-50": "#fafaf9", "stone-100": "#f5f5f4", "stone-200": "#e7e5e4", "stone-300": "#d6d3d1", "stone-400": "#a8a29e", "stone-500": "#78716c", "stone-600": "#57534e", "stone-700": "#44403c", "stone-800": "#292524", "stone-900": "#1c1917", "stone-950": "#0c0a09",
  // Warm
  "red-50": "#fef2f2", "red-100": "#fee2e2", "red-200": "#fecaca", "red-300": "#fca5a5", "red-400": "#f87171", "red-500": "#ef4444", "red-600": "#dc2626", "red-700": "#b91c1c", "red-800": "#991b1b", "red-900": "#7f1d1d", "red-950": "#450a0a",
  "orange-50": "#fff7ed", "orange-100": "#ffedd5", "orange-200": "#fed7aa", "orange-300": "#fdba74", "orange-400": "#fb923c", "orange-500": "#f97316", "orange-600": "#ea580c", "orange-700": "#c2410c", "orange-800": "#9a3412", "orange-900": "#7c2d12", "orange-950": "#431407",
  "amber-50": "#fffbeb", "amber-100": "#fef3c7", "amber-200": "#fde68a", "amber-300": "#fcd34d", "amber-400": "#fbbf24", "amber-500": "#f59e0b", "amber-600": "#d97706", "amber-700": "#b45309", "amber-800": "#92400e", "amber-900": "#78350f", "amber-950": "#451a03",
  "yellow-50": "#fefce8", "yellow-100": "#fef9c3", "yellow-200": "#fef08a", "yellow-300": "#fde047", "yellow-400": "#facc15", "yellow-500": "#eab308", "yellow-600": "#ca8a04", "yellow-700": "#a16207", "yellow-800": "#854d0e", "yellow-900": "#713f12", "yellow-950": "#422006",
  "lime-50": "#f7fee7", "lime-100": "#ecfccb", "lime-200": "#d9f99d", "lime-300": "#bef264", "lime-400": "#a3e635", "lime-500": "#84cc16", "lime-600": "#65a30d", "lime-700": "#4d7c0f", "lime-800": "#3f6212", "lime-900": "#365314", "lime-950": "#1a2e05",
  // Cool
  "green-50": "#f0fdf4", "green-100": "#dcfce7", "green-200": "#bbf7d0", "green-300": "#86efac", "green-400": "#4ade80", "green-500": "#22c55e", "green-600": "#16a34a", "green-700": "#15803d", "green-800": "#166534", "green-900": "#14532d", "green-950": "#052e16",
  "emerald-50": "#ecfdf5", "emerald-100": "#d1fae5", "emerald-200": "#a7f3d0", "emerald-300": "#6ee7b7", "emerald-400": "#34d399", "emerald-500": "#10b981", "emerald-600": "#059669", "emerald-700": "#047857", "emerald-800": "#065f46", "emerald-900": "#064e3b", "emerald-950": "#022c22",
  "teal-50": "#f0fdfa", "teal-100": "#ccfbf1", "teal-200": "#99f6e4", "teal-300": "#5eead4", "teal-400": "#2dd4bf", "teal-500": "#14b8a6", "teal-600": "#0d9488", "teal-700": "#0f766e", "teal-800": "#115e59", "teal-900": "#134e4a", "teal-950": "#042f2e",
  "cyan-50": "#ecfeff", "cyan-100": "#cffafe", "cyan-200": "#a5f3fc", "cyan-300": "#67e8f9", "cyan-400": "#22d3ee", "cyan-500": "#06b6d4", "cyan-600": "#0891b2", "cyan-700": "#0e7490", "cyan-800": "#155e75", "cyan-900": "#164e63", "cyan-950": "#083344",
  "sky-50": "#f0f9ff", "sky-100": "#e0f2fe", "sky-200": "#bae6fd", "sky-300": "#7dd3fc", "sky-400": "#38bdf8", "sky-500": "#0ea5e9", "sky-600": "#0284c7", "sky-700": "#0369a1", "sky-800": "#075985", "sky-900": "#0c4a6e", "sky-950": "#082f49",
  "blue-50": "#eff6ff", "blue-100": "#dbeafe", "blue-200": "#bfdbfe", "blue-300": "#93c5fd", "blue-400": "#60a5fa", "blue-500": "#3b82f6", "blue-600": "#2563eb", "blue-700": "#1d4ed8", "blue-800": "#1e40af", "blue-900": "#1e3a8a", "blue-950": "#172554",
  "indigo-50": "#eef2ff", "indigo-100": "#e0e7ff", "indigo-200": "#c7d2fe", "indigo-300": "#a5b4fc", "indigo-400": "#818cf8", "indigo-500": "#6366f1", "indigo-600": "#4f46e5", "indigo-700": "#4338ca", "indigo-800": "#3730a3", "indigo-900": "#312e81", "indigo-950": "#1e1b4b",
  "violet-50": "#f5f3ff", "violet-100": "#ede9fe", "violet-200": "#ddd6fe", "violet-300": "#c4b5fd", "violet-400": "#a78bfa", "violet-500": "#8b5cf6", "violet-600": "#7c3aed", "violet-700": "#6d28d9", "violet-800": "#5b21b6", "violet-900": "#4c1d95", "violet-950": "#2e1065",
  "purple-50": "#faf5ff", "purple-100": "#f3e8ff", "purple-200": "#e9d5ff", "purple-300": "#d8b4fe", "purple-400": "#c084fc", "purple-500": "#a855f7", "purple-600": "#9333ea", "purple-700": "#7e22ce", "purple-800": "#6b21a8", "purple-900": "#581c87", "purple-950": "#3b0764",
  "fuchsia-50": "#fdf4ff", "fuchsia-100": "#fae8ff", "fuchsia-200": "#f5d0fe", "fuchsia-300": "#f0abfc", "fuchsia-400": "#e879f9", "fuchsia-500": "#d946ef", "fuchsia-600": "#c026d3", "fuchsia-700": "#a21caf", "fuchsia-800": "#86198f", "fuchsia-900": "#701a75", "fuchsia-950": "#4a044e",
  "pink-50": "#fdf2f8", "pink-100": "#fce7f3", "pink-200": "#fbcfe8", "pink-300": "#f9a8d4", "pink-400": "#f472b6", "pink-500": "#ec4899", "pink-600": "#db2777", "pink-700": "#be185d", "pink-800": "#9d174d", "pink-900": "#831843", "pink-950": "#500724",
  "rose-50": "#fff1f2", "rose-100": "#ffe4e6", "rose-200": "#fecdd3", "rose-300": "#fda4af", "rose-400": "#fb7185", "rose-500": "#e11d48", "rose-600": "#be123c", "rose-700": "#9f1239", "rose-800": "#881337", "rose-900": "#4c0519", "rose-950": "#2e0a16",
  // Specials (representative swatches; semantic meaning is "depends")
  "white": "#ffffff",
  "black": "#000000",
})

/**
 * Resolved color value for one of `bg` / `text` / `border`. Either
 * a palette `family + shade` reference, a special value (`white`,
 * `black`, etc.), a design-token reference (e.g. bg-[var(--acme-token-name)],
 * Tailwind v4 arbitrary-value syntax), or null when the property has
 * no color set in the class list.
 *
 * `raws` accumulates EVERY class that matched this property — so the
 * mutator removes them all on commit, even if a prior edit left a
 * duplicate (cf. spacing P2 in this branch).
 *
 * Token preview hex is resolved by the picker UI at display time
 * (it has the tokens fetch); the parser only carries the name.
 */
export type ColorValue =
  | { kind: "palette"; family: string; shade: number; raws: string[] }
  | { kind: "special"; name: string; raws: string[] }
  | { kind: "token"; tokenName: string; raws: string[] }
  /**
   * A computed color that parsed but maps to no palette / special /
   * token — a themed or arbitrary value (e.g. a shadcn `--secondary`
   * background, an inline `rgb()`). `css` is the raw computed string so
   * the swatch can render the ACTUAL color instead of going blank.
   * Display-only: never produced by `parseColor` (only by `inferColor`)
   * and never emitted as a class, so `raws` is always empty.
   */
  | { kind: "custom"; css: string; raws: string[] }
  | null

/**
 * Build a regex that matches `<prefix>-<family>-<shade>` exactly,
 * with no responsive / state / negative variants. The strict anchor
 * mirrors the spacing parser.
 */
function paletteRegex(prefix: string): RegExp {
  const families = TAILWIND_COLOR_FAMILIES.join("|")
  const shades = TAILWIND_COLOR_SHADES.join("|")
  return new RegExp(`^${prefix}-(${families})-(${shades})$`)
}

function specialRegex(prefix: string): RegExp {
  const specials = TAILWIND_SPECIAL_COLORS.join("|")
  return new RegExp(`^${prefix}-(${specials})$`)
}

/**
 * Match Tailwind v4 arbitrary-value classes that reference a CSS
 * custom property — `bg-[var(--acme-color-background-primary)]`.
 *
 * The captured group is the token name (with leading dashes). Only
 * accept variable references that look like design tokens (start
 * with `--`) so we don't false-match arbitrary inline values like
 * `bg-[#fff]` or `bg-[rgb(0,0,0)]` — those stay opaque to the token
 * picker.
 */
function tokenRegex(prefix: string): RegExp {
  return new RegExp(`^${prefix}-\\[var\\(\\s*(--[a-z0-9-]+)\\s*\\)\\]$`)
}

/**
 * Parse the color value for one of `bg`, `text`, or `border` from a
 * class list.
 *
 * **Important — text and border ambiguity.** `text-` is also used for
 * font sizing (`text-base`, `text-center`, etc.); `border-` is also
 * used for border width (`border`, `border-2`, `border-t`). The
 * regexes above are anchored to family+shade or named special, so
 * `text-base` and `border-2` won't match — they pass through as
 * unrelated classes (not even `preservedRaw`).
 */
export function parseColor(
  classes: readonly string[],
  property: ColorProperty,
): ColorValue {
  const palette = paletteRegex(property)
  const special = specialRegex(property)
  const token = tokenRegex(property)

  let result: ColorValue = null
  const raws: string[] = []

  for (const cls of classes) {
    let matched: ColorValue | null = null
    const palMatch = palette.exec(cls)
    if (palMatch) {
      matched = {
        kind: "palette",
        family: palMatch[1],
        shade: parseInt(palMatch[2], 10),
        raws: [cls],
      }
    } else {
      const spMatch = special.exec(cls)
      if (spMatch) {
        matched = { kind: "special", name: spMatch[1], raws: [cls] }
      } else {
        const tokMatch = token.exec(cls)
        if (tokMatch) {
          matched = { kind: "token", tokenName: tokMatch[1], raws: [cls] }
        }
      }
    }
    if (!matched) continue
    raws.push(cls)
    // Cascade-correct: the LAST match wins for the displayed value;
    // every match accumulates in raws so removeAll catches duplicates.
    result = matched
  }
  if (result) return { ...result, raws }
  return null
}

/**
 * Build a mutation that sets `<property>` to the given value, removing
 * every class the parser already matched. Pass `null` to clear.
 */
export function setColor(
  current: ColorValue,
  next:
    | { kind: "palette"; family: string; shade: number }
    | { kind: "special"; name: string }
    | { kind: "token"; tokenName: string }
    | null,
  property: ColorProperty,
): { remove: string[]; add: string[] } {
  const remove = current ? [...current.raws] : []
  if (next === null) return { remove, add: [] }
  if (next.kind === "palette") {
    return { remove, add: [`${property}-${next.family}-${next.shade}`] }
  }
  if (next.kind === "token") {
    // Tailwind v4 arbitrary value referencing the CSS custom property.
    // Tailwind generates `<property>: var(<tokenName>)` at build/JIT time.
    return { remove, add: [`${property}-[var(${next.tokenName})]`] }
  }
  return { remove, add: [`${property}-${next.name}`] }
}

/** Look up the hex preview for a color value. Returns null when unknown. */
export function previewHex(value: ColorValue): string | null {
  if (!value) return null
  if (value.kind === "palette") {
    return TAILWIND_COLOR_HEX[`${value.family}-${value.shade}`] ?? null
  }
  if (value.kind === "token") {
    // Tokens carry only the name; the picker resolves the value
    // via its tokens fetch (TAILWIND_COLOR_HEX has no entries for
    // design tokens).
    return null
  }
  if (value.kind === "custom") {
    // The raw computed color is directly renderable.
    return value.css
  }
  if (value.name === "white" || value.name === "black") {
    return TAILWIND_COLOR_HEX[value.name]
  }
  return null
}
