/**
 * `performRestartAndInstall` (F1 of the adversarial review of Phase 4) — the
 * ordered "Restart to update" routine that replaced a fire-and-forget child
 * shutdown started from the `before-quit-for-update` event (see
 * `restart-and-install.ts`'s own doc comment for the bug that closes).
 *
 * These tests prove the ORDERING invariant — `shutdownChildren()` resolves
 * BEFORE `restartAndInstall()` is ever called — with an injected, manually
 * resolved promise rather than a real child process or wall-clock timing.
 * Same house pattern as `child-tracker.test.ts`: a fake collaborator whose
 * completion is driven explicitly by the test, so the assertion is about
 * WHAT HAPPENED IN WHAT ORDER, not about how long anything took.
 *
 * Also covers F9 and F10 (second adversarial review pass): what happens when
 * `shutdownChildren()` itself fails (F9 — see child-shutdown-coordinator.ts
 * for where the deadline that makes this possible, rather than an infinite
 * hang, comes from) and what happens when `restartAndInstall()` reports it
 * did NOT actually trigger the install (F10 — the updater's phase moved on
 * during the shutdown wait).
 */
import { describe, expect, it, vi } from "vitest"
import { performRestartAndInstall, type RestartAndInstallDeps } from "../restart-and-install.js"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Base deps with every callback a no-op `vi.fn()` — individual tests override what they're testing. */
function baseDeps(overrides: Partial<RestartAndInstallDeps> = {}): RestartAndInstallDeps {
  return {
    getPhase: () => "ready",
    isQuitting: () => false,
    markQuitting: vi.fn(),
    shutdownChildren: vi.fn(async () => {}),
    restartAndInstall: vi.fn(() => true),
    onShutdownFailed: vi.fn(),
    onInstallNoLongerAuthorized: vi.fn(),
    ...overrides,
  }
}

describe("performRestartAndInstall — ordering (F1)", () => {
  it("calls restartAndInstall() only AFTER shutdownChildren() resolves — not before, not concurrently", async () => {
    const calls: string[] = []
    const shutdown = deferred<void>()
    const shutdownChildren = vi.fn(() => shutdown.promise)
    const restartAndInstall = vi.fn(() => {
      calls.push("restart-and-install")
      return true
    })

    const done = performRestartAndInstall(baseDeps({ shutdownChildren, restartAndInstall }))

    // Let the microtask queue turn — shutdownChildren() has been invoked...
    await Promise.resolve()
    await Promise.resolve()
    expect(shutdownChildren).toHaveBeenCalledTimes(1)
    // ...but restartAndInstall() must NOT have fired yet. This is the crux
    // of the fix: proving the child is gone BEFORE quitAndInstall() is
    // invoked, not merely that it eventually happens.
    expect(restartAndInstall).not.toHaveBeenCalled()
    expect(calls).toEqual([])

    // The child (or its SIGKILL escalation) finally exits.
    calls.push("shutdown-resolved")
    shutdown.resolve()
    await done

    expect(calls).toEqual(["shutdown-resolved", "restart-and-install"])
    expect(restartAndInstall).toHaveBeenCalledTimes(1)
  })

  it("is a no-op outside phase 'ready' — never touches children or install (mirrors updater.ts's own guard)", async () => {
    const deps = baseDeps({ getPhase: () => "available" })

    await performRestartAndInstall(deps)

    expect(deps.shutdownChildren).not.toHaveBeenCalled()
    expect(deps.restartAndInstall).not.toHaveBeenCalled()
  })

  it("is a no-op if a quit has already started elsewhere (e.g. an ordinary quit racing a restart click)", async () => {
    const deps = baseDeps({ isQuitting: () => true })

    await performRestartAndInstall(deps)

    expect(deps.shutdownChildren).not.toHaveBeenCalled()
    expect(deps.restartAndInstall).not.toHaveBeenCalled()
  })

  it("marks quitting synchronously, before the first await — a concurrent second call sees it immediately", () => {
    let quitting = false
    const deps: RestartAndInstallDeps = baseDeps({
      isQuitting: () => quitting,
      markQuitting: () => {
        quitting = true
      },
      shutdownChildren: () => new Promise<void>(() => {}), // never resolves in this test
    })

    void performRestartAndInstall(deps)

    // True the instant performRestartAndInstall() is invoked — synchronously,
    // before its own promise has had any chance to resolve. This is the
    // property the IPC handler's "don't double-trigger shutdown" behavior
    // depends on, same reasoning as child-tracker.ts's `isClosing()`.
    expect(quitting).toBe(true)
  })
})

