/**
 * Fetches and installs the `claude` native binary Desde no longer bundles —
 * see `tasks/electron-app.md`'s "stop bundling the claude binary, fetch it
 * on first run" work, and `../src/editor/llm-providers/
 * claude-runtime-location.ts`'s module doc comment for the shared path
 * design both this file and `resolve-claude-executable.ts` build on.
 *
 * **Why not shell out to a system `npm`.** MEASURED: neither Electron's own
 * binary nor the staged CLI payload bundles an `npm` CLI anywhere —
 * Electron ships only Node's runtime/API surface (reachable via
 * `ELECTRON_RUN_AS_NODE`), and the payload's `node_modules` holds
 * *libraries*, not the `npm` executable itself. Assuming a user's system
 * `npm` on PATH is exactly the toolchain-on-PATH assumption the brief asked
 * NOT to make. Instead this uses `pacote` — npm's OWN registry-fetch-and-
 * extract library, i.e. literally what `npm install` calls internally —
 * promoted from an incidental transitive devDependency (pulled in by
 * `license-checker-rseidelsohn` → `@npmcli/arborist`) to a real, declared
 * `dependency` in `package.json`. `desktop/scripts/build.mjs` bundles
 * (`bundle: true`, only `electron` left external) everything this file
 * imports straight into `dist/main.js`, so the shipped app needs no
 * external toolchain on PATH at all: registry resolution, download,
 * integrity verification (against the sha512 expectation recorded at BUILD
 * time in the signed payload's lockfile — passed to `pacote` as
 * `opts.integrity` and cross-checked on the result; NOT merely the registry
 * response's own `dist.integrity`, which the party serving the tarball also
 * controls), and tar extraction all ship inside Desde.
 *
 * **Idempotent, atomic, verified** (the brief's three hard requirements):
 *  - Idempotent: {@link ensureClaudeRuntime} runs the full shared
 *    verification ({@link verifyInstalledClaudeRuntime} — no-follow
 *    regular-file check, install-time manifest, size, content sha256)
 *    against the version-keyed final path FIRST, before anything
 *    network-shaped. An already-installed, VERIFIED binary returns
 *    immediately — boot never pays a network cost twice — and anything at
 *    that path that fails verification (planted symlink, corrupted bytes, a
 *    pre-manifest install) falls through to a fresh, anchored reinstall
 *    instead of being trusted on an executable bit alone.
 *  - Atomic: `pacote.extract()` writes into a TEMP sibling directory (a
 *    random suffix on the runtime dir's own path, so it's on the SAME
 *    filesystem and `rename()` is a single atomic syscall, not a copy) —
 *    same pattern as `editor-cli/src/server/projects-registry.ts`'s
 *    atomic-temp-then-rename writes, applied to a directory instead of a
 *    file. An interrupted download can never leave a partial binary AT the
 *    real path: the real path only ever changes via one `rename()` call,
 *    which either fully happens or doesn't. Temp directories a kill or
 *    power loss abandoned (each holds up to ~200MB) are swept on the next
 *    install attempt by {@link removeStaleTempSiblings} — protected by a
 *    sibling owner marker with a pid LIVENESS check (a suspended installer
 *    is not an abandoned one), with a newest-write age gate only as the
 *    dead-owner fallback.
 *  - Verified: the downloaded tarball is checked against
 *    `expectedIntegrity` — the sha512 SRI recorded at BUILD time in the
 *    signed payload's `package-lock.json` (see
 *    `claude-runtime-expectation.ts` for why the anchor must not be the
 *    registry's own metadata) — twice: `pacote` enforces it during the
 *    fetch (`opts.integrity` → EINTEGRITY on mismatch), and the extract
 *    RESULT's reported integrity is cross-checked here as
 *    belt-and-suspenders against option-name drift across pacote majors.
 *    Then the binary's executable bit is (re-)asserted with an explicit
 *    `chmod`, a macOS quarantine xattr is checked for and cleared if
 *    present (see {@link clearQuarantineIfPresent}), the binary is ACTUALLY
 *    SPAWNED (`claude --version`), and its sha256/size are recorded in the
 *    runtime manifest ({@link CLAUDE_RUNTIME_MANIFEST_FILE}) — all before
 *    the temp directory is renamed into place. Every later resolve
 *    re-verifies against that manifest (see `claude-runtime-verify.ts`'s
 *    module doc comment for the full trust chain and its honest limits —
 *    it defends against a substituted download and post-install tampering
 *    at the well-known path; it does NOT defend against a compromised
 *    build machine, which records the expectation itself and is outside
 *    this control's reach).
 */

