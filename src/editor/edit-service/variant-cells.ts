/**
 * Variant grid cells for the F3 isolation route (Storybook-style view).
 *
 * Takes the variant hints F1's catalog discovers from a component's
 * manifest and projects them into a flat list of "cells" — one per
 * (axis × value) — that the substrate plugin renders into a grid.
 *
 * Design choice: one row per axis, each cell varies *only* that
 * axis's prop (other props use the component's own defaults). This
 * avoids cartesian explosion while still showing the designer how the
 * component reads across each variant dimension. A 3-axis component
 * with 4 values per axis renders 12 cells (3 × 4) instead of 64
 * (4 × 4 × 4).
 *
 * Pure function — no I/O. Called shell-side so the substrate plugin
 * stays thin (the plugin just reads `?variants=<JSON>` from the URL).
 */
import type { VariantAxis } from './component-catalog'

export interface VariantCell {
  /** Designer-facing label (e.g. "appearance: primary"). */
  label: string
  /** Prop set to mount the component with. */
  props: Record<string, string | number | boolean>
  /**
   * Default-slot text content for the cell. Components with a text
   * slot (KButton, KCard, KTooltip) render invisibly when mounted
   * with no children — passing the component name here gives them
   * something to display.
   */
  children?: string
}

/** Per-axis cap. Mirrors F1's catalog cap (12) but tighter for grid layout. */
const PER_AXIS_CAP = 8
/** Total grid cap. Above this the grid becomes unscannable. */
const TOTAL_CAP = 24

export function buildVariantCells(
  hints: ReadonlyArray<VariantAxis>,
  /**
   * Component name. When set, becomes the default-slot text for each
   * cell — the substrate plugin uses it as `h(Component, props,
   * () => children)` so text-slot components are visible.
   */
  componentName?: string,
): VariantCell[] {
  const cells: VariantCell[] = []
  for (const axis of hints) {
    const values = axis.values.slice(0, PER_AXIS_CAP)
    const label = axis.label ?? axis.prop
    for (const v of values) {
      const cell: VariantCell = {
        label: `${label}: ${String(v)}`,
        props: { [axis.prop]: v },
      }
      if (componentName) cell.children = componentName
      cells.push(cell)
      if (cells.length >= TOTAL_CAP) return cells
    }
  }
  return cells
}
