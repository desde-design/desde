/**
 * Pins the desktop shell's copyright string (AGPL-3.0 relicensing) and
 * cross-checks it against `electron-builder.config.mjs`'s `copyright`
 * field — the two are kept in sync BY HAND (electron-builder's config is
 * plain, untranspiled `.mjs` and can't import a `.ts` module directly, see
 * `copyright.ts`'s own doc comment), and nothing else enforces they agree.
 * Same pattern as `product-name.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { COPYRIGHT_LINE } from "../copyright.js"

describe("copyright line", () => {
  it("is a Copyright © line naming Mo Chang", () => {
    expect(COPYRIGHT_LINE).toBe("Copyright © 2026 Mo Chang")
  })

  it("electron-builder.config.mjs pins the same copyright string", async () => {
    // Same never-touched-on-disk placeholder convention product-name.test.ts
    // uses — the config module's payload-dependent notices scan is skipped
    // for a nonexistent payload dir (see electron-builder.config.mjs's
    // `noticesEnabled` doc comment), so this import does no real I/O beyond
    // resolving the (real, installed) `electron` package's own LICENSE
    // files and this repo's own root LICENSE.
    process.env.DESDE_PAYLOAD_DIR = "/tmp/pt-payload"
    delete process.env.DESDE_DESKTOP_SIGN
    try {
      const { default: config } = await import("../electron-builder.config.mjs")
      expect(config.copyright).toBe(COPYRIGHT_LINE)
    } finally {
      delete process.env.DESDE_PAYLOAD_DIR
    }
  })
})
