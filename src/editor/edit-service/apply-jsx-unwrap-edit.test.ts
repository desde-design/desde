import { describe, it, expect } from "vitest"
import { applyJsxUnwrapEdit } from "./apply-jsx-unwrap-edit"

describe("applyJsxUnwrapEdit", () => {
  it("hoists a wrapper's children into its place", () => {
    const src = `export function App() {
  return (
    <section>
      <div className="wrap">
        <span>a</span>
        <p>b</p>
      </div>
    </section>
  )
}
`
    // <div className="wrap"> opening tag: line 4, column 6.
    const r = applyJsxUnwrapEdit({ source: src, line: 4, column: 6 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<span>a</span>")
      expect(r.source).toContain("<p>b</p>")
      expect(r.source).not.toContain('className="wrap"')
    }
  })

  it("unwraps a single-child wrapper that is the returned root", () => {
    const src = `export const A = () => <div><span>x</span></div>\n`
    // <div> at column 23.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 23 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<span>x</span>")
  })

  it("refuses a self-closing element (use Delete)", () => {
    const src = `export const A = () => <div><img src="x" /></div>\n`
    // <img .../> at column 28.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 28 })
    expect(r.ok).toBe(false)
  })

  it("refuses an empty (whitespace-only) wrapper", () => {
    const src = `export const A = () => <div><span>   </span></div>\n`
    // <span> at column 28 has whitespace-only text.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 28 })
    expect(r.ok).toBe(false)
  })

  it("refuses when unwrapping a multi-child returned root (adjacent JSX)", () => {
    const src = `export const A = () => <div><span>a</span><p>b</p></div>\n`
    // <div> root at column 23 — unwrapping yields `<span/><p/>` adjacent → invalid.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 23 })
    expect(r.ok).toBe(false)
  })

  it("refuses unwrapping a root wrapper whose child is text (would become an identifier)", () => {
    const src = `export const A = () => <div>Save</div>\n`
    // <div> root at column 23.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 23 })
    expect(r.ok).toBe(false)
  })

  it("refuses unwrapping a root wrapper whose child is an expression (would become an object)", () => {
    const src = `export const A = (p) => <div>{p.foo}</div>\n`
    // <div> root at column 24.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 24 })
    expect(r.ok).toBe(false)
  })

  it("allows unwrapping a non-root wrapper whose child is text", () => {
    const src = `export const A = () => <p><span>Save</span></p>\n`
    // <span> at column 26 — it has a JSX parent (<p>), so text is valid here.
    const r = applyJsxUnwrapEdit({ source: src, line: 1, column: 26 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<p>Save</p>")
  })

  it("unwraps a multiline returned root without ASI breakage (splices the element)", () => {
    const src = `export function A() {
  return (
    <div>
      <span>x</span>
    </div>
  )
}
`
    // <div> at line 3, column 4. Promoting must not leave `return <newline><span>`.
    const r = applyJsxUnwrapEdit({ source: src, line: 3, column: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<span>x</span>")
      expect(r.source).not.toContain("<div>")
      // The promoted element sits where <div> was (no stray newline before it
      // that would ASI-truncate the return).
      expect(r.source).toMatch(/return\s*\(\s*<span>x<\/span>\s*\)/)
      // Sanity: the module still parses AND the function body isn't `return;`.
      expect(r.source).not.toMatch(/return\s*;/)
    }
  })

  it("refuses when no element matches the coord", () => {
    const src = `export const A = () => <div><span>x</span></div>\n`
    const r = applyJsxUnwrapEdit({ source: src, line: 9, column: 0 })
    expect(r.ok).toBe(false)
  })
})
