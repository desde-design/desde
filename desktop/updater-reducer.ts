/**
 * Pure event → state reducer for the desktop updater.
 *
 * `electron-updater`'s `autoUpdater` is an `EventEmitter` with a shared event
 * stream: `checking-for-update` / `update-available` / `update-not-available` /
 * `download-progress` / `update-downloaded` / `error`, fired at whatever moment
 * its own network/IO work reaches each step, with no indication of which
 * OPERATION (which check, which update's download or install) each event
 * belongs to. `updater.ts` owns closing that gap: it tracks the operations it
 * initiates, mints identity for checks, stamps update outcomes with the
 * update-operation identity this reducer exposes, and translates every raw
 * event into one of the ATTRIBUTED events below before it reaches this
 * reducer. This module's only job is folding attributed events into state.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE INVARIANT (read this before touching any case below)
 *
 *   An outcome may only be applied to the operation it belongs to, and only
 *   an operation's own terminal outcome may consume its bookkeeping.
 *
 * The same bug — an outcome belonging to one operation invalidating, or being
 * attributed to, a DIFFERENT operation — was fixed five separate times in the
 * previous design (F3, F11, F12, F16, and a fifth found in review: a recheck
 * failing mid-download flipped the still-running download to "error"). The
 * first restructure gave CHECKS identity and closed those five doors; review
 * of it found the same class one level up, because UPDATES had no identity
 * (a superseded update's delayed native-prep error landed on its successor,
 * and a check rejection could overwrite a failed update's actionable error).
 * Both operation families are now identity-gated. The rules:
 *
 *  1. SCOPE IS ASSIGNED UPSTREAM, NEVER INFERRED HERE. Every event arrives
 *     already scoped: check-scoped (`check-started` / `check-concluded`) or
 *     update-scoped (`download-progress` / `download-completed` /
 *     `update-failed`). The reducer never looks at its current state to guess
 *     which operation an event belongs to — the guessing is what kept
 *     reopening doors. (How `updater.ts` decides the scope and stamp of a raw
 *     `error` event — the one genuinely ambiguous emit — is documented there.)
 *
 *  2. BOTH OPERATION FAMILIES CARRY IDENTITY, MINTED WHERE THE OPERATION
 *     BEGINS. Checks: a `CheckId` minted by `updater.ts` on the
 *     `checking-for-update` emit. Updates: an `updateOpId` minted HERE, in
 *     the reducer, at the moment an update artifact is created or replaced —
 *     here and not upstream because whether a check conclusion actually
 *     creates a new artifact is decided by the supersede rules below
 *     (`updater.ts` cannot know that a same-version reconfirmation keeps the
 *     old operation while a different-version find starts a new one). The
 *     current `updateOpId` is exposed on `ReducerState` so `updater.ts` can
 *     stamp outcomes with the operation they were observed against.
 *
 *  3. CONCLUSIONS AND OUTCOMES ARE ID-GATED, SYMMETRICALLY. A check
 *     conclusion consumes bookkeeping only on `checkId` match, applies
 *     knowledge only as the active check or anonymously (`checkId: null` — a
 *     check this reducer never saw start), and is dropped whole when its id
 *     names a check that is not active. An `update-failed` stamped with an
 *     `updateOpId` applies only while that operation IS the current artifact;
 *     a stamp naming a superseded operation is dropped whole — the operation
 *     it belonged to no longer has anything to invalidate. An anonymous
 *     stamp (`updateOpId: null`) applies to whatever is current; upstream
 *     uses it only where no operation identity exists to observe.
 *
 *  4. A CHECK-SCOPED FAILURE NEVER TOUCHES AN UPDATE OPERATION'S STATE. Not
 *     a live artifact (available/downloading/ready — F3, door five), and not
 *     a failed artifact that carries an operation id either (its failure
 *     message is the actionable outcome of a real update operation; an
 *     unrelated check error must not overwrite it). A check failure may
 *     write the display only where NO update operation's state exists: stage
 *     "none", or a failure display with `updateOpId: null` (an anonymous
 *     error that belongs to no operation — fresher anonymous news replaces
 *     it, which is what lets a check's own late rejection surface over an
 *     earlier unattributed error, F15). A check's SUCCESSFUL conclusion is
 *     different: it is authoritative news about the feed and may supersede
 *     artifacts by the knowledge rules (offer, withdraw, replace) — that is
 *     the product behavior, not a leak.
 *
 *  5. UPDATE-SCOPED EVENTS NEVER TOUCH CHECK BOOKKEEPING. `activeCheckId`
 *     is written only by the two check-scoped cases. The old design had to
 *     hand-carry its marker through every downloading/ready transition
 *     (F11) — here there is nothing to carry, so nothing to forget.
 *
 * The test for any future change: can an outcome be applied to an operation
 * it does not belong to? If answering requires tracing event orderings
 * case-by-case, the change is wrong — add the missing identity instead.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Kept pure and dependency-free on purpose — no Electron import, no I/O — so
 * every transition (including the ones that are hard to provoke from a real
 * updater: overlapping operations, duplicates, out-of-order and stale events)
 * can be asserted directly against plain objects, with no fake timers or fake
 * network needed. This is the part of the updater most likely to be subtly
 * wrong, so it gets the heaviest test coverage in the desktop package.
 */

