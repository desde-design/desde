import { describe, expect, it, vi } from "vitest"
import type {
  ApplyEditOpts,
  EditResult,
  PropEdit,
  Selection,
  StructuralEdit,
} from "@/editor/core"
import { EditSession } from "@/editor/session/edit-session"
import { dispatchPropEdit, type PropLaneDeps } from "./prop-lane"

interface Prompt { bridgePendingId?: string }

/**
 * A complete `applied` result. `kind: "applied"` REQUIRES `appliedEditId` and
 * `affectedTargetIds` (`src/editor/core/framework-adapter.ts`): a bare
 * `{ kind: "applied" } as EditResult` compiles and then hands the lane an
 * object it reads fields off.
 */
const applied = (newHashes?: Record<string, string>): EditResult => ({
  kind: "applied",
  appliedEditId: "edit-1",
  affectedTargetIds: [],
  ...(newHashes ? { newHashes } : {}),
})

/** A `needsChat` refusal, which is what sends the edit to the chat agent. */
const needsChat = (reason: string): EditResult => ({
  kind: "failed",
  reason,
  needsChat: true,
})

// The separator is NUL, not a space: `propEditKey` in `prop-lane.ts` uses one
// because a CSS selector can contain any printable character. Spelled out here
// rather than imported, so a change to the real one shows up as a test failure
// instead of moving both sides at once.
const propEditKey = (selector: string, propName: string) =>
  `${selector}\u0000${propName}`

const edit = (selector: string, propName: string, generation: number): PropEdit =>
  ({
    kind: "prop",
    id: `${selector}-${propName}`,
    target: {
      targetId: selector,
      selector,
      ancestry: [],
      editTarget: { file: "src/App.vue", line: 3, column: 2, fileHash: "v1" },
    },
    propName,
    value: "Save",
    generation,
  }) as PropEdit

function harness(result: Promise<EditResult>) {
  const session = new EditSession<Prompt>({
    promptDraftId: (p) => p.bridgePendingId,
    propEditKey: (e) => propEditKey(e.target.selector, e.propName),
    mutationKey: (m) => m.id,
  })
  const applyEdit = vi.fn((_edit: StructuralEdit, _opts?: ApplyEditOpts) => result)
  const deps: PropLaneDeps = {
    session,
    adapter: { applyEdit, selectBySelector: vi.fn(async () => null) },
    escalateToChat: vi.fn(async () => true),
    setStatus: vi.fn(),
    recordHashes: vi.fn(),
    resolveOverride: vi.fn(),
    verifyEdit: vi.fn(),
    refreshSelectionStamps: vi.fn(),
    forgetEditId: vi.fn(),
    debounceMs: 500,
  }
  return { session, deps, applyEdit }
}

