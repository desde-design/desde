/**
 * Unit coverage for the JSX prop-edit applicator. Coordinates are Babel coords
 * (1-based line, 0-based column) — what jsx-source-tag-plugin stamps and the
 * bridge surfaces as editTarget. Mirrors apply-prop-edit.test.ts.
 */
import { describe, it, expect } from "vitest"
import { applyJsxPropEdit } from "./apply-jsx-prop-edit"

const sample = `export function App() {
  return (
    <div className="row">
      <KButton variant="primary">Save</KButton>
    </div>
  )
}
`
// <KButton> opening tag is line 4, indented 6 → column 6.

describe("applyJsxPropEdit — existing literal attribute", () => {
  it("replaces a string attribute value, preserving surrounding source", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "variant", value: "danger" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<KButton variant="danger">Save</KButton>')
      expect(r.source).toContain('<div className="row">')
    }
  })

  it("replaces a numeric expression-literal attribute ({3} → {5})", () => {
    const src = `export const C = () => <Box count={3} />\n` // <Box> at 1:23
    const r = applyJsxPropEdit({ source: src, line: 1, column: 23, propName: "count", value: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<Box count={5} />")
  })

  it("escapes double-quotes when writing a string value", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "variant", value: 'a"b' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('variant="a&quot;b"')
  })
})

describe("applyJsxPropEdit — absent attribute (insert)", () => {
  it("inserts a string attribute right after the tag name", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "size", value: "lg" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<KButton size="lg" variant="primary">')
  })

  it("inserts a number attribute as a JSX expression", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "tabIndex", value: 0 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<KButton tabIndex={0} variant=")
  })

  it("inserts a boolean attribute as a JSX expression", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "disabled", value: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<KButton disabled={true} variant=")
  })
})

describe("applyJsxPropEdit — refusals with fallback", () => {
  it("refuses a non-literal bound attribute and emits a bound-binding hint", () => {
    const src = `export const C = ({ kind }) => <Box variant={kind} />\n` // <Box> at 1:30
    const r = applyJsxPropEdit({ source: src, line: 1, column: 31, propName: "variant", value: "danger" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fallback?.kind).toBe("bound-binding")
      if (r.fallback?.kind === "bound-binding") expect(r.fallback.expression).toBe("kind")
    }
  })

  it("refuses to insert when the element has a {...spread} (dynamic-vbind)", () => {
    const src = `export const C = (props) => <Box {...props} />\n` // <Box> at 1:28
    const r = applyJsxPropEdit({ source: src, line: 1, column: 28, propName: "size", value: "lg" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("dynamic-vbind")
  })
})

describe("applyJsxPropEdit — edge cases", () => {
  it("sets a value on a boolean-shorthand attribute", () => {
    const src = `export const C = () => <input disabled />\n` // <input> at 1:22
    const r = applyJsxPropEdit({ source: src, line: 1, column: 23, propName: "disabled", value: false })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<input disabled={false} />")
  })

  it("inserts after TSX type arguments on a generic component (<Table<Row> />)", () => {
    const src = `const C = () => <Table<Row> rows={r} />\n` // <Table> at 1:16
    const r = applyJsxPropEdit({ source: src, line: 1, column: 16, propName: "size", value: "lg" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<Table<Row> size="lg" rows={r} />')
  })

  it("handles a member-expression tag (<Foo.Bar>)", () => {
    const src = `export const C = () => <Foo.Bar label="x" />\n` // <Foo.Bar> at 1:22
    const r = applyJsxPropEdit({ source: src, line: 1, column: 23, propName: "label", value: "y" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<Foo.Bar label="y" />')
  })

  it("refuses when no element exists at the coordinate", () => {
    const r = applyJsxPropEdit({ source: sample, line: 99, column: 0, propName: "variant", value: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No JSX element/)
  })

  it("handles a JSX element at column 0 (Babel 0-based; the validator allows col 0)", () => {
    const src = `const x = (\n<div id="a">hi</div>\n)\n` // <div> at line 2, column 0
    const r = applyJsxPropEdit({ source: src, line: 2, column: 0, propName: "id", value: "b" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<div id="b">hi</div>')
  })

  it("refuses an unsafe prop name", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "on click", value: "x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/Unsafe prop name/)
  })
})

// The load-bearing M1→M2 integration: the exact scratch App.tsx + the
// (line 9, col 6) editTarget the bridge produced live in M1.4.
const scratchApp = `import { useState } from "react"

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="app">
      <h1 className="title">React Scratch App</h1>
      <p className="caption">A paragraph for inspector source-location testing.</p>
      <button className="cta" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} times
      </button>
    </div>
  )
}
`

describe("applyJsxPropEdit — M1→M2 integration (bridge editTarget → applicator)", () => {
  it("edits the button's className at the live editTarget {App.tsx:9:6}", () => {
    const r = applyJsxPropEdit({ source: scratchApp, line: 9, column: 6, propName: "className", value: "cta-active" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<button className="cta-active" onClick=')
      // the bound onClick is untouched
      expect(r.source).toContain("onClick={() => setCount((c) => c + 1)}")
    }
  })

  it("refuses to clobber the bound onClick handler at the same element", () => {
    const r = applyJsxPropEdit({ source: scratchApp, line: 9, column: 6, propName: "onClick", value: "noop" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback?.kind).toBe("bound-binding")
  })
})

describe("applyJsxPropEdit — post-splice validation (WS2 defense-in-depth)", () => {
  // tasks/edit-pipeline-rearchitecture.md WS2: added a strict Babel re-parse
  // (errorRecovery OFF) after every genuinely-changed splice, mirroring
  // apply-jsx-delete-edit.ts. Unlike the Vue lane's apply-prop-edit.ts (where
  // `v-`-prefixed prop names inject real structural directives), JSX has no
  // attribute-name-triggered structural syntax, and `escapeAttr` (`&`/`"`)
  // covers every character that could break a double-quoted JSX attribute
  // value — `<`, `{`, `}` are all syntactically inert inside a quoted string.
  // Exhaustive probing (see PR description / task notes) found no input
  // reachable through this applicator's public API that trips the new
  // backstop. It is unreachable-by-construction today; this suite instead
  // pins down that ordinary edits keep passing the compile check, so a
  // future regression here would be caught immediately.
  it("still returns ok:true for a normal replace that parses cleanly", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "variant", value: "danger" })
    expect(r.ok).toBe(true)
  })

  it("still returns ok:true for a normal insert that parses cleanly", () => {
    const r = applyJsxPropEdit({ source: sample, line: 4, column: 6, propName: "size", value: "lg" })
    expect(r.ok).toBe(true)
  })

  it("does not choke on a string value containing JSX-special characters (escaped safely)", () => {
    const r = applyJsxPropEdit({
      source: sample,
      line: 4,
      column: 6,
      propName: "variant",
      value: '<div>{unterminated</script>',
    })
    expect(r.ok).toBe(true)
  })
})
