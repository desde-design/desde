import { describe, expect, it } from "vitest"
import type { IterationContext } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  bridgeDraftIdOf,
  clickedInsideRow,
  DEFERRED_PARK_STATUS,
  decideAfterVerify,
  describeAmbiguousIteration,
  discardedOnResetStatus,
  NOT_CONNECTED_STATUS,
  rowsToRelease,
  describeRowScopedEdit,
  endSentence,
  errorMessage,
  handOffFailureStatus,
  isStaleGeneration,
  isStaleVerify,
  mayClearInFlightMarker,
  iterationRouteFor,
  iterationTemplateLocation,
  parkedReason,
  promptCollision,
  PROMPT_BUSY_STATUS,
  hasUndispatchedWork,
  dequeueModal,
  dropModalRequestsForDraft,
  enqueueModal,
  modalRequestDraftId,
  sameBridgeDraft,
  SAVE_HANDOFF_TIMEOUT_STATUS,
  sessionEndPlan,
  settleHandOff,
  structuralRouteFor,
  thisRowOperationAllowed,
  thisRowTemplateLocation,
  verifyKeyFor,
  type ModalDecision,
  type ModalRequest,
  type PendingIterationEdit,
} from "./pending-iteration-edit"

const node = {
  id: "n1",
  name: "div",
  type: "element",
  x: 0, y: 0, width: 0, height: 0,
  selector: "body > main > div",
  authoredAt: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
  editTarget: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
} as unknown as OutlineNode

const iterationContext: IterationContext = { source: "map", key: 0, index: 0, siblingCount: 4, expression: null }

describe("iterationTemplateLocation", () => {
  it("reads the outline node's editTarget for a delete", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext,
    }
    expect(iterationTemplateLocation(pending)).toEqual(node.editTarget)
  })

  it("reads the selection's editTarget for a prop edit", () => {
    const pending: PendingIterationEdit = {
      editKind: "prop",
      selection: { selector: "a", editTarget: { file: "src/App.tsx", line: 3, column: 2 } } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    }
    expect(iterationTemplateLocation(pending)).toEqual({ file: "src/App.tsx", line: 3, column: 2 })
  })
})

describe("describeAmbiguousIteration", () => {
  it("phrases a delete as 'delete the element' with the row index and count, on the NODE's selector", () => {
    // A Layers-panel delete carries whatever the iframe had selected, which is
    // routinely a different element from the row that was deleted.
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "body > header > button.icon" } as never,
      node,
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, node.editTarget!, "no .map()")
    expect(d).toMatchObject({
      requested: "delete the element",
      tagName: "div",
      selector: "body > main > div",
      location: node.editTarget,
      index: 0,
      siblingCount: 4,
      noLoopReason: "no .map()",
    })
    expect(d.selector).not.toBe("body > header > button.icon")
  })

  it("phrases a prop edit with the prop name and JSON value", () => {
    const pending: PendingIterationEdit = {
      editKind: "prop",
      selection: { selector: "a", componentName: "KButton", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, { file: "src/App.vue", line: 3, column: 2 }, "no v-for")
    expect(d.requested).toBe('set the prop `size` to "lg"')
    expect(d.componentName).toBe("KButton")
  })

  it("phrases a text edit with the new text", () => {
    const pending: PendingIterationEdit = {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
    }
    expect(describeAmbiguousIteration(pending, { file: "src/App.vue", line: 3, column: 2 }, "x").requested).toBe('change the text to "Hello"')
  })

  it("carries the move destination, which 'move the element' alone loses", () => {
    const pending: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, selector: "li.row", name: "li", type: "element" },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 14, column: 6 } },
        destIndex: 2,
      } as never,
      iterationContext,
    }
    const d = describeAmbiguousIteration(pending, node.editTarget!, "no .map()")
    expect(d.requested).toBe("move the element")
    expect(d.detail).toBe("move it to be child index 2 of the element at src/App.tsx:14:6")
    expect(d.selector).toBe("li.row")
  })

  it("says append when the move landed at the end, and falls back with no destination position", () => {
    function move(destParent: Partial<OutlineNode>, destIndex: number): PendingIterationEdit {
      return {
        editKind: "move",
        payload: { source: node, destParent: { ...node, ...destParent }, destIndex } as never,
        iterationContext,
      }
    }
    expect(
      describeAmbiguousIteration(
        move({ editTarget: { file: "src/App.tsx", line: 14, column: 6 } }, -1),
        node.editTarget!,
        "x",
      ).detail,
    ).toBe("append it to the element at src/App.tsx:14:6")
    expect(
      describeAmbiguousIteration(move({ editTarget: undefined }, 0), node.editTarget!, "x").detail,
    ).toBe("move it within the page")
  })

  it("gives the other kinds no detail, because the verb already carries the payload", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "x" } as never,
      node,
      iterationContext,
    }
    expect(describeAmbiguousIteration(pending, node.editTarget!, "x").detail).toBeUndefined()
  })
})

describe("sameBridgeDraft", () => {
  function domText(bridgePendingId?: string): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
      ...(bridgePendingId ? { bridgePendingId } : {}),
    }
  }

  it("is true for two distinct objects holding the same bridge draft", () => {
    expect(sameBridgeDraft(domText("p-1"), domText("p-1"))).toBe(true)
  })

  it("is false for different drafts, for a missing id, and for non-dom-text kinds", () => {
    expect(sameBridgeDraft(domText("p-1"), domText("p-2"))).toBe(false)
    expect(sameBridgeDraft(domText(), domText())).toBe(false)
    expect(sameBridgeDraft(domText("p-1"), domText())).toBe(false)
    const del: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "x" } as never,
      node,
      iterationContext,
    }
    expect(sameBridgeDraft(del, domText("p-1"))).toBe(false)
  })
})

