/**
 * Coordinates the ONE child-shutdown operation shared by every quit-
 * triggering path in `main.ts`: ordinary quit (`before-quit`), "Restart to
 * update" (`performRestartAndInstall`, restart-and-install.ts), and the
 * `before-quit-for-update` backstop.
 *
 * ## Why a shared coordinator, and not each path running its own shutdown
 *
 * Follow-up to F1 (adversarial review of Phase 4): once "Restart to update"
 * shuts children down BEFORE calling `quitAndInstall()` — which can take up
 * to `SHUTDOWN_GRACE_MS` (10s) if the child ignores SIGTERM —
 * there is a real window where an ORDINARY quit (Cmd+Q, the Quit menu item)
 * can arrive WHILE that shutdown is still in flight. The plain `before-quit`
 * handler used to gate its own cleanup on a simple `quitting` boolean: "if
 * some other path already flipped this, step aside and trust it to call
 * `app.quit()` when it's done." That trust was misplaced here — the
 * update-restart path doesn't end in `app.quit()`, it ends in
 * `updater.restartAndInstall()` (→ `quitAndInstall()`), a DIFFERENT call. If
 * `before-quit` steps aside without calling `event.preventDefault()`,
 * Electron's own un-prevented default quit proceeds immediately, on its own
 * timeline, regardless of whether the update-restart's shutdown has actually
 * finished — reopening the exact "process exits before children are
 * confirmed dead" risk F1 closed, just via a second, concurrent trigger
 * instead of the original fire-and-forget event handler.
 *
 * The fix isn't "check a different boolean" — a boolean can't express "a
 * shutdown is IN FLIGHT" vs "a shutdown already SETTLED", and that
 * distinction is exactly what determines whether it's safe to let a quit
 * through un-prevented. This module tracks both, and memoizes the
 * underlying kill so two racing quit paths never run it twice in parallel
 * (`killChildrenBestEffort`'s own child-tracker calls are individually
 * idempotent too, but running the whole routine twice concurrently would
 * still be wasted work and a second `console.error` on failure).
 *
 * `quitting` (a separate, simple boolean `main.ts` still owns itself) keeps
 * its narrower, original job: preventing a SECOND "Restart to update" click
 * — or a duplicate `before-quit-for-update` firing — from re-entering
 * `performRestartAndInstall`'s own action. That's a different question from
 * "is it safe for a quit to proceed right now", which is what this
 * coordinator answers.
 *
 * Electron-free by the same reasoning as every other split-out module here
 * (`updater-reducer.ts`, `restart-and-install.ts`, `auto-download-mutation-queue.ts`)
 * — the ordering invariant needs to be provable with an injected fake
 * shutdown function, not a real child process or a real Electron `app`. See
 * `__tests__/child-shutdown-coordinator.test.ts`.
 *
 * ## The deadline (F9 of the second adversarial review pass)
 *
 * `killChildrenBestEffort` → `child-tracker.ts`'s `terminate()` only *sends*
 * SIGKILL on a timer; its own returned promise resolves EXCLUSIVELY from the
 * child's `exit` event. If a child never emits `exit` after SIGKILL — a
 * near-impossible-on-a-healthy-OS but not-actually-impossible case (a
 * zombie stuck in an uninterruptible syscall, PID/process-table weirdness)
 * — that promise never settles, and without a deadline HERE, neither would
 * `ensure()`'s. That would make BOTH consumers hang forever: "Restart to
 * update" would sit there never quitting, never installing, no error, no
 * escape — worse than the leak F1 was fixing — and an ordinary quit racing
 * in behind it would ALSO wait forever on the same shared promise.
 *
 * `deadlineMs` bounds `ensure()`'s returned promise unconditionally: if the
 * underlying `shutdown()` hasn't settled by then, this REJECTS with
 * `ShutdownDeadlineExceededError` — not a silent resolve. A silent resolve
 * would look identical to "confirmed dead" to `performRestartAndInstall`
 * (restart-and-install.ts), which would then proceed to call
 * `quitAndInstall()` while the child might still be alive — exactly the
 * unsafe-install risk F1 exists to prevent. A rejection lets that caller
 * tell the two cases apart and abort instead of proceeding blind (F10 covers
 * what "abort" means once shutdown DOES succeed but the install itself is no
 * longer authorized — a related but distinct failure mode). For the ordinary
 * `before-quit` path, a rejection is still fine to treat as "settled, quit
 * anyway" — see main.ts's own handler.
 */

/** Thrown by `ensure()` when the underlying shutdown does not settle within `deadlineMs`. */
export class ShutdownDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`Child shutdown did not settle within ${deadlineMs}ms`)
    this.name = "ShutdownDeadlineExceededError"
  }
}

export interface ChildShutdownCoordinatorOptions {
  /** Bounds `ensure()`'s returned promise so it ALWAYS settles — see this module's doc comment on why a silent resolve on timeout would be unsafe. */
  deadlineMs: number
  /** Injected for tests — replaces `setTimeout`/`clearTimeout`. Defaults to real timers, `.unref()`'d so a pending deadline can never hold the process open on its own. */
  scheduleTimeout?: (fn: () => void, ms: number) => { cancel: () => void }
}

const defaultScheduleTimeout = (fn: () => void, ms: number): { cancel: () => void } => {
  const handle = setTimeout(fn, ms)
  handle.unref()
  return { cancel: () => clearTimeout(handle) }
}

export interface ChildShutdownCoordinator {
  /**
   * Starts the shutdown on the first call. Every later call — including a
   * concurrent one from a different quit-triggering path — gets back the
   * SAME promise rather than kicking off a second parallel kill sequence.
   * Bounded by `deadlineMs`: rejects with `ShutdownDeadlineExceededError` if
   * the underlying shutdown hasn't settled in time — see this module's doc
   * comment.
   */
  ensure(): Promise<void>
  /** True once `ensure()`'s promise has actually settled (resolved OR rejected, including via the deadline) — not merely started. */
  isSettled(): boolean
}

export function createChildShutdownCoordinator(
  shutdown: () => Promise<void>,
  options: ChildShutdownCoordinatorOptions,
): ChildShutdownCoordinator {
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout
  let promise: Promise<void> | null = null
  let settled = false

  function ensure(): Promise<void> {
    if (!promise) {
      promise = new Promise<void>((resolve, reject) => {
        const timer = scheduleTimeout(() => {
          reject(new ShutdownDeadlineExceededError(options.deadlineMs))
        }, options.deadlineMs)
        shutdown().then(
          () => {
            timer.cancel()
            resolve()
          },
          (err: unknown) => {
            timer.cancel()
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      }).finally(() => {
        settled = true
      })
    }
    return promise
  }

  return {
    ensure,
    isSettled: () => settled,
  }
}
