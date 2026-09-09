/**
 * The one-modal-owner queue, as pure values.
 *
 * The Editor raises two dialogs about edits and they ask about the same edit
 * from opposite ends: the SCOPE dialog asks "this item or all items?" for an
 * edit the iteration lane is holding, and the DISAMBIGUATION dialog asks "this
 * instance or all instances?" for a draft the bridge is holding. Either can be
 * raised while the other is open, from four independent places, so until
 * round 10 they stacked in whichever order they arrived (finding R1).
 *
 * Generic over the scope prompt's payload, because that payload
 * (`PendingIterationEdit`) reaches into the components layer and this module
 * may not import React. The caller supplies `promptDraftId`, which is the only
 * thing the queue needs to know about it.
 */
import type { PendingMutation } from "@/editor/core"

/** A dialog the shell owes the designer, as a value. */
export type ModalRequest<Prompt> =
  /** The scope prompt, for an edit the iteration lane verified. */
  | { kind: "scope"; pending: Prompt }
  /**
   * The deterministic mutation dialog, for a draft the bridge is holding.
   *
   * `reason` is the status line a park shows when it finally opens. It is
   * absent for the bridge's ordinary route, because that one is not a park:
   * nothing failed and there is nothing to explain.
   */
  | { kind: "disambiguation"; mutation: PendingMutation; reason?: string }

/** Which of the two dialogs a request is for, and which one currently owns. */
export type ModalKind = ModalRequest<unknown>["kind"]

/** Open it now, or hold it behind whatever is already on screen. */
export type ModalDecision<Prompt> =
  | { open: ModalRequest<Prompt> }
  | { deferred: ModalRequest<Prompt>[] }

export interface ModalQueue<Prompt> {
  /**
   * Which bridge draft a request is about, or undefined when it is about none.
   *
   * The two kinds name the same thing two ways: the bridge's `pendingId` IS the
   * iteration edit's `bridgePendingId`. Reducing both to one key is what lets
   * the queue hold one entry per draft no matter which dialog asked for it.
   */
  requestDraftId(request: ModalRequest<Prompt>): string | undefined
  /**
   * THE rule for raising either dialog. Nothing opens while anything is open,
   * in EITHER direction. A non-empty queue with no owner cannot happen (the
   * release opens the head); it is treated as owned anyway, because opening
   * past a queue would put the newcomer in front of edits that have waited
   * longer.
   */
  enqueue(
    queue: readonly ModalRequest<Prompt>[],
    request: ModalRequest<Prompt>,
    currentOwner: ModalKind | null,
  ): ModalDecision<Prompt>
  /** Take the next request off the queue when the open dialog closes. FIFO. */
  dequeue(queue: readonly ModalRequest<Prompt>[]): {
    next: ModalRequest<Prompt> | null
    queue: ModalRequest<Prompt>[]
  }
  /**
   * Forget every queued request about a draft that has just been given back to
   * the bridge. A queued request holds a payload, not a promise that the
   * payload still exists.
   */
  dropForDraft(
    queue: readonly ModalRequest<Prompt>[],
    draftId: string | undefined,
  ): ModalRequest<Prompt>[]
}

export function createModalQueue<Prompt>(
  promptDraftId: (prompt: Prompt) => string | undefined,
): ModalQueue<Prompt> {
  const requestDraftId = (request: ModalRequest<Prompt>): string | undefined =>
    request.kind === "disambiguation"
      ? request.mutation.pendingId
      : promptDraftId(request.pending)

  /**
   * Add a request, or replace the entry already in it for the same in-page
   * typing session. Replacing matters because the designer can keep typing on
   * the held element: every keystroke round trip rebuilds the pending object
   * and re-collides, and the queue must end up holding the LATEST text. The
   * match is on the DRAFT, not on the kind.
   */
  const push = (
    queue: readonly ModalRequest<Prompt>[],
    request: ModalRequest<Prompt>,
  ): ModalRequest<Prompt>[] => {
    const draftId = requestDraftId(request)
    const at = queue.findIndex(
      (existing) =>
        (existing.kind === "scope" &&
          request.kind === "scope" &&
          existing.pending === request.pending) ||
        (draftId !== undefined && requestDraftId(existing) === draftId),
    )
    if (at === -1) return [...queue, request]
    const next = queue.slice()
    next[at] = request
    return next
  }

  return {
    requestDraftId,
    enqueue(queue, request, currentOwner) {
      if (currentOwner === null && queue.length === 0) return { open: request }
      return { deferred: push(queue, request) }
    },
    dequeue(queue) {
      const [next, ...rest] = queue
      if (!next) return { next: null, queue: [] }
      return { next, queue: rest }
    },
    dropForDraft(queue, draftId) {
      if (!draftId) return [...queue]
      return queue.filter((request) => requestDraftId(request) !== draftId)
    },
  }
}
