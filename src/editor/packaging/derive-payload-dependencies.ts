/**
 * Turns an esbuild metafile into the dependency list a standalone payload's
 * `package.json` needs — see `scripts/build-server-package.mts`
 * (Phase 1 task 3 of `tasks/electron-app.md`).
 *
 * **Why the metafile and not a hand-maintained list.** `editor-cli/scripts/
 * build-server.mjs` bundles `editor-cli/src/cli.ts` (and the MCP stdio
 * entry) with `packages: "external"` — every bare-specifier import stays a
 * runtime `import` instead of getting inlined. Some of those imports come
 * from `editor-cli/src/**` itself; a good number come from ROOT `src/**`,
 * reached through the `@/*` alias, and root `src/` has 483 import lines
 * crossing that boundary (measured, `tasks/electron-app.md` C1). A
 * hand-written list drifts the moment either tree adds or drops an import;
 * the metafile is the bundler's own record of what it actually left
 * external, so it cannot drift from what was actually built.
 *
 * **Two packages this function must never drop.** `typescript` and
 * `vue-component-meta` are declared as devDependencies in BOTH
 * `editor-cli/package.json` and root `package.json`, but
 * `src/editor/edit-service/build-manifest-source.ts` imports both at
 * runtime (inside a `Promise.all` with no try/catch) to build the
 * TS-checker manifest source — the design-system-grounding "moat" this
 * codebase's CLAUDE.md calls out. Because both show up in the metafile's
 * externals like any other runtime import, this function needs no special
 * case for them: dropping them would be a bug in the metafile-derivation
 * logic, not a classification this function has to hardcode. The colocated
 * test pins this so a future refactor of the derivation can't silently
 * regress it.
 */

import { builtinModules } from "node:module"

/** The subset of esbuild's `Metafile` shape this function actually reads. */
interface EsbuildMetafileImport {
  path: unknown
  external?: unknown
}

interface EsbuildMetafileOutput {
  imports?: unknown
}

/**
 * The npm package name a bare-specifier import resolves to — everything up
 * to and including the scope segment for `@scope/name/subpath` imports, or
 * just the first segment for unscoped ones.
 *
 * Needed because esbuild's metafile records the exact specifier a source
 * file wrote (`@modelcontextprotocol/sdk/server/mcp.js`), not the npm
 * package that owns it — and a payload's `package.json` declares the
 * PACKAGE, not one of its subpaths.
 */
function packageNameFor(specifier: string): string {
  const segments = specifier.split("/")
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
}

/**
 * Node builtins never need a `package.json` entry. Both `node:fs`-style
 * specifiers and legacy unprefixed ones (`fs`, `path`) show up in the
 * metafile — esbuild's externalization doesn't normalize them — so both
 * forms are checked. `node:module`'s own `builtinModules` list is static
 * data baked into the running Node binary, not a filesystem or environment
 * read, so importing it here doesn't cost this module its purity.
 */
const BUILTIN_MODULE_NAMES = new Set(builtinModules)

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || BUILTIN_MODULE_NAMES.has(specifier)
}

/**
 * Every bare-specifier import esbuild left external across ALL of a
 * metafile's outputs (`cli.js` and `mcp.js` — a union, since either entry
 * needing a package at runtime means the payload needs it installed),
 * minus Node builtins, collapsed from import specifiers to npm package
 * names, each resolved to a pinned version via `resolveVersion`.
 *
 * `resolveVersion` is injected rather than reading `node_modules` directly
 * so this function stays pure and testable with a synthetic metafile and a
 * fake resolver — no filesystem, no real build required. The caller (the
 * staging script) supplies a resolver that reads the package's OWN
 * `package.json` `version` from wherever it actually resolves on disk, and
 * pins that exact version rather than copying a semver range from a source
 * `package.json` — the range and the installed version can differ, and the
 * payload must reproduce what was tested, not merely something compatible.
 */
export function derivePayloadDependencies(
  metafile: { inputs: Record<string, unknown>; outputs: Record<string, unknown> },
  resolveVersion: (pkg: string) => string,
): Record<string, string> {
  const packages = new Set<string>()

  for (const rawOutput of Object.values(metafile.outputs)) {
    const output = rawOutput as EsbuildMetafileOutput
    const imports = output?.imports
    if (!Array.isArray(imports)) continue
    for (const rawImport of imports as EsbuildMetafileImport[]) {
      if (rawImport?.external !== true) continue
      const specifier = rawImport.path
      if (typeof specifier !== "string" || specifier.length === 0) continue
      if (isNodeBuiltin(specifier)) continue
      packages.add(packageNameFor(specifier))
    }
  }

  const dependencies: Record<string, string> = {}
  for (const pkg of [...packages].sort()) {
    dependencies[pkg] = resolveVersion(pkg)
  }
  return dependencies
}