import type { DesktopUpdateState } from "../src/types/desktop-bridge.js"

/**
 * Identity of one library-level check operation. Minted by `updater.ts` when
 * it observes a check actually begin (the `checking-for-update` emit), NOT
 * per `checkForUpdates()` call — `electron-updater` reuses an in-flight
 * check's promise for concurrent callers (verified against 6.8.9's
 * `AppUpdater.checkForUpdates()`), so several calls can ride one operation.
 */
export type CheckId = number

/**
 * Identity of one update operation — one artifact's lifecycle from the check
 * conclusion that offered it, through its download and install preparation,
 * to its terminal outcome. Minted by the REDUCER when an artifact is created
 * or replaced (see invariant rule 2 for why here and not upstream), carried
 * unchanged through available → downloading → ready → failed, and exposed on
 * `ReducerState.updateOpId` so `updater.ts` can stamp outcomes with it.
 */
export type UpdateOpId = number

/** How a check operation ended. Exactly one of these arrives per check. */
export type CheckOutcome =
  | { kind: "available"; version: string }
  | { kind: "not-available" }
  | { kind: "failed"; message: string }
  /**
   * The check's promise resolved without this process ever observing an
   * `update-available` / `update-not-available` for it. 6.8.9 always emits
   * one of the two before resolving, so this is a defensive terminal for a
   * future library that doesn't: it consumes the check's bookkeeping (so the
   * UI can't sit at "checking" forever) while asserting NO knowledge about
   * the feed — it neither offers, withdraws, nor fails anything.
   */
  | { kind: "settled-without-report" }

/**
 * The attributed event vocabulary — what `updater.ts` translates raw library
 * events into. Scope is part of the type: check-scoped events carry the
 * check identity that gates them; `update-failed` carries the update
 * operation it was observed against. `download-progress` and
 * `download-completed` carry no operation stamp because the library
 * serializes downloads (6.8.9 reuses `this.downloadPromise`) and an active
 * download's artifact cannot be superseded (the F5 knowledge rule below), so
 * the operation they belong to is always the current one; the terminal
 * additionally carries its version, which re-mints identity on a mismatch.
 */
export type UpdaterEvent =
  | { type: "check-started"; checkId: CheckId }
  | { type: "check-concluded"; checkId: CheckId | null; outcome: CheckOutcome }
  | { type: "download-progress"; percent: number }
  | { type: "download-completed"; version: string }
  /**
   * A failure attributed to an update operation — its download failing, its
   * install being declined, or a spontaneous install-preparation error (the
   * measured unsigned-build case). `updateOpId` is the operation the failure
   * was observed against: stamped values gate (a stale operation's outcome
   * is dropped — it has nothing left to invalidate); `null` means upstream
   * had no operation identity to observe (e.g. an error with no artifact at
   * all) and applies to whatever is current.
   */
  | { type: "update-failed"; message: string; updateOpId: UpdateOpId | null }

