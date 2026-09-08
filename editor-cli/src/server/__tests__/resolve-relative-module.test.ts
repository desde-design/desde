/**
 * Tests for resolve-relative-module.ts — the ONE filesystem hop the
 * iteration handler takes to follow a relative import to its module, with
 * the same containment guards as every other CLI file-read.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveRelativeModule } from "../resolve-relative-module.js"
import { resolvePrototypeRoot, type ResolvedRoot } from "../resolve-editable-path.js"

describe("resolveRelativeModule", () => {
  let dir: string
  let root: ResolvedRoot

  beforeEach(async () => {
    // Realpath immediately: on macOS, `os.tmpdir()` sits under `/var`, which
    // is itself a symlink to `/private/var`. `root.rootReal` (below) is
    // realpath'd, so building test paths from the UN-realpath'd `dir` makes
    // every candidate look like it starts with `/var/...` while the root
    // starts with `/private/var/...` — `isWithinRoot`'s startsWith check then
    // fails for every specifier, not because of anything `resolveRelativeModule`
    // got wrong. The real CLI never hits this: `fromFile` there is always
    // already a realpath'd `targetPath`. Realpathing `dir` up front matches
    // that and keeps the fixture honest.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "desde-resolve-module-")))
    const resolved = await resolvePrototypeRoot(dir)
    if (!resolved.ok) throw new Error("resolvePrototypeRoot failed in test setup")
    root = resolved
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("resolves an exact file when the specifier already carries the extension", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "data.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./data.ts", root)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toBe("src/data.ts")
    expect(result.source).toContain("export const X")
  })

  it("resolves an extensionless specifier to a .ts file", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "data.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./data", root)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toBe("src/data.ts")
  })

  it("resolves `./data.js` written against a `.ts` file on disk", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src", "data.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./data.js", root)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toBe("src/data.ts")
  })

  it("resolves `./lib` to lib/index.ts", async () => {
    mkdirSync(join(dir, "src", "lib"), { recursive: true })
    writeFileSync(join(dir, "src", "lib", "index.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./lib", root)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toBe("src/lib/index.ts")
  })

  it("relativePath uses forward slashes and is relative to the root", async () => {
    mkdirSync(join(dir, "src", "nested"), { recursive: true })
    writeFileSync(join(dir, "src", "nested", "data.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./nested/data", root)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.relativePath).toBe("src/nested/data.ts")
    expect(result.relativePath).not.toContain("\\")
  })

  it("refuses a specifier that points above the root", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "../outside", root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("outside")
  })

  it("refuses a bare (non-relative) specifier", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "react", root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("package import")
  })

  it("refuses a specifier that resolves into a node_modules dir inside root", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "export const X = 1\n", "utf8")
    const result = await resolveRelativeModule(
      join(dir, "src", "app.ts"),
      "../node_modules/pkg",
      root,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("node_modules")
  })

  it("refuses when no file can be found for the specifier", async () => {
    mkdirSync(join(dir, "src"), { recursive: true })
    const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./missing", root)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("No file found")
  })

  it("refuses a symlink inside root that points outside root", async () => {
    const other = mkdtempSync(join(tmpdir(), "desde-resolve-module-outside-"))
    try {
      writeFileSync(join(other, "secret.ts"), "export const SECRET = 1\n", "utf8")
      mkdirSync(join(dir, "src"), { recursive: true })
      symlinkSync(join(other, "secret.ts"), join(dir, "src", "link.ts"))
      const result = await resolveRelativeModule(join(dir, "src", "app.ts"), "./link", root)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain("outside")
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