describe("promptCollision", () => {
  function domText(bridgePendingId?: string, value = "Hello"): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value,
      iterationContext,
      ...(bridgePendingId ? { bridgePendingId } : {}),
    }
  }
  const del: PendingIterationEdit = {
    editKind: "delete",
    selection: { selector: "x" } as never,
    node,
    iterationContext,
  }
  const move: PendingIterationEdit = {
    editKind: "move",
    payload: { source: node, destParent: node, destIndex: 1 } as never,
    iterationContext,
  }

  it("opens the incoming edit when no prompt is on screen", () => {
    expect(promptCollision(null, del)).toBe("open-incoming")
    expect(promptCollision(undefined, del)).toBe("open-incoming")
  })

  it("opens the incoming edit when it IS the open one", () => {
    expect(promptCollision(del, del)).toBe("open-incoming")
  })

  it("keeps today's behaviour for two objects holding the same bridge draft", () => {
    // One in-page typing session, rebuilt per keystroke. The newer object has
    // the newer text, so it replaces the older one as it always did.
    expect(promptCollision(domText("p-1", "Hell"), domText("p-1", "Hello"))).toBe("open-incoming")
  })

  it("parks a NEWCOMER that holds a bridge draft, keeping the open question", () => {
    // Replacing the open prompt cancelled its draft. Keeping it and cancelling
    // the newcomer's would lose the newly typed text instead. Parking loses
    // neither.
    expect(promptCollision(del, domText("p-2"))).toBe("keep-open-park-incoming")
    expect(promptCollision(domText("p-1"), domText("p-2"))).toBe("keep-open-park-incoming")
  })

  it("drops a newcomer with nothing to park, so it is reported rather than silent", () => {
    expect(promptCollision(domText("p-1"), del)).toBe("keep-open-drop-incoming")
    expect(promptCollision(del, move)).toBe("keep-open-drop-incoming")
    // An in-page edit with no bridge draft id has nothing held either.
    expect(promptCollision(del, domText())).toBe("keep-open-drop-incoming")
  })
})

describe("the modal queue: enqueueModal / dequeueModal / dropModalRequestsForDraft", () => {
  function domText(bridgePendingId: string, value = "Hello"): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector: "p", editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value,
      iterationContext,
      bridgePendingId,
    }
  }
  const scope = (id: string, value = "Hello") => ({
    kind: "scope" as const,
    pending: domText(id, value),
  })
  const disambiguation = (id: string, reason?: string): ModalRequest => ({
    kind: "disambiguation",
    mutation: { pendingId: id } as never,
    ...(reason === undefined ? {} : { reason }),
  })
  /** The queue half of a decision, or a failure if it opened instead. */
  function deferredOf(decision: ModalDecision): ModalRequest[] {
    if ("open" in decision) throw new Error("expected the request to be deferred")
    return decision.deferred
  }

  it("opens the request when nothing owns the modal and nothing is waiting", () => {
    const request = scope("p-1")
    expect(enqueueModal([], request, null)).toEqual({ open: request })
  })

  it.each([
    ["the scope dialog", "scope" as const],
    ["the disambiguation dialog", "disambiguation" as const],
  ])("opens nothing while %s owns the modal", (_label, owner) => {
    // The round-10 defect, both directions. The exclusion used to be one-way:
    // a park asked whether a scope prompt was open, and a verify asked whether
    // another scope prompt was open, so neither saw the mutation dialog.
    const request = scope("p-1")
    expect(enqueueModal([], request, owner)).toEqual({ deferred: [request] })
    const park = disambiguation("p-2", "parked")
    expect(enqueueModal([], park, owner)).toEqual({ deferred: [park] })
  })

  it("opens nothing while requests are still waiting, even with no owner", () => {
    const waiting = scope("p-1")
    const request = disambiguation("p-2")
    expect(enqueueModal([waiting], request, null)).toEqual({
      deferred: [waiting, request],
    })
  })

  it("queues FIFO and dequeues in the same order", () => {
    const first = scope("p-1")
    const second = disambiguation("p-2")
    const third = scope("p-3")
    let queue: ModalRequest[] = []
    for (const request of [first, second, third]) {
      queue = deferredOf(enqueueModal(queue, request, "scope"))
    }
    expect(queue).toEqual([first, second, third])
    const afterFirst = dequeueModal(queue)
    expect(afterFirst.next).toBe(first)
    const afterSecond = dequeueModal(afterFirst.queue)
    expect(afterSecond.next).toBe(second)
    const afterThird = dequeueModal(afterSecond.queue)
    expect(afterThird.next).toBe(third)
    expect(dequeueModal(afterThird.queue)).toEqual({ next: null, queue: [] })
  })

  it("does not mutate the queue it is given", () => {
    const queue: ModalRequest[] = []
    enqueueModal(queue, scope("p-1"), "scope")
    expect(queue).toEqual([])
  })

  it("replaces the entry for the same in-page typing session, keeping its place", () => {
    // The designer keeps typing on the held element: every keystroke round
    // trip rebuilds the pending object and re-collides. The queue must end up
    // with the LATEST text once, not the first keystroke plus a stack of
    // duplicates.
    const other = scope("p-2")
    const early = scope("p-1", "Hell")
    const late = scope("p-1", "Hello")
    let queue: ModalRequest[] = []
    for (const request of [early, other, late]) {
      queue = deferredOf(enqueueModal(queue, request, "disambiguation"))
    }
    expect(queue).toHaveLength(2)
    expect(queue[0]).toBe(late)
    expect(queue[1]).toBe(other)
  })

  it("replaces a request re-queued as the very same object", () => {
    const request = scope("p-1")
    const again: ModalRequest = { kind: "scope", pending: request.pending }
    expect(enqueueModal([request], again, "scope")).toEqual({ deferred: [again] })
  })

  it("holds one entry per draft even when the two kinds name the same one", () => {
    // The bridge's `pendingId` IS the iteration edit's `bridgePendingId`. A
    // scope question still waiting when its lane gives up is one edit, and
    // keeping both would ask about one draft in two dialogs.
    const question = scope("p-1")
    const park = disambiguation("p-1", "parked")
    expect(enqueueModal([question], park, "scope")).toEqual({ deferred: [park] })
    expect(enqueueModal([park], question, "scope")).toEqual({ deferred: [question] })
  })

  it("keeps requests for different drafts apart", () => {
    const first = disambiguation("p-1", "a")
    const second = disambiguation("p-2", "b")
    expect(enqueueModal([first], second, "scope")).toEqual({
      deferred: [first, second],
    })
  })

  it("reads the draft id out of either kind", () => {
    expect(modalRequestDraftId(scope("p-1"))).toBe("p-1")
    expect(modalRequestDraftId(disambiguation("p-1"))).toBe("p-1")
    // A structural edit holds no bridge draft, so it names none.
    expect(
      modalRequestDraftId({
        kind: "scope",
        pending: { editKind: "delete", selection: {} as never, node, iterationContext },
      }),
    ).toBeUndefined()
  })

  it("drops every waiting request about a draft that has gone back to the bridge", () => {
    const gone = scope("p-1")
    const kept = disambiguation("p-2", "kept")
    expect(dropModalRequestsForDraft([gone, kept], "p-1")).toEqual([kept])
    // Nothing to match on: an edit with no draft cannot be identified this way,
    // so the queue is returned whole rather than emptied.
    expect(dropModalRequestsForDraft([gone, kept], undefined)).toEqual([gone, kept])
  })
})

