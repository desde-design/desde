/**
 * Where the AGPL-3.0 relicensing's attribution files live inside a running
 * Desde process — Desde's own LICENSE, the aggregated third-party notices
 * document, and Electron's own LICENSE/LICENSES.chromium.html. All four are
 * placed by `electron-builder.config.mjs`'s `extraResources` entries (see
 * that file's "── Licensing + third-party attribution ──" section) at the
 * SAME flat `Contents/Resources` directory a packaged app exposes as
 * `process.resourcesPath`.
 *
 * Pure logic, no Electron import — same reasoning as `payload-resolve.ts`:
 * testable directly without a real Electron process, and `main.ts` is the
 * only caller that actually has `app.isPackaged`/`process.resourcesPath` to
 * hand it.
 *
 * Two sources, mirroring `payload-resolve.ts`'s own split:
 *  1. Packaged app → `<process.resourcesPath>/<name>`, exactly where
 *     electron-builder.config.mjs's extraResources entries land.
 *  2. Dev (not packaged, e.g. `npm run desktop`) → the repo's own root
 *     `LICENSE`, the (devDependency) `electron` package's own bundled
 *     `dist/LICENSE`/`dist/LICENSES.chromium.html`, and whatever
 *     `desktop/build/THIRD-PARTY-NOTICES.txt` `generate-notices.mjs` last
 *     wrote there (absent until the first `npm run package`, hence
 *     `openLicenses` in main.ts falling back to the root LICENSE when it's
 *     missing — see that function's own doc comment).
 */
import { join } from "node:path"

export interface LegalResourcePaths {
  license: string
  thirdPartyNotices: string
  electronLicense: string
  electronChromiumLicenses: string
}

/**
 * `desktopRoot`/`repoRoot` are this package's own directory and its parent
 * (the repo root) — `main.ts` passes its own already-computed `DESKTOP_ROOT`/
 * `REPO_ROOT` constants, same pattern `resolvePayloadRoot`'s callers use.
 * `packagedResourcesPath` is `process.resourcesPath` when `app.isPackaged`,
 * `null` otherwise (the caller's responsibility, again matching
 * `resolvePayloadRoot`).
 */
export function resolveLegalResourcePaths(
  desktopRoot: string,
  repoRoot: string,
  packagedResourcesPath: string | null,
): LegalResourcePaths {
  if (packagedResourcesPath !== null) {
    return {
      license: join(packagedResourcesPath, "LICENSE"),
      thirdPartyNotices: join(packagedResourcesPath, "THIRD-PARTY-NOTICES.txt"),
      electronLicense: join(packagedResourcesPath, "ELECTRON-LICENSE.txt"),
      electronChromiumLicenses: join(packagedResourcesPath, "LICENSES.chromium.html"),
    }
  }
  return {
    license: join(repoRoot, "LICENSE"),
    thirdPartyNotices: join(desktopRoot, "build", "THIRD-PARTY-NOTICES.txt"),
    electronLicense: join(desktopRoot, "node_modules", "electron", "dist", "LICENSE"),
    electronChromiumLicenses: join(desktopRoot, "node_modules", "electron", "dist", "LICENSES.chromium.html"),
  }
}

/**
 * Which single file the "Licenses…" menu item should open — the aggregated
 * third-party notices document when it exists (it names, and points at, the
 * other three files sitting alongside it), falling back to Desde's own
 * LICENSE when it doesn't (a dev checkout that has never run `npm run
 * package` has no `build/THIRD-PARTY-NOTICES.txt` yet — see this module's
 * doc comment — but the root LICENSE always exists). `existsSyncFn` is
 * injected so this stays testable without touching the real filesystem.
 */
export function pickLicensesMenuTarget(
  paths: LegalResourcePaths,
  existsSyncFn: (path: string) => boolean,
): string {
  return existsSyncFn(paths.thirdPartyNotices) ? paths.thirdPartyNotices : paths.license
}
