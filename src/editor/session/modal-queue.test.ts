import { describe, expect, it } from "vitest"
import type { PendingMutation } from "@/editor/core"
import { createModalQueue, type ModalRequest } from "./modal-queue"

/** The scope-prompt payload, reduced to the one field the queue reads. */
interface Prompt {
  label: string
  bridgePendingId?: string
}

const queue = createModalQueue<Prompt>((prompt) => prompt.bridgePendingId)

const scope = (label: string, bridgePendingId?: string): ModalRequest<Prompt> => ({
  kind: "scope",
  pending: { label, ...(bridgePendingId ? { bridgePendingId } : {}) },
})

const park = (pendingId: string, reason?: string): ModalRequest<Prompt> => ({
  kind: "disambiguation",
  mutation: { pendingId } as unknown as PendingMutation,
  ...(reason ? { reason } : {}),
})

describe("createModalQueue", () => {
  it("opens a request when nothing owns the modal and nothing is waiting", () => {
    const decision = queue.enqueue([], scope("a"), null)
    expect(decision).toEqual({ open: scope("a") })
  })

  it("defers while either dialog owns the modal, in both directions", () => {
    expect(queue.enqueue([], scope("a"), "disambiguation")).toEqual({
      deferred: [scope("a")],
    })
    expect(queue.enqueue([], park("dom-pending-1"), "scope")).toEqual({
      deferred: [park("dom-pending-1")],
    })
  })

  it("treats a non-empty queue as owned, so a newcomer cannot jump it", () => {
    const decision = queue.enqueue([park("dom-pending-1")], scope("a"), null)
    expect(decision).toEqual({ deferred: [park("dom-pending-1"), scope("a")] })
  })

  it("replaces the queued entry for the same draft, latest text wins", () => {
    const first = queue.enqueue([], scope("first", "dom-pending-1"), "scope")
    expect("deferred" in first).toBe(true)
    const second = queue.enqueue(
      "deferred" in first ? first.deferred : [],
      scope("second", "dom-pending-1"),
      "scope",
    )
    expect(second).toEqual({ deferred: [scope("second", "dom-pending-1")] })
  })

  it("collapses a park and a scope question about one draft into one entry", () => {
    const decision = queue.enqueue(
      [scope("a", "dom-pending-1")],
      park("dom-pending-1", "held"),
      "scope",
    )
    expect(decision).toEqual({ deferred: [park("dom-pending-1", "held")] })
  })

  it("dequeues FIFO and empties", () => {
    expect(queue.dequeue([park("p1"), park("p2")])).toEqual({
      next: park("p1"),
      queue: [park("p2")],
    })
    expect(queue.dequeue([])).toEqual({ next: null, queue: [] })
  })

  it("drops every queued request about a draft that was given back", () => {
    const remaining = queue.dropForDraft(
      [scope("a", "dom-pending-1"), park("dom-pending-1"), park("dom-pending-2")],
      "dom-pending-1",
    )
    expect(remaining).toEqual([park("dom-pending-2")])
  })

  it("reads the draft id off either kind", () => {
    expect(queue.requestDraftId(park("dom-pending-3"))).toBe("dom-pending-3")
    expect(queue.requestDraftId(scope("a", "dom-pending-4"))).toBe("dom-pending-4")
    expect(queue.requestDraftId(scope("a"))).toBeUndefined()
  })
})
