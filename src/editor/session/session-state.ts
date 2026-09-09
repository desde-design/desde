/**
 * The pure lifecycle decisions a bridge session makes: staleness, the
 * handshake boundary, buffer retirement and the end plan.
 *
 * Moved out of `src/hooks/pending-iteration-edit.ts` so `EditSession` can own
 * them without importing React: a `PendingIterationEdit` carries a
 * `LayersMovePayload`, which is a component type, so `sessionEndPlan` is
 * generic over the scope prompt instead and takes an accessor for the one
 * field it needs from it.
 */
import type { PendingMutation } from "@/editor/core"
import { createModalQueue, type ModalRequest } from "./modal-queue"

/**
 * The rows on screen in the deterministic dialog whose draft the bridge is
 * still holding, and which therefore have to be handed back when the adapter
 * that would answer them goes away.
 *
 * Every row reaches that dialog from the bridge, so in practice this is all of
 * them. It is a named selector rather than the array itself because the rule is
 * "a row the bridge is holding", not "a row": a row that ever arrives from
 * somewhere else must not be cancelled against an adapter that never saw it.
 */
export function rowsToRelease(
  rows: readonly PendingMutation[],
): PendingMutation[] {
  return rows.filter((row) => Boolean(row.pendingId))
}

/**
 * What the status bar says when the adapter went away and took held edits with
 * it, or null when it took none.
 *
 * Counted rather than vague, because "some edits" leaves the designer checking
 * the page for something that is not there. Null at zero: a re-attach with
 * nothing held is not an event, and reporting it would put a scary sentence on
 * screen for a page that lost nothing.
 */
export function discardedOnResetStatus(count: number): string | null {
  if (count <= 0) return null
  const edits = count === 1 ? "1 pending edit was" : `${count} pending edits were`
  return `The page connection was reset; ${edits} discarded.`
}

/**
 * Is there work the designer has not dispatched, that reloading the page would
 * throw away without saying so?
 *
 * Three counts, and the third is the one that was missing: a queued modal
 * request is an edit the bridge is still holding while it waits for a dialog to
 * close. It is exactly as unsaved as the other two, and it is INVISIBLE,
 * because nothing has opened a dialog for it yet. A pure function so the unload
 * warning's rule can be read and tested in one place rather than inferred from
 * a boolean expression inside a listener.
 */
export function hasUndispatchedWork(counts: {
  /** Mutations queued for the AI lane, which only Save dispatches. */
  aiQueue: number
  /** Edits parked in the deterministic disambiguation dialog. */
  parked: number
  /** Requests waiting behind the dialog that is open ({@link ModalQueue.enqueue}). */
  deferred: number
}): boolean {
  return counts.aiQueue > 0 || counts.parked > 0 || counts.deferred > 0
}

/**
 * Is this verify's answer stale, i.e. did a newer intercept start while it was
 * in flight?
 *
 * Verify is an HTTP round trip and nothing orders the responses. Draft P1 goes
 * out, the user types again, draft P2 goes out. If B answers first the dialog
 * shows P2, and A's late answer then released P2 (the NEWER keystrokes) and
 * reopened P1. With two `loop` answers it was worse: the second completion
 * silently destroyed the first edit. Sequence numbers make "newer exists" a
 * fact rather than an inference from object identity, which does not hold
 * (the pending object is rebuilt on every keystroke round trip).
 *
 * A stale result may only release ITS OWN draft. It must not touch the prompt
 * or the draft the newer intercept is holding.
 */
export function isStaleVerify(seq: number, latest: number): boolean {
  return seq !== latest
}

/**
 * Does this continuation belong to a bridge session that has ended?
 *
 * The sibling of {@link isStaleVerify}, one level up. That one asks whether a
 * NEWER edit replaced this one inside the same session; this one asks whether
 * the session itself is over: the adapter was torn down and re-attached, or
 * the page was reloaded out from under the edit.
 *
 * It matters because the bridge restarts its draft ids from `dom-pending-1` on
 * every reconnect. A continuation that resumes across that boundary is holding
 * an id that now names SOMEONE ELSE'S draft, so applying its edit writes an
 * overwrite computed for a page that is gone, and releasing "its" draft
 * cancels the live one the designer can still see. Teardown has already handed
 * every held draft back, so the right answer at a stale generation is to do
 * nothing at all: no apply, no release, no park, no status.
 */
export function isStaleGeneration(captured: number, current: number): boolean {
  return captured !== current
}

