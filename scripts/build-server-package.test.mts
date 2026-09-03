/**
 * Unit coverage for `cleanDestination` in `build-server-package.mts` — the
 * guard that decides whether it is safe to delete an existing `--out`
 * directory before staging a fresh payload into it.
 *
 * Imports the module directly rather than spawning it as a subprocess (the
 * pattern `check-website-doc-links.test.mts` uses for a script that has no
 * exports worth calling directly). Two things make that safe here:
 *
 *   1. `cleanDestination` and `MANIFEST_FILENAME` are exported specifically
 *      for this file.
 *   2. `build-server-package.mts`'s own `main()` call is guarded to run only
 *      when the file is the process's own entry point (see the bottom of
 *      that file) — importing it here does NOT parse `process.argv`, shell
 *      out to `npm run build:server`, or call `process.exit`.
 *
 * A subprocess-spawn test would also have had to assume `editor-cli/dist`
 * and `editor-cli/ui-src/dist` are already built (to reach `--skip-build`'s
 * fast path) or pay for a full build on every run — this is faster and has
 * no such precondition.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  cleanDestination,
  currentGitCommit,
  isWorkingTreeDirty,
  MANIFEST_FILENAME,
  pruneNodeModules,
} from "./build-server-package.mjs"

describe("cleanDestination", () => {
  let scratch: string

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  /**
   * The defect this whole suite exists to close: `fs.readdir` follows
   * symlinks, so a `--out` that IS a symlink pointing at a real, empty
   * directory used to sail through the "empty is safe" branch with the
   * marker-file guard never running at all — every artifact would then be
   * written into the symlink's TARGET, not at the path the caller named.
   */
  it("refuses a --out that is a symlink, even when it resolves to an empty directory", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const target = join(scratch, "real-empty-dir")
    mkdirSync(target)
    const outLink = join(scratch, "out-symlink")
    symlinkSync(target, outLink)

    await expect(cleanDestination(outLink)).rejects.toThrow(/symlink/i)

    // The guard must fire BEFORE anything touches the target — nothing
    // should have been read from or written into it.
    expect(readdirSync(target)).toEqual([])
  })

  it("refuses a symlinked --out even when its target already looks like a previous payload build", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const target = join(scratch, "prior-payload")
    mkdirSync(target)
    writeFileSync(join(target, MANIFEST_FILENAME), "{}")
    const outLink = join(scratch, "out-symlink")
    symlinkSync(target, outLink)

    await expect(cleanDestination(outLink)).rejects.toThrow(/symlink/i)
    // Refused outright — not silently deleted via the marker-file branch.
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(target, MANIFEST_FILENAME))).toBe(true)
  })

  it("is a no-op for a --out that does not exist yet", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const doesNotExist = join(scratch, "not-there")

    await expect(cleanDestination(doesNotExist)).resolves.toBeUndefined()
  })

  it("is a no-op for a real (non-symlink) empty directory", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const emptyDir = join(scratch, "empty")
    mkdirSync(emptyDir)

    await expect(cleanDestination(emptyDir)).resolves.toBeUndefined()
    expect(existsSync(emptyDir)).toBe(true)
  })

  it("deletes a real, non-empty --out that carries the payload manifest marker", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const priorBuild = join(scratch, "prior-build")
    mkdirSync(priorBuild)
    writeFileSync(join(priorBuild, MANIFEST_FILENAME), "{}")
    writeFileSync(join(priorBuild, "leftover.txt"), "stale")

    await cleanDestination(priorBuild)

    expect(existsSync(priorBuild)).toBe(false)
  })

  it("refuses a real, non-empty --out with no payload manifest marker", async () => {
    scratch = mkdtempSync(join(tmpdir(), "build-server-package-test-"))
    const unrelated = join(scratch, "not-a-payload-build")
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, "important.txt"), "do not delete me")

    await expect(cleanDestination(unrelated)).rejects.toThrow(new RegExp(MANIFEST_FILENAME))
    expect(existsSync(join(unrelated, "important.txt"))).toBe(true)
  })
})

