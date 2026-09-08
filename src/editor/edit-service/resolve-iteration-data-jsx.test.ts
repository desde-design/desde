import { describe, it, expect } from "vitest"
import { resolveIterationDataJsxSameFile } from "./resolve-iteration-data-jsx"

function loc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") + 1) }
}

describe("resolveIterationDataJsxSameFile", () => {
  it("traces a const array-literal binding + key property", () => {
    const src = `const items = [{ id: 1, label: "A" }, { id: 2, label: "B" }]
export default function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.label}</li>)}
    </ul>
  )
}
`
    const r = resolveIterationDataJsxSameFile({
      source: src,
      templateLocation: loc(src, "<li key"),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.iterateeRoot).toBe("items")
      expect(r.keyProperty).toBe("id")
      // arrayLocation points at the `[` (1-based column → -1 for 0-based index).
      expect(src.split("\n")[r.arrayLocation.line - 1][r.arrayLocation.column - 1]).toBe("[")
    }
  })

  it("traces a useState array-literal initializer", () => {
    const src = `import { useState } from "react"
export default function List() {
  const [rows, setRows] = useState([{ id: 1 }, { id: 2 }])
  return <ul>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>
}
`
    const r = resolveIterationDataJsxSameFile({
      source: src,
      templateLocation: loc(src, "<li key"),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.iterateeRoot).toBe("rows")
      expect(r.keyProperty).toBe("id")
    }
  })

  it("returns positional (null keyProperty) for key={index}", () => {
    const src = `const items = [1, 2, 3]
export const L = () => <ul>{items.map((v, i) => <li key={i}>{v}</li>)}</ul>
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.keyProperty).toBeNull()
  })

  it("refuses when the iteratee isn't a same-file array literal (a prop)", () => {
    const src = `export function L({ items }) {
  return <ul>{items.map((item) => <li key={item.id}>{item.label}</li>)}</ul>
}
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(false)
  })

  it("refuses when the element isn't inside a .map()", () => {
    const src = `export const L = () => <ul><li>x</li></ul>\n`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li>") })
    expect(r.ok).toBe(false)
  })

  it("refuses when a prop shadows a same-named module array (scope guard)", () => {
    // A module `const items = [...]` AND a prop `{ items }` — the rendered rows
    // come from the prop, so the module array must NOT be targeted.
    const src = `const items = [{ id: 1 }]
export function List({ items }: { items: { id: number }[] }) {
  return <ul>{items.map((item) => <li key={item.id}>{item.id}</li>)}</ul>
}
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(false)
  })

  it("ignores a same-name array inside a helper the loop cannot see, and resolves the module-level one (codex round 5)", () => {
    const src = `const items = [{ id: 1 }]
function inner() { const items = [{ id: 2 }]; return items }
export const L = () => <ul>{items.map((item) => <li key={item.id}>{item.id}</li>)}</ul>
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.arrayLocation.line).toBe(1)
  })

  it("refuses when two same-name array bindings are both in scope at the loop (ambiguous)", () => {
    const src = `const items = [{ id: 1 }]
export const L = () => {
  if (Math.random() > 2) { const items = [{ id: 2 }]; console.log(items) }
  return <ul>{items.map((item) => <li key={item.id}>{item.id}</li>)}</ul>
}
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(false)
  })

  it("refuses when no element matches the coord", () => {
    const src = `const items = [1]\nexport const L = () => <ul>{items.map((v) => <li key={v}>{v}</li>)}</ul>\n`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 99, column: 0 } })
    expect(r.ok).toBe(false)
  })

  it("returns an importCandidate when the iteratee is bound by a relative import", () => {
    const src = `import { rows } from "./rows"
export const L = () => <ul>{rows.map((row) => <li key={row.id}>{row.id}</li>)}</ul>
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.importCandidate).toEqual({
      iterateeRoot: "rows",
      itemVar: "row",
      keyProperty: "id",
      binding: { specifier: "./rows", importedName: "rows", via: "import" },
    })
  })

  it("does not surface an importCandidate when a param shadows the import (shadow guard runs first)", () => {
    // Same-named relative import AND a same-named prop — the shadow guard
    // must refuse before ever consulting `findImportBinding`, so the rows
    // rendered here (from the prop) are never confused with the imported
    // module's `rows`.
    const src = `import { rows } from "./rows"
export function List({ rows }: { rows: { id: number }[] }) {
  return <ul>{rows.map((row) => <li key={row.id}>{row.id}</li>)}</ul>
}
`
    const r = resolveIterationDataJsxSameFile({ source: src, templateLocation: loc(src, "<li key") })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.importCandidate).toBeUndefined()
  })
})

