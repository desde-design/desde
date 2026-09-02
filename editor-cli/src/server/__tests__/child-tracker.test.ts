/**
 * `createChildTracker` is what closes the orphan defect measured by the
 * Phase 1 packaging gate's leg 9: `defaultSpawnEditor` (launcher-server.ts)
 * spawns a per-project editor with `detached: false` and forgets about it, so
 * a SIGTERM aimed at the launcher's own PID (what an Electron main process
 * sends on app quit — a terminal's Ctrl-C hits the whole process group
 * instead, which is why this went unnoticed) leaves the grandchild running
 * forever.
 *
 * These tests exercise the tracker in isolation, against a fake `ChildProcess`
 * driven entirely by an injected `Killer` — no real process is spawned and no
 * real wall-clock wait is asserted on. The grace period is real (a genuine
 * `setTimeout`), but the OUTCOME each test checks depends only on what the
 * injected killer did, never on how long that timer took to fire. See
 * `tasks/scripts/payload-gate.mts` leg 9 for the live, real-process proof of
 * the same defect.
 */
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { createChildTracker, type Killer } from "../child-tracker.js"

/**
 * A minimal stand-in for `ChildProcess`: enough surface for the tracker
 * (`once("exit", …)`, `exitCode`, `signalCode`) plus a test-only
 * `simulateExit` the injected killer calls to drive it. Real signal delivery
 * is exactly what `Killer` exists to keep out of this suite.
 *
 * `exitCode`/`signalCode` are declared read-only on the real `ChildProcess`
 * type, so they're backed here by `Object.defineProperty` getters (a method
 * call, not an assignment expression) rather than plain field writes.
 */
function fakeChild(): ChildProcess & { simulateExit: () => void } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { simulateExit: () => void }
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  Object.defineProperty(emitter, "exitCode", { get: () => exitCode, configurable: true })
  Object.defineProperty(emitter, "signalCode", { get: () => signalCode, configurable: true })
  emitter.simulateExit = () => {
    exitCode = 0
    signalCode = null
    emitter.emit("exit", 0, null)
  }
  return emitter
}