describe("rowsToRelease", () => {
  const row = (pendingId: string) => ({ pendingId } as never)

  it("names every row the bridge is holding a draft for", () => {
    const rows = [row("p-1"), row("p-2")]
    expect(rowsToRelease(rows)).toEqual(rows)
  })

  it("leaves out a row with no bridge id", () => {
    // Nothing produces one today. The rule is "a row the bridge is holding",
    // and cancelling an id the adapter never issued is a message about nothing.
    expect(rowsToRelease([row("p-1"), row("")])).toEqual([row("p-1")])
  })

  it("does not mutate the rows it is given", () => {
    const rows = [row("p-1")]
    rowsToRelease(rows)
    expect(rows).toHaveLength(1)
  })
})

describe("discardedOnResetStatus", () => {
  it("counts the discarded edits, singular and plural", () => {
    expect(discardedOnResetStatus(1)).toBe(
      "The page connection was reset; 1 pending edit was discarded.",
    )
    expect(discardedOnResetStatus(3)).toBe(
      "The page connection was reset; 3 pending edits were discarded.",
    )
  })

  it("says nothing when nothing was discarded", () => {
    // A re-attach that was holding nothing is not an event, and the sentence
    // would be alarming about a page that lost nothing.
    expect(discardedOnResetStatus(0)).toBeNull()
    expect(discardedOnResetStatus(-1)).toBeNull()
  })

  it("uses no em dash and no first person", () => {
    for (const count of [1, 2]) {
      const status = discardedOnResetStatus(count) ?? ""
      expect(status).not.toMatch(/—/)
      expect(status).not.toMatch(/\b(me|my)\b/i)
    }
  })
})

describe("NOT_CONNECTED_STATUS", () => {
  it("says what is wrong and what to do, with no em dash and no first person", () => {
    expect(NOT_CONNECTED_STATUS).toBe("The page is not connected. Reload and try again.")
    expect(NOT_CONNECTED_STATUS).not.toMatch(/—/)
    expect(NOT_CONNECTED_STATUS).not.toMatch(/\b(me|my)\b/i)
  })
})

describe("hasUndispatchedWork", () => {
  const none = { aiQueue: 0, parked: 0, deferred: 0 }

  it("says there is nothing to warn about when all three counts are zero", () => {
    expect(hasUndispatchedWork(none)).toBe(false)
  })

  it.each([
    ["mutations queued for the AI lane", { ...none, aiQueue: 1 }],
    ["edits parked in the deterministic dialog", { ...none, parked: 1 }],
    ["parks held behind an open scope prompt", { ...none, deferred: 1 }],
  ])("warns on %s", (_label, counts) => {
    expect(hasUndispatchedWork(counts)).toBe(true)
  })

  /**
   * The deferred count is the one the unload guard did not read. A park behind
   * an open prompt has opened no dialog of its own yet, so it is the only one
   * of the three with nothing on screen to remind the designer it exists, and
   * a reload would take the bridge's held draft with it in silence.
   */
  it("counts a deferred park even when nothing else is outstanding", () => {
    expect(hasUndispatchedWork({ aiQueue: 0, parked: 0, deferred: 2 })).toBe(true)
  })
})

describe("DEFERRED_PARK_STATUS", () => {
  it("says the edit is kept and what happens next, unlike PROMPT_BUSY_STATUS", () => {
    expect(DEFERRED_PARK_STATUS).toBe(
      "This edit is held behind the open question. Answer it and this one is next.",
    )
    // The point of the two sentences differing: this one must NOT tell the
    // designer to repeat an edit that is still being held for them.
    expect(DEFERRED_PARK_STATUS).not.toMatch(/repeat/i)
  })

  it("uses no em dash and no first person", () => {
    expect(DEFERRED_PARK_STATUS).not.toMatch(/\u2014/)
    expect(DEFERRED_PARK_STATUS).not.toMatch(/\b(me|my)\b/i)
  })
})

describe("PROMPT_BUSY_STATUS", () => {
  it("says what to do first and that the edit must be repeated", () => {
    expect(PROMPT_BUSY_STATUS).toBe("Answer the open dialog first, then repeat this edit.")
  })

  it("uses no em dash and no first person", () => {
    expect(PROMPT_BUSY_STATUS).not.toMatch(/—/)
    expect(PROMPT_BUSY_STATUS).not.toMatch(/\b(me|my)\b/i)
  })
})

describe("isStaleVerify", () => {
  it("is false for the only verify in flight and for the newest one", () => {
    expect(isStaleVerify(1, 1)).toBe(false)
    expect(isStaleVerify(7, 7)).toBe(false)
  })

  it("is true for an older verify answering after a newer one started", () => {
    // A (seq 1) and B (seq 2) are both in flight; B is the latest. A's answer,
    // whenever it lands, may not touch the prompt or B's draft.
    expect(isStaleVerify(1, 2)).toBe(true)
  })
})

