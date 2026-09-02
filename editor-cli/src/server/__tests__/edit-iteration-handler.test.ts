/**
 * Tests for edit-iteration-handler.ts — the CLI HTTP handler for
 * `POST /api/editor/edit-iteration`.
 *
 * Uses real tmp-dir SFC fixtures for the filesystem paths, but stubs
 * the dynamic module imports (resolver + applicator) to avoid pulling
 * in the full Vue compiler chain, keeping tests fast and isolated.
 *
 * Covers: 400 (bad body), 404 (missing file), 400 (path traversal),
 * 400 (non-.vue file), 422 (unresolved), 422 (apply-failed), 200 (ok).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  handleIterationEdit,
  validateIterationBody,
  type IterationEditRequestBody,
} from "../edit-iteration-handler.js"

// ---------------------------------------------------------------------------
// Minimal SFC fixture
// ---------------------------------------------------------------------------

const MINIMAL_VUE = `<template>
  <div v-for="item in items" :key="item.id">{{ item.name }}</div>
</template>
<script setup>
const items = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
</script>`

// ---------------------------------------------------------------------------
// Stub the dynamic imports so we don't need the real Vue compiler
// ---------------------------------------------------------------------------

vi.mock("../../../../src/editor/edit-service/resolve-iteration-data-vue.js", () => ({
  resolveIterationDataVueSameFile: vi.fn(
    (_opts: { source: string; templateLocation: { line: number; column: number } }) => ({
      ok: true,
      file: "src/Foo.vue",
      arrayLocation: { startOffset: 100, endOffset: 200 },
      iterateeRoot: "",
      iterateeChain: [],
      keyProperty: "id",
    }),
  ),
}))

vi.mock(
  "../../../../src/editor/edit-service/resolve-iteration-data-vue-cross-component.js",
  () => ({
    resolveIterationDataVueCrossComponent: vi.fn(() => ({ ok: false, reason: "no cross" })),
  }),
)

vi.mock(
  "../../../../src/editor/edit-service/apply-iteration-data-edit-static.js",
  () => ({
    applyIterationDataEditStatic: vi.fn(
      (_opts: { source: string; file: string; arrayLocation: object; matchers: object[]; operation: object }) => ({
        ok: true,
        source: "patched source",
      }),
    ),
  }),
)

// ---------------------------------------------------------------------------
// Helper: build a valid request body
// ---------------------------------------------------------------------------

function makeBody(overrides: Partial<IterationEditRequestBody> = {}): IterationEditRequestBody {
  return {
    file: "src/Foo.vue",
    templateLocation: { line: 2, column: 3 },
    iterationContext: { key: 1, index: 0, siblingCount: 2 },
    payload: { operation: "remove" },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// validateIterationBody — pure unit tests (no FS needed)
// ---------------------------------------------------------------------------

describe("validateIterationBody", () => {
  it("returns null for a valid body", () => {
    expect(validateIterationBody(makeBody())).toBeNull()
  })

  it("rejects non-object body", () => {
    expect(validateIterationBody("string")).toBe("Body must be an object")
  })

  it("rejects missing file", () => {
    const b = makeBody()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (b as any).file
    expect(validateIterationBody(b)).toMatch(/file required/)
  })

  it("rejects empty file", () => {
    expect(validateIterationBody(makeBody({ file: "" }))).toMatch(/file required/)
  })

  it("rejects missing templateLocation", () => {
    const b = makeBody()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (b as any).templateLocation
    expect(validateIterationBody(b)).toMatch(/templateLocation/)
  })

  it("rejects templateLocation with line < 1", () => {
    expect(
      validateIterationBody(makeBody({ templateLocation: { line: 0, column: 1 } })),
    ).toMatch(/templateLocation/)
  })

  it("rejects missing iterationContext", () => {
    const b = makeBody()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (b as any).iterationContext
    expect(validateIterationBody(b)).toMatch(/iterationContext/)
  })

  it("rejects missing payload", () => {
    const b = makeBody()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (b as any).payload
    expect(validateIterationBody(b)).toMatch(/payload/)
  })

  it("rejects unknown operation", () => {
    expect(
      validateIterationBody(makeBody({ payload: { operation: "explode" } as never })),
    ).toMatch(/operation must be one of/)
  })

  it("accepts all valid operations", () => {
    const ops = ["remove", "patch", "duplicate", "reorder", "insert"] as const
    for (const op of ops) {
      expect(validateIterationBody(makeBody({ payload: { operation: op } as never }))).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// handleIterationEdit — integration with tmp-dir FS
// ---------------------------------------------------------------------------

describe("handleIterationEdit", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-iteration-"))
    // Create nested src/ so body.file = "src/Foo.vue" resolves correctly
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "Foo.vue"), MINIMAL_VUE, "utf8")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it("returns 503 when repoRoot is unreadable", async () => {
    const result = await handleIterationEdit(makeBody(), "/nonexistent/path/xyz")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(503)
    expect(result.ok === false && result.reason).toMatch(/Prototype root unreadable/)
  })

  it("returns 400 when file path escapes root via ..", async () => {
    const result = await handleIterationEdit(
      makeBody({ file: "../escape.vue" }),
      dir,
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(400)
    expect(result.ok === false && result.reason).toMatch(/escapes prototype root/)
  })

  it("returns 400 for an unsupported file extension (.ts)", async () => {
    const result = await handleIterationEdit(makeBody({ file: "src/Foo.ts" }), dir)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(400)
    expect(result.ok === false && result.reason).toMatch(/Only \.vue, \.tsx, and \.jsx/)
  })

  it("returns 404 when file does not exist", async () => {
    const result = await handleIterationEdit(makeBody({ file: "src/Missing.vue" }), dir)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(404)
    expect(result.ok === false && result.reason).toMatch(/Could not read file/)
  })

  it("returns 422 (unresolved) when same-file resolver fails", async () => {
    const { resolveIterationDataVueSameFile } = await import(
      "../../../../src/editor/edit-service/resolve-iteration-data-vue.js"
    )
    vi.mocked(resolveIterationDataVueSameFile).mockReturnValueOnce({
      ok: false,
      reason: "no v-for found at location",
    })

    const result = await handleIterationEdit(makeBody(), dir)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
    expect(result.ok === false && (result as { kind?: string }).kind).toBe("unresolved")
    expect(result.ok === false && result.reason).toMatch(/no v-for found/)
  })

  it("returns 422 (apply-failed) when applicator fails", async () => {
    const { applyIterationDataEditStatic } = await import(
      "../../../../src/editor/edit-service/apply-iteration-data-edit-static.js"
    )
    vi.mocked(applyIterationDataEditStatic).mockReturnValueOnce({
      ok: false,
      reason: "index out of bounds",
    })

    const result = await handleIterationEdit(makeBody(), dir)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(422)
    expect(result.ok === false && (result as { kind?: string }).kind).toBe("apply-failed")
    expect(result.ok === false && result.reason).toMatch(/index out of bounds/)
  })

  it("returns 200 with proposal on success", async () => {
    const result = await handleIterationEdit(makeBody(), dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(200)
    expect(result.proposal.newSource).toBe("patched source")
    expect(result.proposal.file).toBe("src/Foo.vue")
    expect(typeof result.proposal.baseHash).toBe("string")
    expect(result.proposal.baseHash).toHaveLength(64) // sha256 hex
    expect(typeof result.proposalId).toBe("string")
    expect(result.proposalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it("includes operation name in explanation", async () => {
    const result = await handleIterationEdit(makeBody(), dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.explanation).toMatch(/remove/)
  })

  // Cross-component fallback (web route lines 169-223). Triggers when:
  //   1. Same-file resolver returns ok:false, AND
  //   2. `pageSourceFile` is set AND differs from `file`, AND
  //   3. The page source file passes the same path-traversal + .vue
  //      guards as `file`, AND
  //   4. Cross-component resolver returns ok:true.
  describe("cross-component pageSourceFile fallback", () => {
    beforeEach(async () => {
      // Same-file resolver fails — forces the handler into the
      // cross-component branch.
      const { resolveIterationDataVueSameFile } = await import(
        "../../../../src/editor/edit-service/resolve-iteration-data-vue.js"
      )
      vi.mocked(resolveIterationDataVueSameFile).mockReturnValue({
        ok: false,
        reason: "same-file miss — falling through to cross",
      })

      // The page SFC exists on disk so the realpath / fs.readFile in
      // the handler succeed.
      writeFileSync(
        join(dir, "src", "Page.vue"),
        `<template><Foo :items="rows" /></template>
<script setup>
const rows = [{ id: 1 }, { id: 2 }]
</script>`,
        "utf8",
      )
    })

    it("returns 200 with proposal.file = pageSourceFile when cross resolves", async () => {
      const { resolveIterationDataVueCrossComponent } = await import(
        "../../../../src/editor/edit-service/resolve-iteration-data-vue-cross-component.js"
      )
      vi.mocked(resolveIterationDataVueCrossComponent).mockReturnValueOnce({
        ok: true,
        file: "src/Page.vue",
        arrayLocation: { startOffset: 50, endOffset: 100 },
        keyProperty: "id",
      } as unknown as ReturnType<typeof resolveIterationDataVueCrossComponent>)

      const result = await handleIterationEdit(
        makeBody({ pageSourceFile: "src/Page.vue" }),
        dir,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.proposal.file).toBe("src/Page.vue")
      expect(result.status).toBe(200)
    })

    it("ignores pageSourceFile that escapes root and falls through to 422", async () => {
      const result = await handleIterationEdit(
        makeBody({ pageSourceFile: "../escape.vue" }),
        dir,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.status).toBe(422)
      // 422 from the same-file resolver — the bad pageSourceFile was
      // skipped silently, the cross-component lane never fired.
      expect(result.ok === false && (result as { kind?: string }).kind).toBe("unresolved")
    })

    it("ignores non-.vue pageSourceFile and falls through to 422", async () => {
      writeFileSync(join(dir, "src", "Page.ts"), "// not a vue file", "utf8")
      const result = await handleIterationEdit(
        makeBody({ pageSourceFile: "src/Page.ts" }),
        dir,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.status).toBe(422)
      expect(result.ok === false && (result as { kind?: string }).kind).toBe("unresolved")
    })

    it("skips cross-component lane when pageSourceFile equals file (no self-fallback)", async () => {
      const { resolveIterationDataVueCrossComponent } = await import(
        "../../../../src/editor/edit-service/resolve-iteration-data-vue-cross-component.js"
      )
      const crossMock = vi.mocked(resolveIterationDataVueCrossComponent)
      crossMock.mockClear()

      const result = await handleIterationEdit(
        makeBody({ pageSourceFile: "src/Foo.vue" }),
        dir,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.status).toBe(422)
      // The handler short-circuits when pageSourceFile === file —
      // cross-component resolver must not be invoked.
      expect(crossMock).not.toHaveBeenCalled()
    })
  })
})
