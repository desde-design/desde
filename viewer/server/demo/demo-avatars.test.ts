import { describe, expect, it } from "vitest"
import { DEMO_AVATARS } from "./demo-avatars"

// The cap `comments-routes.ts` enforces on `author.photoURL`. A portrait that
// grew past it would seed fine (the seed writes to storage directly) and then
// be refused the first time the Editor synced the same author to a viewer.
const MAX_URL_CHARS = 2_048

describe("demo avatars", () => {
  it("are inline SVG data URIs, each under the API's photoURL cap, and all different", () => {
    const uris = Object.values(DEMO_AVATARS)
    expect(uris).toHaveLength(3)
    for (const uri of uris) {
      expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true)
      expect(uri.length).toBeLessThan(MAX_URL_CHARS)
      const svg = Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8")
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">')).toBe(true)
      expect(svg.endsWith("</svg>")).toBe(true)
      // Clipped to a circle, so the pin and the rail can show it as-is.
      expect(svg).toContain('<circle cx="32" cy="32" r="32"/>')
    }
    expect(new Set(uris).size).toBe(3)
  })
})
