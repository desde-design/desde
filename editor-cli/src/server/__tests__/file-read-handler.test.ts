/**
 * Unit tests for the CLI file-read handler.
 *
 * Mirrors the path-traversal + extension-gate semantics of the
 * `overwrite` lane in edit-handler.ts so the editor's read endpoint
 * and the editor's write endpoint accept/reject the same set of files.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readPrototypeFile } from "../file-read-handler.js"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "file-read-handler-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readPrototypeFile", () => {
  it("reads a .vue file under the prototype root", async () => {
    const src = "<template>\n  <div>hello</div>\n</template>\n"
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src/App.vue"), src, "utf8")

    const result = await readPrototypeFile(root, "src/App.vue")
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.content).toBe(src)
    expect(result.relativePath).toBe("src/App.vue")
    const expectedSha = createHash("sha256").update(src, "utf8").digest("hex")
    expect(result.sha).toBe(expectedSha)
  })

  it("reads a .ts file under the prototype root", async () => {
    const src = "export const foo = 1\n"
    writeFileSync(join(root, "util.ts"), src, "utf8")

    const result = await readPrototypeFile(root, "util.ts")
    expect(result.ok).toBe(true)
    expect(result.content).toBe(src)
  })

  it("reads a .tsx file under the prototype root (React support)", async () => {
    const src = "export const App = () => <div>hi</div>\n"
    writeFileSync(join(root, "App.tsx"), src, "utf8")

    const result = await readPrototypeFile(root, "App.tsx")
    expect(result.ok).toBe(true)
    expect(result.content).toBe(src)
  })

  it("reads a .jsx file under the prototype root (React support)", async () => {
    const src = "export const App = () => <div>hi</div>\n"
    writeFileSync(join(root, "App.jsx"), src, "utf8")

    const result = await readPrototypeFile(root, "App.jsx")
    expect(result.ok).toBe(true)
    expect(result.content).toBe(src)
  })

  it("refuses non-.vue/.ts/.tsx/.jsx files", async () => {
    writeFileSync(join(root, "config.json"), "{}", "utf8")
    const result = await readPrototypeFile(root, "config.json")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.reason).toMatch(/\.vue, \.ts, \.tsx, and \.jsx/)
  })

  it("rejects uppercase extensions (parity with edit-handler's case-sensitive gate)", async () => {
    writeFileSync(join(root, "Foo.VUE"), "<template/>", "utf8")
    writeFileSync(join(root, "Bar.TS"), "export {}", "utf8")
    const a = await readPrototypeFile(root, "Foo.VUE")
    expect(a.ok).toBe(false)
    expect(a.status).toBe(400)
    const b = await readPrototypeFile(root, "Bar.TS")
    expect(b.ok).toBe(false)
    expect(b.status).toBe(400)
  })

  it("refuses paths that escape the prototype root", async () => {
    const result = await readPrototypeFile(root, "../etc/passwd.vue")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.reason).toMatch(/escapes prototype root/)
  })

  it("404s on missing file", async () => {
    const result = await readPrototypeFile(root, "src/Missing.vue")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
  })

  it("requires the `path` query parameter", async () => {
    const a = await readPrototypeFile(root, null)
    expect(a.ok).toBe(false)
    expect(a.status).toBe(400)
    const b = await readPrototypeFile(root, "")
    expect(b.ok).toBe(false)
    expect(b.status).toBe(400)
  })

  it("rejects a .vue symlink pointing OUTSIDE the prototype root", async () => {
    // Target is a real file outside the root.
    const otherRoot = mkdtempSync(join(tmpdir(), "file-read-other-"))
    try {
      const outside = join(otherRoot, "secrets.vue")
      writeFileSync(outside, "<template>x</template>", "utf8")
      // Symlink inside root that resolves to the outside file.
      const symPath = join(root, "Sneaky.vue")
      symlinkSync(outside, symPath)

      const result = await readPrototypeFile(root, "Sneaky.vue")
      expect(result.ok).toBe(false)
      // Either the lexical check or the realpath check rejects.
      expect([400, 404]).toContain(result.status)
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  it("rejects a symlink that resolves to a non-.vue/.ts/.tsx/.jsx target", async () => {
    // Target inside root but with a forbidden extension.
    const target = join(root, "config.sh")
    writeFileSync(target, "#!/bin/sh", "utf8")
    const symPath = join(root, "Innocent.vue")
    symlinkSync(target, symPath)

    const result = await readPrototypeFile(root, "Innocent.vue")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(400)
    expect(result.reason).toMatch(/not a \.vue, \.ts, \.tsx, or \.jsx file/)
  })
})
