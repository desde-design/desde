/**
 * Unit coverage for the JSX text-edit applicator. Coordinates are Babel coords
 * (1-based line, 0-based column). Mirrors apply-slot-text-edit.test.ts.
 */
import { describe, it, expect } from "vitest"
import { applyJsxSlotTextEdit } from "./apply-jsx-slot-text-edit"

// Single-line `const C = () => <tag…` puts the opening tag at column 16.

describe("applyJsxSlotTextEdit — happy path", () => {
  it("rewrites a pure-text element child", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "New", after: "Updated" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("<span>Updated</span>")
  })

  it("works when the element also has attributes", () => {
    const src = `const C = () => <span className="hidden sm:inline">New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "New", after: "New chat" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain('<span className="hidden sm:inline">New chat</span>')
  })

  it("escapes JSX-special characters in the new text (no source corruption)", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "New", after: "2 < 3 & {x}" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<span>2 &lt; 3 &amp; &#123;x&#125;</span>")
      expect(r.source).not.toContain("2 < 3 & {x}")
    }
  })

  it("preserves leading/trailing whitespace (indentation)", () => {
    const src = `const C = () => (\n  <span>\n    New\n  </span>\n)\n` // <span> at line 2, col 2
    const r = applyJsxSlotTextEdit({ source: src, line: 2, column: 2, before: "New", after: "Updated" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("\n    Updated\n  </span>")
  })
})

describe("applyJsxSlotTextEdit — refusals (LLM fallback)", () => {
  it("refuses an element with an interpolation child", () => {
    const src = `const C = ({ name }) => <b>Hi {name}</b>\n` // <b> at col 24
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 24, before: "Hi", after: "Hello" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/mixed|expression|LLM/)
  })

  it("refuses an element whose only child is a nested element", () => {
    const src = `const C = () => <div><b>x</b></div>\n` // <div> at col 16
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "x", after: "y" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not static text|mixed/)
  })

  it("refuses on a before mismatch", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "Old", after: "Updated" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/mismatch/)
  })

  it("refuses an element with no text child", () => {
    const src = `const C = () => <div></div>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "x", after: "y" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no text child/)
  })

  it("refuses a no-op (after === before)", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "New", after: "New" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unchanged/)
  })

  it("refuses when no element is at the coordinate", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 9, column: 0, before: "New", after: "X" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No JSX element/)
  })
})

describe("applyJsxSlotTextEdit — post-splice validation (WS2 defense-in-depth)", () => {
  // tasks/edit-pipeline-rearchitecture.md WS2: added a strict Babel re-parse
  // (errorRecovery OFF) after every genuinely-changed splice, mirroring
  // apply-jsx-delete-edit.ts. Unlike the Vue sibling (apply-slot-text-edit.ts,
  // which splices `after` into template text with NO escaping), this
  // applicator already HTML-entity-escapes `<`/`>`/`{`/`}`/`&` via
  // `escapeJsxText` before splicing (see the "escapes JSX-special characters"
  // test above) — so every character that could otherwise break JSX text
  // parsing is neutralized upstream of the splice. Probing did not find an
  // input reachable through this applicator's public API that trips the new
  // backstop; it is unreachable-by-construction today given the existing
  // escaping. This suite pins down that ordinary edits still pass the
  // compile check, so a regression in `escapeJsxText` would be caught here
  // (defense-in-depth) even before the escaping-specific test above notices.
  it("still returns ok:true for a normal text replace that parses cleanly", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({ source: src, line: 1, column: 16, before: "New", after: "Updated" })
    expect(r.ok).toBe(true)
  })

  it("still returns ok:true when the new text contains JSX-special characters (escaped upstream)", () => {
    const src = `const C = () => <span>New</span>\n`
    const r = applyJsxSlotTextEdit({
      source: src,
      line: 1,
      column: 16,
      before: "New",
      after: "<div>{unterminated</script>",
    })
    expect(r.ok).toBe(true)
  })
})
