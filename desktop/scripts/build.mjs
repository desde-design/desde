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
// `"node-gyp"` is ALSO external, for a narrower reason: `pacote` (added for
// `claude-runtime-installer.ts` — see that file's doc comment) depends on
// `@npmcli/run-script`, which calls `require.resolve("node-gyp/bin/
// node-gyp.js")` to support running a package's `install`/`prepare`
// lifecycle scripts. esbuild cannot statically resolve that (the specifier
// isn't a literal it can prove reachable) and emits a build WARNING, which
// this script treats as a hard failure below — correctly, in general
// (a silently-swallowed warning is how real defects hide), but this
// SPECIFIC one is unreachable code in our usage: `claude-runtime-installer.ts`
// only ever calls `pacote.extract()` on a REGISTRY spec (a `.tgz` fetch),
// and pacote's own docs are explicit that lifecycle scripts run ONLY for
// git/directory package sources, never registry ones. Marking the package
// external is the correct fix, not a suppression of a real problem: it
// leaves the (never-executed) `require.resolve` as a plain runtime call
// instead of asking esbuild to prove something about it statically that
// isn't provable, and it also keeps `node-gyp` itself out of the bundle.
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
  external: ["electron", "node-gyp"],
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