describe("verifyKeyFor", () => {
  function domTextAt(selector: string, bridgePendingId?: string): PendingIterationEdit {
    return {
      editKind: "dom-text",
      selection: { selector, editTarget: { file: "src/App.vue", line: 3, column: 2 } } as never,
      field: { id: "f" } as never,
      value: "Hello",
      iterationContext,
      ...(bridgePendingId ? { bridgePendingId } : {}),
    }
  }

  it("is the bridge draft id when the edit holds one", () => {
    // The run of verifies that genuinely supersede each other: one in-page
    // typing session, rebuilt on every keystroke, keeping the same draft id.
    expect(verifyKeyFor(domTextAt("p", "p-1"))).toBe("p-1")
    expect(verifyKeyFor(domTextAt("p.other", "p-1"))).toBe("p-1")
  })

  it("falls back to the element's selector when there is no draft", () => {
    expect(verifyKeyFor(domTextAt("main > p"))).toBe("main > p")
  })

  it("reads the OUTLINE node's selector for a delete, not the selection's", () => {
    // Same rule `describeAmbiguousIteration` follows: a Layers delete carries
    // whatever the iframe had selected, which is routinely another element.
    const del: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "body > header > button.icon" } as never,
      node,
      iterationContext,
    }
    expect(verifyKeyFor(del)).toBe(node.selector)
  })

  it("separates two different elements, which is the whole point", () => {
    // Under one global counter, editing B made A's answer stale, and a stale
    // answer releases its own bridge draft and reports "A newer edit replaced
    // this one." Nothing had replaced it.
    expect(verifyKeyFor(domTextAt("main > h1"))).not.toBe(
      verifyKeyFor(domTextAt("main > p")),
    )
  })

  it("keys a move on the SOURCE node's selector", () => {
    const move: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, selector: "main > li:nth-child(2)" },
        destParent: node,
        destIndex: 0,
      } as never,
      iterationContext,
    }
    expect(verifyKeyFor(move)).toBe("main > li:nth-child(2)")
  })
})

describe("decideAfterVerify", () => {
  const location = { file: "src/components/ui/card.tsx", line: 60, column: 4 }
  const pending: PendingIterationEdit = {
    editKind: "delete",
    selection: { selector: "body > header > button.icon" } as never,
    node,
    iterationContext,
  }

  it("error: releases the draft and says the check could not run", () => {
    expect(
      decideAfterVerify({
        outcome: { kind: "error", reason: "HTTP 500" },
        pending,
        location,
        remembered: undefined,
      }),
    ).toEqual({ kind: "release-and-status", message: "Could not check the source for a loop: HTTP 500" })
  })

  it("error: wins over a remembered scope, so a failed check never dispatches", () => {
    const action = decideAfterVerify({
      outcome: { kind: "error", reason: "offline" },
      pending,
      location,
      remembered: "all-rows",
    })
    expect(action.kind).toBe("release-and-status")
  })

  it("no-loop: hands off with the marker, the count, and the server's reason", () => {
    const action = decideAfterVerify({
      outcome: { kind: "no-loop", reason: "This element is not rendered by a `.map()` call" },
      pending,
      location,
      remembered: "all-rows",
    })
    expect(action.kind).toBe("hand-off")
    if (action.kind !== "hand-off") return
    expect(action.prompt.startsWith(EDIT_HANDOFF_MARKER)).toBe(true)
    expect(action.prompt).toContain("4 elements")
    expect(action.prompt).toContain("item 1 of 4")
    expect(action.prompt).toContain("src/components/ui/card.tsx:60:4")
    expect(action.prompt).toContain("not rendered by a `.map()` call")
  })

  it("loop with a remembered scope: dispatches that scope without asking", () => {
    // The loop is AT the clicked position here, so the carried position equals
    // the click. It is still carried: a `loop` verdict always has one now.
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map", location: { line: 60, column: 4 } },
        pending,
        location,
        remembered: "this-row",
      }),
    ).toEqual({ kind: "remembered", scope: "this-row", loopLocation: location })
  })

  it("loop with nothing remembered: opens the dialog", () => {
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map", location: { line: 60, column: 4 } },
        pending,
        location,
        remembered: undefined,
      }),
    ).toEqual({ kind: "prompt", loopLocation: location })
  })

  it("carries the loop's own position on both loop exits, keeping the verified file", () => {
    // The click stamped a nested element on line 71; the loop is on line 60.
    // "This item" has to dispatch against the loop, so the position travels
    // with the decision.
    const clicked = { file: "src/components/ui/card.tsx", line: 71, column: 12 }
    const outcome = { kind: "loop" as const, expression: "items.map", location: { line: 60, column: 4 } }
    expect(
      decideAfterVerify({ outcome, pending, location: clicked, remembered: undefined }),
    ).toEqual({
      kind: "prompt",
      loopLocation: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
    })
    expect(
      decideAfterVerify({ outcome, pending, location: clicked, remembered: "this-row" }),
    ).toEqual({
      kind: "remembered",
      scope: "this-row",
      loopLocation: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
    })
  })
})

describe("thisRowTemplateLocation", () => {
  const pending: PendingIterationEdit = {
    editKind: "delete",
    selection: { selector: node.selector } as never,
    node,
    iterationContext,
  }

  it("uses the clicked element's position when no loop position was verified", () => {
    expect(thisRowTemplateLocation(pending)).toEqual(node.editTarget)
  })

  it("prefers the verified loop's position over the clicked element's", () => {
    const loopLocation = { file: "src/components/ui/card.tsx", line: 41, column: 2 }
    expect(thisRowTemplateLocation({ ...pending, loopLocation })).toEqual(loopLocation)
  })
})

