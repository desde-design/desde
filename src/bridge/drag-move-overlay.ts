/**
 * DragMoveOverlay — direct-manipulation drag-to-move/reorder (Phase 2 of
 * tasks/editor-direct-manipulation.md). A `SelectModeOverlay` manager wired
 * the same way as TableEdgeOverlay (capture-phase listeners, Shadow-DOM host,
 * bridge-runtime DI, navigation teardown).
 *
 * Gesture: in editor mode, press-and-drag the CURRENTLY-SELECTED element
 * (drag initiates only on the selection → no accidental drags; a press that
 * doesn't pass the threshold falls through to the inspector's click-select).
 * While dragging, an insertion indicator previews where the element will land;
 * on drop we resolve the destination container + index and emit
 * `DRAG_MOVE_COMMITTED`. The shell turns that into the same `move`
 * StructuralEdit the Layers-panel drag produces (apply-move-edit) — no new
 * applicator. Escape cancels.
 *
 * The pure index math lives in ./drop-target (unit-tested); the press →
 * threshold → drag → commit/cancel state machine (pointer capture, pointerId
 * gating, Escape, trailing-click swallow) lives in ./pointer-drag-gesture,
 * shared with the resize overlay. This file owns the DOM (elementsFromPoint
 * walk, child rects, indicator) and the drop semantics. Feel/threshold tuning is
 * validated by dogfood; the round-trip (drag → DRAG_MOVE_COMMITTED with a sane
 * payload) is covered by bridge-smoke.
 */

import { sendToShell, attributeElement, inspectElement } from "./bridge-runtime"
import type { SelectModeOverlay } from "./bridge-types"
import { PointerDragGesture } from "./pointer-drag-gesture"
import {
  renderDropIndicator,
  resolveDropTarget,
  type DropResolution,
} from "./drop-resolver"

const DRAG_THRESHOLD_PX = 5

const DRAG_MOVE_STYLES = `
  :host { all: initial; }
  .indicator {
    position: fixed;
    background: #2563eb;
    box-shadow: 0 0 0 1px rgba(37,99,235,0.4);
    border-radius: 1px;
    pointer-events: none;
    z-index: 2147483646;
    display: none;
  }
`

export class DragMoveOverlayManager implements SelectModeOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private indicatorEl: HTMLElement
  private active = false
  private getSelected: () => Element | null

  private gesture: PointerDragGesture<{ el: Element }>
  private drop: DropResolution | null = null
  private prevBodyCursor: string | null = null

  constructor(getSelected: () => Element | null) {
    this.getSelected = getSelected
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "drag-move-overlay")
    this.shadow = this.root.attachShadow({ mode: "closed" })
    const style = document.createElement("style")
    style.textContent = DRAG_MOVE_STYLES
    this.shadow.appendChild(style)
    this.indicatorEl = document.createElement("div")
    this.indicatorEl.className = "indicator"
    this.shadow.appendChild(this.indicatorEl)
    document.body.appendChild(this.root)
    this.gesture = new PointerDragGesture<{ el: Element }>({
      threshold: DRAG_THRESHOLD_PX,
      onArm: (e) => this.arm(e),
      onDragStart: () => {
        this.prevBodyCursor = document.body.style.cursor
        document.body.style.cursor = "grabbing"
      },
      onDragMove: (data, e) => {
        this.drop = resolveDropTarget(document, e.clientX, e.clientY, data.el)
        renderDropIndicator(this.indicatorEl, this.drop)
      },
      onCommit: (data) => {
        if (this.drop) this.commit(data.el, this.drop)
      },
      onReset: () => {
        this.drop = null
        this.indicatorEl.style.display = "none"
        if (this.prevBodyCursor !== null) {
          document.body.style.cursor = this.prevBodyCursor
          this.prevBodyCursor = null
        }
      },
      // A cancelled OS gesture can still emit a trailing click; swallow it so
      // the aborted drag doesn't re-toggle the selection.
      swallowClickOnPointerCancel: true,
    })
  }

  activate(): void {
    if (this.active) return
    this.active = true
    this.gesture.attach()
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.gesture.detach()
  }

  handleNavigation(): void {
    this.gesture.reset()
  }

  isActive(): boolean {
    return this.active
  }

  /** Debug/test entry — resolve the drop at (x,y) for `dragged` without UI. */
  probeDrop(dragged: Element, x: number, y: number): DropResolution | null {
    return resolveDropTarget(document, x, y, dragged)
  }

  /** Arm decision for the shared gesture: press on the selected element. */
  private arm(e: PointerEvent): { data: { el: Element }; captureEl: Element | null } | null {
    const sel = this.getSelected()
    if (!sel) return null
    const target = e.target as Element | null
    if (!target) return null
    // Don't arm while text-editing: an active contentEditable means the user is
    // dragging to select text / position the caret, not to move the element
    // (codex — drag-move must not pre-empt inline text editing).
    if (target.closest?.("[contenteditable]")) return null
    // Arm only when pressing on the selected element (or a descendant of it).
    if (sel !== target && !sel.contains(target)) return null
    // Must be movable — i.e. attributable to a source location.
    if (!attributeElement(sel)?.editTarget) return null
    // Capture on the event target (released by the gesture's reset()).
    return { data: { el: sel }, captureEl: target }
  }

  private commit(dragged: Element, drop: DropResolution): void {
    const sourceAttr = attributeElement(dragged)
    const destAttr = attributeElement(drop.container)
    if (!sourceAttr?.editTarget || !destAttr?.editTarget) return
    // Attribution carries the editTarget; the stable selector (bookkeeping +
    // no-op/verification on the shell side) comes from inspectElement.
    const sourceSelector =
      (inspectElement(dragged) as { selector?: string }).selector ?? ""
    const destParentSelector =
      (inspectElement(drop.container) as { selector?: string }).selector ?? ""
    sendToShell({
      type: "DRAG_MOVE_COMMITTED",
      payload: {
        sourceSelector,
        sourceEditTarget: sourceAttr.editTarget,
        destParentSelector,
        destParentEditTarget: destAttr.editTarget,
        destIndex: drop.index,
        // Flag v-for/map-rendered source OR destination so the shell refuses
        // rather than silently rewriting the shared loop template for every row
        // (codex). Iterated moves go through the Layers panel's iteration-scope
        // intercept.
        sourceIsIterated: !!sourceAttr.iteration,
        destIsIterated: !!destAttr.iteration,
      },
    })
  }
}
