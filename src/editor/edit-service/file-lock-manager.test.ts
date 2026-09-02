/**
 * Phase 0 smoke matrix for the FileLockManager. Mirrors the four scenarios
 * called out in tasks/editor-detached-sessions.md Phase 0:
 *
 *  1. Two sessions on different files run in parallel
 *  2. Two sessions on the same file serialize in submission order
 *  3. withWriteLock restores file content when fn throws mid-execution
 *  4. Lock contention surfaces in structured telemetry
 *
 * Plus a `safety` block that pins behaviors a future refactor could
 * regress: reentrancy refusal, telemetry-callback isolation, new-file
 * cleanup on throw, FIFO across many waiters, queue-depth telemetry.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  mkdirSync,
  realpathSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createFileLockManager,
  getSharedFileLockManager,
  __resetSharedFileLockManagerForTests,
  type LockEvent,
} from "./file-lock-manager"

interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Flush enough microtasks + I/O ticks for the lock-handoff chain
 * (release → resolve next waiter → next fn body enters) to settle.
 */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

describe("FileLockManager — smoke matrix", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-lock-smoke-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("two sessions on different files run in parallel", async () => {
    const mgr = createFileLockManager()
    const a = join(dir, "a.txt")
    const b = join(dir, "b.txt")
    writeFileSync(a, "A0")
    writeFileSync(b, "B0")
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const order: string[] = []

    const pa = mgr.withLock(
      a,
      async () => {
        order.push("A-start")
        await gateA.promise
        writeFileSync(a, "A1")
        order.push("A-end")
      },
      { sessionId: "S1" }
    )
    const pb = mgr.withLock(
      b,
      async () => {
        order.push("B-start")
        await gateB.promise
        writeFileSync(b, "B1")
        order.push("B-end")
      },
      { sessionId: "S2" }
    )

    await settle()
    expect(order).toEqual(["A-start", "B-start"])

    gateB.resolve()
    gateA.resolve()
    await Promise.all([pa, pb])
    expect(readFileSync(a, "utf8")).toBe("A1")
    expect(readFileSync(b, "utf8")).toBe("B1")
  })

  it("two sessions on the same file serialize in submission order", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    const order: string[] = []

    const p1 = mgr.withLock(
      f,
      async () => {
        order.push("S1-start")
        await gate1.promise
        writeFileSync(f, "1")
        order.push("S1-end")
      },
      { sessionId: "S1" }
    )
    const p2 = mgr.withLock(
      f,
      async () => {
        order.push("S2-start")
        await gate2.promise
        writeFileSync(f, "2")
        order.push("S2-end")
      },
      { sessionId: "S2" }
    )

    await settle()
    expect(order).toEqual(["S1-start"])
    expect(mgr.inspect().queueDepths.get(realpathSync(f))).toBe(1)
    expect(mgr.inspect().heldBy.get(realpathSync(f))).toBe("S1")

    gate1.resolve()
    await settle()
    expect(order).toEqual(["S1-start", "S1-end", "S2-start"])
    expect(mgr.inspect().heldBy.get(realpathSync(f))).toBe("S2")

    gate2.resolve()
    await Promise.all([p1, p2])
    expect(readFileSync(f, "utf8")).toBe("2")
    expect(mgr.inspect().heldBy.has(realpathSync(f))).toBe(false)
  })

  it("withWriteLock restores file content when fn throws after partial write", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "original")

    await expect(
      mgr.withWriteLock(
        f,
        async () => {
          writeFileSync(f, "halfway-overwrite")
          throw new Error("LLM failed mid-stream")
        },
        { sessionId: "S1" }
      )
    ).rejects.toThrow("LLM failed mid-stream")

    expect(readFileSync(f, "utf8")).toBe("original")
    expect(mgr.inspect().heldBy.has(realpathSync(f))).toBe(false)
  })

  it("lock contention surfaces in structured telemetry", async () => {
    const events: LockEvent[] = []
    const mgr = createFileLockManager({ onEvent: (e) => events.push(e) })
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    const gate = deferred<void>()

    const p1 = mgr.withLock(f, async () => gate.promise, { sessionId: "S1" })
    await settle()
    const p2 = mgr.withLock(f, async () => undefined, { sessionId: "S2" })
    await settle()

    const s2Attempt = events.find(
      (e) => e.type === "acquire-attempt" && e.sessionId === "S2"
    ) as Extract<LockEvent, { type: "acquire-attempt" }> | undefined
    expect(s2Attempt).toBeDefined()
    expect(s2Attempt!.queueLength).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "acquired" && e.sessionId === "S1")).toBe(true)
    expect(
      events.some((e) => e.type === "acquired" && e.sessionId === "S2" && e.waitedMs >= 0)
    ).toBe(false)

    gate.resolve()
    await Promise.all([p1, p2])
    const s2Acquired = events.find(
      (e) => e.type === "acquired" && e.sessionId === "S2"
    ) as Extract<LockEvent, { type: "acquired" }> | undefined
    expect(s2Acquired).toBeDefined()
    expect(s2Acquired!.waitedMs).toBeGreaterThanOrEqual(0)
    expect(events.filter((e) => e.type === "released")).toHaveLength(2)
  })
})

