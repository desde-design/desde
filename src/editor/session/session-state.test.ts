import { describe, expect, it } from "vitest"
import type { PendingMutation } from "@/editor/core"
import type { ModalRequest } from "./modal-queue"
import {
  discardedOnResetStatus,
  hasUndispatchedWork,
  isStaleGeneration,
  isStaleVerify,
  isSupersededHandshake,
  mayClearInFlightMarker,
  resumePlan,
  retireForeignEntries,
  retiresBufferedEntries,
  rowsToRelease,
  sessionEndPlan,
  shouldEndSessionOnHandshake,
  type SessionEndState,
} from "./session-state"

/** The scope-prompt payload, reduced to the one field sessionEndPlan reads. */
interface Prompt {
  bridgePendingId?: string
}

const promptDraftId = (prompt: Prompt): string | undefined => prompt.bridgePendingId
const plan = (state: SessionEndState<Prompt>) => sessionEndPlan(state, promptDraftId)

describe("rowsToRelease", () => {
  const row = (pendingId: string) => ({ pendingId } as unknown as PendingMutation)

  it("names every row the bridge is holding a draft for", () => {
    const rows = [row("p-1"), row("p-2")]
    expect(rowsToRelease(rows)).toEqual(rows)
  })

  it("leaves out a row with no bridge id", () => {
    // Nothing produces one today. The rule is "a row the bridge is holding",
    // and cancelling an id the adapter never issued is a message about nothing.
    expect(rowsToRelease([row("p-1"), row("")])).toEqual([row("p-1")])
  })

  it("does not mutate the rows it is given", () => {
    const rows = [row("p-1")]
    rowsToRelease(rows)
    expect(rows).toHaveLength(1)
  })
})

describe("discardedOnResetStatus", () => {
  it("counts the discarded edits, singular and plural", () => {
    expect(discardedOnResetStatus(1)).toBe(
      "The page connection was reset; 1 pending edit was discarded.",
    )
    expect(discardedOnResetStatus(3)).toBe(
      "The page connection was reset; 3 pending edits were discarded.",
    )
  })

  it("says nothing when nothing was discarded", () => {
    // A re-attach that was holding nothing is not an event, and the sentence
    // would be alarming about a page that lost nothing.
    expect(discardedOnResetStatus(0)).toBeNull()
    expect(discardedOnResetStatus(-1)).toBeNull()
  })

  it("uses no em dash and no first person", () => {
    for (const count of [1, 2]) {
      const status = discardedOnResetStatus(count) ?? ""
      expect(status).not.toMatch(/—/)
      expect(status).not.toMatch(/\b(me|my)\b/i)
    }
  })
})

describe("hasUndispatchedWork", () => {
  const none = { aiQueue: 0, parked: 0, deferred: 0 }

  it("says there is nothing to warn about when all three counts are zero", () => {
    expect(hasUndispatchedWork(none)).toBe(false)
  })

  it.each([
    ["mutations queued for the AI lane", { ...none, aiQueue: 1 }],
    ["edits parked in the deterministic dialog", { ...none, parked: 1 }],
    ["parks held behind an open scope prompt", { ...none, deferred: 1 }],
  ])("warns on %s", (_label, counts) => {
    expect(hasUndispatchedWork(counts)).toBe(true)
  })

  /**
   * The deferred count is the one the unload guard did not read. A park behind
   * an open prompt has opened no dialog of its own yet, so it is the only one
   * of the three with nothing on screen to remind the designer it exists, and
   * a reload would take the bridge's held draft with it in silence.
   */
  it("counts a deferred park even when nothing else is outstanding", () => {
    expect(hasUndispatchedWork({ aiQueue: 0, parked: 0, deferred: 2 })).toBe(true)
  })
})

