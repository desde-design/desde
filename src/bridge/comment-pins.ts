/**
 * Desde Bridge — Comment Pins
 *
 * Renders comment pin markers (own shadow DOM) anchored to selectors, drives
 * placement via PlacementOverlay, and emits COMMENT_PIN_CLICKED /
 * NEW_COMMENT_POSITION through the injected `sendToShell`.
 *
 * The host/placement/reposition machinery it shares with `note-pins.ts` lives
 * in `AnchorPinsManager` (./anchor-pins); what stays here is comment-specific:
 * PINS_STYLES, avatar pin markup, the ±4/20px anchor math, and the
 * COMMENT_ANCHOR_STATUS reporting.
 */
import { sendToShell } from "./bridge-runtime"
import { isElementVisible, areTabPanelsActive } from "./selector-engine"
import { AnchorPinsManager, clickRatio, currentPageKey, rectJson, type PlacementResult } from "./anchor-pins"
import { COMMENT_PLACEMENT_ACCENT } from "./placement-overlay"
import type { Comment } from "./bridge-types"

const PINS_STYLES = `
  :host { all: initial; }

  .pt-pins-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2147483640;
  }

  .pt-pin {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 32px;
    height: 32px;
    padding: 3px;
    background: #C7F2EE;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(148, 224, 218, 0.5), 0 2px 8px rgba(0, 0, 0, 0.15);
    cursor: pointer;
    pointer-events: auto;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    transition: box-shadow 0.15s, transform 0.15s;
    overflow: hidden;
    white-space: nowrap;
  }

  .pt-pin:hover {
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  }

  .pt-pin-avatar {
    width: 24px;
    height: 24px;
    min-width: 24px;
    border-radius: 50%;
    object-fit: cover;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.2;
  }

  /*
   * The no-photo pin. Same 24px circle as the <img> it replaces, so the pin's
   * silhouette does not change with the author.
   *
   * The background is rgb(148,224,218) written as a hex — the exact teal the
   * pin's own box-shadow glow is built from, so the initial reads as part of
   * the pin rather than as something dropped into it. Deep teal text over it
   * is 7.57:1 (MEASURED by compositing both), which clears AA at this weight
   * and size — the pink pair it replaces was 7.86:1, so nothing was traded
   * away for the colour.
   *
   * These were pinks until 2026-08-20 (#FFDAF0 fill, #F0B4D8 glow, #4A2038
   * ink): the NOTE palette, worn by a comment. Hard-coded rather than
   * tokenised because this CSS is injected into the CUSTOMER's document,
   * which carries none of our custom properties. The values are the brand
   * teal's hue (190) at the lightness and chroma the pinks used, so the pin
   * keeps its weight on the page.
   */
  .pt-pin-avatar--initial {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #94E0DA;
    color: #004144;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0;
  }

  .pt-pin--resolved {
    opacity: 0.55;
  }

  .pt-pin--active {
    box-shadow: 0 0 0 4px rgba(148, 224, 218, 0.7), 0 4px 14px rgba(0, 0, 0, 0.22);
    transform: scale(1.15);
  }

  .pt-pin--detached {
    display: none;
  }
`

/**
 * The single character a photo-less author's pin shows.
 *
 * `Array.from` rather than `name[0]`: a display name starting with an emoji or
 * any astral-plane character is two UTF-16 code units, and indexing it yields a
 * lone surrogate that renders as a replacement glyph — the same class of broken
 * mark this fallback exists to remove.
 *
 * A name that is empty or only whitespace yields `"?"`. Every branch returns
 * exactly one printable character; there is no path back to an empty pin.
 *
 * The slice happens AFTER `toUpperCase()`, and the order is the whole point.
 * Unicode case conversion is not length-preserving: `"ß".toUpperCase()` is
 * `"SS"`, `"ﬁ"` is `"FI"`, `"ŉ"` is `"ʼN"`. Uppercasing a one-code-point
 * slice therefore hands back two characters, which overflows the pin's 24px
 * circle — the same "one character" contract broken from the other end.
 * Taking `[0]` of the converted string is what actually holds it.
 */
export function pinInitial(displayName: string): string {
  const first = Array.from((displayName ?? "").trim())[0]
  if (!first) return "?"
  return Array.from(first.toUpperCase())[0] ?? "?"
}

