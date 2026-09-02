import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  checkPayloadFreshness,
  checkPayloadHostMatch,
  isPayloadInputsDirty,
  PAYLOAD_INPUT_PATHSPECS,
  readPayloadManifest,
  shellQuote,
  type ManifestReadResult,
} from "../scripts/payload-manifest-guard.mjs"

describe("shellQuote", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shellQuote("/tmp/pt-payload")).toBe("'/tmp/pt-payload'")
  })

  it("makes a path containing spaces safe against word-splitting", () => {
    // The whole point: an unquoted `--out /Users/mo/Proto Tools/payload`
    // would hand the shell FOUR words instead of one, and
    // build-server-package.mts's parseArgs would reject the stray
    // "Tools/payload" as an unrecognized argument.
    expect(shellQuote("/Users/mo/Proto Tools/payload")).toBe("'/Users/mo/Proto Tools/payload'")
  })

  it("escapes an embedded single quote instead of producing a broken quote", () => {
    // `'` can't appear literally inside a single-quoted string — the
    // standard close-escape-reopen technique: 'it -> 'it'\''s
    expect(shellQuote("/Users/mo's mac/payload")).toBe(`'/Users/mo'\\''s mac/payload'`)
  })
})

describe("checkPayloadHostMatch", () => {
  const payloadDir = "/tmp/pt-payload"

  it("passes when platform and arch both match the host", () => {
    const result = checkPayloadHostMatch(
      { status: "ok", manifestPath: `${payloadDir}/payload-manifest.json`, platform: "darwin", arch: "arm64" },
      "darwin",
      "arm64",
      payloadDir,
    )
    expect(result).toEqual({ ok: true })
  })

  it("refuses when arch differs (same platform)", () => {
    const result = checkPayloadHostMatch(
      { status: "ok", manifestPath: `${payloadDir}/payload-manifest.json`, platform: "darwin", arch: "x64" },
      "darwin",
      "arm64",
      payloadDir,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    // Names expected vs found platform/arch, the payload path, and the rebuild command.
    expect(result.message).toContain("staged for darwin/x64")
    expect(result.message).toContain("packaging host is darwin/arm64")
    expect(result.message).toContain(payloadDir)
    expect(result.message).toContain(`npm run build:payload -- --out ${shellQuote(payloadDir)}`)
  })

  it("refuses when platform differs (same arch)", () => {
    const result = checkPayloadHostMatch(
      { status: "ok", manifestPath: `${payloadDir}/payload-manifest.json`, platform: "linux", arch: "arm64" },
      "darwin",
      "arm64",
      payloadDir,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain("staged for linux/arm64")
    expect(result.message).toContain("packaging host is darwin/arm64")
  })

  it("mismatch rebuild command is shell-safe for a payload path containing spaces", () => {
    const spacedDir = "/Users/mo/Proto Tools/.payload-cache"
    const result = checkPayloadHostMatch(
      { status: "ok", manifestPath: `${spacedDir}/payload-manifest.json`, platform: "darwin", arch: "x64" },
      "darwin",
      "arm64",
      spacedDir,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain(`npm run build:payload -- --out ${shellQuote(spacedDir)}`)
    // The unquoted, word-splitting form must NOT appear.
    expect(result.message).not.toContain(`--out ${spacedDir}\n`)
  })

  it("refuses when the manifest is missing, and does not hand out a rebuild command that fails", () => {
    const manifestPath = `${payloadDir}/payload-manifest.json`
    const result = checkPayloadHostMatch({ status: "missing", manifestPath }, "darwin", "arm64", payloadDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain(manifestPath)
    expect(result.message).toContain("does not exist")
    // This is the Task 0 fix: package.mjs only reaches this branch after
    // confirming dist/cli.js exists, so the directory is non-empty —
    // build-server-package.mts's cleanDestination() would refuse to write
    // into it without a marker file, so the message must say so and tell
    // the user to clear the path first, not just repeat the plain command.
    expect(result.message).toContain("is not empty")
    expect(result.message).toContain("rm -rf")
    expect(result.message).toContain(`rm -rf ${shellQuote(payloadDir)}`)
    expect(result.message).toContain(`npm run build:payload -- --out ${shellQuote(payloadDir)}`)
    // Also offers a fresh-path alternative that needs no removal.
    expect(result.message).toContain("stage into a fresh path")
  })

  it("missing-manifest rebuild instructions are shell-safe for a payload path containing spaces", () => {
    const spacedDir = "/Users/mo/Proto Tools/.payload-cache"
    const manifestPath = `${spacedDir}/payload-manifest.json`
    const result = checkPayloadHostMatch({ status: "missing", manifestPath }, "darwin", "arm64", spacedDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain(`rm -rf ${shellQuote(spacedDir)}`)
    expect(result.message).not.toContain(`rm -rf ${spacedDir}\n`)
  })

  it("refuses when the manifest is malformed", () => {
    const manifestPath = `${payloadDir}/payload-manifest.json`
    const result = checkPayloadHostMatch(
      { status: "malformed", manifestPath, reason: "Unexpected token } in JSON at position 4" },
      "darwin",
      "arm64",
      payloadDir,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain(manifestPath)
    expect(result.message).toContain("could not be read")
    expect(result.message).toContain("Unexpected token")
    // The malformed branch's directory DOES contain payload-manifest.json
    // (it just failed to parse) — cleanDestination() matches on filename
    // presence only, so the plain rebuild command works here and should
    // still be offered unmodified (just shell-quoted).
    expect(result.message).toContain(`npm run build:payload -- --out ${shellQuote(payloadDir)}`)
  })
})

describe("readPayloadManifest", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("reads a well-formed manifest", () => {
    dir = mkdtempSync(join(tmpdir(), "pt-manifest-"))
    writeFileSync(join(dir, "payload-manifest.json"), JSON.stringify({ platform: "darwin", arch: "arm64" }))
    expect(readPayloadManifest(dir)).toEqual({
      status: "ok",
      manifestPath: join(dir, "payload-manifest.json"),
      platform: "darwin",
      arch: "arm64",
    })
  })

  it("reports missing when payload-manifest.json is absent", () => {
    dir = mkdtempSync(join(tmpdir(), "pt-manifest-"))
    const result = readPayloadManifest(dir)
    expect(result.status).toBe("missing")
  })

  it("reports malformed for unparseable JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "pt-manifest-"))
    writeFileSync(join(dir, "payload-manifest.json"), "{ not valid json")
    const result = readPayloadManifest(dir)
    expect(result.status).toBe("malformed")
  })

  it("reports malformed when platform/arch fields are missing", () => {
    dir = mkdtempSync(join(tmpdir(), "pt-manifest-"))
    writeFileSync(join(dir, "payload-manifest.json"), JSON.stringify({ gitCommit: "abc123" }))
    const result = readPayloadManifest(dir)
    expect(result.status).toBe("malformed")
  })

  it("F2: carries gitCommit through when present", () => {
    dir = mkdtempSync(join(tmpdir(), "pt-manifest-"))
    writeFileSync(
      join(dir, "payload-manifest.json"),
      JSON.stringify({ platform: "darwin", arch: "arm64", gitCommit: "abc123-dirty" }),
    )
    const result = readPayloadManifest(dir)
    expect(result).toEqual({
      status: "ok",
      manifestPath: join(dir, "payload-manifest.json"),
      platform: "darwin",
      arch: "arm64",
      gitCommit: "abc123-dirty",
    })
  })
})

/**
 * F2 (whole-branch review, Important) → F7 (P1 fix, git-scoped) → F9
 * (whole-branch review, fourth pass, P1 fix: fingerprint-based) — see
 * `payload-manifest-guard.mjs`'s `checkPayloadFreshness` doc comment for the
 * full failure mode: `--payload-dir <weeks-old-dir> --sign` could silently
 * produce a signed app whose server is weeks older than its shell, and
 * neither a plain commit compare (F2) nor a git-scoped dirty compare (F7)
 * can see a change to a gitignored built artifact or to the staging recipe
 * itself — only a content fingerprint can.
 */
describe("checkPayloadFreshness", () => {
  const manifestPath = "/tmp/pt-payload/payload-manifest.json"
  const okAt = (payloadFingerprint: string, gitCommit = "abc123"): ManifestReadResult => ({
    status: "ok",
    manifestPath,
    platform: "darwin",
    arch: "arm64",
    gitCommit,
    payloadFingerprint,
  })
  /** The packaging checkout's current state: its fingerprint (the decision), and commit/dirty (message context only). */
  const current = (fingerprint: string, commit = "abc123", dirty = false) => ({ commit, dirty, fingerprint })

  it("passes silently when the fingerprint matches exactly", () => {
    const result = checkPayloadFreshness(okAt("fp-1"), current("fp-1"), { signing: false, allowStale: false })
    expect(result).toEqual({ ok: true, warning: null })
  })

  // F10 (whole-branch review, fifth pass, P1 fix): a manifest predating
  // payloadFingerprint does NOT pass silently — it falls back to the
  // gitCommit comparison and refuses under --sign unconditionally (an
  // unverifiable payload is never the quiet-success path). See the
  // dedicated "F10: fingerprint-less manifest" block below for the full
  // coverage; this block only covers the ONE case that genuinely has
  // nothing to compare at all (no gitCommit either).
  it("passes silently (nothing to compare) ONLY when the manifest has neither payloadFingerprint NOR gitCommit", () => {
    const noCommitNoFingerprint: ManifestReadResult = {
      status: "ok",
      manifestPath,
      platform: "darwin",
      arch: "arm64",
    }
    const result = checkPayloadFreshness(noCommitNoFingerprint, current("fp-1"), {
      signing: true,
      allowStale: false,
    })
    expect(result).toEqual({ ok: true, warning: null })
  })

  it("passes silently for an unidentifiable manifest — checkPayloadHostMatch already refused it earlier", () => {
    const missing: ManifestReadResult = { status: "missing", manifestPath }
    const result = checkPayloadFreshness(missing, current("fp-1"), { signing: true, allowStale: false })
    expect(result).toEqual({ ok: true, warning: null })
  })

  it("warns (does not refuse) on a fingerprint mismatch when NOT signing", () => {
    const result = checkPayloadFreshness(okAt("fp-old"), current("fp-new"), {
      signing: false,
      allowStale: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.warning).toContain(manifestPath)
    expect(result.warning).toContain("fingerprint")
  })

  it("REFUSES a fingerprint mismatch under --sign with no override", () => {
    const result = checkPayloadFreshness(okAt("fp-old"), current("fp-new"), {
      signing: true,
      allowStale: false,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.message).toContain("Refusing to SIGN")
    expect(result.message).toContain("--allow-stale-payload")
  })

  it("--allow-stale-payload lets a stale payload through even under --sign, still with a warning", () => {
    const result = checkPayloadFreshness(okAt("fp-old"), current("fp-new"), {
      signing: true,
      allowStale: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.warning).not.toBeNull()
  })

  /**
   * F9's whole point, restated as a test: a fingerprint mismatch is flagged
   * even when git's own signals (commit, dirty) show nothing wrong — this
   * is exactly the "editor-cli/dist rebuilt, nothing committed, working
   * tree clean" case a git-based check (F2, even F7) could never catch,
   * because rebuilding a gitignored artifact leaves git with nothing to
   * report at any pathspec scope.
   */
  it("F9: a fingerprint mismatch is flagged EVEN when the commit matches exactly and the checkout is clean", () => {
    const result = checkPayloadFreshness(okAt("fp-old", "abc123"), current("fp-new", "abc123", false), {
      signing: false,
      allowStale: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.warning).not.toBeNull()
  })

  /**
   * The other half of "the fingerprint decides": a MATCHING fingerprint is
   * trusted even when git's own signals look stale (a dirty tree, a
   * different commit) — those are message-context now, not the decision.
   * This is the mirror image of F7's own fix (an unrelated dirty file must
   * not cause a false refusal) generalized past git entirely: an unrelated
   * COMMITTED change that never touched a payload input must not either.
   */
  it("F9: a fingerprint MATCH is trusted even when the checkout is dirty or the commit differs", () => {
    const result = checkPayloadFreshness(okAt("fp-1", "old-commit"), current("fp-1", "new-commit", true), {
      signing: true,
      allowStale: false,
    })
    expect(result).toEqual({ ok: true, warning: null })
  })

  it("names both the commit and the dirty state in the message — the fingerprint decides, the commit explains", () => {
    const result = checkPayloadFreshness(okAt("fp-old", "old111"), current("fp-new", "new222", true), {
      signing: false,
      allowStale: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.warning).toContain("old111")
    expect(result.warning).toContain("new222")
    expect(result.warning).toContain("uncommitted changes")
  })

  it("the message still reads sensibly when the manifest has a fingerprint but no gitCommit", () => {
    const noCommitButFingerprint: ManifestReadResult = {
      status: "ok",
      manifestPath,
      platform: "darwin",
      arch: "arm64",
      payloadFingerprint: "fp-old",
    }
    const result = checkPayloadFreshness(noCommitButFingerprint, current("fp-new"), {
      signing: false,
      allowStale: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.warning).not.toBeNull()
    expect(result.warning).not.toContain("staged from undefined")
  })

  /**
   * F10 (whole-branch review, fifth pass, P1 fix): a payload staged BEFORE
   * `payloadFingerprint` existed has `gitCommit` but no `payloadFingerprint`
   * — reachable TODAY, since `desktop/.payload-cache` (or any cached
   * `--payload-dir`) may hold exactly such a manifest right now. The bug:
   * the fingerprint branch's own guard (`typeof payloadFingerprint ===
   * "string"`) simply fell through to `{ ok: true, warning: null }` for
   * this case — a TOTAL BYPASS, silently packaging (and signing) an
   * arbitrarily old cached payload with no warning at all. This is the
   * test that would fail against that code: it asserts a WARNING (never
   * silence) and, under --sign, a REFUSAL (never a quiet pass) — even in
   * the most dangerous sub-case, where the fallback commit compare finds
   * nothing wrong, because "I cannot verify this" must never look like "it
   * is fine".
   */
  describe("F10: fingerprint-less manifest (a payload staged before payloadFingerprint existed)", () => {
    const fingerprintLessAt = (gitCommit: string): ManifestReadResult => ({
      status: "ok",
      manifestPath,
      platform: "darwin",
      arch: "arm64",
      gitCommit,
      // No payloadFingerprint field at all — the exact shape of a manifest
      // staged before this build gained one.
    })

    it("does NOT silently pass — surfaces a warning even when NOT signing", () => {
      const result = checkPayloadFreshness(fingerprintLessAt("abc123"), current("fp-anything", "abc123", false), {
        signing: false,
        allowStale: false,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")
      expect(result.warning).not.toBeNull()
      expect(result.warning).toContain("cannot be fully verified")
    })

    it("REFUSES under --sign with no override, even when the fallback commit compare finds NOTHING wrong (clean, matching commit) — the exact bypass this closes", () => {
      const result = checkPayloadFreshness(fingerprintLessAt("abc123"), current("fp-anything", "abc123", false), {
        signing: true,
        allowStale: false,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.message).toContain("Refusing to SIGN")
      expect(result.message).toContain("UNVERIFIABLE")
      expect(result.message).toContain("--allow-stale-payload")
    })

    it("REFUSES under --sign even more so when the fallback ALSO finds a commit mismatch", () => {
      const result = checkPayloadFreshness(fingerprintLessAt("old111"), current("fp-anything", "new222", false), {
        signing: true,
        allowStale: false,
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.message).toContain("Refusing to SIGN")
      expect(result.message).toContain("old111")
      expect(result.message).toContain("new222")
    })

    it("REFUSES under --sign when the fallback finds the PAYLOAD itself was staged dirty", () => {
      const result = checkPayloadFreshness(
        fingerprintLessAt("abc123-dirty"),
        current("fp-anything", "abc123", false),
        { signing: true, allowStale: false },
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("unreachable")
      expect(result.message).toContain("Refusing to SIGN")
    })

    it("--allow-stale-payload overrides the refusal, still with a warning naming the unverifiable state", () => {
      const result = checkPayloadFreshness(fingerprintLessAt("abc123"), current("fp-anything", "abc123", false), {
        signing: true,
        allowStale: true,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")
      expect(result.warning).not.toBeNull()
      expect(result.warning).toContain("cannot be fully verified")
    })

    it("the warning names the degraded-signal caveat explicitly when the fallback finds no discrepancy — a clean commit compare is not proof", () => {
      const result = checkPayloadFreshness(fingerprintLessAt("abc123"), current("fp-anything", "abc123", false), {
        signing: false,
        allowStale: false,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("unreachable")
      expect(result.warning).toContain("degraded signal")
      expect(result.warning).toContain("gitignored built artifact")
    })
  })
})

/**
 * F7 (whole-branch review, third pass, P1 fix) — see
 * `payload-manifest-guard.mjs`'s `PAYLOAD_INPUT_PATHSPECS` doc comment for
 * the full reasoning. The P1 (F2) fix compared the packaging checkout's
 * dirty state, but computed it from an UNSCOPED `git status --porcelain` —
 * so reusing a clean payload after adding an unrelated untracked file (a
 * scratch notes.txt, an edit to docs/) made a `--sign` build refuse
 * unconditionally even though nothing the payload contains had changed.
 *
 * Tested against a REAL git repo (same pattern
 * `build-server-package.test.mts` already uses for `isWorkingTreeDirty`),
 * not a mocked git call — the behavior under test IS the pathspec argument
 * actually reaching `git status`, which no amount of asserting against a
 * hand-written string can substitute for.
 */
describe("isPayloadInputsDirty", () => {
  let repo: string

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  /** A minimal git repo mirroring the real payload-relevant layout, with everything committed. */
  function makeScratchRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "payload-manifest-guard-git-test-"))
    const git = (...args: string[]) => {
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com" },
      })
    }
    git("init", "--quiet")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "test")

    mkdirSync(join(dir, "editor-cli", "src"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "src", "index.ts"), "export {}\n")
    mkdirSync(join(dir, "src", "editor"), { recursive: true })
    writeFileSync(join(dir, "src", "editor", "core.ts"), "export {}\n")
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "bridge-bundle.js"), "// bridge bundle\n")
    mkdirSync(join(dir, "public", "vendor"), { recursive: true })
    writeFileSync(join(dir, "public", "vendor", "html2canvas.min.js"), "// html2canvas\n")
    // A non-payload area, present from the start so "untouched since commit"
    // tests below have somewhere real to add files under.
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "readme.md"), "docs\n")

    git("add", "-A")
    git("commit", "--quiet", "-m", "initial")
    return dir
  }

  it("reports NOT dirty on a clean tree", () => {
    repo = makeScratchRepo()
    expect(isPayloadInputsDirty(repo)).toBe(false)
  })

  /**
   * The exact regression named by the review: an untracked file OUTSIDE
   * every payload-input path (a scratch notes.txt at the repo root) must
   * NOT be reported dirty. The pre-fix, unscoped `git status --porcelain`
   * (no pathspec) would have reported this as dirty, incorrectly refusing a
   * `--sign` build that changed nothing the payload contains.
   */
  it("F7: does NOT report dirty for an untracked file OUTSIDE all payload-input paths (a scratch notes.txt at the repo root)", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "notes.txt"), "scratch notes, unrelated to the payload\n")
    expect(isPayloadInputsDirty(repo)).toBe(false)
  })

  it("F7: does NOT report dirty for a change inside docs/ (an unrelated tracked area)", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "docs", "readme.md"), "docs, but different now\n")
    expect(isPayloadInputsDirty(repo)).toBe(false)
  })

  it("F7: does NOT report dirty for an untracked directory modeling an unrelated dirty submodule (e.g. viewer/)", () => {
    repo = makeScratchRepo()
    mkdirSync(join(repo, "viewer", "server"), { recursive: true })
    writeFileSync(join(repo, "viewer", "server", "scratch.ts"), "export {}\n")
    expect(isPayloadInputsDirty(repo)).toBe(false)
  })

  it("reports dirty for an untracked file INSIDE editor-cli/", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "editor-cli", "src", "scratch.ts"), "export {}\n")
    expect(isPayloadInputsDirty(repo)).toBe(true)
  })

  it("reports dirty for an untracked file INSIDE root src/", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "src", "editor", "scratch.ts"), "export {}\n")
    expect(isPayloadInputsDirty(repo)).toBe(true)
  })

  it("reports dirty for a MODIFIED dist/bridge-bundle.js", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "dist", "bridge-bundle.js"), "// changed\n")
    expect(isPayloadInputsDirty(repo)).toBe(true)
  })

  it("reports dirty for a MODIFIED public/vendor/html2canvas.min.js", () => {
    repo = makeScratchRepo()
    writeFileSync(join(repo, "public", "vendor", "html2canvas.min.js"), "// changed\n")
    expect(isPayloadInputsDirty(repo)).toBe(true)
  })

  it("PAYLOAD_INPUT_PATHSPECS covers exactly editor-cli, src, dist/bridge-bundle.js, and public/vendor/html2canvas.min.js", () => {
    expect(PAYLOAD_INPUT_PATHSPECS).toEqual([
      "editor-cli",
      "src",
      "dist/bridge-bundle.js",
      "public/vendor/html2canvas.min.js",
    ])
  })
})
