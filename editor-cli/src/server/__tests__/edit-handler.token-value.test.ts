/**
 * CLI handler tests for the `token-value` lane (§6 Phase 3 "The token" scope).
 *
 * This lane is the ONLY one that admits a `.css` file, so the extension gate +
 * node_modules refusal are security-sensitive. These tests pin:
 *   1. Happy path — a first-party token .css is patched.
 *   2. Extension gate — token-value targeting a .vue is refused (token lane is
 *      .css-only); and a non-token (prop) edit can't reach a .css.
 *   3. node_modules refusal — a token .css under node_modules is read-only.
 *   4. Symlink escape — a token .css symlink pointing OUTSIDE the root refused.
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

// Use the REAL token applicator — these are end-to-end gate + patch tests. The
// other (required) loaders are unused stubs: token/prop edits never reach them
// (prop is refused at the .css gate; token uses loadApplyTokenEdit).
const unused = vi.fn().mockReturnValue({ ok: false, reason: "unused stub" })
const LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({ applyPropEdit: unused }),
  loadApplyMoveEdit: async () => ({ applyMoveEdit: unused }),
  loadApplyDetachEdit: async () => ({ applyDetachEdit: unused }),
  loadApplyTokenEdit: () =>
    import("../../../../src/editor/edit-service/apply-token-edit.js"),
}

const TOKENS_CSS = `:root {\n  --acme-color-background-disabled: #f7f7f7;\n  --other: blue;\n}\n`

function tokenEdit(file: string, over: Partial<Record<string, unknown>> = {}): EditRequestBody {
  return {
    edit: {
      kind: "token-value",
      file,
      tokenName: "--acme-color-background-disabled",
      newValue: "#ff0000",
      selector: ":root",
      ...over,
    } as EditRequestBody["edit"],
  }
}

describe("edit-handler — token-value lane", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-token-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("patches a first-party token .css file", async () => {
    writeFileSync(join(dir, "tokens.css"), TOKENS_CSS, "utf8")
    const result = await applyEdit(tokenEdit("tokens.css"), dir, LOADERS)
    expect(result.ok).toBe(true)
    const patched = readFileSync(join(dir, "tokens.css"), "utf8")
    expect(patched).toContain("--acme-color-background-disabled: #ff0000")
    expect(patched).toContain("--other: blue") // untouched
  })

  it("refuses a token-value edit targeting a .vue file (token lane is .css-only)", async () => {
    writeFileSync(join(dir, "comp.vue"), `<template><div/></template>`, "utf8")
    const result = await applyEdit(tokenEdit("comp.vue"), dir, LOADERS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/\.css/)
  })

  it("refuses editing a token .css inside an external library, naming the package", async () => {
    const nm = join(dir, "node_modules", "@acme", "design-tokens", "dist")
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, "tokens.css"), TOKENS_CSS, "utf8")
    const result = await applyEdit(
      tokenEdit("node_modules/@acme/design-tokens/dist/tokens.css"),
      dir,
      LOADERS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("@acme/design-tokens")
    expect(result.reason).toContain("an external library")
    // This reaches the designer. `node_modules` is a directory they have never
    // opened, "library source" is jargon whose two words both mislead, and
    // "fork it into your prototype" named a manual workaround as if it were a
    // feature. All three were in this string until 2026-08-17.
    expect(result.reason).not.toMatch(/node_modules/)
    expect(result.reason).not.toMatch(/library source/i)
    expect(result.reason).not.toMatch(/\bfork\b/i)
    // The product is never the subject of its own copy.
    expect(result.reason).not.toMatch(/\bDesde\b|\bEditor\b/)
    // A refusal with no way forward is a dead end. Name the redirect.
    expect(result.reason).toMatch(/your project's stylesheets/)
    // The library file must be untouched.
    expect(readFileSync(join(nm, "tokens.css"), "utf8")).toBe(TOKENS_CSS)
  })

  it("refuses a token .css symlink pointing OUTSIDE the prototype root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "desde-token-outside-"))
    const outsideFile = join(outsideDir, "secret.css")
    writeFileSync(outsideFile, TOKENS_CSS, "utf8")
    symlinkSync(outsideFile, join(dir, "link.css"))
    try {
      const result = await applyEdit(tokenEdit("link.css"), dir, LOADERS)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/escapes prototype root/i)
      expect(readFileSync(outsideFile, "utf8")).toBe(TOKENS_CSS) // untouched
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it("refuses a non-token (prop) edit against a .css path — gate stays closed", async () => {
    writeFileSync(join(dir, "tokens.css"), TOKENS_CSS, "utf8")
    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "tokens.css",
        line: 1,
        column: 1,
        propName: "variant",
        value: "danger",
      },
    }
    const result = await applyEdit(body, dir, LOADERS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/\.vue/)
  })
})
