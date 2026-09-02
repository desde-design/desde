/**
 * Every piece of chat state that is keyed by BUCKET ID, in one module, with
 * one function that moves all of it when a bucket is re-keyed.
 *
 * ## Why this module exists
 *
 * A chat turn starts under a provisional bucket key (`SOLO_BUCKET`, or the
 * caller's current sessionId) and is re-keyed to the server-minted sessionId
 * the moment the `session` SSE event arrives. Everything filed under the old
 * key has to move with it, and the move used to be N inline blocks in the
 * `session` handler — one per ref, each one written by hand.
 *
 * That carry has now been forgotten TWICE, and both times the bug was a lost
 * or duplicated user message:
 *
 *  1. The steer ledger was left behind, so a message the user typed sat under
 *     a key no sweep would ever read again.
 *  2. `insideSweep` was left behind, so the re-keyed turn's `finally` saw a
 *     bucket that was not marked as sweeping and started a SECOND, nested
 *     sweep on it — while the outer sweep still held the ledger entry.
 *     Measured: POST bodies `["first", "second", "second"]`, i.e. the user's
 *     steer delivered twice and the agent running the same instruction twice.
 *
 * The pattern is the bug: "remember to add the new ref to the carry" is not a
 * thing a reviewer reliably does. So the state lives in ONE object and the
 * carry is a mapped type over that object's keys — `CARRY_STRATEGIES` below is
 * `{ [K in keyof BucketKeyedState]: … }`, so adding a field to
 * `BucketKeyedState` without giving it a carry rule does not compile. The next
 * per-bucket ref cannot be forgotten; it has to be refused or handled.
 */

import type { ModelImageContent } from "@/editor/agent-chat-sdk/media-content"

/**
 * One steer this client has SENT but whose fate it does not yet know.
 *
 * **THE LEDGER IS THE NO-LOSS GUARANTEE — not the server's
 * `resubmit_required` event.** That event travels on the owning turn's SSE
 * stream, and the likeliest way a steer dies unconsumed is Stop, which CLOSES
 * that stream: `SseStream.send` starts with `if (closed) return false` and
 * drops the frame. So on the single most likely loss path the server's report
 * cannot arrive at all. A guarantee must not ride the channel whose death it
 * is guarding against. The client survives its own Stop, so the CLIENT holds
 * the payload until it knows what happened to it.
 *
 * The server's report is kept, and it is valuable — it lets a live stream say
 * "this one needs resending" precisely, instead of the end-of-turn sweep
 * having to guess. But it is an optimization layered on top of the ledger, not
 * the thing that prevents the loss.
 *
 * State machine, and what each state means for the end-of-turn sweep:
 *
 * | state           | meaning                                        | swept? |
 * | --------------- | ---------------------------------------------- | ------ |
 * | `in-flight`     | the POST has not answered yet                  | always |
 * | `accepted`      | a running turn took it on                      | only on an unclean close |
 * | `must-resubmit` | the server refused it, flagged it, or the POST failed | always |
 *
 * An entry leaves the ledger only when its fate is known: it was confirmed
 * consumed (accepted, and the turn's stream closed cleanly, which means the
 * server's end-of-turn reconciliation ran and did not flag it), or it was
 * resubmitted as a fresh turn.
 */
export interface PendingSteer {
  /** Client-local id. The only stable handle across a bucket re-key. */
  id: string
  /** The user's text, verbatim, so a resubmit is byte-identical. */
  text: string
  /** Base64 data URLs, verbatim as sent. Absent when no images rode along. */
  images?: string[]
  /**
   * True when `steer()` already put a user bubble on screen for this entry, so
   * a resubmit must not append a second one for a single thing the user typed.
   * False for an entry adopted from a `resubmit_required` event that this
   * client never sent (another tab typed it) — that one still needs a bubble.
   */
  rendered: boolean
  /**
   * True once a `steered` SSE event on the owning turn has been matched to
   * this entry. It is how the `steered` handler tells "I sent this one, the
   * bubble is already on screen" from "another client sent it, draw it" —
   * `steered` carries no steer id, only text, so the ledger is the only
   * evidence of authorship this client has.
   *
   * Consumed (set once, matched once) rather than merely read, so two clients
   * steering the SAME text into one turn still produce two bubbles here: the
   * first event claims this entry, the second finds no unclaimed match and
   * draws. Repeat over drop, always.
   */
  steeredEventSeen?: boolean
  state: "in-flight" | "accepted" | "must-resubmit"
  /**
   * A resubmit attempt that is happening RIGHT NOW, and which attempt it is.
   *
   * Deliberately not a fourth `state`. `must-resubmit` means "this entry is
   * owed a resend", which is true for a long time before and between the
   * attempts themselves: on Stop the entry sits in `must-resubmit` while the
   * sweep waits out `RESUBMIT_409_RETRY_DELAYS_MS`. Measured live, the whole
   * recovery ran about 25 seconds with nothing on screen, and the person who
   * had just built the ledger read that silence as the ledger failing. A
   * fourth state would have to answer both "is a resend owed" and "is one in
   * flight" with one value, so the two are separate fields instead.
   *
   * Present while an attempt is outstanding, INCLUDING the backoff wait
   * between attempts — that wait is most of the elapsed time, and it is
   * exactly the part that looked like nothing was happening.
   *
   * `attempt` is 1-based. 1 is the first try, so any value above 1 means at
   * least one 409 retry has already happened.
   */
  resending?: { attempt: number }
}

