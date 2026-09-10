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
import { StrictMode, type ReactElement, useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  EditResult,
  Mutation,
  PendingMutation,
  Selection,
} from "@/editor/core"
import type { StyleOrigin } from "@/types/bridge"
import { useEditorEditing } from "./useEditorEditing"
import { useEditorStore } from "@/stores/editor-only"
import {
  bridgeDraftIdOf,
  DEFERRED_PARK_STATUS,
  HANDOFF_TIMEOUT_MS,
  SAVE_HANDOFF_TIMEOUT_STATUS,
} from "./pending-iteration-edit"
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
  // The id, not a constant. `mutationIdentity` is
  // `sourceLoc|instancePath|kind|target`, so two captures built from this
  // helper with a shared constant here are ONE buffer entry by design, and a
  // test that emits two of them would be measuring the coalescer rather than
  // whatever it meant to measure. One id, one on-screen field, one entry.
  instancePath: id,
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
 * Every request the hook made, with the abort signal it carried.
 *
 * The lanes race their requests against the bridge session's signal, and the
 * fetch stub deliberately ignores it (a request already on the wire can answer
 * after a teardown, which is what the staleness guards are for). Recording it
 * is how a test can still ask the other question: was the request given a
 * signal at all, and did the session end abort it?
 */
const requests: { url: string; signal: AbortSignal | undefined }[] = []

