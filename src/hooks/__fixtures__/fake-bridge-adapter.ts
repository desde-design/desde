/**
 * A `BridgeFrameworkAdapter` the tests drive by hand.
 *
 * The real adapter is a postMessage state machine, and the hook-level questions
 * this exists for are about TIMING: an apply that is still out when the page
 * changes, a handshake that reports another document, a capture that arrives
 * after the boundary. Those are hard to stage through postMessage and trivial
 * here: `applyEdit` parks its promise until the test settles it, and the
 * handshake resolves with whatever document id the test queued.
 *
 * Under `__fixtures__/`, which knip ignores.
 */
import type {
  AdapterSubscription,
  ApplyEditOpts,
  DisambiguationChoice,
  DragMoveRequest,
  EditResult,
  FrameworkAdapter,
  InsertAtPointRequest,
  Mutation,
  OverridePreviewFailure,
  PendingMutation,
  ResizeRequest,
  Selection,
  StructuralEdit,
} from "@/editor/core"
import type { FrameworkId } from "@/editor/core/manifest"
import type { OutlineNode, StyleOrigin } from "@/types/bridge"

export interface RecordedApply {
  edit: StructuralEdit
  signal: AbortSignal | undefined
  settle: (result: EditResult) => void
  fail: (reason: string) => void
  /**
   * The live-stream callbacks this request was handed, so a test can deliver a
   * chunk itself.
   *
   * The server streams the LLM's answer while the request is open, and the
   * page can be replaced in the middle of that. There is no other way to stage
   * a chunk arriving after the boundary: the transport is stubbed out here, so
   * nothing else would ever call these.
   */
  emitLLMStart: (info?: { model: string; mutationCount: number }) => void
  emitLLMDelta: (delta: string) => void
}

/**
 * One cascade read the verification lane asked for, parked until the test
 * answers it.
 *
 * The point of parking it is ordering: a verification settles up to three
 * seconds after the write, and the question the session guard exists for is
 * what happens when the page is replaced INSIDE that window. Holding the read
 * lets a test put the page change exactly there instead of racing it.
 */
export interface RecordedProvenanceRead {
  selector: string
  properties: readonly string[]
  settle: (origins: Record<string, StyleOrigin> | null) => void
}

type Listener<T> = (value: T) => void

const instances: FakeBridgeAdapter[] = []

export function fakeAdapters(): FakeBridgeAdapter[] {
  return instances
}

export function lastFakeAdapter(): FakeBridgeAdapter {
  const adapter = instances[instances.length - 1]
  if (!adapter) throw new Error("no FakeBridgeAdapter has been constructed yet")
  return adapter
}

export function resetFakeAdapters(): void {
  instances.length = 0
  // A static that is not reset here leaks into the next test, and this one
  // decides whether verification runs at all.
  FakeBridgeAdapter.verificationEnabled = false
  FakeBridgeAdapter.parkSelectBySelector = false
  FakeBridgeAdapter.parkSelectMany = false
  FakeBridgeAdapter.parkGetStructure = false
}

/**
 * `implements FrameworkAdapter` on purpose: it is what makes the compiler list
 * the members the hook can reach, instead of you guessing at the no-op block
 * below. Keep the clause.
 *
 * The hook holds its adapter as a `BridgeFrameworkAdapter`, which is a wider
 * type than this interface: the live-preview pokes (`applyPropOverride`,
 * `setElementText`, `clearClassOverrides`, ...) are class members and appear in
 * no interface at all. They are implemented below as no-ops, and the mock
 * factory in the test file is where the two types are reconciled, with the
 * reason written there.
 */
export class FakeBridgeAdapter implements FrameworkAdapter {
  /** Document ids the next handshakes report, in order. */
  static nextDocumentIds: string[] = ["doc-a"]
  /** Set to reject the next `init()` with this message. */
  static nextHandshakeError: string | null = null
  /**
   * Does this adapter claim the bridge reads verification needs?
   *
   * OFF by default, which is the shape every test written before this one was
   * built against: `useEditVerification` opts out silently on an adapter that
   * cannot read, so no verification runs and no toast can fire. A test that
   * wants the verification lane turns it on, and `resetFakeAdapters` turns it
   * back off.
   */
  static verificationEnabled = false
  /**
   * Hold every `selectBySelector` open until the test settles it.
   *
   * OFF by default: every test written before this one expects the read to
   * answer at once. `resetFakeAdapters` turns it back off.
   */
  static parkSelectBySelector = false
  /**
   * Hold every `selectMany` open until the test settles it.
   *
   * OFF by default, and the unparked answer stays the empty list every test
   * before this one was built against. `resetFakeAdapters` turns it back off.
   */
  static parkSelectMany = false
  /**
   * Hold every `getStructure` open until the test settles it.
   *
   * OFF by default: every test written before this one expects the Layers
   * read to answer at once. It is parkable for the same reason `applyEdit`
   * is: the question is what happens when the page is replaced while the read
   * is still out. `resetFakeAdapters` turns it back off.
   */
  static parkGetStructure = false

