import { describe, it, expect } from "vitest"
import { inferAttrFromJsxTextEdit } from "./infer-attr-from-jsx-text-edit"

// Babel coords: 1-based line, 0-based column of the JSXOpeningElement.
const sample = `export function App() {
  return (
    <div>
      <Button label="Save" variant="primary" aria-label="other" />
    </div>
  )
}
`

describe("inferAttrFromJsxTextEdit", () => {
  it("infers the single static attribute matching the captured text", () => {
    const r = inferAttrFromJsxTextEdit({ source: sample, line: 4, column: 6, before: "Save" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.propName).toBe("label")
  })

  it("trims before/after when comparing", () => {
    const r = inferAttrFromJsxTextEdit({ source: sample, line: 4, column: 6, before: "  Save  " })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.propName).toBe("label")
  })

  it("refuses when no static attribute matches", () => {
    const r = inferAttrFromJsxTextEdit({ source: sample, line: 4, column: 6, before: "Nope" })
    expect(r.ok).toBe(false)
  })

  it("refuses when two attributes share the captured value (ambiguous)", () => {
    const src = `export const A = () => <Tag a="x" b="x" />\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 23, before: "x" })
    expect(r.ok).toBe(false)
  })

  it("refuses when the element has a {...spread}", () => {
    const src = `export const A = (p) => <Button label="Save" {...p} />\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 24, before: "Save" })
    expect(r.ok).toBe(false)
  })

  it("refuses when any attribute is bound to an expression", () => {
    const src = `export const A = (p) => <Button label="Save" title={p.t} />\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 24, before: "Save" })
    expect(r.ok).toBe(false)
  })

  it("refuses when children could render the text (expression child)", () => {
    // aria-label coincidentally equals the rendered text, but the real source
    // is the {label} child — must NOT rewrite aria-label.
    const src = `export const A = (p) => <Button aria-label="Save">{p.label}</Button>\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 24, before: "Save" })
    expect(r.ok).toBe(false)
  })

  it("refuses when children include a nested element", () => {
    const src = `export const A = () => <Button aria-label="Save"><b>x</b></Button>\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 23, before: "Save" })
    expect(r.ok).toBe(false)
  })

  it("still recovers when the only child is a JSX comment (renders nothing)", () => {
    const src = `export const A = () => <Button label="Save">{/* note */}</Button>\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 23, before: "Save" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.propName).toBe("label")
  })

  it("still recovers for a self-closing prop-rendered element", () => {
    const src = `export const A = () => <Button label="Save" />\n`
    const r = inferAttrFromJsxTextEdit({ source: src, line: 1, column: 23, before: "Save" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.propName).toBe("label")
  })

  it("refuses empty before", () => {
    const r = inferAttrFromJsxTextEdit({ source: sample, line: 4, column: 6, before: "   " })
    expect(r.ok).toBe(false)
  })

  it("refuses when no element is at the coord", () => {
    const r = inferAttrFromJsxTextEdit({ source: sample, line: 99, column: 0, before: "Save" })
    expect(r.ok).toBe(false)
  })
})
