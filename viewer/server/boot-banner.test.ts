import { describe, expect, it } from "vitest"
import { bootBannerLines } from "./boot-banner"

const base = {
  profile: "selfhost",
  bridgeVersion: "2026-09-08a",
  publicUrl: "http://localhost:3100",
  originLines: ["[viewer] origin line one", "[viewer] origin line two"],
  emailStatus: "email is not configured",
  adminTokenSet: false,
  signInUrl: null as string | null,
}

const SIGN_IN = "http://localhost:3100/api/v1/auth/local?token=abc123"

describe("bootBannerLines", () => {
  it("puts the sign-in URL on the very last line", () => {
    const lines = bootBannerLines({ ...base, signInUrl: SIGN_IN })
    expect(lines.at(-1)).toContain(SIGN_IN)
  })

  it("keeps the sign-in URL last even with every warning present", () => {
    // The reported bug: four warning lines ended up below the URL because they
    // went out on a different stream. Ordering is decided here now, so the
    // noisiest configuration is the one worth asserting.
    const lines = bootBannerLines({
      ...base,
      adminTokenSet: false,
      originLines: [
        "[viewer] Prototypes built with a root-absolute asset base will not fully load.",
        "[viewer] Fix: set VIEWER_SERVE_DOMAIN, or build prototypes with a relative base.",
      ],
      signInUrl: SIGN_IN,
    })
    const urlIndex = lines.findIndex((line) => line.includes(SIGN_IN))
    expect(urlIndex).toBe(lines.length - 1)
    for (const warning of ["VIEWER_ADMIN_TOKEN", "VIEWER_SERVE_DOMAIN", "root-absolute"]) {
      const at = lines.findIndex((line) => line.includes(warning))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(urlIndex)
    }
  })

  it("prints the URL exactly once, so there is nothing to copy by mistake", () => {
    const lines = bootBannerLines({ ...base, signInUrl: SIGN_IN })
    expect(lines.filter((line) => line.includes(SIGN_IN))).toHaveLength(1)
  })

  it("says nothing about signing in when no local token was minted", () => {
    const lines = bootBannerLines({ ...base, signInUrl: null })
    expect(lines.join("\n")).not.toContain("sign in")
    expect(lines.join("\n")).not.toContain("auth/local")
  })

  it("ends on the viewer's own URL when there is no sign-in URL", () => {
    // The reported bug (Mo, 2026-09-14): a `docker run` banner that ended on
    // the VIEWER_ADMIN_TOKEN warning, with the address to open buried in the
    // profile line five lines up.
    const lines = bootBannerLines({ ...base, signInUrl: null })
    expect(lines.at(-1)).toBe("  http://localhost:3100")
    expect(lines.at(-2)).toBe("")
    expect(lines.at(-3)).toBe("[viewer] Open this in a browser:")
  })

  it("keeps every warning above the URL to open, sign-in URL or not", () => {
    for (const signInUrl of [null, SIGN_IN]) {
      const lines = bootBannerLines({ ...base, adminTokenSet: false, signInUrl })
      const warningAt = lines.findIndex((line) => line.includes("VIEWER_ADMIN_TOKEN"))
      expect(warningAt).toBeGreaterThanOrEqual(0)
      expect(warningAt).toBeLessThan(lines.length - 1)
    }
  })

  it("always ends on a URL, so `.at(-1)` is what a reader copies", () => {
    for (const signInUrl of [null, SIGN_IN]) {
      for (const adminTokenSet of [false, true]) {
        const lines = bootBannerLines({ ...base, adminTokenSet, signInUrl })
        expect(lines.at(-1)?.trim()).toMatch(/^https?:\/\//)
      }
    }
  })

  it("omits the admin-bearer notice when a token is configured", () => {
    const lines = bootBannerLines({ ...base, adminTokenSet: true })
    expect(lines.join("\n")).not.toContain("VIEWER_ADMIN_TOKEN")
  })

  it("leads with the profile line and keeps the origin lines in the order given", () => {
    const lines = bootBannerLines({ ...base, signInUrl: SIGN_IN })
    expect(lines[0]).toBe("[viewer] profile=selfhost bridge=2026-09-08a → http://localhost:3100")
    expect(lines[1]).toBe("[viewer] origin line one")
    expect(lines[2]).toBe("[viewer] origin line two")
  })
})