describe("clickedInsideRow / thisRowOperationAllowed", () => {
  const rootLocation = { file: "src/components/ui/card.tsx", line: 60, column: 4 }
  const nestedLoopLocation = { file: "src/components/ui/card.tsx", line: 41, column: 2 }

  /** One pending edit per kind, all clicking the element at `rootLocation`. */
  const byKind: Record<string, PendingIterationEdit> = {
    delete: {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext,
    },
    move: {
      editKind: "move",
      payload: {
        source: { ...node, editTarget: rootLocation },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 9, column: 0 } },
        destIndex: 2,
      } as never,
      iterationContext,
    },
    prop: {
      editKind: "prop",
      selection: { selector: "a", editTarget: rootLocation } as never,
      propName: "size",
      value: "lg",
      iterationContext,
    },
    "dom-text": {
      editKind: "dom-text",
      selection: { selector: "a", editTarget: rootLocation } as never,
      field: { selector: "a", textNodeIndex: 0 } as never,
      value: "new",
      iterationContext,
    },
  }

  const kinds = ["delete", "move", "prop", "dom-text"] as const

  it.each(kinds)("a click ON the loop element allows the row operation (%s)", (kind) => {
    // The verify answered with the same position that was clicked, so the row
    // IS what the designer picked and `remove` / `reorder` mean what they say.
    const pending = { ...byKind[kind], loopLocation: rootLocation } as PendingIterationEdit
    expect(clickedInsideRow(pending)).toBe(false)
    expect(thisRowOperationAllowed(pending)).toBe(true)
  })

  it.each(["delete", "move"] as const)(
    "no verified loop position REFUSES the row operation (%s)",
    (kind) => {
      // Fails closed. "Not nested" has to be positively established, because
      // reading a missing position as "the click IS the loop" produces the
      // worst edit available (the whole item removed, the rows reordered by a
      // sibling index) from the least information.
      expect(clickedInsideRow(byKind[kind])).toBe(false)
      expect(thisRowOperationAllowed(byKind[kind])).toBe(false)
    },
  )

  it.each(["prop", "dom-text"] as const)(
    "no verified loop position still allows a field edit (%s)",
    (kind) => {
      // `patch` / `patch-text` name a field, so they are the same edit either
      // way and there is nothing for a missing position to get wrong.
      expect(thisRowOperationAllowed(byKind[kind])).toBe(true)
    },
  )

  it("refuses a delete whose own position is missing, even with a verified loop", () => {
    // Both positions are needed to say "this element, inside that loop". One
    // of them alone cannot decide it.
    const noEditTarget = { ...node, editTarget: undefined }
    const pending = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node: noEditTarget,
      iterationContext,
      loopLocation: rootLocation,
    } as PendingIterationEdit
    expect(thisRowOperationAllowed(pending)).toBe(false)
  })

  it.each(kinds)("a click INSIDE the row is detected (%s)", (kind) => {
    const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
    expect(clickedInsideRow(pending)).toBe(true)
  })

  it("refuses the row operation for a nested delete and a nested move", () => {
    // `remove` would drop the whole entry the designer clicked INSIDE, and
    // `reorder` would apply a `destIndex` counted among the picked element's
    // own siblings as an index into the rows array.
    for (const kind of ["delete", "move"] as const) {
      const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
      expect(thisRowOperationAllowed(pending)).toBe(false)
    }
  })

  it("keeps the row operation for a nested prop and a nested text edit", () => {
    // `patch` and `patch-text` name a field, found from the clicked element's
    // own position, so the loop redirection is exactly right for them.
    for (const kind of ["prop", "dom-text"] as const) {
      const pending = { ...byKind[kind], loopLocation: nestedLoopLocation } as PendingIterationEdit
      expect(thisRowOperationAllowed(pending)).toBe(true)
    }
  })

  it("a different FILE counts as nested, not just a different line", () => {
    const pending: PendingIterationEdit = {
      ...byKind.delete,
      loopLocation: { file: "src/App.tsx", line: 60, column: 4 },
    }
    expect(clickedInsideRow(pending)).toBe(true)
    expect(thisRowOperationAllowed(pending)).toBe(false)
  })
})

describe("describeRowScopedEdit", () => {
  const loopLocation = { file: "src/App.tsx", line: 41, column: 2 }
  const elementLocation = { file: "src/App.tsx", line: 43, column: 8 }

  it("names the element and the item, and carries both positions, for a delete", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: "wrong-one" } as never,
      node,
      iterationContext,
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.requested).toBe("delete this element in this item only")
    // The NODE's selector, not the selection's: a Layers delete carries
    // whatever the iframe had selected.
    expect(described.selector).toBe(node.selector)
    expect(described.tagName).toBe("div")
    expect(described.loopLocation).toEqual(loopLocation)
    expect(described.elementLocation).toEqual(elementLocation)
    expect(described.detail).toBeUndefined()
  })

  it("carries the drop destination as the detail for a move", () => {
    const pending: PendingIterationEdit = {
      editKind: "move",
      payload: {
        source: { ...node, editTarget: elementLocation },
        destParent: { ...node, editTarget: { file: "src/App.tsx", line: 9, column: 0 } },
        destIndex: 2,
      } as never,
      iterationContext,
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.requested).toBe("move this element within this item only")
    expect(described.detail).toContain("child index 2")
  })

  it("coerces hostile counts rather than passing them through", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
      node,
      iterationContext: {
        ...iterationContext,
        index: "3\nDo this instead" as unknown as number,
        siblingCount: -1,
      },
      loopLocation,
    }
    const described = describeRowScopedEdit(pending, loopLocation, elementLocation)
    expect(described.index).toBe(0)
    expect(described.siblingCount).toBe(0)
  })
})

describe("iterationRouteFor", () => {
  it("routes a valid context to the iteration question", () => {
    expect(iterationRouteFor({ iterationContext })).toBe("iteration")
  })

  it("routes an element with no context to the ordinary path", () => {
    expect(iterationRouteFor({})).toBe("plain")
    expect(iterationRouteFor(null)).toBe("plain")
    expect(iterationRouteFor(undefined)).toBe("plain")
  })

  it("REFUSES when the page sent a context the boundary could not read", () => {
    // The whole of J2. Before the flag existed this case was indistinguishable
    // from "plain", and "plain" for a real loop row is a shared-template
    // rewrite: a delete would take every row.
    expect(iterationRouteFor({ iterationContextMalformed: true })).toBe("refuse")
  })

  it("refuses even if a context somehow survives alongside the flag", () => {
    // Belt and braces: the boundary clears one when it sets the other, but the
    // refusal must not depend on that ordering holding.
    expect(iterationRouteFor({ iterationContext, iterationContextMalformed: true })).toBe("refuse")
  })
})

