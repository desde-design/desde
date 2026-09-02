/**
 * Desde Bridge — Note Pins
 *
 * Renders note pin markers (own shadow DOM), drives placement via
 * PlacementOverlay, and emits NOTE_PIN_CLICKED / NEW_NOTE_POSITION /
 * NOTE_ANCHOR_POSITIONS through the injected `sendToShell`.
 *
 * The host/placement/reposition machinery it shares with `comment-pins.ts`
 * lives in `AnchorPinsManager` (./anchor-pins); what stays here is
 * note-specific: NOTE_STYLES, the numbered pin markup, the expand-direction
 * math (pins flip to right/bottom anchoring near the viewport edges), the
 * minimized-only pin filter, and NOTE_ANCHOR_POSITIONS for expanded notes.
 */
import { sendToShell } from "./bridge-runtime"
import { isElementVisible, areTabPanelsActive } from "./selector-engine"
import { AnchorPinsManager, currentPageKey, rectJson, type PinRect } from "./anchor-pins"
import type { BridgeNote } from "./bridge-types"

const NOTE_STYLES = `
  :host { all: initial; }

  .pt-notes-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2147483639;
  }

  /* Note pin (minimized) */
  .pt-note-pin {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 32px;
    min-height: 32px;
    padding: 6px 8px;
    background: #FFDAF0;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 4px 4px 0 4px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 11px;
    font-weight: 700;
    color: #333;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
    transition: box-shadow 0.15s;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
  }

  /* Pointer corner flips based on expand direction */
  .pt-note-pin--expand-left {
    border-radius: 4px 4px 4px 0;
  }
  .pt-note-pin--expand-up {
    border-radius: 0 4px 4px 4px;
  }
  .pt-note-pin--expand-left.pt-note-pin--expand-up {
    border-radius: 4px 0 4px 4px;
  }

  .pt-note-pin:hover {
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  }

  .pt-note-pin--active {
    box-shadow: 0 0 0 2px rgba(240, 180, 216, 0.5), 0 4px 14px rgba(0, 0, 0, 0.22);
  }

  .pt-note-pin--resolved {
    opacity: 0.55;
  }

  .pt-note--detached {
    display: none;
  }

  .pt-note-pin-number {
    /* number label inherits pin font styles */
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }
`

export class NotePinsManager extends AnchorPinsManager {
  private notes: BridgeNote[] = []
  private noteElements = new Map<string, HTMLElement>()
  private activeNoteId: string | null = null

  constructor() {
    super({
      hostName: "note-pins",
      styles: NOTE_STYLES,
      layerClass: "pt-notes-layer",
      newPositionType: "NEW_NOTE_POSITION",
      exitModeType: "EXIT_NOTE_MODE",
      placementOffsetX: 4,
    })
  }

  setNotes(notes: BridgeNote[]): void {
    this.notes = notes
    this.render()
  }

  highlightNote(noteId: string): void {
    this.activeNoteId = noteId
    const note = this.notes.find((n) => n.id === noteId)

    // Update pin active state (only minimized notes have pins)
    this.noteElements.forEach((el, id) => {
      el.classList.toggle("pt-note-pin--active", id === noteId)
    })

    // Scroll to anchor element
    if (note) {
      const anchorEl = document.querySelector(note.position.anchorSelector)
      if (anchorEl) {
        anchorEl.scrollIntoView({ behavior: "smooth", block: "center" })
        // Re-send positions after scroll settles
        setTimeout(() => this.sendAnchorPositions(), 350)
      }
    }
  }

  protected render(): void {
    this.layer.innerHTML = ""
    this.noteElements.clear()
    this.syncLayerHeight()

    // Only show notes for the current page
    const currentPage = currentPageKey()

    const anchorCounts = new Map<string, number>()

    // Only render pins for minimized notes
    for (const note of this.notes) {
      if (note.resolved && !this.showResolved) continue
      if (note.position.page !== currentPage) continue
      if (!note.minimized) continue

      const selector = note.position.anchorSelector
      const tabActive = areTabPanelsActive(note.position.tabPanelIds)
      const anchorEl = tabActive ? document.querySelector(selector) : null
      const visible = anchorEl && isElementVisible(anchorEl)

      const index = anchorCounts.get(selector) ?? 0
      anchorCounts.set(selector, index + 1)

      const el = document.createElement("div")
      const classes = ["pt-note-pin"]
      if (note.resolved) classes.push("pt-note-pin--resolved")
      if (note.id === this.activeNoteId) classes.push("pt-note-pin--active")

      // Number label
      const numSpan = document.createElement("span")
      numSpan.textContent = String(note.number)
      el.appendChild(numSpan)

      if (visible && anchorEl) {
        const rect = anchorEl.getBoundingClientRect()
        const expandLeft = rect.right > window.innerWidth / 2
        const expandUp = rect.top > window.innerHeight / 2
        if (expandLeft) classes.push("pt-note-pin--expand-left")
        if (expandUp) classes.push("pt-note-pin--expand-up")
        const pinX = rect.right + window.scrollX + 4
        const pinY = rect.top + window.scrollY - 4 + index * 28
        el.className = classes.join(" ")
        this.positionPin(el, pinX, pinY, expandLeft, expandUp)
      } else if (note.position.anchorX != null && note.position.anchorY != null) {
        classes.push("pt-note--detached-fallback")
        const expandLeft = note.position.anchorX > window.innerWidth / 2
        const expandUp = (note.position.anchorY - window.scrollY) > window.innerHeight / 2
        if (expandLeft) classes.push("pt-note-pin--expand-left")
        if (expandUp) classes.push("pt-note-pin--expand-up")
        el.className = classes.join(" ")
        this.positionPin(el, note.position.anchorX, note.position.anchorY, expandLeft, expandUp)
      } else {
        classes.push("pt-note--detached")
        el.className = classes.join(" ")
      }

      el.addEventListener("click", (e) => {
        e.stopPropagation()
        sendToShell({
          type: "NOTE_PIN_CLICKED",
          payload: {
            noteId: note.id,
            pinRect: rectJson(el.getBoundingClientRect()),
          },
        })
      })

      this.layer.appendChild(el)
      this.noteElements.set(note.id, el)
    }

    // Send anchor positions for non-minimized notes to the shell
    this.sendAnchorPositions()
  }