describe("isStaleVerify", () => {
  it("is false for the only verify in flight and for the newest one", () => {
    expect(isStaleVerify(1, 1)).toBe(false)
    expect(isStaleVerify(7, 7)).toBe(false)
  })

  it("is true for an older verify answering after a newer one started", () => {
    // A (seq 1) and B (seq 2) are both in flight; B is the latest. A's answer,
    // whenever it lands, may not touch the prompt or B's draft.
    expect(isStaleVerify(1, 2)).toBe(true)
  })
})

describe("isStaleGeneration", () => {
  it("is stale only when the generation moved", () => {
    expect(isStaleGeneration(3, 3)).toBe(false)
    expect(isStaleGeneration(3, 4)).toBe(true)
    // Direction does not matter: any difference means a different session.
    expect(isStaleGeneration(4, 3)).toBe(true)
    expect(isStaleGeneration(0, 0)).toBe(false)
  })

  it("reads the same way as isStaleVerify, one level up", () => {
    // Same shape, different question: isStaleVerify asks whether a newer edit
    // replaced this one, isStaleGeneration whether the session itself ended.
    expect(isStaleGeneration(1, 2)).toBe(isStaleVerify(1, 2))
  })
})

describe("mayClearInFlightMarker", () => {
  it("lets a dispatch clear its own marker", () => {
    expect(mayClearInFlightMarker(7, 7)).toBe(true)
  })

  it("refuses once the session has moved on", () => {
    // The key in the set is no longer this dispatch's: the page reloaded, the
    // session end emptied the set, and a new dispatch for the same element and
    // prop put the same key back. Deleting it here would let a second write for
    // that identity start alongside the first.
    expect(mayClearInFlightMarker(7, 8)).toBe(false)
    expect(mayClearInFlightMarker(8, 7)).toBe(false)
  })

  it("is exactly the negation of isStaleGeneration", () => {
    for (const [captured, current] of [[0, 0], [1, 2], [5, 5], [9, 3]] as const) {
      expect(mayClearInFlightMarker(captured, current)).toBe(
        !isStaleGeneration(captured, current),
      )
    }
  })
})

