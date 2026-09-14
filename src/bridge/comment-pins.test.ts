/**
 * The pin's inner mark.
 *
 * `comment-pins.ts` had no colocated suite before this — the manager is
 * exercised only by the live smoke harness (`tasks/scripts/bridge-smoke.mts`).
 * The avatar decision is pure DOM construction with no manager state behind
 * it, so it is testable on its own, and it is worth pinning because the
 * failure it guards against is invisible to every other gate: `img.src = ""`
 * typechecks, lints, bundles, and renders a broken-image glyph on every pin.
 *
 * MEASURED (2026-08-20): the viewer sends `photoURL: user.avatarUrl`, which is
 * the empty string for the local operator — the account every first-run
 * reviewer signs in as. So the empty case is the DEFAULT case here, not an
 * edge one.
 */

import { describe, expect, it } from "vitest"
import { buildPinAvatar, commentPinPoint, pinInitial, stackOffset } from "./comment-pins"

const author = (displayName: string, photoURL: string) => ({ displayName, photoURL })

describe("pinInitial", () => {
  it("takes the first character, uppercased", () => {
    expect(pinInitial("local operator")).toBe("L")
    expect(pinInitial("Ada")).toBe("A")
  })

  it("ignores leading whitespace rather than rendering a blank circle", () => {
    expect(pinInitial("   Mo")).toBe("M")
  })

  it("falls back to ? for an empty or whitespace-only name", () => {
    expect(pinInitial("")).toBe("?")
    expect(pinInitial("   ")).toBe("?")
  })

  it("keeps an astral-plane first character whole", () => {
    // `"🦊 Fox"[0]` is a lone surrogate, which renders as its own broken mark —
    // the exact class of glyph this fallback exists to remove.
    expect(pinInitial("🦊 Fox")).toBe("🦊")
    // A non-BMP LETTER, not an emoji: MATHEMATICAL DOUBLE-STRUCK CAPITAL A
    // (U+1D538). It has no uppercase mapping, so it must survive the
    // conversion intact rather than being dropped or halved.
    expect(pinInitial("𝔸da")).toBe("𝔸")
  })

  it("takes one code point AFTER uppercasing, not before", () => {
    // Unicode case conversion is not length-preserving. Uppercasing a
    // one-code-point slice hands back TWO characters for these, which
    // overflows the pin's 24px circle — the one-character contract broken
    // from the other end. Codex P3, 2026-08-20.
    expect("ß".toUpperCase()).toBe("SS") // the premise, asserted so it can't drift
    expect(pinInitial("ßara")).toBe("S")
    expect(pinInitial("ﬁnn")).toBe("F") // U+FB01 LATIN SMALL LIGATURE FI → "FI"
  })

  it("always returns exactly one printable character", () => {
    for (const name of ["", " ", "Ada", "🦊 Fox", "ábaco", "ßara", "ﬁnn", "𝔸da"]) {
      expect(Array.from(pinInitial(name)), name).toHaveLength(1)
    }
  })
})

describe("buildPinAvatar", () => {
  it("NEVER emits an img with an empty src", () => {
    // The whole defect in one assertion. An `<img src="">` resolves against
    // the document and fetches the page itself, which is not an image.
    for (const photoURL of ["", "   "]) {
      const el = buildPinAvatar(author("Local operator", photoURL))
      expect(el.tagName).toBe("SPAN")
      expect(el.querySelector("img")).toBeNull()
    }
  })

  it("renders the initial, in the pin's avatar slot, when there is no photo", () => {
    const el = buildPinAvatar(author("Local operator", ""))
    expect(el.textContent).toBe("L")
    // Keeps the base class, so the 24px circle geometry is unchanged and the
    // pin's silhouette does not shift with the author.
    expect(el.classList.contains("pt-pin-avatar")).toBe(true)
    expect(el.classList.contains("pt-pin-avatar--initial")).toBe(true)
    expect(el.getAttribute("aria-label")).toBe("Local operator")
  })

  it("renders the photo when there is one", () => {
    const el = buildPinAvatar(author("Ada", "https://example.test/ada.png"))
    expect(el.tagName).toBe("IMG")
    expect((el as HTMLImageElement).getAttribute("src")).toBe("https://example.test/ada.png")
    expect((el as HTMLImageElement).alt).toBe("Ada")
  })

  it("swaps a photo that fails to load for the initial", () => {
    // The other route to the same broken glyph: a photoURL that is set but
    // unfetchable — a private avatar host, an offline reviewer.
    const img = buildPinAvatar(author("Ada", "https://example.test/gone.png"))
    const host = document.createElement("div")
    host.appendChild(img)

    img.dispatchEvent(new Event("error"))

    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toBe("A")
    expect(host.firstElementChild?.classList.contains("pt-pin-avatar--initial")).toBe(true)
  })

  it("cannot loop when the fallback is installed", () => {
    const img = buildPinAvatar(author("Ada", "https://example.test/gone.png")) as HTMLImageElement
    document.createElement("div").appendChild(img)

    img.dispatchEvent(new Event("error"))

    expect(img.onerror).toBeNull()
  })
})

