/**
 * Token classifiers for raw CSS custom properties (parsed by `./parser`).
 *
 * These are pure name/value heuristics, substrate-neutral by construction —
 * no design system's naming convention is privileged. A generic prototype's `:root`/`@theme` tokens
 * don't follow any single convention, so classification is layered:
 * `tailwindThemeClassifier` recognizes Tailwind v4's `@theme` namespace
 * prefixes first (unambiguous — the namespace IS the category) and falls back
 * to `genericClassifier` for anything outside those namespaces.
 */
import type { TokenCategory } from '@/editor/core/design-tokens'

export interface Classification {
  category: TokenCategory
  subcategory?: string
}

export type TokenClassifier = (name: string, value: string) => Classification

/** Name-substring keyword groups, checked in order — first match wins. */
const COLOR_KEYWORDS = [
  'color',
  'background',
  'bg',
  'border-color',
  'text-color',
  'fill',
  'stroke',
  // Promoted to full triggers (not just a subcategory hint riding on another
  // trigger like "color"/"background") — shadcn-style token sets commonly
  // name color tokens `--foreground`/`--fg-*` with no other color keyword in
  // sight (e.g. `--foreground-default`), and those should classify as color
  // on the name alone.
  'foreground',
  'fg',
]
const SPACE_KEYWORDS = ['space', 'spacing', 'gap', 'inset', 'margin', 'padding']
const RADIUS_KEYWORDS = ['radius', 'rounded']
const SHADOW_KEYWORDS = ['shadow', 'elevation']
const LINE_HEIGHT_KEYWORDS = ['line-height', 'leading']
const BORDER_WIDTH_KEYWORDS = ['border-width', 'stroke-width']

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i
const FUNCTIONAL_COLOR_RE = /^(rgb|hsl|oklch|oklab|color\()/i
const VAR_REFERENCE_RE = /^var\(/i

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function colorSubcategory(lower: string): string | undefined {
  if (lower.includes('background') || lower.includes('bg')) return 'background'
  if (lower.includes('text') || lower.includes('foreground') || lower.includes('fg')) {
    return 'text'
  }
  if (lower.includes('border')) return 'border'
  return undefined
}

/**
 * Name-first heuristics, value-shape fallback (hex/rgb/hsl/oklch → color;
 * everything else unclassified name-wise and not color-shaped → `other`).
 *
 * Rules are checked in order — first match wins. See task brief for the
 * exact rule table.
 */
export const genericClassifier: TokenClassifier = (name, value) => {
  const lower = name.toLowerCase()

  if (includesAny(lower, COLOR_KEYWORDS)) {
    const subcategory = colorSubcategory(lower)
    return subcategory ? { category: 'color', subcategory } : { category: 'color' }
  }
  if (includesAny(lower, SPACE_KEYWORDS)) return { category: 'space' }
  if (includesAny(lower, RADIUS_KEYWORDS)) return { category: 'border-radius' }
  if (includesAny(lower, SHADOW_KEYWORDS)) return { category: 'shadow' }
  if (lower.includes('font-size')) return { category: 'font-size' }
  if (lower.includes('font-weight')) return { category: 'font-weight' }
  if (includesAny(lower, LINE_HEIGHT_KEYWORDS)) return { category: 'line-height' }
  if (includesAny(lower, BORDER_WIDTH_KEYWORDS)) return { category: 'border-width' }

  const trimmedValue = value.trim()
  // A `var(--…)` reference is never itself color-SHAPED — it's an
  // indirection, not a literal value. Name rules above already had first
  // crack at classifying it; if none matched, fall straight to `other`
  // rather than testing the hex/functional regexes against reference text
  // (which wouldn't match anyway, but this makes "name rules only for
  // var() references" an explicit, independently-testable branch instead of
  // an accident of the regexes never matching `var(...)`).
  if (VAR_REFERENCE_RE.test(trimmedValue)) {
    return { category: 'other' }
  }
  if (HEX_COLOR_RE.test(trimmedValue) || FUNCTIONAL_COLOR_RE.test(trimmedValue)) {
    return { category: 'color' }
  }
  return { category: 'other' }
}

/**
 * Tailwind v4 `@theme` namespaces: `--color-*`, `--spacing-*`, `--radius-*`,
 * `--shadow-*`/`--inset-shadow-*`, `--text-*`, `--font-weight-*`,
 * `--leading-*`, `--font-*`. Anything outside these namespace prefixes
 * delegates to `genericClassifier`.
 *
 * Order matters: `--font-weight-*` must be checked before the bare `--font-*`
 * fallback, since it also starts with `--font-`.
 */
export const tailwindThemeClassifier: TokenClassifier = (name, value) => {
  if (name.startsWith('--color-')) {
    // Derive a subcategory the same way `genericClassifier` does for a
    // color-keyword name (`colorSubcategory` on the lowercased name) — e.g.
    // `--color-background-primary` → 'background', `--color-border-default`
    // → 'border'. Unlike `genericClassifier`, default to 'background' when
    // no keyword matches (`--color-brand`, `--color-primary`, …): the
    // inspector's color-section rows (`src/components/editor/color-section.tsx`)
    // filter tokens by `category === 'color' && subcategory === <row>` across
    // exactly three rows (background/text/border), so a token with NO
    // subcategory is invisible in ALL of them — silently unusable despite
    // being a real `@theme` color token. `genericClassifier` leaving it
    // `undefined` is fine for a name that never matched a color KEYWORD in
    // the first place (its category is a value-shape guess, not a namespace
    // guarantee); here the `--color-` namespace prefix is unambiguous, so a
    // bare theme color name is a design-system palette entry most commonly
    // applied as a fill/background (buttons, badges, surfaces) — 'background'
    // is the row where it's most useful to show up, and "visible in one row"
    // beats "invisible in all three".
    return { category: 'color', subcategory: colorSubcategory(name.toLowerCase()) ?? 'background' }
  }
  if (name.startsWith('--spacing-')) return { category: 'space' }
  if (name.startsWith('--radius-')) return { category: 'border-radius' }
  if (name.startsWith('--shadow-') || name.startsWith('--inset-shadow-')) {
    return { category: 'shadow' }
  }
  if (name.startsWith('--text-')) return { category: 'font-size' }
  if (name.startsWith('--font-weight-')) return { category: 'font-weight' }
  if (name.startsWith('--leading-')) return { category: 'line-height' }
  if (name.startsWith('--font-')) return { category: 'other' }

  return genericClassifier(name, value)
}
