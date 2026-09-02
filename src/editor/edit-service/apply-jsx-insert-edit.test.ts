/**
 * Unit coverage for the JSX insert applicator. Coordinates are Babel coords
 * (1-based line, 0-based column). Mirrors apply-insert-edit.test.ts.
 */
import { describe, it, expect } from "vitest"
import { applyJsxInsertEdit } from "./apply-jsx-insert-edit"

const SRC = `const C = () => (
  <ul>
    <li>A</li>
    <li>B</li>
  </ul>
)
`

describe("applyJsxInsertEdit — element content", () => {
  it("appends a new element child (-1)", () => {
    // <ul> at line 2, col 2.
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<li>C</li>",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const idxB = r.source.indexOf(">B<")
      const idxC = r.source.indexOf(">C<")
      expect(idxC).toBeGreaterThan(idxB)
    }
  })

  it("inserts at index 0 (front)", () => {
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: 0,
      snippet: "<li>Z</li>",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const idxZ = r.source.indexOf(">Z<")
      const idxA = r.source.indexOf(">A<")
      expect(idxZ).toBeLessThan(idxA)
    }
  })

  it("inserts into an empty parent", () => {
    const s = `const C = () => <div></div>\n`
    // <div> at line 1, col 16.
    const r = applyJsxInsertEdit({
      source: s,
      destParentLine: 1,
      destParentColumn: 16,
      destIndex: -1,
      snippet: "<span>hi</span>",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toMatch(/<div>[\s\S]*<span>hi<\/span>[\s\S]*<\/div>/)
  })
})

describe("applyJsxInsertEdit — text content", () => {
  it("inserts JSX-escaped plain text", () => {
    const s = `const C = () => <div></div>\n`
    const r = applyJsxInsertEdit({
      source: s,
      destParentLine: 1,
      destParentColumn: 16,
      destIndex: -1,
      snippet: "2 < 3 & {x}",
      contentKind: "text",
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("2 &lt; 3 &amp; &#123;x&#125;")
      expect(r.source).not.toContain("2 < 3 & {x}")
    }
  })
})

describe("applyJsxInsertEdit — component auto-import", () => {
  const BASE = `import { useState } from "react"

const C = () => (
  <div>
    <span>x</span>
  </div>
)
`
  it("adds a named import for a package component", () => {
    const r = applyJsxInsertEdit({
      source: BASE,
      destParentLine: 4,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<UiCard>Hello</UiCard>",
      componentImport: { name: "UiCard", importPath: "@acme/design-system" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("import { UiCard } from '@acme/design-system'")
      expect(r.source).toContain("<UiCard>Hello</UiCard>")
    }
  })

  it("adds a default import for a relative path", () => {
    const r = applyJsxInsertEdit({
      source: BASE,
      destParentLine: 4,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<Card>Hello</Card>",
      componentImport: { name: "Card", importPath: "./Card" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.source).toContain("import Card from './Card'")
  })

  it("is idempotent when the import already exists", () => {
    const withImport = `import { UiCard } from '@acme/design-system'\n${BASE}`
    const r = applyJsxInsertEdit({
      source: withImport,
      destParentLine: 5,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<UiCard>Hello</UiCard>",
      componentImport: { name: "UiCard", importPath: "@acme/design-system" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Only one import line for UiCard.
      const matches = r.source.match(/import \{ UiCard \}/g) ?? []
      expect(matches.length).toBe(1)
    }
  })

  it("inserts the import AFTER a directive prologue (preserves 'use client')", () => {
    const clientFile = `'use client'

const C = () => (
  <div>
    <span>x</span>
  </div>
)
`
    const r = applyJsxInsertEdit({
      source: clientFile,
      destParentLine: 4,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<UiCard>Hello</UiCard>",
      componentImport: { name: "UiCard", importPath: "@acme/design-system" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The directive stays the first statement; the import follows it.
      expect(r.source.indexOf("'use client'")).toBeLessThan(
        r.source.indexOf("import { UiCard }"),
      )
      expect(r.source.startsWith("'use client'")).toBe(true)
    }
  })

  it("warns (and still inserts) when the name collides with an existing binding", () => {
    const collide = `import { useState } from "react"
const UiCard = 1

const C = () => (
  <div>
    <span>x</span>
  </div>
)
`
    const r = applyJsxInsertEdit({
      source: collide,
      destParentLine: 5,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<UiCard>Hello</UiCard>",
      componentImport: { name: "UiCard", importPath: "@acme/design-system" },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain("<UiCard>Hello</UiCard>")
      expect(r.warnings?.some((w) => /already exists/.test(w))).toBe(true)
    }
  })
})

describe("applyJsxInsertEdit — refusals", () => {
  it("refuses a self-closing destination", () => {
    const s = `const C = () => <br />\n`
    const r = applyJsxInsertEdit({
      source: s,
      destParentLine: 1,
      destParentColumn: 16,
      destIndex: -1,
      snippet: "<span>x</span>",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/self-closing/)
  })

  it("refuses a multi-element snippet", () => {
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "<li>a</li><li>b</li>",
    })
    expect(r.ok).toBe(false)
    // Adjacent JSX elements fail the parenthesized-expression parse (Babel's
    // "Adjacent JSX elements must be wrapped"); either that or the single-root
    // check is a valid refusal.
    if (!r.ok) expect(r.reason).toMatch(/SINGLE JSX element|did not parse/)
  })

  it("refuses a bare-text snippet on the element path", () => {
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "just text",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no root JSX element|did not parse/)
  })

  it("refuses an empty snippet", () => {
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 2,
      destParentColumn: 2,
      destIndex: -1,
      snippet: "   ",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/non-empty/)
  })

  it("refuses when the destination parent isn't found", () => {
    const r = applyJsxInsertEdit({
      source: SRC,
      destParentLine: 99,
      destParentColumn: 0,
      destIndex: -1,
      snippet: "<li>C</li>",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No destination parent/)
  })
})
