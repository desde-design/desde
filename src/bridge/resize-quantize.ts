/**
 * Pure width quantizer for direct-manipulation drag-to-resize (Phase 4 of
 * tasks/editor-direct-manipulation.md). A resize drag yields a pixel width;
 * we snap it to the substrate's idiomatic width vocabulary (Tailwind) rather
 * than emit a raw pixel value — constrained-layout (NEXT #3 D1): edits stay
 * responsive/idiomatic. Near a common fraction of the parent → a fraction
 * class (`w-1/2`); otherwise the nearest fixed step on Tailwind's spacing scale
 * (`w-{n}` = n·0.25rem). Lives in the bridge (can't import the shell's
 * tailwind-classes), so it carries its own small vocabulary.
 *
 * Pure + unit-tested; the resize OVERLAY (DOM handles, drag) consumes it.
 */

/** [fraction-of-parent, class] — checked within FRACTION_TOLERANCE first. */
const WIDTH_FRACTIONS: ReadonlyArray<[number, string]> = [
  [1, "w-full"],
  [3 / 4, "w-3/4"],
  [2 / 3, "w-2/3"],
  [1 / 2, "w-1/2"],
  [1 / 3, "w-1/3"],
  [1 / 4, "w-1/4"],
]

const FRACTION_TOLERANCE = 0.06 // ±6% of the parent snaps to a fraction

/**
 * Tailwind's default spacing scale (used for `w-{n}`; n·0.25rem). Mirrors
 * SPACING_SCALE in the shell's tailwind-classes.ts (kept in sync by hand — the
 * bridge can't import shell modules).
 */
const SPACING_SCALE: readonly number[] = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5,
  4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16,
  20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64,
  72, 80, 96,
]

/** Pixels per rem — Tailwind's default (1rem = 16px); a `w-{n}` step is n·4px. */
const PX_PER_STEP = 4

function nearestSpacingStep(stepValue: number): number {
  let best = SPACING_SCALE[0]
  let bestDiff = Math.abs(stepValue - best)
  for (const s of SPACING_SCALE) {
    const d = Math.abs(stepValue - s)
    if (d < bestDiff) {
      bestDiff = d
      best = s
    }
  }
  return best
}

function formatStep(step: number): string {
  return String(step)
}

/**
 * Quantize a dragged pixel width to a Tailwind width class. `parentPx` is the
 * containing block's content width (for fraction matching); pass 0/undefined to
 * skip fractions and always use the fixed scale.
 */
export function quantizeWidthClass(px: number, parentPx?: number): string {
  const w = Math.max(0, px)
  if (parentPx && parentPx > 0) {
    const frac = w / parentPx
    let bestClass: string | null = null
    let bestDiff = FRACTION_TOLERANCE
    for (const [f, cls] of WIDTH_FRACTIONS) {
      const d = Math.abs(frac - f)
      if (d <= bestDiff) {
        bestDiff = d
        bestClass = cls
      }
    }
    if (bestClass) return bestClass
  }
  // Fixed-width fallback: snap px → nearest spacing-scale step.
  const step = nearestSpacingStep(w / PX_PER_STEP)
  return `w-${formatStep(step)}`
}
