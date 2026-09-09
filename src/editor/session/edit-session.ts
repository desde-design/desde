/**
 * ONE bridge session, as an object.
 *
 * A bridge session is one document in the shell's iframe. Everything here used
 * to be a ref in `useEditorEditing.ts`, re-read by convention in every lane,
 * and the convention was broken again in nineteen consecutive fix waves. The
 * object exists so the rule is enforced by the only path a lane has to the
 * adapter's lifetime rather than by remembering to add four lines after each
 * await.
 */
import {
  isStaleGeneration,
  mayClearInFlightMarker,
  resumePlan,
  retireForeignEntries,
  retiresBufferedEntries,
  sessionEndPlan,
  shouldEndSessionOnHandshake,
  type BridgeSessionEndReason,
} from "./session-state"
import {
  createModalQueue,
  type ModalKind,
  type ModalQueue,
  type ModalRequest,
} from "./modal-queue"
import type {
  LaneId,
  LaneSession,
  SessionRunContext,
  SessionRunResult,
} from "./lane-session"
import type { Mutation, PendingMutation, PropEdit } from "@/editor/core"

export type { LaneId, LaneSession, SessionRunContext, SessionRunResult }

export interface EditSessionOptions<Prompt> {
  /** The bridge draft id a scope prompt is holding, if any. */
  promptDraftId: (prompt: Prompt) => string | undefined
  /** The buffer key for one element's one prop. */
  propEditKey: (edit: PropEdit) => string
  /** The buffer key for one captured mutation. */
  mutationKey: (mutation: Mutation) => string
  /**
   * A dialog just went on screen. The hook writes the status line for it: a
   * park explains itself, and the bridge's ordinary route explains nothing,
   * which is the difference `request.reason` carries.
   */
  onModalOpened?: (request: ModalRequest<Prompt>) => void
}

/** What the hook renders. Rebuilt only on change, so the identity is stable. */
export interface EditSessionSnapshot<Prompt> {
  propEdits: readonly PropEdit[]
  mutations: readonly Mutation[]
  rows: readonly PendingMutation[]
  scopePrompt: Prompt | null
  queued: readonly ModalRequest<Prompt>[]
}

export interface SessionEndResult {
  /** Drafts to hand back to the bridge, when the document can still hear it. */
  cancelDraftIds: string[]
  discarded: number
  status: string | null
  /** The departed document's buffered entries, for the caller's side tables. */
  retiredPropEdits: PropEdit[]
  retiredMutations: Mutation[]
}

export interface ResumePlan {
  propEdits: PropEdit[]
  mutations: Mutation[]
}

export class EditSession<Prompt> implements LaneSession {
  private currentGeneration = 0
  private controller = new AbortController()
  private document: string | null = null
  private readonly inFlight: Record<LaneId, Set<string>> = {
    prop: new Set(),
    text: new Set(),
  }
  private readonly timers: Record<LaneId, Map<string, ReturnType<typeof setTimeout>>> = {
    prop: new Map(),
    text: new Map(),
  }
  private readonly verifySeq = new Map<string, number>()

  private propEdits: readonly PropEdit[] = []
  private mutations: readonly Mutation[] = []
  private rows: readonly PendingMutation[] = []
  private scopePrompt: Prompt | null = null
  private queue: readonly ModalRequest<Prompt>[] = []
  private owner: ModalKind | null = null
  private readonly drafts = new Map<string, PendingMutation>()
  private readonly latestPending = new Map<string, Prompt>()
  private readonly listeners = new Set<() => void>()
  private readonly modals: ModalQueue<Prompt>
  private snapshot: EditSessionSnapshot<Prompt>

  constructor(protected readonly options: EditSessionOptions<Prompt>) {
    this.modals = createModalQueue(options.promptDraftId)
    this.snapshot = this.buildSnapshot()
  }

  private buildSnapshot(): EditSessionSnapshot<Prompt> {
    return {
      propEdits: this.propEdits,
      mutations: this.mutations,
      rows: this.rows,
      scopePrompt: this.scopePrompt,
      queued: this.queue,
    }
  }

  /**
   * One new snapshot, then one notification.
   *
   * The identity has to change on a change and NOT change otherwise:
   * `useSyncExternalStore` re-renders on identity and would loop forever on a
   * fresh object per read.
   */
  private notify(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): EditSessionSnapshot<Prompt> => this.snapshot

  updatePropEdits(update: (prev: readonly PropEdit[]) => readonly PropEdit[]): void {
    const next = update(this.propEdits)
    if (next === this.propEdits) return
    this.propEdits = next
    this.notify()
  }

