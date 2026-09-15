import { describe, expect, it } from "vitest"
import {
  applyResolvedCallsites,
  collectCallsiteCandidates,
  type ResolvedCallsite,
} from "./resolve-layer-callsites"
import type { OutlineNode } from "@/types/bridge"

function node(over: Partial<OutlineNode> & { id: string }): OutlineNode {
  return {
    name: "div",
    type: "element",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    selector: `#${over.id}`,
    ...over,
  }
}

const PAGE = "src/app/crm/page.tsx"
const KPI = "src/app/crm/_components/kpi-cards.tsx"
const TASKS = "src/app/crm/_components/task-reminders.tsx"

/**
 * The CRM page as the bridge walks it after the callsite stamp landed: the
 * two client components carry their page.tsx callsite; the two server
 * components still attribute to their own files.
 */
function crmTree(): OutlineNode[] {
  return [
    node({
      id: "page",
      editTarget: { file: PAGE, line: 8, column: 4 },
      children: [
        node({
          id: "kpi",
          name: "section",
          editTarget: { file: KPI, line: 8, column: 4 },
          authoredAt: { file: KPI, line: 8, column: 4 },
          children: [node({ id: "kpi-inner", editTarget: { file: KPI, line: 9, column: 6 } })],
        }),
        node({
          id: "pipeline",
          name: "PipelineActivity",
          type: "component",
          editTarget: { file: PAGE, line: 11, column: 6 },
        }),
        node({
          id: "tasks",
          name: "section",
          editTarget: { file: TASKS, line: 20, column: 4 },
        }),
        node({
          id: "lib",
          name: "div",
          isLibrary: true,
          editTarget: { file: "node_modules/x/dist/index.js", line: 1, column: 0 },
        }),
      ],
    }),
  ]
}

describe("collectCallsiteCandidates", () => {
  it("picks the element rows whose file differs from the nearest stamped ancestor's", () => {
    expect(collectCallsiteCandidates(crmTree())).toEqual([
      { nodeId: "kpi", parentNodeId: "page", file: KPI, line: 8, column: 4, parentFile: PAGE },
      { nodeId: "tasks", parentNodeId: "page", file: TASKS, line: 20, column: 4, parentFile: PAGE },
    ])
  })

  it("skips rows the runtime already identified as components, same-file rows and library rows", () => {
    const ids = collectCallsiteCandidates(crmTree()).map((c) => c.nodeId)
    expect(ids).not.toContain("pipeline")
    expect(ids).not.toContain("kpi-inner")
    expect(ids).not.toContain("lib")
  })

  it("has nothing to ask when every row is in its ancestor's file", () => {
    const roots = [
      node({
        id: "a",
        editTarget: { file: PAGE, line: 1, column: 0 },
        children: [node({ id: "b", editTarget: { file: PAGE, line: 2, column: 2 } })],
      }),
    ]
    expect(collectCallsiteCandidates(roots)).toEqual([])
  })
})

describe("applyResolvedCallsites", () => {
  it("re-targets a resolved row at its callsite, names it, and keeps where its bytes live", () => {
    const roots = crmTree()
    const candidates = collectCallsiteCandidates(roots)
    const results: (ResolvedCallsite | null)[] = [
      { name: "KpiCards", callsites: [{ line: 9, column: 6 }] },
      null,
    ]
    const out = applyResolvedCallsites(roots, candidates, results)
    const kpi = out[0].children![0]
    expect(kpi).toMatchObject({
      id: "kpi",
      name: "KpiCards",
      type: "component",
      editTarget: { file: PAGE, line: 9, column: 6 },
      authoredAt: { file: KPI, line: 8, column: 4 },
    })
    // Children are carried over untouched.
    expect(kpi.children![0].id).toBe("kpi-inner")
    // The unresolved row is exactly as it was.
    expect(out[0].children![2]).toEqual(roots[0].children![2])
    // The input is not mutated.
    expect(roots[0].children![0].name).toBe("section")
  })

  it("maps DOM order onto source order when one component is written several times", () => {
    const CARD = "src/components/ui/card.tsx"
    const GRID = "src/app/grid.tsx"
    const roots = [
      node({
        id: "grid",
        editTarget: { file: GRID, line: 7, column: 4 },
        children: [
          node({ id: "c1", editTarget: { file: CARD, line: 10, column: 4 } }),
          node({ id: "c2", editTarget: { file: CARD, line: 10, column: 4 } }),
          node({ id: "c3", editTarget: { file: CARD, line: 10, column: 4 } }),
        ],
      }),
    ]
    const candidates = collectCallsiteCandidates(roots)
    const resolved: ResolvedCallsite = {
      name: "Card",
      callsites: [
        { line: 8, column: 6 },
        { line: 25, column: 6 },
      ],
    }
    const out = applyResolvedCallsites(roots, candidates, [resolved, resolved, resolved])
    const [c1, c2, c3] = out[0].children!
    expect(c1.editTarget).toEqual({ file: GRID, line: 8, column: 6 })
    expect(c2.editTarget).toEqual({ file: GRID, line: 25, column: 6 })
    // A third instance with no third callsite is left alone rather than
    // guessed: the DOM has more of them than the file writes, so the
    // mapping is not trustworthy for it.
    expect(c3.editTarget).toEqual({ file: CARD, line: 10, column: 4 })
    expect(c3.name).toBe("div")
  })
})
