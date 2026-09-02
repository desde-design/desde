import { describe, expect, it } from "vitest"
import type { ConditionalGroup } from "@/editor/edit-service/list-conditional-groups"
import type { OutlineNode } from "@/types/bridge"
import {
  collectVueFiles,
  findGroupFirstChildSelector,
  isGroupSelector,
  mergeConditionalGroups,
  type FileConditionalGroups,
} from "./layers-conditional-groups"

const FILE = "src/components/Panel.vue"

function node(partial: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    name: partial.name ?? partial.id,
    type: partial.type ?? "element",
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    width: partial.width ?? 10,
    height: partial.height ?? 10,
    selector: partial.selector ?? `#${partial.id}`,
    ...partial,
  }
}

describe("mergeConditionalGroups", () => {
  it("returns roots unchanged when byFile is empty", () => {
    const roots = [node({ id: "root" })]
    expect(mergeConditionalGroups(roots, new Map())).toBe(roots)
  })

  it("returns roots unchanged when no member matches anything in the tree", () => {
    const group: ConditionalGroup = {
      head: { line: 4, column: 5 },
      directive: "if",
      expression: "multi",
      branches: [{ directive: "if", expression: "multi", line: 4, column: 5 }],
      memberLocs: [{ line: 5, column: 7 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "abc123abc123", groups: [group] }],
    ])
    const roots = [
      node({
        id: "root",
        children: [node({ id: "unrelated", editTarget: { file: FILE, line: 99, column: 1 } })],
      }),
    ]
    expect(mergeConditionalGroups(roots, byFile)).toBe(roots)
  })

  it("collapses a single-branch v-if member into a synthetic group row", () => {
    const group: ConditionalGroup = {
      head: { line: 4, column: 5 },
      directive: "if",
      expression: "multi",
      branches: [{ directive: "if", expression: "multi", line: 4, column: 5 }],
      memberLocs: [{ line: 5, column: 7 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "abc123abc123", groups: [group] }],
    ])
    const member = node({
      id: "cards-div",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      editTarget: { file: FILE, line: 5, column: 7 },
    })
    const roots = [
      node({
        id: "section",
        children: [
          node({ id: "header", editTarget: { file: FILE, line: 3, column: 5 } }),
          member,
          node({ id: "footer", editTarget: { file: FILE, line: 10, column: 5 } }),
        ],
      }),
    ]

    const merged = mergeConditionalGroups(roots, byFile)
    const section = merged[0]
    expect(section.children).toHaveLength(3)
    const groupNode = section.children?.[1]
    expect(groupNode?.id).toBe(`desde-group:${FILE}:4:5`)
    expect(groupNode?.name).toBe('v-if="multi"')
    expect(groupNode?.selector).toBe(`__desde-group__${FILE}:4:5`)
    expect(groupNode?.conditionalGroup).toEqual({ directive: "if", expression: "multi" })
    expect(groupNode?.editTarget).toEqual({ file: FILE, line: 4, column: 5, fileHash: "abc123abc123" })
    expect(groupNode?.children).toEqual([member])
    // Bounding box is the member's own box (single-member group).
    expect(groupNode).toMatchObject({ x: 10, y: 20, width: 100, height: 50 })
    // Untouched siblings pass through by reference.
    expect(section.children?.[0]).toBe(roots[0].children?.[0])
    expect(section.children?.[2]).toBe(roots[0].children?.[2])
  })

  it("collapses a run of v-for iteration members (same memberLoc, many live nodes) into one group with a unioned bbox", () => {
    const group: ConditionalGroup = {
      head: { line: 3, column: 5 },
      directive: "for",
      expression: "x in xs",
      branches: [{ directive: "for", expression: "x in xs", line: 3, column: 5 }],
      memberLocs: [{ line: 4, column: 7 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "def456def456", groups: [group] }],
    ])
    const iterA = node({
      id: "li-0",
      x: 0,
      y: 0,
      width: 20,
      height: 10,
      editTarget: { file: FILE, line: 4, column: 7 },
    })
    const iterB = node({
      id: "li-1",
      x: 0,
      y: 10,
      width: 30,
      height: 15,
      editTarget: { file: FILE, line: 4, column: 7 },
    })
    const iterC = node({
      id: "li-2",
      x: 0,
      y: 25,
      width: 25,
      height: 10,
      editTarget: { file: FILE, line: 4, column: 7 },
    })
    const roots = [node({ id: "ul", children: [iterA, iterB, iterC] })]

    const merged = mergeConditionalGroups(roots, byFile)
    const children = merged[0].children
    expect(children).toHaveLength(1)
    expect(children?.[0].id).toBe(`desde-group:${FILE}:3:5`)
    expect(children?.[0].name).toBe('v-for="x in xs"')
    expect(children?.[0].children).toEqual([iterA, iterB, iterC])
    // Union of the three boxes: y 0..35, x 0..30.
    expect(children?.[0]).toMatchObject({ x: 0, y: 0, width: 30, height: 35 })
  })

  it("recurses into nested children (group members several levels deep)", () => {
    const group: ConditionalGroup = {
      head: { line: 6, column: 7 },
      directive: "if",
      expression: "showBadge",
      branches: [{ directive: "if", expression: "showBadge", line: 6, column: 7 }],
      memberLocs: [{ line: 7, column: 9 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "aaa111aaa111", groups: [group] }],
    ])
    const badge = node({ id: "badge", editTarget: { file: FILE, line: 7, column: 9 } })
    const roots = [
      node({
        id: "root",
        children: [
          node({
            id: "card",
            children: [
              node({
                id: "card-body",
                children: [badge],
              }),
            ],
          }),
        ],
      }),
    ]

    const merged = mergeConditionalGroups(roots, byFile)
    const cardBody = merged[0].children?.[0].children?.[0]
    expect(cardBody?.children).toHaveLength(1)
    expect(cardBody?.children?.[0].conditionalGroup).toEqual({
      directive: "if",
      expression: "showBadge",
    })
  })

  it("treats a non-consecutive match as two separate runs (does not merge across an unrelated sibling)", () => {
    const group: ConditionalGroup = {
      head: { line: 3, column: 5 },
      directive: "for",
      expression: "x in xs",
      branches: [{ directive: "for", expression: "x in xs", line: 3, column: 5 }],
      memberLocs: [{ line: 4, column: 7 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "", groups: [group] }],
    ])
    const iterA = node({ id: "li-0", editTarget: { file: FILE, line: 4, column: 7 } })
    const staticDivider = node({ id: "divider", editTarget: { file: FILE, line: 20, column: 1 } })
    const iterB = node({ id: "li-1", editTarget: { file: FILE, line: 4, column: 7 } })
    const roots = [node({ id: "ul", children: [iterA, staticDivider, iterB] })]

    const merged = mergeConditionalGroups(roots, byFile)
    const children = merged[0].children
    expect(children).toHaveLength(3)
    expect(children?.[0].conditionalGroup).toBeTruthy()
    expect(children?.[1]).toBe(staticDivider)
    expect(children?.[2].conditionalGroup).toBeTruthy()
  })

  it("omits fileHash on the synthetic node when the file listing had none", () => {
    const group: ConditionalGroup = {
      head: { line: 4, column: 5 },
      directive: "if",
      expression: null,
      branches: [{ directive: "if", expression: null, line: 4, column: 5 }],
      memberLocs: [{ line: 5, column: 7 }],
    }
    const byFile = new Map<string, FileConditionalGroups>([
      [FILE, { fileHash: "", groups: [group] }],
    ])
    const member = node({ id: "m", editTarget: { file: FILE, line: 5, column: 7 } })
    const roots = [node({ id: "root", children: [member] })]

    const merged = mergeConditionalGroups(roots, byFile)
    expect(merged[0].children?.[0].editTarget).toEqual({ file: FILE, line: 4, column: 5 })
    expect(merged[0].children?.[0].name).toBe("v-if")
  })
})