/** The signal the one request whose url contains `fragment` was handed. */
function signalFor(fragment: string): AbortSignal | undefined {
  const match = requests.filter((request) => request.url.includes(fragment))
  if (match.length !== 1) {
    throw new Error(
      `expected exactly one request matching ${fragment}, saw ${match.length}`,
    )
  }
  return match[0]!.signal
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
 * A selection the two style lanes accept.
 *
 * `domAnchor` is what the "This page" rule head is built from, and its
 * `matchCount` has to be non-zero or the builder refuses a dead anchor.
 * `authoredAt` and `editTarget` share a file so the reused-component guard
 * passes, and there is no `iterationContext` so the repeated-instance guard
 * passes too. See `buildPageScopedCssOverrideEdit`.
 */
const styleSelection: Selection = {
  targetId: "t-style",
  selector: "#panel",
  ancestry: [],
  classes: [],
  domAnchor: {
    file: "src/App.vue",
    line: 10,
    column: 2,
    matchCount: 1,
    resolution: "direct",
  },
  authoredAt: { file: "src/App.vue", line: 10, column: 2 },
  editTarget: { file: "src/App.vue", line: 10, column: 2 },
}

/** A token whose definition sits in a first-party stylesheet we may write. */
const tokenOrigin: StyleOrigin = {
  property: "background-color",
  computedValue: "rgb(247, 247, 247)",
  winningRule: null,
  varChain: [
    {
      name: "--panel-background",
      value: "#f7f7f7",
      definedAt: {
        selector: ":root",
        stylesheet: { href: "/src/tokens.css" },
      },
    },
  ],
}

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
 * The one refusal that LEAVES the capture in the buffer.
 *
 * A dispatched capture that comes back `applied` is settled and dropped from
 * the buffer, so a Save that runs after it finds nothing to flush and returns
 * ok before it reaches a single request. `needsChat` is the deterministic
 * lane's "a person has to look at this": the entry stays, its identity joins
 * the AI queue, and Save is the thing that dispatches it. Every save test
 * below is set up through it for that reason.
 */
const needsChat = (reason = "bound binding"): EditResult => ({
  kind: "failed",
  reason,
  needsChat: true,
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
  requests.length = 0
  useEditorStore.getState().resetEditor()
  // Nothing reaches the network. The one route with an answer that changes
  // behaviour is the loop check: `verifyIterationLoop` decides whether an
  // iteration edit opens the scope dialog or is handed to chat, so it answers
  // "there is a loop here" and every other route answers an empty object.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push({ url, signal: init?.signal ?? undefined })
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

/**
 * Start a Save and hand back a handle to it, without waiting for it to finish.
 *
 * The save tests below take the page away, or answer one of the save's
 * requests, in the MIDDLE of the run, so they need the promise rather than the
 * outcome. The start is inside `act` because `handleSaveAll` opens with two
 * state writes; every later step is settled by the test in its own `act`, which
 * is what keeps two `act` calls from overlapping (React warns when they do, and
 * a warning is not a pristine run).
 */
async function startSave(): Promise<{
  settled: Promise<void>
  outcome: () => SaveOutcome | undefined
}> {
  let outcome: SaveOutcome | undefined
  let settled: Promise<void> | undefined
  await act(async () => {
    settled = editing()!
      .handleSaveAll()
      .then((result) => {
        outcome = result
      })
    await Promise.resolve()
  })
  return { settled: settled!, outcome: () => outcome }
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
    // `dom-pending-1` again.
    //
    // WHAT THIS TEST WITNESSES, honestly. It is a pin on the row lane's
    // ADAPTER CAPTURE, not on the row lane's two staleness guards. The lane
    // reads its adapter once, before its first await (Task 7's rule, applied
    // to the iteration lane in Task 9), so a continuation that outlives its
    // session holds the DEPARTED adapter and could not reach the arriving one
    // even with both guards deleted. The guards are asserted one per await in
    // `src/editor/edit-service/lanes/iteration-lane.test.ts`, where each is
    // mutation-tested; what is left for this file is the capture itself, and
    // that is worth pinning: the day someone re-reads the adapter after the
    // proposal, this test goes red and the two below stop being decoration.
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
    // Nor into the departed one, which is where the capture would have sent it.
    // The proposal is the lane's THIRD await and its guard fires there, before
    // the lane reaches `adapter.applyEdit` at all, so the departed adapter sees
    // no write either. If the guard were removed this array would hold the
    // stale overwrite and the two assertions above would still pass, which is
    // the whole of the note at the top.
    expect(departing.applies).toEqual([])
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
  it("ends exactly one session per document change, whichever path finds it", async () => {
    // The three ends (the effect cleanup, the conflict reload, the handshake
    // that reports another document) produced different counts for the same
    // state before `sessionEndPlan` (finding T1). One object, one count.
    const { rerender } = await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
      adapter.emitCapture(capture("m1", "hello"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await waitForApply()
    await changeDocument(rerender, "doc-b")
    expect(editing()?.saveStatus).toBe(
      "The page connection was reset; 2 pending edits were discarded.",
    )
  })

  it("cancels the held drafts on the conflict reload too (findings S2, T4)", async () => {
    // The third end path. It used to empty the dialog rows without telling the
    // bridge, and to leave the draft maps holding ids the reloaded page hands
    // out again, so the next page's dom-pending-1 was answered by a dialog row
    // built for the page before it.
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await act(async () => {
      editing()!.handleReloadAfterConflict()
      await Promise.resolve()
    })
    expect(adapter.resolvedDrafts).toEqual([
      { pendingId: "dom-pending-1", choice: "cancel" },
    ])
    expect(editing()?.disambiguationPrompt).toBeNull()
  })

  it("aborts the iteration lane's request when the session ends (finding V3)", async () => {
    // The text lane's half of V3 is covered above, through the apply the fake
    // adapter records. The ITERATION lane holds the bridge's draft across an
    // HTTP round trip instead, and its signal reaches no adapter, so nothing
    // in this harness could see whether that lane threads the session's
    // lifetime at all. The fetch stub records the signal it was handed, which
    // is what makes the question answerable.
    const { rerender } = await mount()
    const adapter = lastFakeAdapter()
    holdProposal = true
    await act(async () => {
      adapter.emitSelection(loopSelection)
      adapter.emitAwaiting(loopDraft(REUSED_DRAFT_ID))
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())
    await act(async () => {
      editing()!.confirmIterationScope("this-row", false)
      await Promise.resolve()
    })
    await waitFor(() => expect(heldProposal).not.toBeNull())
    const signal = signalFor("/api/editor/edit-iteration")
    expect(signal).toBeDefined()
    expect(signal!.aborted).toBe(false)
    await act(async () => {
      rerender(<Harness enabled={false} />)
      await Promise.resolve()
    })
    expect(signal!.aborted).toBe(true)
  })

  it("dispatches two captures taken in one tick, not just the last (finding V1's cause)", async () => {
    // The buffers had two authorities: a useState for rendering and a ref for
    // the async lanes, assigned during render. A continuation that read the ref
    // before React re-rendered saw the previous array (the reason
    // `mutationsRef.current = mutations` exists at all), so the second capture
    // in a tick could overwrite the first instead of joining it. One authority
    // now, written synchronously, so both survive to their dispatch.
    await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
      lastFakeAdapter().emitCapture(capture("m2", "world"))
    })
    await waitFor(() => expect(lastFakeAdapter().applies).toHaveLength(2), {
      timeout: 3000,
    })
  })

  it("opens the queued question when the open one is answered (finding R1)", async () => {
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
      adapter.emitAwaiting(heldDraft("dom-pending-2"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await act(async () => {
      // The dialog's own confirm, which takes a `DisambiguationChoice` and
      // reads the head row itself. There is no `resolveDisambiguation`.
      editing()!.confirmDisambiguation("this-instance")
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-2"),
    )
  })

  it("re-arms a pending write once when the same document answers again", async () => {
    // The re-arm on a repeat handshake must not put a SECOND timer on an entry
    // that already has one. `resumePlan` skips an entry that is being written
    // right now, and the entry here is not: its debounce has not fired yet, so
    // nothing has marked it. The scheduler cancelling the armed timer before
    // it arms its own is what makes that safe, and this is the test of it.
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    // Inside the 500 ms debounce: buffered, armed, and not yet dispatched.
    expect(adapter.applies).toHaveLength(0)
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    await waitForApply()
    // Long enough for a second timer, if the re-arm added one, to fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    expect(adapter.applies).toHaveLength(1)
  })

  it("buffers a capture made in the document that is on screen", async () => {
    // The end-to-end half of the round-15 RULING. The adapter is what tells a
    // capture from the departed page apart from one made in the page in front
    // of the designer, by the id the bridge stamps on it. What the hook owes
    // the contract is the other half: a capture that DOES come from the page on
    // screen is buffered against the session that is live now, and the answer
    // to it is honoured rather than thrown away as stale.
    const { rerender } = await mount()
    const departing = lastFakeAdapter()
    await changeDocument(rerender, "doc-b")
    const arriving = lastFakeAdapter()
    expect(arriving).not.toBe(departing)
    expect(arriving.bridgeDocumentId).toBe("doc-b")
    const statusAfterChange = editing()?.saveStatus

    await act(async () => {
      arriving.emitCapture(capture("m2", "hello"))
    })
    const pending = await waitForApply()
    // Buffered under the live session: its request was not born cancelled.
    expect(pending.signal?.aborted).toBe(false)

    await act(async () => {
      pending.settle(applied({ "src/App.vue": "v2" }))
      await Promise.resolve()
    })
    // The answer was accepted, so no failure line was written over the line the
    // page change left.
    expect(editing()?.saveStatus).toBe(statusAfterChange)
  })

  it("stops a save at the step where the page changed, and keeps the discard line (findings W1, X6)", async () => {
    const { rerender } = await mount()
    const departing = lastFakeAdapter()
    await act(async () => {
      departing.emitCapture(capture("m1", "hello"))
    })
    // The typing-time dispatch, so there is something for Save to flush. Its
    // apply is parked; Save's own apply is the SECOND one.
    const typing = await waitForApply()
    await act(async () => {
      typing.settle(needsChat())
      await Promise.resolve()
    })
    const save = await startSave()
    const saveApply = await waitForApply(1)
    await changeDocument(rerender, "doc-b")
    await act(async () => {
      saveApply.settle(applied())
      await save.settled
    })
    expect(save.outcome()?.ok).toBe(false)
    // The session end's line names what the designer LOST; the save's line
    // only says the save stopped, which the page changing already showed.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    // Nothing was written into the page that replaced it.
    expect(lastFakeAdapter().applies).toEqual([])
    // AND THE SAVE STOPPED AT THIS STEP, not at a later one. These two are
    // what fail when the bundle step's answer is not read: the run carries on,
    // tells the departed bridge its previews are confirmed, then resolves a
    // destination stylesheet, writes every scoped-CSS mutation left, drops the
    // previews and reloads the page in front of the designer, all for a
    // document that has gone. The outcome and the status line cannot see any
    // of that on their own, because `run` withholds the body's value once the
    // session has ended whatever the body did on its way there.
    expect(departing.settledOverrides).toEqual([])
    expect(departing.clearedOverrides).toBe(0)
  })

  it("gives up on a save-time hand-off that never answers (finding N6)", async () => {
    // The save dialog shows no close control while a save is in flight, and the
    // server can hold a chat submission for a concurrency slot for as long as
    // the project's other turns take. Without a deadline the designer is left
    // in front of a modal they cannot dismiss over a save that never answers.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const escalateToChat = vi.fn(() => new Promise<boolean>(() => {}))
      await mount({ escalateToChat })
      await act(async () => {
        lastFakeAdapter().emitCapture(capture("m1", "hello"))
      })
      const typing = await waitForApply()
      await act(async () => {
        typing.settle(needsChat())
        await Promise.resolve()
      })
      const save = await startSave()
      const saveApply = await waitForApply(1)
      await act(async () => {
        saveApply.settle(needsChat("the bundle needs a person"))
        await Promise.resolve()
      })
      expect(escalateToChat).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS + 1_000)
        await save.settled
      })
      expect(save.outcome()?.ok).toBe(false)
      expect(editing()?.saveStatus).toBe(SAVE_HANDOFF_TIMEOUT_STATUS)
      // The dialog can only leave the "asking" panel when this is cleared, and
      // `saving` is what keeps the dialog up at all.
      expect(editing()?.saving).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops counting an identity the save has escalated (finding M6)", async () => {
    const escalateToChat = vi.fn(async () => true)
    await mount({ escalateToChat })
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const typing = await waitForApply()
    await act(async () => {
      typing.settle(needsChat())
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.aiQueueCount).toBe(1))
    const save = await startSave()
    const saveApply = await waitForApply(1)
    await act(async () => {
      saveApply.settle(needsChat("the bundle needs a person"))
      await save.settled
    })
    expect(save.outcome()?.ok).toBe(true)
    // Chat owns these edits now. An identity left in the queue makes the
    // capture scheduler skip the next inline edit on that same element, and
    // keeps the unload warning up over a queue that is empty in fact.
    expect(editing()?.aiQueueCount).toBe(0)
  })

  it("queues the save's question behind an open scope dialog (findings P1, Q3)", async () => {
    // A failed save reports on the status line and through `lastSaveFailure`.
    // It raises no dialog of its own, so the question already on screen is
    // untouched: the scope prompt the designer is answering stays up, and no
    // row appears in the deterministic dialog behind it.
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    const typing = await waitForApply()
    await act(async () => {
      typing.settle(needsChat())
      await Promise.resolve()
    })
    await act(async () => {
      adapter.emitSelection(loopSelection)
      adapter.emitAwaiting(loopDraft("dom-pending-9"))
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())
    const asking = editing()!.iterationScopePrompt
    const save = await startSave()
    const saveApply = await waitForApply(1)
    await act(async () => {
      saveApply.fail("the applicator refused the bundle")
      await save.settled
    })
    expect(save.outcome()?.ok).toBe(false)
    expect(editing()?.iterationScopePrompt).toBe(asking)
    expect(editing()?.disambiguationPrompt).toBeNull()
  })

  it("counts and cancels a question queued behind the open scope dialog", async () => {
    // The carry-forward from Task 6's review. A queued request is an edit the
    // bridge is still holding, and it is INVISIBLE: nothing has opened a dialog
    // for it. A teardown that forgot it would leave the bridge holding a draft
    // nobody can answer, and would under-report what the designer lost.
    const { rerender } = await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitSelection(loopSelection)
      adapter.emitAwaiting(loopDraft("dom-pending-1"))
    })
    await waitFor(() => expect(editing()?.iterationScopePrompt).not.toBeNull())
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-2"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.saveStatus).toBe(DEFERRED_PARK_STATUS))
    // Held, not shown: the scope dialog owns the modal.
    expect(editing()?.disambiguationPrompt).toBeNull()
    await act(async () => {
      rerender(<Harness enabled={false} />)
      await Promise.resolve()
    })
    expect(editing()?.saveStatus).toBe(
      "The page connection was reset; 2 pending edits were discarded.",
    )
    expect(adapter.resolvedDrafts).toEqual([
      { pendingId: "dom-pending-1", choice: "cancel" },
      { pendingId: "dom-pending-2", choice: "cancel" },
    ])
  })

  it("still says what an enabled flip discarded after a remount (finding R3)", async () => {
    // R3: `hookUnmountingRef` latches true on a cleanup and used never to be
    // reset, so StrictMode's mount / unmount / mount on ONE instance left it
    // true. A later `enabled` flip then took the UNMOUNT arm, which is the
    // silent one, and the designer lost held edits with nothing said about it.
    //
    // The effect body resets the flag, so this is a pin on that line rather
    // than a red test. StrictMode is what stages the remount honestly: it runs
    // the whole effect cycle twice on the same hook instance.
    const { rerender } = render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitAwaiting(heldDraft("dom-pending-1"))
    })
    await waitFor(() =>
      expect(editing()?.disambiguationPrompt?.pendingId).toBe("dom-pending-1"),
    )
    await act(async () => {
      rerender(
        <StrictMode>
          <Harness enabled={false} />
        </StrictMode>,
      )
      await Promise.resolve()
    })
    // "teardown", which SAYS what it discarded, not "unmount", which does not.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    expect(adapter.resolvedDrafts).toEqual([
      { pendingId: "dom-pending-1", choice: "cancel" },
    ])
  })

  it("keeps the scoped style lane's failure off the next page (finding W5)", async () => {
    // W5: this lane and the token lane below had no session discipline at all.
    // Both write the status bar after an await, and this one resolves its
    // destination stylesheet through a second await before that. A page
    // replaced in either window makes the report describe a document nobody is
    // looking at, over a status line that belongs to the page in front of them.
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitSelection(styleSelection)
    })
    await waitFor(() =>
      expect(useEditorStore.getState().editorSelection).not.toBeNull(),
    )
    let done: Promise<void> | undefined
    await act(async () => {
      done = editing()!.handleScopedStyleEdit(["bg-red-500"])
      await Promise.resolve()
    })
    const write = await waitForApply()
    // The write carries the session's lifetime, so ending the session cancels
    // it rather than leaving it to answer into a page that has gone.
    expect(write.signal).toBeDefined()
    await changeDocument(rerender, "doc-b")
    expect(write.signal?.aborted).toBe(true)
    const statusAfterChange = editing()?.saveStatus
    await act(async () => {
      // An abort arrives as an ordinary failure, which is exactly the shape
      // that used to be reported as "Scoped style edit failed".
      write.fail("edit request cancelled")
      await done
    })
    expect(editing()?.saveStatus).toBe(statusAfterChange)
  })

  it("keeps the token lane's failure off the next page (finding W5)", async () => {
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitSelection(styleSelection)
    })
    await waitFor(() =>
      expect(useEditorStore.getState().editorSelection).not.toBeNull(),
    )
    let done: Promise<void> | undefined
    await act(async () => {
      done = editing()!.handleTokenStyleEdit("background-color", tokenOrigin, [
        "bg-red-500",
      ])
      await Promise.resolve()
    })
    const write = await waitForApply()
    expect(write.edit.kind).toBe("token-value")
    expect(write.signal).toBeDefined()
    await changeDocument(rerender, "doc-b")
    expect(write.signal?.aborted).toBe(true)
    const statusAfterChange = editing()?.saveStatus
    await act(async () => {
      write.fail("edit request cancelled")
      await done
    })
    expect(editing()?.saveStatus).toBe(statusAfterChange)
  })
})
