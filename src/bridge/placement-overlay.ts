/**
 * Desde Bridge — Placement Overlay
 *
 * Extracted verbatim from `comment-bridge.ts`. A self-contained crosshair
 * overlay (own shadow DOM) used by the comment- and note-pin managers to let
 * the user click an element; it reports the chosen element via the
 * `onElementSelected` callback. No closure state — browser globals plus the
 * shared `isBridgeOwnElement` guard. esbuild inlines it back into the IIFE at
 * bundle time.
 */

import { isBridgeOwnElement } from "./selector-helpers"

const PLACEMENT_STYLES = `
  :host { all: initial; }

  .pt-placement-highlight {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    border: 3px solid #F0B4D8;
    background: rgba(255, 218, 240, 0.08);
    border-radius: 4px;
    transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
  }

  .pt-placement-label {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    background: #F0B4D8;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    font-weight: 400;
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }
`

export class PlacementOverlay {
  private root: HTMLElement
  private shadow: ShadowRoot
  private active = false
  private hoveredElement: Element | null = null
  private elements: HTMLElement[] = []

  onElementSelected: ((el: Element) => void) | null = null
  onCancel: (() => void) | null = null

  private boundMouseMove: (e: MouseEvent) => void
  private boundClick: (e: MouseEvent) => void
  private boundKeydown: (e: KeyboardEvent) => void

  constructor() {
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "comment-placement")
    this.shadow = this.root.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = PLACEMENT_STYLES
    this.shadow.appendChild(style)

    document.body.appendChild(this.root)

    this.boundMouseMove = this.handleMouseMove.bind(this)
    this.boundClick = this.handleClick.bind(this)
    this.boundKeydown = this.handleKeydown.bind(this)
  }

  activate(): void {
    if (this.active) return
    this.active = true
    document.addEventListener("mousemove", this.boundMouseMove, true)
    document.addEventListener("click", this.boundClick, true)
    document.addEventListener("keydown", this.boundKeydown, true)
    // Comment bubble cursor matching pin color (#ff00ff magenta)
    const commentSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="%23ff00ff" stroke="%23fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="13" y2="12"/></svg>`
    document.body.style.cursor = `url("data:image/svg+xml,${commentSvg}") 2 20, crosshair`
  }

  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.hoveredElement = null
    document.removeEventListener("mousemove", this.boundMouseMove, true)
    document.removeEventListener("click", this.boundClick, true)
    document.removeEventListener("keydown", this.boundKeydown, true)
    document.body.style.cursor = ""
    this.clearOverlay()
  }

  destroy(): void {
    this.deactivate()
    this.root.remove()
  }

  private handleMouseMove(e: MouseEvent): void {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || el === this.hoveredElement) return
    if (this.isOwnElement(el)) return
    this.hoveredElement = el
    this.showOverlay(el)
  }

  private handleClick(e: MouseEvent): void {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || this.isOwnElement(el)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    this.deactivate()
    this.onElementSelected?.(el)
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      this.deactivate()
      this.onCancel?.()
    }
  }

  private isOwnElement(el: Element): boolean {
    return isBridgeOwnElement(el)
  }

  private clearOverlay(): void {
    for (const el of this.elements) el.remove()
    this.elements = []
  }

  private showOverlay(el: Element): void {
    this.clearOverlay()
    const rect = el.getBoundingClientRect()

    const highlight = document.createElement("div")
    highlight.className = "pt-placement-highlight"
    highlight.style.top = `${rect.top}px`
    highlight.style.left = `${rect.left}px`
    highlight.style.width = `${rect.width}px`
    highlight.style.height = `${rect.height}px`
    this.shadow.appendChild(highlight)
    this.elements.push(highlight)

    const label = document.createElement("div")
    label.className = "pt-placement-label"
    label.textContent = "Click to add comment"
    const labelTop = rect.top - 24
    label.style.top = `${labelTop < 0 ? rect.bottom + 4 : labelTop}px`
    label.style.left = `${rect.left}px`
    this.shadow.appendChild(label)
    this.elements.push(label)
  }
}
