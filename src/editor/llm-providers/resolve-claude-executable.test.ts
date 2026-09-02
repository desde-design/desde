import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { readInstalledClaudeAgentSdkVersion, resolveClaudeRuntimeDir } from "./claude-runtime-location"
import {
  CLAUDE_RUNTIME_MANIFEST_FILE,
  serializeClaudeRuntimeManifest,
} from "./claude-runtime-verify"
import {
  assertClaudeRuntimeReady,
  DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE,
  resolveClaudeExecutablePath,
} from "./resolve-claude-executable"

// The real installed version, read the same way production code does — so
// this test's fixture directory lands at the EXACT path
// resolveClaudeExecutablePath will compute, without hand-guessing a version
// string that could drift from what's actually installed.
const REAL_SDK_VERSION = readInstalledClaudeAgentSdkVersion(import.meta.url)

const FIXTURE_SCRIPT = "#!/bin/sh\necho ok\n"

const tempDirs: string[] = []
function makeTempAppSupportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-runtime-test-"))
  tempDirs.push(dir)
  return dir
}

/**
 * Writes the state a legitimate desktop install leaves behind: the binary
 * PLUS the install-time verification manifest that matches it. Since the
 * resolver now verifies content against the manifest (F2), a bare
 * executable with no record is deliberately NOT enough to resolve.
 */
function installVerifiedFixture(runtimeDir: string, script: string = FIXTURE_SCRIPT): string {
  mkdirSync(runtimeDir, { recursive: true })
  const bin = join(runtimeDir, "claude")
  writeFileSync(bin, script, { mode: 0o755 })
  writeFileSync(
    join(runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE),
    serializeClaudeRuntimeManifest({
      schema: 1,
      sdkVersion: REAL_SDK_VERSION,
      platformPackage: "@anthropic-ai/claude-agent-sdk-test-platform",
      // Must be STRICTLY valid (sha512, 64-byte digest) — the manifest
      // parser rejects anything less (F7).
      tarballIntegrity: `sha512-${createHash("sha512").update("fixture-tarball").digest("base64")}`,
      binarySha256: createHash("sha256").update(script).digest("hex"),
      binarySize: Buffer.byteLength(script),
    }),
  )
  return bin
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("resolveClaudeExecutablePath — terminal CLI (unaffected)", () => {
  it("returns undefined when neither env var is set", () => {
    expect(resolveClaudeExecutablePath({}, import.meta.url)).toBeUndefined()
  })

  it("ignores EDITOR_CLAUDE_RUNTIME_DIR when it points nowhere real", () => {
    const dir = makeTempAppSupportDir()
    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: dir }, import.meta.url),
    ).toBeUndefined()
  })
})

describe("resolveClaudeExecutablePath — EDITOR_CLAUDE_EXECUTABLE_PATH override", () => {
  it("wins when it points at an executable file", () => {
    const dir = makeTempAppSupportDir()
    const bin = join(dir, "my-claude")
    writeFileSync(bin, "#!/bin/sh\necho ok\n", { mode: 0o755 })
    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_EXECUTABLE_PATH: bin }, import.meta.url),
    ).toBe(bin)
  })

  it("falls through when the override path is not executable", () => {
    const dir = makeTempAppSupportDir()
    const notExecutable = join(dir, "not-a-binary.txt")
    writeFileSync(notExecutable, "nope", { mode: 0o644 })
    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_EXECUTABLE_PATH: notExecutable }, import.meta.url),
    ).toBeUndefined()
  })

  it("falls through when the override path does not exist", () => {
    expect(
      resolveClaudeExecutablePath(
        { EDITOR_CLAUDE_EXECUTABLE_PATH: "/definitely/not/here/claude" },
        import.meta.url,
      ),
    ).toBeUndefined()
  })

  it("is IGNORED under Desde (F5) — an inherited env var must not route around verification", () => {
    // The attack shape: Electron inherits EDITOR_CLAUDE_EXECUTABLE_PATH
    // from its launch environment and passes env down to every child; the
    // override branch used to return ANY X_OK file before verification ran.
    const dir = makeTempAppSupportDir()
    const evil = join(dir, "evil-claude")
    writeFileSync(evil, "#!/bin/sh\necho evil\n", { mode: 0o755 })

    // Under Desde (EDITOR_CLAUDE_RUNTIME_DIR set) with NO verified install:
    // the override must NOT be returned — the resolver refuses instead.
    const appSupportDir = makeTempAppSupportDir()
    expect(
      resolveClaudeExecutablePath(
        { EDITOR_CLAUDE_EXECUTABLE_PATH: evil, EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir },
        import.meta.url,
      ),
    ).toBeUndefined()
  })

  it("under Desde with a VERIFIED install, the verified path wins over the override", () => {
    const dir = makeTempAppSupportDir()
    const evil = join(dir, "evil-claude")
    writeFileSync(evil, "#!/bin/sh\necho evil\n", { mode: 0o755 })

    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    const verified = installVerifiedFixture(runtimeDir)

    expect(
      resolveClaudeExecutablePath(
        { EDITOR_CLAUDE_EXECUTABLE_PATH: evil, EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir },
        import.meta.url,
      ),
    ).toBe(verified)
  })
})