  updateMutations(update: (prev: readonly Mutation[]) => readonly Mutation[]): void {
    const next = update(this.mutations)
    if (next === this.mutations) return
    this.mutations = next
    this.notify()
  }

  updateRows(update: (prev: readonly PendingMutation[]) => readonly PendingMutation[]): void {
    const next = update(this.rows)
    if (next === this.rows) return
    this.rows = next
    this.notify()
  }

  setScopePrompt(prompt: Prompt | null): void {
    if (this.scopePrompt === prompt) return
    this.scopePrompt = prompt
    this.notify()
  }

  /** The bridge is holding this draft for us. */
  holdDraft(pendingId: string, payload: PendingMutation): void {
    this.drafts.set(pendingId, payload)
  }

  getDraft(pendingId: string): PendingMutation | undefined {
    return this.drafts.get(pendingId)
  }

  heldDraftIds(): string[] {
    return [...this.drafts.keys()]
  }

  /**
   * Forget a draft. The bridge is told by the caller, which owns the adapter;
   * a queued question about it goes too, because answering it would resolve an
   * id the bridge no longer knows.
   */
  releaseDraft(pendingId: string): void {
    this.drafts.delete(pendingId)
    this.latestPending.delete(pendingId)
    const next = this.modals.dropForDraft(this.queue, pendingId)
    if (next.length === this.queue.length) return
    this.queue = next
    this.notify()
  }

  /**
   * The NEWEST pending edit per draft id. An in-page typing session rebuilds
   * the pending object on every keystroke round trip, so an older completion
   * must not release a draft the newer one is using, and object identity is
   * the only thing that separates them.
   */
  claimPending(draftId: string, prompt: Prompt): void {
    this.latestPending.set(draftId, prompt)
  }

  latestPendingFor(draftId: string): Prompt | undefined {
    return this.latestPending.get(draftId)
  }

  get modalOwner(): ModalKind | null {
    return this.owner
  }

  get queuedCount(): number {
    return this.queue.length
  }

  /**
   * Ask for a dialog. THE way either one is raised. True when it opened now,
   * false when it is waiting behind the one on screen; a false answer is not a
   * failure, and the caller's only job then is to say so in the status bar.
   */
  requestModal(request: ModalRequest<Prompt>): boolean {
    const decision = this.modals.enqueue(this.queue, request, this.owner)
    if ("open" in decision) {
      this.openModal(decision.open)
      return true
    }
    this.queue = decision.deferred
    this.notify()
    return false
  }

  /**
   * The open dialog has closed. Give the modal up and ask the next question.
   *
   * The class clears the scope prompt itself, when a scope dialog was the one
   * that just closed. A caller must not have to call `setScopePrompt(null)`
   * first: if it forgot, the old prompt would otherwise stay in the snapshot
   * next to whatever opens after it, which is the stacking finding R1 exists
   * to stop. This is one snapshot rebuild and one notification, same as any
   * other change here.
   */
  releaseModal(): void {
    const departingOwner = this.owner
    this.owner = null
    const { next, queue } = this.modals.dequeue(this.queue)
    this.queue = queue
    if (departingOwner === "scope") this.scopePrompt = null
    if (!next) {
      this.notify()
      return
    }
    this.openModal(next)
  }

  private openModal(request: ModalRequest<Prompt>): void {
    if (request.kind === "scope") {
      this.owner = "scope"
      this.scopePrompt = request.pending
    } else {
      this.owner = "disambiguation"
      // The dialog owns the draft from here: its confirm and its cancel both
      // resolve it with the bridge, so nothing else may park or release it.
      this.drafts.delete(request.mutation.pendingId)
      this.latestPending.delete(request.mutation.pendingId)
      if (!this.rows.some((row) => row.pendingId === request.mutation.pendingId)) {
        this.rows = [...this.rows, request.mutation]
      }
    }
    this.notify()
    this.options.onModalOpened?.(request)
  }