/**
 * `Array.prototype.map(callbackFn, thisArg)`. The callback is argument 0; the
 * resolver used to read argument 1 first, which is the `thisArg` for this legal
 * two-argument form. Found by codex review 2026-08-17 — it cost only a
 * positional `keyProperty` before `itemVar` became load-bearing for the
 * `patch-text` lane.
 */
describe("resolveIterationDataJsxSameFile — map(callbackFn, thisArg)", () => {
  it("reads the callback from argument 0, not the thisArg", () => {
    const source = [
      'const items = [{ id: 1, name: "A" }, { id: 2, name: "B" }]',
      "export function List() {",
      "  return (",
      "    <ul>",
      "      {items.map(function (item) { return <li key={item.id}>{item.name}</li> }, this)}",
      "    </ul>",
      "  )",
      "}",
      "",
    ].join("\n")
    const idx = source.indexOf("<li key")
    const before = source.slice(0, idx)
    const result = resolveIterationDataJsxSameFile({
      source,
      templateLocation: {
        line: before.split("\n").length,
        column: idx - (before.lastIndexOf("\n") + 1),
      },
    })
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.itemVar).toBe("item")
    // The same argument mix-up also decided `keyProperty`.
    expect(result.ok === true && result.keyProperty).toBe("id")
  })

  it("reports the list's name for a transformed iteratee it will not edit (`rows.filter(...).map`)", () => {
    const src = 'import { rows } from "./data"\nexport const L = () => <ul>{rows.filter(Boolean).map((r) => <li key={r.id}>{r.name}</li>)}</ul>\n'
    const idx = src.indexOf("<li")
    const result = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 2, column: idx - (src.lastIndexOf("\n", idx) + 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.iterateeRoot).toBe("rows")
    expect(result.importCandidate).toBeUndefined()
  })

  it("gives no list-name hint for a transformed iteratee that is a parameter, even when a same-named import exists (codex round 3)", () => {
    const src = 'import { rows } from "./unrelated"\nexport function List(rows: { id: number }[]) {\n  return <ul>{rows.filter(Boolean).map((r) => <li key={r.id}>{r.id}</li>)}</ul>\n}\n'
    const idx = src.indexOf("<li")
    const result = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 3, column: idx - (src.lastIndexOf("\n", idx) + 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.iterateeRoot).toBeUndefined()
  })

  it("does not follow a module import when a local declaration of the same name exists (codex round 4)", () => {
    const src = 'import { rows } from "./imported"\nexport function List({ supplied }: { supplied: { id: number }[] }) {\n  const rows = supplied\n  return <ul>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>\n}\n'
    const idx = src.indexOf("<li")
    const result = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 4, column: idx - (src.lastIndexOf("\n", idx) + 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate).toBeUndefined()
    expect(result.reason).toMatch(/declared in this file/)
  })

  it("follows the import when the only same-name declaration is a helper's local (codex round 5)", () => {
    const src = 'import { rows } from "./data"\nfunction unrelated() {\n  const rows = makeRows()\n  return rows\n}\nexport const List = () => <ul>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>\n'
    const idx = src.indexOf("<li")
    const result = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 6, column: idx - (src.lastIndexOf("\n", idx) + 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate?.binding.specifier).toBe("./data")
  })

  it("never picks a helper's wrong array over the imported one the loop reads (codex round 5)", () => {
    const src = 'import { rows } from "./data"\nfunction unrelated() {\n  const rows = [{ id: "wrong" }]\n  return rows\n}\nexport const List = () => <ul>{rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>\n'
    const idx = src.indexOf("<li")
    const result = resolveIterationDataJsxSameFile({ source: src, templateLocation: { line: 6, column: idx - (src.lastIndexOf("\n", idx) + 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.importCandidate?.binding.specifier).toBe("./data")
  })
})
