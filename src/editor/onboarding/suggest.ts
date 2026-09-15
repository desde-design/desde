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
 *         `Icon*`, or one spread over too many distinct component
 *         FAMILIES, is icons. Icons are a different surface
 *         (`adapters/icon-sets`), and onboarding one as a design system
 *         would mean extracting thousands of identical components on the
 *         next boot. MEASURED on a shadcn dashboard: the icon package was
 *         the top suggestion by import count (140 files) and would have
 *         arrived with 6,211 "components". This test used to be "the list
 *         is in the hundreds" instead; see {@link looksLikeIconSet} for
 *         why a raw count was the wrong question and what replaced it.
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
 * A component name's FAMILY: its first CamelCase word. `DialogRoot`,
 * `DialogTrigger` and `DialogBackdrop` are all one family, `Dialog`.
 * Leading acronyms stop at the next capitalized word, so `HStack` is `H`.
 */
const FAMILY_RE = /^[A-Z]+(?![a-z])|^[A-Z][a-z0-9]*/

/**
 * How many distinct families make a list icons rather than a design system.
 * 250 is 2.2x the largest design system measured — see the table below.
 */
const ICON_SET_MIN_FAMILIES = 250

/**
 * Is this export list an icon set rather than a design system?
 *
 * Two signals. Either one on its own is enough:
 *
 *  1. **Most of the names are icon-named** — half or more match `XIcon` or
 *     `IconX`.
 *  2. **The names are spread over too many FAMILIES.** A design system has
 *     few families and many parts in each one. An icon set has roughly one
 *     family per glyph.
 *
 * A list under 20 is never judged. A design system may ship a few icons of
 * its own, and the ratio is meaningless on a handful of names.
 *
 * ## Signal 2 replaced a raw export count on 2026-09-15
 *
 * The old rule called any list of 400 or more an icon set. It assumed the
 * largest React design systems export a few hundred components. Chakra v3
 * exports 775, because its compound API (`Dialog.Root`, `Dialog.Trigger`,
 * `Menu.Item`) genuinely ships hundreds of parts. So a top-five library was
 * classified as icons and silently dropped from onboarding.
 *
 * Moving the number would not have fixed it. The two groups OVERLAP on raw
 * count: `@ant-design/icons` exports 832 and Chakra exports 775, so no cutoff
 * separates them. They do not overlap on families: 319 against 114. A
 * compound API multiplies the parts per family, never the family count, which
 * is exactly why counting parts broke and counting families does not.
 *
 * ## MEASURED 2026-09-15
 *
 * 27 packages installed at their current versions and run through the real
 * {@link listReactComponents}. `n` is exported symbols that type as a React
 * component; `icon%` is the share matching `XIcon`/`IconX`.
 *
 * ```
 *   design systems                        n    icon%   families
 *     @chakra-ui/react 3.37.0           775     0.8%        114
 *     @mantine/core 7.17.8              228     2.2%        106
 *     @carbon/react 1.116.0             254     2.8%         89
 *     @shopify/polaris 13.9.5           110     0.9%         89
 *     @fluentui/react-components 9.74   256       0%         85
 *     @salt-ds/core 1.70.0              169     2.4%         84
 *     @mui/material 6.5.0               146     4.1%         75
 *     rsuite 5.83.4                      99     1.0%         74
 *     react-aria-components 1.21.1      150       0%         69
 *     @adobe/react-spectrum 3.47.5      100     1.0%         67
 *     antd 5.29.3                        68       0%         66
 *     @blueprintjs/core 5.19.1           94     1.1%         61
 *     @heroui/react 2.8.10              117     0.9%         56
 *     @primer/react 37.31.0              68     1.5%         54
 *     semantic-ui-react 2.1.5           163     2.5%         51
 *     react-bootstrap 2.10.10           110       0%         43
 *     @radix-ui/themes 3.3.0             44    13.6%         40
 *
 *   icon sets                             n    icon%   families
 *     @mui/icons-material 6.5.0       10615       0%       1043
 *     lucide-react 0.460.0             5211    33.4%        730
 *     @phosphor-icons/react 2.1.10     3042    50.3%        688
 *     @ant-design/icons 5.6.1           832     0.1%        319
 *     @radix-ui/react-icons 1.3.2       318     100%        198
 *     react-feather 2.0.10              286       0%        195
 *     @tabler/icons-react 3.46.0       6250    99.9%          7
 * ```
 *
 * Read the `icon%` column before trusting signal 1 alone. Three of the seven
 * icon sets are under 50% and two are effectively zero — the largest of them,
 * `@mui/icons-material`, names nothing `Icon` at all. Only families catch
 * those. `@tabler/icons-react` is the mirror image: every name starts `Icon`,
 * so it collapses to 7 families and only signal 1 catches it. The two signals
 * cover each other's blind spot, which is why both are kept.
 *
 * The threshold sits at 250 for this reason. The largest design system
 * measured is 114 families. The four icon sets signal 1 misses sit at 195,
 * 319, 730 and 1043. So 250 is 2.2x clear of every design system and catches
 * three of those four.
 *
 * It is not the midpoint, and that is deliberate. The two mistakes do not
 * cost the same. Calling a design system "icons" removes it from onboarding
 * with no trace. Calling an icon set "a design system" seeds a row the user
 * has to notice and remove — the New Project step adds every detection and
 * ignores `confidence` (`new-project-page.tsx`, Mo 2026-09-08: "found means
 * added; remove what is not a design system"). Visible and reversible beats
 * silent, so the expensive mistake gets the headroom. That is why the 195 is
 * allowed to escape rather than pulling the threshold down to 150 and leaving
 * Chakra 1.3x of room.
 *
 * The escape is not free, and the cost is worth knowing before anyone widens
 * it. A wrongly-onboarded icon set lands in the agent's grounding digest,
 * which is sorted by name and capped at 250
 * (`DIGEST_COMPONENT_CAP`, `agent-chat-sdk/grounding-tools.ts`).
 * `react-feather`'s 286 names are front-loaded alphabetically (`Activity`,
 * `Airplay`, `AlertCircle`…), so it can fill that cap alone and push the real
 * design system's components into the "+N more" overflow. The agent can still
 * reach them through `list_components` / `search_components`, so this degrades
 * the prompt rather than breaking it.
 *
 * ## Two known misses, both unchanged by this rewrite
 *
 * `react-feather` (195 families, 0% icon-named) is judged a design system. Its
 * 286 exports were under the old 400-count rule too, so it was judged the same
 * way before this change and nothing regressed. See the paragraph above for
 * why the threshold is not lowered to catch it.
 *
 * `evergreen-ui` is judged an icon set, because it ships its icons in the same
 * entry as its components: 623 exports, 86.8% of them icon-named. Signal 1
 * claims it, as it did under the old rule. Fixing that one means classifying
 * the list with the icon-named names REMOVED, which is a different change.
 */
export function looksLikeIconSet(componentNames: readonly string[]): boolean {
  const n = componentNames.length
  if (n < 20) return false
  const iconNamed = componentNames.filter((name) => ICON_NAME_RE.test(name)).length
  if (iconNamed / n >= 0.5) return true
  const families = new Set<string>()
  for (const name of componentNames) families.add(FAMILY_RE.exec(name)?.[0] ?? name)
  return families.size >= ICON_SET_MIN_FAMILIES
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
