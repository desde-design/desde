/**
 * CLI handler coverage for the React/JSX prop-edit lane (M2): a `kind: "prop"`
 * edit against a `.tsx` file is admitted by the extension gate and dispatched
 * to applyJsxPropEdit, patching the real source. Mirrors the Vue existing-file
 * handler tests but wires the REAL JSX applicator so it's end-to-end.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

// Real JSX applicator; the others are stubs (never reached on this lane).
const LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({
    applyPropEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyJsxPropEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-prop-edit"),
  loadApplyMoveEdit: async () => ({
    applyMoveEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyDetachEdit: async () => ({
    applyDetachEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
}

const APP_TSX = `import { useState } from "react"

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="app">
      <button className="cta" onClick={() => setCount((c) => c + 1)}>
        Clicked {count} times
      </button>
    </div>
  )
}
`
// <button> opening tag is line 7, indented 6 → column 6.

describe("edit-handler — JSX prop lane", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-prop-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("applies a prop edit to an existing .tsx via applyJsxPropEdit", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "prop", file, line: 7, column: 6, propName: "className", value: "cta-active" },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe(200)

    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain('<button className="cta-active" onClick=')
    // The bound onClick is left intact.
    expect(patched).toContain("onClick={() => setCount((c) => c + 1)}")
  })

  it("inserts a new attribute on a .tsx element", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "prop", file, line: 7, column: 6, propName: "type", value: "button" },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, file), "utf8")).toContain('<button type="button" className="cta"')
  })

  it("refuses (no-op) when the prop value is unchanged", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "prop", file, line: 7, column: 6, propName: "className", value: "cta" },
    }
    const result = await applyEdit(body, dir, LOADERS)
    // No-op write guard rejects an unchanged result rather than reporting ok.
    expect(result.ok).toBe(false)
  })
})
