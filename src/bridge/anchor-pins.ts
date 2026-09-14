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
import { PlacementOverlay, type PlacementAccent } from "./placement-overlay"

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
  /**
   * Colours for this surface's placement overlay (hover box, chip, cursor).
   *
   * REQUIRED, with no default, deliberately. One overlay class serves both
   * annotation surfaces, and when it hard-coded one palette the other
   * inherited it and nobody noticed for six weeks. A surface that does not
   * state its colours should fail to compile, not pick up somebody else's.
   */
  placementAccent: PlacementAccent

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

/**
 * Where inside `rect` the point (`clientX`, `clientY`) falls, as a fraction of
 * the box on each axis.
 *
 * Returns `null` — meaning "no usable ratio, fall back to corner placement" —
 * for a degenerate rect. A zero-width or zero-height box divides to `Infinity`
 * or `NaN`, and a `NaN` written into `style.left` is dropped silently by the
 * browser, which would leave the pin stacked at the layer's origin with no
 * error anywhere. Elements can genuinely measure zero: a collapsed
 * `<span>`, an image that has not loaded, a control mid-transition.
 *
 * The result is clamped to 0..1. `elementFromPoint` normally guarantees the
 * point is inside the box, but not always: a CSS transform, an `overflow:
 * visible` child painting outside its parent, or an inline element whose
 * union rect spans two lines can all put the click outside the measured rect.
 * Clamping turns those into an edge-of-element pin instead of one floating off
 * in space.
 */
export function clickRatio(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): { offsetRatioX: number; offsetRatioY: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  return {
    offsetRatioX: clamp((clientX - rect.left) / rect.width),
    offsetRatioY: clamp((clientY - rect.top) / rect.height),
  }
}

/** What a surface reports to the shell when placement resolves. */
export interface PlacementResult {
  /** Document-space X the pin is drawn at when the selector stops matching. */
  anchorX: number
  /** Document-space Y the pin is drawn at when the selector stops matching. */
  anchorY: number
  offsetRatioX?: number
  offsetRatioY?: number
  /**
   * Where the pin itself will sit, in the SAME coordinate space as
   * `elementRect` — the iframe's viewport, so a shell's existing iframe-offset
   * maths applies to it unchanged.
   *
   * It exists so the composer opens next to the pin rather than next to the
   * anchored element. Under corner placement the two were the same corner and
   * the distinction did not arise. Under click placement they are not: click
   * the middle of a full-width hero and an element-anchored composer flies to
   * the hero's edge, which is the same jarring jump the pin was moved to
   * avoid.
   *
   * Optional. A surface that places by the element's corner omits it, and the
   * shell then anchors to `elementRect` exactly as before.
   */
  pinRect?: PinRect
}

export abstract class AnchorPinsManager {
  protected root: HTMLElement
  protected shadow: ShadowRoot
  protected layer: HTMLElement
  protected placementOverlay: PlacementOverlay
  protected showResolved = false
  protected hidden = false
  protected readonly options: AnchorPinsOptions
  private rafId = 0

  constructor(options: AnchorPinsOptions) {
    this.options = options
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

    this.placementOverlay = new PlacementOverlay(options.placementAccent)
    this.placementOverlay.onElementSelected = (el, clientX, clientY) => {
      const selector = generateSelector(el)
      if (!selector) return
      const r = el.getBoundingClientRect()
      const placement = this.computePlacement(r, clientX, clientY)
      this.exitPlacementMode()
      // NOTE: tab-panel ids are deliberately NOT sent here — both surfaces
      // computed them into a local `position` object and then posted only
      // these fields.
      sendToShell({
        type: options.newPositionType,
        payload: {
          anchorSelector: selector,
          page: currentPageKey(),
          anchorX: placement.anchorX,
          anchorY: placement.anchorY,
          ...(placement.offsetRatioX != null && placement.offsetRatioY != null
            ? { offsetRatioX: placement.offsetRatioX, offsetRatioY: placement.offsetRatioY }
            : {}),
          ...(placement.pinRect ? { pinRect: placement.pinRect } : {}),
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

  /**
   * Where this surface's pin goes for a click at (`clientX`, `clientY`) on an
   * element measuring `rect`.
   *
   * The DEFAULT is the corner placement every surface used before 2026-09-13:
   * the pin's top-left corner at the element's top-right corner, nudged by
   * `placementOffsetX` horizontally and 4px up. It reports no ratio, so the
   * shell stores none and the renderer keeps drawing from the corner.
   *
   * Comments override it to place by the click instead. Notes deliberately do
   * not: a note pin is an expanding card with its own geometry, and moving it
   * is a separate visual decision from the one Mo asked for.
   */
  protected computePlacement(rect: DOMRect, _clientX: number, _clientY: number): PlacementResult {
    return {
      anchorX: rect.right + window.scrollX + this.options.placementOffsetX,
      anchorY: rect.top + window.scrollY - 4,
    }
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
