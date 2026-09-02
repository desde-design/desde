/**
 * `signing-env.mjs` — locating and parsing the Apple signing/notarization
 * credentials file (tasks/electron-app.md §5 Phase 5b, Part 2). Every path
 * and value below is a temp-directory FAKE fixture; this file never reads,
 * references, or depends on the real `.env.signing.local` at the main
 * checkout root.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  loadSigningEnv,
  parseEnvFile,
  resolveMainCheckoutRoot,
  resolveSigningEnvCandidates,
  SIGNING_ENV_FILENAME,
} from "../scripts/signing-env.mjs"

describe("parseEnvFile", () => {
  it("parses plain KEY=VALUE lines", () => {
    expect(parseEnvFile("APPLE_TEAM_ID=FAKETEAM\nAPPLE_ID=fake@example.com\n")).toEqual({
      APPLE_TEAM_ID: "FAKETEAM",
      APPLE_ID: "fake@example.com",
    })
  })

  it("skips blank lines and #-prefixed comments", () => {
    expect(parseEnvFile("# a comment\n\nAPPLE_TEAM_ID=FAKETEAM\n\n# trailing comment\n")).toEqual({
      APPLE_TEAM_ID: "FAKETEAM",
    })
  })

  it("strips matching double or single quotes around a value", () => {
    expect(parseEnvFile('APPLE_ID="fake@example.com"\nAPPLE_TEAM_ID=\'FAKETEAM\'\n')).toEqual({
      APPLE_ID: "fake@example.com",
      APPLE_TEAM_ID: "FAKETEAM",
    })
  })

  it("trims surrounding whitespace on both key and value", () => {
    expect(parseEnvFile("  APPLE_TEAM_ID  =  FAKETEAM  \n")).toEqual({ APPLE_TEAM_ID: "FAKETEAM" })
  })

  it("skips a line with no '=' instead of throwing", () => {
    expect(parseEnvFile("not-a-kv-line\nAPPLE_TEAM_ID=FAKETEAM\n")).toEqual({ APPLE_TEAM_ID: "FAKETEAM" })
  })
})

describe("resolveSigningEnvCandidates", () => {
  it("uses ONLY the override when DESDE_SIGNING_ENV is set and absolute — the resolver is never called", () => {
    let resolverCalls = 0
    const fakeResolver = () => {
      resolverCalls++
      return "/fake/main/checkout"
    }
    const candidates = resolveSigningEnvCandidates(
      { DESDE_SIGNING_ENV: "/fake/override/.env.signing.local" },
      "/fake/repo/root",
      "/fake/cwd",
      fakeResolver,
    )
    expect(candidates).toEqual([{ path: "/fake/override/.env.signing.local", required: true }])
    expect(resolverCalls).toBe(0)
  })

  it("throws when DESDE_SIGNING_ENV is set but not absolute", () => {
    expect(() =>
      resolveSigningEnvCandidates({ DESDE_SIGNING_ENV: "relative/.env.signing.local" }, "/fake/repo/root", "/fake/cwd"),
    ).toThrow(/absolute/)
  })

  // F1 (P1 finding, review of the first version of this file): the search
  // order MUST resolve the main checkout first, and use the current repo
  // root only when it IS the main checkout or when git resolution is
  // unavailable — never "try the checkout's own root, then fall back to the
  // main checkout," which would let a worktree's own file shadow the
  // durable main-checkout file whenever both exist.
  it("uses ONLY the main-checkout candidate when it resolves to something different from repoRoot", () => {
    const candidates = resolveSigningEnvCandidates({}, "/fake/repo/root", "/fake/cwd", () => "/fake/main/checkout")
    expect(candidates).toEqual([{ path: `/fake/main/checkout/${SIGNING_ENV_FILENAME}`, required: false }])
  })

  it("never produces the repoRoot candidate when a different main checkout root is resolvable (closes the worktree-shadow bug)", () => {
    const candidates = resolveSigningEnvCandidates({}, "/fake/repo/root", "/fake/cwd", () => "/fake/main/checkout")
    expect(candidates.map((c) => c.path)).not.toContain(`/fake/repo/root/${SIGNING_ENV_FILENAME}`)
  })

  it("produces a single candidate (not a duplicate) when the main checkout root equals repoRoot", () => {
    const candidates = resolveSigningEnvCandidates({}, "/fake/repo/root", "/fake/cwd", () => "/fake/repo/root")
    expect(candidates).toEqual([{ path: `/fake/repo/root/${SIGNING_ENV_FILENAME}`, required: false }])
  })

  it("falls back to the repoRoot candidate only when the resolver finds no main checkout at all", () => {
    const candidates = resolveSigningEnvCandidates({}, "/fake/repo/root", "/fake/cwd", () => null)
    expect(candidates).toEqual([{ path: `/fake/repo/root/${SIGNING_ENV_FILENAME}`, required: false }])
  })
})

describe("loadSigningEnv", () => {
  let tmpDir: string | null = null

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it("returns {} (no error) when no candidate exists and no override is set", () => {
    // Every root is arranged, including repoRoot. The old version passed
    // `process.cwd()` and let repoRoot resolve to the REAL checkout, on the
    // stated assumption that it "by design never holds a .env.signing.local".
    // That assumption is false in the main checkout, which is exactly where
    // the file is supposed to live: the test passed only on a machine with no
    // signing configured, and started failing the day someone set it up. A
    // test that breaks when the feature is configured correctly is testing
    // the developer's machine, not the code.
    const emptyDir = mkdtempSync(join(tmpdir(), "desde-signing-env-empty-"))
    tmpDir = emptyDir
    const result = loadSigningEnv({}, emptyDir, () => null, emptyDir)
    expect(result).toEqual({})
  })

  it("reads from the main-checkout-root candidate when it exists", () => {
    const fakeMainCheckout = mkdtempSync(join(tmpdir(), "desde-signing-env-fake-main-"))
    tmpDir = fakeMainCheckout
    writeFileSync(join(fakeMainCheckout, SIGNING_ENV_FILENAME), "APPLE_TEAM_ID=FAKETEAM\n")
    const result = loadSigningEnv({}, process.cwd(), () => fakeMainCheckout)
    expect(result).toEqual({ APPLE_TEAM_ID: "FAKETEAM" })
  })

  // F1 (P1 finding): when the main checkout resolves but has NO signing-env
  // file there, the correct answer is "{}" — not a silent fall-back to this
  // checkout's own root. `process.cwd()` here is the REAL worktree this test
  // suite runs from, which by design never holds a `.env.signing.local` (see
  // tasks/electron-app.md's Part 2 brief) — so this also happens to prove,
  // safely, that nothing in this suite ever falls back to it.
  it("returns {} rather than falling back to repoRoot when the main checkout resolves but has no file there", () => {
    const fakeMainCheckoutNoFile = mkdtempSync(join(tmpdir(), "desde-signing-env-fake-main-empty-"))
    tmpDir = fakeMainCheckoutNoFile
    const result = loadSigningEnv({}, process.cwd(), () => fakeMainCheckoutNoFile)
    expect(result).toEqual({})
  })

  it("parses the file at the override path when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "desde-signing-env-override-"))
    tmpDir = dir
    const filePath = join(dir, "custom.env")
    writeFileSync(filePath, "APPLE_TEAM_ID=FAKETEAM\n")
    const result = loadSigningEnv({ DESDE_SIGNING_ENV: filePath }, dir, () => null)
    expect(result).toEqual({ APPLE_TEAM_ID: "FAKETEAM" })
  })

  it("throws (does not fall back) when the override path does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "desde-signing-env-override-missing-"))
    tmpDir = dir
    const filePath = join(dir, "does-not-exist.env")
    expect(() => loadSigningEnv({ DESDE_SIGNING_ENV: filePath }, dir, () => "/should/never/be/reached")).toThrow(
      /does not point at a file that exists/,
    )
  })
})

describe("resolveMainCheckoutRoot", () => {
  // A throwaway git repo + linked worktree, entirely under a temp directory
  // — never the real desde checkout — so this exercises the real `git
  // rev-parse --git-common-dir` mechanism without depending on (or risking
  // anything in) the actual repo this test suite is running from.
  let mainRepo: string
  let worktreeParent: string
  let worktreeDir: string

  function initFakeRepoWithWorktree(): void {
    mainRepo = mkdtempSync(join(tmpdir(), "desde-signing-env-main-"))
    execFileSync("git", ["init", "-q"], { cwd: mainRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "fake@example.com"], { cwd: mainRepo, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Fake Fixture"], { cwd: mainRepo, stdio: "ignore" })
    writeFileSync(join(mainRepo, "README.md"), "fake fixture repo — not a real project\n")
    execFileSync("git", ["add", "README.md"], { cwd: mainRepo, stdio: "ignore" })
    execFileSync("git", ["commit", "-q", "-m", "fake initial commit"], { cwd: mainRepo, stdio: "ignore" })
    worktreeParent = mkdtempSync(join(tmpdir(), "desde-signing-env-wt-parent-"))
    worktreeDir = join(worktreeParent, "wt")
    execFileSync("git", ["worktree", "add", "-q", worktreeDir, "-b", "fake-branch"], {
      cwd: mainRepo,
      stdio: "ignore",
    })
  }

  afterEach(() => {
    if (mainRepo) rmSync(mainRepo, { recursive: true, force: true })
    if (worktreeParent) rmSync(worktreeParent, { recursive: true, force: true })
  })

  it("resolves to the MAIN checkout root when run from a linked worktree", () => {
    initFakeRepoWithWorktree()
    const resolved = resolveMainCheckoutRoot(worktreeDir)
    expect(resolved).not.toBeNull()
    // realpath both sides: a system tmp dir is frequently itself a symlink
    // (macOS: /tmp -> /private/tmp) and git resolves through it, so a naive
    // string compare would spuriously fail.
    expect(realpathSync(resolved as string)).toBe(realpathSync(mainRepo))
  })

  it("resolves to the same root when run from the main checkout itself (not a worktree)", () => {
    initFakeRepoWithWorktree()
    const resolved = resolveMainCheckoutRoot(mainRepo)
    expect(resolved).not.toBeNull()
    expect(realpathSync(resolved as string)).toBe(realpathSync(mainRepo))
  })

  it("returns null when cwd is not inside a git repo at all", () => {
    const outside = mkdtempSync(join(tmpdir(), "desde-signing-env-no-git-"))
    try {
      expect(resolveMainCheckoutRoot(outside)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
