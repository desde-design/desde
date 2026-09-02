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

/**
 * The colours one placement surface paints itself in.
 *
 * A parameter rather than a constant because ONE overlay class serves two
 * annotation surfaces with different palettes: comments are teal, notes are
 * pink. Before 2026-09-01 the class hard-coded the note pink and comments
 * inherited it, so arming the comment tool put a pink box and a pink chip
 * over the page while the pin that landed was teal — one interaction showing
 * two palettes. Comment pins moved to teal on 2026-08-20 and this file was
 * missed.
 *
 * Hex and rgba literals, not tokens, for the same reason `comment-pins.ts`
 * uses them: this CSS is injected into the CUSTOMER's document, which carries
 * none of our custom properties.
 */
export interface PlacementAccent {
  /** The hover box's border colour. */
  rule: string
  /** The faint fill inside the hover box. */
  wash: string
  /** The chip's background. */
  label: string
  /** The chip's text colour. */
  labelInk: string
  /**
   * Fill for the cursor SVG, URL-ENCODED (`%23` for `#`). It is spliced into
   * a `data:image/svg+xml,` URI, where a bare `#` would start a fragment and
   * silently truncate the image.
   */
  cursorFill: string
}

/**
 * Comments: the brand teal, matching the Inspector overlay exactly.
 *
 * `#00918A` is `oklch(0.575 0.135 190)` — the shell's own `--primary`, which
 * `inspector-overlay.ts` also hard-codes — converted to sRGB. `#F7FDFD` is
 * `oklch(0.99 0.006 190)`, its `--primary-foreground`. Written as hex because
 * `cursorFill` has to survive URL encoding inside a data URI, and having the
 * chip and the cursor named in two different colour syntaxes is how they
 * drift apart.
 *
 * MEASURED: the chip is 3.88:1, which clears AA for large text and not for
 * normal. It ships anyway on two grounds. It is a 2.3x improvement on what it
 * replaces (white on `#F0B4D8` measured 1.72:1, which was failing badly and
 * silently). And Mo asked for this to MATCH the Inspector, which already
 * ships this exact pair; giving the chip its own darker teal would fix a
 * number by breaking the thing that was asked for.
 */
export const COMMENT_PLACEMENT_ACCENT: PlacementAccent = {
  rule: "#00918A",
  wash: "rgba(0, 145, 138, 0.08)",
  label: "#00918A",
  labelInk: "#F7FDFD",
  cursorFill: "%2300918A",
}

/**
 * Notes: the pink this file used to hard-code for everyone.
 *
 * Unchanged on purpose. Notes are deliberately the pink surface (see
 * `note-pins.ts`), and Mo's 2026-09-01 request was about the COMMENT tool.
 * Recolouring both would have been the one-line change and the wrong one.
 */
export const NOTE_PLACEMENT_ACCENT: PlacementAccent = {
  rule: "#F0B4D8",
  wash: "rgba(255, 218, 240, 0.08)",
  label: "#F0B4D8",
  labelInk: "#fff",
  cursorFill: "%23ff00ff",
}

const placementStyles = (accent: PlacementAccent): string => `
  :host { all: initial; }

  .pt-placement-highlight {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    border: 3px solid ${accent.rule};
    background: ${accent.wash};
    border-radius: 4px;
    transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
  }

  .pt-placement-label {
    position: fixed;
    pointer-events: none;
    z-index: 2147483645;
    background: ${accent.label};
    color: ${accent.labelInk};
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
  private readonly accent: PlacementAccent

  constructor(accent: PlacementAccent) {
    this.accent = accent
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", "comment-placement")
    this.shadow = this.root.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = placementStyles(accent)
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
    // Comment bubble cursor, filled with THIS surface's accent. It used to be
    // a hard-coded `%23ff00ff` magenta whose comment claimed it matched the
    // pin colour; that stopped being true on 2026-08-20 when comment pins
    // went teal, and nothing caught it because a cursor is not in any
    // snapshot.
    const commentSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${this.accent.cursorFill}" stroke="%23fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="13" y2="12"/></svg>`
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
