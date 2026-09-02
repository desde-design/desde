/**
 * CLI handler tests for the `scoped-css-override` lane once it can write a
 * project stylesheet — the change that gives React the restyle-inside-a-
 * component-you-do-not-own capability (`tasks/dev-server-hosts.md` § 9g).
 *
 * Two things make this security-sensitive and both are pinned here:
 *
 *  1. The lane now admits a SECOND extension. Before this, `.css` was reachable
 *     by exactly one kind (`token-value`) and its `node_modules` refusal was
 *     written for that kind alone. A widened lane with an unwidened refusal
 *     would let a style override be written into a library stylesheet — a
 *     broken promise ("Editor never modifies library source") that the next
 *     `npm install` silently reverts.
 *  2. The ANCHOR and the DESTINATION are now separate wire fields. `file` is
 *     still the only path the handler resolves, so every traversal/symlink
 *     guard applies to it unchanged; the anchor is a free string that lands
 *     inside `[data-desde-src="…"]` and must not be able to break out of it.
 */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

const unused = vi.fn().mockReturnValue({ ok: false, reason: "unused stub" })
const LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({ applyPropEdit: unused }),
  loadApplyMoveEdit: async () => ({ applyMoveEdit: unused }),
  loadApplyDetachEdit: async () => ({ applyDetachEdit: unused }),
  loadApplyScopedCssOverrideEdit: () =>
    import("../../../../src/editor/edit-service/apply-scoped-css-override-edit.js"),
}

const APP_CSS = `:root {\n  --brand: #09f;\n}\n\n.card {\n  padding: 8px;\n}\n`

function overrideEdit(over: Partial<Record<string, unknown>> = {}): EditRequestBody {
  return {
    edit: {
      kind: "scoped-css-override",
      // DESTINATION — the only path the handler resolves.
      file: "src/index.css",
      line: 1,
      column: 1,
      // ANCHOR — what the rule head names, read off the rendered DOM.
      anchorFile: "src/App.tsx",
      anchorLine: 33,
      anchorColumn: 46,
      declarations: { "padding-left": "41px" },
      ...over,
    } as EditRequestBody["edit"],
  }
}

