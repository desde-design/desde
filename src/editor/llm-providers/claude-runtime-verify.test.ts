import { createHash } from "node:crypto"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveClaudeExecutablePathIn } from "./claude-runtime-location"
import {
  CLAUDE_RUNTIME_MANIFEST_FILE,
  hashFileSha256Sync,
  isWellFormedSri,
  parseClaudeRuntimeManifest,
  parseSriTokens,
  serializeClaudeRuntimeManifest,
  sriIntersects,
  verifyInstalledClaudeRuntime,
  type ClaudeRuntimeManifest,
} from "./claude-runtime-verify"

const SDK_VERSION = "0.3.143-test"
const TARBALL_SRI = "sha512-41WuTuP+bk4NxrjpG9IJGffsjh1ivyiiAmqgb5QoxPltDAA0p3gs+iZ3lTgDmY4Ga68wDoN05Lt18oCE+DQb7g=="
/** A DIFFERENT but strictly-valid sha512 SRI — 64-byte digest, canonical padded base64. */
const OTHER_SRI = `sha512-${createHash("sha512").update("a different tarball").digest("base64")}`
/** A strictly-INVALID token that the OLD loose parser accepted: valid base64, far short of 64 bytes. */
const TRUNCATED_SHA512 = "sha512-A"
/** A well-formed sha256 SRI — rejected on ALGORITHM, not shape: the anchor pipeline is sha512-only. */
const SHA256_SRI = `sha256-${createHash("sha256").update("x").digest("base64")}`
const SCRIPT = "#!/bin/sh\necho fake-1.0.0\n"

const tempDirs: string[] = []
function makeRuntimeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-runtime-verify-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

/** Writes a binary + a manifest that MATCHES it — the state a legitimate install leaves behind. */
function installFixture(runtimeDir: string, script: string = SCRIPT): { binPath: string; manifest: ClaudeRuntimeManifest } {
  mkdirSync(runtimeDir, { recursive: true })
  const binPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })
  writeFileSync(binPath, script, { mode: 0o755 })
  const manifest: ClaudeRuntimeManifest = {
    schema: 1,
    sdkVersion: SDK_VERSION,
    platformPackage: "@anthropic-ai/claude-agent-sdk-test-platform",
    tarballIntegrity: TARBALL_SRI,
    binarySha256: sha256Hex(script),
    binarySize: Buffer.byteLength(script),
  }
  writeFileSync(join(runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE), serializeClaudeRuntimeManifest(manifest))
  return { binPath, manifest }
}

describe("SRI helpers — STRICT sha512-only parsing (F7)", () => {
  it("parses a canonical sha512 token and drops everything else", () => {
    expect(parseSriTokens(TARBALL_SRI)).toEqual([TARBALL_SRI])
    expect(parseSriTokens(`${SHA256_SRI} ${TARBALL_SRI}`)).toEqual([TARBALL_SRI]) // sha256 dropped, sha512 kept
    expect(parseSriTokens("md5-nope")).toEqual([])
    expect(parseSriTokens("sha512")).toEqual([])
    expect(parseSriTokens("")).toEqual([])
  })

  it("rejects a TRUNCATED sha512 digest — the shape that would brick shipping if it passed the build gate", () => {
    // `sha512-A` is valid base64, so the old loose pattern accepted it; no
    // real tarball can ever hash to it, so a build carrying it would fail
    // EINTEGRITY on every user's machine. Strictness (86 chars + `==`,
    // decoding to exactly 64 bytes) is what lets the BUILD catch it.
    expect(parseSriTokens(TRUNCATED_SHA512)).toEqual([])
    expect(isWellFormedSri(TRUNCATED_SHA512)).toBe(false)
    expect(isWellFormedSri(`sha512-${"A".repeat(43)}=`)).toBe(false) // 32 bytes — sha256-length digest under a sha512 label
  })

  it("F9: rejects NONCANONICAL base64 (nonzero unused padding bits) via decode→re-encode round-trip", () => {
    // 'g' (alphabet index 32 — low 4 bits zero, canonical for the final
    // char of an 86-char sha512 token) changed to 'h' (index 33): the token
    // still matches the regex and still DECODES to exactly 64 bytes, so
    // both pre-F9 checks pass it — but ssri/pacote reject that exact string
    // at verification time, so accepting it here would let a malformed
    // lockfile clear the build gate and EINTEGRITY-fail every shipped
    // install. Only a canonical round-trip closes this.
    const noncanonical = `${TARBALL_SRI.slice(0, -3)}h==`
    expect(noncanonical).not.toBe(TARBALL_SRI)
    expect(Buffer.from(noncanonical.slice("sha512-".length), "base64")).toHaveLength(64) // the OLD checks passed it
    expect(parseSriTokens(noncanonical)).toEqual([])
    expect(isWellFormedSri(noncanonical)).toBe(false)
    expect(sriIntersects(noncanonical, noncanonical)).toBe(false)
  })

  it("rejects sha256/sha384 tokens outright — the anchor pipeline is sha512-only", () => {
    expect(parseSriTokens(SHA256_SRI)).toEqual([])
    expect(isWellFormedSri(SHA256_SRI)).toBe(false)
    expect(isWellFormedSri(`sha384-${createHash("sha384").update("x").digest("base64")}`)).toBe(false)
  })

  it("isWellFormedSri is the fail-closed gate", () => {
    expect(isWellFormedSri(TARBALL_SRI)).toBe(true)
    expect(isWellFormedSri(OTHER_SRI)).toBe(true)
    expect(isWellFormedSri("")).toBe(false)
    expect(isWellFormedSri("latest")).toBe(false)
  })

  it("sriIntersects requires an exact shared sha512 token — and NEVER passes on two empty sets", () => {
    expect(sriIntersects(TARBALL_SRI, TARBALL_SRI)).toBe(true)
    expect(sriIntersects(TARBALL_SRI, `${SHA256_SRI} ${TARBALL_SRI}`)).toBe(true)
    expect(sriIntersects(TARBALL_SRI, OTHER_SRI)).toBe(false)
    expect(sriIntersects("", "")).toBe(false)
    expect(sriIntersects("garbage", "garbage")).toBe(false)
    expect(sriIntersects(TRUNCATED_SHA512, TRUNCATED_SHA512)).toBe(false) // two identical INVALID tokens still never match
  })
})

