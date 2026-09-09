/**
 * The hook-level lifecycle harness.
 *
 * Every finding in `docs/superpowers/reports/2026-09-08-ambiguous-edits-hand-off-findings/`
 * from round 11 onwards is one page change landing in the middle of one lane,
 * and each was found by reading code because there was nowhere to stage it.
 * This is that place: an adapter whose applies park until the test settles
 * them, a handshake that reports whichever document the test wants, and the
 * four transitions that matter (attach, teardown, reconnect, reload).
 *
 * Written against the hook AS IT STANDS, before the EditSession migration, so
 * the migration has something to be measured against. Nothing in the hook is
 * changed by this file.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import { type ReactElement, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  EditResult,
  Mutation,
  PendingMutation,
  Selection,
} from "@/editor/core"
import { useEditorEditing } from "./useEditorEditing"
import { useEditorStore } from "@/stores/editor-only"
import { bridgeDraftIdOf, DEFERRED_PARK_STATUS } from "./pending-iteration-edit"
import {
  FakeBridgeAdapter,
  lastFakeAdapter,
  type RecordedApply,
  resetFakeAdapters,
} from "./__fixtures__/fake-bridge-adapter"

vi.mock("@/editor/adapters/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/adapters/bridge")>()
  const { FakeBridgeAdapter: Fake } = await import("./__fixtures__/fake-bridge-adapter")
  return {
    ...actual,
    // The fake satisfies `FrameworkAdapter` and every member the hook reaches
    // on its adapter, but not the whole `BridgeFrameworkAdapter` class (the
    // postMessage plumbing, the handshake internals, the message router). The
    // cast says that outright: the compiler cannot check this substitution, and
    // the `implements FrameworkAdapter` clause on the fake is what checks the
    // part of it that matters.
    BridgeFrameworkAdapter: Fake as unknown as typeof actual.BridgeFrameworkAdapter,
  }
})

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(), error: vi.fn(), warning: vi.fn(),
    success: vi.fn(), loading: vi.fn(), dismiss: vi.fn(),
  }),
}))

const PROTOTYPE_URL = "https://prototype.example.com/dashboard"
const OTHER_PROTOTYPE_URL = "https://prototype.example.com/other"

const DISCARDED_ONE = "The page connection was reset; 1 pending edit was discarded."

/**
 * The hook's live return value, captured during render.
 *
 * Through a callback the harness calls, which is how `live-prototype-pane.test.tsx`
 * does it: assigning an outer binding inside a component body is a render side
 * effect, and the lint rules are right to refuse it. `editing()` is null until
 * the first render and is reset between tests.
 */
let captured: ReturnType<typeof useEditorEditing> | null = null
const captureEditing = (value: ReturnType<typeof useEditorEditing>): void => {
  captured = value
}
const editing = (): ReturnType<typeof useEditorEditing> | null => captured