describe("createChildTracker", () => {
  it("untracks a child that exits on its own, and never signals it afterward", async () => {
    const killer = vi.fn<Killer>()
    const tracker = createChildTracker({ killer })
    const child = fakeChild()

    tracker.track(child)
    child.simulateExit() // e.g. Ctrl-C already killed it via the process group

    await tracker.shutdown()

    // Untracked, not merely dead: shutdown() must not even attempt a signal
    // on a handle it no longer holds — the whole point being that the OS may
    // since have recycled the pid for something unrelated.
    expect(killer).not.toHaveBeenCalled()
  })

  it("signals a live tracked child with SIGTERM on shutdown", async () => {
    const killer = vi.fn<Killer>((child, signal) => {
      // A well-behaved child: SIGTERM is enough, so the shutdown() promise
      // resolves without ever reaching the SIGKILL escalation.
      if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
    })
    const tracker = createChildTracker({ killer, graceMs: 50_000 })
    const child = fakeChild()
    tracker.track(child)

    await tracker.shutdown()

    expect(killer).toHaveBeenCalledTimes(1)
    expect(killer).toHaveBeenCalledWith(child, "SIGTERM")
  })

  it("escalates to SIGKILL when the child ignores SIGTERM past the grace period", async () => {
    const calls: NodeJS.Signals[] = []
    const killer = vi.fn<Killer>((child, signal) => {
      calls.push(signal)
      // Ignore SIGTERM entirely (the hung-child case); only SIGKILL "works".
      if (signal === "SIGKILL") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
    })
    // Short but real grace period — the assertion below is on the ORDER of
    // calls the injected killer recorded, not on how many milliseconds
    // elapsed, so this is not a race.
    const tracker = createChildTracker({ killer, graceMs: 20 })
    const child = fakeChild()
    tracker.track(child)

    await tracker.shutdown()

    expect(calls).toEqual(["SIGTERM", "SIGKILL"])
  })

  it("is a no-op when there are no tracked children", async () => {
    const killer = vi.fn<Killer>()
    const tracker = createChildTracker({ killer })

    await expect(tracker.shutdown()).resolves.toBeUndefined()
    expect(killer).not.toHaveBeenCalled()
  })

  it("is idempotent — a second shutdown() call finds nothing left to signal", async () => {
    const killer = vi.fn<Killer>((child, signal) => {
      if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
    })
    const tracker = createChildTracker({ killer })
    const child = fakeChild()
    tracker.track(child)

    await tracker.shutdown()
    expect(killer).toHaveBeenCalledTimes(1)

    // Second call: the child is already gone and already untracked. Must
    // resolve harmlessly rather than hang or re-signal.
    await expect(tracker.shutdown()).resolves.toBeUndefined()
    expect(killer).toHaveBeenCalledTimes(1)
  })

  it("tracks and terminates multiple children independently", async () => {
    const killer = vi.fn<Killer>((child, signal) => {
      if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
    })
    const tracker = createChildTracker({ killer })
    const a = fakeChild()
    const b = fakeChild()
    tracker.track(a)
    tracker.track(b)

    await tracker.shutdown()

    expect(killer).toHaveBeenCalledWith(a, "SIGTERM")
    expect(killer).toHaveBeenCalledWith(b, "SIGTERM")
    expect(killer).toHaveBeenCalledTimes(2)
  })

  /**
   * The race this suite exists to close (see the module doc comment on
   * `track`): a child arrives via `track()` AFTER `shutdown()` has already
   * taken its snapshot. Modeled deterministically — no real `setTimeout`
   * race, no real process — by calling `track()` on a fresh child only
   * once `shutdown()` has fully resolved. Before the closing-state fix,
   * this child would join `children` and then sit there forever: nothing
   * ever iterates that set again, so it is never signaled and its handle
   * is simply leaked.
   */
  describe("closing state — the launcher-shutdown race", () => {
    it("isClosing() is false before shutdown() and true once it has been called", async () => {
      const tracker = createChildTracker({ killer: vi.fn<Killer>() })
      expect(tracker.isClosing()).toBe(false)

      const done = tracker.shutdown()
      // True the instant shutdown() is invoked — synchronously, before its
      // own promise has had any chance to resolve. This is the property
      // `defaultSpawnEditor`'s pre-spawn check depends on.
      expect(tracker.isClosing()).toBe(true)

      await done
      expect(tracker.isClosing()).toBe(true)
    })

    it("terminates a child handed to track() AFTER shutdown() has already resolved, instead of adding it to the tracked set and leaking it", async () => {
      const killer = vi.fn<Killer>((child, signal) => {
        if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
      })
      const tracker = createChildTracker({ killer })

      await tracker.shutdown() // Nothing tracked yet — resolves immediately.
      expect(killer).not.toHaveBeenCalled()

      // The race: an in-flight spawn (e.g. defaultSpawnEditor still awaiting
      // pickFreePort() when shutdown() ran) only reaches track() now.
      const late = fakeChild()
      tracker.track(late)

      // Terminated right away — not silently added to a set nobody will
      // ever revisit again.
      expect(killer).toHaveBeenCalledTimes(1)
      expect(killer).toHaveBeenCalledWith(late, "SIGTERM")
    })

    it("terminates a child handed to track() DURING shutdown() — before shutdown()'s own promise has settled", async () => {
      const killer = vi.fn<Killer>((child, signal) => {
        if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
      })
      const tracker = createChildTracker({ killer })
      const alreadyTracked = fakeChild()
      tracker.track(alreadyTracked)

      // Deliberately not awaited yet — models the moment shutdown() has
      // begun (closing flipped synchronously) but is still resolving the
      // children it already held.
      const done = tracker.shutdown()
      expect(tracker.isClosing()).toBe(true)

      const late = fakeChild()
      tracker.track(late)
      expect(killer).toHaveBeenCalledWith(late, "SIGTERM")

      await done
      expect(killer).toHaveBeenCalledWith(alreadyTracked, "SIGTERM")
      expect(killer).toHaveBeenCalledTimes(2)
    })

    it("still escalates a late-tracked child to SIGKILL if it ignores SIGTERM past the grace period", async () => {
      const calls: NodeJS.Signals[] = []
      const killer = vi.fn<Killer>((child, signal) => {
        calls.push(signal)
        if (signal === "SIGKILL") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
      })
      const tracker = createChildTracker({ killer, graceMs: 20 })

      await tracker.shutdown()
      const late = fakeChild()
      tracker.track(late)

      // The immediate-kill path uses the same escalation timer as a normal
      // shutdown — give it a moment to fire rather than asserting only the
      // synchronous SIGTERM call.
      await new Promise((r) => setTimeout(r, 50))
      expect(calls).toEqual(["SIGTERM", "SIGKILL"])
    })

    it("a child handed to track() before shutdown() begins is tracked normally, not immediately killed", async () => {
      const killer = vi.fn<Killer>((child, signal) => {
        if (signal === "SIGTERM") (child as ChildProcess & { simulateExit: () => void }).simulateExit()
      })
      const tracker = createChildTracker({ killer })
      expect(tracker.isClosing()).toBe(false)

      const early = fakeChild()
      tracker.track(early) // Not closing yet — goes into the normal tracked set.
      expect(killer).not.toHaveBeenCalled()

      await tracker.shutdown()
      expect(killer).toHaveBeenCalledWith(early, "SIGTERM")
      expect(killer).toHaveBeenCalledTimes(1)
    })
  })
})
