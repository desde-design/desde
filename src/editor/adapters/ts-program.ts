/**
 * Shared TS-checker `ts.Program` bootstrap for the `.d.ts` TS-checker
 * extractors — `vue-dts-meta` and `react-dts-meta` (audit Task 20 dedup:
 * the two adapters had byte-identical copies of this).
 *
 * Reads the tsconfig at `tsconfigPath` for its `compilerOptions` (module
 * resolution, lib, etc.) but roots the program at the CALLER-supplied
 * `rootFiles` instead of the tsconfig's own `include` — the tsconfig's
 * `include` typically excludes `node_modules`, but the whole point here is
 * to walk an installed library's shipped `.d.ts` declarations (Vue's
 * per-component `.vue.d.ts` files, React's package entry `.d.ts`).
 *
 * Returns `null` (never throws) when there are no root files, or when a
 * tsconfig path was supplied but is missing/unreadable — extractors treat that
 * as "emit nothing, let the composite fall through to the next manifest
 * source."
 *
 * **A NULL `tsconfigPath` is not a failure.** It means the prototype ships no
 * config at all, and the program falls back to {@link DEFAULT_DTS_OPTIONS}.
 * Until 2026-08-16 the caller refused instead, and MEASURED on an ordinary
 * plain-JavaScript React + Vite app (`tasks/react-hint-generation-phase0.md`
 * § 7.7) that cost the user EVERY installed library manifest: the auto-scan
 * found `@mui/material` perfectly well and the catalog still came back holding
 * one component, the user's own `App`. A JavaScript React app is a completely
 * ordinary shape and it was getting no design-system grounding.
 *
 * Defaults, not a written file. `resolve-tsconfig.ts`'s own note weighed
 * synthesizing a config into the user's repo and rejected it on placement /
 * gitignore / concurrent-write / read-only-filesystem grounds — all of which
 * are consequences of WRITING, and none of which apply to passing
 * `compilerOptions` straight to `ts.createProgram`. The cache-context concern
 * from that note is handled by the caller: a null tsconfig contributes a
 * distinct context key, so a project that later adds a config invalidates
 * rather than serving stale manifests.
 *
 * The options are tuned for the one job this program does — walk an installed
 * library's shipped `.d.ts`. Module resolution is `Bundler` because that is
 * what Vite does and what modern `exports`-map packages expect; nothing here
 * reads a `.js` file, since a program rooted at `.d.ts` resolves imports to
 * `.d.ts`.
 */
import * as ts from 'typescript'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_DTS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  strict: false,
}

export function buildProgram(
  tsconfigPath: string | null,
  rootFiles: string[],
): ts.Program | null {
  if (rootFiles.length === 0) return null
  let options: ts.CompilerOptions
  if (tsconfigPath === null) {
    options = DEFAULT_DTS_OPTIONS
  } else {
    if (!existsSync(tsconfigPath)) return null
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
    if (read.error) return null
    options = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath)).options
  }
  return ts.createProgram(rootFiles, {
    ...options,
    noEmit: true,
    skipLibCheck: true,
  })
}