  private sendAnchorPositions(): void {
    const positions: { noteId: string; rect: PinRect }[] = []
    const currentPage = currentPageKey()

    for (const note of this.notes) {
      if (note.resolved && !this.showResolved) continue
      if (note.position.page !== currentPage) continue
      if (note.minimized) continue

      const selector = note.position.anchorSelector
      if (!areTabPanelsActive(note.position.tabPanelIds)) continue

      const anchorEl = document.querySelector(selector)
      if (anchorEl && isElementVisible(anchorEl)) {
        positions.push({
          noteId: note.id,
          rect: rectJson(anchorEl.getBoundingClientRect()),
        })
      } else if (note.position.anchorX != null && note.position.anchorY != null) {
        // Fallback: use stored coordinates (document-relative, convert to viewport-relative)
        const vx = note.position.anchorX - window.scrollX
        const vy = note.position.anchorY - window.scrollY
        positions.push({
          noteId: note.id,
          rect: { x: vx, y: vy, width: 0, height: 0, top: vy, right: vx, bottom: vy, left: vx },
        })
      }
    }

    sendToShell({ type: "NOTE_ANCHOR_POSITIONS", payload: positions })
  }

  protected updatePositions(): void {
    this.syncLayerHeight()

    const anchorCounts = new Map<string, number>()

    // Update minimized pin positions
    const currentPage = currentPageKey()
    for (const note of this.notes) {
      if (note.resolved && !this.showResolved) continue
      if (note.position.page !== currentPage) continue
      if (!note.minimized) continue
      const el = this.noteElements.get(note.id)
      if (!el) continue

      const selector = note.position.anchorSelector

      if (!areTabPanelsActive(note.position.tabPanelIds)) {
        el.classList.add("pt-note--detached")
        continue
      }

      const anchorEl = document.querySelector(selector)
      if (anchorEl && isElementVisible(anchorEl)) {
        const rect = anchorEl.getBoundingClientRect()
        const index = anchorCounts.get(selector) ?? 0
        anchorCounts.set(selector, index + 1)
        const expandLeft = rect.right > window.innerWidth / 2
        const expandUp = rect.top > window.innerHeight / 2
        const pinX = rect.right + window.scrollX + 4
        const pinY = rect.top + window.scrollY - 4 + index * 28
        el.classList.remove("pt-note--detached", "pt-note--detached-fallback")
        el.classList.toggle("pt-note-pin--expand-left", expandLeft)
        el.classList.toggle("pt-note-pin--expand-up", expandUp)
        this.positionPin(el, pinX, pinY, expandLeft, expandUp)
      } else if (note.position.anchorX != null && note.position.anchorY != null) {
        const expandLeft = note.position.anchorX > window.innerWidth / 2
        const expandUp = (note.position.anchorY - window.scrollY) > window.innerHeight / 2
        el.classList.remove("pt-note--detached")
        el.classList.add("pt-note--detached-fallback")
        el.classList.toggle("pt-note-pin--expand-left", expandLeft)
        el.classList.toggle("pt-note-pin--expand-up", expandUp)
        this.positionPin(el, note.position.anchorX, note.position.anchorY, expandLeft, expandUp)
      } else {
        el.classList.add("pt-note--detached")
      }
    }

    // Re-send anchor positions for non-minimized notes
    this.sendAnchorPositions()
  }

  private positionPin(el: HTMLElement, x: number, y: number, expandLeft: boolean, expandUp: boolean): void {
    const scrollW = document.documentElement.scrollWidth
    const scrollH = document.documentElement.scrollHeight
    if (expandLeft) {
      el.style.left = ""
      el.style.right = `${scrollW - x - 28}px`
    } else {
      el.style.right = ""
      el.style.left = `${x}px`
    }
    if (expandUp) {
      el.style.top = ""
      el.style.bottom = `${scrollH - y - 28}px`
    } else {
      el.style.bottom = ""
      el.style.top = `${y}px`
    }
  }
}
