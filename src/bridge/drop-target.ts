/**
 * Pure drop-target geometry for direct-manipulation drag-to-move (Phase 2).
 *
 * The DOM-touching parts (elementsFromPoint walk, reading child rects) live in
 * the DragMoveOverlay manager; this module holds the pure index math so it's
 * unit-testable without a browser. Given the on-axis midpoints of a container's
 * (editable) children in document order, plus the drop coordinate on that axis,
 * it returns the 0-based insertion index — i.e. how many children the drop falls
 * AFTER. Matches the `destIndex` contract of apply-move-edit.
 */

export type DropAxis = "vertical" | "horizontal"

/**
 * Insertion index for a drop at `point` (an x or y client coordinate, matching
 * the axis the midpoints were projected on) among `childMidpoints` (the same
 * axis' midpoints of the container's children, in document order).
 *
 * Returns the count of children whose midpoint is at-or-before the drop point —
 * i.e. dropping above the first child's midpoint → 0 (insert first), below the
 * last → `n` (append). Empty container → 0.
 */
export function computeDropIndex(
  childMidpoints: readonly number[],
  point: number,
): number {
  let i = 0
  while (i < childMidpoints.length && point > childMidpoints[i]) i++
  return i
}

/**
 * Pick the layout axis for index computation from a container's computed
 * `flex-direction`. Row (and reverse) layouts order children horizontally → use
 * X; everything else (column flex, grid, block flow) → use Y. A coarse-but-safe
 * v1 heuristic (grid is treated as vertical; good enough for the common
 * single-column / stacked cases — refine if a row-grid case is hit).
 */
export function axisForFlexDirection(flexDirection: string | undefined): DropAxis {
  if (!flexDirection) return "vertical"
  return /^row/.test(flexDirection.trim()) ? "horizontal" : "vertical"
}

/**
 * Whether a flex-direction reverses screen order vs DOM order
 * (`row-reverse` / `column-reverse`). For these, DOM-order child midpoints are
 * DESCENDING in screen coords, so the caller must reverse before
 * `computeDropIndex` (ascending) and map the result back to a DOM index.
 */
export function isReverseFlexDirection(flexDirection: string | undefined): boolean {
  return !!flexDirection && /-reverse$/.test(flexDirection.trim())
}

/** Project a rect to its midpoint on the given axis. */
export function rectMidpoint(
  rect: { top: number; bottom: number; left: number; right: number },
  axis: DropAxis,
): number {
  return axis === "horizontal"
    ? (rect.left + rect.right) / 2
    : (rect.top + rect.bottom) / 2
}
