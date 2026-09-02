/**
 * Pure enumeration of an npm package's named-export icons by parsing
 * its TypeScript declaration files. Adapter consumers feed this an
 * entry `.d.ts` file (resolved from the package's `types` /
 * `typings` field) and get back a flat list of discovered icons with
 * their categorization path.
 *
 * Strategy:
 *  - Read the entry `.d.ts`
 *  - Recurse on `export * from './<rel>';` declarations, tracking the
 *    relative path components as a category trail
 *  - On `export { default as XxxIcon } from './XxxIcon.vue';` (or
 *    `.ts`, `.js`), emit a {@link DiscoveredExport} if the name
 *    matches the configured icon pattern
 *
 * This is intentionally TS-AST-free: a few regex passes handle the
 * generated-types shape that icon libraries emit. If we hit a package
 * with more exotic declaration syntax, swap in a TS compiler API pass
 * in this file only — no consumer of the function needs to change.
 */

import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface EnumerateOptions {
  /** Absolute path to the package's entry `.d.ts` (resolved from `package.json#types`). */
  rootTypesFile: string
  /**
   * Names matching this pattern are emitted as icons. Defaults to
   * `/Icon$/` (PascalCase exports ending in `Icon`). Override for
   * packages whose icon exports follow a different convention.
   */
  iconPattern?: RegExp
  /** Cycle/recursion guard. Default 6 — enough for `pkg → components → category → icon`. */
  maxDepth?: number
}

export interface DiscoveredExport {
  /** Exported binding name — e.g. `'DataObjectIcon'`. */
  exportName: string
  /**
   * The trail of directory names traversed via `export * from`, from
   * outermost to innermost. Empty when the entry file declared the
   * icon directly. E.g. `['components', 'solid']` for the package icons.
   */
  categoryPath: string[]
  /** Absolute path to the file the binding ultimately resolved from. */
  sourceFile: string
}

const STAR_RE = /export\s*\*\s*from\s*['"]([^'"]+)['"]\s*;?/g
const DEFAULT_AS_RE = /export\s*\{\s*default\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*from\s*['"]([^'"]+)['"]\s*;?/g

/**
 * Resolve a relative module specifier against the directory of the
 * file that contained it, picking a real file on disk. Tries the
 * specifier verbatim, then common extensions, then `<spec>/index.d.ts`.
 * Returns `null` when nothing exists — the caller treats that as an
 * unresolvable redirect and skips it.
 */
async function resolveSpec(fromFile: string, spec: string): Promise<string | null> {
  const baseDir = dirname(fromFile)
  const abs = isAbsolute(spec) ? spec : resolve(baseDir, spec)

  const candidates = [
    abs,
    `${abs}.d.ts`,
    `${abs}.ts`,
    `${abs}.js`,
    join(abs, 'index.d.ts'),
    join(abs, 'index.ts'),
    join(abs, 'index.js'),
  ]

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // continue
    }
  }
  return null
}

/**
 * Read a `.d.ts` file (or any TS/JS file) and extract its
 * `export * from` and `export { default as … } from` declarations.
 * Lines that don't match either pattern are ignored — we intentionally
 * do NOT parse the full AST.
 */
async function readExports(file: string): Promise<{
  stars: string[]
  defaults: Array<{ name: string; from: string }>
}> {
  const source = await fs.readFile(file, 'utf8')
  const stars: string[] = []
  const defaults: Array<{ name: string; from: string }> = []

  STAR_RE.lastIndex = 0
  for (const match of source.matchAll(STAR_RE)) {
    stars.push(match[1])
  }

  DEFAULT_AS_RE.lastIndex = 0
  for (const match of source.matchAll(DEFAULT_AS_RE)) {
    defaults.push({ name: match[1], from: match[2] })
  }

  return { stars, defaults }
}

export async function enumerateNamedExports(
  opts: EnumerateOptions,
): Promise<DiscoveredExport[]> {
  const iconPattern = opts.iconPattern ?? /Icon$/
  const maxDepth = opts.maxDepth ?? 6
  const results: DiscoveredExport[] = []
  const visited = new Set<string>()

  async function walk(file: string, categoryPath: string[], depth: number): Promise<void> {
    if (depth > maxDepth) return
    if (visited.has(file)) return
    visited.add(file)

    const { stars, defaults } = await readExports(file)

    for (const def of defaults) {
      if (!iconPattern.test(def.name)) continue
      const sourceFile = (await resolveSpec(file, def.from)) ?? resolve(dirname(file), def.from)
      results.push({
        exportName: def.name,
        categoryPath: [...categoryPath],
        sourceFile,
      })
    }

    for (const star of stars) {
      const resolved = await resolveSpec(file, star)
      if (!resolved) continue
      const segment = lastPathSegment(star)
      const nextCategory = segment ? [...categoryPath, segment] : categoryPath
      await walk(resolved, nextCategory, depth + 1)
    }
  }

  await walk(opts.rootTypesFile, [], 0)
  return results
}

function lastPathSegment(spec: string): string | null {
  const cleaned = spec.replace(/^\.\.?\//, '').replace(/\/index$/, '').replace(/\.d\.ts$|\.ts$|\.js$/, '')
  const parts = cleaned.split('/').filter(Boolean)
  if (parts.length === 0) return null
  return parts[parts.length - 1]
}