  readonly framework: FrameworkId = "vue3"

  documentId: string | null = null
  disposed = false
  readonly applies: RecordedApply[] = []
  /**
   * How many times the shell asked this adapter to drop its live previews.
   *
   * A save does it at the very end, once every write has landed, so it is the
   * cheapest proof available here that a save ran to COMPLETION rather than
   * stopping at the step where the page changed. Nothing else the tail of a
   * save does is visible from outside the hook: the buffer it empties has
   * already been retired by the page change, and the reload it asks for goes
   * to the iframe rather than to an adapter.
   */
  clearedOverrides = 0
  /**
   * Every live preview this adapter was told the outcome of, in order.
   *
   * The save resolves each mutation in the bundle the moment its write lands,
   * which is BEFORE it resolves a destination stylesheet for the scoped-CSS
   * flush. It is therefore the one observable that sits between the save's
   * first await and its second, and the only way a test can tell "the save
   * stopped at the first step" from "the save carried on and was stopped at
   * the second".
   */
  readonly settledOverrides: { id: string; outcome: string }[] = []
  readonly resolvedDrafts: { pendingId: string; choice: string }[] = []
  readonly structure: OutlineNode[] = []
  /** Cascade reads still waiting for the test to answer them. */
  readonly provenanceReads: RecordedProvenanceRead[] = []
  /**
   * The standing answer every later cascade read gets, once the test has given
   * one. The verification lane POLLS: it re-reads every 100 ms until the
   * cascade is won or the budget runs out, so parking every read would stall
   * the run forever rather than let it reach a verdict.
   */
  private provenanceAnswer: Record<string, StyleOrigin> | null | undefined

  private readonly selectionListeners = new Set<Listener<Selection | null>>()
  private readonly captureListeners = new Set<Listener<Mutation>>()
  private readonly awaitingListeners = new Set<Listener<PendingMutation>>()
  private readonly treeListeners = new Set<() => void>()
  private readonly documentChangedListeners = new Set<Listener<string>>()

  constructor() {
    instances.push(this)
  }

  async init(): Promise<void> {
    if (FakeBridgeAdapter.nextHandshakeError !== null) {
      const message = FakeBridgeAdapter.nextHandshakeError
      FakeBridgeAdapter.nextHandshakeError = null
      throw new Error(message)
    }
    this.documentId =
      FakeBridgeAdapter.nextDocumentIds.length > 1
        ? (FakeBridgeAdapter.nextDocumentIds.shift() as string)
        : (FakeBridgeAdapter.nextDocumentIds[0] ?? "doc-a")
  }

  get bridgeDocumentId(): string | null {
    return this.documentId
  }

  /** The apply parks until the test settles it. */
  applyEdit(edit: StructuralEdit, opts?: ApplyEditOpts): Promise<EditResult> {
    return new Promise<EditResult>((resolve) => {
      this.applies.push({
        edit,
        signal: opts?.signal,
        settle: resolve,
        fail: (reason) => resolve({ kind: "failed", reason }),
        emitLLMStart: (info) =>
          opts?.onLLMStreamStart?.(info ?? { model: "test-model", mutationCount: 1 }),
        emitLLMDelta: (delta) => opts?.onLLMStreamDelta?.(delta),
        // `applied` results are built by the test with its own helper, which
        // fills in `appliedEditId` and `affectedTargetIds`; both are required.
      })
    })
  }

  onSelectionChange(listener: Listener<Selection | null>): AdapterSubscription {
    this.selectionListeners.add(listener)
    return () => {
      this.selectionListeners.delete(listener)
    }
  }

  onMutationCaptured(listener: Listener<Mutation>): AdapterSubscription {
    this.captureListeners.add(listener)
    return () => {
      this.captureListeners.delete(listener)
    }
  }

  onMutationAwaitingDisambiguation(
    listener: Listener<PendingMutation>,
  ): AdapterSubscription {
    this.awaitingListeners.add(listener)
    return () => {
      this.awaitingListeners.delete(listener)
    }
  }

  onTreeUpdate(listener: () => void): AdapterSubscription {
    this.treeListeners.add(listener)
    return () => {
      this.treeListeners.delete(listener)
    }
  }