describe("sessionEndPlan", () => {
  const mutation = (pendingId: string) => ({ pendingId } as unknown as PendingMutation)
  const scopePrompt = (bridgePendingId?: string): Prompt => ({
    ...(bridgePendingId ? { bridgePendingId } : {}),
  })
  const scopeRequest = (bridgePendingId?: string): ModalRequest<Prompt> => ({
    kind: "scope",
    pending: scopePrompt(bridgePendingId),
  })
  const parkRequest = (pendingId: string): ModalRequest<Prompt> => ({
    kind: "disambiguation",
    mutation: mutation(pendingId),
  })
  const empty: SessionEndState<Prompt> = {
    openPrompt: null,
    queued: [],
    rows: [],
    heldDraftIds: [],
    retiredBuffered: 0,
    // The default for these cases is a DOCUMENT change, because that is the
    // only kind of end that retires buffered entries at all. The reasons that
    // do not are the subject of their own cases below.
    reason: "reconnect" as const,
  }

  it("says nothing when the session was holding nothing", () => {
    expect(plan(empty)).toEqual({
      cancelDraftIds: [],
      discarded: 0,
      status: null,
    })
  })

  it("counts the prompt, the queue, the dialog rows and the maps", () => {
    const result = plan({
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-2")],
      rows: [mutation("dom-pending-3")],
      heldDraftIds: ["dom-pending-4"],
      retiredBuffered: 0,
      reason: "reconnect",
    })
    expect(result.discarded).toBe(4)
    expect(result.cancelDraftIds).toEqual([
      "dom-pending-1",
      "dom-pending-2",
      "dom-pending-3",
      "dom-pending-4",
    ])
    expect(result.status).toBe("The page connection was reset; 4 pending edits were discarded.")
  })

  it("counts a prompt and a queued question that hold no draft at all", () => {
    // An inspector or Layers edit reaches the scope dialog with nothing held by
    // the bridge. It is just as lost when the session ends, so it counts; there
    // is simply no id to hand back.
    const result = plan({
      ...empty,
      openPrompt: scopePrompt(),
      queued: [scopeRequest()],
    })
    expect(result.discarded).toBe(2)
    expect(result.cancelDraftIds).toEqual([])
  })

  it("counts a draft once when the prompt and the maps both name it", () => {
    // The usual case: the prompt on screen is asking about a draft that is
    // still recorded in the lane's maps. One edit, one cancel, one count.
    const result = plan({
      ...empty,
      openPrompt: scopePrompt("dom-pending-1"),
      heldDraftIds: ["dom-pending-1"],
    })
    expect(result.discarded).toBe(1)
    expect(result.cancelDraftIds).toEqual(["dom-pending-1"])
  })

  it("drops a queued question about the draft the open prompt already owns", () => {
    // Releasing the prompt's draft drops any queued request about it, the same
    // rule dropForDraft states. Counting it as well would report two
    // discarded edits for one.
    const result = plan({
      ...empty,
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-1"), parkRequest("dom-pending-2")],
    })
    expect(result.discarded).toBe(2)
    expect(result.cancelDraftIds).toEqual(["dom-pending-1", "dom-pending-2"])
  })

  it("leaves out a dialog row the bridge is not holding", () => {
    const result = plan({ ...empty, rows: [mutation("dom-pending-1"), mutation("")] })
    expect(result.discarded).toBe(1)
    expect(result.cancelDraftIds).toEqual(["dom-pending-1"])
  })

  it("is the same plan whichever way the session ends", () => {
    // The reason a session ends decides only whether the ids are handed BACK to
    // the bridge and whether the count is said out loud. What was discarded is
    // one fact, so the cleanup path and the iframe `load` path read it from
    // here rather than each counting for themselves. This is the assertion that
    // stops them drifting apart again.
    const state: SessionEndState<Prompt> = {
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-2"), scopeRequest("dom-pending-1")],
      rows: [mutation("dom-pending-3")],
      heldDraftIds: ["dom-pending-1", "dom-pending-4"],
      retiredBuffered: 0,
      reason: "reconnect",
    }
    const onCleanup = plan(state)
    const onReconnect = plan(state)
    expect(onReconnect).toEqual(onCleanup)
    expect(onCleanup.discarded).toBe(4)
    expect(onCleanup.status).toBe(discardedOnResetStatus(4))
  })

  it("does not mutate the state it is given", () => {
    const queued = [parkRequest("dom-pending-2")]
    const rows = [mutation("dom-pending-3")]
    const heldDraftIds = ["dom-pending-4"]
    plan({
      openPrompt: scopePrompt("dom-pending-1"),
      queued,
      rows,
      heldDraftIds,
      retiredBuffered: 0,
      reason: "reconnect",
    })
    expect(queued).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(heldDraftIds).toEqual(["dom-pending-4"])
  })

  it("counts the buffered entries the departed document left behind", () => {
    // Round 14 V1. A prop typed just before the boundary and two text captures
    // whose debounce never fired are three edits the designer loses. They hold
    // no bridge draft, so there is nothing to cancel for them, but the count
    // has to say so or the reset line under-reports what went.
    const result = plan({ ...empty, retiredBuffered: 3 })
    expect(result.discarded).toBe(3)
    expect(result.cancelDraftIds).toEqual([])
    expect(result.status).toBe("The page connection was reset; 3 pending edits were discarded.")
  })

  it("adds the buffered count to the drafts, rather than replacing it", () => {
    const result = plan({
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-2")],
      rows: [mutation("dom-pending-3")],
      heldDraftIds: ["dom-pending-4"],
      retiredBuffered: 2,
      reason: "reconnect",
    })
    expect(result.discarded).toBe(6)
    // The buffered entries are not drafts, so they add nothing here.
    expect(result.cancelDraftIds).toEqual([
      "dom-pending-1",
      "dom-pending-2",
      "dom-pending-3",
      "dom-pending-4",
    ])
  })

  it("counts no buffered entry for a reason that does not retire them", () => {
    // Round 15 W2. A `teardown` leaves the same page on screen with its
    // buffers untouched, so a count measured there would report edits as
    // discarded that are still sitting where the designer left them. The
    // drafts and the questions still count: those ARE cleared, whatever the
    // reason.
    for (const reason of ["teardown", "unmount"] as const) {
      const result = plan({
        ...empty,
        reason,
        openPrompt: scopePrompt("dom-pending-1"),
        retiredBuffered: 3,
      })
      expect(result.discarded).toBe(1)
      expect(result.status).toBe(discardedOnResetStatus(1))
    }
    for (const reason of ["reload", "reconnect"] as const) {
      expect(plan({ ...empty, reason, retiredBuffered: 3 }).discarded).toBe(3)
    }
  })

  it("says nothing when the buffers were empty and nothing else was held", () => {
    expect(plan({ ...empty, retiredBuffered: 0 }).status).toBeNull()
  })
})

