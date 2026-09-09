import { describe, expect, it } from "vitest"
import type { IterationContext } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  decideAfterVerify,
  describeAmbiguousIteration,
  iterationTemplateLocation,
  sameBridgeDraft,
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
})
