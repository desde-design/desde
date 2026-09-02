/**
 * CLI handler coverage for the React/JSX flatten-conditional lane: a
 * `kind: "flatten-conditional"` edit against a .tsx is admitted by the
 * JSX-capable gate and dispatched to applyJsxFlattenConditionalEdit.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

const LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({
    applyPropEdit: vi.fn().mockReturnValue({ ok: false, reason: "stub" }),
  }),
  loadApplyMoveEdit: async () => ({
    applyMoveEdit: vi.fn().mockReturnValue({ ok: false, reason: "stub" }),
  }),
  loadApplyDetachEdit: async () => ({
    applyDetachEdit: vi.fn().mockReturnValue({ ok: false, reason: "stub" }),
  }),
  // Vue applicator present so a .vue would dispatch (not loader-miss).
  loadApplyFlattenConditionalEdit: async () => ({
    applyFlattenConditionalEdit: vi.fn().mockReturnValue({ ok: false, reason: "stub" }),
  }),
  loadApplyJsxFlattenConditionalEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-flatten-conditional-edit"),
}

const APP_TSX = `export default function App() {
  return (
    <div>
      {on ? <Yes>A</Yes> : <No>B</No>}
    </div>
  )
}
`
// <Yes> opening tag: line 4, column 12.

describe("edit-handler — JSX flatten-conditional lane", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-flatten-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("flattens a .tsx ternary, keeping the clicked branch", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "flatten-conditional", file, line: 4, column: 12, branchToKeep: 0 },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain("<Yes>A</Yes>")
    expect(patched).not.toContain("<No>")
    expect(patched).not.toContain("on ?")
  })
})