describe("retiresBufferedEntries", () => {
  // Round 15 W2. Retirement is for a DOCUMENT change. Round 14's fix applied it
  // to every reason, so an `enabled: true → false → true` flip would have
  // thrown the designer's buffered edits away for a page that never moved.
  it("retires for the two reasons that replace the document", () => {
    expect(retiresBufferedEntries("reload")).toBe(true)
    expect(retiresBufferedEntries("reconnect")).toBe(true)
  })

  it("keeps the buffers when the document stays", () => {
    // `teardown` detaches the adapter with the same page still on screen and
    // its previews still visible; `unmount` needs nothing because React drops
    // the buffers with the hook.
    expect(retiresBufferedEntries("teardown")).toBe(false)
    expect(retiresBufferedEntries("unmount")).toBe(false)
  })
})

describe("resumePlan", () => {
  // Round 16 X2. A `teardown` keeps the buffers but cancels every debounce
  // timer, so a prop typed inside the debounce window before a detach had its
  // preview, its buffered entry, and nothing left to write it. A re-attach over
  // the same document re-arms exactly the entries that are not being written.
  it("re-arms every buffered entry when nothing is in flight", () => {
    const entries = [{ key: "a" }, { key: "b" }]
    expect(resumePlan(entries, new Set())).toEqual([{ key: "a" }, { key: "b" }])
  })

  it("leaves an entry whose write is already out alone", () => {
    // That dispatch reconciles when it lands and re-fires if the buffer moved
    // under it. A second timer for the same identity is the parallel-write race
    // the in-flight markers exist to stop.
    const entries = [{ key: "a" }, { key: "b" }]
    expect(resumePlan(entries, new Set(["a"]))).toEqual([{ key: "b" }])
  })

  it("arms one timer per identity, keeping the latest entry", () => {
    // The dispatch reads the buffer by key, so two entries under one key are one
    // write. Arming twice would be two timers racing for the same identity.
    const entries = [
      { key: "a", value: "first" },
      { key: "a", value: "second" },
    ]
    expect(resumePlan(entries, new Set())).toEqual([{ key: "a", value: "second" }])
  })

  it("re-arms nothing when the buffers are empty", () => {
    expect(resumePlan([], new Set(["a"]))).toEqual([])
  })
})

