/**
 * The static half of callsite recovery for a component the runtime has no
 * instance for.
 *
 * A Next.js server component ignores its props, so nothing the caller stamps
 * on `<KpiCards />` reaches the browser: not `data-desde-src`, not
 * `data-desde-call`. The bridge can only attribute its root element to the
 * component's own file. But the callsite is on disk. Given the root's
 * coordinate and the file the element is displayed inside, these two
 * functions answer "which component is this the root of?" and "where is it
 * written in that file?" from the source alone.
 */
import { describe, expect, it } from "vitest"
import { findJsxCallsites, resolveJsxComponentRoot } from "./resolve-jsx-callsite"

const KPI_CARDS = `import { Card } from "@/components/ui/card";

export function KpiCards() {
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2>Pipeline</h2>
      </div>
    </section>
  );
}
`

const PAGE = `import { KpiCards } from "./_components/kpi-cards";
import { OpportunitiesSection } from "./_components/opportunities-section";
import { PipelineActivity } from "./_components/pipeline-activity";

export default function Page() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <KpiCards />
      <PipelineActivity />
      <OpportunitiesSection />
    </div>
  );
}
`

describe("resolveJsxComponentRoot", () => {
  it("names the function component whose returned root sits at the coordinate", () => {
    // <section> opens at line 5, column 4 (Babel 0-based column).
    expect(resolveJsxComponentRoot(KPI_CARDS, 5, 4)).toEqual({ name: "KpiCards" })
  })

  it("names an arrow component with an expression body", () => {
    const src = `export const Badge = () => <span>x</span>\n`
    expect(resolveJsxComponentRoot(src, 1, 27)).toEqual({ name: "Badge" })
  })

  it("names an arrow component with a block body", () => {
    const src = `const Badge = () => {\n  return <span>x</span>\n}\n`
    expect(resolveJsxComponentRoot(src, 2, 9)).toEqual({ name: "Badge" })
  })

  it("sees through one wrapper call (forwardRef, memo)", () => {
    const src = `const Btn = React.forwardRef((props, ref) => <button ref={ref} />)\n`
    expect(resolveJsxComponentRoot(src, 1, 45)).toEqual({ name: "Btn" })
  })

  it("names a default-exported function declaration", () => {
    expect(resolveJsxComponentRoot(PAGE, 7, 4)).toEqual({ name: "Page" })
  })

  it("answers null for an element that is not the returned root", () => {
    // The inner <div> at line 6, column 6.
    expect(resolveJsxComponentRoot(KPI_CARDS, 6, 6)).toBeNull()
  })

  it("answers null when the root is a fragment: the element is not the whole output", () => {
    const src = `function Two() {\n  return (\n    <>\n      <a />\n      <b />\n    </>\n  )\n}\n`
    expect(resolveJsxComponentRoot(src, 4, 6)).toBeNull()
  })

  it("answers null when nothing is at the coordinate", () => {
    expect(resolveJsxComponentRoot(KPI_CARDS, 40, 0)).toBeNull()
  })
})

describe("findJsxCallsites", () => {
  it("finds the one place the page writes the component, given the import matches the file", () => {
    expect(
      findJsxCallsites({
        source: PAGE,
        name: "KpiCards",
        definitionFile: "src/app/(main)/dashboard/crm/_components/kpi-cards.tsx",
        parentFile: "src/app/(main)/dashboard/crm/page.tsx",
      }),
    ).toEqual([{ line: 8, column: 6 }])
  })

  it("returns every callsite in source order when the component is written more than once", () => {
    const src = `import { Card } from "@/components/ui/card";
export function Grid() {
  return (
    <div>
      <Card>a</Card>
      <Card>b</Card>
    </div>
  );
}
`
    expect(
      findJsxCallsites({
        source: src,
        name: "Card",
        definitionFile: "src/components/ui/card.tsx",
        parentFile: "src/app/grid.tsx",
      }),
    ).toEqual([
      { line: 5, column: 6 },
      { line: 6, column: 6 },
    ])
  })

  it("accepts a default import under a local name", () => {
    const src = `import Hero from "./hero";\nconst P = () => <Hero />\n`
    expect(
      findJsxCallsites({
        source: src,
        name: "Hero",
        definitionFile: "src/pages/hero.tsx",
        parentFile: "src/pages/index.tsx",
      }),
    ).toEqual([{ line: 2, column: 16 }])
  })

  it("accepts an index module for a directory import", () => {
    const src = `import { Hero } from "./hero";\nconst P = () => <Hero />\n`
    expect(
      findJsxCallsites({
        source: src,
        name: "Hero",
        definitionFile: "src/pages/hero/index.tsx",
        parentFile: "src/pages/index.tsx",
      }),
    ).toEqual([{ line: 2, column: 16 }])
  })

  it("answers null when the name is imported from a different module", () => {
    const src = `import { KpiCards } from "some-package";\nconst P = () => <KpiCards />\n`
    expect(
      findJsxCallsites({
        source: src,
        name: "KpiCards",
        definitionFile: "src/app/crm/_components/kpi-cards.tsx",
        parentFile: "src/app/crm/page.tsx",
      }),
    ).toBeNull()
  })

  it("answers null when the name is not imported at all", () => {
    const src = `const P = () => <KpiCards />\n`
    expect(
      findJsxCallsites({
        source: src,
        name: "KpiCards",
        definitionFile: "src/app/crm/_components/kpi-cards.tsx",
        parentFile: "src/app/crm/page.tsx",
      }),
    ).toBeNull()
  })
})
