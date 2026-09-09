import { describe, expect, it } from "vitest"
import type { IterationContext } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  decideAfterVerify,
  describeAmbiguousIteration,
  isStaleVerify,
  iterationRouteFor,
  iterationTemplateLocation,
  sameBridgeDraft,
  thisRowTemplateLocation,
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
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map" },
        pending,
        location,
        remembered: "this-row",
      }),
    ).toEqual({ kind: "remembered", scope: "this-row" })
  })

  it("loop with nothing remembered: opens the dialog", () => {
    expect(
      decideAfterVerify({
        outcome: { kind: "loop", expression: "items.map" },
        pending,
        location,
        remembered: undefined,
      }),
    ).toEqual({ kind: "prompt" })
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
