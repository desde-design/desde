import { describe, expect, it, vi } from "vitest"
import type { EditResult, StructuralEdit } from "@/editor/core"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import {
  applyEditWithChatHandoff,
  describeStructuralEditForHandoff,
  isPolicyRefusal,
} from "./apply-edit-with-chat-handoff"

const applied: EditResult = { kind: "applied", appliedEditId: "e-1", affectedTargetIds: ["t-1"] }
const refused: EditResult = { kind: "failed", reason: "Refusing to delete a root or expression-embedded JSX element" }

function deleteEdit(scope: "definition" | "callsite" = "definition"): StructuralEdit {
  return {
    kind: "delete",
    id: "e-1",
    scope,
    target: {
      targetId: "body > div",
      selector: "body > div",
      componentName: undefined,
      authoredAt: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
      editTarget: { file: "src/app/kpi-cards.tsx", line: 20, column: 12 },
    },
  } as StructuralEdit
}

function adapterReturning(result: EditResult) {
  const calls: StructuralEdit[] = []
  return { applyEdit: async (e: StructuralEdit) => { calls.push(e); return result }, calls }
}

describe("applyEditWithChatHandoff", () => {
  it("returns the deterministic result untouched when it applies", async () => {
    const adapter = adapterReturning(applied)
    const handOff = vi.fn(() => true)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapter, handOff)
    expect(r.result).toBe(applied)
    expect(r.handoff).toEqual({ attempted: false, started: false })
    expect(handOff).not.toHaveBeenCalled()
    expect(adapter.calls).toHaveLength(1)
  })

  it("hands a refusal to chat with the marker, the position, and the reason, and never re-applies", async () => {
    const adapter = adapterReturning(refused)
    const handOff = vi.fn((_prompt: string) => true)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapter, handOff)
    expect(r.result).toBe(refused)
    expect(r.handoff).toEqual({ attempted: true, started: true, originalReason: refused.kind === "failed" ? refused.reason : "" })
    expect(adapter.calls).toHaveLength(1)
    const prompt = handOff.mock.calls[0]![0]
    expect(prompt.startsWith(EDIT_HANDOFF_MARKER)).toBe(true)
    expect(prompt).toContain("src/components/ui/card.tsx:60:4")
    expect(prompt).toContain("the component's own file")
    expect(prompt).toContain("Refusing to delete a root")
  })

  it("reports started:false when the hand-off declines", async () => {
    const adapter = adapterReturning(refused)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapter, () => false)
    expect(r.handoff).toMatchObject({ attempted: true, started: false })
  })

  it("does not attempt a hand-off without a chat transport", async () => {
    const adapter = adapterReturning(refused)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapter, undefined)
    expect(r.handoff).toMatchObject({ attempted: false, started: false })
  })
})