describe("edit-handler — scoped-css-override into a project stylesheet", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-scoped-css-"))
    mkdirSync(join(dir, "src"), { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes the rule into the .css, anchored on the .tsx coordinate", async () => {
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(overrideEdit(), dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, "src/index.css"), "utf8")
    // The rule head names the ANCHOR file, not the file it was written into.
    expect(patched).toContain(
      '[data-desde-src="src/App.tsx:33:46"] { padding-left: 41px !important; }',
    )
    // And the project's own CSS is byte-identical, at the front of the file.
    expect(patched.startsWith(APP_CSS)).toBe(true)
  })

  it("emits a plain descendant combinator — no :deep() outside an SFC", async () => {
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ deepSelector: ".MuiAlert-message" }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, "src/index.css"), "utf8")
    expect(patched).toContain('[data-desde-src="src/App.tsx:33:46"] .MuiAlert-message {')
    expect(patched).not.toContain(":deep(")
  })

  it("still writes an SFC destination as <style scoped> with :deep()", async () => {
    // The Vue lane is unchanged by the split — same file, same block, same
    // piercing form. The destination's extension is what selects the dialect.
    writeFileSync(
      join(dir, "src/App.vue"),
      `<template>\n  <KCard>Hi</KCard>\n</template>\n`,
      "utf8",
    )
    const result = await applyEdit(
      overrideEdit({
        file: "src/App.vue",
        line: 2,
        column: 3,
        anchorFile: "src/App.vue",
        anchorLine: 2,
        anchorColumn: 3,
        deepSelector: ".card-header",
      }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, "src/App.vue"), "utf8")
    expect(patched).toContain("<style scoped>")
    expect(patched).toContain(':deep(.card-header)')
  })

  it("refuses writing an override into an external library, naming the package", async () => {
    const nm = join(dir, "node_modules", "@mui", "material")
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, "style.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ file: "node_modules/@mui/material/style.css" }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The scoped package name, joined, is what makes this recognisable to a
    // designer. A bare "@mui" or a bare "material" is a fragment.
    expect(result.reason).toContain("@mui/material")
    expect(result.reason).toContain("an external library")
    // This string reaches the designer, so neither the directory name nor the
    // jargon may come back. Both were in it until 2026-08-17.
    expect(result.reason).not.toMatch(/node_modules/)
    expect(result.reason).not.toMatch(/library source/i)
    // The reinstall consequence lives HERE and only here: this is the one
    // refusal where the write would otherwise have worked.
    expect(result.reason).toMatch(/would wipe the change/)
    expect(readFileSync(join(nm, "style.css"), "utf8")).toBe(APP_CSS)
  })

  it("falls back to the bare noun phrase when the path yields no package name", async () => {
    // A file directly under node_modules, so there is no package segment to
    // name. Printing a fragment (or the word "undefined") would be worse than
    // saying less.
    const nm = join(dir, "node_modules")
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, "stray.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ file: "node_modules/stray.css" }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("an external library")
    expect(result.reason).not.toMatch(/undefined|``/)
    expect(readFileSync(join(nm, "stray.css"), "utf8")).toBe(APP_CSS)
  })

  it("refuses a .css symlink pointing OUTSIDE the prototype root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "desde-scoped-outside-"))
    const outsideFile = join(outsideDir, "secret.css")
    writeFileSync(outsideFile, APP_CSS, "utf8")
    symlinkSync(outsideFile, join(dir, "src/link.css"))
    try {
      const result = await applyEdit(overrideEdit({ file: "src/link.css" }), dir, LOADERS)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/escapes prototype root/i)
      expect(readFileSync(outsideFile, "utf8")).toBe(APP_CSS)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it("refuses an anchor that would break out of the attribute selector", async () => {
    // The anchor is no longer a resolved path, so it is no longer implicitly
    // quote-free. Without this it is a CSS injection into a file we write.
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ anchorFile: 'src/A"] { color: red } [x' }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, "src/index.css"), "utf8")).toBe(APP_CSS)
  })

  it("rejects a half-specified anchor at the validator, before any write", async () => {
    // Mixing the anchor's file with the destination's line is the exact
    // confusion the split exists to end, so a partial triple is a 400.
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ anchorLine: undefined }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, "src/index.css"), "utf8")).toBe(APP_CSS)
  })

  it("refuses a .tsx destination — a rule cannot live in a component file", async () => {
    writeFileSync(join(dir, "src/App.tsx"), "export const A = () => null\n", "utf8")
    const result = await applyEdit(overrideEdit({ file: "src/App.tsx" }), dir, LOADERS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/\.vue or \.css/)
  })

  it("F-17: writes a quoted attribute deep selector instead of refusing it", async () => {
    // Regression coverage for F-17, end-to-end through the real dispatcher:
    // a stable selector that IS a quoted attribute selector (what the bridge
    // emits for an element with a data-testid/aria-label/placeholder and no
    // usable class/id) used to be refused outright by the applicator's old
    // guard, which banned every `"` in `deepSelector` unconditionally.
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ deepSelector: '[data-testid="hero"]' }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, "src/index.css"), "utf8")
    expect(patched).toContain(
      '[data-desde-src="src/App.tsx:33:46"] [data-testid="hero"] {',
    )
  })

  it("SECURITY: an unbalanced quote in the deep selector is still refused end-to-end", async () => {
    writeFileSync(join(dir, "src/index.css"), APP_CSS, "utf8")
    const result = await applyEdit(
      overrideEdit({ deepSelector: '[data-testid="hero' }),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, "src/index.css"), "utf8")).toBe(APP_CSS)
  })

  it("falls back to the destination triple when no anchor is sent (pre-split senders)", async () => {
    // The Vue wire body carried one triple doing both jobs. A stale client
    // must keep working, and for Vue the two genuinely are the same file.
    writeFileSync(
      join(dir, "src/App.vue"),
      `<template>\n  <div/>\n</template>\n`,
      "utf8",
    )
    const result = await applyEdit(
      {
        edit: {
          kind: "scoped-css-override",
          file: "src/App.vue",
          line: 2,
          column: 3,
          declarations: { color: "red" },
        } as EditRequestBody["edit"],
      },
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "src/App.vue"), "utf8")).toContain(
      '[data-desde-src="src/App.vue:2:3"]',
    )
  })
})