/**
 * The pin's inner mark: the author's avatar, or their initial when there is no
 * avatar to show.
 *
 * MEASURED (2026-08-20, viewer demo project): the viewer sends
 * `photoURL: user.avatarUrl`, which is the EMPTY STRING for the local operator
 * — the account every first-run reviewer uses. `img.src = ""` does not leave
 * the image unset; it resolves against the document and requests the page
 * itself, which is not an image, so every pin on the first-run golden path
 * rendered a broken-image glyph with the `alt` text beside it.
 *
 * So an empty `photoURL` never reaches an `<img>` at all. `onerror` covers the
 * other route to the same glyph — a photoURL that is set but unfetchable (a
 * private avatar host, an offline reviewer) — by swapping the element for the
 * initial instead of leaving the browser's broken mark on screen. `onerror` is
 * cleared first so a fallback that somehow failed could not loop.
 */
export function buildPinAvatar(author: {
  displayName: string
  photoURL: string
}): HTMLElement {
  const initialEl = (): HTMLElement => {
    const el = document.createElement("span")
    el.className = "pt-pin-avatar pt-pin-avatar--initial"
    el.textContent = pinInitial(author.displayName)
    el.setAttribute("aria-label", author.displayName)
    return el
  }

  const photo = (author.photoURL ?? "").trim()
  if (!photo) return initialEl()

  const avatar = document.createElement("img")
  avatar.className = "pt-pin-avatar"
  avatar.src = photo
  avatar.alt = author.displayName
  avatar.onerror = () => {
    avatar.onerror = null
    avatar.replaceWith(initialEl())
  }
  return avatar
}

/** The pin circle's rendered size, matching `.pt-pin`'s width/height above. */
const PIN_SIZE = 32

/**
 * How far the pin's box is shifted from the point it marks.
 *
 * The pin is positioned by its TOP-LEFT corner, so these put its BOTTOM-LEFT
 * corner on the click point, overlapping it by 4px on each axis. The circle
 * therefore sits up and to the right of where the reviewer aimed — the same
 * relationship it has always had to the element's top-right corner, and the
 * same one a Figma pin has to its own anchor.
 *
 * Up-and-right rather than centred on the click, deliberately: a 32px circle
 * centred on the click covers the pixel the reviewer was pointing at, which is
 * usually the thing the comment is about. Centring it is a two-constant change
 * if that turns out to read better.
 */
const PIN_NUDGE_X = -4
const PIN_NUDGE_Y = -(PIN_SIZE - 4)

/**
 * The document-space point a comment's pin is drawn at, given its anchor
 * element's current rect.
 *
 * Two placements live here, and which one applies is decided by the stored
 * position, not by a flag:
 *
 * - A comment with `offsetRatioX`/`offsetRatioY` was placed by CLICK. The
 *   fractions are re-applied to whatever the element measures RIGHT NOW, so
 *   the pin tracks the same proportional spot through a resize or a responsive
 *   reflow rather than being pinned to a pixel offset that stops meaning
 *   anything at another width.
 * - A comment without them was written before 2026-09-13 and gets the corner
 *   placement it was created under. Nothing about an old comment moves.
 *
 * The result is floored at 0 on both axes. A click near the top edge of an
 * element near the top of the page resolves above the document origin, where
 * the pin layer clips it away entirely; the corner placement could only ever
 * be 4px out, but the click placement can be a full pin height out.
 */
export function commentPinPoint(
  position: { offsetRatioX?: number; offsetRatioY?: number },
  rect: DOMRect,
  scrollX: number,
  scrollY: number,
): { x: number; y: number } {
  const { offsetRatioX, offsetRatioY } = position
  if (offsetRatioX == null || offsetRatioY == null) {
    return { x: rect.right + scrollX - 4, y: rect.top + scrollY - 4 }
  }
  return {
    x: Math.max(0, rect.left + rect.width * offsetRatioX + scrollX + PIN_NUDGE_X),
    y: Math.max(0, rect.top + rect.height * offsetRatioY + scrollY + PIN_NUDGE_Y),
  }
}

/**
 * The fan-out offset for pins that land on the SAME point, counted through a
 * caller-owned map.
 *
 * Keyed on the resolved POSITION, where it used to be keyed on the anchor
 * selector. The change is what makes click placement work at all: two comments
 * on the same hero, clicked 300px apart, are already visually distinct, and
 * the selector key would have pushed the second one 20px down for a collision
 * that is not happening.
 *
 * It is NOT purely behaviour-preserving for pre-2026-09-13 comments, and an
 * earlier version of this comment claimed it was (found by codex, 2026-09-13).
 * Two legacy comments on DIFFERENT selectors whose elements share a top-right
 * corner — a wrapper and its first child, which is ordinary — used to fall in
 * separate selector buckets and draw at the identical point, so one sat
 * exactly on top of the other and could not be clicked. They now share a point
 * bucket and fan out. That is the behaviour this mechanism exists to produce,
 * so the change is kept and the claim is corrected rather than the code.
 *
 * PARKED, ruled P3 (codex, 2026-09-13): the key rounds to whole pixels, so
 * points 0.02px apart can land either side of a boundary and fail to stack,
 * while points almost 1px apart can share a key and fan out. Every bucketing
 * scheme has a boundary somewhere, and a sub-pixel gap between two 32px
 * circles is not a collision a reviewer can perceive. The case this has to
 * catch reliably is the EXACT collision — two pins on one corner, or two
 * clicks on one spot — and an exact key catches that exactly.
 */
