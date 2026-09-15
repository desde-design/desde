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

/** A runtime target: what the `"."` export actually points a bundler at. */
const JS_TARGET_RE = /\.[cm]?js$/

/**
 * Walk an `exports` condition tree and return the first string target that
 * `accept` likes, trying `keys` in order at each object node. Conditions may
 * be a bare string, an array of fallbacks, or a nested object.
 */
function firstTarget(
  node: unknown,
  keys: readonly string[],
  accept: (target: string) => boolean,
): string | null {
  if (typeof node === 'string') return accept(node) ? node : null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstTarget(item, keys, accept)
      if (found) return found
    }
    return null
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    for (const key of keys) {
      const found = firstTarget(o[key], keys, accept)
      if (found) return found
    }
  }
  return null
}

/** The `"."` node of an `exports` map, or `undefined` when there is no map. */
function rootExport(exportsField: PackageJsonTypes['exports']): unknown {
  if (!exportsField || typeof exportsField !== 'object') return undefined
  return (exportsField as Record<string, unknown>)['.']
}

/** Pull a declaration path out of an `exports` "." entry, which may nest. */
function typesFromExports(exportsField: PackageJsonTypes['exports']): string | null {
  return firstTarget(rootExport(exportsField), ['types', 'import', 'require', 'default'], (t) =>
    DTS_RE.test(t),
  )
}

/**
 * The declaration files TypeScript pairs with a JavaScript target. It maps
 * `.mjs` to `.d.mts` and `.cjs` to `.d.cts`, but plenty of packages emit one
 * `.d.ts` beside either, so both spellings are candidates.
 */
function declarationSiblings(jsTarget: string): string[] {
  if (!JS_TARGET_RE.test(jsTarget)) return []
  return [jsTarget.replace(/\.([cm]?)js$/, '.d.$1ts'), jsTarget.replace(JS_TARGET_RE, '.d.ts')]
}

/**
 * Where TypeScript itself looks when a package DECLARES no types: the
 * declaration sibling of `main`, then a bare `index.d.ts` at the package root.
 *
 * Plenty of published React libraries rely on this and name no `types` field
 * at all. MEASURED 2026-09-15: `grommet` ships a root `index.d.ts` with 345
 * exports and names neither `types` nor `exports`, so this is the only thing
 * that finds it. It extracts cleanly once the entry is resolved, and was
 * invisible to every caller of this function.
 *
 * `src/editor/ingest/git-repo.ts` already carried a local copy of this
 * fallback to answer "does this repo ship types", which made the ingest lane
 * answer yes and then extract nothing.
 */
function implicitDtsEntry(packageRoot: string, main: string | undefined): string | null {
  const candidates: string[] = []
  if (typeof main === 'string' && main.length > 0) {
    if (JS_TARGET_RE.test(main)) {
      candidates.push(...declarationSiblings(main))
    } else {
      // An extensionless `main` may name either a FILE or a DIRECTORY, and
      // TypeScript tries the file first: `main: "dist/index"` resolves through
      // `dist/index.d.ts` before `dist/index/index.d.ts`. Same order here, or a
      // package with both would get the wrong barrel.
      candidates.push(`${main}.d.ts`, `${main}/index.d.ts`)
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
 * Resolve the entry declaration file(s) for a package's types, in the order
 * TypeScript itself would. Returns an empty array when the package ships no
 * resolvable PACKAGE-ROOT declaration entry.
 *
 * The four steps are numbered in the body. What is worth knowing up front:
 *
 *  - A package that DECLARES an entry which is not on disk falls through
 *    rather than reporting nothing. A stale `types` field is a broken package,
 *    not a reason to ignore declarations that are sitting there.
 *  - An `exports` map is a GATE. A map with no `"."` means the bare specifier
 *    does not resolve, so there is no root entry to offer however many `.d.ts`
 *    files are lying around. MEASURED 2026-09-15 on `@cloudscape-design/components`
 *    (191 exports behind `exports["."]: "./index.js"`): the declaration comes
 *    from substituting the extension on the target `exports` selected, which
 *    is the same file TypeScript would load and is not necessarily `main`'s.
 */
export function discoverReactDtsEntries(packageRoot: string): string[] {
  let pkg: PackageJsonTypes
  try {
    pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return []
  }

  // 1. A declared entry always wins.
  const declared = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports)
  if (declared) {
    const abs = isAbsolute(declared) ? declared : resolve(packageRoot, declared)
    if (existsSync(abs)) return [abs]
  }

  // 2. An `exports` map is a GATE, not just a source. A map with no `"."` is a
  //    subpath-only package: the bare specifier does not resolve at all, so
  //    there is no package-root entry to offer and guessing one would register
  //    an import the prototype cannot write.
  const hasExportsMap = !!pkg.exports && typeof pkg.exports === 'object'
  const dot = rootExport(pkg.exports)
  if (hasExportsMap && dot === undefined) return []

  // 3. `exports["."]` naming a JavaScript target: TypeScript substitutes the
  //    declaration extension on THAT target, not on `main`.
  const jsTarget = firstTarget(dot, ['import', 'require', 'default'], (t) => JS_TARGET_RE.test(t))
  if (jsTarget) {
    for (const rel of declarationSiblings(jsTarget)) {
      const abs = resolve(packageRoot, rel)
      if (existsSync(abs)) return [abs]
    }
  }

  // 4. The legacy layout. Still reached when a package HAS an `exports` map
  //    whose root target has no declarations, because `moduleResolution: node`
  //    ignores `exports` entirely and plenty of prototypes still use it.
  const implicit = implicitDtsEntry(packageRoot, pkg.main)
  return implicit ? [implicit] : []
}