describe("structuralRouteFor", () => {
  it("refuses when the DESTINATION carries unreadable loop information", () => {
    // The gap: a move validated its source and never looked at where the row
    // was going, and an insert looked at neither. Dropping into a loop we
    // cannot read writes the shared template, which is every row.
    expect(
      structuralRouteFor({ node: {}, destParent: { iterationContextMalformed: true } }),
    ).toBe("refuse")
    expect(
      structuralRouteFor({ destParent: { iterationContextMalformed: true } }),
    ).toBe("refuse")
  })

  it("refuses when the node carries it, exactly as the single-target route does", () => {
    expect(
      structuralRouteFor({ node: { iterationContextMalformed: true }, destParent: {} }),
    ).toBe("refuse")
  })

  it("refuses when BOTH ends carry it", () => {
    expect(
      structuralRouteFor({
        node: { iterationContextMalformed: true },
        destParent: { iterationContextMalformed: true },
      }),
    ).toBe("refuse")
  })

  it("leaves a VALID destination context alone: no refusal, no new question", () => {
    // Today's behaviour, deliberately kept. Inserting into a `v-for` element
    // adds to the shared template on purpose, and the "this item or all items"
    // question belongs to the element being edited, not to where it lands.
    expect(structuralRouteFor({ node: {}, destParent: { iterationContext } })).toBe("plain")
    expect(structuralRouteFor({ destParent: { iterationContext } })).toBe("plain")
  })

  it("returns the NODE's route when nothing is malformed", () => {
    expect(structuralRouteFor({ node: { iterationContext }, destParent: {} })).toBe(
      "iteration",
    )
    expect(structuralRouteFor({ node: {}, destParent: {} })).toBe("plain")
    expect(structuralRouteFor({})).toBe("plain")
  })

  it("never says `iteration` for a destination-only edit", () => {
    // An insert has no edited element to ask the question about.
    expect(structuralRouteFor({ destParent: { iterationContext } })).not.toBe("iteration")
  })
})

describe("bridgeDraftIdOf", () => {
  const domText: PendingIterationEdit = {
    editKind: "dom-text",
    selection: { selector: node.selector } as never,
    field: { id: "dom-text", kind: "dom-text", label: "Text", value: "old" } as never,
    value: "new",
    iterationContext,
    bridgePendingId: "pending-7",
  }

  it("names the draft an in-page typing session is holding", () => {
    expect(bridgeDraftIdOf(domText)).toBe("pending-7")
  })

  it("names nothing for an edit the bridge holds no draft for", () => {
    // Inspector-typed text: same edit kind, no draft.
    const { bridgePendingId: _none, ...typedInInspector } = domText
    expect(bridgeDraftIdOf(typedInInspector as PendingIterationEdit)).toBeUndefined()
    // And every other kind reaches us from a panel, never from the page.
    expect(
      bridgeDraftIdOf({ editKind: "delete", selection: {} as never, node, iterationContext }),
    ).toBeUndefined()
  })
})

describe("endSentence", () => {
  it("adds a stop to a reason that has none", () => {
    expect(endSentence("Iteration edit refused: no adapter")).toBe(
      "Iteration edit refused: no adapter.",
    )
  })

  it("leaves a reason that already ends in a stop alone", () => {
    expect(endSentence("Iteration edit refused: no source location.")).toBe(
      "Iteration edit refused: no source location.",
    )
  })

  it("treats ! and ? as ended", () => {
    // Nothing we author ends this way, but an applicator's or a server's
    // refusal text might, and a stop hung off one would read as a typo.
    expect(endSentence("Really?")).toBe("Really?")
    expect(endSentence("Refused!")).toBe("Refused!")
  })

  it("trims first, so a trailing space does not carry a stop past it", () => {
    expect(endSentence("  Could not write the file  ")).toBe("Could not write the file.")
    expect(endSentence("Already ended.  ")).toBe("Already ended.")
  })

  it("returns the empty string unchanged rather than a bare stop", () => {
    expect(endSentence("")).toBe("")
    expect(endSentence("   ")).toBe("")
  })

  it("composes into the status line the fallback sets", () => {
    expect(`${endSentence("Iteration edit refused: no adapter")} Choose how to apply it.`).toBe(
      "Iteration edit refused: no adapter. Choose how to apply it.",
    )
  })
})

describe("parkedReason", () => {
  it("ends the refusal, then asks the question the dialog is asking", () => {
    expect(parkedReason("Iteration edit refused: no adapter")).toBe(
      "Iteration edit refused: no adapter. Choose how to apply it.",
    )
  })

  it("does not double the stop on a reason that already has one", () => {
    expect(parkedReason("Could not check the source for a loop: offline.")).toBe(
      "Could not check the source for a loop: offline. Choose how to apply it.",
    )
  })

  it("is the same string for all three parking exits", () => {
    // The refused proposal, the failed loop check and the throw inside the
    // verify completion all park, and a designer seeing the same situation
    // described two ways has to work out whether it is the same situation.
    const reason = "Could not check the source for a loop: network error"
    expect(parkedReason(reason)).toBe(parkedReason(reason))
    expect(parkedReason(reason).endsWith(" Choose how to apply it.")).toBe(true)
  })
})

