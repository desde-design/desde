import { describe, expect, it } from "vitest"
import {
  ACCESS_DESCRIPTIONS,
  ACCESS_LABELS,
  accessSummary,
  type ProjectAccessValue,
} from "./project-access-copy"

const ALL: ProjectAccessValue[] = ["all-members", "invited", "public-link"]

describe("access copy tables", () => {
  it("has a label and a description for every access value", () => {
    for (const access of ALL) {
      expect(ACCESS_LABELS[access]).toBeTruthy()
      expect(ACCESS_DESCRIPTIONS[access]).toBeTruthy()
    }
  })

  /**
   * The drift this module was created to end (Fix wave M2 review). "Invited
   * only" was described three different ways across the picker hint, the
   * dashboard badge tooltip and the read-only summary — including one
   * ("Only people you add below") that is only true while the picker is on
   * screen, which the badge tooltip is not.
   */
  it("describes 'invited' with the one sentence that is true wherever it appears", () => {
    expect(ACCESS_DESCRIPTIONS.invited).toBe("Only people who were added can open this project.")
  })
})

describe("accessSummary", () => {
  it("returns the plain description for every value while public links are on", () => {
    for (const access of ALL) {
      expect(accessSummary(access, true)).toBe(ACCESS_DESCRIPTIONS[access])
    }
  })

  it("leaves all-members and invited untouched when the kill switch is off — it is not their switch", () => {
    expect(accessSummary("all-members", false)).toBe(ACCESS_DESCRIPTIONS["all-members"])
    expect(accessSummary("invited", false)).toBe(ACCESS_DESCRIPTIONS.invited)
  })

  // The one case the static table cannot express: `canReadProject` treats a
  // stored `"public-link"` under a disabled switch exactly like
  // `"all-members"`, so promising "anyone with the link can view" there would
  // be a disclosure claim that is simply false.
  it("says what is actually true for a public-link project under a disabled kill switch", () => {
    const summary = accessSummary("public-link", false)
    expect(summary).not.toBe(ACCESS_DESCRIPTIONS["public-link"])
    expect(summary).toMatch(/turned off/i)
    expect(summary).toMatch(/signed-in/i)
  })
})
