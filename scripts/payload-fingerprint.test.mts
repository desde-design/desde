/**
 * F9 (whole-branch review, fourth pass, P1 fix) — see
 * `payload-fingerprint.mjs`'s own doc comment for the full reasoning: git
 * cannot see a change to a gitignored built artifact (`editor-cli/dist`,
 * `editor-cli/ui-src/dist`) at ANY scope, and never covered the staging
 * recipe (`build-server-package.mts` itself) at all. Content hashing closes
 * both gaps by reading what is actually on disk, gitignored or not.
 *
 * Tested against a real scratch directory tree on disk — not git, not a
 * mock — since the behavior under test is the file walk and hash itself,
 * which no amount of asserting against a hand-written string could
 * substitute for.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { computePayloadFingerprint, FINGERPRINT_INPUTS } from "./payload-fingerprint.mjs"

describe("computePayloadFingerprint", () => {
  let repo: string

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  /** A minimal tree mirroring every path FINGERPRINT_INPUTS names, plus one deliberately out-of-scope area (docs/) and a repo-root scratch slot. */
  function makeScratchTree(): string {
    const dir = mkdtempSync(join(tmpdir(), "payload-fingerprint-test-"))

    // recipe
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "scripts", "build-server-package.mts"), "// staging recipe v1\n")

    // build-config (F11, whole-branch review, fifth pass, P1 fix)
    mkdirSync(join(dir, "editor-cli"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "package.json"), '{"name":"editor-cli","version":"1.0.0"}\n')
    mkdirSync(join(dir, "editor-cli", "scripts"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "scripts", "build-server.mjs"), "// esbuild invocation v1\n")
    writeFileSync(join(dir, "editor-cli", "tsconfig.json"), '{"compilerOptions":{}}\n')
    mkdirSync(join(dir, "editor-cli", "ui-src"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "ui-src", "vite.config.ts"), "// vite config v1\n")
    writeFileSync(join(dir, "editor-cli", "ui-src", "index.html"), "<!-- vite entry v1 -->\n")

    // built-output
    mkdirSync(join(dir, "editor-cli", "dist"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "dist", "cli.js"), "// server bundle v1\n")

    mkdirSync(join(dir, "editor-cli", "ui-src", "dist"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "ui-src", "dist", "index.html"), "<!-- ui bundle v1 -->\n")

    // source-tree
    mkdirSync(join(dir, "editor-cli", "src"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "src", "cli.ts"), "export {}\n")

    mkdirSync(join(dir, "editor-cli", "ui-src", "src"), { recursive: true })
    writeFileSync(join(dir, "editor-cli", "ui-src", "src", "main.tsx"), "export {}\n")

    mkdirSync(join(dir, "src", "editor"), { recursive: true })
    writeFileSync(join(dir, "src", "editor", "core.ts"), "export {}\n")

    // committed-asset
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "bridge-bundle.js"), "// bridge bundle v1\n")

    mkdirSync(join(dir, "public", "vendor"), { recursive: true })
    writeFileSync(join(dir, "public", "vendor", "html2canvas.min.js"), "// html2canvas v1\n")

    // Deliberately OUT of every fingerprinted path — models docs/, an
    // unrelated repo area, a scratch file at the root.
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "readme.md"), "docs v1\n")

    return dir
  }

  it("is deterministic — the same tree fingerprints identically across two calls", () => {
    repo = makeScratchTree()
    expect(computePayloadFingerprint(repo)).toBe(computePayloadFingerprint(repo))
  })

  /**
   * F9's #2 gap, the reason this module exists at all: editor-cli/dist and
   * editor-cli/ui-src/dist are gitignored, so `git status` — at ANY
   * pathspec scope — structurally cannot report a change here. This is the
   * fingerprint proving what git cannot.
   */
  it("F9: catches a changed BUILT ARTIFACT (editor-cli/dist — gitignored, invisible to git status at any scope)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "dist", "cli.js"), "// server bundle v2 — rebuilt\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("F9: catches a changed built UI ARTIFACT (editor-cli/ui-src/dist — also gitignored)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "ui-src", "dist", "index.html"), "<!-- ui bundle v2 -->\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  /**
   * F9's #1 gap: build-server-package.mts — the staging recipe itself —
   * sat outside every pathspec the git-based check (F2, scoped by F7) ever
   * used. Change what gets copied, or how the manifest is generated, and
   * payload bytes change while a git-based check still reports clean.
   */
  it("F9: catches a changed STAGING RECIPE (scripts/build-server-package.mts itself)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(
      join(repo, "scripts", "build-server-package.mts"),
      "// staging recipe v2 — copy logic changed\n",
    )
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  /**
   * F11 (whole-branch review, fifth pass, P1 fix): five direct staging
   * inputs were outside the hash — each of these determines payload bytes
   * (package metadata copied into the generated manifest, the exact
   * build-config that produces the server/UI bundles) without being
   * application source, so changing one silently left an older manifest's
   * fingerprint matching a NOW-different build.
   */
  it("F11: catches a changed editor-cli/package.json (generatePackageJson reads its name/version/engines into the payload manifest)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "package.json"), '{"name":"editor-cli","version":"2.0.0"}\n')
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("F11: catches a changed editor-cli/scripts/build-server.mjs (the esbuild invocation that produces the server bundle)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "scripts", "build-server.mjs"), "// esbuild invocation v2 — changed\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("F11: catches a changed editor-cli/tsconfig.json (drives module/alias resolution for the server bundle)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "tsconfig.json"), '{"compilerOptions":{"strict":false}}\n')
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("F11: catches a changed editor-cli/ui-src/vite.config.ts (determines the UI bundle)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "ui-src", "vite.config.ts"), "// vite config v2 — changed\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("F11: catches a changed editor-cli/ui-src/index.html (Vite's own entry point for the UI bundle)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "ui-src", "index.html"), "<!-- vite entry v2 — changed -->\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("catches a changed source file inside editor-cli/src", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "src", "scratch.ts"), "export {}\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("catches a changed source file inside editor-cli/ui-src/src", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "ui-src", "src", "scratch.tsx"), "export {}\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("catches a changed source file inside root src/", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "src", "editor", "scratch.ts"), "export {}\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("catches a changed committed asset (dist/bridge-bundle.js)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "dist", "bridge-bundle.js"), "// bridge bundle v2\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("catches a changed committed asset (public/vendor/html2canvas.min.js)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "public", "vendor", "html2canvas.min.js"), "// html2canvas v2\n")
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  /**
   * The exact regression F7 already fixed at the git layer, re-verified at
   * the fingerprint layer: a file OUTSIDE every fingerprinted input must
   * never move the fingerprint. "One proving an unrelated dirty file still
   * does NOT refuse" — the third test the review explicitly asked for.
   */
  it("F9/F7: does NOT change when an unrelated, out-of-scope file changes (docs/)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "docs", "readme.md"), "docs v2 — unrelated edit\n")
    const after = computePayloadFingerprint(repo)
    expect(after).toBe(before)
  })

  it("F9/F7: does NOT change when a new untracked scratch file appears at the repo root", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "notes.txt"), "scratch notes, unrelated to the payload\n")
    const after = computePayloadFingerprint(repo)
    expect(after).toBe(before)
  })

  it("F9/F7: does NOT change when a new file appears inside an unrelated directory modeling a dirty submodule (viewer/)", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    mkdirSync(join(repo, "viewer", "server"), { recursive: true })
    writeFileSync(join(repo, "viewer", "server", "scratch.ts"), "export {}\n")
    const after = computePayloadFingerprint(repo)
    expect(after).toBe(before)
  })

  it("changes when a file is renamed within a fingerprinted tree, even though the surviving content is identical elsewhere", () => {
    repo = makeScratchTree()
    const before = computePayloadFingerprint(repo)
    writeFileSync(join(repo, "editor-cli", "src", "cli-renamed.ts"), "export {}\n")
    rmSync(join(repo, "editor-cli", "src", "cli.ts"))
    const after = computePayloadFingerprint(repo)
    expect(after).not.toBe(before)
  })

  it("tolerates a directory that doesn't exist yet (a fresh checkout before its first editor-cli build)", () => {
    repo = mkdtempSync(join(tmpdir(), "payload-fingerprint-test-empty-"))
    expect(() => computePayloadFingerprint(repo)).not.toThrow()
  })

  it("FINGERPRINT_INPUTS names exactly the documented paths, each tagged with its class, in the documented order", () => {
    expect(FINGERPRINT_INPUTS).toEqual([
      { class: "recipe", kind: "file", path: "scripts/build-server-package.mts" },
      { class: "build-config", kind: "file", path: "editor-cli/package.json" },
      { class: "build-config", kind: "file", path: "editor-cli/scripts/build-server.mjs" },
      { class: "build-config", kind: "file", path: "editor-cli/tsconfig.json" },
      { class: "build-config", kind: "file", path: "editor-cli/ui-src/vite.config.ts" },
      { class: "build-config", kind: "file", path: "editor-cli/ui-src/index.html" },
      { class: "built-output", kind: "dir", path: "editor-cli/dist" },
      { class: "built-output", kind: "dir", path: "editor-cli/ui-src/dist" },
      { class: "source-tree", kind: "dir", path: "editor-cli/src" },
      { class: "source-tree", kind: "dir", path: "editor-cli/ui-src/src" },
      { class: "source-tree", kind: "dir", path: "src" },
      { class: "committed-asset", kind: "file", path: "dist/bridge-bundle.js" },
      { class: "committed-asset", kind: "file", path: "public/vendor/html2canvas.min.js" },
    ])
  })

  it("every FINGERPRINT_INPUTS entry has one of the five documented classes", () => {
    const validClasses = new Set(["recipe", "build-config", "built-output", "source-tree", "committed-asset"])
    for (const input of FINGERPRINT_INPUTS) {
      expect(validClasses.has(input.class), `${input.path} has an unrecognized class: ${input.class}`).toBe(true)
    }
  })
})