describe("resolveClaudeExecutablePath — desktop well-known location", () => {
  it("finds a verified binary (content-checked against its install manifest) at the version-keyed path", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    const bin = installVerifiedFixture(runtimeDir)

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBe(bin)
  })

  it("refuses a bare executable with NO install-time manifest — unverified is never resolved", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, "claude"), FIXTURE_SCRIPT, { mode: 0o755 })

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })

  it("refuses a symlink planted at the runtime path, even one pointing at a real executable", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    const bin = installVerifiedFixture(runtimeDir)
    rmSync(bin)
    symlinkSync("/bin/sh", bin)

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })

  it("refuses a binary corrupted after install even though it kept its executable bit", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    const bin = installVerifiedFixture(runtimeDir)
    writeFileSync(bin, FIXTURE_SCRIPT.replace("echo ok", "echo no"), { mode: 0o755 })

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })

  it("returns undefined when the version directory exists but the binary is missing", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    mkdirSync(runtimeDir, { recursive: true })
    // No `claude` file written — install never completed.

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })

  it("returns undefined when the file exists but lacks the executable bit", () => {
    const appSupportDir = makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: REAL_SDK_VERSION })
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, "claude"), "not actually executable", { mode: 0o644 })

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })

  it("does not match a DIFFERENT version's directory", () => {
    const appSupportDir = makeTempAppSupportDir()
    const wrongVersionDir = resolveClaudeRuntimeDir({
      appSupportDir,
      sdkVersion: `${REAL_SDK_VERSION}-not-the-real-one`,
    })
    mkdirSync(wrongVersionDir, { recursive: true })
    writeFileSync(join(wrongVersionDir, "claude"), "#!/bin/sh\necho ok\n", { mode: 0o755 })

    expect(
      resolveClaudeExecutablePath({ EDITOR_CLAUDE_RUNTIME_DIR: appSupportDir }, import.meta.url),
    ).toBeUndefined()
  })
})

describe("assertClaudeRuntimeReady", () => {
  it("throws the actionable message when unresolved under Desde", () => {
    expect(() =>
      assertClaudeRuntimeReady(undefined, { EDITOR_CLAUDE_RUNTIME_DIR: "/some/dir" }),
    ).toThrow(DESKTOP_CLAUDE_RUNTIME_NOT_READY_MESSAGE)
  })

  it("is a no-op on the terminal CLI (no EDITOR_CLAUDE_RUNTIME_DIR)", () => {
    expect(() => assertClaudeRuntimeReady(undefined, {})).not.toThrow()
  })

  it("is a no-op once a path has been resolved", () => {
    expect(() =>
      assertClaudeRuntimeReady("/some/resolved/claude", { EDITOR_CLAUDE_RUNTIME_DIR: "/some/dir" }),
    ).not.toThrow()
  })
})