describe("dispatchPropEdit", () => {
  it("writes the buffered value and drops the entry when it settles", async () => {
    const { session, deps, applyEdit } = harness(
      Promise.resolve(applied({ "src/App.vue": "v2" })),
    )
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    await dispatchPropEdit(propEditKey("#a", "label"), session.generation, deps)
    expect(applyEdit).toHaveBeenCalledTimes(1)
    expect(deps.recordHashes).toHaveBeenCalledWith({ "src/App.vue": "v2" })
    expect(session.getSnapshot().propEdits).toEqual([])
  })

  it("hands the write the session's signal (finding V3)", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    await dispatchPropEdit(propEditKey("#a", "label"), session.generation, deps)
    expect(applyEdit.mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it("does nothing at all when the page changed while the write was out (finding V2)", async () => {
    let settle!: (result: EditResult) => void
    const pending = new Promise<EditResult>((resolve) => { settle = resolve })
    const { session, deps } = harness(pending)
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    const running = dispatchPropEdit(propEditKey("#a", "label"), session.generation, deps)
    session.end("reconnect")
    settle(applied({ "src/App.vue": "v2" }))
    await running
    // The hashes ARE recorded: they are disk truth whoever is looking. Nothing
    // else is: no status, no override resolution, no verification.
    expect(deps.recordHashes).toHaveBeenCalledWith({ "src/App.vue": "v2" })
    expect(deps.setStatus).not.toHaveBeenCalled()
    expect(deps.resolveOverride).not.toHaveBeenCalled()
    expect(deps.verifyEdit).not.toHaveBeenCalled()
  })

  it("leaves the marker for the next session's dispatch (findings T3, U3)", async () => {
    let settle!: (result: EditResult) => void
    const pending = new Promise<EditResult>((resolve) => { settle = resolve })
    const { session, deps } = harness(pending)
    const key = propEditKey("#a", "label")
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    const running = dispatchPropEdit(key, session.generation, deps)
    session.end("reconnect")
    session.markInFlight("prop", key)
    settle(applied())
    await running
    expect(session.isInFlight("prop", key)).toBe(true)
  })

  it("refuses to start a second write for one identity", async () => {
    const { session, deps, applyEdit } = harness(Promise.resolve(applied()))
    const key = propEditKey("#a", "label")
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    session.markInFlight("prop", key)
    await dispatchPropEdit(key, session.generation, deps)
    expect(applyEdit).not.toHaveBeenCalled()
  })

  it("hands a needsChat refusal to chat with the session's signal (finding U4)", async () => {
    const { session, deps } = harness(Promise.resolve(needsChat("bound binding")))
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    await dispatchPropEdit(propEditKey("#a", "label"), session.generation, deps)
    expect(deps.escalateToChat).toHaveBeenCalledWith(
      expect.stringContaining("label"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(session.getSnapshot().propEdits).toEqual([])
  })

  it("keeps the entry and re-arms the write when the value advanced", async () => {
    vi.useFakeTimers()
    try {
      const { session, deps, applyEdit } = harness(
        Promise.resolve(applied({ "src/App.vue": "v2" })),
      )
      const key = propEditKey("#a", "label")
      session.updatePropEdits(() => [edit("#a", "label", session.generation)])
      // The designer kept typing while the write was out.
      const running = dispatchPropEdit(key, session.generation, deps)
      session.updatePropEdits((prev) => [{ ...prev[0], value: "Saved" }])
      await running
      expect(session.getSnapshot().propEdits).toHaveLength(1)
      // The kept entry's stamp is rebased onto this write's hash, or the
      // re-fire 409s against our own write.
      expect(session.getSnapshot().propEdits[0].target.editTarget?.fileHash).toBe("v2")
      await vi.advanceTimersByTimeAsync(500)
      expect(applyEdit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not re-arm a stale-target retry once the page changed (finding V2)", async () => {
    vi.useFakeTimers()
    try {
      const { session, deps, applyEdit } = harness(
        Promise.resolve({ kind: "failed", reason: "stale target" } as EditResult),
      )
      let land!: (selection: Selection | null) => void
      const reselect = new Promise<Selection | null>((resolve) => {
        land = resolve
      })
      deps.adapter = {
        applyEdit: deps.adapter.applyEdit,
        selectBySelector: vi.fn(() => reselect),
      }
      deps.staleRetried = new Set()
      const key = propEditKey("#a", "label")
      session.updatePropEdits(() => [edit("#a", "label", session.generation)])
      const running = dispatchPropEdit(key, session.generation, deps)
      // The write has answered 409 and the re-select is out.
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.adapter.selectBySelector).toHaveBeenCalledTimes(1)
      // A new adapter attaches, which is a page change that KEEPS the buffer,
      // so the entry is still here to be wrongly rebased.
      session.attach()
      land({
        ...edit("#a", "label", session.generation).target,
        editTarget: { file: "src/App.vue", line: 9, column: 2, fileHash: "v9" },
      } as Selection)
      await running
      await vi.advanceTimersByTimeAsync(1_000)
      // The entry keeps the stamps it was captured with: they describe the
      // document this dispatch wrote against, and the answer that just arrived
      // describes another one.
      expect(session.getSnapshot().propEdits[0].target.editTarget?.fileHash).toBe("v1")
      // No re-fire, and no failure line about a page nobody is looking at.
      expect(applyEdit).toHaveBeenCalledTimes(1)
      expect(deps.setStatus).not.toHaveBeenCalled()
      expect(deps.resolveOverride).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the entry when the hand-off was refused", async () => {
    const { session, deps } = harness(Promise.resolve(needsChat("bound binding")))
    deps.escalateToChat = vi.fn(async () => false)
    session.updatePropEdits(() => [edit("#a", "label", session.generation)])
    await dispatchPropEdit(propEditKey("#a", "label"), session.generation, deps)
    expect(session.getSnapshot().propEdits).toHaveLength(1)
  })
})
