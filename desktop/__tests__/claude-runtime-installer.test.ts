/**
 * `claude-runtime-installer.ts` — the desktop-only fetch-on-first-run
 * installer for the `claude` binary Desde no longer bundles. Every test
 * here injects a FAKE `extractFn` (same DI convention as
 * `notarize-dmg.test.ts`'s `notarizeFn`) so nothing hits the real npm
 * registry — but everything DOWNSTREAM of extraction (atomic rename,
 * chmod, quarantine check, the real `execFile` spawn-verify) runs for
 * real against a real temp directory on this machine's real filesystem,
 * so the atomicity/verification claims are genuinely exercised, not
 * mocked away.
 */
import { createHash } from "node:crypto"
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

import { resolveClaudeExecutablePathIn, resolveClaudeRuntimeDir } from "../../src/editor/llm-providers/claude-runtime-location.js"
import { classifyInstallError, ClaudeRuntimeInstallError, ensureClaudeRuntime, type ExtractFn } from "../claude-runtime-installer.js"

const execFileAsync = promisify(execFile)

const FAKE_SDK_VERSION = "0.3.143-test"
const FAKE_CLAUDE_SCRIPT = "#!/bin/sh\necho fake-1.0.0\nexit 0\n"
/** The "recorded at build time" expectation every happy-path test installs against — STRICTLY valid (sha512, 64-byte digest), since the F7 gate rejects anything less. */
const FAKE_INTEGRITY = `sha512-${createHash("sha512").update("the-expected-fake-tarball").digest("base64")}`
/** A DIFFERENT strictly-valid SRI — what a substituted tarball would (self-consistently) hash to. */
const WRONG_INTEGRITY = `sha512-${createHash("sha512").update("the-substituted-tarball").digest("base64")}`

const tempDirs: string[] = []
async function makeTempAppSupportDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-runtime-installer-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** A working fake extractor: writes a real, spawnable `claude` script into `dest` — mirrors what `pacote.extract` does for the real package (a `claude` file at the root of `dest`), and reports the integrity it "fetched" the same way the real one does. */
function makeFakeExtract(script: string = FAKE_CLAUDE_SCRIPT, reportedIntegrity: string = FAKE_INTEGRITY): ExtractFn {
  return async (_spec, dest) => {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, "claude"), script, { mode: 0o755 })
    return { from: "fake", resolved: "fake", integrity: reportedIntegrity }
  }
}

/** Baseline options every test starts from — the F1 expectation included, since it is now required. */
function baseOptions(appSupportDir: string) {
  return { appSupportDir, sdkVersion: FAKE_SDK_VERSION, expectedIntegrity: FAKE_INTEGRITY }
}

/**
 * Pre-creates the state a completed legitimate install leaves behind —
 * binary AND the install-time manifest — by running the installer itself
 * with a working fake. The fast-path/verification tests start from here.
 */
async function installReal(appSupportDir: string, script: string = FAKE_CLAUDE_SCRIPT): Promise<string> {
  return ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract(script) })
}

describe("ensureClaudeRuntime — idempotent fast path", () => {
  it("returns immediately, without calling extractFn, when a VERIFIED install exists", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const finalPath = await installReal(appSupportDir) // a real prior install — binary + manifest

    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }

    const phases: string[] = []
    const result = await ensureClaudeRuntime({
      ...baseOptions(appSupportDir),
      extractFn,
      onProgress: (p) => phases.push(p),
    })

    expect(result).toBe(finalPath)
    expect(extractCalls).toBe(0) // NO network call — the whole point of idempotency
    expect(phases).toEqual(["checking", "ready"])
  })

  it("does NOT fast-path a bare executable with no install-time manifest — it reinstalls (F2)", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    mkdirSync(runtimeDir, { recursive: true })
    const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })
    // The pre-hardening state: executable present, nothing verified. On
    // current HEAD this was trusted on X_OK alone.
    writeFileSync(finalPath, "#!/bin/sh\necho unverified\n", { mode: 0o755 })

    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }
    const result = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })

    expect(extractCalls).toBe(1) // reinstalled from the anchored download
    const { stdout } = await execFileAsync(result, ["--version"])
    expect(stdout.trim()).toBe("fake-1.0.0") // the unverified content is GONE
  })
})