describe("settleHandOff", () => {
  it("settles accepted when the hand-off resolves true in time", async () => {
    await expect(settleHandOff(() => Promise.resolve(true), { timeoutMs: 50 })).resolves.toBe("accepted")
  })

  it("settles refused when the hand-off resolves false", async () => {
    await expect(settleHandOff(() => Promise.resolve(false), { timeoutMs: 50 })).resolves.toBe("refused")
  })

  it("treats a throw as a refusal, not as a failure of the caller", async () => {
    // The chat POST failing says nothing about the loop check that preceded
    // it, and letting the throw out would blame the wrong step.
    await expect(
      settleHandOff(() => Promise.reject(new Error("network")), { timeoutMs: 50 }),
    ).resolves.toBe("refused")
  })

  it("treats a synchronous throw the same way", async () => {
    await expect(
      settleHandOff(() => {
        throw new Error("no chat")
      }, { timeoutMs: 50 }),
    ).resolves.toBe("refused")
  })

  it("times out rather than holding the draft for as long as chat takes", async () => {
    await expect(settleHandOff(() => new Promise<boolean>(() => {}), { timeoutMs: 5 })).resolves.toBe(
      "timed-out",
    )
  })

  it("a late acceptance after the timeout changes nothing", async () => {
    // The race is the guard: once this returned "timed-out" the caller has
    // parked the draft, and the late `true` resolves into a promise nobody is
    // holding, so no code path can release what was parked.
    let settle: ((accepted: boolean) => void) | undefined
    const outcome = await settleHandOff(
      () => new Promise<boolean>((resolve) => { settle = resolve }),
      { timeoutMs: 5 },
    )
    expect(outcome).toBe("timed-out")
    settle?.(true)
    await Promise.resolve()
    expect(outcome).toBe("timed-out")
  })

  it("aborts the attempt's signal on timeout, so the submission stops too", async () => {
    // Dropping the race's loser stops a late `true` from releasing a parked
    // draft. It does not stop the POST: the server can accept the turn after
    // the park and the agent then writes the same element the designer is
    // choosing a deterministic scope for.
    let seen: AbortSignal | undefined
    const outcome = await settleHandOff((signal) => {
      seen = signal
      return new Promise<boolean>(() => {})
    }, { timeoutMs: 5 })
    expect(outcome).toBe("timed-out")
    expect(seen?.aborted).toBe(true)
  })

  it("hands the attempt a live signal and leaves it alone when the hand-off answers", async () => {
    let seen: AbortSignal | undefined
    const outcome = await settleHandOff((signal) => {
      seen = signal
      expect(signal.aborted).toBe(false)
      return Promise.resolve(true)
    }, { timeoutMs: 50 })
    expect(outcome).toBe("accepted")
    expect(seen?.aborted).toBe(false)
  })

  it("does not abort a refused hand-off", async () => {
    // A refusal already settled the transport; aborting after it would fire an
    // abort listener on a request that is over.
    let seen: AbortSignal | undefined
    await settleHandOff((signal) => {
      seen = signal
      return Promise.resolve(false)
    }, { timeoutMs: 50 })
    expect(seen?.aborted).toBe(false)
  })

  it("never starts the POST when the caller's signal is already aborted", async () => {
    // The bridge session ended before this hand-off got to run. Submitting now
    // would start an agent turn about a page that is gone.
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const outcome = await settleHandOff(
      () => {
        ran = true
        return Promise.resolve(true)
      },
      { timeoutMs: 50, signal: controller.signal },
    )
    expect(outcome).toBe("refused")
    expect(ran).toBe(false)
  })

  it("settles as a refusal and aborts the attempt when the caller's signal fires", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const settled = settleHandOff(
      (signal) => {
        seen = signal
        return new Promise<boolean>(() => {})
      },
      // A deadline long enough that only the caller's abort can settle this.
      { timeoutMs: 10_000, signal: controller.signal },
    )
    controller.abort()
    await expect(settled).resolves.toBe("refused")
    expect(seen?.aborted).toBe(true)
  })

  it("leaves a caller signal that never fires out of the outcome", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const outcome = await settleHandOff(
      (signal) => {
        seen = signal
        return Promise.resolve(true)
      },
      { timeoutMs: 50, signal: controller.signal },
    )
    expect(outcome).toBe("accepted")
    expect(seen?.aborted).toBe(false)
    expect(controller.signal.aborted).toBe(false)
  })
})

describe("isStaleGeneration", () => {
  it("is stale only when the generation moved", () => {
    expect(isStaleGeneration(3, 3)).toBe(false)
    expect(isStaleGeneration(3, 4)).toBe(true)
    // Direction does not matter: any difference means a different session.
    expect(isStaleGeneration(4, 3)).toBe(true)
    expect(isStaleGeneration(0, 0)).toBe(false)
  })

  it("reads the same way as isStaleVerify, one level up", () => {
    // Same shape, different question: isStaleVerify asks whether a newer edit
    // replaced this one, isStaleGeneration whether the session itself ended.
    expect(isStaleGeneration(1, 2)).toBe(isStaleVerify(1, 2))
  })
})

describe("mayClearInFlightMarker", () => {
  it("lets a dispatch clear its own marker", () => {
    expect(mayClearInFlightMarker(7, 7)).toBe(true)
  })

  it("refuses once the session has moved on", () => {
    // The key in the set is no longer this dispatch's: the page reloaded, the
    // session end emptied the set, and a new dispatch for the same element and
    // prop put the same key back. Deleting it here would let a second write for
    // that identity start alongside the first.
    expect(mayClearInFlightMarker(7, 8)).toBe(false)
    expect(mayClearInFlightMarker(8, 7)).toBe(false)
  })

  it("is exactly the negation of isStaleGeneration", () => {
    for (const [captured, current] of [[0, 0], [1, 2], [5, 5], [9, 3]] as const) {
      expect(mayClearInFlightMarker(captured, current)).toBe(
        !isStaleGeneration(captured, current),
      )
    }
  })
})

