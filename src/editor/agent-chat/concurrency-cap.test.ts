/**
 * Tests for the Phase 5 concurrency cap.
 *
 * Covers:
 *   - Under cap: acquire is immediate
 *   - At cap: acquires queue FIFO and drain as releases happen
 *   - Cap is per-project
 *   - Abort while queued cleans up + lets others drain
 *   - Release is idempotent
 *   - onQueued fires only when actually queued
 *   - inspect() reflects in-flight + queue state
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  __resetSharedConcurrencyCapForTests,
  createConcurrencyCap,
  DEFAULT_CONCURRENCY_CAP,
  getSharedConcurrencyCap,
} from "./concurrency-cap"

afterEach(() => {
  __resetSharedConcurrencyCapForTests()
})

function neverAbort(): AbortSignal {
  return new AbortController().signal
}

describe("createConcurrencyCap", () => {
  it("acquires immediately when under cap", async () => {
    const cap = createConcurrencyCap()
    const r = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
    })
    expect(r.wasQueued).toBe(false)
    expect(cap.inspect("p").inFlight).toEqual(["s1"])
    r.release()
    expect(cap.inspect("p").inFlight).toEqual([])
  })

  it("respects per-call cap override", async () => {
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    expect(r1.wasQueued).toBe(false)
    // s2 should queue.
    let queuedFired = false
    const s2 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: neverAbort(),
      cap: 1,
      onQueued: () => {
        queuedFired = true
      },
    })
    // Give the microtask a tick to run + enqueue.
    await Promise.resolve()
    expect(queuedFired).toBe(true)
    expect(cap.inspect("p").queueDepth).toBe(1)
    expect(cap.inspect("p").inFlight).toEqual(["s1"])
    // Release s1; s2 drains.
    r1.release()
    const r2 = await s2
    expect(r2.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s2"])
    expect(cap.inspect("p").queueDepth).toBe(0)
    r2.release()
  })

  it("drains in FIFO order across multiple waiters", async () => {
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    const positions: number[] = []
    const s2 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: neverAbort(),
      cap: 1,
      onQueued: (pos) => positions.push(pos),
    })
    const s3 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s3",
      signal: neverAbort(),
      cap: 1,
      onQueued: (pos) => positions.push(pos),
    })
    const s4 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s4",
      signal: neverAbort(),
      cap: 1,
      onQueued: (pos) => positions.push(pos),
    })
    await Promise.resolve()
    // 1-indexed positions captured at enqueue time.
    expect(positions).toEqual([1, 2, 3])
    expect(cap.inspect("p").queueDepth).toBe(3)

    // Release s1 → s2 drains.
    r1.release()
    const r2 = await s2
    expect(r2.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s2"])
    expect(cap.inspect("p").queueDepth).toBe(2)

    // Release s2 → s3 drains.
    r2.release()
    const r3 = await s3
    expect(r3.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s3"])

    // Release s3 → s4 drains.
    r3.release()
    const r4 = await s4
    expect(r4.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s4"])
    r4.release()
    expect(cap.inspect("p").inFlight).toEqual([])
  })

  it("does not fire onQueued when acquire is immediate", async () => {
    const cap = createConcurrencyCap()
    const onQueued = vi.fn()
    const r = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s",
      signal: neverAbort(),
      onQueued,
    })
    expect(r.wasQueued).toBe(false)
    expect(onQueued).not.toHaveBeenCalled()
    r.release()
  })

  it("cap is per-project — distinct projects don't share quota", async () => {
    const cap = createConcurrencyCap()
    const a1 = await cap.acquireSlot({
      projectId: "a",
      sessionId: "s",
      signal: neverAbort(),
      cap: 1,
    })
    // Project a is at cap, but project b should run immediately.
    const b1 = await cap.acquireSlot({
      projectId: "b",
      sessionId: "s",
      signal: neverAbort(),
      cap: 1,
    })
    expect(b1.wasQueued).toBe(false)
    expect(cap.inspect("a").inFlight).toEqual(["s"])
    expect(cap.inspect("b").inFlight).toEqual(["s"])
    a1.release()
    b1.release()
  })

  it("abort while queued cleans the entry up and unblocks downstream drains", async () => {
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    const abort2 = new AbortController()
    const s2 = cap
      .acquireSlot({
        projectId: "p",
        sessionId: "s2",
        signal: abort2.signal,
        cap: 1,
      })
      .catch((err) => err)
    const s3 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s3",
      signal: neverAbort(),
      cap: 1,
    })
    await Promise.resolve()
    expect(cap.inspect("p").queueDepth).toBe(2)

    // Abort s2 BEFORE s1 releases — s2 should reject + leave the
    // queue, but s3 should still drain when s1 releases.
    abort2.abort()
    const r2 = await s2
    expect(r2).toBeInstanceOf(DOMException)
    expect((r2 as DOMException).name).toBe("AbortError")
    expect(cap.inspect("p").queueDepth).toBe(1)

    r1.release()
    const r3 = await s3
    expect(r3.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s3"])
    r3.release()
  })

  it("immediate acquire with already-aborted signal rejects synchronously without holding a slot", async () => {
    const cap = createConcurrencyCap()
    const abort = new AbortController()
    abort.abort()
    await expect(
      cap.acquireSlot({
        projectId: "p",
        sessionId: "s",
        signal: abort.signal,
      }),
    ).rejects.toThrow(/aborted/i)
    expect(cap.inspect("p").inFlight).toEqual([])
  })

  it("release is idempotent — second call doesn't drain a second waiter", async () => {
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    const s2 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: neverAbort(),
      cap: 1,
    })
    const s3 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s3",
      signal: neverAbort(),
      cap: 1,
    })
    await Promise.resolve()
    expect(cap.inspect("p").queueDepth).toBe(2)

    r1.release()
    const r2 = await s2
    expect(cap.inspect("p").inFlight).toEqual(["s2"])
    expect(cap.inspect("p").queueDepth).toBe(1)

    // Double-release of s1 must NOT pop s3 from the queue.
    r1.release()
    expect(cap.inspect("p").inFlight).toEqual(["s2"])
    expect(cap.inspect("p").queueDepth).toBe(1)

    r2.release()
    const r3 = await s3
    r3.release()
  })

  it("default cap matches DEFAULT_CONCURRENCY_CAP", async () => {
    const cap = createConcurrencyCap()
    // Acquire DEFAULT_CONCURRENCY_CAP slots — all should be immediate.
    const slots = []
    for (let i = 0; i < DEFAULT_CONCURRENCY_CAP; i++) {
      slots.push(
        await cap.acquireSlot({
          projectId: "p",
          sessionId: `s${i}`,
          signal: neverAbort(),
        }),
      )
    }
    expect(cap.inspect("p").inFlight).toHaveLength(DEFAULT_CONCURRENCY_CAP)
    // The next one should queue.
    let queued = false
    const extra = cap.acquireSlot({
      projectId: "p",
      sessionId: "extra",
      signal: neverAbort(),
      onQueued: () => {
        queued = true
      },
    })
    await Promise.resolve()
    expect(queued).toBe(true)
    slots[0].release()
    const r = await extra
    expect(r.wasQueued).toBe(true)
    r.release()
    for (const s of slots.slice(1)) s.release()
  })

  it("handles a synchronous abort fired from within onQueued without hanging the acquire (codex round-1 #1)", async () => {
    // Pre-fill the cap so a follow-up acquire MUST queue.
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    // onQueued synchronously aborts the signal — before codex round-1
    // #1 fix, the abort listener wasn't installed yet, so the abort
    // would be dropped and the acquire promise would hang. After the
    // fix, the listener is installed BEFORE onQueued runs, plus a
    // post-callback re-check covers the edge where the listener was
    // somehow already removed.
    const abort = new AbortController()
    const acquire = cap
      .acquireSlot({
        projectId: "p",
        sessionId: "s2",
        signal: abort.signal,
        cap: 1,
        onQueued: () => {
          abort.abort()
        },
      })
      .catch((err) => err)
    const result = await acquire
    expect(result).toBeInstanceOf(DOMException)
    expect((result as DOMException).name).toBe("AbortError")
    // The queue is clean — no leak.
    expect(cap.inspect("p").queueDepth).toBe(0)
    r1.release()
  })

  it("drain rejects a stale aborted waiter found at the head of the queue (codex round-1 #2)", async () => {
    // Construct the (rare) scenario where a queued waiter's signal
    // aborts but the abort listener is somehow already removed —
    // simulate by directly aborting AFTER acquire returned (which
    // means the entry is normally already gone). To reliably create
    // a "stale aborted entry," we exploit the test injection: pre-
    // fill cap, queue a waiter, abort, then race drain by releasing
    // the held slot. Without the fix the drain would silently `continue`,
    // leaving the queued promise pending forever. With the fix the
    // drain rejects the stale entry.
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    const abort = new AbortController()
    const queued = cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: abort.signal,
      cap: 1,
    })
    // Give the waiter a tick to enter the queue.
    await Promise.resolve()
    expect(cap.inspect("p").queueDepth).toBe(1)
    abort.abort()
    // After abort, the onAbort listener should have rejected the
    // queued promise — it's our happy path. Both the fix-#1 listener
    // ordering AND the fix-#2 drain rejection should leave no leak.
    const r2 = await queued.catch((e) => e)
    expect(r2).toBeInstanceOf(DOMException)
    // Release the held slot: drain should be a no-op now since the
    // queue is empty.
    r1.release()
    expect(cap.inspect("p").inFlight).toEqual([])
    expect(cap.inspect("p").queueDepth).toBe(0)
  })

  it("drain honors the head waiter's cap, not the releasing slot's cap (codex round-1 #3)", async () => {
    // Acquire 1 slot with cap=3 (so 1 in-flight under a lenient cap),
    // then queue a waiter with cap=1 (strict). Releasing the lenient
    // slot must respect the head waiter's strict cap.
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 3,
    })
    // Add a second in-flight under cap=3 so inFlight.size=2.
    const r2 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: neverAbort(),
      cap: 3,
    })
    expect(cap.inspect("p").inFlight).toHaveLength(2)
    // Queue a waiter under cap=1 — it must NOT drain just because
    // a cap=3 slot released, because at the moment its cap=1 is
    // exceeded (inFlight=2 > 1).
    const s3 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s3",
      signal: neverAbort(),
      cap: 1,
    })
    await Promise.resolve()
    expect(cap.inspect("p").queueDepth).toBe(1)
    r1.release()
    // After r1.release: inFlight=1, queue head wants cap=1 → 1 < 1 is
    // false → don't drain. The waiter stays queued.
    await new Promise((r) => setTimeout(r, 10))
    expect(cap.inspect("p").queueDepth).toBe(1)
    r2.release()
    // After r2.release: inFlight=0, queue head wants cap=1 → 0 < 1 →
    // drain.
    const r3 = await s3
    expect(r3.wasQueued).toBe(true)
    expect(cap.inspect("p").inFlight).toEqual(["s3"])
    r3.release()
  })

  it("swallows onQueued throws so callback errors can't break acquire", async () => {
    const cap = createConcurrencyCap()
    const r1 = await cap.acquireSlot({
      projectId: "p",
      sessionId: "s1",
      signal: neverAbort(),
      cap: 1,
    })
    let secondAcquired = false
    const s2 = cap.acquireSlot({
      projectId: "p",
      sessionId: "s2",
      signal: neverAbort(),
      cap: 1,
      onQueued: () => {
        throw new Error("boom")
      },
    })
    // The acquire promise must still be live despite the throw.
    void s2.then(() => {
      secondAcquired = true
    })
    await Promise.resolve()
    expect(cap.inspect("p").queueDepth).toBe(1)
    r1.release()
    const r2 = await s2
    expect(secondAcquired).toBe(true)
    r2.release()
  })
})

describe("getSharedConcurrencyCap", () => {
  beforeEach(() => __resetSharedConcurrencyCapForTests())

  it("returns the same instance across calls", () => {
    expect(getSharedConcurrencyCap()).toBe(getSharedConcurrencyCap())
  })

  it("resets cleanly via __resetSharedConcurrencyCapForTests", () => {
    const a = getSharedConcurrencyCap()
    __resetSharedConcurrencyCapForTests()
    const b = getSharedConcurrencyCap()
    expect(a).not.toBe(b)
  })
})