describe("retireForeignEntries", () => {
  // Round 14 V1. The two edit buffers outlive the document that filled them,
  // and nothing on an entry says which page it describes except this tag.
  const entry = (id: string, generation?: number) =>
    generation === undefined ? { id } : { id, generation }

  it("keeps only the entries captured in the live session", () => {
    const { kept, retired } = retireForeignEntries(
      [entry("a", 4), entry("b", 3), entry("c", 4)],
      4,
    )
    expect(kept.map((e) => e.id)).toEqual(["a", "c"])
    expect(retired.map((e) => e.id)).toEqual(["b"])
  })

  it("retires an entry from a NEWER session as readily as an older one", () => {
    // Exact equality, not "older than". A generation that is not this one
    // describes a document this one is not, whichever direction it lies in.
    const { kept, retired } = retireForeignEntries([entry("a", 9)], 4)
    expect(kept).toEqual([])
    expect(retired.map((e) => e.id)).toEqual(["a"])
  })

  it("retires an untagged entry, because it cannot say which page it came from", () => {
    // Every shell creation site tags its entry, so an untagged one arrived
    // from somewhere that cannot answer the question. Applying it to this
    // document is the wrong-file hazard the partition exists to stop.
    const { kept, retired } = retireForeignEntries([entry("a"), entry("b", 4)], 4)
    expect(kept.map((e) => e.id)).toEqual(["b"])
    expect(retired.map((e) => e.id)).toEqual(["a"])
  })

  it("keeps the buffer's order in both halves", () => {
    const { kept, retired } = retireForeignEntries(
      [entry("a", 4), entry("b", 1), entry("c", 4), entry("d", 1)],
      4,
    )
    expect(kept.map((e) => e.id)).toEqual(["a", "c"])
    expect(retired.map((e) => e.id)).toEqual(["b", "d"])
  })

  it("does not mutate the buffer it is given", () => {
    const entries = [entry("a", 4), entry("b", 1)]
    retireForeignEntries(entries, 4)
    expect(entries.map((e) => e.id)).toEqual(["a", "b"])
  })

  it("retires nothing from an empty buffer", () => {
    expect(retireForeignEntries([], 4)).toEqual({ kept: [], retired: [] })
  })
})

describe("shouldEndSessionOnHandshake", () => {
  it("ends nothing on the first handshake of a document", () => {
    // Nothing was adopted yet. The session this handshake connects to is the
    // one the attach just started, and ending it here would abort the
    // controller it had only just made.
    expect(shouldEndSessionOnHandshake(null, "doc-a")).toBe(false)
  })

  it("ends nothing when the same document answers again", () => {
    // The defect this closes: the bridge announces itself as soon as its
    // script runs, so a page with a slow image fires `load` afterwards and the
    // shell re-handshakes with the page it is already on. Ending the session
    // there discarded a draft the live bridge was still holding. It is also the
    // re-attach case: a teardown keeps the id, so the page that comes back is
    // recognised rather than treated as a new one.
    expect(shouldEndSessionOnHandshake("doc-a", "doc-a")).toBe(false)
  })

  it("ends the session when a different document is there", () => {
    expect(shouldEndSessionOnHandshake("doc-a", "doc-b")).toBe(true)
  })

  it("ends the session for a handshake that names no document at all", () => {
    // Round 16 X3 removed the id-less fallback: a bridge that reports no id is
    // refused at the handshake, so this cannot happen through the wiring. If it
    // ever does, ending is the conservative direction.
    expect(shouldEndSessionOnHandshake("doc-a", null)).toBe(true)
  })
})

describe("isSupersededHandshake", () => {
  // Round 14 V4. A handshake that fails for real ends the session; one that was
  // merely replaced must not, because the replacement is still running and
  // decides the boundary itself.
  it("says yes when a newer handshake replaced this one", () => {
    expect(isSupersededHandshake("handshake superseded by a newer one")).toBe(true)
  })

  it("says no to a page that never answered", () => {
    // The three real failures: off-origin, a server error, and the timeout.
    // Each leaves the shell holding a session with no document behind it.
    expect(isSupersededHandshake("bridge handshake timed out after 5000ms")).toBe(false)
    expect(isSupersededHandshake("prototype responded 500")).toBe(false)
    expect(isSupersededHandshake("")).toBe(false)
  })
})