export function stackOffset(counts: Map<string, number>, x: number, y: number): number {
  const key = `${Math.round(x)}:${Math.round(y)}`
  const index = counts.get(key) ?? 0
  counts.set(key, index + 1)
  return index * 20
}

export class CommentPinsManager extends AnchorPinsManager {
  private comments: Comment[] = []
  private pinElements = new Map<string, HTMLElement>()
  /** Last-emitted anchor-status key, so we only report on change. */
  private lastAnchorStatusKey = ""
  private activeCommentId: string | null = null

  constructor() {
    super({
      hostName: "comment-pins",
      styles: PINS_STYLES,
      layerClass: "pt-pins-layer",
      // Teal, matching the pins this tool drops and the Inspector overlay.
      // Was the note pink until 2026-09-01 (Mo: "it should use the aqua").
      placementAccent: COMMENT_PLACEMENT_ACCENT,
      newPositionType: "NEW_COMMENT_POSITION",
      exitModeType: "EXIT_COMMENT_MODE",
      placementOffsetX: -4,
    })
  }

  /**
   * Comments place by the CLICK, not by the element's corner.
   *
   * `anchorX`/`anchorY` are still reported, and still mean the same thing they
   * always did — the document point to draw the pin at when the selector stops
   * matching — but they now describe the clicked spot rather than the top-right
   * corner. That makes the detached-fallback pin land where the reviewer aimed
   * too, which is strictly better than the corner it used to fall back to.
   *
   * A degenerate rect yields no ratio; the base class's corner placement is
   * then the honest answer, so defer to it rather than inventing a point.
   */
  protected override computePlacement(rect: DOMRect, clientX: number, clientY: number): PlacementResult {
    const ratio = clickRatio(rect, clientX, clientY)
    if (!ratio) return super.computePlacement(rect, clientX, clientY)
    const point = commentPinPoint(ratio, rect, window.scrollX, window.scrollY)
    // `pinRect` is viewport-space, matching `elementRect`; `point` is
    // document-space, matching `anchorX`/`anchorY`. Subtracting the scroll is
    // the whole difference, and mixing the two is the bug this note exists to
    // prevent — it only shows up on a scrolled page, so it survives testing.
    const left = point.x - window.scrollX
    const top = point.y - window.scrollY
    return {
      anchorX: point.x,
      anchorY: point.y,
      ...ratio,
      pinRect: {
        x: left,
        y: top,
        width: PIN_SIZE,
        height: PIN_SIZE,
        left,
        top,
        right: left + PIN_SIZE,
        bottom: top + PIN_SIZE,
      },
    }
  }

  setComments(comments: Comment[]): void {
    this.comments = comments
    this.render()
  }

  highlightComment(commentId: string): void {
    this.activeCommentId = commentId
    const comment = this.comments.find((c) => c.id === commentId)

    this.pinElements.forEach((pin, id) => {
      pin.classList.toggle("pt-pin--active", id === commentId)
    })
    // Scroll to the anchored element
    if (comment) {
      const el = document.querySelector(comment.position.anchorSelector)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    }
    // Send pin rect back to shell so popup positions at the pin
    const pinEl = this.pinElements.get(commentId)
    const anchorEl = comment ? document.querySelector(comment.position.anchorSelector) : null
    const rectSource = pinEl || anchorEl
    if (rectSource) {
      // Small delay to let scroll settle before reading position
      setTimeout(() => {
        sendToShell({
          type: "COMMENT_PIN_CLICKED",
          payload: {
            commentId,
            pinRect: rectJson(rectSource.getBoundingClientRect()),
          },
        })
      }, 350)
    } else {
      // No pin or anchor found — still notify shell so popup opens
      sendToShell({
        type: "COMMENT_PIN_CLICKED",
        payload: {
          commentId,
          pinRect: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
        },
      })
    }
  }