function Harness({
  enabled = true,
  prototypeUrl = PROTOTYPE_URL,
  escalateToChat,
}: {
  enabled?: boolean
  prototypeUrl?: string
  escalateToChat?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<boolean>
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  captureEditing(
    useEditorEditing({ iframeRef, prototypeUrl, enabled, escalateToChat }),
  )
  return <iframe ref={iframeRef} title="Prototype" src={prototypeUrl} />
}

const capture = (id: string, after: string): Mutation => ({
  id,
  kind: "text",
  selector: `#${id}`,
  before: "a",
  after,
  sourceLoc: "src/App.vue:10:2",
  sourceVersion: "v1",
  resolutionKind: "direct",
  scope: "definition",
  callsiteLoc: null,
  instancePath: "0",
})

/**
 * A draft the bridge is holding that reaches the two-option dialog.
 *
 * `scope: "callsite"` with TWO origin candidates, which is the one shape that
 * routes to `queue-dialog` (`disambiguation-route.ts`). The brief's fixture had
 * `scope: "definition"` with one origin, and that shape never reaches a dialog
 * at all: `offeredDisambiguationChoices` returns a single honest option for
 * every definition-scope draft, so the route auto-applies it and the prompt is
 * never opened. Same fixture shape as `disambiguation-route.test.ts` uses for
 * its own "there is a real two-way choice" case.
 */
const heldDraft = (pendingId: string): PendingMutation => ({
  pendingId,
  draft: {
    id: pendingId,
    kind: "text",
    selector: `#${pendingId}`,
    before: "a",
    after: "b",
    sourceLoc: "src/App.vue:10:2",
    resolutionKind: "direct",
    scope: "callsite",
    callsiteLoc: "src/Parent.vue:4:2",
  },
  candidates: [
    { instancePath: "0", selector: "#one", origin: true },
    { instancePath: "1", selector: "#two", origin: true },
  ],
})

const LOOP_LOC = "src/List.vue:12:4"

/**
 * The draft id a reconnected bridge hands out again.
 *
 * The bridge numbers its held drafts from one per document, so the first draft
 * of the NEW session carries the id the departed session's edit is still
 * holding. That collision is the whole of finding S1.
 */
const REUSED_DRAFT_ID = "dom-pending-1"

/**
 * The iteration proposal POST, held open when a test asks for it.
 *
 * The "this item" lane holds the bridge's draft across this round trip, so it
 * is the await a page change has to land inside. `holdProposal` is false by
 * default and the route then refuses with a 422, which is what every test that
 * does not drive the lane wants.
 */
let holdProposal = false
let heldProposal: ((body: unknown) => void) | null = null

function answerProposal(body: unknown): void {
  const answer = heldProposal
  heldProposal = null
  answer?.(body)
}

/**
 * A selection the iteration lane accepts: it is one rendering of a loop, and
 * its `editTarget` is the position {@link loopDraft} anchors to. Both halves
 * are required by the gate in `onMutationAwaitingDisambiguation`.
 */
const loopSelection: Selection = {
  targetId: "t-loop",
  selector: "#row-0",
  ancestry: [],
  editTarget: { file: "src/List.vue", line: 12, column: 4 },
  iterationContext: {
    source: "v-for",
    key: "0",
    index: 0,
    siblingCount: 4,
    expression: "items",
  },
}

/**
 * A draft that routes to the ITERATION dialog rather than the deterministic
 * one: `text` + `definition` scope, anchored at the selection's own position.
 */
const loopDraft = (pendingId: string): PendingMutation => ({
  pendingId,
  draft: {
    id: pendingId,
    kind: "text",
    selector: "#row-0",
    before: "a",
    after: "b",
    sourceLoc: LOOP_LOC,
    resolutionKind: "direct",
    scope: "definition",
    callsiteLoc: null,
  },
  candidates: [
    { instancePath: "0", selector: "#row-0", origin: true },
    { instancePath: "1", selector: "#row-1", origin: false },
  ],
})

/**
 * A complete `applied` result. `kind: "applied"` REQUIRES `appliedEditId` and
 * `affectedTargetIds` (`src/editor/core/framework-adapter.ts`), so a bare
 * `{ kind: "applied" } as EditResult` lies to the compiler and then to the code
 * under test, which reads `affectedTargetIds` to invalidate selection.
 */
const applied = (newHashes?: Record<string, string>): EditResult => ({
  kind: "applied",
  appliedEditId: "edit-1",
  affectedTargetIds: [],
  ...(newHashes ? { newHashes } : {}),
})

/**
 * The hook's observable surface, and it is SMALLER than you want.
 *
 * `useEditorEditing` returns no `mutations` array, no `pendingDisambiguations`
 * array and no `hasUnsavedChanges` flag. Read the `return {` block near the end
 * of `src/hooks/useEditorEditing.ts` before writing an assertion. What it does
 * return, and what these tests use:
 *
 *   status                 { kind: "idle" | "connecting" | "ready" | "error" }
 *   saveStatus             string | null, the one status line
 *   saving                 boolean
 *   aiQueueCount           number, identities parked for the save-time AI lane
 *   iterationScopePrompt   the open scope question, or null
 *   disambiguationPrompt   the HEAD row only (`rows[0] ?? null`)
 *   confirmDisambiguation / cancelDisambiguation
 *   confirmIterationScope / cancelIterationScope
 *   handleSaveAll
 *
 * Do NOT add a field to the hook to make a test easier. The buffers are
 * observable through the fake adapter instead: a buffered entry arms a 500 ms
 * debounce and then calls `applyEdit`, so `adapter.applies` is the buffer's
 * shadow, and `adapter.resolvedDrafts` is what the bridge was told.
 */

beforeEach(() => {
  resetFakeAdapters()
  FakeBridgeAdapter.nextDocumentIds = ["doc-a"]
  FakeBridgeAdapter.nextHandshakeError = null
  captured = null
  holdProposal = false
  heldProposal = null
  useEditorStore.getState().resetEditor()
  // Nothing reaches the network. The one route with an answer that changes
  // behaviour is the loop check: `verifyIterationLoop` decides whether an
  // iteration edit opens the scope dialog or is handed to chat, so it answers
  // "there is a loop here" and every other route answers an empty object.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes("/api/editor/iteration/verify")) {
        return new Response(
          JSON.stringify({
            ok: true,
            loop: { expression: "items", location: { line: 12, column: 4 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/api/editor/edit-iteration")) {
        if (!holdProposal) {
          // 422 is the resolver's "I could not work this out", which is a soft
          // refusal the lane reports rather than a crash.
          return new Response(
            JSON.stringify({ reason: "The list's data could not be resolved." }),
            { status: 422, headers: { "content-type": "application/json" } },
          )
        }
        // Held. The test answers it once the page has been taken away and
        // brought back, which is the window finding S1 lives in. The abort
        // signal is deliberately ignored: a request already on the wire can
        // answer after a teardown, and the guard is what has to cover that.
        return new Promise<Response>((resolve) => {
          heldProposal = (body: unknown) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            )
        })
      }
      return new Response("{}", { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Render and wait for the first handshake to be adopted. */
async function mount(props: Parameters<typeof Harness>[0] = {}) {
  const result = render(<Harness {...props} />)
  await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
  return result
}

/** Wait for the debounced dispatch to reach the adapter. Debounce is 500 ms. */
async function waitForApply(index = 0) {
  await waitFor(
    () => expect(lastFakeAdapter().applies.length).toBeGreaterThan(index),
    { timeout: 3000 },
  )
  return lastFakeAdapter().applies[index]!
}

/** Point the iframe at another prototype, which is a document change. */
async function changeDocument(
  rerender: (ui: ReactElement) => void,
  documentId: string,
) {
  FakeBridgeAdapter.nextDocumentIds = [documentId]
  await act(async () => {
    rerender(<Harness prototypeUrl={OTHER_PROTOTYPE_URL} />)
    await Promise.resolve()
  })
  await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
}

type SaveOutcome = Awaited<
  ReturnType<NonNullable<ReturnType<typeof editing>>["handleSaveAll"]>
>

/**
 * Run Save and hand back what it returned.
 *
 * A refused Save dispatches nothing, and that is what these tests assert. A
 * Save that wrongly PROCEEDS reaches `applyEdit`, and the fake adapter parks
 * every apply, so it would hang the test instead of failing an assertion. The
 * drain answers whatever this Save starts, so a broken gate shows up as
 * `ok: true` rather than as a timeout.
 */
async function saveAll(): Promise<SaveOutcome | undefined> {
  let outcome: SaveOutcome | undefined
  await act(async () => {
    const answered = new Set<RecordedApply>(lastFakeAdapter().applies)
    const drain = setInterval(() => {
      for (const apply of lastFakeAdapter().applies) {
        if (answered.has(apply)) continue
        answered.add(apply)
        apply.settle(applied())
      }
    }, 5)
    try {
      outcome = await editing()!.handleSaveAll()
    } finally {
      clearInterval(drain)
    }
  })
  return outcome
}

describe("useEditorEditing: the bridge session", () => {
  it("adopts the first document without ending anything (finding U1)", async () => {
    await mount()
    const adapter = lastFakeAdapter()
    // Something the session is holding, so a wrongly-ended session would be
    // visible rather than silent.
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    // A second handshake for the SAME document (a late `load` from a slow
    // subresource) must not discard the session that is running. The listener
    // is on the IFRAME, which is where a real late load fires.
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    expect(adapter.resolvedDrafts).toEqual([])
    expect(editing()?.saveStatus).toBeNull()
    // Same adapter, and the buffered edit is still its one apply: the late load
    // ended nothing and re-armed nothing that was already in flight.
    expect(lastFakeAdapter()).toBe(adapter)
    expect(adapter.applies).toHaveLength(1)
  })

  it("dispatches a captured mutation while the page stays (control)", async () => {
    // The control row. Every test below takes the page away mid-flight; this
    // one proves the same setup reaches the adapter when nothing happens to it.
    await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const pending = await waitForApply()
    expect(pending.edit).toBeDefined()
  })

  it("retires the departed document's buffered captures and says how many (finding V1)", async () => {
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    await changeDocument(rerender, "doc-b")
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
  })

  it("keeps the buffer over a plain detach and re-attach (findings W2, X2)", async () => {
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const first = await waitForApply()
    const firstAdapter = lastFakeAdapter()
    await act(async () => {
      rerender(<Harness enabled={false} />)
      await Promise.resolve()
    })
    // A plain detach is not a document change: nothing is discarded and the
    // status bar says nothing.
    expect(editing()?.saveStatus).toBeNull()
    await act(async () => {
      rerender(<Harness enabled />)
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    expect(lastFakeAdapter()).not.toBe(firstAdapter)
    // The departed adapter was let go and the arriving one was not, which is
    // what makes "the NEW adapter" below mean anything.
    expect(firstAdapter.disposed).toBe(true)
    expect(lastFakeAdapter().disposed).toBe(false)
    // The kept entry is re-armed against the NEW adapter, which is X2: before
    // the fix, the buffer survived and the only timer that would flush it did
    // not, so nothing but another keystroke would ever have written it.
    const second = await waitForApply()
    expect(second).not.toBe(first)
  })

  it("cancels an in-flight edit request when the session ends (finding V3)", async () => {
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const pending = await waitForApply()
    expect(pending.signal).toBeDefined()
    await changeDocument(rerender, "doc-b")
    expect(pending.signal?.aborted).toBe(true)
  })

  it("does nothing with an answer that arrives after the page changed (finding V2)", async () => {
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const pending = await waitForApply()
    await changeDocument(rerender, "doc-b")
    const statusAfterReset = editing()?.saveStatus
    const appliesBefore = lastFakeAdapter().applies.length
    await act(async () => {
      pending.settle(applied({ "src/App.vue": "v2" }))
      await Promise.resolve()
    })
    // No status of its own, and no second write into the new document.
    expect(editing()?.saveStatus).toBe(statusAfterReset)
    expect(lastFakeAdapter().applies).toHaveLength(appliesBefore)
  })

  it("keeps a departed page's failure off the status bar (finding V2)", async () => {
    // The same boundary as the test above, settled the other way. A failure is
    // the half that is visible: the departed page's answer writes a line of its
    // own, and it would land over the line saying what the page change lost.
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const pending = await waitForApply()
    await changeDocument(rerender, "doc-b")
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    await act(async () => {
      pending.fail("could not locate the text")
      await Promise.resolve()
    })
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
  })

  it("keeps a torn-down iteration edit out of the next session (finding S1)", async () => {
    // S1's own scenario, and it is the ITERATION lane, not the text one.
    //
    // `dispatchIterationEdit`'s "this item" branch holds the bridge's draft
    // across a proposal POST. The page goes away while that POST is out, the
    // bridge reconnects, and the new session numbers its first draft
    // `dom-pending-1` again. Without the generation guard the departed page's
    // continuation then writes the old row's overwrite into the NEW document
    // and `releaseBridgeDraft` cancels the new session's identically numbered
    // draft, which takes the designer's live preview away and blames a write
    // they never asked for.
    const { rerender } = await mount()
    const departing = lastFakeAdapter()
    holdProposal = true
    await act(async () => {
      departing.emitSelection(loopSelection)
      departing.emitAwaiting(loopDraft(REUSED_DRAFT_ID))
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())
    // "This item" is the branch that posts for a proposal, and the route is
    // holding that POST open.
    await act(async () => {
      editing()!.confirmIterationScope("this-row", false)
      await Promise.resolve()
    })
    await waitFor(() => expect(heldProposal).not.toBeNull())

    // The page is taken away and comes back.
    await act(async () => {
      rerender(<Harness enabled={false} />)
      await Promise.resolve()
    })
    await act(async () => {
      rerender(<Harness enabled />)
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    const arriving = lastFakeAdapter()
    expect(arriving).not.toBe(departing)
    expect(departing.disposed).toBe(true)
    expect(arriving.disposed).toBe(false)

    // The reconnected bridge hands out the same draft id, and this session is
    // now the one holding it.
    await act(async () => {
      arriving.emitSelection(loopSelection)
      arriving.emitAwaiting(loopDraft(REUSED_DRAFT_ID))
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())

    // Now the departed page's proposal answers.
    await act(async () => {
      answerProposal({
        ok: true,
        proposal: {
          file: "src/List.vue",
          newSource: "<template><ul /></template>",
          baseHash: "hash-1",
        },
      })
      await Promise.resolve()
    })
    // Anything the stale continuation started gets its chance to finish, so a
    // release that only runs AFTER a write is not missed by the assertions
    // below. In a hook that guards the boundary there is nothing here to
    // settle.
    await act(async () => {
      for (const apply of arriving.applies) apply.settle(applied())
      await Promise.resolve()
    })

    // Nothing was written into the new document.
    expect(arriving.applies).toEqual([])
    // And the new session's draft was not cancelled out from under it.
    expect(arriving.resolvedDrafts).toEqual([])
    const stillAsking = editing()?.iterationScopePrompt
    expect(stillAsking && bridgeDraftIdOf(stillAsking)).toBe(REUSED_DRAFT_ID)
  })

  it("hands every held draft back to the bridge on a detach (findings Q2, R2, R5)", async () => {
    const { rerender } = await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await act(async () => {
      rerender(<Harness enabled={false} />)
      await Promise.resolve()
    })
    // Q2(b) is this line: teardown OWNS the parked work. Before it, teardown
    // neither flushed nor released, so the bridge kept holding a draft nobody
    // could answer any more.
    expect(adapter.resolvedDrafts).toEqual([
      { pendingId: "dom-pending-1", choice: "cancel" },
    ])
    expect(editing()?.disambiguationPrompt).toBeNull()
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    // The draft went back while the adapter was still there to hear it, which
    // is why the release is ordered before `dispose()`.
    expect(adapter.disposed).toBe(true)
  })

  it("holds a second deterministic question behind the open one (findings Q2, R1)", async () => {
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
      adapter.emitAwaiting(heldDraft("dom-pending-2"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    // The second question is held, not shown: the dialog renders the head row
    // and the head row is still the first draft.
    expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1")
    // And the second draft is not on screen anywhere: nothing was handed back
    // to the bridge for it, so it is genuinely queued rather than dropped.
    expect(adapter.resolvedDrafts).toEqual([])
    // Answering the first one lets the second through, which is the other half
    // of the queue: a held question that never opens is a lost edit. This is
    // Q2(d) as well: the prompt closing through ANY path has to flush what is
    // waiting behind it, and cancel is one of those paths.
    await act(async () => {
      editing()!.cancelDisambiguation()
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-2"),
    )
  })

  it("never opens the scope dialog over the deterministic one (finding R1)", async () => {
    // R1's own scenario, in the order the round file describes: B reaches the
    // ordinary disambiguation route and opens its dialog, then A's loop check
    // completes and wants the scope dialog. Before the one-owner queue, A
    // opened straight over B.
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await act(async () => {
      adapter.emitSelection(loopSelection)
      adapter.emitAwaiting(loopDraft("dom-pending-2"))
      await Promise.resolve()
    })
    // The loop check is a round trip; give it room to come back and try to
    // open its dialog. It says so on the status bar, because a question that
    // is held has no dialog of its own to be seen in yet.
    await waitFor(() =>
      expect(editing()?.saveStatus).toBe(DEFERRED_PARK_STATUS),
    )
    expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1")
    expect(editing()?.iterationScopePrompt).toBeNull()
    // Answering the deterministic question hands the modal to the scope one.
    await act(async () => {
      editing()!.cancelDisambiguation()
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())
    expect(editing()?.disambiguationPrompt).toBeNull()
  })

  it("refuses Save while a question is queued behind the open one (findings L4, R4)", async () => {
    await mount()
    const adapter = lastFakeAdapter()
    // WRITABLE WORK FIRST, and it is the point of the test rather than
    // scenery. L4 was that the parked check lived INSIDE the "there is nothing
    // to apply" branch, so one writable mutation was enough to skip it: Save
    // applied that mutation and reported success over a question nobody had
    // answered. With an empty buffer the broken gate and the fixed one refuse
    // alike, and the test could not tell them apart.
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
      adapter.emitAwaiting(heldDraft("dom-pending-2"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    const outcome = await saveAll()
    expect(outcome?.ok).toBe(false)
    // The SHAPE, which is "Save says a choice is still owed". The exact wording
    // is `parkedSaveRefusal`'s and has its own test.
    expect(editing()?.saveStatus).toMatch(/scope choice|still needs/i)
    // Both the open question and the queued one are counted, which is R4.
    expect(editing()?.saveStatus).toMatch(/2 edits/)
  })

  it("ends the session when the handshake never answers (finding V4)", async () => {
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    // The iframe loads a new document and it never answers: off origin, a 500,
    // or the five-second timeout. The shell is still holding the previous
    // page's session, and leaving it open leaves every continuation from that
    // page reading itself as current.
    FakeBridgeAdapter.nextHandshakeError = "timed out waiting for BRIDGE_READY"
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("error"))
    // ENDED, not merely reported. The buffered edit belonged to the page that
    // is gone, so it is retired and counted.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
  })

  it("ends the session when the prototype url changes to a page that never answers (finding V4)", async () => {
    const { rerender } = await mount()
    FakeBridgeAdapter.nextHandshakeError = "timed out waiting for BRIDGE_READY"
    await act(async () => {
      rerender(<Harness prototypeUrl={OTHER_PROTOTYPE_URL} />)
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("error"))
  })
})
