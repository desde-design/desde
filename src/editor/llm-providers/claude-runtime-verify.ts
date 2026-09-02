/**
 * Content verification for the desktop app's downloaded `claude` runtime —
 * the shared half of the integrity chain `desktop/claude-runtime-installer.ts`
 * starts. See `tasks/electron-app.md`'s "stop bundling the claude binary,
 * fetch it on first run" work, and `claude-runtime-location.ts`'s module doc
 * comment for why this lives in root `src/` (both the desktop installer and
 * `resolve-claude-executable.ts` — which runs in the payload's own
 * processes, outside Electron — must apply the SAME verification, and the
 * import direction is fixed: `desktop/` imports root `src/`, never the
 * reverse).
 *
 * **The trust chain, end to end.** The app's build stages a payload whose
 * `package-lock.json` records npm's `integrity` (a sha512 SRI value) for the
 * exact `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` tarball version
 * the payload's SDK was built against. That lockfile ships INSIDE the
 * signed, notarized app bundle (`Resources/server/package-lock.json`), so
 * tampering with the expectation means breaking Apple's code signature — the
 * anchor is the signature, not the registry's own say-so. At install time
 * the installer verifies the downloaded tarball against that anchored value
 * (refusing to run anything on mismatch), then records what it verified —
 * the tarball SRI it checked against plus the extracted binary's own
 * sha256/size — in a manifest file next to the binary
 * ({@link CLAUDE_RUNTIME_MANIFEST_FILE}). Every later resolve re-checks the
 * binary on disk against that manifest via
 * {@link verifyInstalledClaudeRuntime} before the path is ever handed to the
 * SDK's `spawn()`.
 *
 * **What this defends against, honestly.**
 *  - DEFENDS: a substituted or altered registry download (a compromised
 *    registry, or a TLS-intercepting proxy, serving altered metadata AND a
 *    matching altered tarball — both halves come from the same party, so
 *    "registry metadata agrees with registry tarball" proves nothing; the
 *    shipped lockfile value is the independent anchor).
 *  - DEFENDS: post-install tampering at the well-known runtime path —
 *    a pre-created symlink or directory (the no-follow `lstat` check), a
 *    substituted script or corrupted binary that kept its executable bit
 *    (the sha256 content check), a truncated file (the size check), and an
 *    install that predates this verification entirely (no manifest → not
 *    verified → refused, and the desktop installer reinstalls).
 *  - DOES NOT defend: a compromised BUILD machine (the lockfile expectation
 *    is recorded there — outside this control's reach), root, or an attacker
 *    with arbitrary same-user filesystem write access who rewrites the
 *    binary AND the manifest together consistently. That last attacker can
 *    already run arbitrary code as the user, which no user-space check can
 *    fix; the manifest binds the binary to the install-time verification,
 *    not to the signature directly. The desktop installer's own fast path
 *    additionally pins the manifest's recorded tarball SRI against the
 *    signed anchor, so a manifest whose `tarballIntegrity` doesn't match the
 *    shipped expectation triggers a full (anchored) reinstall.
 *  - RESIDUAL TOCTOU: verification hashes the file's bytes, and the SDK
 *    `execve()`s the PATH later — POSIX offers no way to spawn "the bytes I
 *    just verified" (no fexecve from Node). The window is narrowed to
 *    milliseconds by verifying on every resolve (immediately before each
 *    spawn) and by re-`lstat`ing after hashing, which catches a
 *    replace-by-rename that happened mid-verification — but a same-user
 *    writer who alters the file between the final check and the kernel's
 *    `execve` still wins, and an mmap-based in-place rewrite (see below)
 *    can evade even the re-`lstat`. That window cannot be fully closed from
 *    user space; stating it here is the honest boundary.
 *
 * **Cost: the hash runs on EVERY verification — there is deliberately no
 * cache.** An earlier revision cached the digest keyed on `(dev, ino, size,
 * mtimeMs, ctimeMs)`, arguing ctime is not settable from user space. That
 * argument is FALSE on macOS: a same-user process can rewrite a writable
 * `MAP_SHARED` mapping of the file without calling `msync`, and the changed
 * bytes are immediately visible to reads and to execution while APFS may
 * keep the previous mtime/ctime until the mapping is flushed — same inode,
 * same size, same timestamps, different content. Any cache keyed on stat
 * identity therefore re-serves a stale "verified" verdict for altered
 * bytes. Content verification that can be skipped is not content
 * verification, so the cache is gone: every call hashes the bytes as they
 * are now. MEASURED cost on the real 207MB binary (Apple silicon): ~150ms
 * per resolve — one hash per chat turn, well under the noise floor of an
 * LLM turn. If that ever becomes too slow the fix is a mechanism that
 * enforces content immutability independently (none exists for a
 * user-writable file on macOS today), not a stat-identity cache.
 */

