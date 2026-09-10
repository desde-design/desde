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
import { toast } from "sonner"
import type {
  ComponentManifest,
  ComponentManifestSource,
  EditResult,
  Mutation,
  PendingMutation,
  Selection,
} from "@/editor/core"
import type { OutlineNode, StyleOrigin } from "@/types/bridge"
import { useEditorEditing } from "./useEditorEditing"
import { useEditorStore } from "@/stores/editor-only"
import {
  bridgeDraftIdOf,
  DEFERRED_PARK_STATUS,
  HANDOFF_TIMEOUT_MS,
  SAVE_HANDOFF_TIMEOUT_STATUS,
} from "@/editor/edit-service/pending-iteration-edit"
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
  manifestSource,
}: {
  enabled?: boolean
  prototypeUrl?: string
  escalateToChat?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<boolean>
  /**
   * The manifest source the selection listener looks a component up in.
   *
   * Undefined for every row that does not care, which is what the hook's own
   * default is built for: an EMPTY composite, so a lookup answers null and no
   * manifest is ever installed. A row that wants to hold a lookup open passes
   * {@link ParkedManifestSource}. It has to be the SAME instance across a
   * rerender: the source is a dependency of the adapter effect, so a fresh
   * object per render would detach and re-attach the adapter on every one.
   */
  manifestSource?: ComponentManifestSource
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  captureEditing(
    useEditorEditing({
      iframeRef,
      prototypeUrl,
      enabled,
      escalateToChat,
      manifestSource,
    }),
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
 * A `class` capture: the OTHER dispatch on the same lane.
 *
 * Same shape `text-lane.test.ts` gives `dispatchClassMutation`: a class list
 * before and after, rather than a text value. Plus the two fields the capture
 * scheduler gates a class capture on (`shouldProbeClassMutation`: a `sourceLoc`
 * and a `direct` or `ancestor` resolution) and the `anchorMatchCount` the style
 * builder refuses a zero of. The buffer identity carries the mutation's kind,
 * so this and {@link capture} on one id are two entries, not one.
 */
const classCapture = (id: string, after: string): Mutation => ({
  ...capture(id, after),
  kind: "class",
  before: "p-2",
  anchorMatchCount: 1,
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

/**
 * The component-catalog GET, held open when a test asks for it.
 *
 * `handleEditComponent` fetches the catalog and then NAVIGATES the iframe, so
 * this is the await a page change has to land inside. Off by default, and the
 * default answer is the same empty object every other route gives.
 */
let holdCatalog = false
let heldCatalog: ((body: unknown) => void) | null = null

function answerCatalog(body: unknown): void {
  const answer = heldCatalog
  heldCatalog = null
  answer?.(body)
}

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
 * A manifest source whose lookups park until the test answers them.
 *
 * The selection listener asks it for the selected component's manifest, and
 * the question these rows exist for is what happens when that answer arrives
 * after the selection it was asked for is gone. Parking is the only way to put
 * another selection, or a whole other page, inside that await. Same shape as
 * the parked `applyEdit` and `getStructure` on the fake adapter: one entry per
 * call, each holding its own `settle`.
 *
 * ONE instance per test, held in a `const` and passed to every render: the
 * source is a dependency of the hook's adapter effect, so a new object would
 * re-attach the adapter instead of leaving the page alone.
 */
class ParkedManifestSource implements ComponentManifestSource {
  readonly id = "parked"
  readonly framework = "vue3"
  readonly designSystem = "test-ds"
  /** Every lookup asked for, in order, each still to be answered. */
  readonly lookups: {
    name: string
    settle: (manifest: ComponentManifest | null) => void
  }[] = []

  async listComponents(): Promise<ComponentManifest[]> {
    return []
  }

  getComponent(componentName: string): Promise<ComponentManifest | null> {
    return new Promise<ComponentManifest | null>((resolve) => {
      this.lookups.push({ name: componentName, settle: resolve })
    })
  }
}

/** A manifest a parked lookup can be answered with. */
const manifestNamed = (name: string): ComponentManifest => ({
  id: `parked:${name}`,
  name,
  framework: "vue3",
  designSystem: "test-ds",
  props: [],
})

/**
 * A selection of `selector` that renders `componentName`.
 *
 * No `attributionContext`, so the prefetch chain in the listener stays out of
 * these rows: the manifest lookup is the await they are about, and a second
 * parked await would only make the ordering harder to read.
 */
const componentSelection = (
  selector: string,
  componentName: string,
): Selection => ({
  targetId: `t-${componentName}`,
  selector,
  ancestry: [],
  componentName,
  authoredAt: { file: "src/App.vue", line: 10, column: 2 },
  editTarget: { file: "src/App.vue", line: 10, column: 2 },
})

/** The manifest the inspector is currently offering controls for. */
const installedManifest = (): ComponentManifest | null =>
  useEditorStore.getState().editorManifest

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
  // The toast mocks are module-level, so their call records outlive a test.
  // One row below asserts that NOTHING warned, and a warning from any earlier
  // test in the file would have failed it for the wrong reason. Cleared here
  // rather than in that one test, so the next row that makes the same
  // assertion inherits the guarantee instead of rediscovering the need for it.
  vi.mocked(toast.warning).mockClear()
  FakeBridgeAdapter.nextDocumentIds = ["doc-a"]
  FakeBridgeAdapter.nextHandshakeError = null
  captured = null
  holdProposal = false
  heldProposal = null
  holdCatalog = false
  heldCatalog = null
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
      if (url.includes("/api/editor/catalog") && holdCatalog) {
        // Held. The test takes the page away and then answers, which is the
        // window the component-editor navigation lives in.
        return new Promise<Response>((resolve) => {
          heldCatalog = (body: unknown) =>
            resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            )
        })
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

  it("starts the new session at the new document's own ready, before `load` (round-1 item 1)", async () => {
    // THE WINDOW BETWEEN THE TWO. The bridge announces itself as soon as its
    // script runs, and the iframe's `load` event comes later. The adapter
    // adopted the new document id at the ready, so a capture made in that
    // window passed its document gate; the shell did not start the new session
    // until `load`, so that capture was stamped with the OLD session and the
    // handshake at `load` retired it. The designer was told an edit they had
    // just made on the page in front of them was discarded.
    await mount()
    const adapter = lastFakeAdapter()
    // The departing page is holding one buffered edit, so the boundary is
    // visible: the line below names what IT lost, and nothing else.
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    // The new document announces itself. No `load` event, and no re-render:
    // this is the same adapter, re-handshaking because it was told to.
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    // THE SESSION MOVED HERE. The one departed entry was retired at the ready.
    // That is the observable form of "the session's document is doc-b now":
    // the hook does not return its document id, and this is the same line the
    // boundary used to write at `load` time.
    await waitFor(() => expect(editing()?.saveStatus).toBe(DISCARDED_ONE))
    // An edit on the page that is now on screen.
    await act(async () => {
      adapter.emitCapture(capture("m2", "world"))
    })
    // And the late `load` for that same document, which is a duplicate
    // handshake and must cost the designer nothing.
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    // Unchanged: still the one line about the DEPARTED page's edit. Before the
    // fix this read "2 pending edits were discarded", the second of them being
    // the edit made on the page the designer was looking at.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    // And it is still a live buffered edit: it reaches the adapter as its own
    // write, on the session that owns it.
    const second = await waitForApply(1)
    const bundle = second.edit as unknown as { mutations: Mutation[] }
    expect(bundle.mutations.map((m) => m.id)).toEqual(["m2"])
  })

  it("keeps a capture posted in the SAME turn as the new page's ready (round-2 item 1)", async () => {
    // THE TIGHTEST VERSION OF THE WINDOW ABOVE, and the one the earlier fix
    // did not close. The bridge posts its READY and its first capture back to
    // back, so both are in the shell's queue before anything the shell does in
    // between can finish. The document-changed listener used to answer the
    // ready with a PING round trip and move the session boundary in that round
    // trip's `.then`; the capture arrived first and was buffered under the
    // DEPARTED session, and the boundary then retired it as discarded.
    //
    // No yield between the two emits below. That is the whole test: if the
    // boundary is not synchronous with the adapter adopting the id, there is
    // nowhere for it to run before the capture lands.
    await mount()
    const adapter = lastFakeAdapter()
    // One buffered edit on the departing page, so the discard line has
    // something to name and its COUNT is the assertion.
    await act(async () => {
      adapter.emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      // Same act, same microtask, no await between. The adapter has adopted
      // doc-b (its own contract, pinned in `adapters/bridge/index.test.ts`),
      // so this capture passes its document gate and reaches the shell.
      adapter.emitCapture(capture("m2", "world"))
      await Promise.resolve()
    })
    // The session is on doc-b, and the capture that arrived after the ready
    // belongs to it. The hook returns no document id, so the observable form
    // of "the boundary already moved" is the COUNT on the discard line: one,
    // the departed page's own edit, not two.
    await waitFor(() => expect(editing()?.saveStatus).toBe(DISCARDED_ONE))
    // And the late `load` handshake, which finds the same document and must
    // not re-count anything.
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    // The buffer's shadow: m2 is a live entry on the NEW session and reaches
    // the adapter as its own write. Before the fix it was retired at the
    // boundary and this apply never happened.
    const second = await waitForApply(1)
    const bundle = second.edit as unknown as { mutations: Mutation[] }
    expect(bundle.mutations.map((m) => m.id)).toEqual(["m2"])
  })

  it("writes the discard line again for a second page change (round-2 item 2)", async () => {
    // THE SAME SENTENCE, TWICE. Two page changes, one held draft each, and the
    // notice is word for word identical both times. The status line is a
    // string, so the second write is a React bail-out and every consumer keyed
    // on the text alone hears nothing. `saveStatusSeq` is what separates them:
    // it counts WRITES, so the same text written again is its own event.
    await mount()
    const baselineSeq = editing()!.saveStatusSeq
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    await waitForApply()
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      lastFakeAdapter().emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.saveStatus).toBe(DISCARDED_ONE))
    const firstSeq = editing()!.saveStatusSeq
    expect(firstSeq).toBeGreaterThan(baselineSeq)
    // A draft on the second page, so the third page's arrival discards exactly
    // one again and the line reads the same.
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m2", "world"))
    })
    await waitForApply(1)
    FakeBridgeAdapter.nextDocumentIds = ["doc-c"]
    await act(async () => {
      lastFakeAdapter().emitReady("doc-c")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()!.saveStatusSeq).toBeGreaterThan(firstSeq))
    // Same words, and that is the point: the text cannot tell the two notices
    // apart, so the sequence has to.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
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

  it("writes a class capture as a style rule and releases its preview (control)", async () => {
    // The class lane's control row, and until now the harness had none: every
    // test in this file drove the text lane. The two are one lane on the
    // session and two dispatches in the code, and the class one is the
    // asymmetric half. It awaits a destination BEFORE it can build its edit,
    // and it claims its in-flight marker across that await rather than testing
    // for one in front of it.
    //
    // What this row pins is the whole round trip on a page that never
    // changes: the capture is buffered, the debounce arms, the destination is
    // resolved, the write reaches the adapter as a `scoped-css-override` (not
    // the text lane's llm-patch), and the live class preview the bridge is
    // holding is released under the CAPTURE's id.
    await mount()
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitCapture(classCapture("c1", "p-2 p-4"))
    })
    const write = await waitForApply()
    // A CSS rule, not a source rewrite. This is the one assertion that tells
    // the two dispatches apart from outside the hook.
    expect(write.edit.kind).toBe("scoped-css-override")
    if (write.edit.kind !== "scoped-css-override") throw new Error("unreachable")
    // The rule head, parsed from the capture's own `sourceLoc`
    // ("src/App.vue:10:2"), not the destination the rule is written into.
    expect(write.edit.anchor).toMatchObject({
      file: "src/App.vue",
      line: 10,
      column: 2,
    })
    // The added class ("p-4") resolved to a real CSS declaration, not an
    // empty rule body.
    expect(Object.keys(write.edit.declarations ?? {}).length).toBeGreaterThan(0)
    // The session's lifetime rides along, so a page change can cancel it.
    expect(write.signal).toBeDefined()
    await act(async () => {
      write.settle(applied({ "src/App.vue": "v2" }))
      await Promise.resolve()
    })
    // Release-then-verify: the write landed, so the preview is released at
    // once. Under `c1`, the capture's own id, which is what the bridge
    // registered the override as. Resolving the dispatch's edit id instead
    // would be a silent no-op and the inline `!important` shim would outlive
    // the edit.
    await waitFor(() =>
      expect(adapter.settledOverrides).toEqual([
        { id: "c1", outcome: "confirmed" },
      ]),
    )
    expect(editing()?.saveStatus).toBeNull()
  })

  it("retires a class capture the page change caught in flight (finding V1, the class lane)", async () => {
    // V1 for the OTHER dispatch. The row above it covers the text lane; this
    // is the same boundary against the class lane, which has its own `ctx.step`
    // calls and its own resolve to get wrong.
    //
    // The write is out when the page is replaced. Three things follow: the
    // departed page's buffered entry is retired and COUNTED, so the designer
    // is told what was lost; the request is cancelled; and the answer, when it
    // arrives, does nothing at all. That last part is what `ctx.step` buys.
    // Without it the lane would run its release on the departed adapter, and
    // the bridge restarts its mutation ids on a new document, so "confirmed"
    // for `c1` would retire whatever the NEW page is calling `c1`.
    const { rerender } = await mount()
    const departed = lastFakeAdapter()
    await act(async () => {
      departed.emitCapture(classCapture("c1", "p-2 p-4"))
    })
    const write = await waitForApply()
    expect(write.edit.kind).toBe("scoped-css-override")
    await changeDocument(rerender, "doc-b")
    // One entry, one line, and it says how many.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    expect(write.signal?.aborted).toBe(true)
    const arriving = lastFakeAdapter()
    expect(arriving).not.toBe(departed)
    // The departed page's write answers now, on the far side of the boundary.
    await act(async () => {
      write.settle(applied({ "src/App.vue": "v2" }))
      await Promise.resolve()
    })
    // Nothing it says lands anywhere: not the status line the designer is
    // reading, not the departed page's previews, and not the new page at all.
    expect(editing()?.saveStatus).toBe(DISCARDED_ONE)
    expect(departed.settledOverrides).toEqual([])
    expect(arriving.settledOverrides).toEqual([])
    expect(arriving.applies).toEqual([])
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

  it("leaves the new page's edit alone when the departed page's write answers success (finding V2)", async () => {
    // WHAT MAKES THIS A SIGNAL. The page change retires the departed entry, so
    // settling the old write against an EMPTY buffer proves nothing: the
    // reconcile finds nothing either way. So the new document gets an entry
    // with the SAME identity first (same selector, same instance path, same
    // kind), which is what the designer typing in the same field on the new
    // page produces. The departed write's reconcile matches on that identity,
    // and without `ctx.step` narrowing `stale` first it acts on the new page's
    // entry: it drops it, or it rebases its `before` to the departed page's
    // value and re-arms the timer, which cancels the debounce that would have
    // written it.
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitCapture(capture("m1", "hello"))
    })
    const pending = await waitForApply()
    await changeDocument(rerender, "doc-b")
    const statusAfterReset = editing()?.saveStatus
    const arriving = lastFakeAdapter()
    // The same field, typed again on the page that replaced it.
    await act(async () => {
      arriving.emitCapture(capture("m1", "goodbye"))
    })
    await act(async () => {
      pending.settle(applied({ "src/App.vue": "v2" }))
      await Promise.resolve()
    })
    // No status of its own.
    expect(editing()?.saveStatus).toBe(statusAfterReset)
    // The new page's entry is still armed and still what the designer typed:
    // it reaches the arriving adapter untouched. `before` is the capture's own
    // "a", NOT the departed write's "hello" rebased onto it.
    const second = await waitForApply()
    const bundle = second.edit as unknown as { mutations: Mutation[] }
    expect(bundle.mutations).toHaveLength(1)
    expect(bundle.mutations[0]!.id).toBe("m1")
    expect(bundle.mutations[0]!.before).toBe("a")
    expect(bundle.mutations[0]!.after).toBe("goodbye")
    // And exactly one write reached the new document: the departed answer
    // neither wrote again nor re-armed anything of its own.
    expect(arriving.applies).toHaveLength(1)
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

  it("keeps a departed save's stream chunks out of the dialog (round-1 item 3)", async () => {
    // ONE REF, EVERY SAVE. The live text the save dialog renders accumulates
    // into `saveStreamingTextRef`, and the request that feeds it keeps
    // streaming for as long as the server takes, which can be past the page
    // change that ended this save's session. A chunk delivered afterwards used
    // to append to that shared ref and push it into state, so the departed
    // save's text appeared under the next save's dialog.
    const { rerender } = await mount()
    const departing = lastFakeAdapter()
    await act(async () => {
      departing.emitCapture(capture("m1", "hello"))
    })
    const typing = await waitForApply()
    await act(async () => {
      typing.settle(needsChat())
      await Promise.resolve()
    })
    const save = await startSave()
    const saveApply = await waitForApply(1)
    // THE CONTROL. While the page is still there, a chunk reaches the dialog.
    await act(async () => {
      saveApply.emitLLMStart()
      saveApply.emitLLMDelta("thinking")
    })
    await waitFor(() => expect(editing()?.saveStreamingText).toBe("thinking"))
    await changeDocument(rerender, "doc-b")
    // The same request, still streaming, now answering to nobody.
    await act(async () => {
      saveApply.emitLLMStart()
      saveApply.emitLLMDelta(" about a page that has gone")
      // Past the 33 ms flush cadence, so a chunk that WAS accepted would have
      // been pushed into state by now rather than merely being pending.
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    expect(editing()?.saveStreamingText).toBe("thinking")
    await act(async () => {
      saveApply.settle(applied())
      await save.settled
    })
    expect(save.outcome()?.ok).toBe(false)
    // Still untouched after the save reported the page change: neither the
    // late start nor the late delta rewrote the buffer behind it.
    expect(editing()?.saveStreamingText).toBe("thinking")
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

  it("hands the save's chat submission a signal the page change aborts (finding X1)", async () => {
    // The save-time hand-off is a POST that starts a chat turn, and a turn
    // accepted after the page has gone edits files for a document nobody is
    // looking at. The step that reads the answer cannot retract a turn that has
    // already been taken, so the session's own lifetime goes WITH the
    // submission and cancels it where it is.
    const escalateToChat = vi.fn(
      (_prompt: string, _options?: { signal?: AbortSignal }) =>
        new Promise<boolean>(() => {}),
    )
    const { rerender } = await mount({ escalateToChat })
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
    const signal = escalateToChat.mock.calls[0]?.[1]?.signal
    expect(signal).toBeDefined()
    // The control. Without it, a signal that arrived already aborted would pass
    // the assertion below and prove nothing.
    expect(signal?.aborted).toBe(false)
    await changeDocument(rerender, "doc-b")
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      await save.settled
    })
    expect(save.outcome()?.ok).toBe(false)
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

  it("keeps the text-branch lane's failure off the next page", async () => {
    // The lane the migration's task list missed. It is a page-bound source
    // write like the two above: the byte range in its edit was read off ONE
    // document's source, and it wrote the status bar after the apply returned
    // with no session between the two.
    //
    // Reachable from the harness because the hook returns the handler, which is
    // also how the inspector reaches it (`onEditTextBranch` in
    // `inspector-panel.tsx`). The selection only has to carry an `editTarget`,
    // which `styleSelection` does.
    const { rerender } = await mount()
    await act(async () => {
      lastFakeAdapter().emitSelection(styleSelection)
    })
    await waitFor(() =>
      expect(useEditorStore.getState().editorSelection).not.toBeNull(),
    )
    let done: Promise<void> | undefined
    await act(async () => {
      done = editing()!.handleEditTextBranch(
        {
          kind: "consequent",
          valueKind: "literal",
          value: "Yes",
          byteStart: 120,
          byteEnd: 125,
        },
        "No",
      )
      await Promise.resolve()
    })
    const write = await waitForApply()
    expect(write.edit.kind).toBe("text-branch")
    // The write carries the session's lifetime, so ending the session cancels
    // it rather than leaving it to answer into a page that has gone.
    expect(write.signal).toBeDefined()
    await changeDocument(rerender, "doc-b")
    expect(write.signal?.aborted).toBe(true)
    // The line the designer is actually reading once the page changed. It is
    // whatever the session end wrote, and the departed page's answer must not
    // replace it.
    const statusAfterChange = editing()?.saveStatus ?? null
    await act(async () => {
      // An abort arrives as an ordinary failure, which is exactly the shape
      // that used to be reported as "Conditional text edit failed".
      write.fail("edit request cancelled")
      await done
    })
    expect(editing()?.saveStatus).toBe(statusAfterChange)
    expect(editing()?.saveStatus ?? "").not.toContain("Conditional text edit failed")
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

  it("does not warn about a token edit whose page went away before verification settled (finding C5)", async () => {
    // The write LANDS, and the page changes while the verification that
    // follows it is still reading. That read is taken against the document
    // that replaced this one, whose stylesheets never carried this token, so
    // it reports a cascade loss. Warning the designer about it would be
    // telling them an edit failed on a page they are no longer looking at.
    //
    // Verification is off on this fixture by default, because the hook opts
    // out on an adapter that cannot read and every other test here relies on
    // that. This one turns it on.
    FakeBridgeAdapter.verificationEnabled = true
    const { rerender } = await mount()
    // The adapter this edit is written through, held by hand: `changeDocument`
    // builds a NEW one, and the parked cascade read belongs to this one.
    const adapter = lastFakeAdapter()
    await act(async () => {
      adapter.emitSelection(styleSelection)
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
    const editId = write.edit.id
    await act(async () => {
      write.settle(applied())
      await done
    })
    // The verification is now running. Its first cascade read parks, which is
    // what puts the page change inside the window rather than racing it.
    await waitFor(() => expect(adapter.provenanceReads.length).toBeGreaterThan(0), {
      timeout: 5000,
    })
    await changeDocument(rerender, "doc-b")
    // The read answers now, and it answers that some other rule owns the
    // property: the token this edit patched is nowhere in the chain.
    adapter.settleProvenance({
      "background-color": {
        property: "background-color",
        computedValue: "rgb(255, 255, 255)",
        winningRule: {
          selector: ".other-page-card",
          stylesheet: { href: "/src/other.css" },
          declaration: "background-color: #ffffff",
          specificity: [0, 1, 0],
        },
        varChain: [],
      },
    })
    const recordFor = () =>
      useEditorStore.getState().verifications.find((v) => v.editId === editId)
    await waitFor(() => expect(recordFor()?.phase).toBe("done"), { timeout: 15000 })
    // The verification really did fail. The Checks tab keeps saying so: what
    // the session guard suppresses is the interruption, not the record.
    expect(recordFor()?.result?.status).toBe("fail")
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
  }, 30000)
  it("does not re-select on the page that replaced the one it was scheduled for (finding C6)", async () => {
    // After our own write lands, the open selection still carries the
    // pre-write stamp, so the shell re-reads it from the post-HMR DOM. Those
    // retries used to be bare `setTimeout` calls that read the adapter when
    // they fired. A refresh armed on one page could therefore run after the
    // page had been replaced and re-select the SAME selector on the new one,
    // rebuilding the inspector around another document's element.
    //
    // The selection is emitted again on the new page on purpose. The effect
    // cleanup clears it, and with no live selection carrying that selector the
    // old code returns early, so the bug could not be staged at all.
    //
    // `shouldAdvanceTime` is required, not a preference: `waitFor` only drives
    // a fake clock itself when a global `jest` exists, and under Vitest it
    // does not, so a frozen clock hangs every wait in this file forever.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { rerender } = await mount()
      const departed = lastFakeAdapter()
      await act(async () => {
        departed.emitSelection(styleSelection)
      })
      await waitFor(() =>
        expect(useEditorStore.getState().editorSelection).not.toBeNull(),
      )
      await act(async () => {
        departed.emitCapture(capture("m1", "hello"))
      })
      const typing = await waitForApply()
      await act(async () => {
        // The write lands and names the selected element's file, which is what
        // arms the refresh.
        typing.settle(applied({ "src/App.vue": "hash-2" }))
        await Promise.resolve()
        await Promise.resolve()
      })
      const armedAt = Date.now()
      await changeDocument(rerender, "doc-b")
      // Nothing has fired YET, and this line owes nothing to the clock: the
      // first retry is 300 ms out and the boundary is the only thing that has
      // happened. Without it, a run in which the retry had already fired
      // before the page change would still satisfy the assertions at the end,
      // because those count calls made after the boundary and this one is the
      // proof there were none before it.
      expect(departed.selectBySelectorCalls).toEqual([])
      const arrived = lastFakeAdapter()
      expect(arrived).not.toBe(departed)
      await act(async () => {
        arrived.emitSelection(styleSelection)
        await Promise.resolve()
      })
      // The control. It says the page change really did land inside the first
      // retry's window; without it a slow step here would let the retry fire
      // before the boundary and the assertions below would prove nothing.
      expect(Date.now() - armedAt).toBeLessThan(300)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(arrived.selectBySelectorCalls).toEqual([])
      expect(departed.selectBySelectorCalls).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not install a selection read that settles after the page changed (codex C-D)", async () => {
    // The read is PARKED across the boundary, which is the shape the finding
    // names: `selectBySelector` used to apply its reply to the adapter's own
    // selection and notify the shell INSIDE the awaited request, before the
    // calling lane's `ctx.step` could say the answer was stale. The adapter
    // now drops a reply from a departed document; this row is the hook's half
    // of it, and it is the only place a settle can be put on the far side of
    // a page change.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    FakeBridgeAdapter.parkSelectBySelector = true
    try {
      const { rerender } = await mount()
      const departed = lastFakeAdapter()
      await act(async () => {
        departed.emitSelection(styleSelection)
      })
      await waitFor(() =>
        expect(useEditorStore.getState().editorSelection).not.toBeNull(),
      )
      await act(async () => {
        departed.emitCapture(capture("m1", "hello"))
      })
      const typing = await waitForApply()
      await act(async () => {
        // The write lands and names the selected element's file, which arms
        // the refresh.
        typing.settle(applied({ "src/App.vue": "hash-2" }))
        await Promise.resolve()
        await Promise.resolve()
      })
      // Let the first retry fire. It parks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(departed.parkedSelectReads).toHaveLength(1)

      await changeDocument(rerender, "doc-b")
      const arrived = lastFakeAdapter()
      expect(arrived).not.toBe(departed)

      // The departed page finally answers, with its own element.
      await act(async () => {
        departed.parkedSelectReads[0]!.settle(styleSelection)
        await Promise.resolve()
        await Promise.resolve()
      })

      // Nothing was installed. The store is where the boundary left it, and
      // the retry chain did not carry on onto the page that arrived.
      expect(useEditorStore.getState().editorSelection).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      expect(arrived.selectBySelectorCalls).toEqual([])
      expect(departed.selectBySelectorCalls).toEqual(["#panel"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("a late selection from the departed page cannot become what an edit aims at", async () => {
    // The hand-off case. `editorSelection.editTarget` is the file, line and
    // column an edit writes to, so a selection installed from the page that
    // left would aim the next edit at the departed page's file.
    const { rerender } = await mount()
    const departed = lastFakeAdapter()
    await act(async () => {
      departed.emitSelection(styleSelection)
    })
    await waitFor(() =>
      expect(useEditorStore.getState().editorSelection).not.toBeNull(),
    )

    await changeDocument(rerender, "doc-b")
    const arrived = lastFakeAdapter()

    // The departed page announces its element again, after the boundary.
    await act(async () => {
      departed.emitSelection(styleSelection)
      await Promise.resolve()
    })
    expect(useEditorStore.getState().editorSelection).toBeNull()

    // And an edit attempted now aims at nothing, rather than at
    // `src/App.vue:10:2` on a page nobody is looking at.
    await act(async () => {
      editing()!.handlePropEdit("label", "Renamed")
      await Promise.resolve()
    })
    expect(arrived.applies).toEqual([])
    expect(departed.applies).toHaveLength(0)
  })

  /**
   * The Layers ("Structure") tree, for the two rows below.
   *
   * Not a `.vue` file: `collectVueFiles` finds nothing in it, so the refresh
   * makes no second round trip for conditional groups. These rows are about
   * the structure read itself.
   */
  const outlineNode = (id: string, file: string): OutlineNode => ({
    id,
    name: id,
    type: "component",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    selector: `#${id}`,
    componentFile: file,
    authoredAt: { file, line: 1, column: 0 },
    editTarget: { file, line: 1, column: 0 },
  })

  it("cannot install a Layers tree that answers after the page it describes went away (read continuation)", async () => {
    // THE READ SIDE OF THE BOUNDARY. Every write lane goes through the
    // session. The Layers refresh is a READ, and it did not: its
    // `getStructure()` can still be out when the page is replaced, and what it
    // answers with is the DEPARTED page's tree. Every row in that tree carries
    // `authoredAt` and `editTarget`, which is where a Layers right-click
    // Delete writes, so installing it offers the designer rows that aim at
    // another page's files.
    //
    // THE NEW PAGE NEVER HANDSHAKES HERE, and that is what makes this the
    // session's case rather than the refresh counter's. `layersGenerationRef`
    // asks "did a newer refresh start". A newer refresh starts at the new
    // page's handshake, so while that handshake is still out (or, as here,
    // never completes at all) the counter says the departed page's read is
    // still the current one. The session says otherwise.
    FakeBridgeAdapter.parkGetStructure = true
    const pageA = outlineNode("page-a-root", "src/PageA.tsx")
    const pageAAgain = outlineNode("page-a-root-again", "src/PageA.tsx")

    await mount()
    const adapter = lastFakeAdapter()
    // The first refresh fires right behind the handshake, and it answers on
    // its own page: the control half of this row.
    await waitFor(() => expect(adapter.structureReads).toHaveLength(1))
    await act(async () => {
      adapter.structureReads[0]!.settle([pageA])
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()!.layersRawRoots).toHaveLength(1))

    // A second read, still out when the page goes.
    await act(async () => {
      void editing()!.refreshLayers()
      await Promise.resolve()
    })
    expect(adapter.structureReads).toHaveLength(2)

    // The page is replaced and the new one never answers: off-origin, a 500,
    // or the handshake timeout. The session ends either way, and there is no
    // new page to refresh for.
    FakeBridgeAdapter.nextHandshakeError = "the page never answered"
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("error"))
    // The tree page A had legitimately installed went with the page.
    expect(editing()!.layersRawRoots).toBeNull()

    // And now page A's late answer arrives.
    await act(async () => {
      adapter.structureReads[1]!.settle([pageAAgain])
      await Promise.resolve()
    })
    expect(editing()!.layersRawRoots).toBeNull()
    expect(editing()!.layersRoots).toBeNull()
  })

  it("asks the new page for its own Layers tree, once, and a delete aims there", async () => {
    // The other half. Clearing the departed page's tree is only right if the
    // page that replaced it gets asked for its own, and the refresh used to
    // run for the FIRST adapter only: a document change on the same adapter
    // left the panel with whatever the tree update happened to bring.
    //
    // ONCE is half the assertion. One page change produces up to three
    // completed handshakes (the unsolicited ready, the handshake it triggers,
    // and the `load` event that follows), and each of them reaches the place
    // that issues this request.
    FakeBridgeAdapter.parkGetStructure = true
    const pageA = outlineNode("page-a-root", "src/PageA.tsx")
    const pageB = outlineNode("page-b-root", "src/PageB.tsx")

    await mount()
    const adapter = lastFakeAdapter()
    await waitFor(() => expect(adapter.structureReads).toHaveLength(1))
    await act(async () => {
      adapter.structureReads[0]!.settle([pageA])
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()!.layersRawRoots).toHaveLength(1))

    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    // Page A's tree is gone, and page B has been asked for its own.
    expect(editing()!.layersRawRoots).toBeNull()
    await waitFor(() => expect(adapter.structureReads).toHaveLength(2))

    // The `load` event for that same document is a duplicate handshake and
    // must not ask again.
    const iframe = screen.getByTitle("Prototype")
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    expect(adapter.structureReads).toHaveLength(2)

    await act(async () => {
      adapter.structureReads[1]!.settle([pageB])
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()!.layersRawRoots).toHaveLength(1))
    expect(editing()!.layersRawRoots![0]!.id).toBe("page-b-root")

    // And the delete the panel can dispatch now aims at page B's file.
    await act(async () => {
      editing()!.handleLayerDelete(editing()!.layersRoots![0]!)
      await Promise.resolve()
    })
    expect(adapter.applies).toHaveLength(1)
    const dispatched = adapter.applies[0]!.edit as {
      target: { editTarget?: { file: string } }
    }
    expect(dispatched.target.editTarget?.file).toBe("src/PageB.tsx")
  })

  it("re-selects once on its own page and stops when the stamp has moved", async () => {
    // The control for the test above, on a page that never changed: the
    // refresh has to still happen, and it has to stop as soon as the file hash
    // it reads back differs from the one the selection was carrying.
    //
    // THE SELECTION CARRIES A HASH, and that is the point of this row rather
    // than an incidental detail. The shared `styleSelection` has none, so
    // `priorHash` is undefined and `freshHash !== priorHash` is true of every
    // truthy hash: the chain would stop on the first answer whatever it said,
    // and a comparison that had been reduced to "is there a hash at all" would
    // pass this test. So the selection is stamped `hash-1` here, the first
    // read answers `hash-1` (unchanged, so the chain must go on) and the
    // second answers `hash-2` (re-stamped, so it must stop). Two reads: one
    // for each side of the comparison.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      const adapter = lastFakeAdapter()
      // Local to this test. The shared fixture stays hash-free, because every
      // other row here is about something else.
      const stampedSelection: Selection = {
        ...styleSelection,
        editTarget: { ...styleSelection.editTarget!, fileHash: "hash-1" },
      }
      const reStamped = (fileHash: string): Selection => ({
        ...stampedSelection,
        editTarget: { ...stampedSelection.editTarget!, fileHash },
      })
      // What the two re-reads answer, in order: the same stamp, then a moved
      // one.
      adapter.selectBySelectorAnswers.push(reStamped("hash-1"), reStamped("hash-2"))
      await act(async () => {
        adapter.emitSelection(stampedSelection)
      })
      await waitFor(() =>
        expect(useEditorStore.getState().editorSelection).not.toBeNull(),
      )
      await act(async () => {
        adapter.emitCapture(capture("m1", "hello"))
      })
      const typing = await waitForApply()
      await act(async () => {
        typing.settle(applied({ "src/App.vue": "hash-2" }))
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      // The first read, and its answer carries the hash the selection already
      // had, so the chain is not finished.
      expect(adapter.selectBySelectorCalls).toEqual(["#panel"])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      // The second read fired at 800 ms and answered a MOVED stamp, so the
      // chain stopped there: no third read at 1600 ms.
      expect(adapter.selectBySelectorCalls).toEqual(["#panel", "#panel"])
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * THE SELECTION LISTENER'S OWN CONTINUATIONS, for the three rows below.
   *
   * Clicking an element starts a manifest lookup, and what comes back decides
   * which controls the inspector offers and which schema a prop edit is
   * written against. The lookup used to be correlated by SELECTOR TEXT alone:
   * if the selector the answer was asked for still matched the selector on
   * screen, the answer was installed. `#panel` on one page and `#panel` on the
   * next are the same string and a different element, so the departed page's
   * manifest could become the controls for the arriving page's element.
   */

  it("cannot install a manifest that answers after the page it was asked on went away", async () => {
    // Page A's `#panel` and page B's `#panel` are the same eight characters.
    const source = new ParkedManifestSource()
    render(<Harness manifestSource={source} />)
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    const adapter = lastFakeAdapter()

    // Page A: the designer clicks `#panel`, and the lookup for its component
    // is still out.
    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "OldCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(1))
    expect(source.lookups[0]!.name).toBe("OldCard")

    // The page is replaced, on the same adapter: an in-iframe navigation,
    // which is the case a rerender would not stage.
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))

    // The page change took the selection with it, and the manifest with the
    // selection. The adapter discards the departed page's selection and tells
    // the selection listeners `null` BEFORE it announces the new document, and
    // the listener's null branch nulls the manifest. So the window this row is
    // about opens with nothing installed rather than with page A's manifest
    // still on screen.
    expect(installedManifest()).toBeNull()

    // Page B has its own `#panel`, and its own component behind it.
    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "NewCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(2))
    await act(async () => {
      source.lookups[1]!.settle(manifestNamed("NewCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(installedManifest()?.name).toBe("NewCard"))

    // And now page A's lookup answers.
    await act(async () => {
      source.lookups[0]!.settle(manifestNamed("OldCard"))
      await Promise.resolve()
    })
    expect(installedManifest()?.name).toBe("NewCard")
  })

  it("cannot install a manifest for a selection another selection replaced", async () => {
    // ONE PAGE, ONE SELECTOR, TWO SELECTIONS. The designer clicks `#panel`,
    // deselects, and clicks `#panel` again, which by then is a different
    // element behind the same eight characters (an in-page re-render, a table
    // row swapped, a tab switched). The first click's lookup answers last.
    //
    // This row used to click `#a` and then `#b`, and it could not fail: two
    // selectors differ, so the pre-existing `latestSelector` comparison
    // rejected the late answer before the sequence was ever consulted. It
    // asserted a value that was already safe. With one selector the session
    // has not moved and the selector matches, so `seq` is the only thing
    // standing between the departed click's answer and the inspector.
    const source = new ParkedManifestSource()
    render(<Harness manifestSource={source} />)
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    const adapter = lastFakeAdapter()

    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "CardA"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(1))
    expect(source.lookups[0]!.name).toBe("CardA")

    // The deselection. It takes a sequence number of its own, which is what
    // makes the click after it a new selection rather than the same one.
    await act(async () => {
      adapter.emitSelection(null)
      await Promise.resolve()
    })
    await waitFor(() => expect(installedManifest()).toBeNull())

    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "CardB"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(2))
    expect(source.lookups[1]!.name).toBe("CardB")
    await act(async () => {
      source.lookups[1]!.settle(manifestNamed("CardB"))
      await Promise.resolve()
    })
    await waitFor(() => expect(installedManifest()?.name).toBe("CardB"))

    // The first click's lookup answers last. `CardB` is what is selected, and
    // `CardB` is what the inspector must still be describing.
    await act(async () => {
      source.lookups[0]!.settle(manifestNamed("CardA"))
      await Promise.resolve()
    })
    expect(installedManifest()?.name).toBe("CardB")
  })

  it("cannot install a manifest from before a page the session never adopted", async () => {
    // THE ROW THE SEQUENCE IS THE ONLY LOCK FOR. The bump that makes it so is
    // the DESELECT's, not `enterDocument`'s: the adapter discards the departed
    // page's selection first, and the selection listener takes a number for
    // that null exactly as it does for a click. `enterDocument` bumps too, and
    // it would cover this row on its own, but it is the second bump and not
    // the one that does the work here.
    //
    // The other two rows have a second lock behind the sequence: the session
    // generation moves when a page is replaced, and the selector on screen
    // differs. This one has neither.
    //
    // A page announces itself and then never handshakes (off-origin, a 500,
    // the five-second timeout). The session ends there and FORGETS its
    // document, which is what stops every continuation from the page before
    // it. The page that failed is not on screen, so the page that is still
    // there goes on emitting selections, and one of those starts a lookup.
    // When a page finally does arrive, the session had no document to compare
    // against, so it adopts the new one WITHOUT ending anything: the
    // generation does not move. Same selector, same live session, and only the
    // sequence knows the page underneath changed.
    const source = new ParkedManifestSource()
    render(<Harness manifestSource={source} />)
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))
    const adapter = lastFakeAdapter()

    FakeBridgeAdapter.nextHandshakeError = "the page never answered"
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("error"))

    // The page still on screen announces its `#panel`.
    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "OldCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(1))

    // A page arrives and handshakes. The session had no document, so nothing
    // ends here.
    FakeBridgeAdapter.nextDocumentIds = ["doc-c"]
    await act(async () => {
      adapter.emitReady("doc-c")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))

    // Its own `#panel`, and its own component.
    await act(async () => {
      adapter.emitSelection(componentSelection("#panel", "NewCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(source.lookups).toHaveLength(2))
    await act(async () => {
      source.lookups[1]!.settle(manifestNamed("NewCard"))
      await Promise.resolve()
    })
    await waitFor(() => expect(installedManifest()?.name).toBe("NewCard"))

    await act(async () => {
      source.lookups[0]!.settle(manifestNamed("OldCard"))
      await Promise.resolve()
    })
    expect(installedManifest()?.name).toBe("NewCard")
  })
  it("cannot open the component editor for a page that left while the catalog was out", async () => {
    // THE READ IS THE CATALOG AND THE CONTINUATION IS A NAVIGATION, which is
    // why the catalog being repo data rather than page data was not enough on
    // its own. `handleEditComponent` reads the iframe url BEFORE the fetch,
    // and past the fetch it does two things with it: it navigates the iframe
    // to `/__compose/component/...` on that url's origin, and it stores the
    // url as the `returnUrl` the Exit button goes back to.
    //
    // So a page change inside the fetch took the page that ARRIVED and sent
    // it to the departed page's component route, with a return url aimed at a
    // page that had already gone. The designer clicked "Edit component" on one
    // page and got another page's component, then Exit put them somewhere
    // else again.
    holdCatalog = true
    await mount()
    const adapter = lastFakeAdapter()
    const iframe = screen.getByTitle("Prototype") as HTMLIFrameElement
    const srcBefore = iframe.src

    await act(async () => {
      adapter.emitSelection({
        ...componentSelection("#panel", "OldCard"),
        // A first-party file, so the isolation route HAS a usable import spec.
        // Without one the handler bails before it navigates, and the row would
        // pass whether the guard was there or not.
        componentFile: "src/OldCard.vue",
      })
      await Promise.resolve()
    })
    await act(async () => {
      void editing()!.handleEditComponent()
      await Promise.resolve()
    })
    expect(
      requests.filter((request) => request.url.includes("/api/editor/catalog")),
    ).toHaveLength(1)

    // The page is replaced while the catalog GET is still out.
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))

    // And the catalog answers, with a row that matches the departed page's
    // selection exactly.
    await act(async () => {
      answerCatalog([{ name: "OldCard", file: "src/OldCard.vue" }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(iframe.src).toBe(srcBefore)
    expect(editing()!.componentEditState).toBeNull()
  })

  it("clears the Layers tree for the conflict reload too, before the reloaded page answers", async () => {
    // THE END THAT FORGETS ITS DOCUMENT. The clear used to run under
    // `shouldEndSessionOnHandshake`, which asks whether the session's previous
    // document differs from this one. It answers false when there IS no
    // previous document, and `handleReloadAfterConflict` ends the session with
    // reason "reload", which retires the buffers and forgets the document.
    //
    // So the reloaded page's handshake found `previous === null`, skipped the
    // clear, and left the PRE-RELOAD tree on screen. Every row in it carries
    // the coordinates a right-click Delete writes to, and it stayed clickable
    // until the reloaded page answered its own structure read.
    FakeBridgeAdapter.parkGetStructure = true
    const pageA = outlineNode("page-a-root", "src/PageA.tsx")

    await mount()
    const adapter = lastFakeAdapter()
    await waitFor(() => expect(adapter.structureReads).toHaveLength(1))
    await act(async () => {
      adapter.structureReads[0]!.settle([pageA])
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()!.layersRawRoots).toHaveLength(1))

    await act(async () => {
      editing()!.handleReloadAfterConflict()
      await Promise.resolve()
    })

    // The reloaded page announces itself. A reloaded bridge is a fresh
    // instance with a document id of its own.
    FakeBridgeAdapter.nextDocumentIds = ["doc-b"]
    await act(async () => {
      adapter.emitReady("doc-b")
      await Promise.resolve()
    })
    await waitFor(() => expect(editing()?.status.kind).toBe("ready"))

    // Asked for its own tree, and it has not answered yet. That window is the
    // whole row: the panel must be empty in it, not holding page A's rows.
    await waitFor(() => expect(adapter.structureReads).toHaveLength(2))
    expect(editing()!.layersRawRoots).toBeNull()
    expect(editing()!.layersRoots).toBeNull()
  })

  it("cannot install a multi-select that answers after the designer clicked something else", async () => {
    // THE PAGE NEVER MOVES HERE, and that is what makes this the sequence's
    // case rather than the session's. `handleSelectMany` resolves each
    // selector through the adapter, and the designer can click a single
    // element while that read is out. The store write is what makes a late
    // answer harmful: `setEditorSelectionMany` also pins the primary
    // `editorSelection`, so the multi read would replace the click that
    // superseded it, and the next edit would aim at the element it named.
    FakeBridgeAdapter.parkSelectMany = true
    await mount()
    const adapter = lastFakeAdapter()

    const fromTheMultiRead = componentSelection("#row-1", "RowA")
    const theLaterClick = componentSelection("#header", "Header")

    await act(async () => {
      void editing()!.handleSelectMany(["#row-1", "#row-2"])
      await Promise.resolve()
    })
    expect(adapter.parkedSelectManyReads).toHaveLength(1)

    await act(async () => {
      adapter.emitSelection(theLaterClick)
      await Promise.resolve()
    })
    expect(useEditorStore.getState().editorSelection?.selector).toBe("#header")

    // And the multi read answers last.
    await act(async () => {
      adapter.parkedSelectManyReads[0]!.settle([fromTheMultiRead])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useEditorStore.getState().editorSelection?.selector).toBe("#header")
    expect(useEditorStore.getState().editorSelectionMany).toEqual([])
  })
})
