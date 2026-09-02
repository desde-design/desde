#!/usr/bin/env node
// CLI entry shim. Two paths, and the choice between them is NOT "does a
// built bundle happen to exist" — see `useBundle` below for why that was
// the wrong rule and what replaced it:
//
//   1. Packaged/production: `../dist/cli.js` exists AND `../src/cli.ts`
//      does NOT (a payload assembled by `tasks/scripts/build-server-
//      package.mts` ships dist/ with no src/ beside it at all — see that
//      script's own layout table). Import the bundle directly.
//   2. Dev (a checkout, `../src/cli.ts` present): the TS source, loaded
//      live via the tsx respawn below — unchanged from before the build
//      existed, and now ALSO what runs in a checkout that has a stale
//      `dist/cli.js` sitting next to current `src/`.
//
// Resolution base is anchored to THIS file (`import.meta.url`), not the
// invocation cwd. Otherwise, running the bin from a directory that
// happens to lack `tsx` in its node_modules tree would cause the loader
// to fail before the CLI even boots — which would be opaque to the user
// since they passed the bin a relative repo-path argument expecting cwd
// to be theirs, not ours.

import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"

const binDir = dirname(fileURLToPath(import.meta.url))
const builtEntry = resolve(binDir, "..", "dist", "cli.js")
const srcEntry = resolve(binDir, "..", "src", "cli.ts")

// "Prefer the bundle whenever it exists" (the original rule) was a
// footgun: the FIRST `npm run build:server` in a checkout leaves
// `dist/cli.js` on disk forever after, so EVERY later `node bin/
// desde.mjs` — including ones run right after editing
// `src/**` — silently ran the stale bundle instead. You'd debug code that
// was not the code running, with no signal anything was wrong.
//
// The fix is not "never prefer the bundle" (a payload has to run it —
// there is no `src/` in a payload to fall back to) — it's that "a build
// artifact exists" was never the right signal for "this is a packaged
// payload, not a checkout." Whether `../src/cli.ts` exists beside it is:
// a checkout always has it, and a payload (per `build-server-package.mts`'s
// own copy list) never does. So source wins whenever it's present, exactly
// restoring pre-this-branch dev semantics, and the bundle is used only in
// the one case where there is no source to prefer.
//
// DESDE_EDITOR_USE_BUNDLE=1 is the explicit escape hatch for
// deliberately exercising the built bundle FROM a checkout (e.g. sanity-
// checking `npm run build:server`'s output before packaging it) without
// deleting or hiding `src/`.
const forceBundle = process.env.DESDE_EDITOR_USE_BUNDLE === "1"
if (forceBundle && !existsSync(builtEntry)) {
  console.error(
    `DESDE_EDITOR_USE_BUNDLE=1 is set, but the built bundle is missing at ${builtEntry}. ` +
      "Run `npm run build:server` in editor-cli/ first, or unset DESDE_EDITOR_USE_BUNDLE to run from source.",
  )
  process.exit(1)
}
const useBundle = forceBundle || (existsSync(builtEntry) && !existsSync(srcEntry))

if (useBundle) {
  // Built bundle present: import it directly, no respawn. The tsx respawn
  // below exists ONLY to get .ts source loaded under Node without a build
  // step (see the CJS-interop comment further down) — `dist/cli.js` is
  // already plain ESM JS, emitted by esbuild with `packages: "external"`,
  // so ordinary `import()` resolution (walking up from wherever this file
  // lives to find `node_modules`) is all it needs. Respawning it through
  // the tsx loader would be pointless work at best and could reintroduce
  // exactly the CJS-mode-under-.ts trap this shim's dev path exists to
  // dodge, since dist/ has no package.json of its own to declare ESM.
  await import(pathToFileURL(builtEntry).href)
} else {
  // We need to run TS source under Node without a pre-build step. The
  // in-process `register("tsx/esm")` / `tsImport()` / `register()` APIs
  // all fail under Node 20.6+ once the import graph crosses the repo
  // root: the root `package.json` has no `"type": "module"`, so tsx
  // transpiles those files in CJS mode and bare relative imports
  // (`./types` with no extension) blow up under CJS `require`.
  //
  // `node --import <tsx-loader>` registers the loader before module
  // resolution starts and treats every .ts file as ESM regardless of
  // the surrounding package.json. So this shim re-execs itself once
  // with that flag set, then loads the real CLI on the second pass.
  const RESPAWN_MARKER = "__DESDE_EDITOR_RESPAWNED__"

  if (process.env[RESPAWN_MARKER]) {
    await import("../src/cli.ts")
  } else {
    const here = dirname(fileURLToPath(import.meta.url))
    const tsxLoader = resolve(here, "..", "node_modules", "tsx", "dist", "loader.mjs")
    const child = spawn(
      process.execPath,
      [
        "--import",
        `file://${tsxLoader}`,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          [RESPAWN_MARKER]: "1",
          // tsx resolves TS path aliases (`@/*`) from the tsconfig it
          // discovers at the PROCESS CWD, not from the importing file.
          // Launched from outside the checkout (`node <checkout>/editor-cli/
          // bin/desde.mjs .` in a prototype directory), that lookup finds no
          // tsconfig and the first `@/` import dies with MODULE_NOT_FOUND
          // before the CLI prints anything. Pin the checkout's own root
          // tsconfig; an explicit TSX_TSCONFIG_PATH from the caller wins.
          TSX_TSCONFIG_PATH:
            process.env.TSX_TSCONFIG_PATH ?? resolve(here, "..", "..", "tsconfig.json"),
        },
      },
    )
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      else process.exit(code ?? 0)
    })
  }
}
