/**
 * The single source of truth for the desktop shell's copyright line —
 * AGPL-3.0 relicensing. Same "kept in sync BY HAND, no automation enforces
 * it except a colocated test" tradeoff `product-name.ts` documents for
 * `PRODUCT_NAME`, and for the identical reason: `electron-builder.config.mjs`
 * is plain, untranspiled `.mjs` and cannot import this `.ts` module directly
 * without a build step neither file wants. `desktop/__tests__/copyright.test.ts`
 * asserts this string and `electron-builder.config.mjs`'s `copyright` field
 * agree.
 *
 * Consumed in two places at runtime:
 *  - `electron-builder.config.mjs`'s `copyright` field — written into the
 *    packaged app's Windows `LegalCopyright` version-info field and macOS
 *    `NSHumanReadableCopyright` Info.plist key (which the native About panel
 *    reads when `app.setAboutPanelOptions` doesn't override it).
 *  - `main.ts`'s `app.setAboutPanelOptions` call — sets the SAME string
 *    explicitly at runtime rather than relying solely on the Info.plist key,
 *    so the About panel is correct even before a real signed/packaged build
 *    exists (dev runs have no meaningfully-populated Info.plist).
 */
export const COPYRIGHT_LINE = "Copyright © 2026 Mo Chang"
