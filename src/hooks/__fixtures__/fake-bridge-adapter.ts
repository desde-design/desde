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
import type { OutlineNode } from "@/types/bridge"

export interface RecordedApply {
  edit: StructuralEdit
  signal: AbortSignal | undefined
  settle: (result: EditResult) => void
  fail: (reason: string) => void
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

  private readonly selectionListeners = new Set<Listener<Selection | null>>()
  private readonly captureListeners = new Set<Listener<Mutation>>()
  private readonly awaitingListeners = new Set<Listener<PendingMutation>>()
  private readonly treeListeners = new Set<() => void>()

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
  applyEdit(
    edit: StructuralEdit,
    opts?: { signal?: AbortSignal },
  ): Promise<EditResult> {
    return new Promise<EditResult>((resolve) => {
      this.applies.push({
        edit,
        signal: opts?.signal,
        settle: resolve,
        fail: (reason) => resolve({ kind: "failed", reason }),
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
    return this.structure
  }
  async selectBySelector(): Promise<Selection | null> {
    return null
  }
  async selectMany(): Promise<Selection[]> {
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
  supportsRenderedValueRead(): boolean {
    return false
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
