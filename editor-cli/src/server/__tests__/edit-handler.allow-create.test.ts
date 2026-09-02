/**
 * Phase 4 — `allowCreate` end-to-end tests for the CLI handler's
 * overwrite path. Validates that the new-file create branch:
 *   - Creates the file (and parent dirs) when allowCreate=true and
 *     the target doesn't exist
 *   - Refuses (409) when allowCreate=true but the target DOES exist
 *   - Refuses (400) when allowCreate=true on a non-.vue path
 *   - Default behavior (allowCreate omitted) still refuses ENOENT
 *   - Validates the new source compiles (refuse on bad SFC)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { applyEdit, type EditRequestBody } from "../edit-handler.js"

const STUB_LOADERS = {} as never // overwrite branch doesn't use applicator loaders

describe("edit-handler — allowCreate", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desde-allowcreate-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("creates a new .vue file when allowCreate=true and parent dirs missing", async () => {
    const newSource = "<template><div>fresh</div></template>\n"
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "src/components/Fresh.vue",
        newSource,
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(true)
    const onDisk = readFileSync(join(dir, "src/components/Fresh.vue"), "utf8")
    expect(onDisk).toBe(newSource)
  })

  it("returns 409 when allowCreate=true but the file already exists", async () => {
    writeFileSync(join(dir, "Existing.vue"), "<template/>", "utf8")
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "Existing.vue",
        newSource: "<template>new</template>",
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/already exists/)
    }
  })

  it("accepts .ts under allowCreate (composables / utilities are now supported)", async () => {
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "src/composables/useFoo.ts",
        newSource: "export function useFoo() {\n  return 1\n}\n",
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, "src/composables/useFoo.ts"))).toBe(true)
  })

  it("still refuses unsupported extensions (e.g. .css) under allowCreate", async () => {
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "src/styles/x.css",
        newSource: "body{}",
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
  })

  it("without allowCreate, missing file still returns 404 (unchanged behavior)", async () => {
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "src/Missing.vue",
        newSource: "<template/>",
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
    expect(existsSync(join(dir, "src/Missing.vue"))).toBe(false)
  })

  it("refuses new files whose source fails compile validation", async () => {
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "Broken.vue",
        // No <template> block at all — validateOverwriteSource refuses.
        newSource: "<style>.x { color: red; }</style>",
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(422)
    expect(existsSync(join(dir, "Broken.vue"))).toBe(false)
  })

  it("rejects allowCreate when an ancestor directory is a symlink (P1 escape)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "desde-outside-"))
    try {
      symlinkSync(outside, join(dir, "link-dir"))
      const body: EditRequestBody = {
        edit: {
          kind: "overwrite",
          file: "link-dir/sneaky.vue",
          newSource: "<template>x</template>",
          allowCreate: true,
        },
      }
      const result = await applyEdit(body, dir, STUB_LOADERS)
      expect(result.ok).toBe(false)
      // Either via the safe-create check or the .vue stat check; key
      // outcome is no file lands in `outside`.
      expect(existsSync(join(outside, "sneaky.vue"))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects allowCreate when the leaf path is a dangling symlink", async () => {
    symlinkSync("/no-such-target", join(dir, "danger.vue"))
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "danger.vue",
        newSource: "<template>x</template>",
        allowCreate: true,
      },
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
  })

  it("rejects allowCreate paired with a baseHash (validate-edit-request)", async () => {
    const body: EditRequestBody = {
      edit: {
        kind: "overwrite",
        file: "Foo.vue",
        newSource: "<template/>",
        allowCreate: true,
        baseHash: "abc123",
      } as never,
    }
    const result = await applyEdit(body, dir, STUB_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/mutually exclusive/)
  })
})
