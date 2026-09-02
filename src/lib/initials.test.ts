import { describe, expect, it } from "vitest"
import { avatarInitial } from "./initials"

describe("avatarInitial", () => {
  it("is the first letter, never two", () => {
    expect(avatarInitial("Dana Okafor")).toBe("D")
    expect(avatarInitial("Mo Chang")).toBe("M")
    expect(avatarInitial("Ada Byron Lovelace")).toBe("A")
  })

  it("is the same for one word as for several", () => {
    // The three implementations this replaced disagreed here: one returned
    // "MO" for a single-word name, the others "M".
    expect(avatarInitial("Mo")).toBe("M")
  })

  /**
   * The defect that prompted the rewrite. A self-declared reviewer identity
   * routinely carries a role in brackets, and the first-and-last-word rule
   * turned the bracket itself into a letter: "Dana (reviewer)" rendered "D(".
   */
  it("never returns punctuation", () => {
    expect(avatarInitial("Dana (reviewer)")).toBe("D")
    expect(avatarInitial("-mo-")).toBe("M")
    expect(avatarInitial("(guest)")).toBe("G")
    expect(avatarInitial("   Ada")).toBe("A")
  })

  it("falls back to ? when there is no letter or digit at all", () => {
    expect(avatarInitial("*** ???")).toBe("?")
    expect(avatarInitial("   ")).toBe("?")
    expect(avatarInitial("")).toBe("?")
  })

  it("handles non-Latin scripts and digits", () => {
    expect(avatarInitial("张伟")).toBe("张")
    expect(avatarInitial("ólafur arnalds")).toBe("Ó")
    expect(avatarInitial("4chan user")).toBe("4")
  })
})
