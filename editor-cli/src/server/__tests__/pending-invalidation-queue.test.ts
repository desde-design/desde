/**
 * Unit tests for `createPendingInvalidationQueue` (Phase 5 Task 2
 * root-cause fix, 2026-07-30) — the `DriftLog`-independent delivery
 * mechanism `drift-handler.ts`'s `maybeTriggerRepair` enqueues onto at
 * REPAIR-SETTLE time, and every drift response (`GET`/`POST`/both
 * `DELETE` routes) drains into its `invalidate` field. See
 * `pending-invalidation-queue.ts`'s doc comment for the full "why" — this
 * queue exists specifically so a settled repair's invalidation survives a
 * dismiss/clear-all racing ahead of it.
 */

import { describe, expect, it, vi } from "vitest"
import { createPendingInvalidationQueue } from "../pending-invalidation-queue.js"

describe("createPendingInvalidationQueue", () => {
  it("drain() returns nothing when empty", () => {
    const queue = createPendingInvalidationQueue()
    expect(queue.drain()).toEqual([])
  })

  it("delivers an enqueued invalidation on the next drain", () => {
    const queue = createPendingInvalidationQueue()
    queue.enqueue({ name: "UiButton", importPath: "@acme/design-system", attemptedAt: "2026-07-30T00:00:00.000Z" })
    expect(queue.drain()).toEqual([
      { name: "UiButton", importPath: "@acme/design-system", attemptedAt: "2026-07-30T00:00:00.000Z" },
    ])
  })

  it("drain() empties the queue — a settled repair is delivered exactly ONCE", () => {
    const queue = createPendingInvalidationQueue()
    queue.enqueue({ name: "UiButton", attemptedAt: "2026-07-30T00:00:00.000Z" })
    expect(queue.drain()).toHaveLength(1)
    expect(queue.drain()).toEqual([]) // already drained — not re-sent
  })

  it("preserves FIFO order and accumulates multiple enqueues before a drain", () => {
    const queue = createPendingInvalidationQueue()
    queue.enqueue({ name: "A", attemptedAt: "2026-07-30T00:00:00.000Z" })
    queue.enqueue({ name: "B", attemptedAt: "2026-07-30T00:01:00.000Z" })
    queue.enqueue({ name: "C", attemptedAt: "2026-07-30T00:02:00.000Z" })
    expect(queue.drain().map((e) => e.name)).toEqual(["A", "B", "C"])
  })

  it("caps at the configured size, dropping the OLDEST entry and warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const queue = createPendingInvalidationQueue(3)
    queue.enqueue({ name: "A", attemptedAt: "t0" })
    queue.enqueue({ name: "B", attemptedAt: "t1" })
    queue.enqueue({ name: "C", attemptedAt: "t2" })
    queue.enqueue({ name: "D", attemptedAt: "t3" }) // over cap — drops "A"

    const drained = queue.drain()
    expect(drained.map((e) => e.name)).toEqual(["B", "C", "D"])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exceeded cap/i))
    warn.mockRestore()
  })

  it("resumes normal capacity after a drain (cap only bounds items since the last drain)", () => {
    const queue = createPendingInvalidationQueue(2)
    queue.enqueue({ name: "A", attemptedAt: "t0" })
    queue.enqueue({ name: "B", attemptedAt: "t1" })
    expect(queue.drain().map((e) => e.name)).toEqual(["A", "B"])

    queue.enqueue({ name: "C", attemptedAt: "t2" })
    expect(queue.drain().map((e) => e.name)).toEqual(["C"])
  })
})
