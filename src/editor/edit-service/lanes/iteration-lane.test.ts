import { describe, expect, it, vi } from "vitest"
import type { EditResult, PendingMutation } from "@/editor/core"
import type { IterationVerifyOutcome } from "@/editor/edit-service/iteration-verify"
import {
  bridgeDraftIdOf,
  type PendingIterationEdit,
} from "@/editor/edit-service/pending-iteration-edit"
import { EditSession } from "@/editor/session/edit-session"
import {
  dispatchIteration,
  interceptIteration,
  type IterationDispatchDeps,
  type IterationLaneDeps,
} from "./iteration-lane"

/**
 * The lane takes the verify and the hand-off as dependencies, so these tests
 * drive them directly. Nothing here stubs `fetch`, and nothing renders.
 */

/** A promise plus the handle to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * The `dom-text` member, which is the only one that carries a bridge draft.
 *
 * The brief's fixture said `kind: "remove"`, which is the SERVER's operation
 * name rather than a member of this union. `bridgeDraftIdOf` answers only for
 * `editKind: "dom-text"`, and every case below turns on the draft id, so that
 * is the member these are about. `iterationTemplateLocation` reads
 * `selection.editTarget` for it, so the position lives there rather than in a
 * `templateLocation` field, which this type does not have.
 */
const pendingEdit = (bridgePendingId: string): PendingIterationEdit =>
  ({
    editKind: "dom-text",
    bridgePendingId,
    selection: {
      targetId: bridgePendingId,
      selector: `#${bridgePendingId}`,
      editTarget: { file: "src/App.vue", line: 12, column: 4 },
    },
    field: { selector: `#${bridgePendingId}`, textNodeIndex: 0 },
    value: "new text",
    iterationContext: {
      source: "v-for",
      key: "row-1",
      index: 0,
      siblingCount: 3,
      expression: "items",
    },
  }) as unknown as PendingIterationEdit

const held = (pendingId: string): PendingMutation =>
  ({ pendingId, draft: {}, candidates: [] }) as unknown as PendingMutation

function harness(verifyResult: Promise<IterationVerifyOutcome>) {
  const session = new EditSession<PendingIterationEdit>({
    promptDraftId: (p) => bridgeDraftIdOf(p),
    propEditKey: (e) => `${e.target.selector} ${e.propName}`,
    mutationKey: (m) => m.id,
  })
  const deps: IterationLaneDeps = {
    session,
    verify: vi.fn(() => verifyResult) as unknown as IterationLaneDeps["verify"],
    handOff: vi.fn(async () => true),
    rememberedScope: vi.fn(() => undefined),
    releaseDraft: vi.fn(),
    releaseDraftUnlessShared: vi.fn(),
    // The hook's `parkOrDefer` asks the SESSION for the deterministic dialog,
    // and two cases below assert what the session did with that request. A
    // `vi.fn(() => true)` that touches nothing would let them pass with no
    // park having happened, which is the opposite of what they are for. This
    // is the hook's own body, in four lines.
    parkOrDefer: vi.fn((pending: PendingIterationEdit, reason: string) => {
      const draftId = bridgeDraftIdOf(pending)
      const draft = draftId ? session.getDraft(draftId) : undefined
      if (!draft) return false
      session.requestModal({ kind: "disambiguation", mutation: draft, reason })
      return true
    }),
    releaseOrPark: vi.fn(),
    releaseOrParkUnlessShared: vi.fn(),
    dispatch: vi.fn(async () => {}),
    setStatus: vi.fn(),
    logScopeChoice: vi.fn(),
  }
  return { session, deps }
}

const loop = (line = 10, column = 2): IterationVerifyOutcome => ({
  kind: "loop",
  expression: "item in items",
  location: { line, column },
})

