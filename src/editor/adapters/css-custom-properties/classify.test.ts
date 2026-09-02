import { describe, expect, it } from 'vitest'
import { genericClassifier, tailwindThemeClassifier } from './classify'
import type { Classification } from './classify'

describe('genericClassifier', () => {
  const cases: Array<[name: string, value: string, expected: Classification]> = [
    // Color group — name match, no subcategory.
    ['--color-primary', '#ff0000', { category: 'color' }],
    ['--fill-icon', '#123456', { category: 'color' }],
    // Color group — subcategory: background.
    ['--bg-surface', '#ffffff', { category: 'color', subcategory: 'background' }],
    ['--background-secondary', '#f5f5f5', { category: 'color', subcategory: 'background' }],
    // Color group — subcategory: text (explicit brief example).
    ['--text-color-muted', '#666666', { category: 'color', subcategory: 'text' }],
    // "foreground"/"fg" are themselves full color TRIGGER keywords (promoted
    // amendment) — they drive both the category match and the `text`
    // subcategory on their own, not merely as a subcategory hint riding on
    // another trigger like "color" in `--icon-fg-color`.
    ['--icon-fg-color', '#111111', { category: 'color', subcategory: 'text' }],
    ['--fg-muted', '#111111', { category: 'color', subcategory: 'text' }],
    ['--foreground-default', '#111111', { category: 'color', subcategory: 'text' }],
    // var() reference amendment: name rules run FIRST regardless of value
    // shape, so a "foreground" name still classifies as color/text even
    // though the value is a var() reference, not a literal color — shadcn's
    // `--foreground-default: var(--gray-950)` pattern.
    ['--foreground-default', 'var(--gray-950)', { category: 'color', subcategory: 'text' }],
    // var() reference with no name-rule match: the value-shape fallback is
    // explicitly skipped for var() references, so this falls straight to
    // `other` rather than (failing to, but now explicitly not even trying to)
    // match the hex/functional regexes against the reference text.
    ['--gray-950', 'var(--gray-900)', { category: 'other' }],
    // Color group — subcategory: border.
    ['--border-color-default', '#dddddd', { category: 'color', subcategory: 'border' }],
    // Space group.
    ['--space-md', '16px', { category: 'space' }],
    ['--spacing-4', '1rem', { category: 'space' }],
    ['--gap-lg', '24px', { category: 'space' }],
    ['--inset-sm', '8px', { category: 'space' }],
    ['--margin-block', '12px', { category: 'space' }],
    ['--padding-inline', '12px', { category: 'space' }],
    // Border radius.
    ['--radius-sm', '4px', { category: 'border-radius' }],
    ['--rounded-full', '9999px', { category: 'border-radius' }],
    // Shadow.
    ['--shadow-elevation-2', '0 2px 4px rgba(0,0,0,.1)', { category: 'shadow' }],
    ['--elevation-1', '0 1px 2px rgba(0,0,0,.05)', { category: 'shadow' }],
    // Font size / weight / line height.
    ['--font-size-lg', '18px', { category: 'font-size' }],
    ['--font-weight-bold', '700', { category: 'font-weight' }],
    ['--line-height-tight', '1.1', { category: 'line-height' }],
    ['--leading-normal', '1.5', { category: 'line-height' }],
    // Border width.
    ['--border-width-thin', '1px', { category: 'border-width' }],
    // Value-shape fallback — no name match.
    ['--brand-500', '#336699', { category: 'color' }],
    ['--overlay', 'rgb(0, 0, 0)', { category: 'color' }],
    ['--accent', 'oklch(0.7 0.1 200)', { category: 'color' }],
    ['--tone', 'hsl(200 50% 50%)', { category: 'color' }],
    ['--wide-gamut', 'color(display-p3 1 0 0)', { category: 'color' }],
    // Value-shape fallback — nothing matches at all.
    ['--z-index-modal', '1000', { category: 'other' }],
    ['--transition-duration', '200ms', { category: 'other' }],
  ]

  it.each(cases)('%s: %s -> %o', (name, value, expected) => {
    expect(genericClassifier(name, value)).toEqual(expected)
  })
})

describe('tailwindThemeClassifier', () => {
  const cases: Array<[name: string, value: string, expected: Classification]> = [
    // Bare `--color-*` theme token, no background/text/border keyword in the
    // remainder — defaults to 'background' (see classify.ts's rationale
    // comment) so it's visible in the inspector's color-section rows instead
    // of invisible in all three.
    ['--color-brand', 'oklch(0.6 0.2 250)', { category: 'color', subcategory: 'background' }],
    // `--color-*` names that DO carry a background/text/border keyword
    // derive the matching subcategory (mirrors genericClassifier's
    // `colorSubcategory` helper).
    [
      '--color-background-primary',
      '#ffffff',
      { category: 'color', subcategory: 'background' },
    ],
    ['--color-text-muted', '#666666', { category: 'color', subcategory: 'text' }],
    ['--color-border-default', '#dddddd', { category: 'color', subcategory: 'border' }],
    ['--spacing-4', '1rem', { category: 'space' }],
    ['--radius-lg', '0.75rem', { category: 'border-radius' }],
    ['--shadow-md', '0 4px 6px rgba(0,0,0,.1)', { category: 'shadow' }],
    ['--inset-shadow-sm', '0 1px 2px rgba(0,0,0,.05) inset', { category: 'shadow' }],
    // Explicit brief example: tailwind namespace wins over the deeper
    // generic-color-vs-font-size ambiguity in the raw name.
    ['--text-xl', '1.25rem', { category: 'font-size' }],
    ['--font-weight-bold', '700', { category: 'font-weight' }],
    ['--leading-tight', '1.1', { category: 'line-height' }],
    ['--font-sans', 'Inter, sans-serif', { category: 'other' }],
  ]

  it.each(cases)('%s: %s -> %o', (name, value, expected) => {
    expect(tailwindThemeClassifier(name, value)).toEqual(expected)
  })

  it('delegates to genericClassifier when no tailwind namespace prefix matches', () => {
    // Doesn't start with --radius- (starts with --my-), so falls through to
    // genericClassifier, which name-matches "radius".
    expect(tailwindThemeClassifier('--my-radius-token', '4px')).toEqual({
      category: 'border-radius',
    })
  })

  it('delegates to genericClassifier for the value-shape fallback too', () => {
    expect(tailwindThemeClassifier('--brand-500', '#336699')).toEqual({
      category: 'color',
    })
  })
})
