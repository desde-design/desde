#!/usr/bin/env node
// Bundles the desktop shell's TWO entry points into plain CJS with esbuild —
// mirrors editor-cli/scripts/build-server.mjs's shape (same reasons: no
// runtime dependency on tsx or a repo checkout once built).
//
//   main.ts     -> dist/main.js      (Electron main process)
//   preload.ts  -> dist/preload.js   (contextBridge, loaded via
//                                      webPreferences.preload)
//
// CJS, not ESM, for both: `preload.js` is loaded by a SANDBOXED
// (`sandbox: true`) BrowserWindow, and Electron's sandboxed preload only
// supports CommonJS — there is no ESM preload story that works with
// `sandbox: true` as of Electron 35. `main.js` is built the same way for
// consistency (one format for both outputs) and because CJS gives `__dirname`
// natively, which `main.ts` uses to locate `preload.js` and the repo root.
//
// `bundle: true` inlines desktop/'s own source AND the two editor-cli
// primitives it reuses (`ready-line.ts`, `editor-boot-failure.ts`,
// `child-tracker.ts`) — see child.ts's doc comment for why those are
// imported from source rather than re-implemented. `external: ["electron"]`
// keeps the special `electron` module a runtime `require()`, resolved by
// Electron's own loader — esbuild cannot usefully bundle it (it isn't a
// normal npm package; Electron intercepts the `require`).
//
import { build } from "esbuild"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, "..")

const result = await build({
  entryPoints: {
    main: resolve(desktopRoot, "main.ts"),
    preload: resolve(desktopRoot, "preload.ts"),
  },
  outdir: resolve(desktopRoot, "dist"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // Electron 35+ ships Node 22.14 — matches engines.node (>=22.12) and the
  // payload's own floor (editor-cli/package.json).
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  tsconfig: resolve(desktopRoot, "tsconfig.json"),
})

if (result.warnings.length > 0) {
  console.error(`desktop build:desktop produced ${result.warnings.length} unexpected warning(s):`)
  for (const warning of result.warnings) console.error(warning)
  process.exit(1)
}