describe("parseClaudeRuntimeManifest", () => {
  const valid: ClaudeRuntimeManifest = {
    schema: 1,
    sdkVersion: SDK_VERSION,
    platformPackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    tarballIntegrity: TARBALL_SRI,
    binarySha256: sha256Hex(SCRIPT),
    binarySize: 42,
  }

  it("round-trips through the serializer", () => {
    expect(parseClaudeRuntimeManifest(serializeClaudeRuntimeManifest(valid))).toEqual(valid)
  })

  it.each([
    ["not JSON", "{{{"],
    ["not an object", "42"],
    ["wrong schema", JSON.stringify({ ...valid, schema: 2 })],
    ["empty sdkVersion", JSON.stringify({ ...valid, sdkVersion: "" })],
    ["malformed tarball SRI", JSON.stringify({ ...valid, tarballIntegrity: "trust-me" })],
    ["malformed sha256 (not hex)", JSON.stringify({ ...valid, binarySha256: "xyz" })],
    ["non-integer size", JSON.stringify({ ...valid, binarySize: 1.5 })],
    ["zero size", JSON.stringify({ ...valid, binarySize: 0 })],
  ])("rejects %s", (_label, raw) => {
    expect(parseClaudeRuntimeManifest(raw)).toBeNull()
  })
})

describe("hashFileSha256Sync", () => {
  it("matches node:crypto over the same bytes", () => {
    const dir = makeRuntimeDir()
    const file = join(dir, "blob")
    writeFileSync(file, SCRIPT)
    expect(hashFileSha256Sync(file)).toBe(sha256Hex(SCRIPT))
  })
})