/**
 * May a dispatch that has just finished delete its own in-flight marker?
 *
 * The marker sets (one key per selector+prop identity) are SHARED across bridge
 * sessions, and a dispatch can outlive the session it started in: the page
 * reloads, the adapter re-attaches, a new dispatch for the same key starts and
 * adds the same key. The old dispatch's `finally` then deletes a marker that
 * now belongs to the new one, and a second dispatch for that identity can run
 * concurrently with the first.
 *
 * So a marker may only be cleared by the dispatch that still owns it, i.e. one
 * whose session is the current one. The session end clears the whole set, so a
 * marker left behind here is not stranded.
 *
 * It is the negation of {@link isStaleGeneration} and it is still its own named
 * function: "is this answer stale" and "may I clear this marker" are different
 * questions, and the second one is the whole of the concurrency rule.
 */
export function mayClearInFlightMarker(captured: number, current: number): boolean {
  return !isStaleGeneration(captured, current)
}

/**
 * Does a completed bridge handshake end the session that was running?
 *
 * The document boundary is the HANDSHAKE, not the iframe's `load` event. Those
 * two are not the same moment, and the difference is a real defect: the bridge
 * announces itself as soon as its script runs, so a page whose images or fonts
 * finish afterwards fires `load` on a document the shell is already connected
 * to and has been editing. Ending the session there discarded a draft the live
 * bridge was still holding, with nothing left to cancel it.
 *
 * So `load` only TRIGGERS a handshake now, and this decides what the handshake
 * means:
 *
 * | `previousToken` | `nextToken` | Decision |
 * | --- | --- | --- |
 * | null (first handshake of this document) | anything | ends nothing |
 * | a document | the SAME document | ends nothing: the page answered again |
 * | a document | a DIFFERENT document | ends the session: a new page is here |
 *
 * Both tokens are the bridge's own per-document id, minted once per bridge
 * IIFE. Every bridge the shell accepts reports one: a bridge that does not is
 * refused at the handshake by `REQUIRED_BRIDGE_VERSION`, because the fallback
 * the shell used to run for those — the iframe's `load` event — could not
 * decide the one case it existed for. Every re-handshake the shell can cause
 * follows a `load`, so "a load happened since the last handshake" was true even
 * for the same page answering twice, which is exactly what it was meant to tell
 * apart. A `nextToken` of null therefore cannot happen through the wiring; it
 * ends the session anyway, which is the conservative direction.
 *
 * `previousToken` is null before any handshake has been accepted for this
 * document, which is the first handshake of a fresh attachment and of every
 * attachment that follows a document change. It SURVIVES a plain teardown, so a
 * re-attach over the same page recognises it and re-arms the buffered edits
 * rather than starting a session that knows nothing about them.
 */
export function shouldEndSessionOnHandshake(
  previousToken: string | null,
  nextToken: string | null,
): boolean {
  return previousToken !== null && previousToken !== nextToken
}

/**
 * Did a handshake fail because a newer one replaced it?
 *
 * The adapter rejects the outstanding handshake with "superseded" when the
 * shell starts another one, which is not a failure at all: the newer handshake
 * is still running and will decide the document boundary itself. Every OTHER
 * rejection is a real one. The page never answered (it is off-origin, it 500'd,
 * or the five-second timeout ran out), so there is no document behind the
 * session the shell is still holding, and the session has to end there or the
 * generation never moves and none of the staleness guards engage.
 *
 * A string test, because that is what the adapter gives: the rejection is an
 * `Error` and the reason is in its message.
 */
export function isSupersededHandshake(message: string): boolean {
  return message.includes("superseded")
}

/**
 * Everything a bridge session is holding when it ends, as plain values.
 *
 * The three places a session ends (the adapter effect's cleanup, the iframe's
 * `load` handler, the conflict reload) used to clear different subsets of this
 * in different orders, so they discarded different amounts of the same state.
 */
