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
import { buildPinAvatar, pinInitial } from "./comment-pins"

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
