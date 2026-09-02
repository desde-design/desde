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
  types?: string
  typings?: string
  exports?: Record<string, unknown> | string
}

/** Pull a `.d.ts` path out of an `exports` "." entry, which may nest. */
function typesFromExports(exportsField: PackageJsonTypes['exports']): string | null {
  if (!exportsField || typeof exportsField !== 'object') return null
  const dot = (exportsField as Record<string, unknown>)['.']
  const visit = (node: unknown): string | null => {
    if (typeof node === 'string') return node.endsWith('.d.ts') ? node : null
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
 * Resolve the entry `.d.ts` file(s) for a package's type declarations.
 * Reads `package.json` `types` / `typings` / `exports["."].types`. Returns
 * an empty array when the package ships no resolvable declaration entry.
 */
export function discoverReactDtsEntries(packageRoot: string): string[] {
  let pkg: PackageJsonTypes
  try {
    pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const rel = pkg.types ?? pkg.typings ?? typesFromExports(pkg.exports)
  if (!rel) return []
  const abs = isAbsolute(rel) ? rel : resolve(packageRoot, rel)
  return existsSync(abs) ? [abs] : []
}
