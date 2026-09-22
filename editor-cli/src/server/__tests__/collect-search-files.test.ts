/**
 * Tests for `collectSearchFiles` — the I/O half of the unique-text edit
 * step. Covers the git vs. non-git scope decision, the exclusion list
 * (applied on top of `.gitignore`, not instead of it), the extension
 * allowlist, each of the three limits, and the symlink guard.
 *
 * See `docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`
 * ("Scope and limits") for the rules under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { collectSearchFiles, DEFAULT_COLLECT_LIMITS } from "../collect-search-files.js"

const execFileAsync = promisify(execFile)

async function initGitRepo(root: string): Promise<void> {
  await execFileAsync("git", ["-C", root, "init", "-q"])
  await execFileAsync("git", ["-C", root, "config", "user.email", "t@t.dev"])
  await execFileAsync("git", ["-C", root, "config", "user.name", "T"])
}

async function gitAdd(root: string, ...relPaths: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, "add", ...relPaths])
}

async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, "utf-8")
}

describe("collectSearchFiles", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collect-search-files-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  describe("git repos", () => {
    it("honors .gitignore and includes untracked files", async () => {
      await initGitRepo(tmp)
      await writeFile(tmp, ".gitignore", "dist/\n")
      await writeFile(tmp, "dist/built.json", '{"a":"ignored"}')
      await writeFile(tmp, "src/tracked.json", '{"a":"tracked"}')
      await writeFile(tmp, "src/untracked.json", '{"a":"untracked"}')
      await gitAdd(tmp, ".gitignore", "src/tracked.json")
      // src/untracked.json is deliberately left un-added.

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const paths = result.files.map((f) => f.path).sort()
      expect(paths).toEqual(["src/tracked.json", "src/untracked.json"])
    })
  })

  describe("non-git directories", () => {
    it("walks the tree with fs.readdir when there is no git repo", async () => {
      await writeFile(tmp, "src/a.json", "{}")
      await writeFile(tmp, "src/nested/b.md", "# hi")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const paths = result.files.map((f) => f.path).sort()
      expect(paths).toEqual(["src/a.json", "src/nested/b.md"])
    })
  })

  describe("exclusions (applied on top of git and the walk alike)", () => {
    it("excludes node_modules at any depth", async () => {
      await writeFile(tmp, "node_modules/pkg/index.json", "{}")
      await writeFile(tmp, "packages/app/node_modules/pkg/index.json", "{}")
      await writeFile(tmp, "src/keep.json", "{}")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
    })

    it("excludes .desde", async () => {
      await writeFile(tmp, ".desde/manifests/cache.json", "{}")
      await writeFile(tmp, "src/keep.json", "{}")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
    })

    it("excludes test files and test directories", async () => {
      await writeFile(tmp, "src/thing.test.ts", "test content")
      await writeFile(tmp, "src/thing.spec.ts", "spec content")
      await writeFile(tmp, "__tests__/fixture.json", "{}")
      await writeFile(tmp, "tests/fixture.json", "{}")
      await writeFile(tmp, "e2e/scenario.md", "# e2e")
      await writeFile(tmp, "src/keep.json", "{}")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
    })

    it("excludes docs/ and README/CHANGELOG/LICENSE/CONTRIBUTING files", async () => {
      await writeFile(tmp, "docs/guide.md", "# guide")
      await writeFile(tmp, "README.md", "# readme")
      await writeFile(tmp, "CHANGELOG.md", "# changelog")
      await writeFile(tmp, "LICENSE.md", "license text")
      await writeFile(tmp, "CONTRIBUTING.md", "# contributing")
      await writeFile(tmp, "src/keep.md", "# keep")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.md"])
    })

    it("excludes dot-files and dot-directories at any depth", async () => {
      await writeFile(tmp, ".env.json", "{}")
      await writeFile(tmp, "src/.hidden/thing.json", "{}")
      await writeFile(tmp, "src/.eslintrc.json", "{}")
      await writeFile(tmp, "src/keep.json", "{}")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
    })

    it("excludes config files and lockfiles", async () => {
      await writeFile(tmp, "package.json", "{}")
      await writeFile(tmp, "package-lock.json", "{}")
      await writeFile(tmp, "yarn.lock", "")
      await writeFile(tmp, "pnpm-lock.yaml", "")
      await writeFile(tmp, "tsconfig.json", "{}")
      await writeFile(tmp, "tsconfig.build.json", "{}")
      await writeFile(tmp, "vite.config.ts", "export default {}")
      await writeFile(tmp, "eslint.config.mjs", "export default []")
      await writeFile(tmp, "src/keep.json", "{}")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
    })
  })

  describe("extension filter", () => {
    it("keeps only searchable extensions", async () => {
      await writeFile(tmp, "src/keep.json", "{}")
      await writeFile(tmp, "src/keep.vue", "<template></template>")
      await writeFile(tmp, "src/keep.svelte", "<div></div>")
      await writeFile(tmp, "src/keep.yaml", "a: 1")
      await writeFile(tmp, "src/skip.png", "not text")
      await writeFile(tmp, "src/skip.exe", "binary")
      await writeFile(tmp, "src/skip", "no extension at all")

      const result = await collectSearchFiles(tmp)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path).sort()).toEqual([
        "src/keep.json",
        "src/keep.svelte",
        "src/keep.vue",
        "src/keep.yaml",
      ])
    })
  })

  describe("limits", () => {
    it("refuses when candidate files exceed maxFiles", async () => {
      await writeFile(tmp, "src/a.json", "{}")
      await writeFile(tmp, "src/b.json", "{}")
      await writeFile(tmp, "src/c.json", "{}")

      const result = await collectSearchFiles(tmp, { ...DEFAULT_COLLECT_LIMITS, maxFiles: 2 })
      expect(result).toEqual({ ok: false, reason: "Too many files to search (over 2)." })
    })

    it("skips and counts a file over maxFileBytes without reading it", async () => {
      await writeFile(tmp, "src/big.json", "x".repeat(20))
      await writeFile(tmp, "src/small.json", "{}")

      const result = await collectSearchFiles(tmp, { ...DEFAULT_COLLECT_LIMITS, maxFileBytes: 10 })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.files.map((f) => f.path)).toEqual(["src/small.json"])
      expect(result.skippedLarge).toBe(1)
    })

    it("refuses right after the listing/walk when the budget is already spent before any read", async () => {
      await writeFile(tmp, "src/a.json", "{}")

      // First call establishes `start` (0). The very next call is the new
      // post-listing checkpoint, which sees the clock already past the
      // budget -- before any file is read at all.
      const clock = [0, 1000]
      const now = () => clock.shift() ?? 1000

      const result = await collectSearchFiles(tmp, { ...DEFAULT_COLLECT_LIMITS, budgetMs: 500 }, now)
      expect(result).toEqual({ ok: false, reason: "Searching the project took too long." })
    })

    it("refuses when the wall-clock budget is exceeded between reads", async () => {
      await writeFile(tmp, "src/a.json", "{}")
      await writeFile(tmp, "src/b.json", "{}")

      // Calls in order: start (0), the post-listing checkpoint (0, still
      // fine), the first loop iteration's checkpoint (0, so file a.json is
      // read), then the second loop iteration's checkpoint sees the clock
      // has jumped past the budget -- before file b.json is read.
      const clock = [0, 0, 0, 1000]
      const now = () => clock.shift() ?? 1000

      const result = await collectSearchFiles(tmp, { ...DEFAULT_COLLECT_LIMITS, budgetMs: 500 }, now)
      expect(result).toEqual({ ok: false, reason: "Searching the project took too long." })
    })

    it("refuses right after the last read, when finishing it alone pushes past the budget", async () => {
      await writeFile(tmp, "src/a.json", "{}")

      // Only one candidate file, so the per-iteration checkpoint (still 0,
      // before reading it) can't be what catches this -- only the new
      // post-loop checkpoint, after the file is read, can.
      const clock = [0, 0, 0, 1000]
      const now = () => clock.shift() ?? 1000

      const result = await collectSearchFiles(tmp, { ...DEFAULT_COLLECT_LIMITS, budgetMs: 500 }, now)
      expect(result).toEqual({ ok: false, reason: "Searching the project took too long." })
    })
  })

  describe("symlinks", () => {
    it("skips a symlink pointing outside the root", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "collect-search-files-outside-"))
      try {
        await writeFile(outside, "secret.json", '{"a":"outside"}')
        await fs.mkdir(path.join(tmp, "src"), { recursive: true })
        await fs.symlink(
          path.join(outside, "secret.json"),
          path.join(tmp, "src", "linked.json"),
        )
        await writeFile(tmp, "src/keep.json", "{}")

        const result = await collectSearchFiles(tmp)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    })

    it("skips a symlinked directory rather than following it", async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "collect-search-files-outside-dir-"))
      try {
        await writeFile(outside, "leaked.json", "{}")
        await fs.mkdir(path.join(tmp, "src"), { recursive: true })
        await fs.symlink(outside, path.join(tmp, "src", "linked-dir"))
        await writeFile(tmp, "src/keep.json", "{}")

        const result = await collectSearchFiles(tmp)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.files.map((f) => f.path)).toEqual(["src/keep.json"])
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
  })
})
