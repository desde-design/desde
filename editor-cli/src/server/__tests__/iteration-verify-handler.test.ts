import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  handleIterationVerify,
  validateIterationVerifyBody,
} from "../iteration-verify-handler.js"

const LIST_TSX = `const items = [{ id: 1 }, { id: 2 }]
export function List() {
  return (
    <ul>
      {items.map((item) => <li key={item.id}>{item.id}</li>)}
    </ul>
  )
}
`

const CARD_TSX = `export function CardAction(props: { children?: unknown }) {
  return <div data-slot="card-action" {...props} />
}
`

function babelLoc(src: string, marker: string): { line: number; column: number } {
  const idx = src.indexOf(marker)
  const before = src.slice(0, idx)
  return { line: before.split("\n").length, column: idx - (before.lastIndexOf("\n") + 1) }
}

describe("iteration-verify-handler", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-iter-verify-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function write(file: string, contents: string): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), contents, "utf8")
    return file
  }

  it("answers loop: {...} for an element inside .map()", async () => {
    const file = write("src/List.tsx", LIST_TSX)
    const r = await handleIterationVerify({ file, templateLocation: babelLoc(LIST_TSX, "<li key") }, dir)
    expect(r).toEqual({ ok: true, status: 200, loop: { kind: "map", expression: "items.map" } })
  })

  it("answers loop: null, with the reason, for a component's own root", async () => {
    const file = write("src/components/ui/card.tsx", CARD_TSX)
    const r = await handleIterationVerify({ file, templateLocation: babelLoc(CARD_TSX, "<div data-slot") }, dir)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.loop).toBeNull()
      expect(r.reason).toMatch(/not rendered by a `.map\(\)`/)
    }
  })

  it("refuses a path outside the prototype root", async () => {
    write("src/List.tsx", LIST_TSX)
    const r = await handleIterationVerify({ file: "../outside.tsx", templateLocation: { line: 1, column: 0 } }, dir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it("refuses library source", async () => {
    const file = write("node_modules/lib/List.tsx", LIST_TSX)
    const r = await handleIterationVerify({ file, templateLocation: { line: 1, column: 0 } }, dir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/installed library/)
  })

  it("404s a missing file", async () => {
    const r = await handleIterationVerify({ file: "src/Missing.tsx", templateLocation: { line: 1, column: 0 } }, dir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(404)
  })

  it("validates the body shape", () => {
    expect(validateIterationVerifyBody(null)).toBe("Body must be an object")
    expect(validateIterationVerifyBody({ file: "" })).toBe("body.file required")
    expect(validateIterationVerifyBody({ file: "a.tsx" })).toMatch(/templateLocation/)
    expect(validateIterationVerifyBody({ file: "a.tsx", templateLocation: { line: 0, column: 0 } })).toMatch(/templateLocation/)
    expect(validateIterationVerifyBody({ file: "a.tsx", templateLocation: { line: 1, column: 0 } })).toBeNull()
  })
})
