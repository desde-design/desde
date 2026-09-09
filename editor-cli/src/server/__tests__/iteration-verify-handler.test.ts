import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
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

  it("parses by the realpath target's extension, not the name the client sent", async () => {
    // `src/Alias.vue` is a symlink to a TSX file. Parsing by `body.file` would
    // hand `.vue` bytes that are JSX to the SFC compiler and find no loop.
    write("src/List.tsx", LIST_TSX)
    symlinkSync(join(dir, "src/List.tsx"), join(dir, "src/Alias.vue"))
    const r = await handleIterationVerify(
      { file: "src/Alias.vue", templateLocation: babelLoc(LIST_TSX, "<li key") },
      dir,
    )
    expect(r).toEqual({ ok: true, status: 200, loop: { kind: "map", expression: "items.map" } })
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

  it("refuses an unsupported extension BEFORE touching the filesystem", async () => {
    // The path does not exist AND has the wrong extension. A 400 (not the
    // 404 a missing supported file gets) is what proves the extension gate
    // runs first: reading the bytes first would have made this route an
    // existence oracle, and would have pulled a `.env` into memory.
    writeFileSync(join(dir, ".env"), "SECRET=1", "utf8")
    for (const file of [".env", "src/Nope.env", "src/does-not-exist.env"]) {
      const r = await handleIterationVerify({ file, templateLocation: { line: 1, column: 0 } }, dir)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(400)
        expect(r.reason).toBe("Only .vue, .tsx, and .jsx files are supported")
      }
    }
  })

  it("gives an existing and a missing unsupported path the same answer", async () => {
    writeFileSync(join(dir, "present.env"), "SECRET=1", "utf8")
    const present = await handleIterationVerify({ file: "present.env", templateLocation: { line: 1, column: 0 } }, dir)
    const absent = await handleIterationVerify({ file: "absent.env", templateLocation: { line: 1, column: 0 } }, dir)
    expect(present).toEqual(absent)
  })

  it("validates the body shape", () => {
    expect(validateIterationVerifyBody(null)).toBe("Body must be an object")
    expect(validateIterationVerifyBody({ file: "" })).toBe("body.file required")
    expect(validateIterationVerifyBody({ file: "a.tsx" })).toMatch(/templateLocation/)
    expect(validateIterationVerifyBody({ file: "a.tsx", templateLocation: { line: 0, column: 0 } })).toMatch(/templateLocation/)
    expect(validateIterationVerifyBody({ file: "a.tsx", templateLocation: { line: 1, column: 0 } })).toBeNull()
  })

  it("rejects NaN, Infinity and fractional positions", () => {
    for (const templateLocation of [
      { line: Number.NaN, column: 0 },
      { line: 1, column: Number.NaN },
      { line: Number.POSITIVE_INFINITY, column: 0 },
      { line: 1.5, column: 0 },
      { line: 1, column: 2.5 },
      { line: 1, column: "0" },
    ]) {
      expect(validateIterationVerifyBody({ file: "a.tsx", templateLocation })).toMatch(/templateLocation/)
    }
  })
})