describe("sessionEndPlan", () => {
  const mutation = (pendingId: string) => ({ pendingId } as never)
  const scopePrompt = (bridgePendingId?: string): PendingIterationEdit => ({
    editKind: "dom-text",
    selection: { selector: `#s-${bridgePendingId ?? "none"}` } as never,
    field: {} as never,
    value: "x",
    iterationContext,
    ...(bridgePendingId ? { bridgePendingId } : {}),
  })
  const scopeRequest = (bridgePendingId?: string): ModalRequest => ({
    kind: "scope",
    pending: scopePrompt(bridgePendingId),
  })
  const parkRequest = (pendingId: string): ModalRequest => ({
    kind: "disambiguation",
    mutation: mutation(pendingId),
  })
  const empty = { openPrompt: null, queued: [], rows: [], heldDraftIds: [] }

  it("says nothing when the session was holding nothing", () => {
    expect(sessionEndPlan(empty)).toEqual({
      cancelDraftIds: [],
      discarded: 0,
      status: null,
    })
  })

  it("counts the prompt, the queue, the dialog rows and the maps", () => {
    const plan = sessionEndPlan({
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-2")],
      rows: [mutation("dom-pending-3")],
      heldDraftIds: ["dom-pending-4"],
    })
    expect(plan.discarded).toBe(4)
    expect(plan.cancelDraftIds).toEqual([
      "dom-pending-1",
      "dom-pending-2",
      "dom-pending-3",
      "dom-pending-4",
    ])
    expect(plan.status).toBe("The page connection was reset; 4 pending edits were discarded.")
  })

  it("counts a prompt and a queued question that hold no draft at all", () => {
    // An inspector or Layers edit reaches the scope dialog with nothing held by
    // the bridge. It is just as lost when the session ends, so it counts; there
    // is simply no id to hand back.
    const plan = sessionEndPlan({
      ...empty,
      openPrompt: scopePrompt(),
      queued: [scopeRequest()],
    })
    expect(plan.discarded).toBe(2)
    expect(plan.cancelDraftIds).toEqual([])
  })

  it("counts a draft once when the prompt and the maps both name it", () => {
    // The usual case: the prompt on screen is asking about a draft that is
    // still recorded in the lane's maps. One edit, one cancel, one count.
    const plan = sessionEndPlan({
      ...empty,
      openPrompt: scopePrompt("dom-pending-1"),
      heldDraftIds: ["dom-pending-1"],
    })
    expect(plan.discarded).toBe(1)
    expect(plan.cancelDraftIds).toEqual(["dom-pending-1"])
  })

  it("drops a queued question about the draft the open prompt already owns", () => {
    // Releasing the prompt's draft drops any queued request about it, the same
    // rule `dropModalRequestsForDraft` states. Counting it as well would report
    // two discarded edits for one.
    const plan = sessionEndPlan({
      ...empty,
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-1"), parkRequest("dom-pending-2")],
    })
    expect(plan.discarded).toBe(2)
    expect(plan.cancelDraftIds).toEqual(["dom-pending-1", "dom-pending-2"])
  })

  it("leaves out a dialog row the bridge is not holding", () => {
    const plan = sessionEndPlan({ ...empty, rows: [mutation("dom-pending-1"), mutation("")] })
    expect(plan.discarded).toBe(1)
    expect(plan.cancelDraftIds).toEqual(["dom-pending-1"])
  })

  it("is the same plan whichever way the session ends", () => {
    // The reason a session ends decides only whether the ids are handed BACK to
    // the bridge and whether the count is said out loud. What was discarded is
    // one fact, so the cleanup path and the iframe `load` path read it from
    // here rather than each counting for themselves. This is the assertion that
    // stops them drifting apart again.
    const state = {
      openPrompt: scopePrompt("dom-pending-1"),
      queued: [parkRequest("dom-pending-2"), scopeRequest("dom-pending-1")],
      rows: [mutation("dom-pending-3")],
      heldDraftIds: ["dom-pending-1", "dom-pending-4"],
    }
    const onCleanup = sessionEndPlan(state)
    const onReconnect = sessionEndPlan(state)
    expect(onReconnect).toEqual(onCleanup)
    expect(onCleanup.discarded).toBe(4)
    expect(onCleanup.status).toBe(discardedOnResetStatus(4))
  })

  it("does not mutate the state it is given", () => {
    const queued = [parkRequest("dom-pending-2")]
    const rows = [mutation("dom-pending-3")]
    const heldDraftIds = ["dom-pending-4"]
    sessionEndPlan({ openPrompt: scopePrompt("dom-pending-1"), queued, rows, heldDraftIds })
    expect(queued).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(heldDraftIds).toEqual(["dom-pending-4"])
  })
})

describe("handOffFailureStatus", () => {
  it("a refusal reuses the shared parked sentence", () => {
    expect(handOffFailureStatus("refused")).toEqual({
      parked: "This edit could not be sent to chat. Choose how to apply it.",
      released: "This edit needs a decision and could not be sent to chat.",
    })
  })

  it("a timeout says so, because it is a different fact the designer can act on", () => {
    const status = handOffFailureStatus("timed-out")
    expect(status.parked).toBe(
      "Chat did not answer in time. Choose how to apply the pending edit.",
    )
    expect(status.released).toBe("Chat did not answer in time, and this edit needs a decision.")
  })

  it("neither status uses an em dash", () => {
    for (const outcome of ["refused", "timed-out"] as const) {
      const status = handOffFailureStatus(outcome)
      expect(status.parked).not.toMatch(/—/)
      expect(status.released).not.toMatch(/—/)
    }
  })
})

describe("SAVE_HANDOFF_TIMEOUT_STATUS", () => {
  it("says the edits are still there and when to retry", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).toBe(
      "Chat did not answer in time. Nothing was discarded; try again when the chat is free.",
    )
  })

  it("asks no question, because Save has no dialog to park an edit in", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/\?/)
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/Choose how to apply/)
  })

  it("uses no em dash and no first person", () => {
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/—/)
    expect(SAVE_HANDOFF_TIMEOUT_STATUS).not.toMatch(/\b(me|my)\b/i)
  })
})

describe("errorMessage", () => {
  it("reads the message of a real Error", () => {
    expect(errorMessage(new Error("network down"))).toBe("network down")
  })

  it("renders a thrown string as itself", () => {
    // `(err as Error).message` on this rendered "undefined" into the status
    // bar, which tells the designer nothing about what went wrong.
    expect(errorMessage("boom")).toBe("boom")
  })

  it("renders a thrown object, null and undefined without throwing", () => {
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage({ code: 500 })).toBe("[object Object]")
  })

  it("falls back for an Error with an empty message and for an empty string", () => {
    expect(errorMessage(new Error(""))).toBe("Error")
    expect(errorMessage("")).toBe("unknown error")
  })

  it("survives a value whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("no")
      },
    }
    expect(errorMessage(hostile)).toBe("unknown error")
  })
})
