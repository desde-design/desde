import { describe, expect, it } from "vitest"
import { DEMO_AVATARS } from "./demo-avatars"

// The cap `comments-routes.ts` enforces on `author.photoURL`. A portrait that
// grew past it would seed fine (the seed writes to storage directly) and then
// be refused the first time the Editor synced the same author to a viewer.
// tasks/scripts/demo-avatar-crops.mjs refuses to write one over the cap; this
// is the same bound checked from the shipping side.
const MAX_URL_CHARS = 2_048

describe("demo avatars", () => {
  it("are inline WebP data URIs, each under the API's photoURL cap, and all different", () => {
    const uris = Object.values(DEMO_AVATARS)
    expect(uris).toHaveLength(3)
    for (const uri of uris) {
      // WebP, not PNG: the same crop as a PNG does not fit the cap.
      expect(uri.startsWith("data:image/webp;base64,")).toBe(true)
      expect(uri.length).toBeLessThan(MAX_URL_CHARS)
      const bytes = Buffer.from(uri.slice("data:image/webp;base64,".length), "base64")
      // RIFF....WEBP, so a truncated or mislabelled payload fails here rather
      // than as a broken image in the pin.
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF")
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP")
    }
    expect(new Set(uris).size).toBe(3)
  })
})