describe("verifyInstalledClaudeRuntime — the F2 checks", () => {
  it("passes a legitimate install", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toEqual({ ok: true, path: binPath })
  })

  it("rejects a missing binary", () => {
    const runtimeDir = makeRuntimeDir()
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "binary-missing" })
  })

  it("rejects a SYMLINK at the runtime path even when its target is executable (no-follow)", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    // Replace the real binary with a symlink to a genuinely executable file
    // — the exact planted-symlink shape F2 describes. An access(X_OK) check
    // follows the link and passes; lstat must refuse.
    rmSync(binPath)
    symlinkSync("/bin/sh", binPath)
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "not-a-regular-file" })
  })

  it("rejects a corrupted-but-still-executable binary (content hash mismatch)", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    // Same length, same mode, different bytes — only the content check can see this.
    const corrupted = SCRIPT.replace("fake-1.0.0", "evil-1.0.0")
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(SCRIPT))
    writeFileSync(binPath, corrupted, { mode: 0o755 })
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" })
  })

  it("rejects a truncated binary via the cheap size check", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    writeFileSync(binPath, SCRIPT.slice(0, 5), { mode: 0o755 })
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "size-mismatch" })
  })

  it("rejects when the executable bit is missing", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    chmodSync(binPath, 0o644) // writeFileSync's `mode` only applies at creation — chmod the existing file
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "not-executable" })
  })

  it("rejects when there is no manifest at all — an unverified install is never trusted", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    rmSync(join(runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE))
    expect(lstatSync(binPath).isFile()).toBe(true) // binary itself is fine — the RECORD is what's missing
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "manifest-missing" })
  })

  it("rejects a malformed manifest", () => {
    const runtimeDir = makeRuntimeDir()
    installFixture(runtimeDir)
    writeFileSync(join(runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE), "not json at all")
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "manifest-invalid" })
  })

  it("rejects a manifest recorded for a different sdkVersion", () => {
    const runtimeDir = makeRuntimeDir()
    installFixture(runtimeDir)
    const result = verifyInstalledClaudeRuntime({
      runtimeDir,
      platform: process.platform,
      sdkVersion: `${SDK_VERSION}-other`,
    })
    expect(result).toMatchObject({ ok: false, reason: "manifest-mismatch" })
  })

  it("pins the manifest's tarball integrity to the shipped anchor when the caller provides one", () => {
    const runtimeDir = makeRuntimeDir()
    installFixture(runtimeDir)
    expect(
      verifyInstalledClaudeRuntime({
        runtimeDir,
        platform: process.platform,
        sdkVersion: SDK_VERSION,
        expectedTarballIntegrity: TARBALL_SRI,
      }).ok,
    ).toBe(true)
    expect(
      verifyInstalledClaudeRuntime({
        runtimeDir,
        platform: process.platform,
        sdkVersion: SDK_VERSION,
        expectedTarballIntegrity: OTHER_SRI,
      }),
    ).toMatchObject({ ok: false, reason: "manifest-mismatch" })
  })
})

describe("verifyInstalledClaudeRuntime — the hash runs on EVERY call, never from a cache (F6)", () => {
  // WHY there is no cache: on macOS a same-user process can rewrite a
  // writable MAP_SHARED mapping of the file without msync — the changed
  // bytes are immediately live for reads and execution while mtime/ctime
  // may keep their old values until the mapping is flushed. Any cache keyed
  // on stat identity therefore re-serves a stale "verified" verdict for
  // altered content. That exact condition (content changed, timestamps
  // unchanged, same inode) cannot be reproduced from Node without native
  // code, so these tests prove the WEAKER invariant the fix reduces to:
  // there is no cache to consult — a content change is detected on the
  // immediately following verification even when every user-forgeable
  // stat field has been restored. (Stated per the review's instruction.)

  it("detects a content rewrite on the very next verification", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    expect(verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION }).ok).toBe(true)

    // Tamper AFTER a successful verification — same size, executable kept.
    const corrupted = SCRIPT.replace("fake-1.0.0", "evil-1.0.0")
    writeFileSync(binPath, corrupted, { mode: 0o755 })
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" })
  })

  it("detects tampering even when atime/mtime are forged back to their pre-tamper values", () => {
    const runtimeDir = makeRuntimeDir()
    const { binPath } = installFixture(runtimeDir)
    expect(verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION }).ok).toBe(true)

    const before = statSync(binPath)
    const corrupted = SCRIPT.replace("fake-1.0.0", "evil-1.0.0")
    writeFileSync(binPath, corrupted, { mode: 0o755 })
    // Restore every stat field user space CAN forge. With no cache in the
    // path, none of it matters — the next call hashes the actual bytes.
    utimesSync(binPath, before.atime, before.mtime)
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" })
  })

  it("a prior ok never outlives the manifest it was checked against", () => {
    const runtimeDir = makeRuntimeDir()
    const { manifest } = installFixture(runtimeDir)
    expect(verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION }).ok).toBe(true)

    // Rewrite the manifest to expect DIFFERENT content while leaving the
    // binary untouched — the next verification must compare the fresh hash
    // against the CURRENT record and fail, not serve any earlier verdict.
    writeFileSync(
      join(runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE),
      serializeClaudeRuntimeManifest({ ...manifest, binarySha256: sha256Hex("something else") }),
    )
    const result = verifyInstalledClaudeRuntime({ runtimeDir, platform: process.platform, sdkVersion: SDK_VERSION })
    expect(result).toMatchObject({ ok: false, reason: "hash-mismatch" })
  })
})
