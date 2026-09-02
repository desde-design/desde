/**
 * Pins the desktop shell's product identity. `appId` is the macOS bundle
 * identifier — the load-bearing one, per `electron-builder.config.mjs`'s own
 * doc comment: changing it after a real release ships breaks that release's
 * ability to recognise its own updates. This test exists so a future rename
 * can't silently change it again the way the Desde -> Desde rename
 * (2026-08-13, `tasks/electron-app.md` §5 Phase 5b) deliberately did once.
 *
 * Also cross-checks `productName` against `product-name.ts`'s
 * `PRODUCT_NAME` — the two are kept in sync BY HAND (electron-builder's
 * config is plain, untranspiled `.mjs` and can't import a `.ts` module
 * directly — see product-name.ts's own doc comment), and nothing else
 * enforces they agree.
 */
import { describe, expect, it } from "vitest"
import { PRODUCT_NAME } from "../product-name.js"

describe("product identity", () => {
  it("PRODUCT_NAME is Desde", () => {
    expect(PRODUCT_NAME).toBe("Desde")
  })

  it("electron-builder.config.mjs pins appId to com.desde.editor and productName to PRODUCT_NAME", async () => {
    // A placeholder, never-touched-on-disk path — same convention
    // payload-manifest-guard.test.ts and payload-resolve.test.ts already use
    // for a payload dir the config module never actually reads from disk on
    // this (unsigned, DESDE_DESKTOP_SIGN unset) branch.
    process.env.DESDE_PAYLOAD_DIR = "/tmp/pt-payload"
    delete process.env.DESDE_DESKTOP_SIGN
    try {
      const { default: config } = await import("../electron-builder.config.mjs")
      expect(config.appId).toBe("com.desde.editor")
      expect(config.productName).toBe(PRODUCT_NAME)
    } finally {
      delete process.env.DESDE_PAYLOAD_DIR
    }
  })
})
