/**
 * Desde Bridge — AnchorPinsManager (shared pin-layer machinery)
 *
 * `comment-pins.ts` and `note-pins.ts` were near line-for-line duplicates: the
 * same Shadow-DOM host + pin layer, the same PlacementOverlay wiring (click an
 * element → generate a selector → emit a NEW_*_POSITION; Escape → EXIT_*_MODE),
 * and the same rAF-debounced reposition loop (scroll + resize + MutationObserver).
 * That machinery lives here once; the subclasses keep everything that genuinely
 * differs — their CSS, their pin markup, their payload shapes, and their
 * anchor/offset math.
 *
 * Behaviour-preserving extraction: every per-surface difference is expressed as
 * an `AnchorPinsOptions` field or an overridden method, never as a branch here.
 */
import { sendToShell } from "./bridge-runtime"
import { generateSelector } from "./selector-engine"
import { PlacementOverlay } from "./placement-overlay"

/** The JSON-safe rect shape both surfaces post to the shell. */
export interface PinRect {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

export function rectJson(r: DOMRect): PinRect {
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    left: r.left,
  }
}

/** Page key pins are scoped by — pathname + hash, matching stored positions. */
export function currentPageKey(): string {
  return window.location.pathname + window.location.hash
}

export interface AnchorPinsOptions {
  /** `data-prototype-flow` value on the host element (selector-capture excludes it). */
  hostName: string
  /** Shadow-DOM stylesheet for this pin surface. */
  styles: string
  /** Class name on the absolutely-positioned pin layer. */
  layerClass: string
  /** Message emitted when placement resolves to an element. */
  newPositionType: string
  /** Message emitted when placement is cancelled (Escape / overlay cancel). */
  exitModeType: string
  /**
   * Horizontal offset applied to the anchor's right edge when reporting a new
   * placement. Comments tuck the pin INSIDE the anchor (-4); notes sit just
   * OUTSIDE it (+4).
   */
  placementOffsetX: number
}

export abstract class AnchorPinsManager {
  protected root: HTMLElement
  protected shadow: ShadowRoot
  protected layer: HTMLElement
  protected placementOverlay: PlacementOverlay
  protected showResolved = false
  protected hidden = false
  private rafId = 0

  constructor(options: AnchorPinsOptions) {
    this.root = document.createElement("div")
    this.root.setAttribute("data-prototype-flow", options.hostName)
    this.shadow = this.root.attachShadow({ mode: "closed" })

    const style = document.createElement("style")
    style.textContent = options.styles
    this.shadow.appendChild(style)

    this.layer = document.createElement("div")
    this.layer.className = options.layerClass
    this.shadow.appendChild(this.layer)

    document.body.appendChild(this.root)

    this.placementOverlay = new PlacementOverlay()
    this.placementOverlay.onElementSelected = (el) => {
      const selector = generateSelector(el)
      if (!selector) return
      const r = el.getBoundingClientRect()
      const anchorX = r.right + window.scrollX + options.placementOffsetX
      const anchorY = r.top + window.scrollY - 4
      this.exitPlacementMode()
      // NOTE: tab-panel ids are deliberately NOT sent here — both surfaces
      // computed them into a local `position` object and then posted only
      // these five fields. Payload shape preserved verbatim.
      sendToShell({
        type: options.newPositionType,
        payload: {
          anchorSelector: selector,
          page: currentPageKey(),
          anchorX,
          anchorY,
          elementRect: rectJson(r),
        },
      })
    }
    this.placementOverlay.onCancel = () => {
      this.exitPlacementMode()
      sendToShell({ type: options.exitModeType })
    }

    const scheduleUpdate = () => {
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(() => {
          this.updatePositions()
          this.rafId = 0
        })
      }
    }
    document.addEventListener("scroll", scheduleUpdate, true)
    window.addEventListener("resize", scheduleUpdate)

    new MutationObserver(scheduleUpdate).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"],
    })
  }

  setHidden(h: boolean): void {
    this.hidden = h
    this.layer.style.display = h ? "none" : ""
  }

  setShowResolved(show: boolean): void {
    this.showResolved = show
    this.render()
  }

  handleNavigation(): void {
    this.render()
  }

  enterPlacementMode(): void {
    this.placementOverlay.activate()
  }

  exitPlacementMode(): void {
    this.placementOverlay.deactivate()
  }

  /** Keep the absolutely-positioned layer as tall as the document. */
  protected syncLayerHeight(): void {
    this.layer.style.height = `${document.documentElement.scrollHeight}px`
  }

  /** Rebuild every pin element from scratch. */
  protected abstract render(): void

  /** Reposition existing pins against their (possibly moved) anchors. */
  protected abstract updatePositions(): void
}