/** One steer being resent right now, as the chat surface renders it. */
export interface ResendingSteer {
  id: string
  /** The user's text, verbatim. Empty for an image-only steer. */
  text: string
  /** 1-based; above 1 means at least one 409 retry has already happened. */
  attempt: number
}

/** A {@link ResendingSteer} plus the bucket whose surface may render it. */
export interface ResendingSteerRecord extends ResendingSteer {
  bucketId: string
}

/**
 * Snapshot every in-flight resend across every bucket.
 *
 * Recomputed from the ledger rather than tracked alongside it, so a bucket
 * re-key (which moves ledger entries wholesale) cannot leave this list
 * pointing at a key nothing reads any more.
 */
export function collectResendingSteers(
  ledger: PendingSteerLedger,
): ResendingSteerRecord[] {
  const out: ResendingSteerRecord[] = []
  for (const [bucketId, entries] of ledger) {
    for (const entry of entries) {
      if (!entry.resending) continue
      out.push({
        bucketId,
        id: entry.id,
        text: entry.text,
        attempt: entry.resending.attempt,
      })
    }
  }
  return out
}

/**
 * Field-wise equality for two resend snapshots.
 *
 * The publisher writes React state on every ledger mutation it makes, and the
 * chat surface re-renders on that state. Most of those publishes change
 * nothing (a sweep that finds no resends, a settle that touches a different
 * entry), so an unconditional `setState` would repaint the rail for no reason.
 */
export function sameResendingSteers(
  a: ResendingSteerRecord[],
  b: ResendingSteerRecord[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, i) => {
    const other = b[i]
    return (
      entry.id === other.id &&
      entry.bucketId === other.bucketId &&
      entry.attempt === other.attempt &&
      entry.text === other.text
    )
  })
}

/**
 * How a turn's SSE stream ended, which is the only thing that decides whether
 * an `accepted` steer counts as confirmed-consumed.
 *
 * `reconciled` — the stream ended normally. The server's end-of-turn
 * reconciliation runs in `chat-handler`'s `finally` and emits
 * `resubmit_required` for every steer it cannot account for BEFORE the stream
 * closes, so a steer that was accepted and not flagged is confirmed.
 *
 * `unknown` — Stop, abort, an exception, a dead stream, a rejected fetch, a
 * non-OK response. Nothing is confirmed and everything goes back out.
 */
export type TurnCloseMode = "reconciled" | "unknown"

export type PendingSteerLedger = Map<string, PendingSteer[]>

export function appendPendingSteer(
  ledger: PendingSteerLedger,
  bucketId: string,
  entry: PendingSteer,
): void {
  const existing = ledger.get(bucketId)
  if (existing) existing.push(entry)
  else ledger.set(bucketId, [entry])
}

/**
 * Locate an entry by id across EVERY bucket, not just the one it was filed
 * under. A steer's POST can still be in flight when the `session` event
 * re-keys its bucket, so the bucket id captured at send time may already be
 * stale by the time the response lands.
 */
export function findPendingSteer(
  ledger: PendingSteerLedger,
  id: string,
): { bucketId: string; entry: PendingSteer } | null {
  for (const [bucketId, entries] of ledger) {
    const entry = entries.find((e) => e.id === id)
    if (entry) return { bucketId, entry }
  }
  return null
}

/**
 * Remove one ledger entry by id, wherever it now lives. Removal must follow
 * the id and not the bucket the caller filed it under, because a `session`
 * re-key can move a bucket's ledger while an entry is mid-resubmit.
 */
export function removePendingSteer(ledger: PendingSteerLedger, id: string): void {
  for (const [bucketId, entries] of ledger) {
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) continue
    entries.splice(idx, 1)
    if (entries.length === 0) ledger.delete(bucketId)
    return
  }
}