/**
 * The update artifact's lifecycle — "none" until a check finds something,
 * then what we know about the found update. "failed" doubles as the surfaced
 * terminal failure display: an update operation's failure lands here with
 * the operation's version and id, and a check failure with no update
 * operation's state to protect lands here anonymously (no version, no op).
 */
export type UpdateArtifact =
  | { stage: "none" }
  | { stage: "available"; version: string }
  | { stage: "downloading"; version: string | undefined; progressPercent: number }
  | { stage: "ready"; version: string }
  | { stage: "failed"; version: string | undefined; error: string }

export interface ReducerState {
  /** The update we know about — see `UpdateArtifact`. */
  update: UpdateArtifact
  /**
   * The update operation `update` belongs to — null when `update` is "none",
   * and null on a "failed" display that no operation produced (an anonymous
   * error, e.g. a check failure surfaced with nothing else to show). Minted
   * on artifact creation/replacement, preserved through the artifact's whole
   * lifecycle including its terminal "failed".
   */
  updateOpId: UpdateOpId | null
  /** Mint counter for `updateOpId` — reducer state because the reducer is
   *  pure (no module-global mutation). */
  nextUpdateOpId: UpdateOpId
  /**
   * The check currently believed in flight, or null. Set by `check-started`,
   * consumed ONLY by a `check-concluded` carrying the same id. Written by no
   * update-scoped case (invariant rule 5).
   */
  activeCheckId: CheckId | null
}

export const INITIAL_REDUCER_STATE: ReducerState = {
  update: { stage: "none" },
  updateOpId: null,
  nextUpdateOpId: 1,
  activeCheckId: null,
}

const NO_UPDATE: UpdateArtifact = { stage: "none" }

/**
 * Projects the rich reducer state onto the wire contract
 * (`DesktopUpdateState`, read by preload / IPC / the Editor UI). The
 * pre-restructure design shipped its internal bookkeeping across the wire
 * because its state WAS the wire state; the projection keeps internals
 * internal.
 *
 * Phase precedence falls out of the artifact: a live or failed update always
 * outranks check activity (an in-flight recheck must not hide a
 * ready-to-install update behind "checking"), and check activity only shows
 * as "checking" when there is nothing else to say.
 */
export function projectUpdateState(state: ReducerState): DesktopUpdateState {
  const update = state.update
  switch (update.stage) {
    case "none":
      return state.activeCheckId !== null ? { phase: "checking" } : { phase: "idle" }
    case "available":
      return { phase: "available", version: update.version }
    case "downloading":
      return { phase: "downloading", version: update.version, progressPercent: update.progressPercent }
    case "ready":
      return { phase: "ready", version: update.version }
    case "failed":
      return { phase: "error", version: update.version, error: update.error }
    default: {
      const _exhaustive: never = update
      return _exhaustive
    }
  }
}

/** The artifact-and-identity slice a check outcome may rewrite — everything
 *  in `ReducerState` except `activeCheckId`, which only the id-gate in the
 *  `check-concluded` case itself may consume (invariant rules 3 and 5). */
type UpdateSlice = Pick<ReducerState, "update" | "updateOpId" | "nextUpdateOpId">

/**
 * What a check's outcome is allowed to do to the update artifact. This is
 * the KNOWLEDGE half of a conclusion (the bookkeeping half — consuming
 * `activeCheckId` — lives in the reducer case and is purely id-gated).
 * Returns a slice whose `update` is the input object unchanged (reference
 * equality) when the outcome changes nothing, so no-ops stay detectable.
 */
