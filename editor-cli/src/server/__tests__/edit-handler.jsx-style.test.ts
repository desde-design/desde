/**
 * CLI handler coverage for the React/JSX inline-style lane (`kind: "jsx-style"`):
 * a styling edit against a `.tsx` file is admitted by the JSX-only extension
 * gate and dispatched to applyJsxStyleEdit, patching real source. Covers both
 * modes (classname splice + inline style object) and the .vue refusal (the lane
 * is React-only — Vue inline styling is the scoped-css-override lane).
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
  loadApplyJsxStyleEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-style-edit"),
  // Vue scoped-css-override applicator — present so a .vue jsx-style attempt is
  // refused by the GATE, not for lack of a loader.
  loadApplyScopedCssOverrideEdit: async () => ({
    applyScopedCssOverrideEdit: vi
      .fn()
      .mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
}

const APP_TSX = `export default function App() {
  return (
    <div className="app">
      <button className="border-b-2 px-4">Save</button>
    </div>
  )
}
`
// <button> opening tag is line 4, indented 6 → column 6.

describe("edit-handler — JSX inline-style lane", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-style-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeApp(file = "src/App.tsx"): string {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), APP_TSX, "utf8")
    return file
  }

  it("classname mode: merges a Tailwind utility into className", async () => {
    const file = writeApp()
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 4,
        column: 6,
        mode: "classname",
        addClasses: ["rounded-md"],
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe(200)
    expect(readFileSync(join(dir, file), "utf8")).toContain(
      'className="border-b-2 px-4 rounded-md"',
    )
  })

  it("classname mode: tailwind-merge replaces a conflicting utility", async () => {
    const file = writeApp()
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 4,
        column: 6,
        mode: "classname",
        addClasses: ["border-b-4"],
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, file), "utf8")
    expect(patched).toContain("border-b-4")
    expect(patched).not.toContain("border-b-2")
  })

  it("inline mode: creates a style object (kebab→camel)", async () => {
    const file = writeApp()
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 4,
        column: 6,
        mode: "inline",
        declarations: { "border-bottom-width": "3px" },
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, file), "utf8")).toContain(
      'borderBottomWidth: "3px"',
    )
  })

  it("refuses a .vue file (jsx-style is React-only)", async () => {
    const file = "src/App.vue"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "<template><div/></template>\n", "utf8")
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 1,
        column: 0,
        mode: "classname",
        addClasses: ["px-2"],
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  it("surfaces an actionable refusal for a bound className ({cn(...)})", async () => {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(
      join(dir, file),
      `export const A = (p) => <div className={cn("row", p.x)}>x</div>\n`,
      "utf8",
    )
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 1,
        column: 24,
        mode: "classname",
        addClasses: ["px-2"],
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toContain("via chat")
    }
  })

  it("refuses a no-op (class already present)", async () => {
    const file = writeApp()
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 4,
        column: 6,
        mode: "classname",
        addClasses: ["px-4"],
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
  })
})

/**
 * Audit Task 23 — jsx-style refusals now carry a TYPED fallback hint
 * (`JsxStyleFallbackHint`, `lane: "jsx-style"`), and the dispatcher routes on
 * that hint instead of inferring the lane from `body.edit.kind` and appending a
 * hardcoded reason-string suffix.
 *
 * These pin the routing itself, using stub applicators so the presence/absence
 * of the hint is the ONLY variable — the same kind, the same file, the same
 * request, two different refusal shapes.
 */
describe("edit-handler — jsx-style refusal routes on the typed hint", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-jsx-hint-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const CHAT_SUFFIX = "The class/style is dynamically composed, so adjust it via chat."

  function loadersReturning(
    result: unknown,
  ): ApplicatorLoaders {
    return {
      ...LOADERS,
      loadApplyJsxStyleEdit: async () =>
        ({ applyJsxStyleEdit: () => result }) as unknown as typeof import("../../../../src/editor/edit-service/apply-jsx-style-edit"),
    }
  }

  function styleBody(file: string): EditRequestBody {
    return {
      edit: {
        kind: "jsx-style",
        file,
        line: 1,
        column: 0,
        mode: "classname",
        addClasses: ["px-2"],
      },
    } as EditRequestBody
  }

  function writeTsx(): string {
    const file = "src/App.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "export const A = () => <div>x</div>\n", "utf8")
    return file
  }

  it("appends the chat guidance when the refusal carries a jsx-style hint", async () => {
    const file = writeTsx()
    const loaders = loadersReturning({
      ok: false,
      reason: "className is bound to an expression.",
      fallback: {
        lane: "jsx-style",
        kind: "bound-binding",
        attribute: "className",
        expression: 'cn("row")',
      },
    })
    const result = await applyEdit(styleBody(file), dir, loaders)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toBe(`className is bound to an expression. ${CHAT_SUFFIX}`)
    }
  })

  it("routes a dynamic-vbind (spread) hint the same way", async () => {
    const file = writeTsx()
    const loaders = loadersReturning({
      ok: false,
      reason: "Element has a {...spread}.",
      fallback: { lane: "jsx-style", kind: "dynamic-vbind", attribute: "style" },
    })
    const result = await applyEdit(styleBody(file), dir, loaders)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(CHAT_SUFFIX)
  })

  it("does NOT append the guidance to a hintless jsx-style refusal", async () => {
    // Same kind, same lane — but a plain refusal (unsafe class name, no
    // element at the coordinates, …) has no dynamic composition to explain.
    // This pins PRE-EXISTING behavior, not a fix: the arm keyed off
    // `body.edit.kind` before the typed hint, but it ALSO required a truthy
    // `result.fallback`, so a hintless refusal already fell through to the
    // plain 422. Regression cover for the routing rewrite.
    const file = writeTsx()
    const loaders = loadersReturning({
      ok: false,
      reason: 'Unsafe class name "px-2;color:red".',
    })
    const result = await applyEdit(styleBody(file), dir, loaders)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toBe('Unsafe class name "px-2;color:red".')
      expect(result.reason).not.toContain(CHAT_SUFFIX)
    }
  })

  it("the real applicator emits the typed hint the dispatcher routes on", async () => {
    // End-to-end through the REAL applicator: bound className → hint → suffix.
    const file = "src/Bound.tsx"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(
      join(dir, file),
      `export const A = (p) => <div className={cn("row", p.x)}>x</div>\n`,
      "utf8",
    )
    const body: EditRequestBody = {
      edit: {
        kind: "jsx-style",
        file,
        line: 1,
        column: 24,
        mode: "classname",
        addClasses: ["px-2"],
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(CHAT_SUFFIX)
  })
})
