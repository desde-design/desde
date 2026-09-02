/**
 * InsertPlacementOverlay — direct-manipulation insert-at-a-point (Phase 3 of
 * tasks/editor-direct-manipulation.md). The shell enters placement mode
 * (`ENTER_INSERT_PLACEMENT` with a label) when the user picks a palette
 * primitive to "place"; the overlay then previews an insertion indicator that
 * follows the cursor (reusing the SAME drop resolver as drag-to-move) and, on
 * the next click in the iframe, emits `INSERT_AT_POINT` with the resolved
 * destination container + index. The shell turns that into the existing
 * insert edit (apply-insert-edit) — no new applicator.
 *
 * Click-to-place (not cross-iframe HTML5 drag): the palette lives in the shell
 * and the bridge owns the iframe, so a pointer-drag can't be tracked across the
 * boundary. Click-to-place is reliable + smoke-able and reuses the placement
 * pattern. One-shot: a successful placement (or Escape) exits the mode.
 */

import { attributeElement, inspectElement, sendToShell } from "./bridge-runtime"
import type { SelectModeOverlay } from "./bridge-types"
import { renderDropIndicator, resolveDropTarget } from "./drop-resolver"

const INSERT_PLACEMENT_STYLES = `
  :host { all: initial; }
  .indicator {
    position: fixed;
    background: #16a34a;
    box-shadow: 0 0 0 1px rgba(22,163,74,0.4);
    border-radius: 1px;
    pointer-events: none;
    z-index: 2147483646;
    display: none;
  }
  .hint {
    position: fixed;
    left: 8px;
    bottom: 8px;
    padding: 4px 8px;
    font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
    color: #fff;
    background: #16a34a;
    border-radius: 4px;
    pointer-events: none;
    z-index: 2147483647;
    display: none;
  }
`

export class InsertPlacementOverlayManager implements SelectModeOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private indicatorEl: HTMLElement
  private hintEl: HTMLElement
  private placing = false

  private boundMove: (e: PointerEvent) => void
  private boundClick: (e: MouseEvent) => void
  private boundKey: (e: KeyboardEvent) => void

  constructor() {
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "insert-placement-overlay")
    this.shadow = this.root.attachShadow({ mode: "closed" })
    const style = document.createElement("style")
    style.textContent = INSERT_PLACEMENT_STYLES
    this.shadow.appendChild(style)
    this.indicatorEl = document.createElement("div")
    this.indicatorEl.className = "indicator"
    this.hintEl = document.createElement("div")
    this.hintEl.className = "hint"
    this.shadow.appendChild(this.indicatorEl)
    this.shadow.appendChild(this.hintEl)
    document.body.appendChild(this.root)
    this.boundMove = this.handlePointerMove.bind(this)
    this.boundClick = this.handleClick.bind(this)
    this.boundKey = this.handleKeydown.bind(this)
  }

  /** Enter placement mode for a labelled snippet (driven by ENTER_INSERT_PLACEMENT). */
  enter(label: string): void {
    if (this.placing) this.exit()
    this.placing = true
    document.addEventListener("pointermove", this.boundMove, true)
    // Click on WINDOW capture so it fires BEFORE the inspector's document-level
    // capture click handler (which stopImmediatePropagation) — otherwise the
    // placement click would also select instead of placing.
    window.addEventListener("click", this.boundClick, true)
    document.addEventListener("keydown", this.boundKey, true)
    this.hintEl.textContent = `Click to place ${label} · Esc to cancel`
    this.hintEl.style.display = "block"
  }

  exit(): void {
    if (!this.placing) return
    this.placing = false
    document.removeEventListener("pointermove", this.boundMove, true)
    window.removeEventListener("click", this.boundClick, true)
    document.removeEventListener("keydown", this.boundKey, true)
    this.indicatorEl.style.display = "none"
    this.hintEl.style.display = "none"
  }

  isPlacing(): boolean {
    return this.placing
  }

  // SelectModeOverlay: placement is entered explicitly via enter(), so the
  // passive select-mode activate() is a no-op; deactivate()/navigation cancel it.
  activate(): void {}
  deactivate(): void {
    this.exit()
  }
  handleNavigation(): void {
    this.exit()
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.placing) return
    const drop = resolveDropTarget(document, e.clientX, e.clientY, null, { intoChildless: true })
    renderDropIndicator(this.indicatorEl, drop)
  }

  private handleClick(e: MouseEvent): void {
    if (!this.placing) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const drop = resolveDropTarget(document, e.clientX, e.clientY, null, { intoChildless: true })
    if (drop) {
      const attr = attributeElement(drop.container)
      if (attr?.editTarget) {
        const parentSelector =
          (inspectElement(drop.container) as { selector?: string }).selector ?? ""
        sendToShell({
          type: "INSERT_AT_POINT",
          payload: {
            parentSelector,
            parentEditTarget: attr.editTarget,
            destIndex: drop.index,
            // Refuse inserting into a v-for/map row (would add to every row).
            parentIsIterated: !!attr.iteration,
          },
        })
      }
    }
    // One-shot: placement ends after a click (valid or not).
    this.exit()
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (this.placing && e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      this.exit()
    }
  }
}