describe("describeStructuralEditForHandoff", () => {
  it("uses authoredAt for a definition-scope delete and editTarget for a callsite one", () => {
    expect(describeStructuralEditForHandoff(deleteEdit("definition"), "r")?.location.file).toBe("src/components/ui/card.tsx")
    expect(describeStructuralEditForHandoff(deleteEdit("callsite"), "r")?.location.file).toBe("src/app/kpi-cards.tsx")
  })

  it("returns null for kinds that have no source position to hand over", () => {
    const overwrite = { kind: "overwrite", id: "o", target: { targetId: "f", selector: "f" }, file: "f", newSource: "" } as StructuralEdit
    expect(describeStructuralEditForHandoff(overwrite, "r")).toBeNull()
  })

  it("keeps a definition-scope delete that has authoredAt but no editTarget", () => {
    const edit = {
      kind: "delete",
      id: "e-1",
      scope: "definition",
      target: {
        targetId: "t",
        selector: "div",
        authoredAt: { file: "src/components/ui/card.tsx", line: 60, column: 4 },
      },
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.location).toEqual({
      file: "src/components/ui/card.tsx",
      line: 60,
      column: 4,
    })
  })

  it("returns null for a definition-scope delete with no authoredAt, rather than passing the callsite off as the component's own file", () => {
    // `editTarget` is the CALLSITE. Labelling it "scope: definition, the
    // component's own file" sent the agent to the wrong place. The adapter
    // refuses this edit anyway ("DeleteEdit requires target.authoredAt").
    const edit = {
      kind: "delete",
      id: "e-1",
      scope: "definition",
      target: {
        targetId: "t",
        selector: "div",
        editTarget: { file: "src/app/kpi-cards.tsx", line: 20, column: 12 },
      },
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")).toBeNull()
  })
})

describe("isPolicyRefusal", () => {
  it("is true for the dormant-lane refusal, which names lanes.<id>", () => {
    const reason =
      'The "detach" edit lane is dormant: it is Vue-only and has no JSX sibling, ' +
      "so the product does not offer it. Set lanes.detach " +
      '({ "lanes": { "detach": true } } in desde.config.json at the prototype ' +
      "root) to turn it back on. The applicator is intact and unchanged."
    expect(isPolicyRefusal(reason)).toBe(true)
  })

  it("is true for the two library refusals", () => {
    expect(
      isPolicyRefusal(
        "Refusing a definition-scoped delete in library source (node_modules/x/y.vue); editor never rewrites node_modules",
      ),
    ).toBe(true)
    expect(
      isPolicyRefusal("This file belongs to an installed library, which the Editor does not edit"),
    ).toBe(true)
  })

  it("is false for a capability refusal, which the agent CAN work on", () => {
    expect(isPolicyRefusal("Refusing to delete a root or expression-embedded JSX element")).toBe(false)
    expect(isPolicyRefusal("Stale target: the file changed under the captured position")).toBe(false)
  })
})

describe("policy refusals are not handed to chat", () => {
  const dormant: EditResult = {
    kind: "failed",
    reason: 'The "swap" edit lane is dormant. Set lanes.swap to turn it back on.',
  }
  const library: EditResult = {
    kind: "failed",
    reason: "Refusing a callsite-scoped delete in library source (node_modules/k/a.vue); editor never rewrites node_modules",
  }

  it("reports a dormant-lane refusal as a plain failure", async () => {
    const handOff = vi.fn(() => true)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapterReturning(dormant), handOff)
    expect(handOff).not.toHaveBeenCalled()
    expect(r.handoff).toEqual({
      attempted: false,
      started: false,
      originalReason: dormant.kind === "failed" ? dormant.reason : "",
    })
  })

  it("reports a library refusal as a plain failure", async () => {
    const handOff = vi.fn(() => true)
    await applyEditWithChatHandoff(deleteEdit(), adapterReturning(library), handOff)
    expect(handOff).not.toHaveBeenCalled()
  })

  it("still hands off a capability refusal", async () => {
    const handOff = vi.fn(() => true)
    const r = await applyEditWithChatHandoff(deleteEdit(), adapterReturning(refused), handOff)
    expect(handOff).toHaveBeenCalledTimes(1)
    expect(r.handoff.attempted).toBe(true)
  })
})