  protected render(): void {
    this.layer.innerHTML = ""
    this.pinElements.clear()
    this.syncLayerHeight()

    // Only show comments for the current page
    const currentPage = currentPageKey()

    // Track how many pins land on the same POINT so we can fan them out.
    // See `stackOffset` for why the key is the point and not the selector.
    const anchorCounts = new Map<string, number>()

    for (const comment of this.comments) {
      if (comment.resolved && !this.showResolved) continue
      if (comment.position.page !== currentPage) continue

      const pin = document.createElement("div")
      const selector = comment.position.anchorSelector
      const tabActive = areTabPanelsActive(comment.position.tabPanelIds)
      // A malformed / empty selector throws in querySelector; guard it so
      // one bad anchor can't break the whole render loop (every other pin
      // would fail to render). Treat a throw as "did not resolve" — same
      // as updatePositions() below.
      let anchorEl: Element | null = null
      if (tabActive) {
        try {
          anchorEl = document.querySelector(selector)
        } catch {
          anchorEl = null
        }
      }

      if (anchorEl && isElementVisible(anchorEl)) {
        const rect = anchorEl.getBoundingClientRect()
        const classes = ["pt-pin"]
        if (comment.resolved) classes.push("pt-pin--resolved")
        if (comment.id === this.activeCommentId) classes.push("pt-pin--active")
        pin.className = classes.join(" ")
        const point = commentPinPoint(comment.position, rect, window.scrollX, window.scrollY)
        this.positionPin(pin, point.x, point.y + stackOffset(anchorCounts, point.x, point.y))
      } else if (comment.position.anchorX != null && comment.position.anchorY != null) {
        const classes = ["pt-pin", "pt-pin--detached-fallback"]
        if (comment.resolved) classes.push("pt-pin--resolved")
        if (comment.id === this.activeCommentId) classes.push("pt-pin--active")
        pin.className = classes.join(" ")
        this.positionPin(pin, comment.position.anchorX, comment.position.anchorY)
      } else {
        const classes = ["pt-pin", "pt-pin--detached"]
        if (comment.resolved) classes.push("pt-pin--resolved")
        pin.className = classes.join(" ")
      }

      pin.appendChild(buildPinAvatar(comment.author))

      pin.addEventListener("click", (e) => {
        e.stopPropagation()
        sendToShell({
          type: "COMMENT_PIN_CLICKED",
          payload: {
            commentId: comment.id,
            pinRect: rectJson(pin.getBoundingClientRect()),
          },
        })
      })

      this.layer.appendChild(pin)
      this.pinElements.set(comment.id, pin)
    }
  }

  protected updatePositions(): void {
    this.syncLayerHeight()

    const anchorCounts = new Map<string, number>()
    // Comments whose selector didn't resolve on THIS build. `fallback`
    // still show a pin (at their captured coordinates); `unanchored`
    // have no coordinates either, so there's no pin to find — the list
    // surfaces both so a stale anchor is never silently invisible.
    const unanchored: string[] = []
    const fallback: string[] = []

    for (const comment of this.comments) {
      if (comment.resolved && !this.showResolved) continue
      const pin = this.pinElements.get(comment.id)
      if (!pin) continue

      const selector = comment.position.anchorSelector

      if (!areTabPanelsActive(comment.position.tabPanelIds)) {
        // Anchored, but its tab panel isn't active — hidden, not stale.
        pin.classList.add("pt-pin--detached")
        continue
      }

      // A malformed / empty selector throws in querySelector; guard it so
      // one bad anchor can't break the whole pin-update loop (every other
      // pin would freeze). Treat a throw as "did not resolve".
      let anchorEl: Element | null = null
      try {
        anchorEl = selector ? document.querySelector(selector) : null
      } catch {
        anchorEl = null
      }

      if (anchorEl && isElementVisible(anchorEl)) {
        const rect = anchorEl.getBoundingClientRect()
        const point = commentPinPoint(comment.position, rect, window.scrollX, window.scrollY)
        pin.classList.remove("pt-pin--detached", "pt-pin--detached-fallback")
        this.positionPin(pin, point.x, point.y + stackOffset(anchorCounts, point.x, point.y))
      } else if (comment.position.anchorX != null && comment.position.anchorY != null) {
        pin.classList.remove("pt-pin--detached")
        pin.classList.add("pt-pin--detached-fallback")
        this.positionPin(pin, comment.position.anchorX, comment.position.anchorY)
        fallback.push(comment.id)
      } else {
        pin.classList.add("pt-pin--detached")
        unanchored.push(comment.id)
      }
    }

    // Report anchor status to the shell, but only when it changes — this
    // runs on every scroll/resize, so unconditional posts would flood.
    const key = `${unanchored.slice().sort().join(",")}|${fallback.slice().sort().join(",")}`
    if (key !== this.lastAnchorStatusKey) {
      this.lastAnchorStatusKey = key
      sendToShell({
        type: "COMMENT_ANCHOR_STATUS",
        payload: { unanchored, fallback },
      })
    }
  }

  private positionPin(pin: HTMLElement, x: number, y: number): void {
    pin.style.right = ""
    pin.style.bottom = ""
    pin.style.left = `${x}px`
    pin.style.top = `${y}px`
  }
}