/** `resubmit_required` carries MCP image blocks; `submit` takes data URLs. */
export function dataUrlFromModelImage(image: ModelImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`
}

/**
 * A sweep in progress, holding the bucket it is CURRENTLY sweeping.
 *
 * Deliberately a mutable box rather than a bare bucket id in a `Set<string>`.
 * A re-key retargets the box (see `CARRY_STRATEGIES.sweeps`), so both the
 * sweep's own loop and its `finally` follow the bucket instead of stranding:
 *
 *  - a sweep that kept draining its ORIGINAL key would stop seeing the steers
 *    that moved to the new one, and
 *  - a sweep that released its ORIGINAL key on the way out would leave the NEW
 *    key latched forever — and a latched key silently blocks every future
 *    sweep on that bucket, which is the loss this whole mechanism prevents.
 */
export interface SweepHandle {
  bucketId: string
}

/**
 * All bucket-keyed chat state. Add a field here and the compiler will demand a
 * carry rule for it below — that is the whole point of the module.
 */
export interface BucketKeyedState {
  /** In-flight stream controller per bucket. Its presence means "a turn owns this bucket". */
  aborts: Map<string, AbortController>
  /** Steers whose fate is unknown. See `PendingSteer`. */
  pendingSteers: PendingSteerLedger
  /** Sweeps in progress. Two on one bucket would abort each other's resubmits. */
  sweeps: Set<SweepHandle>
  /** How each bucket's most recent turn ended, for a second sweep pass. */
  lastCloseMode: Map<string, TurnCloseMode>
  /** The SERVER's sessionId per bucket, learned from the `session` event. */
  serverSessionId: Map<string, string>
  /** Buckets whose streaming assistant message must be cut below a steer bubble. */
  steerSplit: Set<string>
}

export function createBucketKeyedState(): BucketKeyedState {
  return {
    aborts: new Map(),
    pendingSteers: new Map(),
    sweeps: new Set(),
    lastCloseMode: new Map(),
    serverSessionId: new Map(),
    steerSplit: new Set(),
  }
}

/** Is a sweep already draining this bucket? */
export function isSweeping(state: BucketKeyedState, bucketId: string): boolean {
  for (const handle of state.sweeps) {
    if (handle.bucketId === bucketId) return true
  }
  return false
}

export function beginSweep(state: BucketKeyedState, bucketId: string): SweepHandle {
  const handle: SweepHandle = { bucketId }
  state.sweeps.add(handle)
  return handle
}

/** Released by identity, so a re-keyed sweep releases the key it now holds. */
export function endSweep(state: BucketKeyedState, handle: SweepHandle): void {
  state.sweeps.delete(handle)
}

function moveMapEntry<V>(map: Map<string, V>, fromId: string, toId: string): void {
  if (!map.has(fromId)) return
  const value = map.get(fromId) as V
  map.delete(fromId)
  // Source wins: the bucket being re-keyed is the one with the live turn, so
  // its record is the fresher of the two.
  map.set(toId, value)
}

function moveSetMember(set: Set<string>, fromId: string, toId: string): void {
  if (set.delete(fromId)) set.add(toId)
}

type CarryStrategy = (
  state: BucketKeyedState,
  fromId: string,
  toId: string,
) => void

/**
 * One carry rule per field of `BucketKeyedState`. The mapped type is the
 * guard: a new field with no rule here is a type error, not a silent
 * omission.
 */
const CARRY_STRATEGIES: { [K in keyof BucketKeyedState]: CarryStrategy } = {
  aborts: (state, fromId, toId) => {
    // If a submit was already in flight on the destination, abort it — the
    // carried turn now owns this bucket, and same-session concurrent submits
    // aren't supported.
    const carried = state.aborts.get(fromId)
    const priorOnDestination = state.aborts.get(toId)
    if (priorOnDestination && priorOnDestination !== carried) {
      priorOnDestination.abort()
    }
    if (carried) {
      state.aborts.delete(fromId)
      state.aborts.set(toId, carried)
    }
  },
  pendingSteers: (state, fromId, toId) => {
    // Appended AFTER any entries already filed under the destination, so
    // resubmit order stays send order.
    const carried = state.pendingSteers.get(fromId)
    if (!carried || carried.length === 0) return
    state.pendingSteers.delete(fromId)
    const atDestination = state.pendingSteers.get(toId) ?? []
    state.pendingSteers.set(toId, [...atDestination, ...carried])
  },
  sweeps: (state, fromId, toId) => {
    for (const handle of state.sweeps) {
      if (handle.bucketId === fromId) handle.bucketId = toId
    }
  },
  lastCloseMode: (state, fromId, toId) =>
    moveMapEntry(state.lastCloseMode, fromId, toId),
  serverSessionId: (state, fromId, toId) =>
    moveMapEntry(state.serverSessionId, fromId, toId),
  steerSplit: (state, fromId, toId) =>
    moveSetMember(state.steerSplit, fromId, toId),
}

/**
 * Move every per-bucket entry from `fromId` to `toId`. Called from the one
 * place a bucket is ever re-keyed: the `session` SSE handler.
 */
export function carryBucketState(
  state: BucketKeyedState,
  fromId: string,
  toId: string,
): void {
  if (fromId === toId) return
  for (const carry of Object.values(CARRY_STRATEGIES)) {
    carry(state, fromId, toId)
  }
}