describe("ensureClaudeRuntime — fresh install", () => {
  it("installs, verifies, and returns the executable path", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })
    expect(existsSync(finalPath)).toBe(false)

    const phases: string[] = []
    const result = await ensureClaudeRuntime({
      ...baseOptions(appSupportDir),
      extractFn: makeFakeExtract(),
      onProgress: (p) => phases.push(p),
    })

    expect(result).toBe(finalPath)
    expect(() => accessSync(finalPath, fsConstants.X_OK)).not.toThrow()
    expect(phases).toEqual(["checking", "downloading", "ready"])

    // The binary is genuinely spawnable — not just present on disk.
    const { stdout } = await execFileAsync(finalPath, ["--version"])
    expect(stdout.trim()).toBe("fake-1.0.0")
  })

  it("is atomic — no leftover .tmp- directory after a successful install", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    await ensureClaudeRuntime({
      ...baseOptions(appSupportDir),
      extractFn: makeFakeExtract(),
    })
    const claudeRuntimeRoot = join(appSupportDir, "claude-runtime")
    const entries = readdirSync(claudeRuntimeRoot)
    expect(entries).toEqual([FAKE_SDK_VERSION]) // exactly the final version dir, nothing else
  })

  it("passes the extractFn a spec built from the pinned sdkVersion, not 'latest'", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    let capturedSpec = ""
    const extractFn: ExtractFn = async (spec, dest, extractOpts) => {
      capturedSpec = spec
      return makeFakeExtract()(spec, dest, extractOpts)
    }
    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })
    expect(capturedSpec).toContain(`@${FAKE_SDK_VERSION}`)
    expect(capturedSpec).not.toContain("latest")
  })

  it("re-checking after a successful install is idempotent (no second extract)", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }
    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })
    expect(extractCalls).toBe(1)

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })
    expect(extractCalls).toBe(1) // unchanged — the second call took the fast path
  })
})

describe("ensureClaudeRuntime — corrupted/truncated extraction", () => {
  it("throws and leaves no partial binary at the final path when the extracted file isn't executable", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })

    const extractFn: ExtractFn = async (_spec, dest) => {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, "claude"), "not a real binary")
      // Deliberately non-executable — simulates a mode-stripped/truncated extraction.
      await chmod(join(dest, "claude"), 0o644)
      return { from: "fake", resolved: "fake", integrity: FAKE_INTEGRITY }
    }

    await expect(
      ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }),
    ).rejects.toThrow(ClaudeRuntimeInstallError)
    expect(existsSync(finalPath)).toBe(false)
    expect(existsSync(runtimeDir)).toBe(false) // no partial directory left behind either
  })

  it("throws when the extracted binary exists and is +x but fails to actually run", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })

    const extractFn = makeFakeExtract("#!/bin/sh\nexit 1\n") // executable, but exits non-zero

    await expect(
      ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }),
    ).rejects.toThrow(/failed to run/)
    expect(existsSync(finalPath)).toBe(false)
  })
})

