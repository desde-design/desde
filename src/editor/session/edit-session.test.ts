import { describe, expect, it, vi } from "vitest"
import { EditSession } from "./edit-session"
import type { Mutation, PendingMutation, PropEdit } from "@/editor/core"

interface Prompt { bridgePendingId?: string }

/**
 * The buffer key, spelled exactly as the hook spells it.
 *
 * The separator is NUL, not a space: `propEditKey` in `useEditorEditing.ts`
 * uses one because a CSS selector can contain any printable character. Write
 * the escape, never a real control byte: a NUL does not survive a copy.
 */
const key = (selector: string, propName: string) =>
  `${selector}\u0000${propName}`

const newSession = () =>
  new EditSession<Prompt>({
    promptDraftId: (prompt) => prompt.bridgePendingId,
    propEditKey: (edit) => key(edit.target.selector, edit.propName),
    mutationKey: (mutation) => mutation.id,
  })


/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("EditSession: the session itself", () => {
  it("starts at generation 0 with a live signal and no document", () => {
    const session = newSession()
    expect(session.generation).toBe(0)
    expect(session.documentId).toBeNull()
    expect(session.signal.aborted).toBe(false)
  })

  it("moves the generation and renews the signal on attach", () => {
    const session = newSession()
    const first = session.signal
    session.attach()
    expect(session.generation).toBe(1)
    expect(session.signal).not.toBe(first)
    expect(session.signal.aborted).toBe(false)
  })

  it("discards a run whose session moved while it was out (finding S1)", async () => {
    const session = newSession()
    const work = deferred<string>()
    const run = session.run(async () => work.promise)
    session.attach()
    work.resolve("written")
    await expect(run).resolves.toEqual({ stale: true })
  })

  it("returns the value when the session did not move", async () => {
    const session = newSession()
    await expect(session.run(async () => "written")).resolves.toEqual({
      stale: false,
      value: "written",
    })
  })

  it("swallows a throw from a run whose session moved, and rethrows otherwise", async () => {
    const session = newSession()
    const failing = deferred<string>()
    const run = session.run(async () => failing.promise)
    session.attach()
    failing.reject(new Error("request failed"))
    await expect(run).resolves.toEqual({ stale: true })

    await expect(
      session.run(async () => {
        throw new Error("request failed")
      }),
    ).rejects.toThrow("request failed")
  })

  it("hands the run a signal that ends with the session, not with the next one", async () => {
    const session = newSession()
    let captured: AbortSignal | null = null
    const work = deferred<void>()
    const run = session.run(async (ctx) => {
      captured = ctx.signal
      await work.promise
    })
    session.end("reconnect")
    expect(captured!.aborted).toBe(true)
    // The session has a live controller again for the next edit.
    expect(session.signal.aborted).toBe(false)
    work.resolve()
    await expect(run).resolves.toEqual({ stale: true })
  })

  it("reports staleness at each step, so a lane cannot forget the guard", async () => {
    const session = newSession()
    const first = deferred<string>()
    const second = deferred<string>()
    const seen: string[] = []
    const run = session.run(async (ctx) => {
      const a = await ctx.step(first.promise)
      if (a.stale) return "stopped-after-first"
      seen.push(a.value)
      const b = await ctx.step(second.promise)
      if (b.stale) return "stopped-after-second"
      seen.push(b.value)
      return "finished"
    })
    first.resolve("one")
    await Promise.resolve()
    session.attach()
    second.resolve("two")
    await expect(run).resolves.toEqual({ stale: true })
    expect(seen).toEqual(["one"])
  })

  it("keeps one in-flight marker per lane and key", () => {
    const session = newSession()
    expect(session.markInFlight("prop", "a")).toBe(true)
    expect(session.markInFlight("prop", "a")).toBe(false)
    expect(session.markInFlight("text", "a")).toBe(true)
    expect(session.isInFlight("prop", "a")).toBe(true)
  })

  it("takes one lane back to rest without touching the other", () => {
    vi.useFakeTimers()
    try {
      const session = newSession()
      const propTimer = vi.fn()
      const textTimer = vi.fn()
      session.markInFlight("prop", "a")
      session.markInFlight("text", "a")
      session.schedule("prop", "a", session.generation, propTimer, 500)
      session.schedule("text", "a", session.generation, textTimer, 500)
      session.resetLane("prop")
      expect(session.hasInFlight("prop")).toBe(false)
      expect(session.hasInFlight("text")).toBe(true)
      vi.advanceTimersByTime(500)
      expect(propTimer).not.toHaveBeenCalled()
      expect(textTimer).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows a lane's markers as a live read-only view", () => {
    // The capture scheduler's predicates take a `ReadonlySet`, and they have to
    // see the marker the lane took a moment ago, not a copy from before it.
    const session = newSession()
    const keys = session.inFlightKeys("text")
    expect(keys.has("a")).toBe(false)
    session.markInFlight("text", "a")
    expect(keys.has("a")).toBe(true)
    expect(session.inFlightKeys("prop").has("a")).toBe(false)
  })

  it("refuses to clear a marker the next session owns (findings T3, U3)", () => {
    const session = newSession()
    const generation = session.generation
    session.markInFlight("prop", "a")
    session.end("reconnect")
    // The new session takes the same key.
    session.markInFlight("prop", "a")
    session.clearInFlight("prop", "a", generation)
    expect(session.isInFlight("prop", "a")).toBe(true)
    session.clearInFlight("prop", "a", session.generation)
    expect(session.isInFlight("prop", "a")).toBe(false)
  })

  it("runs a scheduled callback only while its session is the live one (finding U2)", () => {
    vi.useFakeTimers()
    try {
      const session = newSession()
      const ran = vi.fn()
      session.schedule("prop", "a", session.generation, ran, 500)
      vi.advanceTimersByTime(500)
      expect(ran).toHaveBeenCalledTimes(1)

      session.schedule("prop", "b", session.generation, ran, 500)
      session.attach()
      vi.advanceTimersByTime(500)
      expect(ran).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("replaces the timer for a key rather than stacking them", () => {
    vi.useFakeTimers()
    try {
      const session = newSession()
      const ran = vi.fn()
      session.schedule("text", "a", session.generation, ran, 500)
      session.schedule("text", "a", session.generation, ran, 500)
      vi.advanceTimersByTime(500)
      expect(ran).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps verify sequences per target, so one edit cannot stale another (finding L3)", () => {
    const session = newSession()
    const a1 = session.nextVerifySeq("#a")
    const b1 = session.nextVerifySeq("#b")
    const a2 = session.nextVerifySeq("#a")
    expect(session.latestVerifySeq("#a", a1)).toBe(a2)
    expect(session.latestVerifySeq("#b", b1)).toBe(b1)
  })
})

const propEdit = (selector: string, propName: string, generation?: number): PropEdit =>
  ({
    kind: "prop",
    id: `${selector}-${propName}`,
    target: { targetId: selector, selector, ancestry: [] },
    propName,
    value: "x",
    ...(generation === undefined ? {} : { generation }),
  }) as PropEdit

const mutation = (id: string, generation?: number): Mutation =>
  ({
    id,
    kind: "text",
    selector: `#${id}`,
    before: "a",
    after: "b",
    sourceLoc: "src/App.vue:1:1",
    resolutionKind: "direct",
    scope: "definition",
    callsiteLoc: null,
    instancePath: "0",
    ...(generation === undefined ? {} : { generation }),
  }) as unknown as Mutation

const held = (pendingId: string): PendingMutation =>
  ({ pendingId, draft: {}, candidates: [] }) as unknown as PendingMutation

describe("EditSession: the state it owns", () => {
  it("notifies subscribers and hands out a new snapshot on every change", () => {
    const session = newSession()
    const listener = vi.fn()
    const stop = session.subscribe(listener)
    const before = session.getSnapshot()
    session.updatePropEdits((prev) => [...prev, propEdit("#a", "label", session.generation)])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot()).not.toBe(before)
    // Stable between changes, which useSyncExternalStore requires.
    expect(session.getSnapshot()).toBe(session.getSnapshot())
    stop()
    session.updatePropEdits((prev) => prev)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("opens the first dialog and queues the second, in either direction (finding R1)", () => {
    const opened: string[] = []
    const session = new EditSession<Prompt>({
      promptDraftId: (prompt) => prompt.bridgePendingId,
      propEditKey: (edit) => key(edit.target.selector, edit.propName),
      mutationKey: (m) => m.id,
      onModalOpened: (request) => opened.push(request.kind),
    })
    session.holdDraft("dom-pending-2", held("dom-pending-2"))
    expect(session.requestModal({ kind: "scope", pending: { bridgePendingId: "dom-pending-1" } })).toBe(true)
    expect(session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-2") })).toBe(false)
    expect(session.modalOwner).toBe("scope")
    expect(session.queuedCount).toBe(1)
    expect(session.getSnapshot().rows).toEqual([])

    session.setScopePrompt(null)
    session.releaseModal()
    expect(session.modalOwner).toBe("disambiguation")
    expect(session.getSnapshot().rows.map((row) => row.pendingId)).toEqual(["dom-pending-2"])
    expect(opened).toEqual(["scope", "disambiguation"])
  })

  it("opens the first dialog and queues the second, the other direction (finding R1)", () => {
    const session = newSession()
    expect(
      session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-2") }),
    ).toBe(true)
    expect(
      session.requestModal({ kind: "scope", pending: { bridgePendingId: "dom-pending-1" } }),
    ).toBe(false)
    expect(session.modalOwner).toBe("disambiguation")
    expect(session.queuedCount).toBe(1)

    session.releaseModal()
    expect(session.modalOwner).toBe("scope")
    expect(session.getSnapshot().scopePrompt).toEqual({ bridgePendingId: "dom-pending-1" })
  })

  it("releaseModal clears the scope prompt it was showing, on its own (finding R1)", () => {
    // The caller does NOT call setScopePrompt(null) first here. That used to
    // be required, and forgetting it left a stale prompt in the snapshot
    // alongside whatever opened next: the exact stacking finding R1 exists to
    // stop. The class must close that hole itself.
    const session = newSession()
    session.holdDraft("dom-pending-2", held("dom-pending-2"))
    session.requestModal({ kind: "scope", pending: { bridgePendingId: "dom-pending-1" } })
    session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-2") })

    session.releaseModal()

    expect(session.getSnapshot().scopePrompt).toBeNull()
    expect(session.getSnapshot().rows.map((row) => row.pendingId)).toEqual(["dom-pending-2"])
    expect(session.modalOwner).toBe("disambiguation")
  })

  it("keeps the newest pending edit claimed per draft id", () => {
    const session = newSession()
    const first: Prompt = { bridgePendingId: "dom-pending-1" }
    const second: Prompt = { bridgePendingId: "dom-pending-1" }
    session.claimPending("dom-pending-1", first)
    expect(session.latestPendingFor("dom-pending-1")).toBe(first)
    session.claimPending("dom-pending-1", second)
    expect(session.latestPendingFor("dom-pending-1")).toBe(second)
  })

  it("has nothing pending for a draft id nobody claimed", () => {
    const session = newSession()
    expect(session.latestPendingFor("dom-pending-9")).toBeUndefined()
  })

  it("clears a held draft's pending claim once its disambiguation dialog opens (finding R5)", () => {
    const session = newSession()
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    session.claimPending("dom-pending-1", { bridgePendingId: "dom-pending-1" })

    session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-1") })

    expect(session.heldDraftIds()).not.toContain("dom-pending-1")
    expect(session.latestPendingFor("dom-pending-1")).toBeUndefined()
  })

  it("drops a queued question about a draft that was released", () => {
    const session = newSession()
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    session.requestModal({ kind: "scope", pending: {} })
    session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-1") })
    expect(session.queuedCount).toBe(1)
    session.releaseDraft("dom-pending-1")
    expect(session.queuedCount).toBe(0)
    expect(session.getDraft("dom-pending-1")).toBeUndefined()
  })

  it("counts and cancels everything the session was holding when it ends", () => {
    const session = newSession()
    session.holdDraft("dom-pending-4", held("dom-pending-4"))
    session.requestModal({ kind: "scope", pending: { bridgePendingId: "dom-pending-1" } })
    session.requestModal({ kind: "disambiguation", mutation: held("dom-pending-3") })
    const result = session.end("reconnect")
    expect(result.discarded).toBe(3)
    expect(result.cancelDraftIds).toEqual(["dom-pending-1", "dom-pending-3", "dom-pending-4"])
    expect(result.status).toBe("The page connection was reset; 3 pending edits were discarded.")
    expect(session.modalOwner).toBeNull()
    expect(session.getSnapshot().scopePrompt).toBeNull()
    expect(session.heldDraftIds()).toEqual([])
  })

  it("retires the departed document's buffered edits and reports them (finding V1)", () => {
    const session = newSession()
    session.updatePropEdits(() => [propEdit("#a", "label", session.generation)])
    session.updateMutations(() => [mutation("m1", session.generation)])
    const result = session.end("reconnect")
    expect(result.retiredPropEdits.map((e) => e.id)).toEqual(["#a-label"])
    expect(result.retiredMutations.map((m) => m.id)).toEqual(["m1"])
    expect(result.discarded).toBe(2)
    expect(session.getSnapshot().propEdits).toEqual([])
    expect(session.getSnapshot().mutations).toEqual([])
  })

  it("keeps the buffers on a plain teardown, which is not a document change (finding W2)", () => {
    const session = newSession()
    session.updatePropEdits(() => [propEdit("#a", "label", session.generation)])
    const result = session.end("teardown")
    expect(result.retiredPropEdits).toEqual([])
    expect(result.discarded).toBe(0)
    expect(session.getSnapshot().propEdits).toHaveLength(1)
    expect(session.documentId).toBeNull()
  })

  it("ends the session only when the handshake reports another document (finding U1)", () => {
    const session = newSession()
    expect(session.start("doc-a").ended).toBeNull()
    expect(session.start("doc-a").ended).toBeNull()
    const generationBefore = session.generation
    const again = session.start("doc-b")
    expect(again.ended).not.toBeNull()
    expect(session.generation).toBe(generationBefore + 1)
    expect(session.documentId).toBe("doc-b")
  })

  it("re-arms the buffered edits when the same document answers again (finding X2)", () => {
    const session = newSession()
    session.start("doc-a")
    session.updatePropEdits(() => [
      propEdit("#a", "label", session.generation),
      propEdit("#b", "title", session.generation),
    ])
    session.updateMutations(() => [mutation("m1", session.generation)])
    session.end("teardown")
    session.attach()
    const { ended, resumed } = session.start("doc-a")
    expect(ended).toBeNull()
    // BOTH entries, and that is the point: `end` clears the marker sets, so
    // nothing is in flight across a teardown and every kept entry is re-armed.
    // The in-flight filter inside `resume` is for the next case, not this one.
    expect(resumed?.propEdits.map((e) => e.id)).toEqual(["#a-label", "#b-title"])
    expect(resumed?.mutations.map((m) => m.id)).toEqual(["m1"])
  })

  it("skips an entry a dispatch is writing right now", () => {
    // `resume` on its own, with no end in between, which is the only way a
    // marker can still be held: that entry's own dispatch re-fires if the
    // buffer moved under it, and a second timer for one identity is the
    // parallel-write race the markers exist to stop.
    const session = newSession()
    session.updatePropEdits(() => [
      propEdit("#a", "label", session.generation),
      propEdit("#b", "title", session.generation),
    ])
    session.markInFlight("prop", key("#b", "title"))
    expect(session.resume().propEdits.map((e) => e.id)).toEqual(["#a-label"])
  })

  it("re-arms nothing when the eligibility filter refuses a mutation", () => {
    const session = newSession()
    session.start("doc-a")
    session.updateMutations(() => [mutation("m1", session.generation)])
    session.end("teardown")
    session.attach()
    const { resumed } = session.start("doc-a", () => false)
    expect(resumed?.mutations).toEqual([])
  })

  it("gives back the dialog rows too, not just the held drafts (findings S2, T4)", () => {
    // The conflict reload used to empty the dialog rows without cancelling them
    // with the bridge, and to leave the draft maps holding ids the reloaded page
    // reissues. One end() clears all three; the caller decides only whether the
    // cancels are actually sent.
    const session = newSession()
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    session.updateRows(() => [held("dom-pending-2")])
    const result = session.end("reconnect")
    expect(result.cancelDraftIds).toEqual(["dom-pending-2", "dom-pending-1"])
    expect(session.heldDraftIds()).toEqual([])
    expect(session.getSnapshot().rows).toEqual([])
  })
})