import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants as fsConstants } from "node:fs"
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import * as pacote from "pacote"

import {
  claudeAgentSdkPackageName,
  claudeAgentSdkPlatformCandidates,
  resolveClaudeExecutablePathIn,
  resolveClaudeRuntimeDir,
} from "../src/editor/llm-providers/claude-runtime-location.js"
import {
  CLAUDE_RUNTIME_MANIFEST_FILE,
  hashFileSha256Sync,
  isWellFormedSri,
  serializeClaudeRuntimeManifest,
  sriIntersects,
  verifyInstalledClaudeRuntime,
} from "../src/editor/llm-providers/claude-runtime-verify.js"

const execFileAsync = promisify(execFile)

export type ClaudeRuntimeInstallCause =
  | "offline"
  | "registry-unreachable"
  | "disk-full"
  | "permissions"
  | "integrity"
  | "unknown"

/** Thrown by {@link ensureClaudeRuntime} on any failure — always carries a {@link ClaudeRuntimeInstallCause} so the UI can name the cause rather than showing a raw stack trace. */
export class ClaudeRuntimeInstallError extends Error {
  readonly reason: ClaudeRuntimeInstallCause

  constructor(cause: ClaudeRuntimeInstallCause, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ClaudeRuntimeInstallError"
    this.reason = cause
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Classifies a caught error into one of the brief's four named causes
 * ("offline, disk full, permissions, registry unreachable") plus a
 * catch-all. MEASURED against `npm-registry-fetch`'s real error shape
 * (`lib/errors.js`): an HTTP error carries `.code = "E${status}"` and
 * `.statusCode`; a network-layer failure (DNS, connection refused) surfaces
 * Node's own standard errno `.code` (from the underlying fetch), sometimes
 * one level down on `.cause` when wrapped by `make-fetch-happen`/undici —
 * both are checked.
 */
export function classifyInstallError(err: unknown): ClaudeRuntimeInstallCause {
  const codesToCheck: unknown[] = []
  let cursor: unknown = err
  for (let depth = 0; depth < 3 && cursor; depth++) {
    const code = (cursor as { code?: unknown } | undefined)?.code
    if (code !== undefined) codesToCheck.push(code)
    cursor = (cursor as { cause?: unknown } | undefined)?.cause
  }

  const statusCode = (err as { statusCode?: unknown } | undefined)?.statusCode
  if (typeof statusCode === "number" && statusCode >= 500) return "registry-unreachable"

  for (const code of codesToCheck) {
    if (typeof code !== "string") continue
    if (["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
      return "offline"
    }
    if (code === "ENOSPC") return "disk-full"
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permissions"
    // pacote/ssri's own verdict when the fetched tarball fails the
    // `integrity` expectation we pass in — the F1 primary enforcement path.
    if (code === "EINTEGRITY") return "integrity"
    if (/^E5\d\d$/.test(code)) return "registry-unreachable"
  }
  return "unknown"
}

function causeMessage(cause: ClaudeRuntimeInstallCause, detail: string): string {
  switch (cause) {
    case "offline":
      return `Couldn't reach the npm registry — check your internet connection and try again. (${detail})`
    case "registry-unreachable":
      return `The npm registry didn't respond correctly — it may be down or blocking requests. Try again shortly. (${detail})`
    case "disk-full":
      return `Not enough disk space to install the AI chat runtime (~200MB needed). Free up space and try again. (${detail})`
    case "permissions":
      return `Desde doesn't have permission to write to its application-support directory. Check folder permissions and try again. (${detail})`
    case "integrity":
      return (
        `The AI chat runtime download couldn't be verified against the checksum recorded in this build ` +
        `of Desde, so nothing was installed or run. This can be caused by a network proxy or appliance ` +
        `rewriting downloads — or by a tampered registry response. (${detail})`
      )
    case "unknown":
      return `Installing the AI chat runtime failed for an unexpected reason: ${detail}`
  }
}

/**
 * macOS-only: if the extracted binary carries the `com.apple.quarantine`
 * xattr, remove ONLY that attribute — never a blanket `xattr -c` strip,
 * which would also discard unrelated metadata (ACLs, resource forks) the
 * brief explicitly warned against assuming is safe. A `pacote`/npm-registry
 * fetch is NOT expected to set this attribute — it's applied by macOS's
 * LaunchServices quarantine hook for browser/Mail-style downloads, which
 * this fetch path never goes through — but that expectation was verified
 * live (see this work's own verification report: `xattr -l` on a real
 * installed binary, then an ACTUAL spawn) rather than assumed, per the
 * brief's explicit instruction. This check-and-clear runs on every install
 * regardless, so the code path is real and covers the case even though it's
 * measured to be a no-op today.
 */
async function clearQuarantineIfPresent(path: string): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    await execFileAsync("/usr/bin/xattr", ["-p", "com.apple.quarantine", path])
  } catch {
    return // No such xattr (exit 1) — the expected case, nothing to clear.
  }
  // The attribute IS present — remove exactly that one.
  await execFileAsync("/usr/bin/xattr", ["-d", "com.apple.quarantine", path])
}

/** Actually spawns the extracted binary — "verify before trusting," not just a stat check. A truncated/corrupted extraction is caught HERE, before the temp dir is ever renamed into place. */
async function verifySpawnable(path: string): Promise<void> {
  try {
    await execFileAsync(path, ["--version"])
  } catch (err) {
    throw new ClaudeRuntimeInstallError(
      "unknown",
      `the extracted binary failed to run (${(err as Error).message}) — install did not complete`,
      { cause: err },
    )
  }
}

/** The one `pacote` call this file makes, factored out so tests can inject a fake that writes fixture files instead of hitting the real registry — same DI convention as `notarize-dmg.mjs`'s `notarizeFn` param (its own test file explains the house rule: a unit test never makes the real network call). The RESULT type is load-bearing: {@link ensureClaudeRuntime} cross-checks the reported `integrity` against the shipped expectation, so a fake must report what it "fetched" the same way the real `pacote.extract` does. */
export type ExtractFn = (spec: string, dest: string, opts: pacote.PacoteOptions) => Promise<pacote.PacoteExtractResult>

const defaultExtract: ExtractFn = (spec, dest, opts) => pacote.extract(spec, dest, opts)

export interface EnsureClaudeRuntimeOptions {
  /** {@link resolveAppSupportDir}'s return value — the app-support root, NOT the version-keyed runtime dir. */
  appSupportDir: string
  /** The exact `@anthropic-ai/claude-agent-sdk` version the running payload ships — see `readInstalledClaudeAgentSdkVersion`. Pinned, never `"latest"` — a mismatched SDK-JS/native-binary pair is a real failure mode (tasks/electron-app.md). */
  sdkVersion: string
  /**
   * The sha512 SRI the downloaded platform-package tarball MUST match —
   * read from the signed payload's `package-lock.json` by
   * `claude-runtime-expectation.ts` (see that module's doc comment for why
   * the anchor must not be the registry's own metadata). Required, and
   * fail-closed: a missing or malformed value refuses the install before
   * any network I/O — an unverifiable binary is never downloaded, let
   * alone spawned.
   */
  expectedIntegrity: string
  platform?: NodeJS.Platform
  arch?: string
  /** Test/CI override for the npm registry URL. */
  registry?: string
  onProgress?: (phase: "checking" | "downloading" | "ready") => void
  /** Injected for tests — see {@link ExtractFn}. Production callers never pass this. */
  extractFn?: ExtractFn
}

const TEMP_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** Matches this file's own temp-dir naming: `<runtimeDir>.tmp-<uuid>`. Anchored on the UUID so a hypothetical version string containing ".tmp-" could never make a REAL runtime dir eligible for the sweep. */
const TEMP_SIBLING_PATTERN = new RegExp(`\\.tmp-${TEMP_UUID}$`, "i")

/**
 * The owner marker's suffix: `<tmpDir>.owner.json`, a SIBLING file, not a
 * file inside the temp dir — `pacote.extract` rimrafs its destination
 * before unpacking (MEASURED: `#mkdir` → `#empty` in pacote 21.5.1's
 * `lib/fetcher.js`), so anything placed inside the dir dies the moment the
 * download starts, which is exactly the window the marker exists to cover.
 */
const TEMP_OWNER_MARKER_SUFFIX = ".owner.json"

const OWNER_MARKER_PATTERN = new RegExp(`\\.tmp-${TEMP_UUID}\\.owner\\.json$`, "i")

/**
 * How long a temp dir must have gone WITHOUT A SINGLE WRITE before the
 * age fallback may remove it. An active install writes its ~198MB binary
 * continuously (file mtime advances with every chunk), so "newest mtime
 * across the dir and its immediate entries is over an hour old" means the
 * installer that owned it made no progress for an hour. Age alone is NOT
 * the verdict, though — see the owner-marker liveness check below: a
 * process suspended across laptop sleep or SIGSTOP looks identical to an
 * abandoned one under any wall-clock test, which is why a temp dir whose
 * recorded owner pid is still alive is never removed regardless of age.
 */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000

/** True when `pid` names a currently-existing process. `EPERM` means "exists, different user" — alive. Errs toward alive: a recycled pid keeps a genuinely stale dir around until that process exits, a bounded disk cost in the conservative direction. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function readOwnerPid(markerPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { pid?: unknown }
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null
  } catch {
    return null
  }
}

/**
 * F3: sweeps abandoned `.tmp-<uuid>` siblings out of the runtime parent
 * directory. A kill or power loss mid-extraction skips the in-process
 * `catch` cleanup, and every retry picks a fresh UUID — without this sweep,
 * repeated interruptions accumulate ~200MB orphans until ENOSPC. Runs on
 * the next install ATTEMPT (never on the fast path — no writes there), and
 * is entirely best-effort: any single failure is skipped, because failing
 * an INSTALL over cleanup would invert the priorities.
 *
 * Two-step verdict per candidate (F8): first LIVENESS — a sibling owner
 * marker naming a pid that still exists protects the dir outright, because
 * a suspended installer (laptop sleep, SIGSTOP) is indistinguishable from
 * an abandoned one by wall-clock age and its directory must never be
 * deleted out from under `pacote`'s active extraction. Only when the owner
 * is dead (or no marker survived) does the AGE fallback apply. Orphaned
 * markers (dir already gone) are themselves removed once old enough — the
 * age condition also protects the marker-written-but-dir-not-yet-created
 * instant of a concurrent installer's startup.
 */
async function removeStaleTempSiblings(runtimeParentDir: string, now: number = Date.now()): Promise<void> {
  let entryNames: string[]
  try {
    entryNames = await readdir(runtimeParentDir)
  } catch {
    return // parent doesn't exist yet — nothing to sweep
  }
  const names = new Set(entryNames)
  for (const name of entryNames) {
    const full = join(runtimeParentDir, name)

    // Orphaned owner marker: its directory is gone (finished install's
    // rename, a prior sweep — or an installer suspended between
    // marker-write and mkdir). LIVENESS first, exactly as for the dirs
    // (F10): a marker whose recorded owner is still alive belongs to a
    // suspended installer that has not created (or is about to create) its
    // temp dir — deleting the marker on age alone would leave that dir
    // unclaimed, and a later sweep could then collect it mid-extraction,
    // which is the F8 race surviving through a narrower window. Only a
    // marker whose owner is dead (or whose pid is unreadable/invalid) ages
    // out, and the age condition still applies so a just-written marker is
    // never touched.
    if (OWNER_MARKER_PATTERN.test(name)) {
      if (!names.has(name.slice(0, -TEMP_OWNER_MARKER_SUFFIX.length))) {
        try {
          const ownerPid = await readOwnerPid(full)
          if (ownerPid !== null && isPidAlive(ownerPid)) continue
          const st = await lstat(full)
          if (now - st.mtimeMs > STALE_TEMP_MAX_AGE_MS) {
            await rm(full, { force: true })
          }
        } catch {
          // best-effort — see the doc comment
        }
      }
      continue
    }

    if (!TEMP_SIBLING_PATTERN.test(name)) continue
    try {
      const st = await lstat(full)
      if (!st.isDirectory()) continue

      // F8 liveness check FIRST — age is only the fallback.
      const ownerPid = await readOwnerPid(`${full}${TEMP_OWNER_MARKER_SUFFIX}`)
      if (ownerPid !== null && isPidAlive(ownerPid)) continue

      let newestMtimeMs = st.mtimeMs
      for (const childName of await readdir(full)) {
        try {
          const childSt = await lstat(join(full, childName))
          newestMtimeMs = Math.max(newestMtimeMs, childSt.mtimeMs)
        } catch {
          // child vanished mid-scan — a concurrent installer is ACTIVE in
          // this dir; leave it alone entirely.
          newestMtimeMs = now
        }
      }
      if (now - newestMtimeMs > STALE_TEMP_MAX_AGE_MS) {
        await rm(full, { recursive: true, force: true })
        await rm(`${full}${TEMP_OWNER_MARKER_SUFFIX}`, { force: true }).catch(() => {})
      }
    } catch {
      // best-effort — see the doc comment
    }
  }
}

/**
 * Ensures a verified, executable `claude` binary exists at the version-keyed
 * install path and returns its absolute path. Safe to call on every app
 * boot / every "agent first needed" trigger — the idempotent fast path
 * makes a repeat call cheap and network-free.
 *
 * @throws {ClaudeRuntimeInstallError} on any failure, with `.reason` naming
 *   one of the brief's four causes, `"integrity"` (a download that failed
 *   verification against the shipped expectation, or a build shipping no
 *   usable expectation — both refusals, nothing installed or run), or
 *   `"unknown"`.
 */
export async function ensureClaudeRuntime(opts: EnsureClaudeRuntimeOptions): Promise<string> {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch

  opts.onProgress?.("checking")
  const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir: opts.appSupportDir, sdkVersion: opts.sdkVersion })
  const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform })
  const [suffix] = claudeAgentSdkPlatformCandidates(platform, arch)
  const platformPackage = claudeAgentSdkPackageName(suffix)
  const spec = `${platformPackage}@${opts.sdkVersion}`

  // Fail closed FIRST (F1), before the fast path and before any network
  // I/O: no usable expectation means nothing gets verified, so nothing gets
  // trusted — not even a previously-installed runtime, whose manifest pin
  // below would otherwise be silently skipped. Never a fallback that runs
  // it anyway. (The option is typed `string`; this guards the JS boundary.)
  if (typeof opts.expectedIntegrity !== "string" || !isWellFormedSri(opts.expectedIntegrity)) {
    throw new ClaudeRuntimeInstallError(
      "integrity",
      causeMessage(
        "integrity",
        `this build carries no usable integrity expectation for ${spec} — refusing to download or run a binary that cannot be verified`,
      ),
    )
  }

  // Idempotent fast path — no network, no filesystem writes. FULL
  // verification (F2), not a bare X_OK check: no-follow regular-file check,
  // install-time manifest, size, content sha256, AND the manifest's
  // recorded tarball SRI pinned against this build's shipped expectation.
  // Anything at the path that fails — a planted symlink, corrupted bytes, a
  // pre-manifest install, a runtime verified against a DIFFERENT build's
  // expectation — falls through to a fresh anchored reinstall below rather
  // than being trusted. Cost note: EVERY verification hashes the ~198MB
  // binary (~150ms measured, synchronous — a deliberate trade for having
  // exactly ONE verification implementation and NO stat-identity cache,
  // which claude-runtime-verify.ts's module doc comment shows is unsound).
  const preVerification = verifyInstalledClaudeRuntime({
    runtimeDir,
    platform,
    sdkVersion: opts.sdkVersion,
    expectedTarballIntegrity: opts.expectedIntegrity,
  })
  if (preVerification.ok) {
    opts.onProgress?.("ready")
    return finalPath
  }
  if (preVerification.reason !== "binary-missing") {
    // Something IS at the well-known path and it failed verification —
    // worth a diagnostic trace before it gets replaced (the reinstall below
    // is the recovery, so this is not an error path).
    console.warn(
      `[desktop] installed claude runtime failed verification (${preVerification.reason}: ${preVerification.detail}) — reinstalling`,
    )
  }

  opts.onProgress?.("downloading")

  const tmpDir = `${runtimeDir}.tmp-${randomUUID()}`
  const ownerMarkerPath = `${tmpDir}${TEMP_OWNER_MARKER_SUFFIX}`

  try {
    await mkdir(dirname(runtimeDir), { recursive: true })
    // F3: sweep temp dirs a killed/interrupted prior attempt abandoned.
    // A live installer's dir is protected by its owner marker (liveness
    // check), with the age gate only as the dead-owner fallback (F8).
    await removeStaleTempSiblings(dirname(runtimeDir))
    // Claim ownership BEFORE creating the dir, as a SIBLING file — pacote
    // rimrafs the extraction destination, so an in-dir marker would die
    // exactly when the long download starts (see TEMP_OWNER_MARKER_SUFFIX's
    // doc comment). Removed again on every exit path below.
    await writeFile(ownerMarkerPath, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8")
    await mkdir(tmpDir, { recursive: true })

    let extractResult: pacote.PacoteExtractResult
    try {
      const extract = opts.extractFn ?? defaultExtract
      extractResult = await extract(spec, tmpDir, {
        ...(opts.registry ? { registry: opts.registry } : {}),
        // The F1 primary enforcement: pacote verifies the fetched tarball
        // against OUR shipped expectation while streaming (EINTEGRITY on
        // mismatch) — not merely against the registry response's own
        // `dist.integrity`, which the same party that served the tarball
        // controls.
        integrity: opts.expectedIntegrity,
      })
    } catch (err) {
      const cause = classifyInstallError(err)
      throw new ClaudeRuntimeInstallError(cause, causeMessage(cause, (err as Error).message), { cause: err })
    }

    // Belt-and-suspenders for F1: require the extraction to REPORT the
    // integrity it fetched, and require that report to match the shipped
    // expectation. This catches the failure mode where the `integrity`
    // option above silently stopped being enforced (an option rename across
    // pacote majors, a fake in a test) — "no report" is a refusal, never a
    // pass.
    if (typeof extractResult.integrity !== "string" || !sriIntersects(extractResult.integrity, opts.expectedIntegrity)) {
      throw new ClaudeRuntimeInstallError(
        "integrity",
        causeMessage(
          "integrity",
          `the downloaded tarball's integrity (${String(extractResult.integrity)}) does not match this build's recorded expectation for ${spec}`,
        ),
      )
    }

    const tmpBinaryPath = resolveClaudeExecutablePathIn({ runtimeDir: tmpDir, platform })
    // Defensive: re-assert the executable bit even though the tarball's own
    // recorded mode already sets it — see the module doc comment's
    // "Verified" bullet.
    await chmod(tmpBinaryPath, 0o755).catch((err) => {
      const cause = classifyInstallError(err)
      throw new ClaudeRuntimeInstallError(cause, causeMessage(cause, (err as Error).message), { cause: err })
    })
    await clearQuarantineIfPresent(tmpBinaryPath)
    if (!isExecutableFile(tmpBinaryPath)) {
      throw new ClaudeRuntimeInstallError(
        "unknown",
        `extracted package did not produce an executable binary at ${tmpBinaryPath}`,
      )
    }
    await verifySpawnable(tmpBinaryPath)

    // Record what was just verified — the binary's own sha256/size plus the
    // tarball SRI it descended from — INSIDE the temp dir, so the atomic
    // rename publishes binary and manifest together. Every later resolve
    // (claude-runtime-verify.ts) checks the binary against this record; the
    // sha256 is computed from the bytes that passed the tarball check
    // moments ago, in the same process, which is what ties the at-rest
    // verification back to the signed anchor.
    const binaryStat = await lstat(tmpBinaryPath)
    await writeFile(
      join(tmpDir, CLAUDE_RUNTIME_MANIFEST_FILE),
      serializeClaudeRuntimeManifest({
        schema: 1,
        sdkVersion: opts.sdkVersion,
        platformPackage,
        tarballIntegrity: opts.expectedIntegrity,
        binarySha256: hashFileSha256Sync(tmpBinaryPath),
        binarySize: binaryStat.size,
      }),
      "utf8",
    )

    // Atomic swap: clear any stale directory from a prior failed attempt
    // (best-effort — its absence is the common case), then ONE rename into
    // the real path. Both operations target the SAME parent directory as
    // tmpDir, so rename() is a same-filesystem, single-syscall op.
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {})
    await rename(tmpDir, runtimeDir)
    await rm(ownerMarkerPath, { force: true }).catch(() => {})
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await rm(ownerMarkerPath, { force: true }).catch(() => {})
    if (err instanceof ClaudeRuntimeInstallError) throw err
    const cause = classifyInstallError(err)
    throw new ClaudeRuntimeInstallError(cause, causeMessage(cause, (err as Error).message), { cause: err })
  }

  // Should be unreachable given the checks above, but "verify before
  // trusting" applies to this function's OWN output too — never hand back a
  // path without a final live check. Full verification (not a bare X_OK):
  // this also primes this process's verification cache for the published
  // path, so the settings-menu retry's fast path is an lstat, not a rehash.
  const postVerification = verifyInstalledClaudeRuntime({
    runtimeDir,
    platform,
    sdkVersion: opts.sdkVersion,
    expectedTarballIntegrity: opts.expectedIntegrity,
  })
  if (!postVerification.ok) {
    throw new ClaudeRuntimeInstallError(
      "unknown",
      `install completed but ${finalPath} failed verification (${postVerification.reason}: ${postVerification.detail})`,
    )
  }
  opts.onProgress?.("ready")
  return finalPath
}
