/**
 * Real `electron-updater` wrapper — `tasks/electron-app.md` §4.
 *
 * What this module owns:
 *  - OPERATION TRACKING AND EVENT ATTRIBUTION. `electron-updater`'s events
 *    carry no operation identity (a version on some, nothing on others), so
 *    this module mints it: one `CheckId` per library-level check, tracked
 *    from the `checking-for-update` emit to the check promise settling, and
 *    every raw event is translated into an ATTRIBUTED `UpdaterEvent` before
 *    it reaches the pure reducer (`updater-reducer.ts` — read its invariant
 *    doc comment first; this module is the "scope is assigned upstream" half
 *    of that contract). The reducer never guesses which operation an event
 *    belongs to; this module never folds state.
 *  - "Checking is ALWAYS on" — except while an update is READY: one check
 *    at construction (called from `main.ts`'s `boot()`, i.e. after
 *    `app.whenReady()`), then every 4 hours on a timer, plus
 *    `checkForUpdates()`, the on-demand trigger for "Check for updates" in
 *    the UI. All three funnel through the SAME `runCheck()`, which refuses
 *    outright while `getState().phase === "ready"` (on macOS a check there
 *    destroys Squirrel.Mac's in-progress or finished install prep — see the
 *    comment in `runCheck()`) and otherwise
 *    starts by calling `shouldSkipCheck()` (F1, whole-branch review,
 *    P1 fix) — a packaged app whose package-time stamp confirms no publish
 *    provider is configured (see `update-feed-guard.ts`) skips THAT
 *    trigger's real check and stays wherever it already was, instead of
 *    ENOENTing into a permanent `error`. Critically, this is re-evaluated on
 *    EVERY trigger, not decided once and cached: the 4h timer is always
 *    scheduled (it just no-ops on each fire while the stamp says skip), and
 *    the on-demand click always calls through `runCheck()` too — so neither
 *    path needs any special-casing to "reconsider" if the answer ever
 *    changes. TEMPORARY — see `update-feed-guard.ts`'s doc comment for the
 *    self-disabling condition.
 *  - `autoDownload` tracks the persisted setting: the caller passes the
 *    initial value in and calls `setAutoDownload()` on every toggle change.
 *    This module never reads the settings file itself.
 *  - `autoInstallOnAppQuit` stays at its documented default (`true`): a user
 *    who ignores the "Restart to update" badge and quits normally still gets
 *    the update applied on next launch. Set explicitly so the invariant is
 *    visible here instead of "the library's default happens to be right."
 *  - `download()` / `restartAndInstall()` are guarded against the state they
 *    require (`"available"` / `"ready"`) — a stray call in the wrong phase
 *    is a harmless no-op, not a thrown error surfaced through IPC.
 *
 * ── How each raw library event is attributed ────────────────────────────────
 *
 * Everything below was verified against the INSTALLED electron-updater 6.8.9
 * source (`node_modules/electron-updater/out/AppUpdater.js`,
 * `BaseUpdater.js`, `MacUpdater.js`), not assumed. Version-sensitive facts
 * are marked; the degradation if a future release breaks one is documented
 * at the point that depends on it.
 *
 *  - `checking-for-update`: a check operation actually began. Emitted
 *    synchronously at the top of `doCheckForUpdates()`, i.e. inside our
 *    `source.checkForUpdates()` call, and exactly once per real check —
 *    concurrent `checkForUpdates()` calls reuse the in-flight promise and
 *    re-emit nothing. Mints a new `CheckId` (or re-announces the unsettled
 *    current one, which the reducer treats as a no-op).
 *  - `update-available` / `update-not-available`: the current check's
 *    conclusion. Attributed to the unsettled current check if there is one;
 *    otherwise dispatched with the last check's (now stale) id — the reducer
 *    drops it — or anonymously (`checkId: null`) when no check was ever
 *    observed, so a source that skips `checking-for-update` (the test fakes
 *    do) still drives the state machine.
 *  - `download-progress` / `update-downloaded`: update-scoped, no ambiguity —
 *    downloads are serialized by the library (`downloadPromise` reuse), and
 *    `update-downloaded` carries its own version. After `update-downloaded`
 *    this module records the READY OPERATION's id (`nativePrepOp`): on macOS
 *    `MacUpdater.updateDownloaded()` reports ready and THEN runs async
 *    native preparation (Squirrel's signature validation) for that update,
 *    so a later spontaneous error may belong to it even after a recheck has
 *    superseded the artifact.
 *  - `error`: THE ambiguous emit — the library funnels check failures,
 *    download failures, install declines, and spontaneous install-prep
 *    failures through one `dispatchError()`. Attribution, in order:
 *      1. Inside our synchronous `quitAndInstall()` call window → the
 *         install attempt's failure, stamped with the update operation
 *         captured at the call's entry and recorded on the call-scoped
 *         probe so `restartAndInstall()` reports it (F14).
 *      2. While the current check is unsettled → PARKED, not dispatched: it
 *         may be that check's own failure (6.8.9's check `.catch` emits
 *         "error" and then rethrows the SAME object, so the rejection that
 *         settles the matter is already on its way), or it may be an
 *         unrelated failure that merely landed mid-check. The update-op
 *         stamp is captured AT PARK TIME (see 3 — so a conclusion arriving
 *         before the flush cannot re-address the error to the artifact it
 *         creates; parking defers the dispatch, never the attribution).
 *         Parked errors are resolved when the check settles: the one the
 *         rejection claims is the check's own (already dispatched as its
 *         conclusion); the rest flush update-scoped under their captured
 *         stamps. Correct-but-briefly-deferred beats
 *         instant-but-misattributed: dispatching immediately would need
 *         exactly the state-based guess that produced five bugs, and the
 *         parking window is bounded by the check settling (the library's
 *         HTTP layer enforces request timeouts).
 *      3. Otherwise → update-scoped, stamped with the operation it was
 *         observed against: `nativePrepOp` when one is recorded and differs
 *         from the current artifact's operation (the artifact the native
 *         prep belonged to was superseded — its delayed error belongs to
 *         the DEAD operation, and the reducer's stamp gate drops it rather
 *         than letting it invalidate the successor), else the current
 *         artifact's operation (the normal case — including the measured
 *         unsigned-build C5 error, where prep and artifact are the same
 *         operation), else null when there is no artifact at all (an
 *         anonymous error; the reducer surfaces it).
 *  - A REJECTED check promise: the check's terminal failure, attributed to
 *    the check the call rode on. 6.8.9 rejects with the identical object it
 *    just emitted; `claimParkedError` uses that identity (message equality
 *    as a defensive fallback) to drop the parked duplicate. DEGRADATION IF
 *    IDENTITY STOPS MATCHING (library patch release): the parked copy is not
 *    claimed and flushes as an update-scoped error once the check settles —
 *    a duplicate failure SURFACES (visible, recoverable on the next check)
 *    rather than anything being silently swallowed or a foreign operation's
 *    state being consumed.
 *  - A REJECTED download promise: the download's terminal failure, stamped
 *    with the update operation captured where the download was observed
 *    beginning — `download()`'s entry for manual downloads, the check
 *    result's `downloadPromise` (6.8.9 returns it on `UpdateCheckResult`)
 *    for autoDownload. This is what keeps a download failure visible even
 *    when its emit half got parked behind an in-flight recheck, or diverted
 *    as a stale-prep error: the rejection is the operation's OWN signal.
 *    (`CancellationError` rejections are ignored — a cancelled download,
 *    which nothing in this product currently triggers, is not a failure.)
 *
 * What this module deliberately does NOT own: `quitAndInstall()`'s window-
 * close-before-quit event ordering (`before-quit-for-update` vs plain
 * `before-quit`) is `main.ts`'s job — see its doc comment for why child
 * cleanup has to hook BOTH events to the same shutdown routine.
 */