/**
 * F9 (second adversarial review pass) — a hung shutdown must not leave
 * "Restart to update" hanging forever with no error. `shutdownChildren()`
 * is `main.ts`'s deadline-bounded `childShutdown.ensure()`
 * (child-shutdown-coordinator.ts), which is guaranteed to eventually
 * REJECT rather than hang if the child never confirms it's gone. This
 * module's job is to react correctly to that rejection: never call
 * restartAndInstall() on an unconfirmed shutdown, and never leave the
 * rejection as a silent unhandled one either.
 */
describe("performRestartAndInstall — F9: shutdownChildren() failing aborts the install instead of hanging or proceeding blind", () => {
  it("calls onShutdownFailed and does NOT call restartAndInstall() when shutdownChildren() rejects", async () => {
    const error = new Error("child shutdown did not settle within 15000ms")
    const deps = baseDeps({
      shutdownChildren: vi.fn(async () => {
        throw error
      }),
    })

    await performRestartAndInstall(deps)

    expect(deps.onShutdownFailed).toHaveBeenCalledWith(error)
    expect(deps.restartAndInstall).not.toHaveBeenCalled()
    expect(deps.onInstallNoLongerAuthorized).not.toHaveBeenCalled()
  })

  it("resolves normally rather than rejecting — the caller (main.ts's IPC handler) must not see an unhandled rejection", async () => {
    const deps = baseDeps({
      shutdownChildren: vi.fn(async () => {
        throw new Error("kill failed")
      }),
    })

    await expect(performRestartAndInstall(deps)).resolves.toBe("failed")
  })
})

/**
 * F10 (second adversarial review pass) — shutdown can succeed while the
 * updater's own phase moves on during the wait (e.g. a newer
 * `update-available` arrives), making `restartAndInstall()` a silent no-op
 * by ITS OWN "ready"-only guard (updater.ts). Before this fix, that left
 * the payload child dead (shutdown already ran) with nothing else
 * happening — no install, no quit, just a window with no server behind it.
 */
describe("performRestartAndInstall — F10: an install that's no longer authorized after shutdown does not leave a dead shell", () => {
  it("calls onInstallNoLongerAuthorized when restartAndInstall() returns false", async () => {
    const deps = baseDeps({
      restartAndInstall: vi.fn(() => false),
    })

    await performRestartAndInstall(deps)

    expect(deps.restartAndInstall).toHaveBeenCalledTimes(1)
    expect(deps.onInstallNoLongerAuthorized).toHaveBeenCalledTimes(1)
    expect(deps.onShutdownFailed).not.toHaveBeenCalled()
  })

  it("does NOT call onInstallNoLongerAuthorized when restartAndInstall() returns true (the normal, successful path)", async () => {
    const deps = baseDeps({
      restartAndInstall: vi.fn(() => true),
    })

    await performRestartAndInstall(deps)

    expect(deps.onInstallNoLongerAuthorized).not.toHaveBeenCalled()
  })
})

describe("performRestartAndInstall — the outcome the renderer's 'Restarting to update' state reads", () => {
  it("reports 'installing' once shutdown resolved and restartAndInstall() accepted", async () => {
    await expect(performRestartAndInstall(baseDeps())).resolves.toBe("installing")
  })

  it("reports 'failed' when shutdownChildren() rejects — the app stays open, so the dialog must stand down", async () => {
    const deps = baseDeps({
      shutdownChildren: vi.fn(async () => {
        throw new Error("deadline")
      }),
    })
    await expect(performRestartAndInstall(deps)).resolves.toBe("failed")
    expect(deps.onShutdownFailed).toHaveBeenCalledTimes(1)
  })

  it("reports 'ignored' outside phase 'ready', while already quitting, and when the install was no longer authorized", async () => {
    await expect(performRestartAndInstall(baseDeps({ getPhase: () => "available" }))).resolves.toBe("ignored")
    await expect(performRestartAndInstall(baseDeps({ isQuitting: () => true }))).resolves.toBe("ignored")
    const deps = baseDeps({ restartAndInstall: vi.fn(() => false) })
    await expect(performRestartAndInstall(deps)).resolves.toBe("ignored")
    expect(deps.onInstallNoLongerAuthorized).toHaveBeenCalledTimes(1)
  })
})