import { createHash } from "node:crypto"
import { closeSync, lstatSync, openSync, readFileSync, readSync, type Stats } from "node:fs"
import { join as joinPath } from "node:path"

import { resolveClaudeExecutablePathIn } from "./claude-runtime-location"

/**
 * Written by the desktop installer into the version-keyed runtime directory,
 * next to the binary, at install time — inside the temp directory BEFORE the
 * atomic rename, so a published runtime dir always carries its manifest.
 * Dot-prefixed to keep clear of anything the platform package's own tarball
 * extracts (its contents are `claude` + `package.json` today, but the
 * namespace is Anthropic's, not ours).
 */
export const CLAUDE_RUNTIME_MANIFEST_FILE = ".claude-runtime-integrity.json"

export interface ClaudeRuntimeManifest {
  schema: 1
  /** The exact `@anthropic-ai/claude-agent-sdk` version this runtime serves — must match the version-keyed directory it sits in. */
  sdkVersion: string
  /** The platform package the binary came from, e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`. */
  platformPackage: string
  /** The SRI value the downloaded tarball was verified against at install time — the signed payload lockfile's `integrity` for {@link platformPackage}. */
  tarballIntegrity: string
  /** Lowercase hex sha256 of the extracted binary's bytes, computed at install time immediately after the tarball verification passed. */
  binarySha256: string
  /** The binary's byte size at install time — a cheap pre-hash check. */
  binarySize: number
}

/**
 * STRICT token shape: `sha512-` + canonical padded base64 of EXACTLY 64
 * bytes (86 chars + `==`), which is precisely what npm lockfiles and ssri
 * emit for a sha512 digest. Deliberately narrower than the SRI spec:
 *  - sha256/sha384 are rejected — the anchor pipeline is sha512-only
 *    end-to-end (lockfile → pacote → manifest), so accepting a weaker
 *    algorithm here could only ever LOWER the bar.
 *  - A truncated digest (`sha512-A` is valid base64!) is rejected — a
 *    malformed value that passed this gate would clear the BUILD and then
 *    fail EINTEGRITY against every real tarball on every user's machine,
 *    bricking install for the whole release. Strictness here is what makes
 *    the build-time gate (`assertClaudeRuntimeAnchor`) able to catch that.
 *  - NONCANONICAL base64 is rejected via decode→re-encode round-trip (F9):
 *    a 64-byte token with nonzero unused padding bits (canonical trailing
 *    `w==` changed to `x==`) passes the regex AND a decoded-length check —
 *    but ssri/pacote reject exactly that string at verification time, so
 *    accepting it here is the same shipping-breaker one layer down. Only
 *    a token that reproduces itself byte-for-byte when re-encoded is one
 *    the runtime verifier will ever agree with.
 */
const SRI_SHA512_TOKEN_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/

/** Splits an SRI string (possibly several space-separated entries) into its strictly-valid sha512 tokens, dropping everything else. Each surviving token must decode to exactly 64 bytes AND round-trip to the identical string (see the canonicality bullet above). */
export function parseSriTokens(value: string): string[] {
  return value.split(/\s+/).filter((token) => {
    if (!SRI_SHA512_TOKEN_PATTERN.test(token)) return false
    const digest = token.slice("sha512-".length)
    const decoded = Buffer.from(digest, "base64")
    return decoded.length === 64 && decoded.toString("base64") === digest
  })
}

