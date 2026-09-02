/**
 * Desde Bridge — PointerDragGesture
 *
 * The press → threshold → drag → commit/cancel state machine shared by
 * `drag-move-overlay.ts` (drag to reorder) and `resize-overlay.ts` (drag the
 * width handle). Both had a byte-for-byte-equivalent copy of the same hardening:
 *
 *   - capture-phase pointerdown/move/up/cancel + keydown listeners on `document`
 *   - `setPointerCapture` on arm so a release OUTSIDE the iframe still lands,
 *     released in `reset()`
 *   - pointerId gating (a second finger/pen can't hijack an in-flight drag)
 *   - a movement threshold before the gesture counts as a drag (so a plain
 *     click still falls through to the inspector's select)
 *   - Escape cancels
 *   - a WINDOW-capture click swallower: a real drag fires a trailing `click`
 *     after `pointerup`, and the inspector selects on `click`
 *     (stopImmediatePropagation on a document-level listener), so the swallower
 *     must run on window capture to precede it
 *
 * Only the arm decision, the per-move work, and commit/cancel differ — those
 * are the callbacks. This is a pure state machine over DOM events: no shadow
 * DOM, no bridge-runtime dependency, unit-testable in jsdom.
 *
 * Pattern-mate: `drop-resolver.ts` / `drop-target.ts` (DOM shell + pure core).
 */

/** Reason a gesture ended without committing. */
export type PointerDragCancelReason = "escape" | "pointercancel"

export interface PointerDragOptions<T> {
  /** Movement (px) required before the press becomes a drag. */
  threshold: number
  /**
   * Distance metric against the arm point. Defaults to Euclidean; the resize
   * handle is width-only so it passes `(dx) => Math.abs(dx)`.
   */
  distance?: (dx: number, dy: number) => number
  /**
   * Decide whether this pointerdown arms a gesture. Return the per-gesture
   * payload (+ the element to pointer-capture on), or null to ignore the press.
   * Any preventDefault/stopPropagation the caller wants on the DOWN event
   * belongs here.
   */
  onArm: (e: PointerEvent) => { data: T; captureEl: Element | null } | null
  /** First move past the threshold (cursor styling, etc.). */
  onDragStart?: (data: T, e: PointerEvent) => void
  /** Every move once dragging (the caller owns preview rendering). */
  onDragMove: (data: T, e: PointerEvent) => void
  /** Pointerup after a real drag. */
  onCommit: (data: T, e: PointerEvent) => void
  /** Escape or pointercancel during a real drag (undo any live preview). */
  onCancel?: (data: T, reason: PointerDragCancelReason) => void
  /** Teardown that must run on every reset, dragging or not. */
  onReset?: () => void
  /**
   * Swallow the trailing click when a drag is aborted by `pointercancel`.
   * drag-move does (defensive: a cancelled OS gesture must not re-toggle the
   * selection); resize does not. Preserved per-surface rather than unified.
   */
  swallowClickOnPointerCancel?: boolean
}

export class PointerDragGesture<T> {
  private opts: PointerDragOptions<T>
  private armed: { data: T; startX: number; startY: number; pointerId: number } | null = null
  private captureEl: Element | null = null
  private draggingFlag = false
  private attached = false
  /**
   * A real drag fires a trailing `click` after `pointerup`. The inspector
   * selects/deselects on `click` (a SEPARATE event from our pointer stream, so
   * stopPropagation on pointerup can't suppress it). Swallow exactly one click
   * after a drag so the drop doesn't also toggle the selection.
   */
  private swallowNextClick = false

  private boundDown: (e: PointerEvent) => void
  private boundMove: (e: PointerEvent) => void
  private boundUp: (e: PointerEvent) => void
  private boundCancel: (e: PointerEvent) => void
  private boundKey: (e: KeyboardEvent) => void
  private boundClick: (e: MouseEvent) => void

  constructor(opts: PointerDragOptions<T>) {
    this.opts = opts
    this.boundDown = this.handlePointerDown.bind(this)
    this.boundMove = this.handlePointerMove.bind(this)
    this.boundUp = this.handlePointerUp.bind(this)
    this.boundCancel = this.handlePointerCancel.bind(this)
    this.boundKey = this.handleKeydown.bind(this)
    this.boundClick = this.handleClick.bind(this)
  }

