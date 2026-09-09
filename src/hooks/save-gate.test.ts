import { describe, expect, it } from "vitest"
import { parkedSaveRefusal, saveGate } from "./save-gate"

describe("saveGate", () => {
  it("blocks on a parked edit even when there is writable work", () => {
    // THE regression. The parked check used to sit inside the "nothing to
    // apply" branch, so a single writable mutation skipped it entirely: the
    // mutation was applied, Save reported success, and the parked edit stayed
    // unresolved with nothing on screen saying so.
    expect(saveGate({ pendingDisambiguations: 1, mutations: 3, scoped: 0 })).toBe(
      "blocked-parked",
    )
    expect(saveGate({ pendingDisambiguations: 1, mutations: 0, scoped: 2 })).toBe(
      "blocked-parked",
    )
    expect(saveGate({ pendingDisambiguations: 2, mutations: 4, scoped: 5 })).toBe(
      "blocked-parked",
    )
  })

  it("blocks on a parked edit with nothing else unsaved", () => {
    // The case that already worked, kept so a future simplification cannot
    // trade one for the other.
    expect(saveGate({ pendingDisambiguations: 1, mutations: 0, scoped: 0 })).toBe(
      "blocked-parked",
    )
  })

  it("is trivially ok with nothing unsaved at all", () => {
    expect(saveGate({ pendingDisambiguations: 0, mutations: 0, scoped: 0 })).toBe(
      "nothing",
    )
  })

  it("proceeds on either lane's work when nothing is parked", () => {
    expect(saveGate({ pendingDisambiguations: 0, mutations: 1, scoped: 0 })).toBe(
      "proceed",
    )
    expect(saveGate({ pendingDisambiguations: 0, mutations: 0, scoped: 1 })).toBe(
      "proceed",
    )
    expect(saveGate({ pendingDisambiguations: 0, mutations: 2, scoped: 3 })).toBe(
      "proceed",
    )
  })
})

describe("parkedSaveRefusal", () => {
  it("is singular for one and plural above it", () => {
    expect(parkedSaveRefusal(1)).toContain("1 edit still need a scope choice")
    expect(parkedSaveRefusal(3)).toContain("3 edits still need a scope choice")
  })

  it("names the dialog and says what dismissing does", () => {
    // Dismissing DISCARDS rather than resolves, which is not guessable from
    // the dialog, so the refusal has to say it.
    expect(parkedSaveRefusal(1)).toContain('"Resolve ambiguous edit"')
    expect(parkedSaveRefusal(1)).toContain("dismiss it to discard")
  })
})