describe("ensureClaudeRuntime — error classification surfaces through the thrown error", () => {
  it("classifies a DNS-style failure as offline", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const extractFn: ExtractFn = async () => {
      const err = new Error("getaddrinfo ENOTFOUND registry.npmjs.org") as NodeJS.ErrnoException
      err.code = "ENOTFOUND"
      throw err
    }
    const caught = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }).catch(
      (e: unknown) => e,
    )
    expect(caught).toBeInstanceOf(ClaudeRuntimeInstallError)
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("offline")
    expect((caught as ClaudeRuntimeInstallError).message).toMatch(/internet connection/)
  })

  it("classifies a 503 registry response as registry-unreachable", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const extractFn: ExtractFn = async () => {
      const err = new Error("503 Service Unavailable") as Error & { code: string; statusCode: number }
      err.code = "E503"
      err.statusCode = 503
      throw err
    }
    const caught = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }).catch(
      (e: unknown) => e,
    )
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("registry-unreachable")
  })

  it("classifies EACCES as permissions", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const extractFn: ExtractFn = async () => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
      err.code = "EACCES"
      throw err
    }
    const caught = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }).catch(
      (e: unknown) => e,
    )
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("permissions")
  })

  it("classifies ENOSPC as disk-full", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const extractFn: ExtractFn = async () => {
      const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException
      err.code = "ENOSPC"
      throw err
    }
    const caught = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }).catch(
      (e: unknown) => e,
    )
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("disk-full")
  })

  it("falls back to unknown for an unrecognized error shape", async () => {
    expect(classifyInstallError(new Error("something weird"))).toBe("unknown")
    expect(classifyInstallError("not even an Error object")).toBe("unknown")
  })

  it("checks one level of .cause for a wrapped errno code", () => {
    const inner = new Error("ECONNREFUSED") as NodeJS.ErrnoException
    inner.code = "ECONNREFUSED"
    const outer = new Error("fetch failed", { cause: inner })
    expect(classifyInstallError(outer)).toBe("offline")
  })

  it("real filesystem permissions failure is classified and cleaned up", async () => {
    // A REAL EACCES, not a synthetic error object: make the app-support
    // dir's own parent unwritable so mkdir() genuinely fails.
    const appSupportDir = await makeTempAppSupportDir()
    const readOnlyParent = join(appSupportDir, "locked")
    mkdirSync(readOnlyParent, { mode: 0o500 })
    const lockedAppSupportDir = join(readOnlyParent, "Desde")

    const caught = await ensureClaudeRuntime({
      ...baseOptions(lockedAppSupportDir),
      extractFn: makeFakeExtract(),
    }).catch((e: unknown) => e)

    await chmod(readOnlyParent, 0o700) // restore so afterEach's rm can clean up
    expect(caught).toBeInstanceOf(ClaudeRuntimeInstallError)
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("permissions")
  })
})

describe("ensureClaudeRuntime — F1: the integrity anchor is the SHIPPED expectation, not the registry's say-so", () => {
  /** A fake extractor whose payload records every spawn into a marker file — how "nothing was spawned" is PROVEN rather than assumed. */
  function makeMarkingExtract(markerPath: string, reportedIntegrity: string): ExtractFn {
    return async (_spec, dest) => {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, "claude"), `#!/bin/sh\necho spawned >> "${markerPath}"\necho fake-1.0.0\nexit 0\n`, {
        mode: 0o755,
      })
      return { from: "fake", resolved: "fake", integrity: reportedIntegrity }
    }
  }

  it("rejects a download whose integrity does not match the recorded expectation — and NOTHING is spawned", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })
    const markerPath = join(appSupportDir, "spawn-marker")

    const caught = await ensureClaudeRuntime({
      ...baseOptions(appSupportDir),
      extractFn: makeMarkingExtract(markerPath, WRONG_INTEGRITY), // the substituted tarball's (self-consistent!) integrity
    }).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(ClaudeRuntimeInstallError)
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("integrity")
    expect(existsSync(markerPath)).toBe(false) // the payload never ran
    expect(existsSync(finalPath)).toBe(false) // nothing was installed
    expect(readdirSync(join(appSupportDir, "claude-runtime"))).toEqual([]) // temp dir cleaned up too
  })

  it("rejects an extraction that reports NO integrity at all — no report is a refusal, never a pass", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const markerPath = join(appSupportDir, "spawn-marker")
    const extractFn: ExtractFn = async (_spec, dest) => {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, "claude"), `#!/bin/sh\necho spawned >> "${markerPath}"\nexit 0\n`, { mode: 0o755 })
      return { from: "fake", resolved: "fake", integrity: false } // pacote's shape when nothing was verified
    }

    const caught = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn }).catch((e: unknown) => e)
    expect((caught as ClaudeRuntimeInstallError).reason).toBe("integrity")
    expect(existsSync(markerPath)).toBe(false)
  })

  it("fails closed BEFORE any download when the shipped expectation is missing or malformed", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }

    // "sha512-A" (valid base64, truncated digest) and a well-formed sha256
    // token are the F7 shapes: the old loose parser accepted both, and
    // either one shipping would fail EINTEGRITY against every real tarball.
    for (const badExpectation of [
      "",
      "latest",
      "trust-me-bro",
      "sha512-A",
      `sha256-${createHash("sha256").update("x").digest("base64")}`,
    ]) {
      const caught = await ensureClaudeRuntime({
        ...baseOptions(appSupportDir),
        expectedIntegrity: badExpectation,
        extractFn,
      }).catch((e: unknown) => e)
      expect(caught).toBeInstanceOf(ClaudeRuntimeInstallError)
      expect((caught as ClaudeRuntimeInstallError).reason).toBe("integrity")
    }
    expect(extractCalls).toBe(0) // refused before any network-shaped call
  })

  it("passes the shipped expectation through to pacote's own opts.integrity (the streaming enforcement)", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    let capturedIntegrity: unknown
    const extractFn: ExtractFn = async (spec, dest, extractOpts) => {
      capturedIntegrity = extractOpts.integrity
      return makeFakeExtract()(spec, dest, extractOpts)
    }
    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })
    expect(capturedIntegrity).toBe(FAKE_INTEGRITY)
  })

  it("classifies pacote's own EINTEGRITY verdict as an integrity failure", () => {
    const err = new Error("sha512 integrity checksum failed") as NodeJS.ErrnoException
    err.code = "EINTEGRITY"
    expect(classifyInstallError(err)).toBe("integrity")
  })
})

