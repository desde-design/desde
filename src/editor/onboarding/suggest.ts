/**
 * "Use what my prototype already imports" (spec §8) — scan the prototype's
 * installed design-system libraries and rank them by how often the
 * prototype's own source imports them, so the onboarding UI can seed or
 * offer one-click adds without the user naming anything.
 *
 * Two arms, one ranking:
 *
 *  - **Vue** — `scanInstalledVueLibraries` walks `node_modules` for packages
 *    shipping `*.vue.d.ts`. That marker is precise (only a Vue component
 *    library has one), so a declared dependency that carries it is a
 *    suggestion even if nothing imports it yet.
 *  - **React** (added 2026-09-08; it was a "follow-up" in this header from
 *    6.3 to then) — `scanInstalledReactLibraries` is bounded to the
 *    prototype's declared dependencies that list `react` as a dependency or
 *    peer AND resolve a `.d.ts` entry. That is a weaker signal than
 *    `*.vue.d.ts`: a hooks library, a router and a data-fetching client all
 *    pass it. So the React arm asks two more questions the Vue arm can skip:
 *      1. does the prototype's own source import it at all
 *         (`importFrequency >= 1`), and
 *      2. does its entry export at least one thing that types as a React
 *         component (`listReactComponents`, the extractor's own predicate
 *         over ONE shared TS program), and
 *      3. is it not an icon set: an export list that is mostly `*Icon` /
 *         `Icon*`, or one in the hundreds, is icons. Icons are a different
 *         surface (`adapters/icon-sets`), and onboarding one as a design
 *         system would mean extracting thousands of identical components
 *         on the next boot. MEASURED on a shadcn dashboard: the icon
 *         package was the top suggestion by import count (140 files) and
 *         would have arrived with 6,211 "components".
 *    A package failing any of the three is not offered. The count is real,
 *    not approximate: it is what onboarding the package would extract.
 *
 * The two arms differ in how sure they are, and the result says so
 * (`confidence`). `*.vue.d.ts` is `certain`: only a component library ships
 * it, so the New Project step seeds those rows into the list unasked. The
 * React marker is `likely`: MEASURED on the same shadcn dashboard the arm
 * returns 13 packages the prototype genuinely renders from (charts, a date
 * picker, a toaster, a drawer, an OTP input, the primitives under its own
 * wrappers), and no heuristic can say which of those the user calls a
 * design system. So `likely` rows are OFFERED, one click each, not seeded;
 * seeding them would register every small UI package on the next boot.
 *
 * Neither arm sees a component library that is NOT a package — a design
 * system copied into the repo as source (the shadcn/ui distribution model)
 * is first-party code, and first-party components are catalogued by
 * `local-react` / `local-vue` on every boot with nothing to register. The
 * onboarding UI's copy says so, because an empty list here used to read as
 * "nothing was found" when the truth was "nothing here is a package".
 *
 * Pure read-only over the filesystem; no network. The React arm builds a TS
 * program (in memory) and nothing else.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FrameworkId } from '@/editor/core/manifest'

export interface DesignSystemSuggestion {
  package: string
  version: string
  framework: FrameworkId
  /**
   * Components the package exports: discovered `*.vue.d.ts` files (Vue), or
   * exported symbols that type as a React component (React).
   */
  componentCount: number
  /** Times the prototype's own source imports this package. */
  importFrequency: number
  /**
   * How sure the marker is that this is a design system. `certain` (Vue,
   * `*.vue.d.ts`) is seeded into the New Project list; `likely` (React) is
   * offered for the user to add. See the header for why they differ.
   */
  confidence: 'certain' | 'likely'
}

/** `XIcon` and `IconX`: the two naming conventions React icon sets use. */
const ICON_NAME_RE = /(^Icon[A-Z]|Icon$)/

/**
 * Is this export list an icon set rather than a design system? Either the
 * majority of a non-trivial list is icon-named, or the list is larger than
 * any design system (the largest React design systems export a few hundred
 * components; icon sets export thousands, and some name them without any
 * `Icon` affix at all).
 */
export function looksLikeIconSet(componentNames: readonly string[]): boolean {
  const n = componentNames.length
  if (n >= 400) return true
  if (n < 20) return false
  const iconNamed = componentNames.filter((name) => ICON_NAME_RE.test(name)).length
  return iconNamed / n >= 0.5
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
    { scanInstalledReactLibraries },
    { listReactComponents },
    { resolveTsconfig },
  ] = await Promise.all([
    import('@/editor/adapters/vue-dts-meta/auto-scan'),
    import('@/editor/adapters/vue-dts-meta/presets'),
    import('@/editor/adapters/cached'),
    import('@/editor/adapters/react-dts-meta/auto-scan'),
    import('@/editor/adapters/react-dts-meta/count-components'),
    import('@/editor/core/resolve-tsconfig'),
  ])

  const [vueScanned, reactScanned, declaredDeps, importCounts, tsconfigPath] = await Promise.all([
    scanInstalledVueLibraries(prototypeRoot),
    scanInstalledReactLibraries(prototypeRoot),
    readDeclaredDependencies(prototypeRoot),
    countPackageImports(prototypeRoot),
    resolveTsconfig(prototypeRoot),
  ])

  const suggestions: DesignSystemSuggestion[] = []
  const suggested = new Set<string>()

  for (const { packageName, packageRoot, dtsRoot } of vueScanned) {
    // Intersect with declared deps — a transitively-installed package the
    // prototype never declares isn't a design system the user "uses". (No
    // package.json → no declared deps → no suggestions; add via npm/installed.)
    if (!declaredDeps.has(packageName)) continue
    const components = discoverVueDtsComponents(packageRoot, {
      dtsRoots: [path.relative(packageRoot, dtsRoot) || '.'],
    })
    if (components.length === 0) continue
    suggested.add(packageName)
    suggestions.push({
      package: packageName,
      version: resolvePackageVersion(packageRoot) ?? 'unknown',
      framework: 'vue3',
      componentCount: components.length,
      importFrequency: importCounts.get(packageName) ?? 0,
      confidence: 'certain',
    })
  }

  // React arm. `scanInstalledReactLibraries` is already bounded to declared
  // dependencies; the import gate is the extra question its weaker marker
  // needs (see the header). A package the Vue arm already claimed is Vue.
  const reactCandidates = reactScanned.filter(
    ({ packageName }) => !suggested.has(packageName) && (importCounts.get(packageName) ?? 0) > 0,
  )
  if (reactCandidates.length > 0) {
    const names = listReactComponents(
      tsconfigPath,
      new Map(reactCandidates.map(({ packageName, entryFiles }) => [packageName, entryFiles])),
    )
    for (const { packageName, packageRoot } of reactCandidates) {
      const components = names.get(packageName) ?? []
      if (components.length === 0 || looksLikeIconSet(components)) continue
      suggestions.push({
        package: packageName,
        version: resolvePackageVersion(packageRoot) ?? 'unknown',
        framework: 'react',
        componentCount: components.length,
        importFrequency: importCounts.get(packageName) ?? 0,
        confidence: 'likely',
      })
    }
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
