/**
 * "Use what my prototype already imports" (spec §8) — scan the prototype's
 * installed Vue design-system libraries and rank them by how often the
 * prototype's own source imports them, so the onboarding UI's "Detected" tab
 * can offer one-click adds without the user naming anything.
 *
 * v1 SCOPE: Vue libraries (where the deterministic `*.vue.d.ts` auto-scan
 * investment is, and the dogfood substrate). React libraries are detected by
 * `detectFramework` and onboarded via the npm/installed path (6.3); a React
 * "Detected" arm is a follow-up (it needs a cheap component-count heuristic the
 * Vue side gets for free from `*.vue.d.ts`).
 *
 * Pure read-only over the filesystem; no network, no TS checker.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FrameworkId } from '@/editor/core/manifest'

export interface DesignSystemSuggestion {
  package: string
  version: string
  framework: FrameworkId
  /** Discovered `*.vue.d.ts` component count. */
  componentCount: number
  /** Times the prototype's own source imports this package. */
  importFrequency: number
}

const SOURCE_FILE_RE = /\.(vue|ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage'])
const IMPORT_SPECIFIER_RE = /(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g

/**
 * Resolve an import specifier to its bare npm PACKAGE name, or null for a
 * relative/absolute path. `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`.
 */
export function extractPackageName(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] || null
}

export async function suggestDesignSystems(
  prototypeRoot: string,
): Promise<DesignSystemSuggestion[]> {
  const [
    { scanInstalledVueLibraries },
    { discoverVueDtsComponents },
    { resolvePackageVersion },
  ] = await Promise.all([
    import('@/editor/adapters/vue-dts-meta/auto-scan'),
    import('@/editor/adapters/vue-dts-meta/presets'),
    import('@/editor/adapters/cached'),
  ])

  const [scanned, declaredDeps, importCounts] = await Promise.all([
    scanInstalledVueLibraries(prototypeRoot),
    readDeclaredDependencies(prototypeRoot),
    countPackageImports(prototypeRoot),
  ])

  const suggestions: DesignSystemSuggestion[] = []
  for (const { packageName, packageRoot, dtsRoot } of scanned) {
    // Intersect with declared deps — a transitively-installed package the
    // prototype never declares isn't a design system the user "uses". (No
    // package.json → no declared deps → no suggestions; add via npm/installed.)
    if (!declaredDeps.has(packageName)) continue
    const components = discoverVueDtsComponents(packageRoot, {
      dtsRoots: [path.relative(packageRoot, dtsRoot) || '.'],
    })
    if (components.length === 0) continue
    suggestions.push({
      package: packageName,
      version: resolvePackageVersion(packageRoot) ?? 'unknown',
      framework: 'vue3',
      componentCount: components.length,
      importFrequency: importCounts.get(packageName) ?? 0,
    })
  }

  // Most-imported first; break ties by richer component coverage.
  suggestions.sort(
    (a, b) => b.importFrequency - a.importFrequency || b.componentCount - a.componentCount,
  )
  return suggestions
}

/** Names from the prototype's package.json deps + devDeps + peerDeps. */
async function readDeclaredDependencies(prototypeRoot: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(path.join(prototypeRoot, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as Record<string, Record<string, string> | undefined>
    const names = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[field]
      if (deps) for (const name of Object.keys(deps)) names.add(name)
    }
    return names
  } catch {
    return new Set()
  }
}

/** Count, per imported package, how many prototype source files import it. */
async function countPackageImports(prototypeRoot: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else if (e.isFile() && SOURCE_FILE_RE.test(e.name)) {
        await tallyFile(full, counts)
      }
    }
  }
  await walk(prototypeRoot, 0)
  return counts
}

async function tallyFile(file: string, counts: Map<string, number>): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return
  }
  // Count each package AT MOST ONCE per file (frequency = files-that-import).
  const seen = new Set<string>()
  for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const pkg = extractPackageName(m[1])
    if (pkg) seen.add(pkg)
  }
  for (const pkg of seen) counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
}
