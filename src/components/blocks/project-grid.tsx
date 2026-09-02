"use client"

import { useEffect, useState } from "react"

/**
 * The project-card grid's layout maths and colour ramp — the two things that
 * make the Editor launcher and the Viewer dashboard look like one product.
 *
 * Shared rather than copied, because both halves are the kind of value that
 * drifts silently: a tint ramp diverging by one alpha step, or one surface
 * breaking to three columns where the other breaks to four, reads as
 * sloppiness long before anyone can name what changed. The cards themselves
 * are NOT shared — the Editor's card is one big open-this-repo button, the
 * Viewer's carries a visibility badge, a deploy state and two destinations.
 * Forcing one component to serve both would need more props than markup.
 * What is genuinely common is the grid, and that is what lives here.
 */

/**
 * Column count by viewport, and the SINGLE source of truth for it.
 *
 * The grid's `gridTemplateColumns` is set from this at render rather than
 * from Tailwind `sm:grid-cols-*` classes, because the row tint below needs
 * the column count as a NUMBER: which row a card lands in is `index /
 * columns`, and no CSS selector can express "the third row" when the column
 * count is responsive. Expressing the columns twice — once as classes for
 * layout, once as numbers for the tint — is a drift trap where the colour
 * banding silently stops matching the visual rows at one breakpoint. One
 * list, both jobs.
 *
 * Widest first; `resolveColumnCount` takes the first match.
 */
const COLUMN_STEPS = [
  { minWidth: 1024, columns: 4 },
  { minWidth: 640, columns: 3 },
  { minWidth: 0, columns: 2 },
] as const

/**
 * Row tints: teal, fading down the page.
 *
 * Alpha steps on `--primary` (which IS the brand teal) rather than five new
 * teal colour tokens. That is not just brevity — it is what makes the fade
 * correct in dark mode for free. A ramp of fixed light-teal hex values would
 * invert on a dark ground: the "lightest" row would glow brightest and the
 * banding would read upside down. A tint of the ground always settles toward
 * the ground, so row 5 recedes in both modes, which is the actual intent.
 *
 * The ceiling is deliberate. These stay under 50% so the tinted strip never
 * drifts far from the mode's own background lightness, which is what lets one
 * `text-foreground` carry legible contrast on every row in BOTH modes. Push
 * row 1 up to a solid teal and the strip's label needs a per-row, per-mode
 * colour to stay readable.
 *
 * Rows past the last step clamp to it rather than cycling: a long list should
 * settle into calm, not restart at full saturation halfway down.
 */
export const ROW_TINTS = [
  "bg-primary/45",
  "bg-primary/34",
  "bg-primary/25",
  "bg-primary/17",
  "bg-primary/10",
] as const

function resolveColumnCount(): number {
  const fallback = COLUMN_STEPS[COLUMN_STEPS.length - 1].columns
  if (typeof window === "undefined") return fallback
  return (
    COLUMN_STEPS.find((s) => window.matchMedia(`(min-width: ${s.minWidth}px)`).matches)
      ?.columns ?? fallback
  )
}

/**
 * The live column count, plus the inline style that realises it.
 *
 * The columns are a measured, responsive number, so the returned `style` is
 * exactly the "genuinely dynamic value" that belongs in `style` rather than
 * in a className.
 */
export function useProjectGrid(): {
  columns: number
  style: { gridTemplateColumns: string }
} {
  const [columns, setColumns] = useState(resolveColumnCount)
  useEffect(() => {
    const queries = COLUMN_STEPS.filter((s) => s.minWidth > 0).map((s) =>
      window.matchMedia(`(min-width: ${s.minWidth}px)`),
    )
    const update = () => setColumns(resolveColumnCount())
    queries.forEach((q) => q.addEventListener("change", update))
    // Resolve once on mount: the initial state ran during render, which is
    // before the real viewport is knowable under SSR/hydration.
    update()
    return () => queries.forEach((q) => q.removeEventListener("change", update))
  }, [])
  return {
    columns,
    style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
  }
}

/**
 * The tint for the card at `index`, given the live column count.
 *
 * Index over the FILTERED list, not the full one, so the banding re-flows to
 * match what is actually on screen — banding an unfiltered index leaves a
 * filtered grid with gaps in its colour sequence.
 */
export function rowTint(index: number, columns: number): string {
  return ROW_TINTS[Math.min(Math.floor(index / columns), ROW_TINTS.length - 1)]
}
