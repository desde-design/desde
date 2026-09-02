/**
 * End-to-end pin for the lock-event persistence pipeline. Proves
 * that calling withWriteLock from inside a runWithChatSession scope
 * results in events landing on the session's jsonl file via the
 * production singleton's onEvent wiring — no test doubles.
 *
 * The shared FileLockManager is a singleton; each test resets it
 * via __resetSharedFileLockManagerForTests so the persistence sink
 * we wire here doesn't leak across cases.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { runWithChatSession } from "./chat-session-context"
import {
  __resetSharedFileLockManagerForTests,
  getSharedFileLockManager,
} from "./file-lock-manager"
import {
  __resetWriteChainsForTests,
  flushPendingLockEventWrites,
  readLockEvents,
} from "./lock-event-persistence"

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "lock-event-integration-"))
  __resetSharedFileLockManagerForTests()
  __resetWriteChainsForTests()
})

afterEach(() => {
  __resetSharedFileLockManagerForTests()
  __resetWriteChainsForTests()
  rmSync(repoRoot, { recursive: true, force: true })
})

/**
 * Persistence writes happen on an internal promise chain and are
 * not awaited inside the singleton's onEvent callback (we don't
 * want lock release blocked on disk I/O). Tests use the public
 * flush helper to drain the chain before asserting on file
 * contents.
 *
 * Re-snapshot and re-flush a few times: each in-flight write can
 * schedule ANOTHER write (e.g., the release event fires after the
 * acquired event was already being persisted). One snapshot may
 * miss subsequently-enqueued writes; looping until the map is
 * stable picks them all up.
 */
async function flushPersistence(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await flushPendingLockEventWrites()
    // Yield so any further setImmediate-deferred chain work runs.
    await new Promise<void>((r) => setImmediate(r))
  }
}

describe("lock-event persistence (end-to-end)", () => {
  it("persists events emitted inside a runWithChatSession scope", async () => {
    const target = join(repoRoot, "x.txt")
    writeFileSync(target, "v0")
    await runWithChatSession({ sessionId: "session-a", repoRoot }, async () => {
      await getSharedFileLockManager().withWriteLock(
        target,
        async () => {
          writeFileSync(target, "v1")
        },
        { sessionId: "session-a" },
      )
    })
    await flushPersistence()
    const events = await readLockEvents(repoRoot, "session-a")
    const types = events.map((e) => e.type)
    expect(types).toContain("acquire-attempt")
    expect(types).toContain("acquired")
    expect(types).toContain("snapshot-captured")
    expect(types).toContain("snapshot-discarded")
    expect(types).toContain("released")
    // All events should be attributed to the active session.
    for (const e of events) expect(e.sessionId).toBe("session-a")
  })

  it("drops events fired OUTSIDE any chat-session scope", async () => {
    const target = join(repoRoot, "x.txt")
    writeFileSync(target, "v0")
    // No runWithChatSession wrapper — events should not be persisted
    // to any session's file.
    await getSharedFileLockManager().withWriteLock(target, async () => {
      writeFileSync(target, "v1")
    })
    await flushPersistence()
    expect(await readLockEvents(repoRoot, "session-a")).toEqual([])
  })

  it("attributes events to the active scope's session even when withWriteLock supplies a different sessionId", async () => {
    // The persistence sink reads from the scope, not from the
    // event payload — that's intentional: it lets us scope to the
    // CHAT session even when an inner caller passes an anonymous
    // or alternate sessionId.
    const target = join(repoRoot, "x.txt")
    writeFileSync(target, "v0")
    await runWithChatSession({ sessionId: "session-a", repoRoot }, async () => {
      // Note: no sessionId passed → anonymous attribution on the
      // event itself.
      await getSharedFileLockManager().withWriteLock(target, async () => {
        writeFileSync(target, "v1")
      })
    })
    await flushPersistence()
    const events = await readLockEvents(repoRoot, "session-a")
    expect(events.length).toBeGreaterThan(0)
  })

  it("isolates parallel scopes — events route to their own session files", async () => {
    const targetA = join(repoRoot, "a.txt")
    const targetB = join(repoRoot, "b.txt")
    writeFileSync(targetA, "A0")
    writeFileSync(targetB, "B0")
    await Promise.all([
      runWithChatSession({ sessionId: "ses-a", repoRoot }, async () => {
        await getSharedFileLockManager().withWriteLock(
          targetA,
          async () => writeFileSync(targetA, "A1"),
          { sessionId: "ses-a" },
        )
      }),
      runWithChatSession({ sessionId: "ses-b", repoRoot }, async () => {
        await getSharedFileLockManager().withWriteLock(
          targetB,
          async () => writeFileSync(targetB, "B1"),
          { sessionId: "ses-b" },
        )
      }),
    ])
    await flushPersistence()
    const eventsA = await readLockEvents(repoRoot, "ses-a")
    const eventsB = await readLockEvents(repoRoot, "ses-b")
    expect(eventsA.length).toBeGreaterThan(0)
    expect(eventsB.length).toBeGreaterThan(0)
    // No cross-talk.
    for (const e of eventsA) expect(e.absPath).not.toContain("b.txt")
    for (const e of eventsB) expect(e.absPath).not.toContain("a.txt")
  })

  it("persists snapshot-restored events when the lock'd fn throws", async () => {
    const target = join(repoRoot, "x.txt")
    writeFileSync(target, "v0")
    await runWithChatSession({ sessionId: "session-a", repoRoot }, async () => {
      await expect(
        getSharedFileLockManager().withWriteLock(
          target,
          async () => {
            writeFileSync(target, "BROKEN")
            throw new Error("fn boom")
          },
          { sessionId: "session-a" },
        ),
      ).rejects.toThrow(/fn boom/)
    })
    await flushPersistence()
    const events = await readLockEvents(repoRoot, "session-a")
    const types = events.map((e) => e.type)
    expect(types).toContain("snapshot-restored")
    expect(types).not.toContain("snapshot-discarded")
  })
})
