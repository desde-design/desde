import { describe, expect, it, vi } from "vitest"
import type {
  ApplyEditOpts,
  EditResult,
  Mutation,
  StructuralEdit,
} from "@/editor/core"
import { EditSession } from "@/editor/session/edit-session"
import {
  dispatchClassMutation,
  dispatchTextMutation,
  type TextLaneDeps,
} from "./text-lane"

interface Prompt { bridgePendingId?: string }

/**
 * A complete `applied` result. `kind: "applied"` REQUIRES `appliedEditId` and
 * `affectedTargetIds` (`src/editor/core/framework-adapter.ts`), so a bare
 * `{ kind: "applied" } as EditResult` would hand the lane an object it then
 * reads missing fields off.
 */
const applied = (newHashes?: Record<string, string>): EditResult => ({
  kind: "applied",
  appliedEditId: "edit-1",
  affectedTargetIds: [],
  ...(newHashes ? { newHashes } : {}),
})

// Spelled out rather than imported from `editor-mutation-coalesce`, so a change
// to the real identity shows up here as a failure instead of moving both sides
// at once. The lane takes the identity as a dep and never builds one itself.
const mutationIdentity = (m: Mutation) => `${m.kind}:${m.selector}`

const textMutation = (id: string): Mutation =>
  ({
    id,
    kind: "text",
    selector: `#${id}`,
    before: "a",
    after: "b",
    sourceLoc: "src/App.vue:10:2",
    resolutionKind: "direct",
    scope: "definition",
    callsiteLoc: null,
    instancePath: "0",
  }) as unknown as Mutation

const classMutation = (id: string, overrides: Partial<Mutation> = {}): Mutation =>
  ({
    ...textMutation(id),
    kind: "class",
    before: "p-2",
    after: "p-4",
    ...overrides,
  }) as unknown as Mutation

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function harness(result: Promise<EditResult>) {
  const session = new EditSession<Prompt>({
    promptDraftId: (p) => p.bridgePendingId,
    propEditKey: (e) => `${e.target.selector} ${e.propName}`,
    mutationKey: mutationIdentity,
  })
  const applyEdit = vi.fn((_edit: StructuralEdit, _opts?: ApplyEditOpts) => result)
  const deps: TextLaneDeps = {
    session,
    adapter: { applyEdit, resolveOverride: vi.fn() },
    mutationKey: mutationIdentity,
    setStatus: vi.fn(),
    recordHashes: vi.fn(),
    baseHashes: () => ({}),
    resolveOverride: vi.fn(),
    verifyEdit: vi.fn(),
    refreshSelectionStamps: vi.fn(),
    queueForAi: vi.fn(),
    forgetEditId: vi.fn(),
    // The class lane's ONE pre-marker await. Resolvable per test.
    resolveStyleDestination: vi.fn(async () => ({ ok: true as const, opts: {} })),
    debounceMs: 500,
  }
  return { session, deps, applyEdit }
}

