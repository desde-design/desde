/**
 * The ordered "Restart to update" routine (F1 of the adversarial review of
 * Phase 4) — shut the payload child down FIRST, then trigger
 * `quitAndInstall()`, instead of racing a fire-and-forget shutdown against
 * Electron's own quit sequence.
 *
 * ## The bug this replaces
 *
 * The original wiring started child shutdown from `main.ts`'s
 * `nativeAutoUpdater.on("before-quit-for-update", ...)` handler. That event
 * fires SYNCHRONOUSLY as part of `quitAndInstall()` itself (confirmed
 * against `electron-updater`'s own source: `BaseUpdater.quitAndInstall()`
 * emits it and calls `app.quit()` in the SAME `setImmediate` callback; on
 * mac, `MacUpdater` routes through Electron's native `autoUpdater`, which
 * does the equivalent). The event is not cancelable — there is no
 * `event.preventDefault()` available — so Electron proceeds to close windows
 * and quit the instant the handler RETURNS, regardless of what async work it
 * kicked off. A fire-and-forget `void killChildrenBestEffort()` inside that
 * handler could not delay anything: if the payload child ignored SIGTERM,
 * the whole app process could exit before the 10-second SIGKILL escalation
 * ever fired, leaving the child (or its descendants) alive and possibly
 * holding update files open — on the exact path where files are being
 * replaced.
 *
 * ## The fix
 *
 * Run the shutdown BEFORE ever calling `restartAndInstall()` (which is what
 * triggers `quitAndInstall()`), and only call `restartAndInstall()` once
 * shutdown has resolved. `killChildrenBestEffort` (main.ts) is already
 * bounded — SIGTERM, then SIGKILL after `SHUTDOWN_GRACE_MS` (child.ts's 10s),
 * escalating through `child-tracker.ts` — so this doesn't need its own
 * separate timeout; it inherits the same 10s bound the event handler used to
 * rely on, just run to completion FIRST instead of raced against it.
 *
 * The plain `before-quit` handler (ordinary quit, e.g. Cmd+Q) is untouched —
 * it already does its own child shutdown, bounded the same way, before
 * calling `app.quit()` a second time. `before-quit-for-update` stays wired
 * in main.ts too, as a defense-in-depth backstop for any future path that
 * might call `quitAndInstall()` outside this routine; by the time it fires
 * here, `quitting` is already `true` and it steps aside.
 *
 * ## F9 (second review pass) — the wait itself must not be able to hang forever
 *
 * `shutdownChildren` is `main.ts`'s shared `childShutdown.ensure()`
 * (child-shutdown-coordinator.ts), which is deadline-bounded — see that
 * module's own doc comment for why. If it rejects (the deadline fired, or
 * any other shutdown failure), this function does NOT proceed to
 * `restartAndInstall()`: the install must never run on an UNCONFIRMED
 * shutdown, since `quitAndInstall()` could then be racing a still-alive
 * child on the exact path where update files are replaced — the original
 * defect this whole routine exists to prevent. `onShutdownFailed` is called
 * instead, so the caller (main.ts) can surface a real error rather than the
 * app just sitting there.
 *
 * ## F10 (second review pass) — the authorized install can evaporate during the wait
 *
 * `getPhase() === "ready"` is checked once, at the START. Shutdown can take
 * several seconds; during that window the updater's OWN state can move on
 * (e.g. a newer `update-available` arrives from a periodic or on-demand
 * check, and `ready` becomes `available` — see `updater-reducer.ts`'s
 * "update-available while ready DOES override" rule). `restartAndInstall()`
 * re-checks phase itself and silently no-ops outside `"ready"` — by design,
 * for a stray/duplicate trigger. But here, if that happens, the payload
 * child is ALREADY dead (shutdown already succeeded) and NOTHING else was
 * going to run: no install, no quit, just a `BrowserWindow` left open
 * pointing at a server that no longer exists. `restartAndInstall` now
 * reports (via its boolean return — see `Updater.restartAndInstall()` in
 * updater.ts) whether it actually triggered the install; when it didn't,
 * `onInstallNoLongerAuthorized` runs instead, so the caller can fall back to
 * a plain quit rather than leaving a dead shell on screen.
 *
 * ## Why this is its own module
 *
 * `main.ts` imports `electron` at module load, which isn't something a
 * plain vitest environment can execute — so the ordering invariant this file
 * exists to guarantee ("children are gone before `restartAndInstall()` is
 * invoked") has to live somewhere Electron-free to be testable at all. Same
 * reasoning as `updater-reducer.ts`'s own split from `updater.ts`. See
 * `__tests__/restart-and-install.test.ts`, which proves the ordering with
 * injected fakes and a deferred promise — no real child process, no real
 * Electron `app`, no wall-clock timing (the house pattern:
 * `child-tracker.test.ts`).
 */

export interface RestartAndInstallDeps {
  /** The updater's current phase — mirrors `updater.ts`'s own "ready"-only guard on `restartAndInstall()`, so a stray trigger (e.g. a duplicate IPC message) stays a no-op instead of tearing down children for nothing. */
  getPhase: () => string
  /** True once ANY quit path — ordinary or update-restart — has already started. A second trigger arriving mid-shutdown must not re-run it or race the first. */
  isQuitting: () => boolean
  /** Marks the quit as started. Called synchronously, before the first `await`, matching `child-tracker.ts`'s own closing-state race-freedom pattern — a concurrent call sees the flag immediately, not after some later microtask. */
  markQuitting: () => void
  /** Terminates the tracked children, resolving once they're gone — or REJECTING once a deadline gives up waiting for confirmation (see this module's F9 doc comment). Never hangs forever. */
  shutdownChildren: () => Promise<void>
  /** The real `Updater.restartAndInstall()` call (→ `quitAndInstall()`) — only ever reached once `shutdownChildren()` has resolved. Returns whether it actually triggered the install (false means the phase moved on during the wait — see this module's F10 doc comment). */
  restartAndInstall: () => boolean
  /** Called INSTEAD of `restartAndInstall()` if `shutdownChildren()` rejects. The install must never proceed on an unconfirmed shutdown. */
  onShutdownFailed: (err: unknown) => void
  /** Called if `restartAndInstall()` returns `false` — shutdown succeeded, but the install is no longer authorized (the updater's phase moved on during the wait). The caller should not leave the app sitting open with a dead payload child behind it. */
  onInstallNoLongerAuthorized: () => void
}

export async function performRestartAndInstall(deps: RestartAndInstallDeps): Promise<void> {
  if (deps.getPhase() !== "ready") return
  if (deps.isQuitting()) return
  deps.markQuitting()
  try {
    await deps.shutdownChildren()
  } catch (err) {
    deps.onShutdownFailed(err)
    return
  }
  const installed = deps.restartAndInstall()
  if (!installed) {
    deps.onInstallNoLongerAuthorized()
  }
}
