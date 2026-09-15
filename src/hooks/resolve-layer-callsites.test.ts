import { describe, expect, it, vi } from "vitest"
import {
  applyResolvedCallsites,
  collectCallsiteCandidates,
  fetchResolvedCallsites,
  type ResolvedCallsite,
} from "./resolve-layer-callsites"
import type { OutlineNode } from "@/types/bridge"

const editorFetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => editorFetchMock(...args),
}))

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
      { name: "KpiCards", parentHash: "abcdefabcdef", callsites: [{ line: 9, column: 6, dynamic:false }] },
      null,
    ]
    const out = applyResolvedCallsites(roots, candidates, results)
    const kpi = out[0].children![0]
    expect(kpi).toMatchObject({
      id: "kpi",
      name: "KpiCards",
      type: "component",
      // The parent file's hash rides along, so the stale-target guard covers
      // a recovered target the way it covers a stamped one (codex P2).
      editTarget: { file: PAGE, line: 9, column: 6, fileHash: "abcdefabcdef" },
      authoredAt: { file: KPI, line: 8, column: 4 },
    })
    // Children are carried over untouched.
    expect(kpi.children![0].id).toBe("kpi-inner")
    // The unresolved row is exactly as it was.
    expect(out[0].children![2]).toEqual(roots[0].children![2])
    // The input is not mutated.
    expect(roots[0].children![0].name).toBe("section")
  })

  const CARD = "src/components/ui/card.tsx"
  const GRID = "src/app/grid.tsx"
  function gridWith(count: number): OutlineNode[] {
    return [
      node({
        id: "grid",
        editTarget: { file: GRID, line: 7, column: 4 },
        children: Array.from({ length: count }, (_, i) =>
          node({ id: `c${i + 1}`, editTarget: { file: CARD, line: 10, column: 4 } }),
        ),
      }),
    ]
  }
  const twoStatic: ResolvedCallsite = {
    name: "Card",
    parentHash: "000000000000",
    callsites: [
      { line: 8, column: 6, dynamic:false },
      { line: 25, column: 6, dynamic:false },
    ],
  }

  it("maps DOM order onto source order when every callsite is static and the counts agree", () => {
    const roots = gridWith(2)
    const candidates = collectCallsiteCandidates(roots)
    const out = applyResolvedCallsites(roots, candidates, [twoStatic, twoStatic])
    const [c1, c2] = out[0].children!
    expect(c1.editTarget).toMatchObject({ file: GRID, line: 8, column: 6 })
    expect(c2.editTarget).toMatchObject({ file: GRID, line: 25, column: 6 })
  })

  it("leaves the whole group alone when the DOM has a different number of instances than the file writes (codex P1)", () => {
    // Three on screen, two in source: some callsite rendered more than once,
    // and DOM order no longer says which. Guessing would edit the wrong JSX.
    const roots = gridWith(3)
    const candidates = collectCallsiteCandidates(roots)
    const out = applyResolvedCallsites(roots, candidates, [twoStatic, twoStatic, twoStatic])
    for (const c of out[0].children!) {
      expect(c.editTarget).toEqual({ file: CARD, line: 10, column: 4 })
      expect(c.name).toBe("div")
    }
  })

  it("leaves the group alone when any callsite sits inside a {…} expression (codex P1)", () => {
    // `{flag ? <Card/> : <Card/>}` renders ONE Card from TWO callsites; the
    // counts can even agree by accident. Only static callsites are mapped.
    const conditional: ResolvedCallsite = {
      name: "Card",
      parentHash: "000000000000",
      callsites: [
        { line: 8, column: 14, dynamic:true },
        { line: 8, column: 31, dynamic:true },
      ],
    }
    const roots = gridWith(2)
    const candidates = collectCallsiteCandidates(roots)
    const out = applyResolvedCallsites(roots, candidates, [conditional, conditional])
    for (const c of out[0].children!) expect(c.editTarget).toEqual({ file: CARD, line: 10, column: 4 })
  })
})

describe("fetchResolvedCallsites", () => {
  it("sends the candidates in batches of at most 200 and stitches the answers (codex P2)", async () => {
    editorFetchMock.mockReset()
    editorFetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { items } = JSON.parse(init.body) as { items: unknown[] }
      return {
        ok: true,
        json: async () => ({ ok: true, results: items.map((_, i) => ({ name: `R${i}`, parentHash: "0", callsites: [] })) }),
      }
    })
    const items = Array.from({ length: 450 }, (_, i) => ({ file: `f${i}.tsx`, line: 1, column: 0, parentFile: "p.tsx" }))
    const results = await fetchResolvedCallsites(items)
    expect(editorFetchMock).toHaveBeenCalledTimes(3)
    const sizes = editorFetchMock.mock.calls.map((c) => (JSON.parse((c[1] as { body: string }).body) as { items: unknown[] }).items.length)
    expect(sizes).toEqual([200, 200, 50])
    expect(results).toHaveLength(450)
  })

  it("answers null for the whole tree when any batch fails, rather than a partial map", async () => {
    editorFetchMock.mockReset()
    editorFetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, results: Array(200).fill(null) }) })
      .mockResolvedValueOnce({ ok: false })
    const items = Array.from({ length: 250 }, (_, i) => ({ file: `f${i}.tsx`, line: 1, column: 0, parentFile: "p.tsx" }))
    expect(await fetchResolvedCallsites(items)).toBeNull()
  })
})