describe("interceptIteration", () => {
  it("does nothing at all when the session ended while the verify was out (finding S1)", async () => {
    // No release, no park, no status: the teardown handed every held draft back
    // already and the next adapter starts its ids at dom-pending-1 again, so
    // cancelling "this" draft id now would cancel the NEW session's edit.
    const verify = deferred<IterationVerifyOutcome>()
    const { session, deps } = harness(verify.promise)
    const pending = pendingEdit("dom-pending-1")
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    const running = interceptIteration(pending, deps)
    session.end("reconnect")
    verify.resolve(loop())
    await running
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.releaseDraftUnlessShared).not.toHaveBeenCalled()
    expect(deps.parkOrDefer).not.toHaveBeenCalled()
    expect(deps.setStatus).not.toHaveBeenCalled()
    expect(deps.handOff).not.toHaveBeenCalled()
    expect(session.getSnapshot().scopePrompt).toBeNull()
  })

  it("hands the verify the session's own signal (findings U4, N2)", async () => {
    const { session, deps } = harness(Promise.resolve(loop()))
    await interceptIteration(pendingEdit("dom-pending-1"), deps)
    expect(deps.verify).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    // And it is the session's, so ending the session aborts it.
    const passed = (deps.verify as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      signal: AbortSignal
    }
    expect(passed.signal.aborted).toBe(false)
    session.end("reconnect")
    expect(passed.signal.aborted).toBe(true)
  })

  it("releases only its own draft when a newer keystroke replaced it (finding L3)", async () => {
    // Two intercepts on the SAME draft: the designer kept typing, so the pending
    // object was rebuilt and a second verify went out. The first answer back is
    // stale, and a stale answer may release its OWN draft and nothing else.
    const first = deferred<IterationVerifyOutcome>()
    const { session, deps } = harness(first.promise)
    const older = pendingEdit("dom-pending-1")
    const newer = pendingEdit("dom-pending-1")
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    const running = interceptIteration(older, deps)
    // The newer intercept claims the draft, which is what makes the older stale.
    session.claimPending("dom-pending-1", newer)
    session.nextVerifySeq("dom-pending-1")
    first.resolve(loop())
    await running
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.releaseDraftUnlessShared).toHaveBeenCalledWith(older)
    expect(session.getSnapshot().scopePrompt).toBeNull()
  })

  it("parks rather than cancels when the loop check fails (finding M2)", async () => {
    // The designer's typed text is IN that draft. Cancelling it throws the text
    // away and says nothing; parking keeps it and asks a question about it.
    const { session, deps } = harness(
      Promise.resolve({ kind: "error", reason: "the file could not be read" }),
    )
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    const pending = pendingEdit("dom-pending-1")
    await interceptIteration(pending, deps)
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.releaseOrPark).toHaveBeenCalledWith(
      pending,
      "Could not check the source for a loop: the file could not be read",
    )
  })

  it("aborts the hand-off submission when the session ends (findings N2, X1)", async () => {
    const { session, deps } = harness(
      Promise.resolve({ kind: "no-loop", reason: "no v-for above this element" }),
    )
    const handOff = deferred<boolean>()
    let captured: AbortSignal | undefined
    deps.handOff = vi.fn((_prompt, options) => {
      captured = options?.signal
      return handOff.promise
    })
    const running = interceptIteration(pendingEdit("dom-pending-1"), deps)
    await Promise.resolve()
    await Promise.resolve()
    expect(captured).toBeDefined()
    session.end("reconnect")
    // The POST itself is cancelled, not just the wait for it: the agent must not
    // write the file while a deterministic dialog is being offered for the same
    // element on a page that has already gone.
    expect(captured?.aborted).toBe(true)
    handOff.resolve(true)
    await running
    expect(deps.setStatus).not.toHaveBeenCalled()
  })

  it("parks a refused hand-off, and never releases a draft it parked (finding M5)", async () => {
    const { session, deps } = harness(
      Promise.resolve({ kind: "no-loop", reason: "no v-for above this element" }),
    )
    deps.handOff = vi.fn(async () => false)
    session.holdDraft("dom-pending-1", held("dom-pending-1"))
    const pending = pendingEdit("dom-pending-1")
    await interceptIteration(pending, deps)
    expect(deps.parkOrDefer).toHaveBeenCalledWith(pending, expect.any(String))
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.releaseDraftUnlessShared).not.toHaveBeenCalled()
  })

  it("keeps the open prompt and defers the newcomer (findings N1, P3, Q1)", async () => {
    // A second verified edit on a DIFFERENT target arrives while the scope
    // dialog is up. The open one wins; the newcomer goes into the queue, not
    // straight into the dialog rows and not on top of the open dialog.
    const { session, deps } = harness(Promise.resolve(loop()))
    const open = pendingEdit("dom-pending-1")
    session.requestModal({ kind: "scope", pending: open })
    expect(session.modalOwner).toBe("scope")
    const newcomer = pendingEdit("dom-pending-2")
    session.holdDraft("dom-pending-2", held("dom-pending-2"))
    await interceptIteration(newcomer, deps)
    expect(session.getSnapshot().scopePrompt).toBe(open)
    expect(session.queuedCount).toBe(1)
    expect(session.getSnapshot().rows).toEqual([])
    expect(deps.releaseDraft).not.toHaveBeenCalled()
  })

  it("carries the verified loop position onto the pending edit", async () => {
    // The server walks UP from a nested element to the enclosing loop, so the
    // position it answers with is not the position that was asked about. A
    // "this item" dispatch aimed at the click rather than at the loop element
    // removes a `<span>` inside a row instead of the row.
    const { session, deps } = harness(Promise.resolve(loop(10, 2)))
    await interceptIteration(pendingEdit("dom-pending-1"), deps)
    const prompt = session.getSnapshot().scopePrompt
    expect(prompt?.loopLocation).toMatchObject({ line: 10, column: 2 })
  })

  it("dispatches straight through when a scope was already chosen for this kind", async () => {
    const { session, deps } = harness(Promise.resolve(loop()))
    deps.rememberedScope = vi.fn(() => "all-rows" as const)
    const pending = pendingEdit("dom-pending-1")
    await interceptIteration(pending, deps)
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ bridgePendingId: "dom-pending-1" }),
      "all-rows",
    )
    expect(deps.logScopeChoice).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "all-rows", remembered: true }),
    )
    expect(session.getSnapshot().scopePrompt).toBeNull()
  })
})

