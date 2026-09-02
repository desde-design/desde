/**
 * CLI handler tests for the EXISTING-file branches (not allowCreate).
 * Three cases ported from the deleted web `route.test.ts`:
 *
 *   1. Symlink escape — a link inside the root pointing OUTSIDE the
 *      root must be refused (400 / escapes), and the outside file
 *      must NOT be modified.
 *   2. .ts overwrite on an existing file — the overwrite lane accepts
 *      .ts for composables / utilities; the file is rewritten.
 *   3. Non-overwrite (`prop`) edit against a .ts path — refused 400,
 *      reason mentions `.vue`.
 *
 * These are distinct from the `allowCreate` tests in
 * `edit-handler.allow-create.test.ts`, which cover the new-file
 * branch — symlink escape there is a different code path (the
 * "safe-create" check). The cases here exercise the realpath +
 * containment guards on existing-file edits, plus the extension
 * gate's non-.vue refusal for Vue-primitive edit kinds.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

// The .ts-overwrite case never reaches an applicator (overwrite just
// writes the bytes once guards pass), and the .ts-prop case is
// refused before the applicator is reached. The symlink case also
// short-circuits before applicator dispatch. So a minimal stub
// suffices for all three.
const STUB_LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({
    applyPropEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyMoveEdit: async () => ({
    applyMoveEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
  loadApplyDetachEdit: async () => ({
    applyDetachEdit: vi.fn().mockReturnValue({ ok: false, reason: "unused stub" }),
  }),
}

const MINIMAL_SFC = `<template>
  <button>Click me</button>
</template>
`

describe("edit-handler — existing-file extension + symlink guards", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-existing-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses a prop edit when an in-root symlink points to a .vue OUTSIDE the root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "desde-outside-"))
    const outsideFile = join(outsideDir, "secret.vue")
    writeFileSync(outsideFile, MINIMAL_SFC, "utf8")
    symlinkSync(outsideFile, join(dir, "link.vue"))

    try {
      const body: EditRequestBody = {
        edit: {
          kind: "prop",
          file: "link.vue",
          line: 2,
          column: 3,
          propName: "variant",
          value: "danger",
        },
      }
      const result = await applyEdit(body, dir, STUB_LOADERS)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(400)
        expect(result.reason).toMatch(/escapes/)
      }
      // Critical: the file the link pointed to must be unmodified.
      // This is the actual security property the test exists to pin.
      expect(readFileSync(outsideFile, "utf8")).toBe(MINIMAL_SFC)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it("rewrites an existing .ts file via the overwrite lane (composables / utilities)", async () => {
    const file = "src/composables/useTabUrlSync.ts"
    const original = `export const tabs = ['overview', 'logs'] as const\n`
    const updated = `export const tabs = ['overview', 'logs', 'settings'] as const\n`
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), original, "utf8")

    const body: EditRequestBody = {
      edit: { kind: "overwrite", file, newSource: updated },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe(200)
    expect(readFileSync(join(dir, file), "utf8")).toBe(updated)
  })

  it("refuses a prop edit against an existing .ts file (Vue-primitive lanes stay .vue-only)", async () => {
    const file = "src/composables/useFoo.ts"
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), "export {}\n", "utf8")

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file,
        line: 1,
        column: 1,
        propName: "variant",
        value: "x",
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.reason).toMatch(/\.vue/)
    }
    // File should be untouched.
    expect(readFileSync(join(dir, file), "utf8")).toBe("export {}\n")
    // And no spurious .vue file gets created next to it.
    expect(existsSync(join(dir, "src/composables/useFoo.vue"))).toBe(false)
  })
})