  /**
   * A handshake completed. Decide what it means, and say what the caller has
   * to do about it.
   *
   * The document boundary is the HANDSHAKE, not the iframe's `load` event
   * (finding U1): the bridge announces itself as soon as its script runs, so a
   * page whose images finish afterwards fires `load` on a document the shell is
   * already editing.
   */
  start(
    /**
     * `string | null`, matching `shouldEndSessionOnHandshake`. The adapter's
     * `bridgeDocumentId` getter is `string | null`, and an id-less handshake is
     * refused at the adapter, so null cannot reach here through the wiring.
     * Taking it anyway keeps the caller from inventing an empty string, which
     * would be adopted as a real document.
     */
    documentId: string | null,
    mutationEligible: (mutation: Mutation) => boolean = () => true,
  ): { ended: SessionEndResult | null; resumed: ResumePlan | null } {
    const previous = this.document
    const ended = shouldEndSessionOnHandshake(previous, documentId)
      ? this.end("reconnect")
      : null
    this.document = documentId
    const resumed =
      previous !== null && previous === documentId
        ? this.resume(mutationEligible)
        : null
    return { ended, resumed }
  }

  /**
   * Which buffered entries get their debounced write re-armed after a session
   * end that KEPT them (finding X2). An entry being written right now is
   * skipped: its own dispatch re-fires if the buffer moved under it.
   */
  resume(mutationEligible: (mutation: Mutation) => boolean = () => true): ResumePlan {
    const propEntries = this.propEdits.map((edit) => ({
      key: this.options.propEditKey(edit),
      edit,
    }))
    const mutationEntries = this.mutations
      .filter(mutationEligible)
      .map((mutation) => ({ key: this.options.mutationKey(mutation), mutation }))
    return {
      propEdits: resumePlan(propEntries, this.inFlight.prop).map((e) => e.edit),
      mutations: resumePlan(mutationEntries, this.inFlight.text).map((e) => e.mutation),
    }
  }

  get generation(): number {
    return this.currentGeneration
  }

