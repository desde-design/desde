#!/usr/bin/env node
// Bundles the Editor CLI's SERVER (not the browser UI — that's
// `build:ui` / `ui-src/vite.config.ts`) into plain JS with esbuild, so the
// CLI can run inside a packaged app (Electron, or a future standalone
// install) with no repo checkout, no `tsx`, and no devDependencies at
// runtime. Two entry points:
//
//   src/cli.ts                      -> dist/cli.js   (the `desde` bin)
//   src/mcp-proxy/stdio-server.ts   -> dist/mcp.js    (the `desde-mcp` bin)
//
// This file is plain `.mjs`, not TypeScript, on purpose: it must be able to
// run before any build exists (including its own first run), and `tsx`
// itself is one of the things this bundle exists to stop depending on.
//
// `packages: "external"` means only first-party code (this repo's
// `editor-cli/src/**` and the root `src/**` it imports via the `@/*` alias)
// gets inlined. Every bare import (`vite`, `zod`, `@modelcontextprotocol/sdk`,
// …) stays a runtime `import`/`require` and must be satisfied by the
// payload's own `node_modules` — see `tasks/electron-distribution-plan.md`
// Phase 1. This is deliberate: those packages have native bindings, CJS/ESM
// quirks, or are simply large, and re-bundling them buys nothing over
// installing them into the payload for real.
//
// The `@/*` alias (root `src/` imported as `@/editor/…`, `@/types/…`, from
// `editor-cli/tsconfig.json`'s `paths`) needs no plugin — esbuild reads that
// tsconfig's `paths` itself. `tsconfig` is still passed explicitly below
// rather than relying on esbuild's cwd-relative auto-discovery, so this
// script behaves identically no matter what directory `npm run build:server`
// happens to be invoked from.
//
// `esbuild` resolves via Node's normal `node_modules` walk-up from this
// script's own directory (`editor-cli/scripts/` has no local `node_modules`,
// so resolution climbs to the repo root's). It is declared in
// `editor-cli/package.json` devDependencies so a fresh clone's `npm install`
// actually puts it somewhere reachable — the walk-up is what makes it work
// in THIS checkout today, not what's supposed to make it work everywhere.
import { build } from "esbuild"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const editorCliRoot = resolve(scriptDir, "..")

const result = await build({
  entryPoints: {
    cli: resolve(editorCliRoot, "src/cli.ts"),
    mcp: resolve(editorCliRoot, "src/mcp-proxy/stdio-server.ts"),
  },
  outdir: resolve(editorCliRoot, "dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 35+ ships Node 22.14; matches the `engines.node` floor in
  // package.json (>=22.12, the LTS where `require(esm)` stabilized — Vite 8
  // itself requires >=20.19/22.12).
  target: "node22",
  // Only first-party code is inlined — see the module doc comment above.
  packages: "external",
  // A stack trace out of a packaged app, pointing at minified bundle
  // offsets with no source map, is unreadable. `true` = linked mode: a
  // sibling `.js.map` plus a `//# sourceMappingURL=` comment in the output.
  sourcemap: true,
  // Written to dist/metafile.json below. The staging script (Phase 1 task
  // 3) reads it to derive the payload's true runtime dependency list — this
  // is a hard requirement of that script, not diagnostic output.
  metafile: true,
  logLevel: "info",
  tsconfig: resolve(editorCliRoot, "tsconfig.json"),
})

// esbuild's own five host-adapter dynamic imports
// (`await import(pathToFileURL(...).href)` in nuxt/astro/react-router
// host.ts) resolve modules from the USER'S PROTOTYPE's node_modules by
// absolute path at runtime — a path that does not exist until Editor is
// pointed at a real project. They are fully opaque to static analysis (no
// shared literal prefix esbuild could partially bundle), so esbuild leaves
// them alone with no warning at all rather than a "cannot bundle, kept
// as-is" notice. Nothing to report here unless `result.warnings` is
// non-empty, in which case: print it and fail loud rather than silently
// waving every warning through.
if (result.warnings.length > 0) {
  console.error(`build:server produced ${result.warnings.length} unexpected warning(s):`)
  for (const warning of result.warnings) {
    console.error(warning)
  }
  process.exit(1)
}

await writeFile(
  resolve(editorCliRoot, "dist/metafile.json"),
  JSON.stringify(result.metafile, null, 2),
)
