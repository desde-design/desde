import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  handleResolveCallsites,
  validateResolveCallsitesBody,
} from "../resolve-callsites-handler.js"

const KPI_CARDS = `export function KpiCards() {
  return (
    <section className="space-y-5">
      <h2>Pipeline</h2>
    </section>
  );
}
`

const PAGE = `import { KpiCards } from "./_components/kpi-cards";

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <KpiCards />
    </div>
  );
}
`

function babelLoc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") + 1) }
}

describe("resolve-callsites-handler", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-resolve-callsites-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(file: string, contents: string): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), contents, "utf8")
    return file
  }

  it("answers the callsite of a component root, read from the two files", async () => {
    const kpi = write("src/app/crm/_components/kpi-cards.tsx", KPI_CARDS)
    const page = write("src/app/crm/page.tsx", PAGE)
    const r = await handleResolveCallsites(
      { items: [{ file: kpi, ...babelLoc(KPI_CARDS, "<section"), parentFile: page }] },
      dir,
    )
    expect(r).toEqual({
      ok: true,
      status: 200,
      results: [{ name: "KpiCards", callsites: [babelLoc(PAGE, "<KpiCards")] }],
    })
  })

  it("answers null for an element that is not a component's root", async () => {
    const kpi = write("src/app/crm/_components/kpi-cards.tsx", KPI_CARDS)
    const page = write("src/app/crm/page.tsx", PAGE)
    const r = await handleResolveCallsites(
      { items: [{ file: kpi, ...babelLoc(KPI_CARDS, "<h2"), parentFile: page }] },
      dir,
    )
    expect(r).toEqual({ ok: true, status: 200, results: [null] })
  })

  it("answers null when the parent file does not import the component from that file", async () => {
    const kpi = write("src/app/crm/_components/kpi-cards.tsx", KPI_CARDS)
    const page = write(
      "src/app/crm/page.tsx",
      `import { KpiCards } from "elsewhere";\nexport default function P() { return <KpiCards /> }\n`,
    )
    const r = await handleResolveCallsites(
      { items: [{ file: kpi, ...babelLoc(KPI_CARDS, "<section"), parentFile: page }] },
      dir,
    )
    expect(r).toEqual({ ok: true, status: 200, results: [null] })
  })

  it("refuses a path that escapes the prototype root", async () => {
    const page = write("src/app/crm/page.tsx", PAGE)
    const r = await handleResolveCallsites(
      { items: [{ file: "../outside.tsx", line: 1, column: 0, parentFile: page }] },
      dir,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it("answers null, not an error, for a file under node_modules", async () => {
    const lib = write("node_modules/ui/card.tsx", KPI_CARDS)
    const page = write("src/app/crm/page.tsx", PAGE)
    const r = await handleResolveCallsites(
      { items: [{ file: lib, ...babelLoc(KPI_CARDS, "<section"), parentFile: page }] },
      dir,
    )
    expect(r).toEqual({ ok: true, status: 200, results: [null] })
  })

  it("answers null for a missing file rather than failing the batch", async () => {
    const page = write("src/app/crm/page.tsx", PAGE)
    const r = await handleResolveCallsites(
      { items: [{ file: "src/app/crm/_components/gone.tsx", line: 3, column: 4, parentFile: page }] },
      dir,
    )
    expect(r).toEqual({ ok: true, status: 200, results: [null] })
  })
})

describe("validateResolveCallsitesBody", () => {
  it("requires an items array of positioned file pairs", () => {
    expect(validateResolveCallsitesBody({})).toMatch(/items/)
    expect(validateResolveCallsitesBody({ items: [{ file: "a.tsx", line: 0, column: 0, parentFile: "b.tsx" }] })).toMatch(
      /line/,
    )
    expect(validateResolveCallsitesBody({ items: [{ file: "a.tsx", line: 1, column: 0 }] })).toMatch(/parentFile/)
    expect(
      validateResolveCallsitesBody({ items: [{ file: "a.tsx", line: 1, column: 0, parentFile: "b.tsx" }] }),
    ).toBeNull()
  })

  it("caps the batch", () => {
    const items = Array.from({ length: 201 }, () => ({ file: "a.tsx", line: 1, column: 0, parentFile: "b.tsx" }))
    expect(validateResolveCallsitesBody({ items })).toMatch(/at most 200/)
  })
})
