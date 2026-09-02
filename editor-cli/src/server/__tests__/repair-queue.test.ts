/**
 * Unit tests for `createRepairQueue` (final review fix wave) — the
 * single-flight serialization queue `drift-handler.ts`'s `maybeTriggerRepair`
 * routes every auto-repair through. See `repair-queue.ts`'s doc comment for
 * why: `repairComponent` runs a synchronous TS program per call, so an
 * unbounded fire-and-forget fan-out could stall the whole CLI event loop.
 */

import { describe, expect, it, vi } from "vitest"
import type { RepairOutcome } from "../../../../src/editor/drift/repair-component.js"
import { createRepairQueue } from "../repair-queue.js"

/** A job whose resolution is controlled externally by the test. */
class DeferredJob {
  calls = 0
  private resolveFn: ((outcome: RepairOutcome) => void) | null = null

  job = (): Promise<RepairOutcome> => {
    this.calls += 1
    return new Promise<RepairOutcome>((resolve) => {
      this.resolveFn = resolve
    })
  }

  resolve(outcome: RepairOutcome): void {
    this.resolveFn?.(outcome)
  }
}

function deferredJob(): DeferredJob {
  return new DeferredJob()
}

describe("createRepairQueue", () => {
  it("runs the first job immediately", async () => {
    const queue = createRepairQueue()
    const a = deferredJob()
    const p = queue.enqueue(a.job)
    // Synchronous: the first job starts right away, no queueing needed.
    expect(a.calls).toBe(1)
    a.resolve({ outcome: "repaired" })
    await expect(p).resolves.toEqual({ outcome: "repaired" })
  })

  it("never runs a second job while the first is still in flight (single-flight)", async () => {
    const queue = createRepairQueue()
    const a = deferredJob()
    const b = deferredJob()
    void queue.enqueue(a.job)
    void queue.enqueue(b.job)

    expect(a.calls).toBe(1)
    expect(b.calls).toBe(0) // queued, not started

    a.resolve({ outcome: "unchanged" })
    await Promise.resolve()
    await Promise.resolve()

    expect(b.calls).toBe(1) // now started, after `a` settled
  })

  it("runs jobs strictly in FIFO order", async () => {
    const queue = createRepairQueue()
    const order: string[] = []
    const jobs = ["a", "b", "c"].map((name) => ({
      name,
      job: () =>
        new Promise<RepairOutcome>((resolve) => {
          order.push(`start:${name}`)
          setTimeout(() => resolve({ outcome: "unchanged" }), 0)
        }),
    }))

    const results = jobs.map((j) => queue.enqueue(j.job))
    await Promise.all(results)

    expect(order).toEqual(["start:a", "start:b", "start:c"])
  })

  it("resolves a queue-full submission immediately with a clear reason, and never invokes that job", async () => {
    const queue = createRepairQueue(2) // cap 2 pending
    const running = deferredJob()
    const pending1 = deferredJob()
    const pending2 = deferredJob()
    const overflow = vi.fn(() => Promise.resolve<RepairOutcome>({ outcome: "repaired" }))

    void queue.enqueue(running.job) // starts immediately
    void queue.enqueue(pending1.job) // queued (1/2)
    void queue.enqueue(pending2.job) // queued (2/2) — cap reached

    const overflowResult = await queue.enqueue(overflow) // rejected outright

    expect(overflowResult.outcome).toBe("failed")
    expect(overflowResult.reason).toMatch(/queue full/i)
    expect(overflow).not.toHaveBeenCalled()

    // Clean up the still-pending jobs so they don't leak into other tests.
    running.resolve({ outcome: "unchanged" })
    await Promise.resolve()
    await Promise.resolve()
    pending1.resolve({ outcome: "unchanged" })
    await Promise.resolve()
    await Promise.resolve()
    pending2.resolve({ outcome: "unchanged" })
  })

  it("accepts new work again once the pending queue drops back below cap", async () => {
    const queue = createRepairQueue(1) // cap 1 pending
    const running = deferredJob()
    const pending = deferredJob()

    void queue.enqueue(running.job)
    void queue.enqueue(pending.job) // fills the 1-slot pending cap

    const rejected = await queue.enqueue(() => Promise.resolve<RepairOutcome>({ outcome: "repaired" }))
    expect(rejected.outcome).toBe("failed")

    // Free up a pending slot by letting `running` settle — `pending` now
    // starts running, and the queue has room again.
    running.resolve({ outcome: "unchanged" })
    await Promise.resolve()
    await Promise.resolve()

    const later = deferredJob()
    void queue.enqueue(later.job)
    expect(later.calls).toBe(0) // `pending` is now the one running

    pending.resolve({ outcome: "unchanged" })
    await Promise.resolve()
    await Promise.resolve()
    expect(later.calls).toBe(1)

    later.resolve({ outcome: "unchanged" })
  })

  it("never throws: a job whose promise rejects settles as a 'failed' outcome and does not wedge the queue", async () => {
    const queue = createRepairQueue()
    const throwing = () => Promise.reject(new Error("checker exploded"))
    const result = await queue.enqueue(throwing)
    expect(result).toEqual({ outcome: "failed", reason: "checker exploded" })

    // The queue must still be usable afterward (not wedged at runningCount 1).
    const next = deferredJob()
    void queue.enqueue(next.job)
    expect(next.calls).toBe(1)
    next.resolve({ outcome: "repaired" })
  })
})
