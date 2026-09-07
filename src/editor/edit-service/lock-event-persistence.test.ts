/**
 * Tests for the lock-event persistence module — Phase 3 follow-up of
 * tasks/editor-detached-sessions.md. Pins the on-disk layout, the
 * bounded-cap rotation behavior, the per-session serialization
 * guarantee, and the swallow-on-error contract.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  __resetWriteChainsForTests,
  appendLockEvent,
  getLockEventsFileSize,
  lockEventsFilePath,
  MAX_PERSISTED_EVENTS,
  readLockEvents,
} from "./lock-event-persistence"
import type { LockEvent } from "./file-lock-manager"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lock-event-persistence-"))
  __resetWriteChainsForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function ev(overrides: Partial<LockEvent> = {}): LockEvent {
  return {
    type: "acquired",
    absPath: "/tmp/x.vue",
    sessionId: "session-a",
    waitedMs: 0,
    t: Date.now(),
    ...overrides,
  } as LockEvent
}

describe("lockEventsFilePath", () => {
  it("produces the documented layout", () => {
    expect(lockEventsFilePath(root, "abc123")).toBe(
      join(root, ".desde", "chat-sessions", "abc123", "lock-events.jsonl"),
    )
  })

  it("rejects invalid sessionIds (path-traversal guard)", () => {
    expect(() => lockEventsFilePath(root, "../escape")).toThrow(
      /sessionId must match/i,
    )
    expect(() => lockEventsFilePath(root, "")).toThrow(/sessionId must match/i)
    expect(() => lockEventsFilePath(root, "x/y")).toThrow(/sessionId must match/i)
  })
})

describe("appendLockEvent", () => {
  it("creates the session directory + writes one JSON line per call", async () => {
    await appendLockEvent(root, "s1", ev({ type: "acquired", waitedMs: 10 }))
    await appendLockEvent(root, "s1", ev({ type: "released", heldMs: 5 } as Partial<LockEvent>))
    const raw = readFileSync(lockEventsFilePath(root, "s1"), "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    const lines = raw.trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first.type).toBe("acquired")
    expect(first.waitedMs).toBe(10)
  })

  it("serializes concurrent appends per session", async () => {
    // Fire 20 appends in parallel — order in the file should match
    // submission order, not interleave, even though writes are
    // async.
    const promises = Array.from({ length: 20 }, (_, i) =>
      appendLockEvent(root, "s1", ev({ t: i, type: "acquired", waitedMs: 0 })),
    )
    await Promise.all(promises)
    const events = await readLockEvents(root, "s1")
    expect(events.map((e) => e.t)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    )
  })

  it("isolates writes across sessions (no cross-talk)", async () => {
    await Promise.all([
      appendLockEvent(root, "s1", ev({ sessionId: "s1" })),
      appendLockEvent(root, "s2", ev({ sessionId: "s2" })),
    ])
    expect(await readLockEvents(root, "s1")).toHaveLength(1)
    expect(await readLockEvents(root, "s2")).toHaveLength(1)
  })

  it("caps the file at maxPersistedEvents by rotating oldest", async () => {
    for (let i = 0; i < 7; i++) {
      await appendLockEvent(root, "s1", ev({ t: i }), { maxPersistedEvents: 5 })
    }
    const events = await readLockEvents(root, "s1")
    expect(events).toHaveLength(5)
    // Most recent kept, oldest dropped.
    expect(events.map((e) => e.t)).toEqual([2, 3, 4, 5, 6])
  })

  it("no-ops when maxPersistedEvents is 0 (disable persistence)", async () => {
    await appendLockEvent(root, "s1", ev(), { maxPersistedEvents: 0 })
    expect(await readLockEvents(root, "s1")).toEqual([])
    expect(await getLockEventsFileSize(root, "s1")).toBe(0)
  })

  it("swallows write errors but reports via onError", async () => {
    // Plant a directory where the file should go — appendFile will fail
    // with EISDIR.
    const path = lockEventsFilePath(root, "s1")
    mkdirSync(path, { recursive: true })
    const errors: unknown[] = []
    await appendLockEvent(root, "s1", ev(), {
      onError: (err) => errors.push(err),
    })
    expect(errors).toHaveLength(1)
  })

  it("onError swallows callback throws (telemetry can't break telemetry)", async () => {
    const path = lockEventsFilePath(root, "s1")
    mkdirSync(path, { recursive: true })
    // The callback itself throws. The contract is: persistence still
    // resolves without re-throwing.
    await expect(
      appendLockEvent(root, "s1", ev(), {
        onError: () => {
          throw new Error("callback boom")
        },
      }),
    ).resolves.toBeUndefined()
  })
})

describe("readLockEvents", () => {
  it("returns [] for missing file", async () => {
    expect(await readLockEvents(root, "no-such")).toEqual([])
  })

  it("skips malformed lines without throwing", async () => {
    const path = lockEventsFilePath(root, "s1")
    mkdirSync(join(root, ".desde", "chat-sessions", "s1"), { recursive: true })
    writeFileSync(
      path,
      [
        JSON.stringify(ev({ t: 1 })),
        "not json",
        JSON.stringify(ev({ t: 2 })),
        "",
        '{"missing":"fields"}',
        JSON.stringify(ev({ t: 3 })),
      ].join("\n") + "\n",
      "utf8",
    )
    const events = await readLockEvents(root, "s1")
    expect(events.map((e) => e.t)).toEqual([1, 2, 3])
  })

  it("rejects invalid sessionIds (defense in depth)", async () => {
    await expect(readLockEvents(root, "../escape")).rejects.toThrow(
      /sessionId must match/i,
    )
  })
})

describe("MAX_PERSISTED_EVENTS default", () => {
  it("is a sensible bound", () => {
    expect(MAX_PERSISTED_EVENTS).toBeGreaterThan(100)
    expect(MAX_PERSISTED_EVENTS).toBeLessThanOrEqual(10_000)
  })
})

describe("getLockEventsFileSize", () => {
  it("returns 0 for missing file", async () => {
    expect(await getLockEventsFileSize(root, "no-such")).toBe(0)
  })

  it("returns byte size for an existing file", async () => {
    await appendLockEvent(root, "s1", ev())
    const size = await getLockEventsFileSize(root, "s1")
    expect(size).toBeGreaterThan(0)
  })
})

describe("FX4 item 2: a symlinked .desde", () => {
  it("writes no audit log outside the working tree, and reports the refusal", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lock-event-outside-"))
    try {
      symlinkSync(outside, join(root, ".desde"))
      const errors: unknown[] = []
      await appendLockEvent(root, "session-a", ev(), { onError: (e) => errors.push(e) })
      expect(errors).toHaveLength(1)
      expect((errors[0] as Error).message).toMatch(/symbolic link/i)
      expect(existsSync(join(outside, "chat-sessions"))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
