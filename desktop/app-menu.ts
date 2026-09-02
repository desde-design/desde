/**
 * The mac "appMenu" item — the menu next to the Apple logo (About / Hide /
 * Quit and friends). Built as its own module so the LABELS are unit-testable
 * without needing a real Electron process: `MenuItemConstructorOptions` is a
 * TYPE ONLY import (erased at build time, no `require("electron")` at
 * runtime), and this module returns a plain data structure — `main.ts` is
 * the only place that actually hands it to the real `electron` module's
 * `Menu.buildFromTemplate`.
 *
 * ── F4 (tasks/electron-app.md §5 Phase 5b review) — why this exists at all ──
 *
 * `main.ts` used to build this item with Electron's `{ role: "appMenu" }`
 * convenience, which auto-labels the WHOLE submenu — the menu title itself,
 * "About …", "Hide …", "Quit …" — from `app.getName()`. Setting the window
 * title (`product-name.ts`'s `PRODUCT_NAME`) does NOT change that: it's a
 * completely separate Electron API, and `app.getName()` reads the packaged
 * app's bundled `package.json` "name" field, `@desde/desktop` — NOT
 * `productName` from `electron-builder.config.mjs` (see product-name.ts's
 * own doc comment for how this was MEASURED against a real packaged build).
 * So the single most visible place a macOS app's name appears — the
 * menu-bar item next to the Apple logo, plus every item under it — could
 * still read the old internal package name after the desktop shell's
 * dialogs and window title had already been renamed to Desde.
 *
 * The fix is to build the submenu explicitly with `PRODUCT_NAME`-based
 * `label`s, while keeping each item's `role` so the native OS behavior
 * (opening the About panel, hiding the app, quitting, the standard
 * accelerators) is unaffected — a `role` still does its job when a `label`
 * is also supplied; only the auto-generated TEXT is replaced.
 *
 * Deliberately does NOT touch `desktop/package.json`'s own `"name"` field,
 * the repo name, or any CLI identifier — those are out of scope for the
 * customer-facing rename (see tasks/electron-app.md §5 Phase 5b, Part 1) and
 * this fix doesn't need them: overriding each item's `label` sidesteps
 * `app.getName()` entirely rather than trying to change what it returns.
 *
 * ── "Licenses…" (AGPL-3.0 relicensing) ──────────────────────────────────
 *
 * Added next to "About Desde" — the conventional macOS neighbor for a
 * legal/attribution item, and the one place this task's brief names by
 * name ("you already own desktop/app-menu.ts, so a 'Licenses' item there is
 * natural"). `openLicenses` is passed in rather than imported, so this file
 * stays Electron-free for testability (see the module doc comment above):
 * `main.ts` is the only place that actually knows how to resolve and open a
 * file (`legal-resources.ts` + `shell.openPath`). Optional — omitting it
 * (as every existing colocated test does) produces a plain, disabled-look
 * menu item rather than a crash, so `app-menu.test.ts`'s existing assertions
 * don't need to change.
 */
import type { MenuItemConstructorOptions } from "electron"
import { PRODUCT_NAME } from "./product-name.js"

/**
 * The full `{ role: "appMenu" }`-equivalent item, with every
 * name-in-its-label sub-item relabeled to `PRODUCT_NAME`. Pass this as the
 * first entry of the mac menu template, in place of `{ role: "appMenu" }`.
 */
export function buildAppMenuItem(openLicenses?: () => void): MenuItemConstructorOptions {
  return {
    label: PRODUCT_NAME,
    submenu: [
      { role: "about", label: `About ${PRODUCT_NAME}` },
      { label: "Licenses…", click: openLicenses },
      { type: "separator" },
      // "Services" is an OS-controlled submenu (system-provided text, not
      // app-name-based) — no label override needed or possible here.
      { role: "services" },
      { type: "separator" },
      { role: "hide", label: `Hide ${PRODUCT_NAME}` },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit", label: `Quit ${PRODUCT_NAME}` },
    ],
  }
}