describe("ensureClaudeRuntime — F2: an installed runtime is re-verified, never trusted on X_OK alone", () => {
  it("rejects a SYMLINK planted at the runtime path and reinstalls a real file over it", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const finalPath = await installReal(appSupportDir)
    // Plant the attack: replace the verified binary with a symlink to a
    // genuinely executable target — access(X_OK) follows it and passes.
    await rm(finalPath)
    symlinkSync("/bin/sh", finalPath)
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(true)

    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }
    const result = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })

    expect(extractCalls).toBe(1) // the symlink was NOT reported "ready" — it triggered a reinstall
    expect(lstatSync(result).isSymbolicLink()).toBe(false)
    expect(lstatSync(result).isFile()).toBe(true)
    const { stdout } = await execFileAsync(result, ["--version"])
    expect(stdout.trim()).toBe("fake-1.0.0")
  })

  it("rejects a corrupted-but-still-executable binary and reinstalls (content check, not a stat check)", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const finalPath = await installReal(appSupportDir)
    // Corrupt the content while keeping size AND the executable bit — the
    // exact case an access(X_OK) fast path waves through.
    const corrupted = FAKE_CLAUDE_SCRIPT.replace("fake-1.0.0", "evil-6.6.6")
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(FAKE_CLAUDE_SCRIPT))
    writeFileSync(finalPath, corrupted, { mode: 0o755 })

    let extractCalls = 0
    const extractFn: ExtractFn = async (...args) => {
      extractCalls++
      return makeFakeExtract()(...args)
    }
    const result = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })

    expect(extractCalls).toBe(1) // corruption detected → reinstall, not "ready"
    const { stdout } = await execFileAsync(result, ["--version"])
    expect(stdout.trim()).toBe("fake-1.0.0") // the corrupted content never survived to be spawned
  })
})

