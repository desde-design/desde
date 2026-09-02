/**
 * CLI handler coverage for the React/JSX unwrap lane: a `kind: "unwrap"` edit
 * against a `.tsx` file is admitted by the JSX-capable gate and dispatched to
 * applyJsxUnwrapEdit, hoisting the wrapper's children into source.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

const LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({
    applyPropEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyMoveEdit: async () => ({
    applyMoveEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyDetachEdit: async () => ({
    applyDetachEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  // Vue unwrap present so a .vue would dispatch (not loader-miss); the JSX path
  // is the one under test.
  loadApplyUnwrapEdit: async () => ({
    applyUnwrapEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyJsxUnwrapEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-unwrap-edit"),
}

const APP_TSX = `export default function App() {
  return (
    <section>
      <div className="wrap">
        <span>a</span>
      </div>
    </section>
  )
}
`
// <div className="wrap"> opening tag: line 4, indented 6 → column 6.

describe("edit-handler — JSX unwrap lane", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-unwrap-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("unwraps a .tsx wrapper via applyJsxUnwrapEdit", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "unwrap", file, line: 4, column: 6 },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain("<span>a</span>")
    expect(patched).not.toContain('className="wrap"')
  })
})
