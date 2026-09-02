import { describe, it, expect } from "vitest"
import { applyJsxFlattenConditionalEdit } from "./apply-jsx-flatten-conditional-edit"

// Helper: locate a tag's Babel (line, col) in a source string.
function loc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  const line = before.split("\n").length
  const column = idx - (before.lastIndexOf("\n") + 1)
  return { line, column }
}

describe("applyJsxFlattenConditionalEdit", () => {
  const ternary = `export default function App() {
  return (
    <div>
      {on ? <Yes className="y">A</Yes> : <No className="n">B</No>}
    </div>
  )
}
`

  it("keeps the clicked branch (consequent) with branchToKeep 0", () => {
    const { line, column } = loc(ternary, "<Yes")
    const r = applyJsxFlattenConditionalEdit({ source: ternary, line, column, branchToKeep: 0 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<Yes className="y">A</Yes>')
      expect(r.source).not.toContain("<No")
      expect(r.source).not.toContain("on ?")
    }
  })

  it("keeps the other branch with branchToKeep 'else'", () => {
    const { line, column } = loc(ternary, "<Yes")
    const r = applyJsxFlattenConditionalEdit({ source: ternary, line, column, branchToKeep: "else" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<No className="n">B</No>')
      expect(r.source).not.toContain("<Yes")
    }
  })

  it("is clicked-relative: clicking the alternate, 'else' keeps the consequent", () => {
    const { line, column } = loc(ternary, "<No")
    const r = applyJsxFlattenConditionalEdit({ source: ternary, line, column, branchToKeep: "else" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<Yes")
      expect(r.source).not.toContain("<No")
    }
  })

  it("flattens a logical && to its rendered element (branchToKeep 0)", () => {
    const and = `export const A = () => <div>{show && <Banner className="b">Hi</Banner>}</div>\n`
    const { line, column } = loc(and, "<Banner")
    const r = applyJsxFlattenConditionalEdit({ source: and, line, column, branchToKeep: 0 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<Banner className="b">Hi</Banner>')
      expect(r.source).not.toContain("show &&")
    }
  })

  it("removes a logical && render with branchToKeep 'else'", () => {
    const and = `export const A = () => <div>{show && <Banner>Hi</Banner>}</div>\n`
    const { line, column } = loc(and, "<Banner")
    const r = applyJsxFlattenConditionalEdit({ source: and, line, column, branchToKeep: "else" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<div></div>")
      expect(r.source).not.toContain("Banner")
    }
  })

  it("wraps a non-JSX kept branch so it stays a valid child", () => {
    const src = `export const A = (p) => <div>{p.on ? <X/> : null}</div>\n`
    const { line, column } = loc(src, "<X/>")
    const r = applyJsxFlattenConditionalEdit({ source: src, line, column, branchToKeep: "else" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<div>{null}</div>")
  })

  it("refuses when the element isn't in a conditional", () => {
    const src = `export const A = () => <div><span>x</span></div>\n`
    const { line, column } = loc(src, "<span")
    const r = applyJsxFlattenConditionalEdit({ source: src, line, column, branchToKeep: 0 })
    expect(r.ok).toBe(false)
  })

  it("targets the INNER conditional for a nested ternary", () => {
    const src = `export const A = (p) => <div>{p.a ? (p.b ? <X/> : <Y/>) : <Z/>}</div>\n`
    const { line, column } = loc(src, "<X/>")
    // Click <X/>, keep else → inner flattens to <Y/>, outer untouched.
    const r = applyJsxFlattenConditionalEdit({ source: src, line, column, branchToKeep: "else" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<Y/>")
      expect(r.source).not.toContain("<X/>")
      // Outer ternary still present (Z still reachable).
      expect(r.source).toContain("<Z/>")
      expect(r.source).toContain("p.a ?")
    }
  })

  it("refuses a nonzero numeric branchToKeep (JSX has only 0 / else)", () => {
    const { line, column } = loc(ternary, "<Yes")
    const r = applyJsxFlattenConditionalEdit({ source: ternary, line, column, branchToKeep: 1 })
    expect(r.ok).toBe(false)
  })

  it("refuses when no element matches the coord", () => {
    const r = applyJsxFlattenConditionalEdit({ source: ternary, line: 99, column: 0, branchToKeep: 0 })
    expect(r.ok).toBe(false)
  })
})
