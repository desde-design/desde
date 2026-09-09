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
  type BridgeSessionEndReason,
} from "./session-state"
import type {
  LaneId,
  LaneSession,
  SessionRunContext,
  SessionRunResult,
} from "./lane-session"
import type { Mutation, PropEdit } from "@/editor/core"

export type { LaneId, LaneSession, SessionRunContext, SessionRunResult }

export interface EditSessionOptions<Prompt> {
  /** The bridge draft id a scope prompt is holding, if any. */
  promptDraftId: (prompt: Prompt) => string | undefined
  /** The buffer key for one element's one prop. */
  propEditKey: (edit: PropEdit) => string
  /** The buffer key for one captured mutation. */
  mutationKey: (mutation: Mutation) => string
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

  constructor(protected readonly options: EditSessionOptions<Prompt>) {}

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

  /** Ends the session. Task 3 fills this in; part 1 only moves the lifetime. */
  end(reason: BridgeSessionEndReason): void {
    void reason
    this.currentGeneration += 1
    this.controller.abort()
    this.controller = new AbortController()
    this.inFlight.prop.clear()
    this.inFlight.text.clear()
    this.cancelTimers()
  }
}
