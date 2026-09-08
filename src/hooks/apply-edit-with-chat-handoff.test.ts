import { describe, expect, it, vi } from "vitest"
import type { EditResult, StructuralEdit } from "@/editor/core"
import { EDIT_HANDOFF_MARKER } from "@/editor/edit-service/build-edit-escalation-prompt"
import { applyEditWithChatHandoff, describeStructuralEditForHandoff } from "./apply-edit-with-chat-handoff"

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
})
