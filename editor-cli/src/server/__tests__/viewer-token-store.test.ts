import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearDefaultViewerOrigin,
  clearViewerToken,
  normalizeOrigin,
  readDefaultViewerOrigin,
  readViewerToken,
  viewerTokenFilePath,
  writeDefaultViewerOrigin,
  writeViewerToken,
} from "../viewer-token-store"

const dirs: string[] = []
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "viewer-tok-"))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe("normalizeOrigin", () => {
  /**
   * Without this, a trailing slash silently creates a SECOND entry and the
   * user is asked to sign in again for a viewer they already have a token
   * for.
   */
  it("collapses the same viewer typed different ways to one key", () => {
    const forms = [
      "https://v.example.com",
      "https://v.example.com/",
      "https://V.Example.com",
      "https://v.example.com/review/abc",
    ]
    const keys = new Set(forms.map(normalizeOrigin))
    expect(keys.size).toBe(1)
  })

  it("keeps distinct viewers distinct, including by port", () => {
    expect(normalizeOrigin("http://localhost:3100")).not.toBe(normalizeOrigin("http://localhost:3200"))
    expect(normalizeOrigin("https://a.example.com")).not.toBe(normalizeOrigin("https://b.example.com"))
  })

  it("does not throw on an unparseable value", () => {
    // A malformed config must not crash the Editor at boot.
    expect(() => normalizeOrigin("not a url")).not.toThrow()
  })
})

describe("viewer token store", () => {
  it("round-trips a token", async () => {
    const h = home()
    await writeViewerToken("https://v.example.com", "dsv_abc_def", h)
    expect(await readViewerToken("https://v.example.com/", h)).toBe("dsv_abc_def")
  })

  /**
   * A person can review against a team instance and a local one. One flat
   * value would send the wrong credential, which the viewer answers with a
   * 401 that reads as "expired" rather than "wrong server".
   */
  it("keeps tokens for different viewers independent", async () => {
    const h = home()
    await writeViewerToken("https://team.example.com", "dsv_team", h)
    await writeViewerToken("http://localhost:3100", "dsv_local", h)
    expect(await readViewerToken("https://team.example.com", h)).toBe("dsv_team")
    expect(await readViewerToken("http://localhost:3100", h)).toBe("dsv_local")
  })

  it("returns null for an unknown viewer and for a missing file", async () => {
    const h = home()
    expect(await readViewerToken("https://never.example.com", h)).toBeNull()
    await writeViewerToken("https://a.example.com", "dsv_a", h)
    expect(await readViewerToken("https://b.example.com", h)).toBeNull()
  })

  it("clears one viewer without touching the others", async () => {
    const h = home()
    await writeViewerToken("https://a.example.com", "dsv_a", h)
    await writeViewerToken("https://b.example.com", "dsv_b", h)
    await clearViewerToken("https://a.example.com", h)
    expect(await readViewerToken("https://a.example.com", h)).toBeNull()
    expect(await readViewerToken("https://b.example.com", h)).toBe("dsv_b")
  })

  it("clearing an unknown viewer is a no-op, not an error", async () => {
    const h = home()
    await expect(clearViewerToken("https://nope.example.com", h)).resolves.toBeUndefined()
  })

  it("writes the file 0600 — it holds a bearer secret", async () => {
    const h = home()
    await writeViewerToken("https://v.example.com", "dsv_x", h)
    expect(statSync(viewerTokenFilePath(h)).mode & 0o777).toBe(0o600)
  })

  it("survives a corrupt file by re-authenticating rather than refusing to start", async () => {
    const h = home()
    await writeViewerToken("https://v.example.com", "dsv_x", h)
    const { writeFileSync } = await import("node:fs")
    writeFileSync(viewerTokenFilePath(h), "{ not json")
    expect(await readViewerToken("https://v.example.com", h)).toBeNull()
    // ...and a later write repairs it rather than compounding the damage.
    await writeViewerToken("https://v.example.com", "dsv_y", h)
    expect(await readViewerToken("https://v.example.com", h)).toBe("dsv_y")
  })
})

/**
 * The machine's default viewer (2026-08-26). One origin beside the token map,
 * so a repo that has never been through the connect dialog can still be
 * resolved against "my viewer" at boot.
 */
describe("default viewer origin", () => {
  it("is null until set, and round-trips normalized", async () => {
    const h = home()
    expect(await readDefaultViewerOrigin(h)).toBeNull()

    await writeDefaultViewerOrigin("HTTPS://Viewer.Example.com/", h)
    // Normalized on the way in, so a trailing slash or odd casing typed into
    // the settings field still matches the key `readViewerToken` looks up.
    expect(await readDefaultViewerOrigin(h)).toBe(normalizeOrigin("https://viewer.example.com"))
  })

  it("does not disturb stored tokens, and they do not disturb it", async () => {
    const h = home()
    await writeViewerToken("https://a.example.com", "dsv_a", h)
    await writeDefaultViewerOrigin("https://a.example.com", h)
    await writeViewerToken("https://b.example.com", "dsv_b", h)

    expect(await readDefaultViewerOrigin(h)).toBe(normalizeOrigin("https://a.example.com"))
    expect(await readViewerToken("https://a.example.com", h)).toBe("dsv_a")
    expect(await readViewerToken("https://b.example.com", h)).toBe("dsv_b")
  })

  it("clearing the default leaves that viewer's token in place", async () => {
    const h = home()
    await writeViewerToken("https://a.example.com", "dsv_a", h)
    await writeDefaultViewerOrigin("https://a.example.com", h)

    await clearDefaultViewerOrigin(h)

    expect(await readDefaultViewerOrigin(h)).toBeNull()
    // The credential outlives the preference: re-pointing at this viewer
    // later must not re-ask for a token that was never revoked.
    expect(await readViewerToken("https://a.example.com", h)).toBe("dsv_a")
  })

  it("clearing an absent default does not create the credentials file", async () => {
    const h = home()
    await clearDefaultViewerOrigin(h)
    expect(() => statSync(viewerTokenFilePath(h))).toThrow()
  })

  it("clearing an absent token does not create the credentials file", async () => {
    const h = home()
    await clearViewerToken("https://never.example.com", h)
    expect(() => statSync(viewerTokenFilePath(h))).toThrow()
  })
})
