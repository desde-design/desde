/**
 * ResizeOverlay — direct-manipulation drag-to-resize (Phase 4 of
 * tasks/editor-direct-manipulation.md). Draws a right-edge WIDTH handle on
 * the currently-selected element; dragging it live-previews an inline width and,
 * on release, quantizes the pixel width to an idiomatic Tailwind class
 * (resize-quantize.ts) and emits RESIZE_COMMITTED. The shell applies it through
 * the existing class-edit path (no new applicator). Constrained-layout: width
 * via the substrate's class vocabulary, not raw px.
 *
 * v1 = width only (the highest-value axis, mirrors Phase 1's width presets).
 * Reuses Phase 2's gesture hardening — pointer-capture (so a release outside the
 * iframe still fires), pointerId gating (multi-touch), Escape-cancel, and a
 * window-capture click swallow so the post-drag click can't reselect — now
 * literally shared: the state machine lives in ./pointer-drag-gesture, the same
 * helper drag-move-overlay drives. What stays here is the handle DOM, the rAF
 * pin-to-right-edge loop, the live inline-width preview, and the commit.
 */

import { attributeElement, inspectElement, sendToShell } from "./bridge-runtime"
import type { SelectModeOverlay } from "./bridge-types"
import { PointerDragGesture } from "./pointer-drag-gesture"
import { quantizeWidthClass } from "./resize-quantize"

const RESIZE_STYLES = `
  :host { all: initial; }
  .handle {
    position: fixed;
    width: 8px;
    height: 28px;
    margin-top: -14px;
    margin-left: -4px;
    background: #2563eb;
    border: 1px solid #fff;
    border-radius: 3px;
    cursor: ew-resize;
    pointer-events: auto;
    z-index: 2147483646;
    display: none;
  }
`

/** Px of horizontal travel before a press on the handle counts as a resize. */
const RESIZE_THRESHOLD_PX = 3

/** Per-gesture state carried by the shared PointerDragGesture. */
interface ResizeDrag {
  el: HTMLElement
  startWidth: number
  startX: number
  /** The element's inline `style.width` BEFORE the drag — restored on cancel
   *  so a cancelled gesture leaves no live mutation. */
  origInlineWidth: string
}