export interface SessionEndState<Prompt> {
  /** The scope question on screen, if one is open. */
  openPrompt: Prompt | null
  /** Questions waiting behind whatever is open ({@link ModalQueue.enqueue}). */
  queued: readonly ModalRequest<Prompt>[]
  /** Rows in the deterministic disambiguation dialog. */
  rows: readonly PendingMutation[]
  /** Draft ids still recorded in the lane's maps, i.e. work in flight. */
  heldDraftIds: readonly string[]
  /**
   * How many buffered entries the departed document left behind, from
   * {@link retireForeignEntries}: the pending prop edits and the captured
   * mutations that were waiting for their debounce when the page went away.
   *
   * Required, not defaulted. It is a separate count from everything else here
   * and the only caller that can measure it is the one ending the session; a
   * default of zero would let a caller under-report a discard silently, which
   * is the failure this whole function exists to stop.
   *
   * Only counted for a reason that actually retires them
   * ({@link retiresBufferedEntries}). A caller that measures a count on a
   * `teardown` cannot report a discard that did not happen.
   */
  retiredBuffered: number
  /** Why the session is ending. See {@link retiresBufferedEntries}. */
  reason: BridgeSessionEndReason
}

/**
 * Why a bridge session ended.
 *
 * `cancelWithBridge` used to be the only thing the call sites disagreed about,
 * and it was passed as a bare boolean. The reason is what actually happened,
 * and two decisions now read it: whether the status line is worth setting, and
 * whether the edit buffers are retired.
 *
 * The four are not four behaviours. `unmount` is `teardown` with nobody left to
 * read the status bar, and `reload` is `reconnect` seen one step earlier: the
 * shell knows the document is about to be replaced rather than finding out from
 * the `load` event.
 */
export type BridgeSessionEndReason =
  /** The adapter is detaching and the panels stay on screen. */
  | "teardown"
  /** The adapter is detaching because the hook is unmounting. */
  | "unmount"
  /** The shell is about to replace the document (the conflict reload). */
  | "reload"
  /** The iframe has just loaded a different document. */
  | "reconnect"

/**
 * Does ending the session for this reason retire the edit buffers?
 *
 * Retirement is for a DOCUMENT CHANGE, and only two reasons are one: `reload`
 * (the shell is about to replace the document) and `reconnect` (the iframe
 * already did, including the handshake that never answered). An entry captured
 * against the departed page cannot be written into the page that replaced it,
 * so it is discarded and counted.
 *
 * The other two are not document changes:
 *
 * - `teardown` detaches the adapter and leaves the same document on screen with
 *   its previews still showing. An `enabled: true → false → true` flip would
 *   otherwise throw the designer's buffered edits away for a page that never
 *   went anywhere.
 * - `unmount` needs nothing done: React drops the buffers with the hook, and
 *   there is no status bar left to say what was discarded.
 *
 * Everything else a session end clears (the open prompt, the queued questions,
 * the dialog rows, the held drafts, the in-flight markers and the debounce
 * timers) is cleared for EVERY reason, because all of it is bound to the
 * adapter rather than to the document.
 */
export function retiresBufferedEntries(reason: BridgeSessionEndReason): boolean {
  return reason === "reload" || reason === "reconnect"
}

/** What ending a bridge session has to do, decided from {@link SessionEndState}. */
export interface SessionEndPlan {
  /**
   * Every draft this session was holding, once each, in the order the teardown
   * used to hand them back. Handed to the bridge only when the document that
   * issued them is still the one on screen.
   */
  cancelDraftIds: string[]
  /** How many held edits the session end throws away. */
  discarded: number
  /** The line to show for that count, or null when nothing was held. */
  status: string | null
}

/**
 * The ONE decision behind ending a bridge session.
 *
 * Pure, because the count it produces is the only thing the designer sees and
 * it was previously computed by three different code paths: the teardown
 * counted the prompt, the queue, the dialog rows and the maps; the conflict
 * reload counted nothing and said nothing; the `load` handler did not exist.
 *
 * Counting rules, unchanged from the teardown that had them first:
 *
 * - The open prompt counts as one whether or not it holds a bridge draft. An
 *   inspector or Layers edit parked in that dialog is just as lost.
 * - A queued request counts as one, for the same reason.
 * - A dialog row counts only when the bridge is holding its draft
 *   ({@link rowsToRelease}).
 * - A held draft counts only if nothing above already claimed it. The prompt
 *   and the queue own their drafts, and cancelling one twice would both
 *   double-count it and send the bridge a message about an id it has already
 *   dropped.
 * - Every buffered entry the departed document left behind counts, and none of
 *   them holds a bridge draft, so there is nothing to cancel for them. See
 *   {@link retireForeignEntries} for what "left behind" means, and
 *   {@link retiresBufferedEntries} for the reasons that leave them alone
 *   entirely (a `teardown` keeps the document, so it keeps the buffers).
 *
 * Releasing the prompt's draft also drops any queued question about that same
 * draft, which is what {@link ModalQueue.dropForDraft} does at the call site
 * that releases it; doing it here keeps the count honest.
 */
