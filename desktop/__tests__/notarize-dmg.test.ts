/**
 * `notarize-dmg.mjs` — Job 1 fix, tasks/electron-app.md §5 Phase 5c ("the
 * dmg is unsigned"). Every credential value below is a FAKE fixture, never
 * anything from the real `.env.signing.local`. `notarizeDmg`'s real network
 * call is never exercised here — every test injects a stub `notarizeFn`
 * instead, matching the house rule that a unit test never hits Apple's
 * notary service.
 */
import { describe, expect, it, vi } from "vitest"
import { buildNotarizeCredentials, notarizeDmg } from "../scripts/notarize-dmg.mjs"

describe("buildNotarizeCredentials", () => {
  it("builds Apple-ID credentials from a complete set", () => {
    const result = buildNotarizeCredentials({
      APPLE_ID: "fake@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
      APPLE_TEAM_ID: "FAKETEAMID",
    })
    expect(result).toEqual({
      appleId: "fake@example.com",
      appleIdPassword: "fake-app-specific-password",
      teamId: "FAKETEAMID",
    })
  })

  it("builds API-key credentials from a complete set", () => {
    const result = buildNotarizeCredentials({
      APPLE_API_KEY: "/fake/AuthKey_FAKE1234.p8",
      APPLE_API_KEY_ID: "FAKE_KEY_ID",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    })
    expect(result).toEqual({
      appleApiKey: "/fake/AuthKey_FAKE1234.p8",
      appleApiKeyId: "FAKE_KEY_ID",
      appleApiIssuer: "00000000-0000-0000-0000-000000000000",
    })
  })

  it("prefers Apple-ID when both shapes are complete — matches electron-builder's own precedence (F2)", () => {
    const result = buildNotarizeCredentials({
      APPLE_ID: "fake@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
      APPLE_TEAM_ID: "FAKETEAMID",
      APPLE_API_KEY: "/fake/AuthKey_FAKE1234.p8",
      APPLE_API_KEY_ID: "FAKE_KEY_ID",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    })
    expect(result).toEqual({
      appleId: "fake@example.com",
      appleIdPassword: "fake-app-specific-password",
      teamId: "FAKETEAMID",
    })
  })

  it("returns null for an incomplete Apple-ID set (missing team id)", () => {
    const result = buildNotarizeCredentials({
      APPLE_ID: "fake@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "fake-app-specific-password",
    })
    expect(result).toBeNull()
  })

  it("returns null for an incomplete API-key set (missing issuer)", () => {
    const result = buildNotarizeCredentials({
      APPLE_API_KEY: "/fake/AuthKey_FAKE1234.p8",
      APPLE_API_KEY_ID: "FAKE_KEY_ID",
    })
    expect(result).toBeNull()
  })

  it("returns null when nothing is set", () => {
    expect(buildNotarizeCredentials({})).toBeNull()
  })
})

describe("notarizeDmg", () => {
  it("calls the injected notarize function with appPath + credentials, never the real @electron/notarize", async () => {
    const notarizeFn = vi.fn().mockResolvedValue(undefined)
    await notarizeDmg(
      "/fake/release/Desde-0.1.0-arm64.dmg",
      { APPLE_ID: "fake@example.com", APPLE_APP_SPECIFIC_PASSWORD: "fake-pw", APPLE_TEAM_ID: "FAKETEAMID" },
      notarizeFn,
    )
    expect(notarizeFn).toHaveBeenCalledTimes(1)
    expect(notarizeFn).toHaveBeenCalledWith({
      appPath: "/fake/release/Desde-0.1.0-arm64.dmg",
      appleId: "fake@example.com",
      appleIdPassword: "fake-pw",
      teamId: "FAKETEAMID",
    })
  })

  it("throws, and never calls notarizeFn, when no credentials are present", async () => {
    const notarizeFn = vi.fn().mockResolvedValue(undefined)
    await expect(notarizeDmg("/fake/release/Desde-0.1.0-arm64.dmg", {}, notarizeFn)).rejects.toThrow(
      /no complete Apple notarization credentials/,
    )
    expect(notarizeFn).not.toHaveBeenCalled()
  })

  it("propagates a rejection from the injected notarize function", async () => {
    const notarizeFn = vi.fn().mockRejectedValue(new Error("fake notarytool rejection"))
    await expect(
      notarizeDmg(
        "/fake/release/Desde-0.1.0-arm64.dmg",
        { APPLE_ID: "fake@example.com", APPLE_APP_SPECIFIC_PASSWORD: "fake-pw", APPLE_TEAM_ID: "FAKETEAMID" },
        notarizeFn,
      ),
    ).rejects.toThrow(/fake notarytool rejection/)
  })
})