describe("ensureClaudeRuntime — F3: abandoned temp directories are swept, active ones survive", () => {
  const HOURS = 60 * 60 * 1000

  function makeTempSibling(appSupportDir: string, ageMs: number): string {
    const claudeRuntimeRoot = join(appSupportDir, "claude-runtime")
    mkdirSync(claudeRuntimeRoot, { recursive: true })
    // The exact shape an interrupted install leaves: `<version>.tmp-<uuid>`
    // holding a partial download.
    const dir = join(claudeRuntimeRoot, `${FAKE_SDK_VERSION}.tmp-123e4567-e89b-42d3-a456-426614174000`.replace("123e4567", ageMs > HOURS ? "aaaaaaaa" : "bbbbbbbb"))
    mkdirSync(dir)
    writeFileSync(join(dir, "claude"), "partial download debris")
    const then = new Date(Date.now() - ageMs)
    utimesSync(join(dir, "claude"), then, then)
    utimesSync(dir, then, then)
    return dir
  }

  it("removes a STALE temp sibling on the next install attempt", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const staleDir = makeTempSibling(appSupportDir, 2 * HOURS)
    expect(existsSync(staleDir)).toBe(true)

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(staleDir)).toBe(false) // swept
    expect(readdirSync(join(appSupportDir, "claude-runtime"))).toEqual([FAKE_SDK_VERSION])
  })

  it("does NOT remove a temp sibling with recent writes — a concurrent installer's active dir", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const activeDir = makeTempSibling(appSupportDir, 0) // written to just now

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(activeDir)).toBe(true) // left alone
  })

  it("a recently-written FILE inside an old dir counts as activity (dir mtime alone is not the verdict)", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const dir = makeTempSibling(appSupportDir, 2 * HOURS)
    // The dir's own mtime is 2h old (its entry set hasn't changed), but the
    // download inside it is being actively appended — exactly what a slow
    // in-flight pacote fetch looks like.
    writeFileSync(join(dir, "claude"), "still downloading…")

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(dir)).toBe(true) // treated as active, not swept
  })

  it("F8: an OLD temp dir whose owner marker names a LIVE pid is never swept — suspended is not abandoned", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    // Fully stale by every wall-clock measure (2h without a write)…
    const dir = makeTempSibling(appSupportDir, 2 * HOURS)
    // …but its owner claims it and that owner is ALIVE (this very test
    // process — the same state a SIGSTOP'd or sleep-suspended installer is
    // in: no writes for hours, process still exists).
    writeFileSync(`${dir}.owner.json`, JSON.stringify({ pid: process.pid }))

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(dir)).toBe(true) // protected by liveness, despite the age
  })

  it("F8: a temp dir whose owner pid is DEAD falls back to the age gate and is swept, marker included", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const dir = makeTempSibling(appSupportDir, 2 * HOURS)
    // A pid that provably existed and provably exited — no liveness.
    const { execFile: execFileCb } = await import("node:child_process")
    const deadPid = await new Promise<number>((resolvePid, rejectPid) => {
      const child = execFileCb("/usr/bin/true", (err) => (err ? rejectPid(err) : resolvePid(child.pid as number)))
    })
    writeFileSync(`${dir}.owner.json`, JSON.stringify({ pid: deadPid }))
    const oldDate = new Date(Date.now() - 2 * HOURS)
    utimesSync(`${dir}.owner.json`, oldDate, oldDate)

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(dir)).toBe(false)
    expect(existsSync(`${dir}.owner.json`)).toBe(false) // no marker litter left behind
  })

  it("F8: an ORPHANED old owner marker (its dir already gone) is removed; a fresh one is kept", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const claudeRuntimeRoot = join(appSupportDir, "claude-runtime")
    mkdirSync(claudeRuntimeRoot, { recursive: true })
    const orphanOld = join(claudeRuntimeRoot, `${FAKE_SDK_VERSION}.tmp-cccccccc-e89b-42d3-a456-426614174000.owner.json`)
    writeFileSync(orphanOld, JSON.stringify({ pid: 999999 }))
    const oldDate = new Date(Date.now() - 2 * HOURS)
    utimesSync(orphanOld, oldDate, oldDate)
    // A FRESH orphan models a concurrent installer between marker-write and
    // mkdir — the age condition is what keeps that instant safe.
    const orphanFresh = join(claudeRuntimeRoot, `${FAKE_SDK_VERSION}.tmp-dddddddd-e89b-42d3-a456-426614174000.owner.json`)
    writeFileSync(orphanFresh, JSON.stringify({ pid: process.pid }))

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(orphanOld)).toBe(false)
    expect(existsSync(orphanFresh)).toBe(true)
    rm(orphanFresh, { force: true }).catch(() => {})
  })

  it("F10: an ORPHANED old marker whose owner pid is ALIVE survives the sweep — suspended between marker-write and mkdir", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const claudeRuntimeRoot = join(appSupportDir, "claude-runtime")
    mkdirSync(claudeRuntimeRoot, { recursive: true })
    // The F10 race shape: an installer wrote its marker, was suspended for
    // over an hour BEFORE creating its temp dir, and is still alive (this
    // very process). Deleting the marker on age alone would leave the temp
    // dir it creates on resume unclaimed — collectable by a later sweep
    // mid-extraction.
    const marker = join(claudeRuntimeRoot, `${FAKE_SDK_VERSION}.tmp-eeeeeeee-e89b-42d3-a456-426614174000.owner.json`)
    writeFileSync(marker, JSON.stringify({ pid: process.pid }))
    const oldDate = new Date(Date.now() - 48 * HOURS)
    utimesSync(marker, oldDate, oldDate)

    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })

    expect(existsSync(marker)).toBe(true) // protected by liveness, despite the age
    await rm(marker, { force: true }).catch(() => {})
  })

  it("F8: a successful install leaves NO owner marker behind", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })
    const entries = readdirSync(join(appSupportDir, "claude-runtime"))
    expect(entries).toEqual([FAKE_SDK_VERSION]) // exactly the version dir — no .owner.json litter
  })

  it("does not sweep the REAL version directory even while reinstalling over it", async () => {
    const appSupportDir = await makeTempAppSupportDir()
    const finalPath = await installReal(appSupportDir)
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
    // Age the real install far past the stale threshold, then corrupt it so
    // a reinstall (and with it, the sweep) actually runs.
    const old = new Date(Date.now() - 48 * HOURS)
    utimesSync(finalPath, old, old)
    utimesSync(runtimeDir, old, old)
    writeFileSync(finalPath, "corrupted", { mode: 0o755 })

    const result = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn: makeFakeExtract() })
    const { stdout } = await execFileAsync(result, ["--version"])
    expect(stdout.trim()).toBe("fake-1.0.0")
  })
})

