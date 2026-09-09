import { describe, expect, it } from "vitest"
import { parkedSaveRefusal, saveGate } from "./save-gate"

describe("saveGate", () => {
  /** Nothing unsaved anywhere, for a case to vary one field of. */
  const clear = {
    pendingDisambiguations: 0,
    queuedModalRequests: 0,
    mutations: 0,
    scoped: 0,
  }

  it("blocks on a parked edit even when there is writable work", () => {
    // THE regression. The parked check used to sit inside the "nothing to
    // apply" branch, so a single writable mutation skipped it entirely: the
    // mutation was applied, Save reported success, and the parked edit stayed
    // unresolved with nothing on screen saying so.
    expect(saveGate({ ...clear, pendingDisambiguations: 1, mutations: 3 })).toBe(
      "blocked-parked",
    )
    expect(saveGate({ ...clear, pendingDisambiguations: 1, scoped: 2 })).toBe(
      "blocked-parked",
    )
    expect(
      saveGate({ ...clear, pendingDisambiguations: 2, mutations: 4, scoped: 5 }),
    ).toBe("blocked-parked")
  })

  it("blocks on a parked edit with nothing else unsaved", () => {
    // The case that already worked, kept so a future simplification cannot
    // trade one for the other.
    expect(saveGate({ ...clear, pendingDisambiguations: 1 })).toBe("blocked-parked")
  })

  it("blocks on a request queued behind the open dialog", () => {
    // One dialog is on screen at a time, so an edit whose question has not been
    // reached yet is in `queuedModalRequests` and in no other count. Without
    // this the writable work would be applied and Save would report success
    // over an edit the bridge is still holding.
    expect(saveGate({ ...clear, queuedModalRequests: 1 })).toBe("blocked-parked")
    expect(saveGate({ ...clear, queuedModalRequests: 1, mutations: 3 })).toBe(
      "blocked-parked",
    )
    expect(saveGate({ ...clear, queuedModalRequests: 2, scoped: 1 })).toBe(
      "blocked-parked",
    )
  })

  it("is trivially ok with nothing unsaved at all", () => {
    expect(saveGate(clear)).toBe("nothing")
  })

  it("proceeds on either lane's work when nothing is parked or queued", () => {
    expect(saveGate({ ...clear, mutations: 1 })).toBe("proceed")
    expect(saveGate({ ...clear, scoped: 1 })).toBe("proceed")
    expect(saveGate({ ...clear, mutations: 2, scoped: 3 })).toBe("proceed")
  })
})

describe("parkedSaveRefusal", () => {
  it("is singular for one and plural above it", () => {
    expect(parkedSaveRefusal(1)).toContain("1 edit still needs a scope choice")
    expect(parkedSaveRefusal(3)).toContain("3 edits still need a scope choice")
  })

  it("says what to do and what dismissing does", () => {
    // Dismissing DISCARDS rather than resolves, which is not guessable from
    // the dialog, so the refusal has to say it.
    expect(parkedSaveRefusal(1)).toContain(
      "Choose how to apply the pending edit in the dialog, then save again.",
    )
    expect(parkedSaveRefusal(1)).toContain("Dismissing the dialog discards the edit.")
    expect(parkedSaveRefusal(3)).toContain("Dismissing the dialog discards the edits.")
  })

  it("names no dialog title, because the one it used to name no longer exists", () => {
    // The dialog asks "Change this item or all items?" now. A refusal that
    // points at a title is one rename away from sending the designer to look
    // for something that is not on screen.
    expect(parkedSaveRefusal(1)).not.toContain("Resolve ambiguous edit")
    expect(parkedSaveRefusal(1)).not.toMatch(/—/)
  })
})