export class ResizeOverlayManager implements SelectModeOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private handleEl: HTMLElement
  private getSelected: () => Element | null
  private active = false
  private rafToken = 0

  private gesture: PointerDragGesture<ResizeDrag>

  constructor(getSelected: () => Element | null) {
    this.getSelected = getSelected
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "resize-overlay")
    this.shadow = this.root.attachShadow({ mode: "closed" })
    const style = document.createElement("style")
    style.textContent = RESIZE_STYLES
    this.shadow.appendChild(style)
    this.handleEl = document.createElement("div")
    this.handleEl.className = "handle"
    this.shadow.appendChild(this.handleEl)
    document.body.appendChild(this.root)
    this.gesture = new PointerDragGesture<ResizeDrag>({
      threshold: RESIZE_THRESHOLD_PX,
      // Width-only axis: horizontal travel alone arms the drag.
      distance: (dx) => Math.abs(dx),
      onArm: (e) => this.arm(e),
      onDragMove: (drag, e) => {
        // Remember the in-flight drag so teardown can undo its preview.
        // `reset()` nulls the gesture's own `armed` before invoking
        // `onReset`, so the callback cannot recover it from there.
        this.inFlight = drag
        this.previewWidth(drag, e)
      },
      onCommit: (drag) => this.commit(drag),
      onCancel: (drag) => {
        this.inFlight = null
        this.clearPreview(drag)
      },
      /**
       * Runs on EVERY gesture reset, including `detach()` — which `onCancel`
       * does not.
       *
       * Without it, deactivating mid-drag (switching tools, a navigation)
       * left the speculative inline width on the prototype: a visible size
       * change that was never committed, that no source file explains, and
       * that nothing later removes. `clearPreview` restores the element's
       * ORIGINAL inline width, so running it twice is harmless.
       */
      onReset: () => {
        if (!this.inFlight) return
        const drag = this.inFlight
        this.inFlight = null
        this.clearPreview(drag)
      },
    })
  }

  activate(): void {
    if (this.active) return
    this.active = true
    this.gesture.attach()
    this.tick()
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.gesture.detach()
    if (this.rafToken) cancelAnimationFrame(this.rafToken)
    this.rafToken = 0
    this.handleEl.style.display = "none"
  }

  handleNavigation(): void {
    this.gesture.reset()
    this.handleEl.style.display = "none"
  }

  isActive(): boolean {
    return this.active
  }

  /**
   * rAF loop: keep the handle pinned to the selected element's right edge
   * (handles selection changes, scroll, and layout shifts uniformly). Pauses
   * positioning during an active drag (the drag updates the handle itself).
   */
  private tick(): void {
    if (!this.active) return
    if (!this.gesture.dragging) {
      const el = this.getSelected()
      if (el && el instanceof HTMLElement && attributeElement(el)?.editTarget) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          this.handleEl.style.display = "block"
          this.handleEl.style.left = `${r.right}px`
          this.handleEl.style.top = `${r.top + r.height / 2}px`
        } else {
          this.handleEl.style.display = "none"
        }
      } else {
        this.handleEl.style.display = "none"
      }
    }
    this.rafToken = requestAnimationFrame(() => this.tick())
  }

  /** Arm decision for the shared gesture: press on the width handle. */
  private arm(e: PointerEvent): { data: ResizeDrag; captureEl: Element | null } | null {
    // A closed-shadow pointerdown on the handle retargets to the host root;
    // the host is pointer-events:none except the handle, so this means "pressed
    // the handle".
    if (e.target !== this.root) return null
    const el = this.getSelected()
    if (!(el instanceof HTMLElement)) return null
    if (!attributeElement(el)?.editTarget) return null
    e.preventDefault()
    e.stopPropagation()
    return {
      data: {
        el,
        startWidth: el.getBoundingClientRect().width,
        startX: e.clientX,
        origInlineWidth: el.style.width,
      },
      captureEl: this.handleEl,
    }
  }

  /** The drag whose preview is currently painted, if any. */
  private inFlight: ResizeDrag | null = null

  private previewWidth(drag: ResizeDrag, e: PointerEvent): void {
    const next = Math.max(0, drag.startWidth + (e.clientX - drag.startX))
    // Live preview via inline width; the handle follows the new right edge.
    drag.el.style.width = `${Math.round(next)}px`
    const r = drag.el.getBoundingClientRect()
    this.handleEl.style.left = `${r.right}px`
    this.handleEl.style.top = `${r.top + r.height / 2}px`
  }

  private commit(drag: ResizeDrag): void {
    const el = drag.el
    const finalWidth = el.getBoundingClientRect().width
    const parentPx = el.parentElement?.clientWidth ?? 0
    // Drop the inline preview before measuring source-truth: the committed edit
    // re-renders via HMR. (Measure width first, above.)
    this.inFlight = null
    this.clearPreview(drag)
    const attr = attributeElement(el)
    if (!attr?.editTarget) return
    const selector = (inspectElement(el) as { selector?: string }).selector ?? ""
    sendToShell({
      type: "RESIZE_COMMITTED",
      payload: {
        selector,
        editTarget: attr.editTarget,
        widthClass: quantizeWidthClass(finalWidth, parentPx),
      },
    })
  }

  private clearPreview(drag: ResizeDrag): void {
    // Restore the element's ORIGINAL inline width (not blank) so a cancelled
    // drag leaves no live mutation; on commit this restores "" (or the prior
    // authored value) and the new width class takes over after HMR.
    drag.el.style.width = drag.origInlineWidth
  }
}