  /** Which document this session last handshaked with, or null before one. */
  get documentId(): string | null {
    return this.document
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  isCurrent(generation: number): boolean {
    return !isStaleGeneration(generation, this.currentGeneration)
  }

  /**
   * A new adapter is attaching. Anything still in flight from the previous
   * attachment is stale, whatever it does next.
   *
   * Deliberately does NOT touch the document id: the session that was running
   * ended in the previous cleanup, and the reason it ended decided whether the
   * document is still the same one (a plain teardown keeps it, so the first
   * handshake can recognise the page and re-arm the buffered edits).
   */
  attach(): void {
    this.currentGeneration += 1
    this.controller = new AbortController()
  }

  async run<T>(
    fn: (ctx: SessionRunContext) => Promise<T>,
  ): Promise<SessionRunResult<T>> {
    const generation = this.currentGeneration
    const signal = this.controller.signal
    // Bind the check rather than alias `this`: an object-literal getter and
    // method see their OWN `this` (the ctx object), not the class instance,
    // so a bound reference is what actually reaches the instance here.
    const isCurrent = this.isCurrent.bind(this)
    const ctx: SessionRunContext = {
      generation,
      signal,
      get current() {
        return isCurrent(generation)
      },
      async step<S>(work: Promise<S>): Promise<SessionRunResult<S>> {
        let value: S
        try {
          value = await work
        } catch (err) {
          if (!isCurrent(generation)) return { stale: true }
          throw err
        }
        if (!isCurrent(generation)) return { stale: true }
        return { stale: false, value }
      },
    }
    let value: T
    try {
      value = await fn(ctx)
    } catch (err) {
      // A throw from a run whose session is over is not the caller's problem:
      // the surface that would have shown the error is describing another page.
      if (!this.isCurrent(generation)) return { stale: true }
      throw err
    }
    if (!this.isCurrent(generation)) return { stale: true }
    return { stale: false, value }
  }

  /** Take the marker for this identity. False when someone already holds it. */
  markInFlight(lane: LaneId, key: string): boolean {
    if (this.inFlight[lane].has(key)) return false
    this.inFlight[lane].add(key)
    return true
  }

  isInFlight(lane: LaneId, key: string): boolean {
    return this.inFlight[lane].has(key)
  }

  /**
   * Is ANY write out on this lane right now? Asked by work that has to wait for
   * the writes to land rather than for one identity in particular, such as
   * re-reading a selection's source stamps after HMR.
   */
  hasInFlight(lane: LaneId): boolean {
    return this.inFlight[lane].size > 0
  }

  /**
   * One lane, back to rest: every armed write cancelled, every marker given up.
   *
   * For the adapter going away rather than the session ending. A debounce
   * callback that fired afterwards would call into an adapter that is gone, and
   * a marker left behind would block the first dispatch for that identity once
   * a new adapter attaches. Not on `LaneSession`, because this is the shell
   * tearing a lane down, not the lane running.
   */
  resetLane(lane: LaneId): void {
    for (const timer of this.timers[lane].values()) clearTimeout(timer)
    this.timers[lane].clear()
    this.inFlight[lane].clear()
  }

  /**
   * Give the marker back, but only while this dispatch still owns it.
   *
   * The marker sets are keyed on the element and the prop, not on the session,
   * and a dispatch can outlive the session it started in. Deleting then would
   * delete the NEXT session's marker and let two writes for one identity run at
   * once. See `mayClearInFlightMarker`, and findings T3 and U3.
   */
  clearInFlight(lane: LaneId, key: string, generation: number): void {
    if (!mayClearInFlightMarker(generation, this.currentGeneration)) return
    this.inFlight[lane].delete(key)
  }

  /**
   * Arm a debounced write for this identity, in the session that asked for it.
   *
   * The generation is the caller's, captured at schedule time rather than read
   * inside the callback half a second later: read there it would be whichever
   * session is live when the timer fires, so a timer that outlived a page
   * change would write the previous page's edit under the new page's session
   * and pass every guard on the way (finding U2).
   */
  schedule(
    lane: LaneId,
    key: string,
    generation: number,
    fn: () => void,
    ms: number,
  ): void {
    this.cancelTimer(lane, key)
    const timer = setTimeout(() => {
      this.timers[lane].delete(key)
      if (!this.isCurrent(generation)) return
      fn()
    }, ms)
    this.timers[lane].set(key, timer)
  }

  cancelTimer(lane: LaneId, key: string): void {
    const existing = this.timers[lane].get(key)
    if (existing === undefined) return
    clearTimeout(existing)
    this.timers[lane].delete(key)
  }

  /** Every armed write, cancelled. Called by the session end. */
  cancelTimers(): void {
    for (const lane of ["prop", "text"] as const) {
      for (const timer of this.timers[lane].values()) clearTimeout(timer)
      this.timers[lane].clear()
    }
  }

  /**
   * Claim the latest verify slot FOR THIS TARGET. Responses are not ordered, so
   * this is what tells a late answer that newer keystrokes on the same element
   * replaced it. Per key, because one global counter let an edit on one element
   * declare an unrelated edit's answer stale and release its draft (L3).
   */
  nextVerifySeq(key: string): number {
    const seq = (this.verifySeq.get(key) ?? 0) + 1
    this.verifySeq.set(key, seq)
    return seq
  }

  latestVerifySeq(key: string, fallback: number): number {
    return this.verifySeq.get(key) ?? fallback
  }

  /**
   * End the session. ONE order, for every reason.
   *
   * The generation moves and the controller is aborted FIRST, before anything
   * is cleared: every continuation still awaiting belongs to the session that
   * is ending, and the clearing below is what it would otherwise resume into.
   * The controller is renewed rather than left aborted, because the reasons
   * that keep the adapter need a live one for the next edit.
   */
  end(reason: BridgeSessionEndReason): SessionEndResult {
    this.currentGeneration += 1
    this.controller.abort()
    this.controller = new AbortController()
    const retire = retiresBufferedEntries(reason)
    // The document is forgotten for exactly the reasons that retire the
    // buffers. A teardown keeps it, because the page is still on screen and
    // the buffered edits it kept belong to it.
    if (retire) this.document = null
    const propPartition = retire
      ? retireForeignEntries(this.propEdits, this.currentGeneration)
      : { kept: [...this.propEdits], retired: [] as PropEdit[] }
    const mutationPartition = retire
      ? retireForeignEntries(this.mutations, this.currentGeneration)
      : { kept: [...this.mutations], retired: [] as Mutation[] }
    const plan = sessionEndPlan(
      {
        openPrompt: this.scopePrompt,
        queued: this.queue,
        rows: this.rows,
        heldDraftIds: this.heldDraftIds(),
        retiredBuffered:
          propPartition.retired.length + mutationPartition.retired.length,
        reason,
      },
      this.options.promptDraftId,
    )
    this.propEdits = propPartition.kept
    this.mutations = mutationPartition.kept
    this.scopePrompt = null
    this.queue = []
    this.owner = null
    this.rows = []
    this.drafts.clear()
    this.latestPending.clear()
    this.inFlight.prop.clear()
    this.inFlight.text.clear()
    this.cancelTimers()
    this.notify()
    return {
      cancelDraftIds: plan.cancelDraftIds,
      discarded: plan.discarded,
      status: plan.status,
      retiredPropEdits: propPartition.retired,
      retiredMutations: mutationPartition.retired,
    }
  }
}