function applyCheckOutcome(state: ReducerState, outcome: CheckOutcome): UpdateSlice {
  const { update, updateOpId, nextUpdateOpId } = state
  const unchanged: UpdateSlice = { update, updateOpId, nextUpdateOpId }
  switch (outcome.kind) {
    case "available":
      // An ACTIVE download's version stays authoritative (F5): a different
      // version reported mid-download does NOT mean a new download started —
      // electron-updater keeps resolving the SAME downloadPromise it already
      // has in flight (verified against 6.8.9's `downloadUpdate()`, which
      // reuses `this.downloadPromise`). The news is dropped; the next check
      // after this download settles will re-report whatever's still true.
      if (update.stage === "downloading") return unchanged
      // A re-report of the SAME version is the SAME operation continuing:
      // it doesn't un-ready a verified download (re-arming a restart the
      // user may already have been offered), doesn't churn an unchanged
      // "available", and keeps the operation's identity. A DIFFERENT
      // version replaces the artifact — the feed changed under us, and
      // there is no correct reason to hide a newer release from someone
      // sitting on an older one, verified-and-ready or not — and that
      // replacement is where a NEW update operation begins, so identity is
      // minted here (invariant rule 2).
      if (update.stage === "ready" && update.version === outcome.version) return unchanged
      if (update.stage === "available" && update.version === outcome.version) return unchanged
      return {
        update: { stage: "available", version: outcome.version },
        updateOpId: nextUpdateOpId,
        nextUpdateOpId: nextUpdateOpId + 1,
      }

    case "not-available":
      // "Nothing new on the feed" is a statement about what ELSE is out
      // there, not about the thing already in hand — a download in flight or
      // a verified, ready update is not invalidated by it.
      if (update.stage === "downloading" || update.stage === "ready") return unchanged
      if (update.stage === "none") return unchanged
      // An undownloaded "available" IS withdrawn by it (F4): a pulled or
      // corrected release must not stay offered forever. A displayed failure
      // is likewise cleared — a successful conclusion is authoritative news
      // about the feed, and the failure's story is over.
      return { update: NO_UPDATE, updateOpId: null, nextUpdateOpId }

    case "failed":
      // Invariant rule 4: a check's failure never touches an update
      // operation's state — not a live artifact, and not an op-carrying
      // failure display (that message is a real update operation's
      // actionable outcome; "the recheck's network blipped" must not
      // overwrite "v1.2's install failed"). It may write the display only
      // where no operation's state exists: nothing at all, or an anonymous
      // failure display — which fresher anonymous news replaces, so a
      // check's own late rejection can still surface over an earlier
      // unattributed error (F15's shape).
      if (update.stage === "none" || (update.stage === "failed" && updateOpId === null)) {
        return {
          update: {
            stage: "failed",
            version: update.stage === "failed" ? update.version : undefined,
            error: outcome.message,
          },
          updateOpId: null,
          nextUpdateOpId,
        }
      }
      return unchanged

    case "settled-without-report":
      // Bookkeeping-only terminal — asserts no knowledge (see CheckOutcome).
      return unchanged

    default: {
      const _exhaustive: never = outcome
      return _exhaustive
    }
  }
}

/**
 * `state === next` (reference equality) signals "this event changed nothing"
 * to the caller (`updater.ts`'s `apply()`), which uses that to skip further
 * work for a no-op — a stale or duplicate event must not spam subscribers.
 */
