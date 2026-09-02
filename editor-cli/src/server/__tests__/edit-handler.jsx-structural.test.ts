/**
 * CLI handler coverage for the React/JSX structural-edit lanes (move / delete /
 * insert): each `kind` against a `.tsx` file is admitted by the extension gate
 * and dispatched to its JSX applicator, patching the real source. Mirrors the
 * JSX prop-lane handler test but wires the REAL JSX structural applicators so
 * the gate→dispatch→applicator→fs-write path is exercised end-to-end.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

// Real JSX structural applicators; Vue applicators are stubs (never reached).
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
  loadApplyJsxMoveEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-move-edit"),
  loadApplyJsxDeleteEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-delete-edit"),
  loadApplyJsxInsertEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-insert-edit"),
}

const APP_TSX = `export default function App() {
  return (
    <ul>
      <li>A</li>
      <li>B</li>
    </ul>
  )
}
`
//   1 export default function App() {
//   2   return (
//   3     <ul>          (col 4)
//   4       <li>A</li>  (col 6)
//   5       <li>B</li>  (col 6)
//   6     </ul>
//   7   )
//   8 }

describe("edit-handler — JSX structural lanes", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-struct-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(file: string, contents: string): void {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), contents, "utf8")
  }

  it("reorders a child via the move lane", async () => {
    const file = "src/App.tsx"
    write(file, APP_TSX)
    const body: EditRequestBody = {
      edit: {
        kind: "move",
        file,
        line: 4,
        column: 6,
        destFile: file,
        destParentLine: 3,
        destParentColumn: 4,
        destIndex: -1,
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched.indexOf(">A<")).toBeGreaterThan(patched.indexOf(">B<"))
  })

  it("removes a child via the delete lane", async () => {
    const file = "src/App.tsx"
    write(file, APP_TSX)
    const body: EditRequestBody = {
      edit: { kind: "delete", file, line: 5, column: 6 },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).not.toContain(">B<")
    expect(patched).toContain(">A<")
  })

  it("inserts a child via the insert lane", async () => {
    const file = "src/App.tsx"
    write(file, APP_TSX)
    const body: EditRequestBody = {
      edit: {
        kind: "insert",
        file,
        line: 3,
        column: 4,
        destIndex: -1,
        snippet: "<li>C</li>",
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain(">C<")
    expect(patched.indexOf(">C<")).toBeGreaterThan(patched.indexOf(">B<"))
  })

  it("refuses deleting the returned root (422)", async () => {
    const file = "src/App.tsx"
    write(file, APP_TSX)
    const body: EditRequestBody = {
      // <ul> is the returned root.
      edit: { kind: "delete", file, line: 3, column: 4 },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
  })

  it("admits .jsx files on a structural lane", async () => {
    const file = "src/App.jsx"
    write(file, APP_TSX)
    const body: EditRequestBody = {
      edit: { kind: "delete", file, line: 5, column: 6 },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
  })
})
