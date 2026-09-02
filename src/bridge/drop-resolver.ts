/**
 * Shared DOM drop-target resolver for direct-manipulation gestures
 * (drag-to-move Phase 2 + insert-at-point Phase 3). The pure index math lives
 * in ./drop-target; this owns the DOM walk (elementsFromPoint, child rects,
 * edge-proximity) and returns a {@link DropResolution} both overlays render +
 * commit from. Factored out of DragMoveOverlay so the insert-placement overlay
 * reuses identical resolution (one resolver, one behaviour to harden).
 *
 * `exclude` is the dragged element for a move (can't drop into yourself or your
 * subtree); pass `null` for insert (nothing to exclude).
 */

import { attributeElement } from "./bridge-runtime"
import { isBridgeOwnElement } from "./selector-helpers"
import {
  axisForFlexDirection,
  computeDropIndex,
  isReverseFlexDirection,
  rectMidpoint,
  type DropAxis,
} from "./drop-target"

export interface DropResolution {
  container: Element
  index: number
  axis: DropAxis
  /** The on-axis coordinate to draw the insertion line at. */
  linePos: number
  /** Cross-axis extent of the indicator (container's box on the other axis). */
  crossStart: number
  crossEnd: number
}

/** Direct children of `el` with an editTarget, minus `exclude`. */
export function editableChildren(el: Element, exclude: Element | null): Element[] {
  return Array.from(el.children).filter(
    (c) => c !== exclude && !!attributeElement(c)?.editTarget,
  )
}

/** Nearest ancestor of `start` (inclusive) with an editTarget, stopping before
 *  `exclude` or its subtree. Null if none. */
export function nearestEditableAncestor(
  start: Element | null,
  exclude: Element | null,
): Element | null {
  let cur: Element | null = start
  while (cur && cur !== document.body) {
    if (exclude && (cur === exclude || exclude.contains(cur))) return null
    if (attributeElement(cur)?.editTarget) return cur
    cur = cur.parentElement
  }
  return null
}

/**
 * Resolve the destination container + insertion index for a drop at (x,y).
 *
 * v1 LIMITATION (codex): for a drop over a SLOTTED child inside a user-authored
 * component, `container.editTarget` may point at the child component's internal
 * DOM (a different file) rather than the caller's `<Component>…</Component>`
 * slot site. The Layers panel has effective-slot-parent resolution; replicating
 * it here is a follow-up. Slotted/cross-file cases refuse gracefully downstream.
 */
export function resolveDropTarget(
  doc: Document,
  x: number,
  y: number,
  exclude: Element | null,
  opts?: {
    /**
     * Allow dropping INTO a childless element when the cursor is in its middle
     * (insert-at-point). For MOVE this is false (a childless element is treated
     * as a sibling — the documented empty-container limitation); for INSERT
     * it's true so "add the first child to an empty <div>" works (codex).
     */
    intoChildless?: boolean
  },
): DropResolution | null {
  // Element the cursor is over — deepest editable element, excluding the
  // excluded subtree + our own overlay hosts.
  const stack = doc.elementsFromPoint(x, y)
  let hit: Element | null = null
  for (const el of stack) {
    if (isBridgeOwnElement(el)) continue
    let cur: Element | null = el
    while (cur && cur !== doc.body) {
      if (exclude && (cur === exclude || exclude.contains(cur))) break
      if (attributeElement(cur)?.editTarget) {
        hit = cur
        break
      }
      cur = cur.parentElement
    }
    if (hit) break
  }
  if (!hit) return null

  // Edge-proximity container rule (codex): the hovered element's nearest
  // editable parent is the "reorder among siblings" container. Decide
  // into-vs-beside by where the cursor sits within the hovered element on the
  // parent's layout axis: outer ~25% (near an edge) → BESIDE it (container =
  // parent); middle → INTO it only if it's a populated container, else still
  // beside. Makes card/list reorder work (drop on B's edge → beside B) while
  // still allowing drop-into-a-container's-body. (Thresholds dogfood-tunable.)
  const reorderParent = nearestEditableAncestor(hit.parentElement, exclude)
  let container: Element | null
  if (reorderParent) {
    const ps = getComputedStyle(reorderParent)
    const pAxis = axisForFlexDirection(
      ps.display.includes("flex") ? ps.flexDirection : undefined,
    )
    const hr = hit.getBoundingClientRect()
    const pos = pAxis === "horizontal" ? x : y
    const start = pAxis === "horizontal" ? hr.left : hr.top
    const size = pAxis === "horizontal" ? hr.width : hr.height
    const frac = size > 0 ? (pos - start) / size : 0.5
    const inMiddle = frac > 0.25 && frac < 0.75
    const hitHasChildren = editableChildren(hit, exclude).length > 0
    // Middle → drop INTO the hovered element when it's a populated container,
    // or (insert mode) when childless drops are allowed. Otherwise reorder
    // beside it (in its parent). Edge always reorders beside.
    container =
      inMiddle && (hitHasChildren || opts?.intoChildless) ? hit : reorderParent
  } else {
    container = hit
  }
  if (!container) return null

  const cs = getComputedStyle(container)
  const flexDir = cs.display.includes("flex") ? cs.flexDirection : undefined
  const axis = axisForFlexDirection(flexDir)
  const reverse = isReverseFlexDirection(flexDir)
  const children = editableChildren(container, exclude)
  const midpoints = children.map((c) => rectMidpoint(c.getBoundingClientRect(), axis))
  const pos = axis === "horizontal" ? x : y
  // Reverse layouts: DOM order is descending in screen coords — compute the
  // screen-order index against ascending midpoints, then map to a DOM index.
  let index: number
  if (reverse) {
    const ascending = [...midpoints].reverse()
    index = children.length - computeDropIndex(ascending, pos)
  } else {
    index = computeDropIndex(midpoints, pos)
  }

  // Indicator geometry: a line at the insertion boundary spanning the
  // container's cross-axis box. (Reverse-flex preview edge is approximate —
  // cosmetic, codex P3.)
  const cRect = container.getBoundingClientRect()
  const before = children[index]?.getBoundingClientRect()
  const after = children[index - 1]?.getBoundingClientRect()
  let linePos: number
  if (axis === "horizontal") {
    linePos = before ? before.left : after ? after.right : cRect.left
  } else {
    linePos = before ? before.top : after ? after.bottom : cRect.top
  }
  return {
    container,
    index,
    axis,
    linePos,
    crossStart: axis === "horizontal" ? cRect.top : cRect.left,
    crossEnd: axis === "horizontal" ? cRect.bottom : cRect.right,
  }
}

/** Render a drop-indicator line into `el` from a resolution (or hide it). */
export function renderDropIndicator(el: HTMLElement, drop: DropResolution | null): void {
  if (!drop) {
    el.style.display = "none"
    return
  }
  const s = el.style
  s.display = "block"
  const THICK = 2
  if (drop.axis === "horizontal") {
    s.left = `${drop.linePos - THICK / 2}px`
    s.top = `${drop.crossStart}px`
    s.width = `${THICK}px`
    s.height = `${drop.crossEnd - drop.crossStart}px`
  } else {
    s.top = `${drop.linePos - THICK / 2}px`
    s.left = `${drop.crossStart}px`
    s.height = `${THICK}px`
    s.width = `${drop.crossEnd - drop.crossStart}px`
  }
}