export function reduceUpdateState(state: ReducerState, event: UpdaterEvent): ReducerState {
  switch (event.type) {
    case "check-started": {
      // The same check re-announcing itself (updater.ts reuses the id while
      // a check is unsettled) is a true no-op.
      if (state.activeCheckId === event.checkId) return state
      // A NEW check beginning supersedes a terminal failure display — the
      // failure's story is over and a fresh answer is coming. It does NOT
      // touch a live update (invariant rule 4): available/downloading/ready
      // all keep displaying while the check runs in the background.
      const clearsFailure = state.update.stage === "failed"
      return {
        update: clearsFailure ? NO_UPDATE : state.update,
        updateOpId: clearsFailure ? null : state.updateOpId,
        nextUpdateOpId: state.nextUpdateOpId,
        activeCheckId: event.checkId,
      }
    }

    case "check-concluded": {
      const anonymous = event.checkId === null
      const ownsActiveCheck = !anonymous && event.checkId === state.activeCheckId
      // Invariant rule 3: a conclusion carrying the id of a check that is
      // not the active one is STALE — it belongs to an operation whose story
      // already ended (its conclusion arrived, or a newer check replaced
      // it). It consumes nothing and asserts nothing. This one gate is what
      // the old design's marker-clearing patches (F12, F16) were each
      // approximating for one outcome kind at a time.
      if (!anonymous && !ownsActiveCheck) return state
      // Consume only your own bookkeeping; an anonymous conclusion (a check
      // this reducer never saw start) has none to consume and must not eat
      // a different check's.
      const activeCheckId = ownsActiveCheck ? null : state.activeCheckId
      const slice = applyCheckOutcome(state, event.outcome)
      if (
        slice.update === state.update &&
        slice.updateOpId === state.updateOpId &&
        activeCheckId === state.activeCheckId
      ) {
        return state
      }
      return { ...slice, activeCheckId }
    }

    case "download-progress": {
      const update = state.update
      // Late progress after the download already finished ("ready") or the
      // update already failed is discarded outright — the terminal state
      // already said more than a percentage can.
      if (update.stage === "ready" || update.stage === "failed") return state
      const version =
        update.stage === "available" || update.stage === "downloading" ? update.version : undefined
      // Percent never moves backward: network-layer reordering can deliver a
      // lower percent after a higher one, and showing that would read as
      // "the download restarted" when it didn't.
      if (update.stage === "downloading" && event.percent <= update.progressPercent) return state
      const progressPercent =
        update.stage === "downloading" ? Math.max(update.progressPercent, event.percent) : event.percent
      // Progress over an existing artifact is that operation continuing;
      // progress from nothing (a download observed with no known artifact)
      // begins an operation, so identity is minted for it.
      const mintsOp = update.stage === "none"
      return {
        update: { stage: "downloading", version, progressPercent },
        updateOpId: mintsOp ? state.nextUpdateOpId : state.updateOpId,
        nextUpdateOpId: mintsOp ? state.nextUpdateOpId + 1 : state.nextUpdateOpId,
        activeCheckId: state.activeCheckId,
      }
    }

    case "download-completed": {
      const update = state.update
      if (update.stage === "ready" && update.version === event.version) return state
      // The completing download is the current operation when it completes
      // the artifact in hand (any downloading artifact — downloads are
      // serialized and an active download cannot be superseded — or an
      // available/ready artifact of the same version). A completion that
      // matches nothing in hand is a download this reducer never saw run:
      // a new operation, so identity is minted.
      const keepsOp =
        update.stage === "downloading" ||
        ((update.stage === "available" || update.stage === "ready") && update.version === event.version)
      // Note what is NOT here: any handling of `activeCheckId`. The old
      // design had to hand-carry its marker through this transition (F11);
      // orthogonal fields make the carry automatic and unforgettable.
      return {
        update: { stage: "ready", version: event.version },
        updateOpId: keepsOp ? state.updateOpId : state.nextUpdateOpId,
        nextUpdateOpId: keepsOp ? state.nextUpdateOpId : state.nextUpdateOpId + 1,
        activeCheckId: state.activeCheckId,
      }
    }

    case "update-failed": {
      // Invariant rule 3, update side: a failure stamped with an operation
      // that is no longer the current artifact is STALE — the operation it
      // belonged to was superseded, and its outcome has nothing left to
      // invalidate. This is the gate that keeps a replaced update's delayed
      // native-prep error (observed on macOS: `MacUpdater.updateDownloaded()`
      // reports ready and THEN does async native preparation) from landing
      // on its successor.
      if (event.updateOpId !== null && event.updateOpId !== state.updateOpId) return state
      const update = state.update
      if (update.stage === "failed" && update.error === event.message) return state
      // Applies unconditionally past the gate: upstream attribution already
      // established this failure is ABOUT this operation, so no state here
      // may veto it. The failure display keeps the operation's identity —
      // it is that operation's terminal, protected from check-failure
      // overwrite by rule 4 (or stays anonymous when there was none).
      return {
        update: {
          stage: "failed",
          version: update.stage === "none" ? undefined : update.version,
          error: event.message,
        },
        updateOpId: state.updateOpId,
        nextUpdateOpId: state.nextUpdateOpId,
        activeCheckId: state.activeCheckId,
      }
    }

    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}
