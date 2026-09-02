import { describe, expect, it } from "vitest"
import { demoDeleteMessage } from "./demo-delete-message"

const base = { present: true as const, dirtyFiles: 0, extraCommits: 0 }

describe("demoDeleteMessage", () => {
  it("says nothing is lost when the tree is untouched", () => {
    expect(demoDeleteMessage(base)).toBe("Delete the demo? It can be added again at any time.")
  })

  it("uses the singular for exactly one file and one commit", () => {
    expect(demoDeleteMessage({ ...base, dirtyFiles: 1, extraCommits: 1 })).toBe(
      "Delete the demo? 1 uncommitted file and 1 commit will be lost. Adding it again starts from the original.",
    )
  })

  it("uses the plural for more than one", () => {
    expect(demoDeleteMessage({ ...base, dirtyFiles: 3, extraCommits: 2 })).toContain(
      "3 uncommitted files and 2 commits will be lost",
    )
  })

  it("names only the half that is non-zero", () => {
    expect(demoDeleteMessage({ ...base, dirtyFiles: 2 })).toContain("2 uncommitted files will be lost")
    expect(demoDeleteMessage({ ...base, extraCommits: 4 })).toContain("4 commits will be lost")
  })

  it("contains no em dash", () => {
    for (const c of [base, { ...base, dirtyFiles: 1 }, { ...base, dirtyFiles: 2, extraCommits: 3 }]) {
      expect(demoDeleteMessage(c)).not.toContain("—")
    }
  })
})
