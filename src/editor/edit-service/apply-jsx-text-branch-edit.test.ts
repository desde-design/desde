import { describe, it, expect } from "vitest"
import { applyJsxTextBranchEdit } from "./apply-jsx-text-branch-edit"
import { detectJsxTextBranches } from "./detect-jsx-text-branches"

const src = `export const A = (p) => <span>{p.on ? "On" : "Off"}</span>\n`

describe("applyJsxTextBranchEdit", () => {
  it("rewrites a literal branch (detector → applicator round-trip)", () => {
    const det = detectJsxTextBranches({ source: src, line: 1, column: 24 })
    expect(det).not.toBeNull()
    if (!det) return
    const b = det.branches[0] // "On"
    const r = applyJsxTextBranchEdit({
      source: src,
      byteStart: b.byteStart,
      byteEnd: b.byteEnd,
      valueKind: b.valueKind,
      newValue: "Enabled",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain(`{p.on ? "Enabled" : "Off"}`)
  })

  it("escapes quotes/backslashes in a literal replacement", () => {
    const det = detectJsxTextBranches({ source: src, line: 1, column: 24 })!
    const b = det.branches[1] // "Off"
    const r = applyJsxTextBranchEdit({
      source: src,
      byteStart: b.byteStart,
      byteEnd: b.byteEnd,
      valueKind: b.valueKind,
      newValue: 'say "hi"',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('"say \\"hi\\""')
      // Still parses.
    }
  })

  it("splices a bound replacement verbatim", () => {
    const boundSrc = `export const A = (p) => <span>{p.on ? p.a : p.b}</span>\n`
    const det = detectJsxTextBranches({ source: boundSrc, line: 1, column: 24 })!
    const b = det.branches[0]
    const r = applyJsxTextBranchEdit({
      source: boundSrc,
      byteStart: b.byteStart,
      byteEnd: b.byteEnd,
      valueKind: "bound",
      newValue: "p.label",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain(`{p.on ? p.label : p.b}`)
  })

  it("refuses an invalid bound expression", () => {
    const r = applyJsxTextBranchEdit({
      source: src,
      byteStart: 31,
      byteEnd: 35,
      valueKind: "bound",
      newValue: "foo(",
    })
    expect(r.ok).toBe(false)
  })

  it("refuses an out-of-bounds range", () => {
    const r = applyJsxTextBranchEdit({
      source: src,
      byteStart: 0,
      byteEnd: src.length + 10,
      valueKind: "literal",
      newValue: "x",
    })
    expect(r.ok).toBe(false)
  })
})