  /**
   * The shell hearing that a DIFFERENT document announced itself, without the
   * shell having asked for a handshake.
   *
   * Not on `FrameworkAdapter`: it is a `BridgeFrameworkAdapter` member, like
   * the live-preview pokes below. This fixture does not run the real adapter's
   * postMessage router at all, so what it models is the CONTRACT the hook is
   * wired to: adopt the new id, then tell the shell. That the real adapter
   * emits exactly there, once, and not during a handshake it asked for, is
   * covered by `src/editor/adapters/bridge/index.test.ts`.
   */
  onDocumentChanged(listener: Listener<string>): AdapterSubscription {
    this.documentChangedListeners.add(listener)
    return () => {
      this.documentChangedListeners.delete(listener)
    }
  }

  /** Test drivers. */
  emitCapture(mutation: Mutation): void {
    for (const listener of this.captureListeners) listener(mutation)
  }

  emitAwaiting(pending: PendingMutation): void {
    for (const listener of this.awaitingListeners) listener(pending)
  }

  emitSelection(selection: Selection | null): void {
    for (const listener of this.selectionListeners) listener(selection)
  }

  emitTreeUpdate(): void {
    for (const listener of this.treeListeners) listener()
  }

  /**
   * An UNSOLICITED bridge ready from `documentId`, i.e. the new page
   * announcing itself before the iframe's `load` event.
   *
   * Same order as the real adapter's `handleBridgeReady`, in four steps:
   *
   * 1. The id is adopted first, so a listener that re-handshakes reads the NEW
   *    document.
   * 2. Every parked selection read settles, with `null` for a single read and
   *    the empty list for a multi read. That is the first half of
   *    `discardSelectionFromDepartedDocument`: the page it is talking to
   *    cannot answer the departed page's question, so the read settles the
   *    way an unresolved selector already settles. BEFORE the listeners, in
   *    that method and here, because a lane woken by a listener must not find
   *    a read from the previous page still open.
   * 3. The selection listeners hear `null`. The real adapter gets there
   *    through `discardSelectionFromDepartedDocument`, which it calls on a
   *    document REPLACEMENT (a previous id that is not this one) and before it
   *    announces the change. A selection belongs to the page it was made on,
   *    so the shell hears the page go away with the selection already gone.
   *    Only on a replacement, which is why the null is skipped when there was
   *    no previous id: a first handshake replaced nothing.
   * 4. The document-changed listeners hear the new id.
   *
   * The order is the point. A fixture that told the document-changed
   * listeners first let a test believe the shell still held the departed
   * page's selection at the moment the boundary moved, which the product
   * never does.
   */
  emitReady(documentId: string): void {
    if (documentId === this.documentId) return
    const replacedDocument = this.documentId !== null
    this.documentId = documentId
    if (replacedDocument) {
      for (const parked of this.parkedSelectReads) parked.settle(null)
      this.parkedSelectReads.length = 0
      for (const parked of this.parkedSelectManyReads) parked.settle([])
      this.parkedSelectManyReads.length = 0
      for (const listener of this.selectionListeners) listener(null)
    }
    for (const listener of this.documentChangedListeners) listener(documentId)
  }