export function sessionEndPlan<Prompt>(
  state: SessionEndState<Prompt>,
  promptDraftId: (prompt: Prompt) => string | undefined,
): SessionEndPlan {
  const queue = createModalQueue(promptDraftId)
  const openDraftId = state.openPrompt ? promptDraftId(state.openPrompt) : undefined
  const queued = openDraftId
    ? queue.dropForDraft(state.queued, openDraftId)
    : [...state.queued]
  const rows = rowsToRelease(state.rows)
  const cancelDraftIds: string[] = []
  const claimed = new Set<string>()
  const claim = (draftId: string | undefined): boolean => {
    if (!draftId || claimed.has(draftId)) return false
    claimed.add(draftId)
    cancelDraftIds.push(draftId)
    return true
  }
  claim(openDraftId)
  for (const request of queued) claim(queue.requestDraftId(request))
  for (const row of rows) claim(row.pendingId)
  // The reason has the last word on the buffered count. The caller only
  // measures one for a reason that retires, and this is the second lock on the
  // same door: a `teardown` cannot report edits as discarded when it left them
  // exactly where they were.
  const retiredBuffered = retiresBufferedEntries(state.reason)
    ? state.retiredBuffered
    : 0
  let discarded =
    (state.openPrompt ? 1 : 0) + queued.length + rows.length + retiredBuffered
  for (const draftId of state.heldDraftIds) {
    if (claim(draftId)) discarded += 1
  }
  return { cancelDraftIds, discarded, status: discardedOnResetStatus(discarded) }
}

/**
 * Split buffered entries into the ones the live session may still act on and
 * the ones the departed document left behind.
 *
 * The shell's two edit buffers (the pending prop edits, the captured DOM
 * mutations) outlive the document that filled them. A prop typed just before a
 * reload is still sitting in its buffer when the new page attaches; so is a
 * text or class capture whose debounce had not fired. Nothing in either entry
 * says which page it came from, so the next Save, the next AI-queue drain, or
 * the next debounce read the whole array and wrote the departed page's source
 * into the page the designer is looking at now, or failed stale-target trying.
 *
 * The rule is exact equality with the live generation, so an entry captured in
 * ANY other session is foreign, older or newer. An entry carrying no
 * generation at all is foreign too: every shell creation site tags its entry,
 * so an untagged one came from somewhere that cannot say which document it
 * describes, and applying it to this one is the hazard this exists to stop.
 *
 * Retiring is a discard, and the caller says so: the count goes to
 * {@link sessionEndPlan}, which puts it in the line the designer reads.
 */
export function retireForeignEntries<T extends { generation?: number }>(
  entries: readonly T[],
  currentGeneration: number,
): { kept: T[]; retired: T[] } {
  const kept: T[] = []
  const retired: T[] = []
  for (const entry of entries) {
    if (entry.generation === currentGeneration) kept.push(entry)
    else retired.push(entry)
  }
  return { kept, retired }
}

/**
 * Which buffered entries get their debounced write re-armed when the adapter
 * re-attaches over the SAME document.
 *
 * Ending a bridge session cancels every debounce timer, because a timer that
 * outlived a page change writes the previous page's edit into the page in front
 * of the designer. A plain teardown ends the session but KEEPS the buffers (see
 * {@link retiresBufferedEntries}), so a prop typed inside the debounce window
 * before a detach kept its preview and its buffered entry with nothing left to
 * write it: there is no save-time flush for the prop buffer, and only another
 * keystroke on that same field would have re-armed it.
 *
 * So a re-attach over the same document re-arms them, which is exactly what
 * that next keystroke would have done.
 *
 * `inFlightKeys` is the lane's in-flight marker set. An entry being written
 * right now must NOT be re-armed: its own dispatch re-fires if the buffer moved
 * under it, and a second timer for the same identity is the parallel-write race
 * the markers exist to stop. Duplicate keys collapse to the last entry, since
 * the dispatch reads the buffer by key anyway.
 */
export function resumePlan<T extends { key: string }>(
  entries: readonly T[],
  inFlightKeys: ReadonlySet<string>,
): T[] {
  const byKey = new Map<string, T>()
  for (const entry of entries) {
    if (inFlightKeys.has(entry.key)) continue
    byKey.set(entry.key, entry)
  }
  return [...byKey.values()]
}