/** True when `value` contains at least one strictly-valid sha512 token — the fail-closed gate for "do we even HAVE a usable expectation". */
export function isWellFormedSri(value: string): boolean {
  return parseSriTokens(value).length > 0
}

/**
 * True when the two SRI strings share at least one exact `algo-digest`
 * token. Exact string comparison of tokens is sufficient here — both sides
 * come from npm tooling (a lockfile on one side, pacote/ssri's canonical
 * `String(integrity)` on the other), which emit standard padded base64, so
 * a genuine match is byte-identical. No partial-credit matching: zero
 * well-formed tokens on either side is a mismatch, never a pass.
 */
export function sriIntersects(a: string, b: string): boolean {
  const aTokens = parseSriTokens(a)
  if (aTokens.length === 0) return false
  const bTokens = new Set(parseSriTokens(b))
  return aTokens.some((token) => bTokens.has(token))
}

/** Parses + validates a manifest file's contents. Returns `null` for anything malformed — callers treat that as "not verified", never as a soft pass. */
export function parseClaudeRuntimeManifest(raw: string): ClaudeRuntimeManifest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.schema !== 1) return null
  if (typeof candidate.sdkVersion !== "string" || candidate.sdkVersion.length === 0) return null
  if (typeof candidate.platformPackage !== "string" || candidate.platformPackage.length === 0) return null
  if (typeof candidate.tarballIntegrity !== "string" || !isWellFormedSri(candidate.tarballIntegrity)) return null
  if (typeof candidate.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(candidate.binarySha256)) return null
  if (typeof candidate.binarySize !== "number" || !Number.isInteger(candidate.binarySize) || candidate.binarySize <= 0) {
    return null
  }
  return {
    schema: 1,
    sdkVersion: candidate.sdkVersion,
    platformPackage: candidate.platformPackage,
    tarballIntegrity: candidate.tarballIntegrity,
    binarySha256: candidate.binarySha256,
    binarySize: candidate.binarySize,
  }
}

/** The one serializer, so the installer can never write a shape {@link parseClaudeRuntimeManifest} wouldn't read back. */
export function serializeClaudeRuntimeManifest(manifest: ClaudeRuntimeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * Chunked synchronous sha256 — sync because
 * `resolve-claude-executable.ts`'s resolver is (and must stay) synchronous
 * at its two `query()` call sites, and 8MB chunks so a ~198MB binary never
 * needs a single ~198MB buffer.
 */
export function hashFileSha256Sync(path: string): string {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024)
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}

export type ClaudeRuntimeVerifyFailureReason =
  | "binary-missing"
  | "not-a-regular-file"
  | "not-executable"
  | "manifest-missing"
  | "manifest-invalid"
  | "manifest-mismatch"
  | "size-mismatch"
  | "hash-mismatch"

export type ClaudeRuntimeVerification =
  | { ok: true; path: string }
  | { ok: false; reason: ClaudeRuntimeVerifyFailureReason; detail: string }

export interface VerifyInstalledClaudeRuntimeOptions {
  runtimeDir: string
  platform: NodeJS.Platform
  /** The version the caller EXPECTS this runtime dir to hold — cross-checked against the manifest so a mislabeled directory can't pass. */
  sdkVersion: string
  /**
   * The signed-bundle anchor (the payload lockfile's SRI for the platform
   * package). The desktop installer passes it, pinning the manifest's
   * recorded `tarballIntegrity` to the shipped expectation. The payload's
   * own processes omit it — they have no channel to the signed value — and
   * get manifest-bound verification only (see the module doc comment's
   * boundary discussion).
   */
  expectedTarballIntegrity?: string
}

function sameStatIdentity(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
  )
}

