/**
 * Discovery for `ReactDtsMetaManifestSource`.
 *
 * React has no per-component declaration-file convention (the Vue
 * `.vue.d.ts` marker has no analogue), so "discovery" here is resolving a
 * package's *type entry* `.d.ts` — the barrel the extractor then scans for
 * component exports. The component-vs-not decision is made inside the
 * extractor (a type with a React-ish call/construct signature), so this
 * layer only has to find the entry file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

interface PackageJsonTypes {
  main?: string
  types?: string
  typings?: string
  exports?: Record<string, unknown> | string
}

/**
 * A declaration file by any of its three extensions. `.d.mts` / `.d.cts` are
 * NOT `.d.ts` by suffix, so matching on `.d.ts` alone silently skipped every
 * ESM-only package that names its types through an `exports` condition.
 */
const DTS_RE = /\.d\.[cm]?ts$/

/** Pull a `.d.ts` path out of an `exports` "." entry, which may nest. */
function typesFromExports(exportsField: PackageJsonTypes['exports']): string | null {
  if (!exportsField || typeof exportsField !== 'object') return null
  const dot = (exportsField as Record<string, unknown>)['.']
  const visit = (node: unknown): string | null => {
    if (typeof node === 'string') return DTS_RE.test(node) ? node : null
    if (Array.isArray(node)) {
      // `exports` conditions may be an array of fallbacks — take the first
      // branch that yields a `.d.ts`.
      for (const item of node) {
        const found = visit(item)
        if (found) return found
      }
      return null
    }
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>
      // Prefer an explicit `types` condition, else recurse common ones.
      for (const key of ['types', 'import', 'require', 'default']) {
        const found = visit(o[key])
        if (found) return found
      }
    }
    return null
  }
  return visit(dot)
}

/**
 * Where TypeScript itself looks when a package DECLARES no types: the
 * declaration sibling of `main`, then a bare `index.d.ts` at the package root.
 *
 * Plenty of published React libraries rely on this and name no `types` field
 * at all. MEASURED 2026-09-15: `grommet` ships a root `index.d.ts` with 345
 * exports and no `types` field, and `@cloudscape-design/components` ships one
 * with 191 exports behind `exports["."]: "./index.js"` — a string that is not
 * a declaration path, so nothing above this resolves it. Both extract cleanly
 * once the entry is found; both were invisible to every caller of this
 * function. `src/editor/ingest/git-repo.ts` already carried a local copy of
 * this fallback to answer "does this repo ship types", which made the ingest
 * lane answer yes and then extract nothing.
 */
function implicitDtsEntry(packageRoot: string, main: string | undefined): string | null {
  const candidates: string[] = []
  if (typeof main === 'string' && main.length > 0) {
    if (/\.[cm]?js$/.test(main)) {
      // `dist/index.js` → `dist/index.d.ts`. TypeScript pairs `.mjs` with
      // `.d.mts` and `.cjs` with `.d.cts`, so try that first — but plenty of
      // packages emit ONE `.d.ts` beside an `.mjs`, so try the plain form too.
      candidates.push(main.replace(/\.([cm]?)js$/, '.d.$1ts'), main.replace(/\.[cm]?js$/, '.d.ts'))
    } else {
      // `main: "lib"` names a DIRECTORY, so its declarations are `lib/index.d.ts`.
      candidates.push(`${main}/index.d.ts`)
    }
  }
  candidates.push('index.d.ts')
  for (const rel of candidates) {
    const abs = resolve(packageRoot, rel)
    if (DTS_RE.test(abs) && existsSync(abs)) return abs
  }
  return null
}

/**
 * Resolve the entry declaration file(s) for a package's types. Reads
 * `package.json` `types` / `typings` / `exports["."]`, and falls back to the
 * layout TypeScript resolves implicitly ({@link implicitDtsEntry}). Returns an
 * empty array when the package ships no resolvable declaration entry.
 *
 * A package that DECLARES an entry which is not on disk falls through to the
 * implicit layout rather than reporting nothing: a stale `types` field is a
 * broken package, not a reason to ignore declarations that are sitting there.
 */
export function discoverReactDtsEntries(packageRoot: string): string[] {
  let pkg: PackageJsonTypes
  try {
    pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const rel = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports)
  if (rel) {
    const abs = isAbsolute(rel) ? rel : resolve(packageRoot, rel)
    if (existsSync(abs)) return [abs]
  }
  const implicit = implicitDtsEntry(packageRoot, pkg.main)
  return implicit ? [implicit] : []
}