/**
 * The row lane's own guard pair.
 *
 * The hook harness's S1 case used to be the only witness for these, and it
 * cannot be any more: the lane captures the adapter ONCE, before its first
 * await, so a departed page's continuation can no longer reach the adapter
 * that replaced it even with the guards removed. That is the safer code and
 * the weaker test, so the guards are pinned here instead, one per await.
 */
describe("dispatchIteration, row scope", () => {
  const rowPending = (): PendingIterationEdit => ({
    ...pendingEdit("dom-pending-1"),
    loopLocation: { file: "src/App.vue", line: 12, column: 4 },
  })

  const proposal = {
    ok: true as const,
    proposal: {
      file: "src/List.vue",
      newSource: "<template><ul /></template>",
      baseHash: "hash-1",
    },
  }

  function rowHarness(
    requestProposal: () => Promise<typeof proposal>,
    applyEdit: () => Promise<EditResult>,
  ) {
    const session = new EditSession<PendingIterationEdit>({
      promptDraftId: (p) => bridgeDraftIdOf(p),
      propEditKey: (e) => `${e.target.selector} ${e.propName}`,
      mutationKey: (m) => m.id,
    })
    const deps: IterationDispatchDeps = {
      session,
      handOff: vi.fn(async () => true),
      adapter: {
        applyEdit: vi.fn(applyEdit),
        resolveMutationDisambiguation: vi.fn(),
        setElementText: vi.fn(),
      },
      parkOrDefer: vi.fn(() => true),
      releaseDraft: vi.fn(),
      setStatus: vi.fn(),
      requestProposal: vi.fn(
        requestProposal,
      ) as unknown as IterationDispatchDeps["requestProposal"],
      pageSourceFile: () => "src/App.vue",
      applyAllRowsDelete: vi.fn(),
      applyAllRowsProp: vi.fn(),
      applyAllRowsMove: vi.fn(),
    }
    return { session, deps }
  }

  const written: EditResult = {
    kind: "applied",
    appliedEditId: "edit-1",
    affectedTargetIds: [],
  }

  it("writes the rewrite and only then releases the draft (control)", async () => {
    const { deps } = rowHarness(
      async () => proposal,
      async () => written,
    )
    const pending = rowPending()
    await dispatchIteration(pending, "this-row", deps)
    expect(deps.adapter?.applyEdit).toHaveBeenCalledTimes(1)
    expect(deps.releaseDraft).toHaveBeenCalledWith(pending)
    expect(deps.setStatus).toHaveBeenLastCalledWith(
      expect.stringContaining("Iteration applied to src/List.vue"),
    )
  })

  it("writes nothing when the session ended while the proposal was out (finding S1)", async () => {
    const proposed = deferred<typeof proposal>()
    const { session, deps } = rowHarness(
      () => proposed.promise,
      async () => written,
    )
    const running = dispatchIteration(rowPending(), "this-row", deps)
    session.end("reconnect")
    proposed.resolve(proposal)
    await running
    expect(deps.adapter?.applyEdit).not.toHaveBeenCalled()
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.parkOrDefer).not.toHaveBeenCalled()
  })

  it("neither releases nor reports when the session ended while the write was out (finding S1)", async () => {
    const applying = deferred<EditResult>()
    const { session, deps } = rowHarness(
      async () => proposal,
      () => applying.promise,
    )
    const running = dispatchIteration(rowPending(), "this-row", deps)
    // Let the proposal land and the write go out.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.adapter?.applyEdit).toHaveBeenCalledTimes(1)
    session.end("reconnect")
    applying.resolve(written)
    await running
    // The draft this would give back belongs to the NEXT session now, and the
    // status line is describing another page.
    expect(deps.releaseDraft).not.toHaveBeenCalled()
    expect(deps.parkOrDefer).not.toHaveBeenCalled()
    expect(deps.setStatus).not.toHaveBeenCalledWith(
      expect.stringContaining("Iteration applied"),
    )
  })
})