/**
 * The full check `resolve-claude-executable.ts` and the desktop installer's
 * fast path both run before an installed runtime is trusted: no-follow
 * regular-file check, executable bit, manifest presence + validity +
 * version/anchor agreement, size, and content sha256 — the hash runs on
 * EVERY call, never from a cache (see the module doc comment for why a
 * stat-identity cache is unsound on macOS). Fails closed on every branch:
 * any doubt returns `ok: false` and the caller must not spawn.
 */
export function verifyInstalledClaudeRuntime(
  opts: VerifyInstalledClaudeRuntimeOptions,
): ClaudeRuntimeVerification {
  const path = resolveClaudeExecutablePathIn({ runtimeDir: opts.runtimeDir, platform: opts.platform })

  // No-follow: `lstat`, never `stat`/`access` (which would happily follow a
  // planted symlink to some other executable and report on the TARGET).
  let st: Stats
  try {
    st = lstatSync(path)
  } catch {
    return { ok: false, reason: "binary-missing", detail: `no file at ${path}` }
  }
  if (!st.isFile()) {
    return {
      ok: false,
      reason: "not-a-regular-file",
      detail: `${path} is not a regular file (symlink/directory/special file refused)`,
    }
  }
  if ((st.mode & 0o111) === 0) {
    return { ok: false, reason: "not-executable", detail: `${path} has no executable bit` }
  }

  const manifestPath = joinPath(opts.runtimeDir, CLAUDE_RUNTIME_MANIFEST_FILE)
  let rawManifest: string
  try {
    rawManifest = readFileSync(manifestPath, "utf8")
  } catch {
    return {
      ok: false,
      reason: "manifest-missing",
      detail: `no install-time verification record at ${manifestPath}: this runtime was never verified`,
    }
  }
  const manifest = parseClaudeRuntimeManifest(rawManifest)
  if (manifest === null) {
    return { ok: false, reason: "manifest-invalid", detail: `${manifestPath} is malformed` }
  }
  if (manifest.sdkVersion !== opts.sdkVersion) {
    return {
      ok: false,
      reason: "manifest-mismatch",
      detail: `manifest records sdkVersion ${manifest.sdkVersion}, expected ${opts.sdkVersion}`,
    }
  }
  if (
    opts.expectedTarballIntegrity !== undefined &&
    !sriIntersects(manifest.tarballIntegrity, opts.expectedTarballIntegrity)
  ) {
    return {
      ok: false,
      reason: "manifest-mismatch",
      detail: "manifest's recorded tarball integrity does not match this build's shipped expectation",
    }
  }
  if (st.size !== manifest.binarySize) {
    return {
      ok: false,
      reason: "size-mismatch",
      detail: `${path} is ${st.size} bytes, manifest records ${manifest.binarySize}`,
    }
  }

  // Always hash the bytes as they are NOW — no cache to consult, no cache
  // to poison (module doc comment: a stat-identity cache is unsound on
  // macOS because mmap writes can change content without moving mtime/ctime).
  let sha256: string
  try {
    sha256 = hashFileSha256Sync(path)
  } catch (err) {
    return {
      ok: false,
      reason: "binary-missing",
      detail: `could not read ${path} for hashing: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // Re-lstat AFTER hashing: catches a replace-by-rename or rewrite that
  // moved the stat identity mid-hash, in which case the digest describes no
  // coherent file state. Best-effort narrowing only — an mmap in-place
  // rewrite can leave the identity unchanged (which is exactly why the NEXT
  // resolve rehashes from scratch); see the module doc comment's TOCTOU
  // bullet for the residual window.
  let after: Stats
  try {
    after = lstatSync(path)
  } catch {
    return { ok: false, reason: "binary-missing", detail: `${path} disappeared during verification` }
  }
  if (!after.isFile() || !sameStatIdentity(st, after)) {
    return { ok: false, reason: "hash-mismatch", detail: `${path} changed while being verified` }
  }

  if (sha256 !== manifest.binarySha256) {
    return {
      ok: false,
      reason: "hash-mismatch",
      detail: `${path} content hash does not match the install-time verification record`,
    }
  }

  return { ok: true, path }
}
