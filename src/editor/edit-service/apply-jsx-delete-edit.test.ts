/**
 * Unit coverage for the JSX delete applicator. Coordinates are Babel coords
 * (1-based line, 0-based column). Mirrors apply-delete-edit.test.ts.
 */
import { describe, it, expect } from "vitest"
import { applyJsxDeleteEdit } from "./apply-jsx-delete-edit"

const SRC = `const C = () => (
  <div>
    <span>keep</span>
    <button>remove</button>
  </div>
)
`

describe("applyJsxDeleteEdit — happy path", () => {
  it("removes a nested element", () => {
    // <button> at line 4, col 4.
    const r = applyJsxDeleteEdit({ source: SRC, line: 4, column: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).not.toContain("remove")
      expect(r.source).toContain("<span>keep</span>")
    }
  })

  it("removes a self-closing nested element", () => {
    const s = `const C = () => (
  <div>
    <img src="a.png" />
    <span>x</span>
  </div>
)
`
    // <img/> at line 3, col 4.
    const r = applyJsxDeleteEdit({ source: s, line: 3, column: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).not.toContain("a.png")
  })
})

describe("applyJsxDeleteEdit — refusals", () => {
  it("refuses deleting the returned root element", () => {
    // <div> at line 2, col 2 — the returned root, no JSX parent.
    const r = applyJsxDeleteEdit({ source: SRC, line: 2, column: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/root or expression-embedded/)
  })

  it("refuses an expression-embedded element", () => {
    const s = `const C = ({ show }) => (
  <div>
    {show && <span>maybe</span>}
  </div>
)
`
    // <span> is inside {show && …}; its parent in the AST is a LogicalExpression,
    // not a JSXElement — refuse to the LLM lane. <span> at line 3, col 13.
    const r = applyJsxDeleteEdit({ source: s, line: 3, column: 13 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/root or expression-embedded/)
  })

  it("refuses when no element is at the coordinate", () => {
    const r = applyJsxDeleteEdit({ source: SRC, line: 99, column: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No JSX element/)
  })
})
