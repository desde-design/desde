/**
 * React/JSX coverage for edit-iteration-handler.ts. Unlike the Vue test (which
 * stubs the compiler chain), this drives the REAL JSX resolver + static
 * applicator end-to-end against a tmp .tsx fixture — they're framework-neutral
 * pure modules, so a real round-trip is cheap and proves the wiring.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  handleIterationEdit,
  type IterationEditRequestBody,
} from "../edit-iteration-handler.js"

const APP_TSX = `const items = [{ id: 1, name: "A" }, { id: 2, name: "B" }]
export default function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.name}</li>)}
    </ul>
  )
}
`

function babelLoc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") + 1) }
}

describe("edit-iteration-handler — React/JSX", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-iter-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(file = "src/List.tsx"): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")
    return file
  }

  it("removes a row from a .tsx array literal via the JSX resolver + applicator", async () => {
    const file = write()
    const tl = babelLoc(APP_TSX, "<li key")
    const body: IterationEditRequestBody = {
      file,
      templateLocation: tl,
      iterationContext: { key: 1, index: 0, siblingCount: 2 },
      payload: { operation: "remove" },
    }
    const result = await handleIterationEdit(body, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Row with id:1 / name:"A" is gone; id:2 / "B" remains.
      expect(result.proposal.newSource).not.toContain('name: "A"')
      expect(result.proposal.newSource).toContain('name: "B"')
    }
  })

  it("matches a numeric id even when React stringifies the key", async () => {
    // React exposes `key={item.id}` as the STRING "1"; the array stores id: 1
    // (NumericLiteral). The rewriter's string-coerced match handles this.
    const file = write()
    const tl = babelLoc(APP_TSX, "<li key")
    const body: IterationEditRequestBody = {
      file,
      templateLocation: tl,
      iterationContext: { key: "1", index: 0, siblingCount: 2 }, // string, as React gives it
      payload: { operation: "remove" },
    }
    const result = await handleIterationEdit(body, dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.newSource).not.toContain('name: "A"')
      expect(result.proposal.newSource).toContain('name: "B"')
    }
  })

  it("422s when the iteratee can't be traced to a same-file array (a prop)", async () => {
    const file = "src/Propped.tsx"
    const src = `export function L({ items }: { items: { id: number }[] }) {
  return <ul>{items.map((item) => <li key={item.id}>{item.id}</li>)}</ul>
}
`
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), src, "utf8")
    const body: IterationEditRequestBody = {
      file,
      templateLocation: babelLoc(src, "<li key"),
      iterationContext: { key: 1, index: 0, siblingCount: 1 },
      payload: { operation: "remove" },
    }
    const result = await handleIterationEdit(body, dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(422)
  })
})

/**
 * The `patch-text` lane — "this row" for a TEXT edit.
 *
 * The client sends the new string only. It cannot name the property, because
 * that answer is in the source; the server derives it with the interpolation
 * extractor. These pin the two halves that a unit test can see, and the one
 * that already went wrong live: the extractor must be handed the LOOP VARIABLE
 * (`item`), not `iterateeRoot` (`items`, the ARRAY). Passing the array made
 * every well-formed row refuse with a message that read like a user error.
 */
describe("edit-iteration-handler — patch-text (this row, for text)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-patchtext-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeSource(src: string, file = "src/List.tsx"): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), src, "utf8")
    return file
  }

  it("patches only the matched row's property", async () => {
    const file = writeSource(APP_TSX)
    const body: IterationEditRequestBody = {
      file,
      templateLocation: babelLoc(APP_TSX, "<li key"),
      iterationContext: { key: "2", index: 1, siblingCount: 2 },
      payload: { operation: "patch-text", value: "PATCHED" },
    }
    const res = await handleIterationEdit(body, dir)
    expect(res.ok).toBe(true)
    const out = (res as { proposal: { newSource: string } }).proposal.newSource
    expect(out).toContain('{ id: 2, name: "PATCHED" }')
    // The sibling row is the whole point of "this row".
    expect(out).toContain('{ id: 1, name: "A" }')
  })

  it("refuses a row that is a bare string — no property to patch", async () => {
    const src = `const items = ["A", "B"]
export default function List() {
  return (
    <ul>
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  )
}
`
    const file = writeSource(src)
    const res = await handleIterationEdit(
      {
        file,
        templateLocation: babelLoc(src, "<li key"),
        iterationContext: { key: "B", index: 1, siblingCount: 2 },
        payload: { operation: "patch-text", value: "NOPE" },
      },
      dir,
    )
    expect(res.ok).toBe(false)
    expect((res as { reason: string }).reason).toMatch(/entry itself/)
    // 422 is what the client reads as "offer the LLM lane".
    expect((res as { status: number }).status).toBe(422)
  })

  it("refuses when the text sits inside a wrapper element", async () => {
    const src = `const items = [{ id: 1, name: "A" }, { id: 2, name: "B" }]
export default function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}><span>{item.name}</span></li>)}
    </ul>
  )
}
`
    const file = writeSource(src)
    const res = await handleIterationEdit(
      {
        file,
        templateLocation: babelLoc(src, "<li key"),
        iterationContext: { key: "2", index: 1, siblingCount: 2 },
        payload: { operation: "patch-text", value: "NOPE" },
      },
      dir,
    )
    expect(res.ok).toBe(false)
    expect((res as { reason: string }).reason).toMatch(/child element/)
  })
})