  /** True once the press has passed the threshold. */
  get dragging(): boolean {
    return this.draggingFlag
  }

  /** The armed payload, or null when idle. */
  get data(): T | null {
    return this.armed?.data ?? null
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    document.addEventListener("pointerdown", this.boundDown, true)
    document.addEventListener("pointermove", this.boundMove, true)
    document.addEventListener("pointerup", this.boundUp, true)
    document.addEventListener("pointercancel", this.boundCancel, true)
    document.addEventListener("keydown", this.boundKey, true)
    // On WINDOW (not document) capture so this fires BEFORE the inspector's
    // document-level capture click handler — the inspector calls
    // stopImmediatePropagation, so a document-level swallower registered after
    // it would never run (codex). Window capture precedes document capture.
    window.addEventListener("click", this.boundClick, true)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener("pointerdown", this.boundDown, true)
    document.removeEventListener("pointermove", this.boundMove, true)
    document.removeEventListener("pointerup", this.boundUp, true)
    document.removeEventListener("pointercancel", this.boundCancel, true)
    document.removeEventListener("keydown", this.boundKey, true)
    window.removeEventListener("click", this.boundClick, true)
    this.swallowNextClick = false
    this.reset()
  }

  /** Drop any in-flight gesture (navigation, teardown). Runs `onReset`. */
  reset(): void {
    if (this.captureEl && this.armed) {
      try {
        this.captureEl.releasePointerCapture?.(this.armed.pointerId)
      } catch {
        // Already released / capture lost — ignore.
      }
    }
    this.captureEl = null
    this.armed = null
    this.draggingFlag = false
    this.opts.onReset?.()
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    const arm = this.opts.onArm(e)
    if (!arm) return
    this.armed = { data: arm.data, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId }
    // Capture the pointer so pointermove/up keep arriving even if the cursor
    // leaves the iframe — without this a release outside the document never
    // fires our pointerup, leaving the drag UI/state stuck (codex). Released
    // in reset().
    try {
      arm.captureEl?.setPointerCapture?.(e.pointerId)
      this.captureEl = arm.captureEl
    } catch {
      this.captureEl = null
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.armed) return
    // Ignore other pointers (a second finger/pen) during a drag (codex).
    if (e.pointerId !== this.armed.pointerId) return
    if (!this.draggingFlag) {
      const dx = e.clientX - this.armed.startX
      const dy = e.clientY - this.armed.startY
      const dist = this.opts.distance ? this.opts.distance(dx, dy) : Math.hypot(dx, dy)
      if (dist < this.opts.threshold) return
      this.draggingFlag = true
      this.opts.onDragStart?.(this.armed.data, e)
    }
    // Own the gesture while dragging so the inspector doesn't also act.
    e.preventDefault()
    e.stopPropagation()
    this.opts.onDragMove(this.armed.data, e)
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.armed) return
    if (e.pointerId !== this.armed.pointerId) return
    const wasDragging = this.draggingFlag
    const data = this.armed.data
    if (wasDragging) {
      e.preventDefault()
      e.stopPropagation()
      // The browser fires a trailing `click` after this pointerup; swallow it
      // so the drop doesn't also toggle selection.
      this.swallowNextClick = true
      this.opts.onCommit(data, e)
    }
    this.reset()
  }

  private handlePointerCancel(e: PointerEvent): void {
    if (this.armed && e.pointerId !== this.armed.pointerId) return
    // Pointer cancelled (OS gesture, capture lost, etc.) — drop the gesture.
    if (this.draggingFlag) {
      if (this.opts.swallowClickOnPointerCancel) this.swallowNextClick = true
      if (this.armed) this.opts.onCancel?.(this.armed.data, "pointercancel")
    }
    this.reset()
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && this.draggingFlag) {
      e.preventDefault()
      e.stopPropagation()
      // The release after Escape can still fire a trailing click — swallow it
      // so cancelling a drag doesn't also toggle the selection (codex).
      this.swallowNextClick = true
      if (this.armed) this.opts.onCancel?.(this.armed.data, "escape")
      this.reset()
    }
  }

  private handleClick(e: MouseEvent): void {
    if (!this.swallowNextClick) return
    this.swallowNextClick = false
    e.preventDefault()
    e.stopPropagation()
  }
}
