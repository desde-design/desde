/**
 * React/JSX coverage for the conditional-text vertical:
 *  - getTextBranches (the detection endpoint) returns branches for a .tsx file
 *    via the JSX detector, and refuses unsupported extensions.
 *  - applyEdit dispatches a `text-branch` edit on a .tsx through
 *    applyJsxTextBranchEdit, splicing the chosen branch.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTextBranches } from "../text-branches-handler.js"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

const APP_TSX = `export default function App() {
  return (
    <span>{enabled ? "On" : "Off"}</span>
  )
}
`
// <span> opening tag: line 3, indented 4 → column 4.

describe("text-branches — React/JSX", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-tb-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeApp(file = "src/App.tsx"): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")
    return file
  }

  it("detects JSX conditional-text branches via getTextBranches", async () => {
    const file = writeApp()
    const r = await getTextBranches({ file, line: 3, column: 4 }, dir)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.testExpression).toBe("enabled")
      expect(r.branches[0]).toMatchObject({ kind: "consequent", value: "On" })
      expect(r.branches[1]).toMatchObject({ kind: "alternate", value: "Off" })
    }
  })

  it("refuses an unsupported extension", async () => {
    const file = "src/notes.md"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "# hi\n", "utf8")
    const r = await getTextBranches({ file, line: 1, column: 0 }, dir)
    expect(r.ok).toBe(false)
  })

  it("applies a JSX text-branch edit through applyEdit", async () => {
    const file = writeApp()
    // Detect to get real byte ranges, then edit the consequent branch.
    const det = await getTextBranches({ file, line: 3, column: 4 }, dir)
    expect(det.ok).toBe(true)
    if (!det.ok) return
    const b = det.branches[0]

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
      loadApplyJsxTextBranchEdit: () =>
        import("../../../../src/editor/edit-service/apply-jsx-text-branch-edit"),
    }
    const body: EditRequestBody = {
      edit: {
        kind: "text-branch",
        file,
        byteStart: b.byteStart,
        byteEnd: b.byteEnd,
        valueKind: b.valueKind,
        newValue: "Enabled",
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain('{enabled ? "Enabled" : "Off"}')
  })
})