describe("ensureClaudeRuntime — macOS quarantine handling (darwin only)", () => {
  it.runIf(process.platform === "darwin")(
    "clears a REAL com.apple.quarantine xattr and the binary is spawnable afterward",
    async () => {
      const appSupportDir = await makeTempAppSupportDir()
      const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion: FAKE_SDK_VERSION })
      const finalPath = resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform })

      const extractFn: ExtractFn = async (_spec, dest) => {
        mkdirSync(dest, { recursive: true })
        const binPath = join(dest, "claude")
        writeFileSync(binPath, FAKE_CLAUDE_SCRIPT, { mode: 0o755 })
        // Force a REAL quarantine attribute — the same one macOS applies to
        // browser downloads — onto the file BEFORE the installer's own
        // verification step runs, so this exercises the actual clear path,
        // not just its absence.
        await execFileAsync("/usr/bin/xattr", [
          "-w",
          "com.apple.quarantine",
          "0081;00000000;Safari;00000000-0000-0000-0000-000000000000",
          binPath,
        ])
        return { from: "fake", resolved: "fake", integrity: FAKE_INTEGRITY }
      }

      const result = await ensureClaudeRuntime({ ...baseOptions(appSupportDir), extractFn })
      expect(result).toBe(finalPath)

      // The attribute must be GONE on the final, renamed-into-place binary.
      await expect(execFileAsync("/usr/bin/xattr", ["-p", "com.apple.quarantine", finalPath])).rejects.toThrow()

      // And it genuinely runs.
      const { stdout } = await execFileAsync(finalPath, ["--version"])
      expect(stdout.trim()).toBe("fake-1.0.0")
    },
  )
})
