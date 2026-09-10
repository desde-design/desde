/**
 * What an edit lane is allowed to see of the bridge session.
 *
 * A lane needs the session's lifetime and its serialization; it has no business
 * with the scope prompt, which is why this interface is not generic and
 * `EditSession<Prompt>` satisfies it structurally. A lane that took the class
 * would have to name a Prompt type it never touches, and would be able to open
 * dialogs, which is the hook's job.
 */

/**
 * Every lane the session serializes and arms timers for.
 *
 * One array rather than a hand-written union, because the class has to
 * ENUMERATE these (cancel every timer, clear every marker) and a union cannot
 * be looped over. A lane added to the union alone would be missed by those
 * loops and its timers would outlive the page, which is finding C6.
 *
 * `selection` is the stamp refresh that re-reads the selected element after
 * our own write. It arms timers and reads the other two lanes' markers; it
 * takes no marker of its own.
 */
export const LANE_IDS = ["prop", "text", "selection"] as const

export type LaneId = (typeof LANE_IDS)[number]

/** Awaited work, plus whether the session it started in is still the live one. */
export type SessionRunResult<T> = { stale: true } | { stale: false; value: T }

export interface SessionRunContext {
  /** The session this run belongs to, captured before the first await. */
  readonly generation: number
  /**
   * The session's lifetime, as a signal, captured WITH the generation. Read at
   * request time instead, it could be the NEXT session's live controller, and
   * the request would run on past the reload that should have cancelled it.
   */
  readonly signal: AbortSignal
  /** Is the session this run started in still the live one? */
  readonly current: boolean
  /**
   * Await one step of the lane and be told whether to carry on.
   *
   * The whole point of the shape: `stale` has to be narrowed before `value`
   * can be read, so a lane cannot use an answer that arrived after its page
   * went away. Nineteen fix waves went into adding that check by hand at every
   * await; findings S1, T1, T3, U2, U3, V2, V3, W1 and X1 are all one missing
   * copy of it.
   */
  step<T>(work: Promise<T>): Promise<SessionRunResult<T>>
}

/**
 * One key namespace per lane, and it is flat.
 *
 * `key` is not scoped any further than the `lane` it is passed with. Two
 * callers that pass the same `lane` and the same `key` string share one
 * marker and one timer, whether they meant to or not. This interface does
 * not police that: it is on each caller's own key function (for example
 * `mutationIdentity`, which folds a mutation's kind into the string) to keep
 * its keys distinct from whatever else uses that lane.
 */
export interface LaneSession {
  readonly generation: number
  readonly signal: AbortSignal
  isCurrent(generation: number): boolean
  run<T>(fn: (ctx: SessionRunContext) => Promise<T>): Promise<SessionRunResult<T>>
  markInFlight(lane: LaneId, key: string): boolean
  isInFlight(lane: LaneId, key: string): boolean
  clearInFlight(lane: LaneId, key: string, generation: number): void
  schedule(
    lane: LaneId,
    key: string,
    generation: number,
    fn: () => void,
    ms: number,
  ): void
  cancelTimer(lane: LaneId, key: string): void
}