  /** Everything else the hook calls, as no-ops that record nothing. */
  onDragMoveCommitted(_listener: Listener<DragMoveRequest>): AdapterSubscription {
    return () => {}
  }
  onInsertAtPoint(
    _listener: Listener<InsertAtPointRequest>,
  ): AdapterSubscription {
    return () => {}
  }
  onResizeCommitted(_listener: Listener<ResizeRequest>): AdapterSubscription {
    return () => {}
  }
  onResolutionFailed(
    _listener: Listener<{ id: string; reason: string; selector: string }>,
  ): AdapterSubscription {
    return () => {}
  }
  onOverridePreviewFailed(
    _listener: Listener<OverridePreviewFailure>,
  ): AdapterSubscription {
    return () => {}
  }
  onOverrideReverted(
    _listener: Listener<{
      id: string
      kind: string
      selector: string
      reason: string
    }>,
  ): AdapterSubscription {
    return () => {}
  }
  onOverrideUnverified(
    _listener: Listener<{ id: string; kind: string; selector: string }>,
  ): AdapterSubscription {
    return () => {}
  }
  async getStructure(): Promise<OutlineNode[]> {
    if (!FakeBridgeAdapter.parkGetStructure) return this.structure
    return new Promise<OutlineNode[]>((resolve) => {
      this.structureReads.push({ settle: resolve })
    })
  }
  /**
   * Every parked Layers read, in order, each with the answer still to give.
   *
   * One entry per `getStructure` call while {@link FakeBridgeAdapter.parkGetStructure}
   * is on. A test settles them out of order on purpose: the departed page's
   * tree arriving after the new page's is the whole point.
   */
  readonly structureReads: { settle: (roots: OutlineNode[]) => void }[] = []
  /**
   * Every selector this adapter was asked to re-select, in order.
   *
   * The selection-stamp refresh after HMR is the only caller in these tests,
   * and it is invisible from the hook's return value, so this list is the one
   * place its retries can be counted.
   */
  readonly selectBySelectorCalls: string[] = []
  /** What the next `selectBySelector` answers. Null unless a test sets one. */
  selectBySelectorResult: Selection | null = null
  /**
   * One answer per call, in order, taken before {@link selectBySelectorResult}.
   *
   * The refresh is a CHAIN: it re-reads the stamp, and whether it reads again
   * is decided by the answer it just got. A single standing answer can only
   * stage the last link of that, so the case where the first read comes back
   * unchanged and the second comes back re-stamped had no way to be written.
   */
  readonly selectBySelectorAnswers: (Selection | null)[] = []
  /**
   * Selection reads parked until the test answers them, when
   * {@link FakeBridgeAdapter.parkSelectBySelector} is on.
   *
   * Parking is the only way to put a page change INSIDE one of these reads,
   * which is where the question lives: the real adapter used to apply the
   * reply to its own selection before the calling lane could ask whether the
   * page was still there.
   */
  readonly parkedSelectReads: {
    selector: string
    settle: (selection: Selection | null) => void
  }[] = []
  async selectBySelector(selector: string): Promise<Selection | null> {
    this.selectBySelectorCalls.push(selector)
    if (FakeBridgeAdapter.parkSelectBySelector) {
      return new Promise<Selection | null>((resolve) => {
        this.parkedSelectReads.push({ selector, settle: resolve })
      })
    }
    if (this.selectBySelectorAnswers.length > 0) {
      return this.selectBySelectorAnswers.shift() ?? null
    }
    return this.selectBySelectorResult
  }
  /**
   * Every multi-select read parked until the test answers it, when
   * {@link FakeBridgeAdapter.parkSelectMany} is on.
   *
   * The single-read list above exists so a PAGE CHANGE can be put inside a
   * read. This one exists so a SELECTION change can: the page stays where it
   * is, the designer clicks something else, and the multi-read that was
   * already out answers afterwards.
   */
  readonly parkedSelectManyReads: {
    selectors: readonly string[]
    settle: (selections: Selection[]) => void
  }[] = []
  async selectMany(selectors: readonly string[]): Promise<Selection[]> {
    if (FakeBridgeAdapter.parkSelectMany) {
      return new Promise<Selection[]>((resolve) => {
        this.parkedSelectManyReads.push({ selectors, settle: resolve })
      })
    }
    return []
  }
  async selectParent(): Promise<Selection | null> {
    return null
  }
  async setActive(): Promise<void> {}
  async clearSelection(): Promise<void> {}
  async exitDomEditMode(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true
  }
  previewHighlight(): void {}
  setElementText(): void {}
  setElementClasses(): void {}
  enterInsertPlacement(): void {}
  exitInsertPlacement(): void {}
  applyPropOverride(): void {}
  applyAttrOverride(): void {}
  clearPropOverrides(): void {
    this.clearedOverrides += 1
  }
  clearAttrOverrides(): void {
    this.clearedOverrides += 1
  }
  clearClassOverrides(): void {
    this.clearedOverrides += 1
  }
  resolveOverride(id: string, outcome: string): void {
    this.settledOverrides.push({ id, outcome })
  }
  /**
   * Present but never useful: `useEditVerification` opts out entirely unless
   * `supportsRenderedValueRead()` agrees, and the value lane is not what this
   * fixture stages. It exists because the hook checks for the METHOD first and
   * skips before it ever consults the flag.
   */
  async readRenderedValue(): Promise<string | null> {
    return null
  }
  supportsRenderedValueRead(): boolean {
    return FakeBridgeAdapter.verificationEnabled
  }
  supportsStyleProvenance(): boolean {
    return FakeBridgeAdapter.verificationEnabled
  }
  getStyleProvenance(
    selector: string,
    properties: readonly string[],
  ): Promise<Record<string, StyleOrigin> | null> {
    if (this.provenanceAnswer !== undefined) {
      return Promise.resolve(this.provenanceAnswer)
    }
    return new Promise((resolve) => {
      this.provenanceReads.push({ selector, properties, settle: resolve })
    })
  }
  /**
   * Answer every parked cascade read, and every later one, with `origins`.
   *
   * One call rather than settling reads by hand: the lane polls, so a test
   * that answered only the read it is holding would immediately be holding
   * the next one.
   */
  settleProvenance(origins: Record<string, StyleOrigin> | null): void {
    this.provenanceAnswer = origins
    const parked = this.provenanceReads.splice(0, this.provenanceReads.length)
    for (const read of parked) read.settle(origins)
  }
  supportsMeasurementsRead(): boolean {
    return false
  }
  resolveMutationDisambiguation(
    pendingId: string,
    choice: DisambiguationChoice | "cancel",
  ): void {
    this.resolvedDrafts.push({ pendingId, choice })
  }
}
