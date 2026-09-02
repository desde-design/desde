import { describe, expect, it } from "vitest"
import { HOVER_REVEAL } from "./hover-reveal"

/**
 * `HOVER_REVEAL` is four clauses and three of them are easy to mistake for
 * decoration. This pins each one to the case it exists for, so trimming it
 * fails here rather than as a bug report about a menu that vanishes.
 */
describe("HOVER_REVEAL", () => {
  it("hides by default and reveals on the card's hover", () => {
    expect(HOVER_REVEAL).toContain("opacity-0")
    expect(HOVER_REVEAL).toContain("group-hover:opacity-100")
  })

  it("keeps the control reachable by keyboard", () => {
    // Without this, tab lands on something invisible.
    expect(HOVER_REVEAL).toContain("focus-visible:opacity-100")
  })

  it("keeps an open menu's trigger visible", () => {
    // The one that looks like a bug when it is missing: a dropdown portals to
    // `body`, so moving the pointer into the menu leaves the card, and
    // `group-hover` goes false while the menu is still open.
    expect(HOVER_REVEAL).toContain("data-[state=open]:opacity-100")
  })

  it("shows unconditionally where there is no hover", () => {
    // A touch device cannot reveal this any other way.
    expect(HOVER_REVEAL).toContain("[@media(hover:none)]:opacity-100")
  })

  it("reserves its space, so revealing cannot reflow the row", () => {
    expect(HOVER_REVEAL).not.toContain("hidden")
  })
})