describe("collectVueFiles", () => {
  it("collects distinct .vue files from authoredAt and editTarget, ignoring non-.vue", () => {
    const roots = [
      node({
        id: "root",
        editTarget: { file: "src/App.vue", line: 1, column: 1 },
        children: [
          node({ id: "a", authoredAt: { file: "src/components/A.vue", line: 1, column: 1 } }),
          node({ id: "b", editTarget: { file: "src/App.vue", line: 2, column: 1 } }),
          node({ id: "c", editTarget: { file: "src/main.tsx", line: 1, column: 1 } }),
          node({ id: "d" }),
        ],
      }),
    ]
    expect(collectVueFiles(roots)).toEqual(new Set(["src/App.vue", "src/components/A.vue"]))
  })

  it("returns an empty set for a tree with no .vue locations", () => {
    const roots = [node({ id: "root", children: [node({ id: "a" })] })]
    expect(collectVueFiles(roots).size).toBe(0)
  })
})

describe("isGroupSelector", () => {
  it("recognizes the sentinel prefix and rejects ordinary selectors", () => {
    expect(isGroupSelector(`__desde-group__${FILE}:4:5`)).toBe(true)
    expect(isGroupSelector("#some-real-id")).toBe(false)
  })
})

describe("findGroupFirstChildSelector", () => {
  it("resolves to the first selectable child of the matching group node", () => {
    const child1 = node({ id: "c1", selector: "#c1" })
    const child2 = node({ id: "c2", selector: "#c2" })
    const groupSel = `__desde-group__${FILE}:4:5`
    const roots = [
      node({
        id: "root",
        children: [
          node({ id: "grp", selector: groupSel, children: [child1, child2] }),
        ],
      }),
    ]
    expect(findGroupFirstChildSelector(roots, groupSel)).toBe("#c1")
  })

  it("skips children with an empty selector and returns null when none qualify", () => {
    const groupSel = `__desde-group__${FILE}:4:5`
    const roots = [
      node({
        id: "root",
        children: [
          node({
            id: "grp",
            selector: groupSel,
            children: [node({ id: "c1", selector: "" })],
          }),
        ],
      }),
    ]
    expect(findGroupFirstChildSelector(roots, groupSel)).toBeNull()
  })

  it("returns null when roots is null or the group node isn't found", () => {
    expect(findGroupFirstChildSelector(null, "__desde-group__x:1:1")).toBeNull()
    expect(findGroupFirstChildSelector([node({ id: "root" })], "__desde-group__x:1:1")).toBeNull()
  })
})