describe("dispatchTextMutation", () => {
  it("bundles the mutation as an llm-patch that probes the deterministic lane only", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    await dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    const edit = applyEdit.mock.calls[0][0] as unknown as {
      kind: string
      llmFallback: string
      mutations: Mutation[]
    }
    expect(edit.kind).toBe("llm-patch")
    expect(edit.llmFallback).toBe("chat")
    expect(edit.mutations.map((x) => x.id)).toEqual(["m1"])
  })

  it("hands the write the session's signal (finding V3)", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    await dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    expect(applyEdit.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it("records the hashes and nothing else once the page changed (findings U3, X5)", async () => {
    const pending = deferred<EditResult>()
    const { session, deps } = harness(pending.promise)
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    const running = dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    session.end("reconnect")
    pending.resolve(applied({ "src/App.vue": "v2" }))
    await running
    // Disk truth goes in whoever is looking: the write LANDED, and dropping the
    // hash is what makes the next save 409 for no reason (X5).
    expect(deps.recordHashes).toHaveBeenCalledWith({ "src/App.vue": "v2" })
    expect(deps.setStatus).not.toHaveBeenCalled()
    expect(deps.resolveOverride).not.toHaveBeenCalled()
    expect(deps.verifyEdit).not.toHaveBeenCalled()
    expect(deps.queueForAi).not.toHaveBeenCalled()
  })

  it("leaves the shared marker for the next session (finding U3)", async () => {
    const pending = deferred<EditResult>()
    const { session, deps } = harness(pending.promise)
    const m = textMutation("m1")
    const identity = mutationIdentity(m)
    session.updateMutations(() => [m])
    const running = dispatchTextMutation(identity, session.generation, deps)
    session.end("reconnect")
    // The next session takes the same identity: the key is the element and the
    // kind, and neither changed just because the page did.
    session.markInFlight("text", identity)
    pending.resolve(applied())
    await running
    expect(session.isInFlight("text", identity)).toBe(true)
  })

  it("shares one marker set with the class lane, which is what the lane id says", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const m = classMutation("m1")
    const identity = mutationIdentity(m)
    session.updateMutations(() => [m])
    session.markInFlight("text", identity)
    await dispatchClassMutation(identity, session.generation, deps)
    expect(applyEdit).not.toHaveBeenCalled()
  })

  it("queues a needsChat refusal for the save-time AI lane instead of interrupting", async () => {
    const { session, deps } = harness(
      Promise.resolve({ kind: "failed", reason: "bound binding", needsChat: true }),
    )
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    await dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    expect(deps.queueForAi).toHaveBeenCalledWith(mutationIdentity(m))
    // A needsChat refusal deliberately does NOT resolve the override: the edit
    // is still going to be applied, at save time, by the AI lane.
    expect(deps.resolveOverride).not.toHaveBeenCalled()
  })

  it("does not retire the next document's preview when verification settles late", async () => {
    // `verifyEdit` settles 0.85 to 3 seconds after the write and has no notion
    // of a session. The bridge restarts its mutation ids on a new document, so
    // a late "confirmed" resolving `normalized.id` would retire a preview shim
    // that now belongs to a completely different edit on the page in front of
    // the designer.
    let onOutcome: ((outcome: "verified" | "didnt-take" | "skipped") => void) | undefined
    const { session, deps } = harness(Promise.resolve(applied()))
    deps.verifyEdit = vi.fn((_input, cb) => {
      onOutcome = cb as typeof onOutcome
    })
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    await dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    expect(onOutcome).toBeDefined()
    // The page goes away between the write and the verification settling.
    session.end("reconnect")
    onOutcome!("verified")
    expect(deps.resolveOverride).not.toHaveBeenCalled()
  })

  it("resolves the preview when verification settles inside its own session (control)", async () => {
    // The control for the test above: the same callback, invoked while the
    // session it was created in is still the live one, DOES resolve. Without
    // this row the guard could be a `return` that never lets anything through.
    let onOutcome: ((outcome: "verified" | "didnt-take" | "skipped") => void) | undefined
    const { session, deps } = harness(Promise.resolve(applied()))
    deps.verifyEdit = vi.fn((_input, cb) => {
      onOutcome = cb as typeof onOutcome
    })
    const m = textMutation("m1")
    session.updateMutations(() => [m])
    await dispatchTextMutation(mutationIdentity(m), session.generation, deps)
    onOutcome!("verified")
    expect(deps.resolveOverride).toHaveBeenCalledWith("m1", "confirmed")
    onOutcome!("didnt-take")
    expect(deps.resolveOverride).toHaveBeenCalledWith("m1", "ineffective")
  })

  it("keeps the entry and re-arms the write when the text advanced", async () => {
    // The re-fire is the only proof `session.schedule` is wired, and the rebase
    // is what stops the second write looking for a `before` that is no longer
    // in the file.
    vi.useFakeTimers()
    try {
      const pending = deferred<EditResult>()
      const { session, deps, applyEdit } = harness(pending.promise)
      const m = textMutation("m1")
      const identity = mutationIdentity(m)
      session.updateMutations(() => [m])
      const running = dispatchTextMutation(identity, session.generation, deps)
      await Promise.resolve()
      // The designer kept typing while the write was out.
      session.updateMutations((prev) => prev.map((x) => ({ ...x, after: "bc" })))
      pending.resolve(applied({ "src/App.vue": "v2" }))
      await running
      const kept = session.getSnapshot().mutations[0]
      expect(kept.after).toBe("bc")
      expect(kept.before).toBe("b")
      expect(kept.sourceVersion).toBe("v2")
      expect(applyEdit).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(600)
      expect(applyEdit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("dispatchClassMutation", () => {
  it("stops before taking the marker when the destination lookup outlives the page", async () => {
    // This lane awaits BEFORE it takes its marker: resolving where a style rule
    // may be written can ask the document. A page replaced in that window makes
    // both the answer and the override id name a document that is gone.
    const destination = deferred<{ ok: true; opts: Record<string, never> }>()
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    deps.resolveStyleDestination = vi.fn(() => destination.promise)
    const m = classMutation("m1")
    const identity = mutationIdentity(m)
    session.updateMutations(() => [m])
    const running = dispatchClassMutation(identity, session.generation, deps)
    session.end("reconnect")
    destination.resolve({ ok: true, opts: {} })
    await running
    expect(applyEdit).not.toHaveBeenCalled()
    expect(session.isInFlight("text", identity)).toBe(false)
    expect(deps.setStatus).not.toHaveBeenCalled()
  })

  it("writes what buildStyleEdit produced, not an llm-patch", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const m = classMutation("m1")
    session.updateMutations(() => [m])
    await dispatchClassMutation(mutationIdentity(m), session.generation, deps)
    const edit = applyEdit.mock.calls[0][0] as { kind: string }
    expect(edit.kind).not.toBe("llm-patch")
    expect(edit.kind).toBe("scoped-css-override")
    expect(applyEdit.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it("fails the override with the reason when the destination cannot be found", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    deps.resolveStyleDestination = vi.fn(async () => ({
      ok: false as const,
      reason: "no stylesheet the editor may write to",
    }))
    const m = classMutation("m1")
    session.updateMutations(() => [m])
    await dispatchClassMutation(mutationIdentity(m), session.generation, deps)
    expect(applyEdit).not.toHaveBeenCalled()
    expect(deps.setStatus).toHaveBeenCalledWith(
      "Inline style edit failed: no stylesheet the editor may write to",
    )
    expect(deps.resolveOverride).toHaveBeenCalledWith(
      m.id,
      "failed",
      "no stylesheet the editor may write to",
    )
  })

  it("settles the class entry and resolves confirmed", async () => {
    // The class lane's post-write half had no direct test at all: every case
    // above stops before or at `applyEdit`. This is the ordinary success, end
    // to end.
    const { session, deps } = harness(Promise.resolve(applied()))
    const m = classMutation("m1")
    const identity = mutationIdentity(m)
    session.updateMutations(() => [m])
    await dispatchClassMutation(identity, session.generation, deps)
    // Nothing was typed during the round trip, so the entry is settled and
    // dropped: the next keystroke makes a fresh one against the on-disk source.
    expect(session.getSnapshot().mutations).toEqual([])
    // RELEASE-THEN-VERIFY. The preview is resolved by the CAPTURE's id, which
    // is the id the override store registered under, and verification runs
    // afterwards purely as a diagnosis.
    expect(deps.resolveOverride).toHaveBeenCalledWith("m1", "confirmed")
    expect(deps.verifyEdit).toHaveBeenCalledTimes(1)
    // The side table keyed by the settled entry's id goes with the entry.
    expect(deps.forgetEditId).toHaveBeenCalledWith("m1")
    // And the marker is given back, so the next class edit on this element is
    // not blocked by the one that finished.
    expect(session.isInFlight("text", identity)).toBe(false)
  })

  it("keeps the entry and re-arms when the value advanced", async () => {
    // The re-fire is the only proof `session.schedule` is wired on this lane.
    //
    // Note what is NOT asserted, because this lane genuinely does not do it:
    // the text lane rebases the kept entry's `before` to the dispatched value
    // and refreshes its `sourceVersion`. The class lane writes a CSS rule
    // rather than a source-line rewrite, so it carries no stale-target stamp
    // to refresh and leaves the entry exactly as it found it.
    vi.useFakeTimers()
    try {
      const pending = deferred<EditResult>()
      const { session, deps, applyEdit } = harness(pending.promise)
      const m = classMutation("m1")
      const identity = mutationIdentity(m)
      session.updateMutations(() => [m])
      const running = dispatchClassMutation(identity, session.generation, deps)
      // Two microtask turns, not one: this lane awaits its style destination
      // before it ever reaches `applyEdit`.
      await Promise.resolve()
      await Promise.resolve()
      // The designer kept changing classes while the write was out.
      session.updateMutations((prev) => prev.map((x) => ({ ...x, after: "p-8" })))
      pending.resolve(applied())
      await running
      const kept = session.getSnapshot().mutations[0]
      expect(kept).toBeDefined()
      expect(kept.after).toBe("p-8")
      expect(kept.before).toBe("p-2")
      expect(deps.forgetEditId).not.toHaveBeenCalled()
      expect(applyEdit).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(600)
      expect(applyEdit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reverts the preview when the applicator cannot express the edit", async () => {
    // `isUnsupportedStyleBuild` is the builder saying "there is no edit here",
    // and the swatch on screen is showing a value nothing will ever write.
    //
    // The shape that drives it on THIS substrate is a dead anchor
    // (`anchorMatchCount: 0`): the rule the builder would write matches nothing
    // on the page. The destination cannot drive it here, because the
    // destination only refuses on React (`overrideDestination` in
    // `style-edit-builders.ts`) and these tests run the default vue3 flag.
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const m = classMutation("m1", { anchorMatchCount: 0 })
    session.updateMutations(() => [m])
    await dispatchClassMutation(mutationIdentity(m), session.generation, deps)
    expect(applyEdit).not.toHaveBeenCalled()
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.stringContaining("Inline style edit failed:"),
    )
    expect(deps.resolveOverride).toHaveBeenCalledWith(m.id, "failed", expect.any(String))
  })
})
