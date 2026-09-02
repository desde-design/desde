/**
 * `resolveNotarizeCredentials` — the pure(-ish) decision of whether a signed
 * build should notarize, from tasks/electron-app.md §5 Phase 5b's Part 2
 * brief. Every value used below is a FAKE fixture value, never anything
 * from the real `.env.signing.local` (which this test never touches, reads,
 * or references).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { API_KEY_VARS, APPLE_ID_VARS, resolveNotarizeCredentials } from "../scripts/notarize-config.mjs"

let tmpDir: string | null = null

/** A fake `.p8` fixture file — fake content, never the real key material. */
function fakeApiKeyFile(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "desde-notarize-config-"))
  const keyPath = join(tmpDir, "AuthKey_FAKE1234.p8")
  writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nfake-fixture-not-a-real-key\n-----END PRIVATE KEY-----\n")
  return keyPath
}

afterEach(() => {
  if (tmpDir) {
    // A leftover unreadable/no-exec fixture from the F3 tests below would
    // otherwise make rmSync itself fail to clean up — restore permissions
    // first, best-effort, before removing the directory tree.
    try {
      chmodSync(tmpDir, 0o700)
    } catch {
      // already gone or already permissive — fine either way
    }
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe("resolveNotarizeCredentials", () => {
  it("enables notarize for a complete API-key set", () => {
    const keyPath = fakeApiKeyFile()
    const result = resolveNotarizeCredentials({
      APPLE_API_KEY: keyPath,
      APPLE_API_KEY_ID: "FAKE_KEY_ID",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
      APPLE_TEAM_ID: "FAKETEAMID",
    })
    expect(result).toEqual({ notarize: true, shape: "api-key" })
  })

  it("enables notarize for a complete Apple-ID set", () => {
    const result = resolveNotarizeCredentials({
      APPLE_ID: "fake@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
      APPLE_TEAM_ID: "FAKETEAMID",
    })
    expect(result).toEqual({ notarize: true, shape: "apple-id" })
  })

  it("disables notarize with no error when nothing is set", () => {
    const result = resolveNotarizeCredentials({})
    expect(result.notarize).toBe(false)
    expect(result).toHaveProperty("skipReason")
    if (!result.notarize) {
      expect(result.skipReason.length).toBeGreaterThan(0)
    }
  })

  it("ignores unrelated env vars when deciding 'nothing is set'", () => {
    const result = resolveNotarizeCredentials({ PATH: "/usr/bin", HOME: "/home/fake" })
    expect(result.notarize).toBe(false)
  })

  it("a lone APPLE_TEAM_ID with nothing else touches neither shape (matches electron-builder, which never inspects team id to decide intent)", () => {
    const result = resolveNotarizeCredentials({ APPLE_TEAM_ID: "FAKETEAMID" })
    expect(result.notarize).toBe(false)
  })

  for (const missing of API_KEY_VARS) {
    it(`errors naming exactly the missing variable when only ${missing} is absent from the API-key set`, () => {
      const keyPath = fakeApiKeyFile()
      const full: Record<string, string> = {
        APPLE_API_KEY: keyPath,
        APPLE_API_KEY_ID: "FAKE_KEY_ID",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        APPLE_TEAM_ID: "FAKETEAMID",
      }
      delete full[missing]
      expect(() => resolveNotarizeCredentials(full)).toThrowError(
        new RegExp(`missing:[^.]*\\b${missing}\\b`),
      )
    })
  }

  for (const missing of APPLE_ID_VARS) {
    it(`errors naming exactly the missing variable when only ${missing} is absent from the Apple-ID set`, () => {
      const full: Record<string, string> = {
        APPLE_ID: "fake@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
        APPLE_TEAM_ID: "FAKETEAMID",
      }
      delete full[missing]
      expect(() => resolveNotarizeCredentials(full)).toThrowError(
        new RegExp(`missing:[^.]*\\b${missing}\\b`),
      )
    })
  }

  it("errors and does not name a present variable as missing", () => {
    // Only APPLE_ID set (missing the other two) — the error must call out
    // APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID, not APPLE_ID itself.
    let thrown: Error | undefined
    try {
      resolveNotarizeCredentials({ APPLE_ID: "fake@example.com" })
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown?.message).toMatch(/APPLE_APP_SPECIFIC_PASSWORD/)
    expect(thrown?.message).toMatch(/APPLE_TEAM_ID/)
    expect(thrown?.message).not.toMatch(/missing:[^.]*APPLE_ID\b/)
  })

  it("errors when APPLE_API_KEY points at a file that does not exist", () => {
    const missingPath = join(tmpdir(), "desde-notarize-config-does-not-exist", "AuthKey_FAKE.p8")
    expect(() =>
      resolveNotarizeCredentials({
        APPLE_API_KEY: missingPath,
        APPLE_API_KEY_ID: "FAKE_KEY_ID",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        APPLE_TEAM_ID: "FAKETEAMID",
      }),
    ).toThrowError(/does not point at a readable regular file/)
  })

  // F3 (P2 finding): existsSync alone is too weak — a directory or an
  // unreadable file both pass a bare existence check, so notarization would
  // be enabled and the build would spend several minutes staging, packaging,
  // and signing before `notarytool` finally rejects the path far later, with
  // far less context than a build-time refusal gives.
  it("errors when APPLE_API_KEY points at a directory instead of a file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "desde-notarize-config-dir-"))
    const dirAsKeyPath = join(tmpDir, "AuthKey_ISADIR.p8")
    // Create it AS A DIRECTORY, not a file — the exact case a bare
    // `existsSync` check cannot distinguish from a real key file.
    mkdirSync(dirAsKeyPath)
    expect(() =>
      resolveNotarizeCredentials({
        APPLE_API_KEY: dirAsKeyPath,
        APPLE_API_KEY_ID: "FAKE_KEY_ID",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        APPLE_TEAM_ID: "FAKETEAMID",
      }),
    ).toThrowError(/does not point at a readable regular file/)
  })

  it("errors when APPLE_API_KEY points at a file with no read permission", () => {
    const keyPath = fakeApiKeyFile()
    chmodSync(keyPath, 0o000)
    try {
      expect(() =>
        resolveNotarizeCredentials({
          APPLE_API_KEY: keyPath,
          APPLE_API_KEY_ID: "FAKE_KEY_ID",
          APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
          APPLE_TEAM_ID: "FAKETEAMID",
        }),
      ).toThrowError(/does not point at a readable regular file/)
    } finally {
      // Restore before afterEach's rmSync runs, in case the harness itself
      // is running as a user that respects these bits during cleanup.
      chmodSync(keyPath, 0o600)
    }
  })

  it("never includes the APPLE_API_KEY path in the file-not-found error", () => {
    const missingPath = join(tmpdir(), "desde-notarize-config-does-not-exist", "AuthKey_SECRETLOOKING.p8")
    let thrown: Error | undefined
    try {
      resolveNotarizeCredentials({
        APPLE_API_KEY: missingPath,
        APPLE_API_KEY_ID: "FAKE_KEY_ID",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        APPLE_TEAM_ID: "FAKETEAMID",
      })
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown?.message).not.toContain(missingPath)
    expect(thrown?.message).not.toContain("SECRETLOOKING")
  })

  it("errors naming both shapes' shortfalls when both are partially touched", () => {
    let thrown: Error | undefined
    try {
      resolveNotarizeCredentials({
        APPLE_API_KEY_ID: "FAKE_KEY_ID", // API-key shape: partial
        APPLE_ID: "fake@example.com", // Apple-ID shape: partial
      })
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    // Apple-ID is checked first (see F2 below) so its own shortfall is what
    // gets named as "missing:" — but the message must still surface that an
    // API-key set is also partially present, so the fix is discoverable
    // either way instead of looking like APPLE_ID alone is the problem.
    expect(thrown?.message).toMatch(/Apple ID/)
    expect(thrown?.message).toMatch(/missing:[^.]*APPLE_APP_SPECIFIC_PASSWORD/)
    expect(thrown?.message).toMatch(/API-key/)
  })

  // F2 (P2 finding): a COMPLETE API-key set must not silently mask a
  // touched-but-incomplete Apple-ID set. electron-builder's own
  // `getNotarizeOptions` checks `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`
  // FIRST — if either is present at all, it commits to that shape and
  // throws on an incomplete pair WITHOUT ever consulting the API-key
  // variables, even a fully complete set of them. This module used to check
  // API-key completeness first, which let this case return
  // `{ shape: "api-key" }` with zero validation of the incomplete Apple-ID
  // leftovers — a false "it's fine" that the real electron-builder run would
  // have refused.
  it("throws naming the Apple-ID shortfall even when a complete API-key set is also present (F2 — electron-builder checks Apple-ID first)", () => {
    const keyPath = fakeApiKeyFile()
    expect(() =>
      resolveNotarizeCredentials({
        APPLE_API_KEY: keyPath,
        APPLE_API_KEY_ID: "FAKE_KEY_ID",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
        APPLE_TEAM_ID: "FAKETEAMID",
        APPLE_ID: "fake@example.com", // Apple-ID shape: touched, but...
        // ...APPLE_APP_SPECIFIC_PASSWORD deliberately absent — partial.
      }),
    ).toThrowError(/Incomplete Apple ID.*missing:[^.]*APPLE_APP_SPECIFIC_PASSWORD/s)
  })

  // F2's other half: when BOTH shapes are simultaneously complete, the
  // SELECTED shape must be the one electron-builder will actually use —
  // otherwise this module's own "notarization ENABLED — <shape> credentials
  // found" log line (electron-builder.config.mjs) states something false
  // about which Apple account produced the release.
  it("selects apple-id (not api-key) when both shapes are simultaneously complete, matching electron-builder's own precedence", () => {
    const keyPath = fakeApiKeyFile()
    const result = resolveNotarizeCredentials({
      APPLE_API_KEY: keyPath,
      APPLE_API_KEY_ID: "FAKE_KEY_ID",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
      APPLE_ID: "fake@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
      APPLE_TEAM_ID: "FAKETEAMID",
    })
    expect(result).toEqual({ notarize: true, shape: "apple-id" })
  })
})
