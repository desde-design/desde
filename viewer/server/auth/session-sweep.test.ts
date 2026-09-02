import { describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import type { StorageAdapter } from "../storage/types"
import { runSessionSweepTick, startSessionSweep } from "./session-sweep"
import { upsertTestUser } from "../__tests__/user-fixtures"

/**
 * Wraps a real StorageAdapter but makes `deleteExpiredSessions` reject —
 * same `Proxy`-over-a-real-adapter technique as `current-user.test.ts`'s
 * `makeStorageThatRejects`, used here to force the failure path without a
 * hand-rolled fake that would drift from the real interface.
 */
function makeStorageThatRejectsSweep(inner: StorageAdapter): StorageAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "deleteExpiredSessions") {
        return async () => {
          throw new Error("simulated storage failure in deleteExpiredSessions")
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

async function seedExpiredSession(storage: StorageAdapter) {
  const user = await upsertTestUser(storage, {
    provider: "github",
    providerUserId: "1",
    email: "mo@example.com",
    displayName: "Mo",
    avatarUrl: "",
  })
  return storage.createSession({
    userId: user.id,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
}

describe("sign-in token sweep (viewer-membership Task 14)", () => {
  /**
   * `POST /auth/magic-link` is unauthenticated, and on an instance with a
   * domain rule every address at that domain is a row an anonymous caller can
   * cause to be written. Nothing else deletes these — redemption sets
   * `usedAt` — so this tick is the only thing standing between that route and
   * a table that only grows.
   */
  it("deletes expired sign-in tokens and leaves live ones", async () => {
    const storage = new InMemoryStorage()
    const dead = await storage.createSignInToken({
      id: "aaaaaaaaaaaaaaa1",
      userId: null,
      email: "dead@example.com",
      tokenHash: "h",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const live = await storage.createSignInToken({
      id: "aaaaaaaaaaaaaaa2",
      userId: null,
      email: "live@example.com",
      tokenHash: "h",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await runSessionSweepTick({ storage })

    expect(await storage.getSignInToken(dead.id)).toBeNull()
    expect(await storage.getSignInToken(live.id)).not.toBeNull()
  })

  /**
   * The two passes have their own try/catch on purpose. Sharing one would let
   * a busy `sessions` delete silently cancel the sign-in-token pass for that
   * tick — and the two tables have no reason to fail together.
   */
  it("still sweeps sign-in tokens when the SESSION pass fails", async () => {
    const inner = new InMemoryStorage()
    const dead = await inner.createSignInToken({
      id: "bbbbbbbbbbbbbbb1",
      userId: null,
      email: "dead@example.com",
      tokenHash: "h",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const storage = makeStorageThatRejectsSweep(inner)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(runSessionSweepTick({ storage })).resolves.toBeUndefined()

    expect(await inner.getSignInToken(dead.id)).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("a failure in the sign-in token pass does not reject the tick", async () => {
    const inner = new InMemoryStorage()
    const storage = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "deleteExpiredSignInTokens") {
          return async () => {
            throw new Error("simulated storage failure in deleteExpiredSignInTokens")
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as StorageAdapter
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(runSessionSweepTick({ storage })).resolves.toBeUndefined()

    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe("instance invite sweep (viewer-membership M2)", () => {
  it("deletes an unused, unrevoked invite past its expiry, and leaves a live/used/revoked one", async () => {
    const storage = new InMemoryStorage()
    const dead = await storage.createInstanceInvite({
      id: "cccccccccccccc01",
      email: "dead@example.com",
      role: "editor",
      tokenHash: "h",
      createdByUserId: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const live = await storage.createInstanceInvite({
      id: "cccccccccccccc02",
      email: "live@example.com",
      role: "editor",
      tokenHash: "h",
      createdByUserId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const used = await storage.createInstanceInvite({
      id: "cccccccccccccc03",
      email: "used@example.com",
      role: "editor",
      tokenHash: "h",
      createdByUserId: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await storage.claimInstanceInvite(used.id, new Date().toISOString())
    const revoked = await storage.createInstanceInvite({
      id: "cccccccccccccc04",
      email: "revoked@example.com",
      role: "editor",
      tokenHash: "h",
      createdByUserId: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await storage.revokeInstanceInvite(revoked.id)

    await runSessionSweepTick({ storage })

    expect(await storage.getInstanceInvite(dead.id)).toBeNull()
    expect(await storage.getInstanceInvite(live.id)).not.toBeNull()
    expect(await storage.getInstanceInvite(used.id)).not.toBeNull()
    expect(await storage.getInstanceInvite(revoked.id)).not.toBeNull()
  })

  it("still sweeps invites when the SESSION pass fails", async () => {
    const inner = new InMemoryStorage()
    const dead = await inner.createInstanceInvite({
      id: "dddddddddddddd01",
      email: "dead@example.com",
      role: "editor",
      tokenHash: "h",
      createdByUserId: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const storage = makeStorageThatRejectsSweep(inner)
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(runSessionSweepTick({ storage })).resolves.toBeUndefined()

    expect(await inner.getInstanceInvite(dead.id)).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("a failure in the invite pass does not reject the tick, and does not skip the other passes", async () => {
    const inner = new InMemoryStorage()
    const deadSession = await seedExpiredSession(inner)
    const storage = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "deleteExpiredInstanceInvites") {
          return async () => {
            throw new Error("simulated storage failure in deleteExpiredInstanceInvites")
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as StorageAdapter
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(runSessionSweepTick({ storage })).resolves.toBeUndefined()

    // The session pass still ran despite the invite pass failing.
    expect(await inner.getSession(deadSession.id)).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe("runSessionSweepTick", () => {
  it("deletes expired sessions and leaves unexpired ones", async () => {
    const storage = new InMemoryStorage()
    const expired = await seedExpiredSession(storage)
    const user = await upsertTestUser(storage, {
      provider: "github",
      providerUserId: "2",
      email: "ada@example.com",
      displayName: "Ada",
      avatarUrl: "",
    })
    const fresh = await storage.createSession({
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await runSessionSweepTick({ storage })

    expect(await storage.getSession(expired.id)).toBeNull()
    expect(await storage.getSession(fresh.id)).not.toBeNull()
  })

  it("a storage failure in deleteExpiredSessions does NOT reject the tick — it logs and lets the next tick proceed", async () => {
    const storage = new InMemoryStorage()
    const expired = await seedExpiredSession(storage)
    const failingStorage = makeStorageThatRejectsSweep(storage)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    // Pre-fix, an unguarded `deleteExpiredSessions` rejection would propagate
    // straight out of `runSessionSweepTick`. Called as
    // `void runSessionSweepTick(deps).catch(...)` from the scheduler's
    // `setInterval` callback, an unguarded rejection here would still be
    // caught by that outer `.catch` — but the tick-level try/catch is the
    // first line of defense and is what this asserts directly: the returned
    // promise resolves, not rejects, and the failure is logged.
    await expect(runSessionSweepTick({ storage: failingStorage })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
    // The row is still there — storage failed, nothing was deleted.
    expect(await storage.getSession(expired.id)).not.toBeNull()

    // Next tick, storage recovered (no more proxy): the row is swept.
    await runSessionSweepTick({ storage })
    expect(await storage.getSession(expired.id)).toBeNull()

    errorSpy.mockRestore()
  })
})

describe("startSessionSweep", () => {
  it("sweeps once at boot, then again on the interval; stop() halts further sweeps", async () => {
    // Fake timers so the interval firing (and the clock `expiresAt`
    // comparisons are computed against) is driven deterministically instead
    // of racing a real 20ms timer. `vi.advanceTimersByTimeAsync` — not the
    // sync `advanceTimersByTime` — because each tick's `deleteExpiredSessions`
    // is a real async storage call; the sync variant would advance the clock
    // and fire the timer callback without ever letting that promise resolve.
    vi.useFakeTimers()
    try {
      const storage = new InMemoryStorage()
      const deleteSpy = vi.spyOn(storage, "deleteExpiredSessions")
      const bootExpired = await seedExpiredSession(storage)

      const stop = startSessionSweep({ storage, intervalMs: 1000 })

      // Boot sweep: dispatched synchronously by `startSessionSweep` itself,
      // but the storage call inside it is async — flush it before asserting.
      await vi.advanceTimersByTimeAsync(0)
      expect(deleteSpy).toHaveBeenCalledTimes(1)
      expect(await storage.getSession(bootExpired.id)).toBeNull()

      // Interval sweep: seed a fresh expired row (the boot sweep already
      // cleared the table, so a second deletion here can only be explained
      // by the interval actually firing, not by e.g. a no-op re-run of the
      // same boot pass) and advance the fake clock by exactly one interval.
      const intervalExpired = await seedExpiredSession(storage)
      await vi.advanceTimersByTimeAsync(1000)
      expect(deleteSpy).toHaveBeenCalledTimes(2)
      expect(await storage.getSession(intervalExpired.id)).toBeNull()

      // stop() halts further sweeps: seed one more expired row, stop, then
      // advance well past another interval. If `stop()` merely failed to
      // throw but didn't actually `clearInterval`, this row would be swept
      // and the assertion below would catch it.
      const postStopExpired = await seedExpiredSession(storage)
      stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(deleteSpy).toHaveBeenCalledTimes(2)
      expect(await storage.getSession(postStopExpired.id)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("is safe to call stop() immediately (no throw, no timer leak)", async () => {
    const storage = new InMemoryStorage()
    const stop = startSessionSweep({ storage, intervalMs: 10 })
    expect(() => stop()).not.toThrow()
  })
})
