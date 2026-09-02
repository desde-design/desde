/**
 * `claude-runtime-expectation.ts` — the F1 trust anchor's reader. Fixture
 * lockfiles on a real temp filesystem; every failure branch must THROW
 * (fail closed), because the caller treats any throw as "refuse to
 * install", never "install unverified".
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { readClaudeRuntimeExpectedIntegrity, resolveAnchorPayloadDir } from "../claude-runtime-expectation.js"

const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk-darwin-arm64"
const SDK_VERSION = "0.3.143"
const INTEGRITY = "sha512-41WuTuP+bk4NxrjpG9IJGffsjh1ivyiiAmqgb5QoxPltDAA0p3gs+iZ3lTgDmY4Ga68wDoN05Lt18oCE+DQb7g=="

const tempDirs: string[] = []
function makePayloadDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-runtime-expectation-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeLockfile(payloadDir: string, packages: Record<string, unknown>): void {
  writeFileSync(
    join(payloadDir, "package-lock.json"),
    JSON.stringify({ name: "payload", lockfileVersion: 3, packages }, null, 2),
  )
}

describe("readClaudeRuntimeExpectedIntegrity", () => {
  it("returns the SRI recorded for the exact package@version", () => {
    const payloadDir = makePayloadDir()
    writeLockfile(payloadDir, {
      [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: INTEGRITY },
    })
    expect(
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toBe(INTEGRITY)
  })

  it("throws when the lockfile is missing entirely", () => {
    const payloadDir = makePayloadDir()
    expect(() =>
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toThrow(/cannot read the payload lockfile/)
  })

  it("throws on unparseable JSON", () => {
    const payloadDir = makePayloadDir()
    writeFileSync(join(payloadDir, "package-lock.json"), "{{{not json")
    expect(() =>
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toThrow(/not valid JSON/)
  })

  it("throws when there is no entry for the platform package", () => {
    const payloadDir = makePayloadDir()
    writeLockfile(payloadDir, {
      "node_modules/@anthropic-ai/claude-agent-sdk": { version: SDK_VERSION, integrity: INTEGRITY },
    })
    expect(() =>
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toThrow(/no entry for "node_modules\/@anthropic-ai\/claude-agent-sdk-darwin-arm64"/)
  })

  it("throws when the recorded version is not the installed SDK version — the expectation would not apply", () => {
    const payloadDir = makePayloadDir()
    writeLockfile(payloadDir, {
      [`node_modules/${PACKAGE_NAME}`]: { version: "0.0.1", integrity: INTEGRITY },
    })
    expect(() =>
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toThrow(/does not apply to the version/)
  })

  it("throws when the entry has no well-formed integrity value", () => {
    const payloadDir = makePayloadDir()
    for (const bad of [undefined, "", "md5-nope", 42]) {
      writeLockfile(payloadDir, {
        [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: bad },
      })
      expect(() =>
        readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
      ).toThrow(/no well-formed "integrity"/)
    }
  })

  it("F7: rejects a TRUNCATED sha512 digest and any non-sha512 algorithm — the shapes that would brick shipping", () => {
    // `assertClaudeRuntimeAnchor` (the build gate in
    // build-server-package.mts) delegates to this exact reader, so a
    // rejection here IS a build failure. Both values passed the old loose
    // parser; both would then fail EINTEGRITY against every real tarball on
    // every user's machine — a checksum no artifact can ever match.
    const payloadDir = makePayloadDir()
    const sha256Token = "sha256-LCa0a2j/xo/5m0U8HTBBNBNCLXBkg7+g+YpeiGJm564=" // valid 32-byte sha256 SRI
    for (const bad of ["sha512-A", sha256Token]) {
      writeLockfile(payloadDir, {
        [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: bad },
      })
      expect(() =>
        readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
      ).toThrow(/no well-formed "integrity"/)
    }
  })

  it("F9: rejects a noncanonical-padding token — the F7 shipping-breaker class, one layer down", () => {
    // Canonical trailing 'g==' changed to 'h==': same 64 decoded bytes, but
    // ssri/pacote reject the string at verification time — so the build
    // gate (which delegates to this reader) must reject it too, or every
    // shipped install EINTEGRITY-fails.
    const payloadDir = makePayloadDir()
    const noncanonical = `${INTEGRITY.slice(0, -3)}h==`
    writeLockfile(payloadDir, {
      [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: noncanonical },
    })
    expect(() =>
      readClaudeRuntimeExpectedIntegrity({ payloadDir, packageName: PACKAGE_NAME, sdkVersion: SDK_VERSION }),
    ).toThrow(/no well-formed "integrity"/)
  })

  it("F4: in a PACKAGED build the anchor comes from the signed Resources/server — a payload override cannot supply it", () => {
    // The attack shape: `--payload`/DESDE_DESKTOP_PAYLOAD points a
    // packaged app at an unsigned payload copy whose lockfile the attacker
    // rewrote. The anchor read must ignore that directory entirely.
    const overridePayload = makePayloadDir() // caller-controlled, unsigned
    const anchorDir = resolveAnchorPayloadDir({
      payloadRoot: overridePayload,
      packagedResourcesPath: "/Applications/Desde.app/Contents/Resources",
    })
    expect(anchorDir).toBe(join("/Applications/Desde.app/Contents/Resources", "server"))
    expect(anchorDir).not.toBe(overridePayload)

    // End-to-end shape of the defeat: the override dir carries an
    // attacker-authored lockfile with a (strictly valid) wrong SRI, while
    // the "signed" resources dir carries the real one under server/.
    // Reading via the anchor selection returns the SIGNED value, never the
    // attacker's.
    const attackerSri = `sha512-${Buffer.alloc(64, 7).toString("base64")}`
    writeLockfile(overridePayload, {
      [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: attackerSri },
    })
    const resourcesDir = makePayloadDir()
    const signedServerDir = join(resourcesDir, "server")
    mkdirSync(signedServerDir)
    writeLockfile(signedServerDir, {
      [`node_modules/${PACKAGE_NAME}`]: { version: SDK_VERSION, integrity: INTEGRITY },
    })
    const chosen = resolveAnchorPayloadDir({ payloadRoot: overridePayload, packagedResourcesPath: resourcesDir })
    const anchored = readClaudeRuntimeExpectedIntegrity({
      payloadDir: chosen,
      packageName: PACKAGE_NAME,
      sdkVersion: SDK_VERSION,
    })
    expect(anchored).toBe(INTEGRITY)
    expect(anchored).not.toBe(attackerSri)
  })

  it("F4: dev (unpackaged) reads the payload being run — the only copy there is", () => {
    expect(resolveAnchorPayloadDir({ payloadRoot: "/some/dev/payload", packagedResourcesPath: null })).toBe(
      "/some/dev/payload",
    )
  })

  it("reads the REAL repo lockfile's shape — the fixture format matches what npm actually writes", () => {
    // Guards against the fixture drifting from npm's real lockfile schema:
    // the repo's own package-lock.json records the same platform packages
    // the payload lockfile does, so read one entry from it verbatim (at
    // whatever version is currently pinned — read that from the lockfile
    // itself rather than hardcoding one that rots on SDK upgrades).
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
    const lockfile = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>
    }
    const recordedVersion = lockfile.packages[`node_modules/${PACKAGE_NAME}`]?.version
    expect(recordedVersion).toBeTruthy()
    const value = readClaudeRuntimeExpectedIntegrity({
      payloadDir: repoRoot,
      packageName: PACKAGE_NAME,
      sdkVersion: recordedVersion as string,
    })
    expect(value).toMatch(/^sha512-/)
  })
})