/**
 * A POSITIONAL key must not be matched against the `:key` property.
 *
 * `iterationContext.key` is only the framework's key when the bridge could walk
 * to a component instance for the row; a loop over NATIVE elements leaves it as
 * the positional index. Matching that against `keyProperty` selects the wrong
 * entry whenever ids do not coincide with positions — MEASURED live 2026-08-17,
 * where retyping row 2 of `[{id:1},{id:2},{id:3}]` rewrote row 1.
 *
 * Pre-existing: delete / prop / move share this matcher. Invisible to every
 * other test in this file because they each hand in a key they chose.
 */
describe("edit-iteration-handler — positional key vs :key property", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-poskey-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // ids deliberately 1-based while indices are 0-based, so a positional key
  // read as an id lands exactly one row early.
  const SRC = `const items = [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }]
export default function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.name}</li>)}
    </ul>
  )
}
`

  it("patches the row the designer pointed at, not the one whose id equals the index", async () => {
    mkdirSync(dirname(join(dir, "src/List.tsx")), { recursive: true })
    writeFileSync(join(dir, "src/List.tsx"), SRC, "utf8")
    const res = await handleIterationEdit(
      {
        file: "src/List.tsx",
        templateLocation: babelLoc(SRC, "<li key"),
        // What the bridge really sends for a native-element loop: key === index.
        iterationContext: { key: 1, index: 1, siblingCount: 3 },
        payload: { operation: "patch-text", value: "SECOND" },
      },
      dir,
    )
    expect(res.ok).toBe(true)
    const out = (res as { proposal: { newSource: string } }).proposal.newSource
    expect(out).toContain('{ id: 2, name: "SECOND" }')
    expect(out).toContain('{ id: 1, name: "A" }')
  })

  it("still uses :key matching when the key is genuinely NOT positional", async () => {
    mkdirSync(dirname(join(dir, "src/List.tsx")), { recursive: true })
    writeFileSync(join(dir, "src/List.tsx"), SRC, "utf8")
    const res = await handleIterationEdit(
      {
        file: "src/List.tsx",
        templateLocation: babelLoc(SRC, "<li key"),
        // key 3 at index 1 could only come from a real framework key.
        iterationContext: { key: "3", index: 1, siblingCount: 3 },
        payload: { operation: "patch-text", value: "THIRD" },
      },
      dir,
    )
    expect(res.ok).toBe(true)
    const out = (res as { proposal: { newSource: string } }).proposal.newSource
    expect(out).toContain('{ id: 3, name: "THIRD" }')
    expect(out).toContain('{ id: 2, name: "B" }')
  })
})

/**
 * Codex round 2, P1. A key equal to its index is indistinguishable from the
 * positional seed, so positional matching is only safe when nothing was
 * filtered out. When the rendered count and the source count disagree the row
 * cannot be mapped either way — refuse rather than rewrite a hidden entry.
 */
describe("edit-iteration-handler — filtered loops refuse instead of guessing", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-filtered-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // 3 source entries, 2 rendered. The first VISIBLE row is `{id:0}`, but it
  // sits at source index 1 — positional matching would hit the hidden `{id:99}`.
  // NOT `items.filter(...).map(...)` — codex's original example. That shape is
  // already refused one layer up ("the `.map()` iteratee isn't a simple
  // identifier chain"), so it could never reach the matcher. The reachable
  // version keeps a plain iteratee and drops rows INSIDE the callback.
  const SRC = `const items = [{ id: 99, show: false, name: "HIDDEN" }, { id: 0, show: true, name: "A" }, { id: 1, show: true, name: "B" }]
export default function List() {
  return (
    <ul>
      {items.map((item) => item.show ? <li key={item.id}>{item.name}</li> : null)}
    </ul>
  )
}
`

  it("refuses when rendered siblings and source entries disagree", async () => {
    mkdirSync(dirname(join(dir, "src/List.tsx")), { recursive: true })
    writeFileSync(join(dir, "src/List.tsx"), SRC, "utf8")
    const res = await handleIterationEdit(
      {
        file: "src/List.tsx",
        templateLocation: babelLoc(SRC, "<li key"),
        // First visible row: positional key, and only 2 of 3 entries render.
        iterationContext: { key: 0, index: 0, siblingCount: 2 },
        payload: { operation: "patch-text", value: "NOPE" },
      },
      dir,
    )
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(422)
    expect((res as { reason: string }).reason).toMatch(/renders 2 of 3 entries/)
  })
})
