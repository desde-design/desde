import { describe, expect, it } from "vitest"
import { buildMoveToChatHandoff } from "./move-to-chat"
import type { OutlineNode } from "@/types/bridge"

function node(over: Partial<OutlineNode>): OutlineNode {
  return {
    id: "n",
    name: "div",
    type: "element",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    selector: "#n",
    ...over,
  }
}

const kpi = node({
  id: "n2",
  name: "KpiCards",
  type: "component",
  selector: "section.space-y-5",
  editTarget: { file: "src/app/crm/_components/kpi-cards.tsx", line: 8, column: 4 },
})
const pipeline = node({
  id: "n3",
  name: "PipelineActivity",
  type: "component",
  selector: "div.pipeline",
  editTarget: { file: "src/app/crm/page.tsx", line: 11, column: 6 },
})

describe("buildMoveToChatHandoff", () => {
  it("describes a cross-file drop beside a sibling as the move the user made", () => {
    const h = buildMoveToChatHandoff({
      source: kpi,
      target: pipeline,
      position: "after",
      reason: "different-file",
      sourceFile: kpi.editTarget!.file,
      targetFile: pipeline.editTarget!.file,
    })
    expect(h).not.toBeNull()
    expect(h!.prompt).toContain("- What I did: Move <KpiCards> (selector: section.space-y-5)")
    expect(h!.prompt).toContain(
      "- Details: move it to just after the element at src/app/crm/page.tsx:11:6",
    )
    expect(h!.prompt).toContain("- Source position: src/app/crm/_components/kpi-cards.tsx:8:4")
    expect(h!.prompt).toContain(
      "- Why it refused: KpiCards is written in src/app/crm/_components/kpi-cards.tsx; the drop target is written in src/app/crm/page.tsx. A direct move rewrites one file, so it cannot do this.",
    )
  })

  it("describes a drop INTO a target as an append to it", () => {
    const h = buildMoveToChatHandoff({
      source: kpi,
      target: pipeline,
      position: "inside",
      reason: "different-file",
      sourceFile: kpi.editTarget!.file,
      targetFile: pipeline.editTarget!.file,
    })
    expect(h!.prompt).toContain("- Details: append it to the element at src/app/crm/page.tsx:11:6")
  })

  it("says what no-parent means in words about files, not containers", () => {
    const card = node({
      name: "div",
      selector: "div.card",
      editTarget: { file: "src/components/ui/card.tsx", line: 10, column: 4 },
    })
    const h = buildMoveToChatHandoff({
      source: card,
      target: { ...card, id: "other", selector: "div.card:nth-child(2)" },
      position: "before",
      reason: "no-parent",
      sourceFile: card.editTarget!.file,
      targetFile: card.editTarget!.file,
    })
    expect(h!.why).toBe(
      "div is written in src/components/ui/card.tsx, but nothing above the drop target on this page is written in that file. A direct move needs a parent in the same file, so it cannot do this.",
    )
    // A bare tag is not a component name: the element is named by its tag.
    expect(h!.prompt).toContain("- What I did: Move <div> (selector: div.card)")
  })

  it("has nothing to hand over when the source has no source position", () => {
    expect(
      buildMoveToChatHandoff({
        source: node({ name: "span", editTarget: undefined }),
        target: pipeline,
        position: "after",
        reason: "different-file",
        sourceFile: "",
        targetFile: pipeline.editTarget!.file,
      }),
    ).toBeNull()
  })
})
