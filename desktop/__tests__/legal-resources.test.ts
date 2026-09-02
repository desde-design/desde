/**
 * `legal-resources.ts` — AGPL-3.0 relicensing: where the LICENSE/third-party
 * notices/Electron attribution files live in a packaged vs. dev process, and
 * which one the "Licenses…" menu item should actually open. Same isolated,
 * no-real-Electron-process testing approach `payload-resolve.test.ts` uses.
 */
import { describe, expect, it } from "vitest"
import { pickLicensesMenuTarget, resolveLegalResourcePaths } from "../legal-resources.js"

describe("resolveLegalResourcePaths", () => {
  it("packaged: resolves all four paths under process.resourcesPath, flat", () => {
    const paths = resolveLegalResourcePaths("/app/desktop", "/app", "/Applications/Desde.app/Contents/Resources")
    expect(paths).toEqual({
      license: "/Applications/Desde.app/Contents/Resources/LICENSE",
      thirdPartyNotices: "/Applications/Desde.app/Contents/Resources/THIRD-PARTY-NOTICES.txt",
      electronLicense: "/Applications/Desde.app/Contents/Resources/ELECTRON-LICENSE.txt",
      electronChromiumLicenses: "/Applications/Desde.app/Contents/Resources/LICENSES.chromium.html",
    })
  })

  it("dev (not packaged): resolves against the repo root and the desktop package's own node_modules/electron", () => {
    const paths = resolveLegalResourcePaths("/repo/desktop", "/repo", null)
    expect(paths).toEqual({
      license: "/repo/LICENSE",
      thirdPartyNotices: "/repo/desktop/build/THIRD-PARTY-NOTICES.txt",
      electronLicense: "/repo/desktop/node_modules/electron/dist/LICENSE",
      electronChromiumLicenses: "/repo/desktop/node_modules/electron/dist/LICENSES.chromium.html",
    })
  })
})

describe("pickLicensesMenuTarget", () => {
  const paths = resolveLegalResourcePaths("/repo/desktop", "/repo", null)

  it("prefers the aggregated third-party notices document when it exists", () => {
    const target = pickLicensesMenuTarget(paths, (p) => p === paths.thirdPartyNotices)
    expect(target).toBe(paths.thirdPartyNotices)
  })

  it("falls back to Desde's own LICENSE when the notices document hasn't been generated yet (a dev checkout that never ran `npm run package`)", () => {
    const target = pickLicensesMenuTarget(paths, () => false)
    expect(target).toBe(paths.license)
  })
})