/**
 * Regression coverage for fix-round finding F4: `payload-manifest.json`'s
 * `gitCommit` field used to record a clean SHA no matter what state the
 * working tree was actually in, so a payload built from uncommitted work
 * claimed to BE a commit it wasn't — the exact staleness question the
 * manifest exists to answer, answered wrong. Both functions take an
 * explicit `repoRoot` so these tests exercise a disposable SCRATCH git repo
 * rather than depending on (or perturbing) this checkout's own working-tree
 * state, which other concurrent sessions may be actively changing.
 */
describe("isWorkingTreeDirty / currentGitCommit", () => {
  let repo: string

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  /** A minimal git repo with one committed file, isolated from the real user/global git config. */
  function makeScratchRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "build-server-package-git-test-"))
    const git = (...args: string[]): void => {
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com" },
      })
    }
    git("init", "--quiet")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "test")
    writeFileSync(join(dir, "committed.txt"), "hello")
    git("add", "committed.txt")
    git("commit", "--quiet", "--message", "initial", "--author", "test <test@example.com>")
    return dir
  }

  it("reports a freshly committed tree as clean", () => {
    repo = makeScratchRepo()
    expect(isWorkingTreeDirty(repo)).toBe(false)
  })

  it("reports an unstaged modification as dirty", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "committed.txt"), "modified")
    expect(isWorkingTreeDirty(repo)).toBe(true)
  })

  it("reports an untracked file as dirty", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "untracked.txt"), "new")
    expect(isWorkingTreeDirty(repo)).toBe(true)
  })

  it("currentGitCommit returns the bare SHA for a clean tree", () => {
    repo = makeScratchRepo()
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    expect(currentGitCommit(repo)).toBe(sha)
  })

  it("currentGitCommit appends -dirty when the tree has pending changes", () => {
    repo = makeScratchRepo()
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    writeFileSync(join(repo, "committed.txt"), "modified")
    expect(currentGitCommit(repo)).toBe(`${sha}-dirty`)
  })
})

describe("pruneNodeModules", () => {
  function file(root: string, rel: string): string {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, "x", "utf8")
    return full
  }

  it("drops maps, docs, test dirs and declarations, keeps licenses, code, and typescript/ whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "prune-"))
    const nm = join(root, "node_modules")
    const kept = [
      file(nm, "zod/index.js"),
      file(nm, "zod/LICENSE"),
      file(nm, "zod/LICENSE.md"),
      file(nm, "zod/NOTICE.txt"),
      file(nm, "zod/src/types.ts"),
      file(nm, "typescript/lib/lib.dom.d.ts"),
      file(nm, "typescript/README.md"),
      file(nm, "typescript/lib/typescript.js.map"),
      file(nm, "@scope/pkg/dist/index.cjs"),
    ]
    const dropped = [
      file(nm, "zod/index.js.map"),
      file(nm, "zod/README.md"),
      file(nm, "zod/CHANGELOG.markdown"),
      file(nm, "zod/index.d.ts"),
      file(nm, "zod/index.d.mts"),
      file(nm, "zod/index.d.cts"),
      file(nm, "zod/test/a.test.js"),
      file(nm, "zod/lib/__tests__/b.js"),
      file(nm, "@scope/pkg/tests/c.js"),
      file(nm, "@scope/pkg/dist/index.d.ts"),
    ]
    const result = await pruneNodeModules(nm)
    for (const p of kept) expect(existsSync(p), p).toBe(true)
    for (const p of dropped) expect(existsSync(p), p).toBe(false)
    expect(result.files).toBe(dropped.length)
    expect(result.dirs).toBe(3)
    rmSync(root, { recursive: true, force: true })
  })

  it("is a no-op for a missing directory (--skip-install payloads)", async () => {
    await expect(pruneNodeModules(join(tmpdir(), "does-not-exist-prune"))).resolves.toEqual({
      files: 0,
      dirs: 0,
      bytes: 0,
    })
  })
})
