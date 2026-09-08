import { describe, expect, it } from "vitest"
import type { IterationContext } from "@/editor/core"
import type { OutlineNode } from "@/types/bridge"
import {
  describeAmbiguousIteration,
  iterationTemplateLocation,
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
  it("phrases a delete as 'delete the element' with the row index and count", () => {
    const pending: PendingIterationEdit = {
      editKind: "delete",
      selection: { selector: node.selector } as never,
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
