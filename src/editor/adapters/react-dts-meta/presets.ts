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
  /** Any of the four legal spellings — see {@link rootExport}. */
  exports?: unknown
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
 * Every string target in an `exports` condition tree that `accept` likes:
 * `keys` in order at each object node, array entries left to right.
 *
 * ## This is deliberately PERMISSIVE, and it is not what a runtime does
 *
 * A real resolver picks ONE target. It knows which conditions are active
 * (`import` vs `require`, `types` under a given `moduleResolution`), it stops
 * at the first one that matches, and a `null` target BLOCKS the resolution
 * rather than falling through. An array is "first valid target" — validity is
 * about the target's syntax, not whether the file is on disk, so a runtime
 * never falls through to a later entry because an earlier one is missing.
 *
 * This function does none of that, because it cannot: it is handed a package
 * directory and nothing about the prototype that will import it. So it answers
 * the weaker question it CAN answer — "could the package root resolve to a
 * declaration file under some condition set" — and leaves the caller to decide.
 *
 * Two consequences, both accepted (see {@link discoverReactDtsEntries}):
 *
 *  - `{"import": null, "default": "./i.js"}` blocks ESM outright, and this
 *    still finds `./i.d.ts` through `default`. A CJS-only package can be
 *    offered to an ESM prototype.
 *  - `["./missing.js", "./dist/i.js"]` resolves to the FIRST entry at runtime
 *    and then fails to load it. This finds `dist/i.d.ts`. Only reachable for a
 *    package that is already broken.
 *
 * Both were raised by codex review on 2026-09-15 and both are real. Fixing
 * either properly means taking the active conditions as a parameter, which is
 * a change to every caller. The bias is deliberate: this whole seam exists
 * because packages were being dropped SILENTLY, and a wrong offer is a row the
 * user can see and remove. Revisit when a caller can say which conditions
 * apply.
 */
function allTargets(
  node: unknown,
  keys: readonly string[],
  accept: (target: string) => boolean,
): string[] {
  const found: string[] = []
  const visit = (n: unknown): void => {
    if (typeof n === 'string') {
      if (accept(n)) found.push(n)
      return
    }
    if (Array.isArray(n)) {
      for (const item of n) visit(item)
      return
    }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      for (const key of keys) if (key in o) visit(o[key])
    }
  }
  visit(node)
  return found
}

/**
 * What an `exports` field says about the PACKAGE ROOT. Only one of its four
 * legal spellings uses a literal `"."` key, so reading `exports['.']` alone
 * mistakes two valid root forms for "no root export":
 *
 * ```jsonc
 *   "exports": "./index.js"                        // string sugar for "."
 *   "exports": ["./a.js", "./b.js"]                // array sugar for "."
 *   "exports": { "import": "…", "require": "…" }   // CONDITION-ONLY sugar for "."
 *   "exports": { ".": "…", "./sub": "…" }          // a real subpath map
 * ```
 *
 * Node's rule for the object forms: if no key begins with `.`, every key is a
 * CONDITION and the object as a whole is the root export. One `.`-prefixed key
 * makes it a subpath map, and then a missing `"."` really does mean the bare
 * specifier does not resolve.
 */
type RootExport =
  | { kind: 'absent' }
  | { kind: 'root'; node: unknown }
  | { kind: 'subpathOnly' }

function rootExport(exportsField: unknown): RootExport {
  if (exportsField === undefined || exportsField === null) return { kind: 'absent' }
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return { kind: 'root', node: exportsField }
  }
  if (typeof exportsField !== 'object') return { kind: 'absent' }

  const map = exportsField as Record<string, unknown>
  const keys = Object.keys(map)
  // `"exports": {}` exports nothing at all, root included.
  if (keys.length === 0) return { kind: 'subpathOnly' }
  if (!keys.some((k) => k.startsWith('.'))) return { kind: 'root', node: map }
  return '.' in map ? { kind: 'root', node: map['.'] } : { kind: 'subpathOnly' }
}

/** Pull a declaration path out of a package's root export, which may nest. */
function typesFromExports(exportsField: unknown): string | null {
  const root = rootExport(exportsField)
  if (root.kind !== 'root') return null
  const keys = ['types', 'import', 'require', 'default']
  return allTargets(root.node, keys, (t) => DTS_RE.test(t))[0] ?? null
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
 *  - An `exports` map is a GATE. A SUBPATH map with no root export means the
 *    bare specifier does not resolve, so there is no root entry to offer
 *    however many `.d.ts` files are lying around. Only one of the four legal
 *    spellings uses a literal `"."` key, so {@link rootExport} normalises them
 *    before the gate is applied. MEASURED 2026-09-15 on
 *    `@cloudscape-design/components` (191 exports behind
 *    `exports["."]: "./index.js"`): the declaration comes from substituting
 *    the extension on the target `exports` selected, which is the same file
 *    TypeScript would load and is not necessarily `main`'s.
 *  - It is CONDITION-AGNOSTIC, and so more permissive than any runtime. It
 *    reports a declaration the root export could resolve to under SOME set of
 *    conditions, not the one a particular prototype would get. See
 *    {@link allTargets} for the two known consequences and why they are
 *    accepted rather than fixed.
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

  // 2. An `exports` field is a GATE, not just a source. A subpath map with no
  //    root export means the bare specifier does not resolve at all, so there
  //    is no package-root entry to offer and guessing one would register an
  //    import the prototype cannot write.
  const root = rootExport(pkg.exports)
  if (root.kind === 'subpathOnly') return []

  // 3. A root export naming a JavaScript target: TypeScript substitutes the
  //    declaration extension on THAT target, not on `main`.
  if (root.kind === 'root') {
    const jsTargets = allTargets(root.node, ['import', 'require', 'default'], (t) =>
      JS_TARGET_RE.test(t),
    )
    for (const target of jsTargets) {
      for (const rel of declarationSiblings(target)) {
        const abs = resolve(packageRoot, rel)
        if (existsSync(abs)) return [abs]
      }
    }
  }

  // 4. The legacy layout. Still reached when a package HAS an `exports` map
  //    whose root target has no declarations, because `moduleResolution: node`
  //    ignores `exports` entirely and plenty of prototypes still use it.
  const implicit = implicitDtsEntry(packageRoot, pkg.main)
  return implicit ? [implicit] : []
}