describe("describeStructuralEditForHandoff details", () => {
  const target = {
    targetId: "t-1",
    selector: "body > main > div",
    editTarget: { file: "src/App.tsx", line: 8, column: 4 },
  }

  it("move: names the destination parent position and the child index", () => {
    const edit = {
      kind: "move",
      id: "e",
      target,
      destination: { parentId: "p", index: 2, parentEditTarget: { file: "src/App.tsx", line: 14, column: 6 } },
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe(
      "move it to be child index 2 of the element at src/App.tsx:14:6",
    )
  })

  it("move: says append when the index is -1", () => {
    const edit = {
      kind: "move",
      id: "e",
      target,
      destination: { parentId: "p", index: -1, parentEditTarget: { file: "src/App.tsx", line: 14, column: 6 } },
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe(
      "append it to the element at src/App.tsx:14:6",
    )
  })

  it("move: falls back to a page-level phrase with no destination position", () => {
    const edit = { kind: "move", id: "e", target, destination: { parentId: "p", index: 0 } } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe("move it within the page")
  })

  it("insert: labels the target as the parent and carries the snippet and index", () => {
    const edit = {
      kind: "insert",
      id: "e",
      target,
      destIndex: 1,
      snippet: '<UiCard title="Hello" />',
    } as StructuralEdit
    const d = describeStructuralEditForHandoff(edit, "r")
    expect(d?.kindLabel).toBe("Insert into")
    expect(d?.detail).toBe('insert <UiCard title="Hello" /> at child index 1')
  })

  it("insert: carries a 400-character snippet whole, where the old 200 cap cut it", () => {
    const snippet = `<div>${"x".repeat(400)}</div>`
    const edit = { kind: "insert", id: "e", target, destIndex: -1, snippet } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe(`insert ${snippet} at the end`)
  })

  it("insert: cuts at 2000 characters, says so, and still says 'at the end' for -1", () => {
    const edit = {
      kind: "insert",
      id: "e",
      target,
      destIndex: -1,
      snippet: `<div>${"x".repeat(4000)}</div>`,
    } as StructuralEdit
    const detail = describeStructuralEditForHandoff(edit, "r")?.detail ?? ""
    expect(detail.endsWith("... (truncated) at the end")).toBe(true)
    expect(detail).toContain(`insert ${"<div>"}${"x".repeat(1995)}... (truncated)`)
  })

  it("insert: 2000 characters exactly is not truncated; 2001 is", () => {
    const exact = { kind: "insert", id: "e", target, destIndex: 0, snippet: "y".repeat(2000) } as StructuralEdit
    expect(describeStructuralEditForHandoff(exact, "r")?.detail).not.toContain("(truncated)")
    const over = { kind: "insert", id: "e", target, destIndex: 0, snippet: "y".repeat(2001) } as StructuralEdit
    expect(describeStructuralEditForHandoff(over, "r")?.detail).toContain("(truncated)")
  })

  it("insert: quotes a text payload", () => {
    const edit = {
      kind: "insert",
      id: "e",
      target,
      destIndex: 0,
      contentKind: "text",
      snippet: "Hello",
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe('insert the text "Hello" at child index 0')
  })

  it("swap: names both components", () => {
    const edit = {
      kind: "swap",
      id: "e",
      target,
      fromComponentName: "KButton",
      toComponentName: "UiButton",
    } as StructuralEdit
    expect(describeStructuralEditForHandoff(edit, "r")?.detail).toBe("replace <KButton> with <UiButton>")
  })

  it("flatten-conditional: names the branch kept", () => {
    const numbered = { kind: "flatten-conditional", id: "e", target, branchToKeep: 1 } as StructuralEdit
    expect(describeStructuralEditForHandoff(numbered, "r")?.detail).toBe(
      "keep branch 1 of the conditional chain",
    )
    const elseBranch = { kind: "flatten-conditional", id: "e", target, branchToKeep: "else" } as StructuralEdit
    expect(describeStructuralEditForHandoff(elseBranch, "r")?.detail).toBe("keep the else branch")
  })

  it("delete, detach and unwrap carry no detail", () => {
    for (const kind of ["delete", "detach", "unwrap"] as const) {
      // `delete` defaults to definition scope, which needs `authoredAt` to be
      // describable at all; without it the assertion below would pass on a
      // null result rather than on a described edit with no detail.
      const edit = {
        kind,
        id: "e",
        target: { ...target, authoredAt: { file: "src/Card.vue", line: 2, column: 0 } },
        componentFile: "src/Card.vue",
      } as unknown as StructuralEdit
      const described = describeStructuralEditForHandoff(edit, "r")
      expect(described).not.toBeNull()
      expect(described?.detail).toBeUndefined()
    }
  })
})