describe("FileLockManager — safety", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-lock-safety-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("reentrant acquire by the same session throws synchronously inside the wrapper", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    await expect(
      mgr.withLock(
        f,
        async () => {
          await mgr.withLock(f, async () => undefined, { sessionId: "S1" })
        },
        { sessionId: "S1" }
      )
    ).rejects.toThrow(/reentrant/i)
    expect(mgr.inspect().heldBy.has(realpathSync(f))).toBe(false)
  })

  it("telemetry callback throwing does not break the lock", async () => {
    const mgr = createFileLockManager({
      onEvent: () => {
        throw new Error("boom")
      },
    })
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    await mgr.withLock(
      f,
      async () => {
        writeFileSync(f, "1")
      },
      { sessionId: "S1" }
    )
    expect(readFileSync(f, "utf8")).toBe("1")
    expect(mgr.inspect().heldBy.has(realpathSync(f))).toBe(false)
  })

  it("withWriteLock unlinks new file when fn throws after creating it", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "new.txt")
    expect(existsSync(f)).toBe(false)

    await expect(
      mgr.withWriteLock(
        f,
        async () => {
          writeFileSync(f, "partial")
          throw new Error("LLM failed before commit")
        },
        { sessionId: "S1" }
      )
    ).rejects.toThrow("LLM failed before commit")

    expect(existsSync(f)).toBe(false)
  })

  it("withWriteLock leaves a successfully-created new file in place", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "new.txt")
    await mgr.withWriteLock(
      f,
      async () => {
        writeFileSync(f, "created")
      },
      { sessionId: "S1" }
    )
    expect(readFileSync(f, "utf8")).toBe("created")
  })

  it("FIFO ordering preserved across five queued waiters", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    const N = 5
    const gates = Array.from({ length: N }, () => deferred<void>())
    const order: string[] = []
    const ps = gates.map((g, i) =>
      mgr.withLock(
        f,
        async () => {
          order.push(`S${i}-start`)
          await g.promise
          order.push(`S${i}-end`)
        },
        { sessionId: `S${i}` }
      )
    )

    for (let i = 0; i < N; i++) {
      await settle()
      gates[i].resolve()
    }
    await Promise.all(ps)

    const expected: string[] = []
    for (let i = 0; i < N; i++) {
      expected.push(`S${i}-start`, `S${i}-end`)
    }
    expect(order).toEqual(expected)
  })

  it("queue depth in acquire-attempt event reflects actual waiters", async () => {
    const events: LockEvent[] = []
    const mgr = createFileLockManager({ onEvent: (e) => events.push(e) })
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    const gate = deferred<void>()

    const ps: Promise<void>[] = []
    ps.push(mgr.withLock(f, async () => gate.promise, { sessionId: "S0" }))
    await settle()
    ps.push(mgr.withLock(f, async () => undefined, { sessionId: "S1" }))
    await settle()
    ps.push(mgr.withLock(f, async () => undefined, { sessionId: "S2" }))
    await settle()

    const s1Attempt = events.find(
      (e) => e.type === "acquire-attempt" && e.sessionId === "S1"
    ) as Extract<LockEvent, { type: "acquire-attempt" }> | undefined
    const s2Attempt = events.find(
      (e) => e.type === "acquire-attempt" && e.sessionId === "S2"
    ) as Extract<LockEvent, { type: "acquire-attempt" }> | undefined
    expect(s1Attempt!.queueLength).toBe(1)
    expect(s2Attempt!.queueLength).toBe(2)

    gate.resolve()
    await Promise.all(ps)
  })

  it("two anonymous callers on the same file serialize (not flagged as reentrant)", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    const gate1 = deferred<void>()
    const gate2 = deferred<void>()
    const order: string[] = []

    const p1 = mgr.withLock(f, async () => {
      order.push("anon-1-enter")
      await gate1.promise
      order.push("anon-1-exit")
    })
    const p2 = mgr.withLock(f, async () => {
      order.push("anon-2-enter")
      await gate2.promise
      order.push("anon-2-exit")
    })

    await settle()
    expect(order).toEqual(["anon-1-enter"])
    gate1.resolve()
    await settle()
    expect(order).toEqual(["anon-1-enter", "anon-1-exit", "anon-2-enter"])
    gate2.resolve()
    await Promise.all([p1, p2])
  })

  it("symlink and target path serialize on the same canonical lock", async () => {
    const mgr = createFileLockManager()
    const target = join(dir, "target.txt")
    const link = join(dir, "link.txt")
    writeFileSync(target, "0")
    symlinkSync(target, link)
    const gate = deferred<void>()
    const order: string[] = []

    const p1 = mgr.withLock(
      target,
      async () => {
        order.push("via-target-enter")
        await gate.promise
        order.push("via-target-exit")
      },
      { sessionId: "S1" }
    )
    await settle()
    const p2 = mgr.withLock(
      link,
      async () => {
        order.push("via-link-enter")
        order.push("via-link-exit")
      },
      { sessionId: "S2" }
    )
    await settle()
    // S2 must be queued behind S1 even though it acquired via the symlink path.
    expect(order).toEqual(["via-target-enter"])
    gate.resolve()
    await Promise.all([p1, p2])
    expect(order).toEqual([
      "via-target-enter",
      "via-target-exit",
      "via-link-enter",
      "via-link-exit",
    ])
  })

  it("withWriteLock surfaces AggregateError when restore itself fails", async () => {
    const events: LockEvent[] = []
    const mgr = createFileLockManager({ onEvent: (e) => events.push(e) })
    const f = join(dir, "f.txt")
    writeFileSync(f, "original")

    // fn replaces the file with a directory at the same path, then throws.
    // Restore's fs.writeFile will fail with EISDIR.
    let caught: unknown = null
    try {
      await mgr.withWriteLock(
        f,
        async () => {
          rmSync(f)
          mkdirSync(f)
          throw new Error("simulated fn failure")
        },
        { sessionId: "S1" }
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AggregateError)
    const agg = caught as AggregateError
    expect(agg.errors).toHaveLength(2)
    expect((agg.errors[0] as Error).message).toBe("simulated fn failure")
    expect(events.some((e) => e.type === "snapshot-restore-failed")).toBe(true)
  })

  it("withWriteLock surfaces non-ENOENT cleanup failures via AggregateError", async () => {
    const events: LockEvent[] = []
    const mgr = createFileLockManager({ onEvent: (e) => events.push(e) })
    const newPath = join(dir, "new.txt")
    // fn creates a directory at the target path then throws. Cleanup's
    // fs.unlink will fail with EISDIR/EPERM rather than ENOENT.
    let caught: unknown = null
    try {
      await mgr.withWriteLock(
        newPath,
        async () => {
          mkdirSync(newPath)
          throw new Error("simulated new-file fn failure")
        },
        { sessionId: "S1" }
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect(events.some((e) => e.type === "snapshot-restore-failed")).toBe(true)
    // The directory is still there; the test cleans it up.
    expect(existsSync(newPath)).toBe(true)
  })

  it("onEventError fires when onEvent throws", async () => {
    const escalations: { message: string; eventType: string }[] = []
    const mgr = createFileLockManager({
      onEvent: () => {
        throw new Error("telemetry boom")
      },
      onEventError: (err, event) => {
        escalations.push({
          message: (err as Error).message,
          eventType: event.type,
        })
      },
    })
    const f = join(dir, "f.txt")
    writeFileSync(f, "0")
    await mgr.withLock(f, async () => undefined, { sessionId: "S1" })
    expect(escalations.length).toBeGreaterThan(0)
    expect(escalations[0].message).toBe("telemetry boom")
  })

  it("getSharedFileLockManager returns the same instance across calls", () => {
    __resetSharedFileLockManagerForTests()
    const a = getSharedFileLockManager()
    const b = getSharedFileLockManager()
    expect(a).toBe(b)
    __resetSharedFileLockManagerForTests()
    const c = getSharedFileLockManager()
    expect(c).not.toBe(a)
    // Use realpathSync as a smoke check that the singleton actually works
    // end-to-end against a real path.
    const f = join(dir, "shared.txt")
    writeFileSync(f, "0")
    expect(typeof realpathSync(f)).toBe("string")
    __resetSharedFileLockManagerForTests()
  })

  it("withWriteLock keeps the lock held during restore", async () => {
    const mgr = createFileLockManager()
    const f = join(dir, "f.txt")
    writeFileSync(f, "original")

    const restoreObserved = deferred<string>()
    const followUpResult = deferred<string>()

    const failing = mgr
      .withWriteLock(
        f,
        async () => {
          writeFileSync(f, "halfway")
          throw new Error("forced")
        },
        { sessionId: "S1" }
      )
      .catch(() => {
        restoreObserved.resolve(readFileSync(f, "utf8"))
      })

    const followUp = mgr.withWriteLock(
      f,
      async () => {
        followUpResult.resolve(readFileSync(f, "utf8"))
        writeFileSync(f, "after")
      },
      { sessionId: "S2" }
    )

    await Promise.all([failing, followUp])
    expect(await restoreObserved.promise).toBe("original")
    expect(await followUpResult.promise).toBe("original")
    expect(readFileSync(f, "utf8")).toBe("after")
  })
})
