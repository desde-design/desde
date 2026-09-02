/**
 * `createChildShutdownCoordinator` (F1 follow-up, adversarial review of
 * Phase 4) — proves the properties `main.ts`'s `before-quit` handler and
 * `performRestartAndInstall` (restart-and-install.ts) depend on:
 *
 *  1. `ensure()` is memoized — two callers (an ordinary quit racing an
 *     in-flight "Restart to update") share the SAME underlying shutdown,
 *     never running it twice in parallel.
 *  2. `isSettled()` is false for the whole duration the shutdown is running,
 *     and only flips true once it has actually finished — the exact
 *     distinction a plain boolean "quitting" flag couldn't make, which is
 *     what let an ordinary quit step aside too early in the bug this
 *     closes.
 *  3. (F9, second review pass) `ensure()`'s returned promise ALWAYS
 *     settles, even if the underlying shutdown never does — bounded by
 *     `deadlineMs`, proven with an injected fake timer rather than a real
 *     one, so nothing here waits on wall-clock time.
 *
 * Same house pattern as `child-tracker.test.ts` / `restart-and-install.test.ts`:
 * a deferred promise (and, for the deadline, a manually-fired fake timer)
 * the test drives explicitly, so the assertions are about WHAT HAPPENED IN
 * WHAT ORDER, never about how long anything took.
 */
import { describe, expect, it, vi } from "vitest"
import {
  createChildShutdownCoordinator,
  ShutdownDeadlineExceededError,
} from "../child-shutdown-coordinator.js"

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A fake `scheduleTimeout` the test fires manually — no real setTimeout involved. */
function fakeScheduleTimeout(): {
  schedule: (fn: () => void, ms: number) => { cancel: () => void }
  fire: () => void
  isCancelled: () => boolean
  calls: Array<{ ms: number }>
} {
  const calls: Array<{ ms: number }> = []
  let pendingFn: (() => void) | undefined
  let cancelled = false
  return {
    schedule: (fn, ms) => {
      calls.push({ ms })
      pendingFn = fn
      cancelled = false
      return { cancel: () => { cancelled = true } }
    },
    fire: () => pendingFn?.(),
    isCancelled: () => cancelled,
    calls,
  }
}

const DEADLINE_MS = 15_000

describe("createChildShutdownCoordinator", () => {
  it("ensure() runs the underlying shutdown exactly once even when called multiple times before it settles", async () => {
    const shutdown = deferred<void>()
    const runShutdown = vi.fn(() => shutdown.promise)
    const coordinator = createChildShutdownCoordinator(runShutdown, { deadlineMs: DEADLINE_MS })

    const first = coordinator.ensure()
    const second = coordinator.ensure() // a second, concurrent caller (e.g. ordinary quit racing a restart click)

    expect(runShutdown).toHaveBeenCalledTimes(1)
    expect(second).toBe(first) // the SAME promise, not a second parallel run

    shutdown.resolve()
    await first
    await second
  })

  it("ensure() called AGAIN after the shutdown has already settled does not re-run it", async () => {
    const runShutdown = vi.fn(async () => {})
    const coordinator = createChildShutdownCoordinator(runShutdown, { deadlineMs: DEADLINE_MS })

    await coordinator.ensure()
    await coordinator.ensure()

    expect(runShutdown).toHaveBeenCalledTimes(1)
  })

  it("isSettled() is false while the shutdown is still running, and only true once it has actually finished", async () => {
    const shutdown = deferred<void>()
    const coordinator = createChildShutdownCoordinator(() => shutdown.promise, { deadlineMs: DEADLINE_MS })

    expect(coordinator.isSettled()).toBe(false)
    const pending = coordinator.ensure()
    expect(coordinator.isSettled()).toBe(false) // started, not finished

    shutdown.resolve()
    await pending
    expect(coordinator.isSettled()).toBe(true)
  })

  it("isSettled() flips true even when the underlying shutdown REJECTS — a failure still counts as 'done', not 'still running'", async () => {
    const shutdown = deferred<void>()
    const coordinator = createChildShutdownCoordinator(() => shutdown.promise, { deadlineMs: DEADLINE_MS })

    const pending = coordinator.ensure().catch(() => {}) // the coordinator itself doesn't swallow — this is just so the test's own await doesn't throw
    expect(coordinator.isSettled()).toBe(false)

    shutdown.reject(new Error("kill failed"))
    await pending

    expect(coordinator.isSettled()).toBe(true)
  })

  /**
   * F9 (second adversarial review pass). `child-tracker.ts`'s `terminate()`
   * only *sends* SIGKILL on its own grace-period timer — its promise
   * resolves EXCLUSIVELY from the child's `exit` event. If a child never
   * emits `exit` even after SIGKILL, that promise never settles, and
   * without a deadline here, `ensure()`'s wouldn't either — "Restart to
   * update" would hang forever with no error, and an ordinary quit racing
   * in behind it would ALSO wait forever on the same shared promise.
   */
  describe("F9: the deadline", () => {
    it("ensure() rejects with ShutdownDeadlineExceededError if the underlying shutdown never settles — proven by firing an injected timer, not waiting on a real one", async () => {
      const shutdown = vi.fn(() => new Promise<void>(() => {})) // never resolves, never rejects
      const timer = fakeScheduleTimeout()
      const coordinator = createChildShutdownCoordinator(shutdown, {
        deadlineMs: DEADLINE_MS,
        scheduleTimeout: timer.schedule,
      })

      const pending = coordinator.ensure()
      expect(coordinator.isSettled()).toBe(false)
      expect(timer.calls).toEqual([{ ms: DEADLINE_MS }])

      // Fire the deadline — no real time has passed.
      timer.fire()

      await expect(pending).rejects.toBeInstanceOf(ShutdownDeadlineExceededError)
      expect(coordinator.isSettled()).toBe(true)
    })

    it("cancels the deadline timer once the underlying shutdown settles normally, so a late-firing timer can't do anything after the fact", async () => {
      const shutdown = vi.fn(async () => {})
      const timer = fakeScheduleTimeout()
      const coordinator = createChildShutdownCoordinator(shutdown, {
        deadlineMs: DEADLINE_MS,
        scheduleTimeout: timer.schedule,
      })

      await coordinator.ensure()

      expect(timer.isCancelled()).toBe(true)
    })

    it("cancels the deadline timer when the underlying shutdown rejects on its own, before the deadline", async () => {
      const shutdown = vi.fn(async () => {
        throw new Error("kill failed")
      })
      const timer = fakeScheduleTimeout()
      const coordinator = createChildShutdownCoordinator(shutdown, {
        deadlineMs: DEADLINE_MS,
        scheduleTimeout: timer.schedule,
      })

      await expect(coordinator.ensure()).rejects.toThrow("kill failed")

      expect(timer.isCancelled()).toBe(true)
    })

    it("a later ensure() call after a deadline timeout returns the SAME rejected promise, rather than starting a fresh attempt", async () => {
      const shutdown = vi.fn(() => new Promise<void>(() => {}))
      const timer = fakeScheduleTimeout()
      const coordinator = createChildShutdownCoordinator(shutdown, {
        deadlineMs: DEADLINE_MS,
        scheduleTimeout: timer.schedule,
      })

      const first = coordinator.ensure()
      timer.fire()
      await expect(first).rejects.toBeInstanceOf(ShutdownDeadlineExceededError)

      const second = coordinator.ensure()
      expect(second).toBe(first)
      expect(shutdown).toHaveBeenCalledTimes(1)
    })
  })
})