/**
 * Where the pin lands.
 *
 * The rule Mo asked for on 2026-09-13: a pin should appear where the reviewer
 * clicked, not at the anchored element's top-right corner, because a pin that
 * jumps to a corner is easy to miss. The fraction is what makes that survive a
 * resize, so the resize cases below are the point of this suite and not an
 * edge case bolted onto it.
 */
const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

describe("commentPinPoint", () => {
  it("places a comment with no ratios at the element's top-right corner", () => {
    // Every comment written before 2026-09-13 is this one. Its pin must not
    // move a pixel.
    expect(commentPinPoint({}, rectOf(100, 200, 400, 50), 0, 0)).toEqual({ x: 496, y: 196 })
  })

  it("treats a half-present ratio pair as absent", () => {
    const corner = commentPinPoint({}, rectOf(100, 200, 400, 50), 0, 0)
    expect(commentPinPoint({ offsetRatioX: 0.5 }, rectOf(100, 200, 400, 50), 0, 0)).toEqual(corner)
    expect(commentPinPoint({ offsetRatioY: 0.5 }, rectOf(100, 200, 400, 50), 0, 0)).toEqual(corner)
  })

  it("places a click-placed pin up and to the right of the click point", () => {
    // Clicked dead centre of a 400x100 box at (100, 200) — i.e. (300, 250).
    // The pin's bottom-left corner lands there, overlapping by 4px each way,
    // so its top-left is (296, 222) with the 32px pin height taken off.
    const point = commentPinPoint({ offsetRatioX: 0.5, offsetRatioY: 0.5 }, rectOf(100, 200, 400, 100), 0, 0)
    expect(point).toEqual({ x: 296, y: 222 })
  })

  it("adds the page scroll, so the point is document-space", () => {
    const point = commentPinPoint({ offsetRatioX: 0.5, offsetRatioY: 0.5 }, rectOf(100, 200, 400, 100), 40, 1000)
    expect(point).toEqual({ x: 336, y: 1222 })
  })

  it("keeps the pin at the same PROPORTIONAL spot when the element resizes", () => {
    // The case that rules out storing a pixel offset. Clicked 25% across a
    // 1200px-wide hero on a laptop; the same hero is 400px wide on a phone.
    // A stored pixel offset of 300 would put the pin 300px into a 400px box —
    // three quarters of the way across, nowhere near where it was clicked.
    const ratios = { offsetRatioX: 0.25, offsetRatioY: 0.5 }
    const wide = commentPinPoint(ratios, rectOf(0, 0, 1200, 200), 0, 0)
    const narrow = commentPinPoint(ratios, rectOf(0, 0, 400, 200), 0, 0)
    expect(wide.x).toBe(0.25 * 1200 - 4)
    expect(narrow.x).toBe(0.25 * 400 - 4)
  })

  it("never resolves above the document origin, where the layer would clip it", () => {
    // A click near the top edge of an element at the top of the page. The
    // 28px upward shift would otherwise put the pin at a negative top, which
    // the pin layer clips away entirely — a comment that exists and cannot be
    // seen.
    const point = commentPinPoint({ offsetRatioX: 0, offsetRatioY: 0 }, rectOf(0, 0, 300, 40), 0, 0)
    expect(point).toEqual({ x: 0, y: 0 })
  })
})

/**
 * Fan-out, which is keyed on the rendered POINT rather than on the anchor
 * selector. The cases below are the ones the key change actually moves, and
 * one of them is a deliberate behaviour CHANGE for old comments — pinned here
 * so it stays a decision rather than drifting back.
 */
describe("stackOffset", () => {
  it("does not move a pin that is alone on its point", () => {
    expect(stackOffset(new Map(), 100, 200)).toBe(0)
  })

  it("fans out pins that land on the same point, 20px apart", () => {
    const counts = new Map<string, number>()
    expect(stackOffset(counts, 100, 200)).toBe(0)
    expect(stackOffset(counts, 100, 200)).toBe(20)
    expect(stackOffset(counts, 100, 200)).toBe(40)
  })

  it("leaves click-placed pins on the same element alone when they are apart", () => {
    // The case the selector key got wrong: two comments on one hero, clicked
    // 300px apart, are already distinct and must not be displaced.
    const counts = new Map<string, number>()
    expect(stackOffset(counts, 100, 200)).toBe(0)
    expect(stackOffset(counts, 400, 200)).toBe(0)
  })

  it("fans out legacy pins on DIFFERENT selectors that share a corner", () => {
    // A deliberate change from the selector-keyed behaviour, not an accident.
    // A wrapper and its first child commonly share a top-right corner. Under
    // the old key each got index 0 in its own bucket and the two pins drew
    // exactly on top of each other, leaving one unclickable. They now fan out.
    const counts = new Map<string, number>()
    expect(stackOffset(counts, 896, 196)).toBe(0)
    expect(stackOffset(counts, 896, 196)).toBe(20)
  })
})