import { autoUpdater } from "electron-updater"
import type { DesktopUpdateState } from "../src/types/desktop-bridge.js"
import {
  INITIAL_REDUCER_STATE,
  projectUpdateState,
  reduceUpdateState,
  type CheckOutcome,
  type ReducerState,
  type UpdateOpId,
  type UpdaterEvent,
} from "./updater-reducer.js"

export type { DesktopUpdateState }

/**
 * The exact slice of `electron-updater`'s `AppUpdater` this module touches —
 * NOT `typeof autoUpdater` itself. Kept narrow and hand-written (rather than
 * `Pick<typeof autoUpdater, …>`) so a test double can be a small plain object
 * instead of something that has to structurally satisfy `AppUpdater`'s much
 * larger real surface (channel getters, staging rollout hooks, request
 * headers, …) which this module never touches.
 */
export interface UpdaterEventSource {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  forceDevUpdateConfig: boolean
  on(event: "checking-for-update", listener: () => void): unknown
  on(event: "update-available", listener: (info: { version: string }) => void): unknown
  on(event: "update-not-available", listener: (info: { version: string }) => void): unknown
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface Updater {
  getState(): DesktopUpdateState
  /** Returns an unsubscribe function. */
  onState(cb: (state: DesktopUpdateState) => void): () => void
  /** Manual download when autoDownload is off. No-op outside phase "available". */
  download(): Promise<void>
  /**
   * Only valid in phase "ready" — a no-op otherwise. Returns whether the
   * install attempt actually initiated: `false` means either the phase was
   * not "ready" at call time, or `quitAndInstall()` declined SYNCHRONOUSLY
   * (its failure is observed by a call-scoped probe around the call, not by
   * re-reading global phase — F14). `restart-and-install.ts`'s
   * `performRestartAndInstall` depends on this: it checks phase once before
   * a (possibly several-second) child shutdown, and needs to know whether
   * the install really started before deciding what to do next (F10).
   */
  restartAndInstall(): boolean
  /**
   * On-demand check — the same effect as the periodic 4h timer firing once,
   * right now ("Check for updates" in the settings menu). Safe to call from
   * any phase — `electron-updater`'s own `checkForUpdates()` reuses an
   * already-in-flight check rather than starting a second one, and a check
   * never disturbs a live update (the reducer's invariant rule 4).
   *
   * Returns a promise that resolves once THIS call's check has settled — a
   * skip (`shouldSkipCheck()` said so this trigger), a real conclusion, or a
   * real failure all resolve it; it never rejects (a check's own failure is
   * reported through `onState`/`getState()`, not by throwing here). F3
   * (whole-branch review, P2 fix): this is what lets a caller (the IPC
   * handler, `main.ts`) know PRECISELY when to read `getState()` for this
   * click's own result, instead of guessing a timeout window against
   * electron-updater's own (up to 60s) HTTP layer.
   *
   * `performed` (F8, whole-branch review, P2 fix) is `false` when NOTHING
   * was actually checked — `shouldSkipCheck()` said skip (a packaged build
   * with no publish provider configured), `electron-updater`'s own
   * unpackaged-dev no-op (`isUpdaterActive()` returns `Promise.resolve(null)`
   * before ever attempting anything, unless `forceDevUpdateConfig` is set),
   * or an update is already `"ready"` (re-checking then is destructive on
   * macOS — see `runCheck()`). The first two leave `getState()` at whatever
   * it already was — typically `"idle"`, indistinguishable by state alone
   * from "checked, nothing new". A caller must read `performed` FIRST:
   * `getState().phase === "idle"` only means "up to date" when `performed`
   * is also `true` — otherwise no check ever ran, and saying so would be
   * reporting a result that was never obtained. The third leaves it at
   * `"ready"`, which IS the answer: the update is downloaded and waits for
   * a restart.
   */
  checkForUpdates(): Promise<{ performed: boolean }>
  /** Flips the live `autoDownload` flag. Called at boot from the persisted
   *  setting, and again on every toggle change, so a flip takes effect on
   *  the NEXT check with no app restart required. */
  setAutoDownload(value: boolean): void
  /** Stops the periodic check timer. Production `main.ts` never calls this
   *  (the process just exits) — it exists so tests (and any future
   *  short-lived harness) can tear down cleanly instead of leaking a live
   *  `setInterval`. Idempotent. */
  dispose(): void
}

/** `tasks/electron-app.md` §4: "every 4 hours." */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export interface CreateUpdaterOptions {
  /** The persisted `updates.autoDownload` setting, read by the caller before construction. */
  autoDownload: boolean
  /**
   * `dev-app-update.yml` opt-in (`electron-updater` otherwise no-ops
   * `checkForUpdates()` entirely unless `app.isPackaged`) — the local-feed
   * smoke harness (`tasks/scripts/desktop-update-smoke.mts`) sets this via
   * `DESDE_DESKTOP_FORCE_DEV_UPDATE_CONFIG=1`; a normal `npm run
   * desktop` dev run leaves it unset, matching the stub's prior "never
   * transitions out of idle in dev" behavior.
   */
  forceDevUpdateConfig?: boolean
  /**
   * F1 (whole-branch review, merge blocker; P1 fix on second pass): consulted
   * at the TOP of `runCheck()` — i.e. on EVERY trigger (construction, each 4h
   * timer fire, each on-demand click), never cached — see
   * `update-feed-guard.ts`'s doc comment for why a one-shot decision baked in
   * at construction couldn't tell "confirmed unconfigured at package time"
   * apart from "might change", and why the 4h timer used to not even get
   * scheduled. Returning `true` skips THAT trigger's real check (logs, state
   * stays wherever it was); `false` lets it proceed normally, including
   * surfacing a genuine ENOENT/corrupt-feed failure as `error` exactly as if
   * this option didn't exist. Defaults to always-`false` (never skip) when
   * omitted — production always passes `main.ts`'s
   * `() => shouldSkipUpdateChecks({...})`, itself re-reading the package-time
   * stamp off disk on every call. TEMPORARY — delete this option once Phase 5
   * ships a real publish provider and every packaged app's stamp says so.
   */
  shouldSkipCheck?: () => boolean
  /** Injected for tests — a fake event source instead of the real `electron-updater` singleton. */
  source?: UpdaterEventSource
  /** Injected for tests — replaces `setInterval`/`clearInterval`. */
  scheduleCheck?: (fn: () => void, ms: number) => { stop: () => void }
}

/** One tracked check operation. `settled` flips exactly once, at the first
 *  observed terminal (conclusion emit, promise rejection, or promise
 *  resolution) — later terminals for the same operation are no-ops, which is
 *  also what dedups two `runCheck()` callers sharing one in-flight promise. */
interface TrackedCheck {
  readonly id: number
  settled: boolean
}

/** Same-failure test for claiming a parked error: object identity first (the
 *  6.8.9-verified behavior — the library emits and rethrows the SAME
 *  instance), message equality as the defensive fallback for a future
 *  release that wraps the error between emit and rethrow. */
function isSameFailure(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return a instanceof Error && b instanceof Error && a.message === b.message
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createUpdater(options: CreateUpdaterOptions): Updater {
  const source = options.source ?? (autoUpdater as unknown as UpdaterEventSource)
  /** The user's setting. What `source.autoDownload` is allowed to be when no update is in hand — see `applyAutoDownload`. */
  let desiredAutoDownload = options.autoDownload
  source.autoDownload = desiredAutoDownload
  source.autoInstallOnAppQuit = true
  if (options.forceDevUpdateConfig) source.forceDevUpdateConfig = true

  let reducerState: ReducerState = INITIAL_REDUCER_STATE
  let wireState: DesktopUpdateState = projectUpdateState(reducerState)
  const listeners = new Set<(s: DesktopUpdateState) => void>()

  // ── Operation tracking (the identity the raw events lack) ────────────────
  let nextCheckId = 1
  let currentCheck: TrackedCheck | null = null
  /** Errors emitted while the current check was unsettled — see the module
   *  doc comment's attribution rules for why they wait for the check to
   *  settle instead of being dispatched on a state-based guess. The
   *  update-op stamp is captured at park time, so a check conclusion that
   *  replaces the artifact before the flush cannot re-address a parked
   *  error to the artifact it created. */
  let parkedErrors: Array<{ err: unknown; updateOpId: UpdateOpId | null }> = []
  /** Non-null exactly for the synchronous duration of `quitAndInstall()` —
   *  the call-scoped failure probe F14 asked for, carrying the update
   *  operation the install attempt is FOR. */
  let installProbe: { failed: boolean; updateOpId: UpdateOpId | null } | null = null
  /** The update operation whose native install preparation may still be
   *  running — recorded at `update-downloaded` (macOS runs async native
   *  prep AFTER reporting ready), re-pointed by the next `update-downloaded`.
   *  Consulted by `spontaneousOpStamp` so a superseded update's delayed
   *  prep error is stamped with ITS operation, not the successor's. Since
   *  2026-09-03 the reducer never supersedes a READY update (see
   *  `applyCheckOutcome`), so this can no longer differ from the current
   *  operation; it stays as a defence, not a reachable path. */
  let nativePrepOp: UpdateOpId | null = null

  /**
   * The library reads `autoDownload` at the moment a check CONCLUDES
   * (`doCheckForUpdates`: `this.autoDownload ? this.downloadUpdate() : null`),
   * not when it starts. So the start-time gate in `runCheck()` (below) is
   * not enough on macOS: a check that begins while a download is running
   * and concludes after that download was handed to Squirrel.Mac would
   * start a SECOND download from cache — which re-runs
   * `MacUpdater.updateDownloaded()`, replaces Electron's SQRLUpdater, and
   * has the replacement's housekeeping delete the directory the first one
   * is still unzipping (the 2026-09-02 field failure; codex found this
   * ordering after the start-time gate shipped). While an update is being
   * downloaded or is ready, the live flag is therefore forced off, whatever
   * the user's setting says; it is restored the moment the update leaves
   * those phases (fails, or the artifact goes away). The user's setting is
   * kept in `desiredAutoDownload` so a toggle during a download is not lost.
   */
  function applyAutoDownload(): void {
    const inHand = wireState.phase === "downloading" || wireState.phase === "ready"
    source.autoDownload = desiredAutoDownload && !inHand
  }

  function apply(event: UpdaterEvent): void {
    const next = reduceUpdateState(reducerState, event)
    // Reference-equal means the reducer judged this a no-op (stale/duplicate/
    // out-of-order) — see updater-reducer.ts.
    if (next === reducerState) return
    reducerState = next
    const nextWire = projectUpdateState(next)
    // Kept in step with the phase BEFORE the visible-change filter below:
    // the flag depends on the phase alone, and a phase change is always a
    // visible change, but this ordering keeps the two from ever drifting.
    const phaseChanged = nextWire.phase !== wireState.phase
    // Only a VISIBLE change notifies: internal bookkeeping (a check starting
    // while an update stays displayed) must not spam subscribers with
    // identical states.
    if (
      nextWire.phase === wireState.phase &&
      nextWire.version === wireState.version &&
      nextWire.progressPercent === wireState.progressPercent &&
      nextWire.error === wireState.error
    ) {
      return
    }
    wireState = nextWire
    if (phaseChanged) applyAutoDownload()
    for (const cb of listeners) cb(wireState)
  }

  function dispatchUpdateFailed(err: unknown, updateOpId: UpdateOpId | null): void {
    apply({ type: "update-failed", message: failureMessage(err), updateOpId })
  }

  /**
   * The update operation a spontaneous (unclaimed, un-probed) error was
   * observed against. Normally the current artifact's operation — which
   * covers the measured unsigned-build C5 error, where the native prep and
   * the artifact are the same operation. When a recorded native prep
   * belongs to an operation the artifact has since been superseded away
   * from, the error is stamped with THAT dead operation instead: it is the
   * only spontaneous source that can exist for a never-downloaded successor
   * (the successor's own download failures arrive with their own promise
   * rejections, tracked below), and the reducer's gate then drops it rather
   * than letting one update's outcome invalidate another. Null only when
   * there is no artifact at all.
   */
  function spontaneousOpStamp(): UpdateOpId | null {
    const current = reducerState.updateOpId
    if (nativePrepOp !== null && nativePrepOp !== current) return nativePrepOp
    return current
  }

  /** Drops the parked copy of a failure that just got dispatched through an
   *  attributed path (a check rejection, a download rejection) — identity
   *  first, then at most ONE message-equal entry, so two genuinely distinct
   *  same-message failures can't both be swallowed by one claim. */
  function claimParkedError(err: unknown): void {
    if (parkedErrors.length === 0) return
    const identityIndex = parkedErrors.findIndex((parked) => parked.err === err)
    if (identityIndex >= 0) {
      parkedErrors.splice(identityIndex, 1)
      return
    }
    const messageIndex = parkedErrors.findIndex((parked) => isSameFailure(parked.err, err))
    if (messageIndex >= 0) parkedErrors.splice(messageIndex, 1)
  }

  /** Once no check is unsettled, everything still parked is by elimination
   *  update-scoped (the check's own failure was claimed at rejection time),
   *  dispatched under the stamps captured when each was parked. */
  function flushParkedErrors(): void {
    if (parkedErrors.length === 0) return
    if (currentCheck && !currentCheck.settled) return
    const flush = parkedErrors
    parkedErrors = []
    for (const parked of flush) dispatchUpdateFailed(parked.err, parked.updateOpId)
  }

  /**
   * Ownership registry for observed download promises: promise object → the
   * update operation that was live when that promise was FIRST observed.
   * First observation wins, because 6.8.9 REUSES a pending download promise
   * across callers: `downloadUpdate()` returns `this.downloadPromise`
   * whenever one is non-null, and nulls it only in its `.finally` — so a
   * recheck that reports v2 while v1's download/native-prep is still
   * pending hands back v1's OWN promise inside v2's check result. Stamping
   * that reused promise with the artifact current at (re-)observation time
   * would dispatch v1's eventual rejection under v2 — exactly the
   * cross-operation invalidation the update-op gate exists to prevent,
   * arriving through the promise path. Ownership therefore follows the
   * promise OBJECT, not the moment a check result happened to surface it.
   *
   * Entries are removed when the promise settles (resolve or reject), so
   * the map holds at most the in-flight downloads — under 6.8.9's
   * serialization, at most one entry — and cannot accumulate over a
   * long-running app's check cycles.
   *
   * VERSION-COUPLING NOTE (verified against 6.8.9, alongside the emit/
   * rethrow identity note above): this depends on the library returning the
   * SAME promise object for a reused in-flight download. If a future
   * version returned a fresh wrapper around the same underlying work,
   * object identity would stop deduplicating — which is why observation
   * ALSO consults serialization: a "new" promise observed while another
   * tracked download is still unsettled inherits THAT download's owner
   * (the library runs one download at a time, so same-window means same
   * work). Under that fallback a wrapper still dispatches under the
   * original operation — at worst a duplicate on the CORRECT owner, never
   * a misattribution to the successor. The residual truly outside the
   * model: a download whose beginning this module never observed at all
   * (neither `download()` nor any check result carried it) falls back to
   * the current-artifact stamp of `spontaneousOpStamp` via the emit path,
   * as before.
   */
  const downloadOwners = new Map<Promise<unknown>, UpdateOpId | null>()

  /** Registers a download promise under its owning operation (see
   *  `downloadOwners`) and attaches the single settle/rejection handler.
   *  Idempotent per promise object — a reused promise keeps its original
   *  owner and gains no second handler. */
  function trackDownloadPromise(promise: Promise<unknown>): void {
    if (downloadOwners.has(promise)) return
    // Serialization fallback: an unsettled tracked download means this
    // "new" promise object is the same underlying work (one download at a
    // time) — inherit its owner rather than guessing from the current
    // artifact. Under 6.8.9 this branch never fires (identity already
    // deduplicates); it exists to keep a fresh-wrapper future degrading to
    // the correct owner. Empty map: a genuinely new download, owned by the
    // operation live right now.
    const inherited = downloadOwners.size > 0 ? downloadOwners.values().next() : null
    const owner: UpdateOpId | null =
      inherited !== null && !inherited.done ? inherited.value : reducerState.updateOpId
    downloadOwners.set(promise, owner)
    promise.then(
      () => {
        downloadOwners.delete(promise)
      },
      (err: unknown) => {
        downloadOwners.delete(promise)
        if (err instanceof Error && err.name === "CancellationError") return
        claimParkedError(err)
        dispatchUpdateFailed(err, owner)
      },
    )
  }

  /**
   * Surfaces the `downloadPromise` 6.8.9 returns on `UpdateCheckResult`
   * when autoDownload has a download going — the download operation's OWN
   * terminal signal — into the ownership registry above. Shape-probed
   * defensively: a fake source resolving null, or a future library
   * reshaping the result, simply yields no tracking (the emit path still
   * reports, as before).
   */
  function trackAutoDownload(result: unknown): void {
    if (typeof result !== "object" || result === null) return
    const downloadPromise = (result as { downloadPromise?: unknown }).downloadPromise
    if (
      typeof downloadPromise !== "object" ||
      downloadPromise === null ||
      typeof (downloadPromise as { catch?: unknown }).catch !== "function"
    ) {
      return
    }
    trackDownloadPromise(downloadPromise as Promise<unknown>)
  }

  /** The current check's conclusion arrived via an `update-available` /
   *  `update-not-available` emit. */
  function concludeCheckFromEmit(outcome: CheckOutcome): void {
    if (currentCheck && !currentCheck.settled) {
      currentCheck.settled = true
      apply({ type: "check-concluded", checkId: currentCheck.id, outcome })
      flushParkedErrors()
      return
    }
    // No unsettled check. Dispatch with the last check's (stale) id when one
    // exists — the reducer drops it, which IS the old "a stale duplicate
    // racing behind the same check is ignored" behavior — or anonymously
    // when no check was ever observed, so the conclusion still lands (the
    // reducer applies its knowledge without consuming anyone's bookkeeping).
    apply({ type: "check-concluded", checkId: currentCheck ? currentCheck.id : null, outcome })
  }

  /** A check promise rejected — the check's terminal failure (6.8.9 both
   *  emits and rethrows the same object for one underlying failure; the emit
   *  half is parked above and claimed here). */
  function concludeCheckFromRejection(check: TrackedCheck | null, err: unknown): void {
    if (check && check.settled) {
      // A second catch on the same shared in-flight promise — the first one
      // already concluded the operation.
      flushParkedErrors()
      return
    }
    if (check) check.settled = true
    apply({
      type: "check-concluded",
      checkId: check ? check.id : null,
      outcome: { kind: "failed", message: failureMessage(err) },
    })
    claimParkedError(err)
    flushParkedErrors()
  }

  source.on("checking-for-update", () => {
    // Exactly one unsettled check can exist (the library serializes checks by
    // reusing the in-flight promise — verified against 6.8.9). A re-announce
    // while unsettled keeps the same identity; the reducer no-ops it.
    if (!currentCheck || currentCheck.settled) {
      currentCheck = { id: nextCheckId++, settled: false }
    }
    apply({ type: "check-started", checkId: currentCheck.id })
  })
  source.on("update-available", (info) =>
    concludeCheckFromEmit({ kind: "available", version: info.version }),
  )
  source.on("update-not-available", () => concludeCheckFromEmit({ kind: "not-available" }))
  source.on("download-progress", (info) => apply({ type: "download-progress", percent: info.percent }))
  source.on("update-downloaded", (info) => {
    apply({ type: "download-completed", version: info.version })
    // Native install preparation is now (potentially) running FOR the
    // operation that just reached ready — recorded so its delayed error
    // stays its own even if a recheck supersedes the artifact first.
    nativePrepOp = reducerState.updateOpId
  })
  source.on("error", (err) => {
    // Attribution ladder — see the module doc comment. Order matters: the
    // install probe outranks parking, because an install declining while an
    // unrelated recheck happens to be in flight is exactly the F14 case that
    // must not be mistaken for the recheck's own failure.
    if (installProbe) {
      installProbe.failed = true
      dispatchUpdateFailed(err, installProbe.updateOpId)
      return
    }
    if (currentCheck && !currentCheck.settled) {
      parkedErrors.push({ err, updateOpId: spontaneousOpStamp() })
      return
    }
    dispatchUpdateFailed(err, spontaneousOpStamp())
  })

  // F1 (whole-branch review, merge blocker; P1 fix on second pass): consulted
  // at the top of EVERY `runCheck()` call — see `CreateUpdaterOptions`'s doc
  // comment on why this is a live callback, re-invoked per trigger, rather
  // than a boolean decided once.
  const shouldSkipCheck = options.shouldSkipCheck ?? (() => false)

  /**
   * One code path for all three check triggers (construction, the 4h timer,
   * on-demand). Starts by consulting `shouldSkipCheck()` — see its doc
   * comment — which can say skip on one call and not the next; nothing here
   * remembers a prior answer.
   *
   * When not skipped, the tracked check is captured right after the call:
   * `checking-for-update` is emitted synchronously inside
   * `source.checkForUpdates()` (verified — `doCheckForUpdates()` emits at its
   * top, before any await), so by this point `currentCheck` is the operation
   * this call is riding on — freshly minted, or reused-in-flight. A source
   * that never emits it (the dev no-op path resolving null, a rejection
   * thrown before the emit — "malformed feed config") leaves the capture
   * null, and its outcome dispatches anonymously.
   *
   * Returns a promise resolving once this call's own check has settled (see
   * the public `checkForUpdates()` doc comment on `Updater` — F3, P2 fix):
   * never rejects, since failure is reported through the state machine, not
   * by throwing here. The resolved `{ performed }` (F8, whole-branch review,
   * P2 fix) tells the caller whether a real check actually RAN — see
   * `Updater.checkForUpdates()`'s doc comment for why `getState()` alone
   * can't answer that.
   */
  function runCheck(): Promise<{ performed: boolean }> {
    if (shouldSkipCheck()) {
      console.log(
        "[desktop] Skipping this update check — no publish provider configured yet " +
          "(update-feed-guard.ts's package-time stamp). Re-checked on every trigger, " +
          "not decided once at boot — this guard is temporary and self-disables once " +
          "Phase 5 lands a real publish config.",
      )
      return Promise.resolve({ performed: false })
    }
    // An update that is already downloaded is never re-checked. On macOS a
    // check here is DESTRUCTIVE, not redundant — measured 2026-09-02 (the
    // "Update failed: ditto: Could not lstat …/ShipIt/update.XXXXXXX/…"
    // field failure, reproduced by `tasks/scripts/desktop-update-smoke.mts`
    // scenario 4): "ready" is reported the moment the zip is handed to
    // Squirrel.Mac, which then unzips and verifies it in the background.
    // With autoDownload on, a later `checkForUpdates()` re-runs
    // `MacUpdater.updateDownloaded()` from the cached file, which closes
    // the proxy Squirrel is reading from, calls `setFeedURL` again (Electron
    // discards its SQRLUpdater and creates a new one), and the new one's
    // housekeeping deletes EVERY `update.*` directory in Squirrel's cache —
    // including the one still being extracted, and including a finished one
    // that ShipIt has already been pointed at. Nothing about the 4h timer
    // makes it safer, so the gate is here, on every trigger. The update
    // stays ready; the caller sees `performed: false` and the UI reads the
    // state machine ("ready") for the truth. Once the ready update FAILS
    // (a native-prep error flips it to "error"), checking is open again —
    // that is the recovery path. This gate only covers checks that START
    // while ready; `applyAutoDownload()` covers the ones that start earlier
    // and conclude later. The gate is deliberately not macOS-only: a ready
    // update that the feed has since replaced installs on the next restart
    // and the newer one is found on the boot after — a tolerable cost for
    // one rule on every platform.
    if (wireState.phase === "ready") {
      return Promise.resolve({ performed: false })
    }
    const promise = source.checkForUpdates()
    const check = currentCheck && !currentCheck.settled ? currentCheck : null
    return promise.then(
      (result) => {
        if (check && !check.settled) {
          // Resolved without a conclusion emit — never observed on 6.8.9
          // (every resolution is preceded by update-available /
          // update-not-available); a defensive terminal so the UI can't sit
          // at "checking" forever under a future library. Asserts no
          // knowledge (see CheckOutcome's doc).
          check.settled = true
          apply({ type: "check-concluded", checkId: check.id, outcome: { kind: "settled-without-report" } })
        }
        flushParkedErrors()
        trackAutoDownload(result)
        // F8 (whole-branch review, P2 fix): `check !== null` is exactly "did
        // THIS call observe a real `checking-for-update` emit" — false for
        // electron-updater's own dev no-op (`AppUpdater.checkForUpdates()`
        // returns `Promise.resolve(null)` from `isUpdaterActive()` BEFORE
        // ever calling `doCheckForUpdates()`, which is where the emit lives
        // — verified against the installed 6.8.9 source), the SAME shape as
        // `shouldSkipCheck()` returning true: the promise resolves cleanly,
        // state never leaves "idle", and nothing was actually checked. Both
        // must report `performed: false` so a caller never mistakes "idle
        // because nothing ran" for "idle because a real check found
        // nothing new".
        return { performed: check !== null }
      },
      (err: unknown) => {
        concludeCheckFromRejection(check, err)
        // A rejection still means an attempt genuinely happened (the no-op
        // path never rejects — it resolves null before doing anything) —
        // moot for the caller's toast decision either way, since a
        // rejection always lands phase at "error", never "idle", but
        // reported honestly rather than defaulting to false.
        return { performed: true }
      },
    )
  }

  const scheduleCheck =
    options.scheduleCheck ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  // ALWAYS run at construction and ALWAYS schedule the timer — `runCheck()`
  // itself decides per-call whether to skip (P1 fix: the timer no longer
  // goes unscheduled just because the FIRST call happened to skip; each
  // firing re-evaluates `shouldSkipCheck()` on its own).
  void runCheck()
  const timer = scheduleCheck(() => void runCheck(), CHECK_INTERVAL_MS)

  return {
    getState: () => wireState,
    onState: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    download: async () => {
      // Nothing to download outside "available" — see this file's module
      // doc comment for why a stray call here is a no-op, not a throw.
      if (wireState.phase !== "available") return
      // Ownership goes through the SAME registry as autoDownload
      // (`trackDownloadPromise`), not a capture at this call's entry: 6.8.9
      // reuses a pending download promise, so this call can hand back a
      // download that BEGAN under an earlier, since-superseded operation
      // (v1 still preparing while v2 is the offered artifact). The registry
      // stamps the rejection with the operation that owned the promise at
      // first observation — the state dispatch (claim + update-failed)
      // happens in its single settle handler, exactly once no matter how
      // many callers share the promise. Awaited here only so the IPC caller
      // still observes the rejection, as before.
      let promise: Promise<unknown>
      try {
        promise = source.downloadUpdate()
      } catch (err) {
        // A SYNCHRONOUS throw — no promise was ever produced, so the
        // registry can't see this one. Reachable in the installed
        // Windows/Linux updater implementations, where
        // `provider.resolveFiles` / `findFile` throw before any promise
        // exists (malformed release metadata with no files is the concrete
        // case). It is still this download attempt's failure, for the
        // operation the download was requested for — the current artifact
        // (a sync throw implies no pending download existed to reuse, so
        // there is no prior owner to inherit) — and it must be
        // indistinguishable downstream from the async rejection: same
        // claim, same `update-failed`, same stamp. Without this, the IPC
        // caller saw the rejection while state stayed "available",
        // presenting a download that had just failed. Rethrown unchanged
        // for the caller.
        claimParkedError(err)
        dispatchUpdateFailed(err, reducerState.updateOpId)
        throw err
      }
      trackDownloadPromise(promise)
      await promise
    },
    restartAndInstall: () => {
      if (wireState.phase !== "ready") return false
      // F14: success is judged by a CALL-SCOPED probe, not by re-reading
      // global phase. `BaseUpdater.quitAndInstall()` can decline
      // SYNCHRONOUSLY (verified: `install()` returns false — installer file
      // missing, `doInstall()` threw — after routing the failure through
      // `dispatchError()`, i.e. an "error" emit on this same source, before
      // `quitAndInstall()` returns). The probe is set for exactly the
      // synchronous duration of the call, so the error handler above can
      // attribute such an emit to THIS install attempt no matter what else
      // is in flight — the old phase-read returned `true` when a concurrent
      // check's bookkeeping absorbed the emit, and
      // `performRestartAndInstall` then skipped its plain-quit fallback,
      // leaving a dead window (payload already shut down, no install, app
      // still open).
      // The operation this install attempt is FOR — the ready artifact's.
      // The call is synchronous, so nothing can supersede it mid-call; the
      // capture makes the stamp explicit rather than read-at-emit.
      const probe = { failed: false, updateOpId: reducerState.updateOpId }
      installProbe = probe
      try {
        source.quitAndInstall()
      } catch (err) {
        // 6.8.9 never throws here (install() catches internally), but a
        // throw IS this call's failure if it ever happens — degrade to a
        // reported failure, not an IPC-propagated exception.
        probe.failed = true
        dispatchUpdateFailed(err, probe.updateOpId)
      } finally {
        installProbe = null
      }
      return !probe.failed
    },
    // F1: the on-demand trigger runs through the SAME `runCheck()` as
    // construction and the timer, so it re-evaluates `shouldSkipCheck()`
    // itself — a user clicking "Check for updates" can't reintroduce the
    // ENOENT-into-permanent-error this guard prevents, but a build whose
    // stamp confirms a provider IS configured still gets a real check on
    // every click, exactly as if the guard didn't exist.
    // F3: returns `runCheck()`'s own promise so the caller (the IPC handler)
    // knows precisely when THIS click's check has settled.
    checkForUpdates: () => runCheck(),
    setAutoDownload: (value) => {
      desiredAutoDownload = value
      applyAutoDownload()
    },
    dispose: () => {
      timer.stop()
    },
  }
}
