/**
 * What an edit lane is allowed to see of the bridge session.
 *
 * A lane needs the session's lifetime and its serialization; it has no business
 * with the scope prompt, which is why this interface is not generic and
 * `EditSession<Prompt>` satisfies it structurally. A lane that took the class
 * would have to name a Prompt type it never touches, and would be able to open
 * dialogs, which is the hook's job.
 */
export type LaneId = "prop" | "text"

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
