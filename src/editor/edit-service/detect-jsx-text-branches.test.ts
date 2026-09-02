import { describe, it, expect } from "vitest"
import { detectJsxTextBranches } from "./detect-jsx-text-branches"

describe("detectJsxTextBranches", () => {
  it("detects a ternary with two string-literal branches", () => {
    const src = `export const A = () => <span>{enabled ? "On" : "Off"}</span>\n`
    // <span> opening tag at column 23.
    const r = detectJsxTextBranches({ source: src, line: 1, column: 23 })
    expect(r).not.toBeNull()
    if (r) {
      expect(r.testExpression).toBe("enabled")
      expect(r.branches[0]).toMatchObject({ kind: "consequent", valueKind: "literal", value: "On" })
      expect(r.branches[1]).toMatchObject({ kind: "alternate", valueKind: "literal", value: "Off" })
      // Byte ranges include the quotes.
      expect(src.slice(r.branches[0].byteStart, r.branches[0].byteEnd)).toBe('"On"')
      expect(src.slice(r.branches[1].byteStart, r.branches[1].byteEnd)).toBe('"Off"')
    }
  })

  it("classifies a non-literal branch as bound", () => {
    const src = `export const A = (p) => <span>{p.on ? p.label : "Off"}</span>\n`
    const r = detectJsxTextBranches({ source: src, line: 1, column: 24 })
    expect(r).not.toBeNull()
    if (r) {
      expect(r.branches[0]).toMatchObject({ valueKind: "bound", value: "p.label" })
      expect(r.branches[1]).toMatchObject({ valueKind: "literal", value: "Off" })
    }
  })

  it("ignores surrounding whitespace text children", () => {
    const src = `export function A() {
  return (
    <span>
      {flag ? "Yes" : "No"}
    </span>
  )
}
`
    // <span> at line 3, column 4.
    const r = detectJsxTextBranches({ source: src, line: 3, column: 4 })
    expect(r).not.toBeNull()
    if (r) expect(r.testExpression).toBe("flag")
  })

  it("returns null for a non-ternary expression child", () => {
    const src = `export const A = (p) => <span>{p.name}</span>\n`
    const r = detectJsxTextBranches({ source: src, line: 1, column: 24 })
    expect(r).toBeNull()
  })

  it("returns null for a plain text child", () => {
    const src = `export const A = () => <span>hello</span>\n`
    const r = detectJsxTextBranches({ source: src, line: 1, column: 23 })
    expect(r).toBeNull()
  })

  it("returns null for mixed children (text + container)", () => {
    const src = `export const A = (p) => <span>x {p.on ? "a" : "b"}</span>\n`
    const r = detectJsxTextBranches({ source: src, line: 1, column: 24 })
    expect(r).toBeNull()
  })

  it("returns null when no element is at the coord", () => {
    const src = `export const A = () => <span>{a ? "x" : "y"}</span>\n`
    const r = detectJsxTextBranches({ source: src, line: 9, column: 0 })
    expect(r).toBeNull()
  })
})
