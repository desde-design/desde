/**
 * The single source of truth for the desktop shell's user-facing product
 * name (renamed from "Desde Editor" to "Desde", 2026-08-13 — see
 * `tasks/electron-app.md` §5 Phase 5b). Every dialog string and the window
 * title this package owns are built from this constant, not a literal
 * repeated at each call site — see `main.ts` and `child.ts`.
 *
 * Deliberately NOT sourced from `app.getName()` or electron-builder's
 * `productName` config at runtime: MEASURED against a real packaged build
 * (Phase 3's `.app`), `app.getName()` reads the packaged app's bundled
 * `package.json` "name" field (`@desde/desktop`) — electron-builder
 * does NOT rewrite that field to match `productName`, which only drives the
 * `.app` bundle name, Info.plist `CFBundleName`, and installer filenames
 * (see `electron-builder.config.mjs`). So neither Electron API is a
 * reliable source for the display name at runtime, in dev or packaged.
 *
 * Kept in sync BY HAND with `electron-builder.config.mjs`'s `productName` —
 * `desktop/__tests__/product-name.test.ts` asserts the two agree. This is
 * the same "no automation enforces it except a colocated test" tradeoff
 * `payload-manifest-guard.d.mts` documents for its own hand-written types:
 * `electron-builder.config.mjs` is plain, untranspiled `.mjs` and cannot
 * import this `.ts` file directly without a build step neither file wants.
 *
 * Scope note (Part 1 of the rename): this constant covers ONLY the desktop
 * shell (this package). The terminal-CLI UI (`editor-cli/ui-src`, shared
 * with the plain-browser flow) keeps saying "Desde Editor" — out of
 * scope by design, see `tasks/electron-app.md`'s Part 1 brief. `main.ts`'s
 * `page-title-updated` handling is what keeps the desktop window's own
 * title bar on this name without touching that shared file.
 */
export const PRODUCT_NAME = "Desde"
