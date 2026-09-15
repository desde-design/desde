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
 *         `Icon*`, or one spread over too many distinct component FAMILIES,
 *         is icons. MEASURED on a shadcn dashboard: the icon package was
 *         the top suggestion by import count (140 files) and would have
 *         arrived with 6,211 "components". This test used to be "the list
 *         is in the hundreds" instead; see {@link looksLikeIconSet} for
 *         why a raw count was the wrong question and what replaced it.
 *
 *         Failing this question does NOT hand the package to the icon
 *         picker. That surface has its own detection pass, at CLI boot,
 *         over dependencies whose NAME contains "icon"
 *         (`icon-sets/auto-detect.ts`) — `lucide-react` and `react-feather`
 *         are not candidates there either. Excluded here means offered
 *         nowhere, which is why the rule leans toward keeping.
 *    A package failing any of the three is not offered. The count is real,
 *    not approximate: it is what onboarding the package would extract.
 *
 * The two arms differ in how sure they are, and the result says so
 * (`confidence`). `*.vue.d.ts` is `certain`: only a component library ships
 * it. The React marker is `likely`: MEASURED on the same shadcn dashboard the
 * arm returns 13 packages the prototype genuinely renders from (charts, a
 * date picker, a toaster, a drawer, an OTP input, the primitives under its
 * own wrappers), and no heuristic can say which of those the user calls a
 * design system.
 *
 * **Nothing downstream acts on that difference today.** This header used to
 * say `likely` rows were "OFFERED, one click each, not seeded". That stopped
 * being true on 2026-09-08: the New Project step seeds EVERY detection into
 * the list and ignores `confidence` outright (`new-project-page.tsx` — Mo:
 * "found means added; remove what is not a design system"). So a `likely`
 * row is opt-OUT, and the field is carried for a consumer that does not exist
 * yet. That is what makes a wrong verdict in {@link looksLikeIconSet} cost
 * more than a row the user can ignore; see its doc comment.
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
   * How sure the marker is that this is a design system. `certain` is Vue's
   * `*.vue.d.ts`; `likely` is the React arm's weaker one. See the header for
   * why they differ, and for the fact that no consumer reads this yet: the
   * New Project step seeds both kinds alike.
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
 * A list spread over this many families is icons whatever its shape. No
 * design system measured comes close — the largest is 127.
 */
const ICON_SET_MIN_FAMILIES = 250

/**
 * The flat-catalog pair, applied together: this many families AND fewer than
 * this many names in each. Catches an icon set too small for
 * {@link ICON_SET_MIN_FAMILIES}, without catching a large compound design
 * system, which is dense by construction. See signal 3 below.
 */
const FLAT_MIN_FAMILIES = 150
const FLAT_MAX_PARTS_PER_FAMILY = 2

/**
 * Is this export list an icon set rather than a design system?
 *
 * Three signals. Any one of them on its own is enough:
 *
 *  1. **Most of the names are icon-named** — half or more match `XIcon` or
 *     `IconX`.
 *  2. **The names are spread over 250 or more families.** A family is a
 *     name's first CamelCase word, so `DialogRoot`, `DialogTrigger` and
 *     `DialogBackdrop` are one family, `Dialog`.
 *  3. **The names are spread over 150 or more families AND average fewer
 *     than 2 per family.** A flat catalog of mostly one-off names.
 *
 * A list under 20 names is never judged. A design system may ship a few icons
 * of its own, and a ratio over a handful of names means nothing.
 *
 * ## Why families and not a count of exports
 *
 * Until 2026-09-15 the rule was "400 or more exports is an icon set". It
 * assumed the largest React design systems export a few hundred components.
 * Chakra v3 exports 775, because its compound API (`Dialog.Root`,
 * `Dialog.Trigger`, `Menu.Item`) genuinely ships hundreds of parts. So a
 * top-five library was classified as icons and silently dropped.
 *
 * Moving the number would not have fixed it. The two groups OVERLAP on raw
 * count: `@ant-design/icons` exports 832 and Chakra exports 775, so no cutoff
 * separates them. They do not overlap on families: 319 against 114. A
 * compound API multiplies the parts per family, never the family count, which
 * is exactly why counting parts broke and counting families does not.
 *
 * ## Why signal 3 exists as a PAIR
 *
 * Signal 2 alone left `react-feather` (286 names, no name containing `Icon`,
 * 195 families) judged a design system. That is not free. A wrongly-onboarded
 * icon set lands in the agent's grounding digest, which is sorted by name and
 * capped at 250 (`DIGEST_COMPONENT_CAP`, `agent-chat-sdk/grounding-tools.ts`).
 * `react-feather`'s names are front-loaded alphabetically (`Activity`,
 * `Airplay`, `AlertCircle`…), so it fills that cap on its own and pushes the
 * real design system's components into the "+N more" overflow.
 *
 * Dropping signal 2's threshold to 150 would have caught it, and would have
 * left Chakra only 1.2x of room below the line. That is how the ORIGINAL bug
 * happened: a threshold tuned just above the biggest thing anyone had looked
 * at. So the low threshold is paired with a density test instead.
 *
 * The pair is what makes it safe. To be caught wrongly, a design system has
 * to be flat AND have more families than any measured today. Those two pull
 * against each other. A design system grows families by adding components,
 * and a large one adds PARTS as it grows (`Root`, `Trigger`, `Item`), which
 * is exactly what raises parts-per-family above 2. The flat ones stay small:
 * the flattest measured, `antd` and `@arco-design/web-react`, sit at 66 and
 * 68 families, and the largest flat one, `@shopify/polaris`, at 89.
 *
 * ## MEASURED 2026-09-15
 *
 * 42 packages installed at their current versions and run through the real
 * {@link listReactComponents}. `n` is exported symbols that type as a React
 * component. `icon%` is the share matching `XIcon`/`IconX`. `p/f` is names
 * divided by families. The 34 below are the ones this function actually sees
 * and that could be labelled; the other 8 are accounted for under the table.
 *
 * ```
 *   design systems                        n   icon%   families   p/f
 *     react-admin 5.15.3                303    0.3%       127   2.39
 *     @chakra-ui/react 3.37.0           775    0.8%       114   6.80
 *     @mantine/core 7.17.8              228    2.2%       106   2.15
 *     @fluentui/react 8.125.7           232    2.2%        91   2.55
 *     @carbon/react 1.116.0             254    2.8%        89   2.85
 *     @douyinfe/semi-ui 2.103.0         113    1.8%        89   1.27
 *     @patternfly/react-core 6.6.1      306    0.7%        89   3.44
 *     @shopify/polaris 13.9.5           110    0.9%        89   1.24
 *     @fluentui/react-components 9.74   256      0%        85   3.01
 *     @salt-ds/core 1.70.0              169    2.4%        84   2.01
 *     @mui/material 6.5.0               146    4.1%        75   1.95
 *     rsuite 5.83.4                      99    1.0%        74   1.34
 *     react-aria-components 1.21.1      150      0%        69   2.17
 *     @arco-design/web-react 2.66.16     71    1.4%        68   1.04
 *     @adobe/react-spectrum 3.47.5      100    1.0%        67   1.49
 *     antd 5.29.3                        68      0%        66   1.03
 *     @blueprintjs/core 5.19.1           94    1.1%        61   1.54
 *     @heroui/react 2.8.10              117    0.9%        56   2.09
 *     @primer/react 37.31.0              68    1.5%        54   1.26
 *     semantic-ui-react 2.1.5           163    2.5%        51   3.20
 *     react-bootstrap 2.10.10           110      0%        43   2.56
 *     @radix-ui/themes 3.3.0             44   13.6%        40   1.10
 *     @tremor/react 3.18.7               67    1.5%        40   1.68
 *     reactstrap 9.2.3                   96      0%        34   2.82
 *
 *   icon sets                             n   icon%   families   p/f
 *     @mui/icons-material 6.5.0       10615      0%      1043  10.18
 *     lucide-react 0.460.0             5211   33.4%       730   7.14
 *     @phosphor-icons/react 2.1.10     3042   50.3%       688   4.42
 *     iconoir-react 7.12.1             1671      0%       658   2.54
 *     react-bootstrap-icons 1.11.6     2077      0%       561   3.70
 *     @ant-design/icons 5.6.1           832    0.1%       319   2.61
 *     @radix-ui/react-icons 1.3.2       318    100%       198   1.61
 *     react-feather 2.0.10              286      0%       195   1.47
 *     @tabler/icons-react 3.46.0       6250   99.9%         7 892.86
 *
 *   ships both                            n   icon%   families   p/f
 *     evergreen-ui 7.1.9                623   86.8%       377   1.65
 * ```
 *
 * The other 8 are not in the table because this function never sees them, or
 * sees too little to judge. They are four separate gaps in DISCOVERY, none of
 * them in this rule, and each one means a library a user has installed is
 * invisible to onboarding. Diagnosed 2026-09-15 against the real checker:
 *
 *  - *No declared types, implicit layout* — `grommet` (345 exports behind a
 *    bare root `index.d.ts`, no `types` field) and
 *    `@cloudscape-design/components` (191, behind `exports["."]: "./index.js"`).
 *    FIXED the same day: `discoverReactDtsEntries` now falls back to the
 *    layout TypeScript itself resolves, and both are offered.
 *  - *Types only under subpaths* — `primereact` (`primereact/button`) and
 *    `@heroicons/react` (`./24/outline`). Their package root genuinely has no
 *    declarations. Resolving these means walking `exports` subpaths and
 *    deciding which to scan; still OPEN.
 *  - *Union-typed components* — `@remixicon/react` declares all 3,228 of its
 *    exports as `ComponentType<P>`, which is `ComponentClass | FunctionComponent`.
 *    A union has no call OR construct signatures of its own, so
 *    `getReactPropsType` sees nothing and the package counts zero. This hits
 *    any library that types exports with React's own canonical component type.
 *    Still OPEN, and DELIBERATELY so — the fix is four lines (recurse into the
 *    union's constituents) but it must not land alone. PROTOTYPED and MEASURED
 *    2026-09-15 over 14 installed libraries: `@remixicon/react` goes 0 -> 3,227
 *    and `@mui/material` 146 -> 148, every other count unchanged. The problem
 *    is what 3,227 then does HERE. Remixicon prefixes every name `Ri`, so it
 *    collapses to THREE families at 1,076 names each, and none of the three
 *    signals fires: it would be offered as a design system with 3,227
 *    components, eleven times the `react-feather` case above.
 *
 *    A fourth signal would catch it — no design system measured exceeds 6.8
 *    names per family (Chakra), against 893 for `@tabler/icons-react` and
 *    1,076 for remixicon, so "enormous parts-per-family" separates by 130x and
 *    would also stop tabler depending on the literal word `Icon`. It is not
 *    added here because that signal means "brand-prefixed", not "icons", and
 *    design systems do it too: `@elastic/eui` names everything `Eui*` and
 *    would land in the same box. Untangling that is a classifier change with
 *    its own measurement pass, not a rider on an extractor fix.
 *  - *Ambient-module bundles* — `@elastic/eui` ships one 31k-line `eui.d.ts`
 *    of `declare module '…'` blocks. The file is not itself a module, so it
 *    has no module symbol to enumerate exports from; still OPEN.
 *
 * `baseui` (4 exports) and `react-icons` (2) are not gaps: their root entries
 * really do expose almost nothing, and both land under the 20-name floor.
 *
 * ## How to read the table before changing a number
 *
 * Read `icon%` before trusting signal 1. Five of the nine icon sets are under
 * 50% and four are effectively zero — the largest, `@mui/icons-material`,
 * names nothing `Icon` at all. `@tabler/icons-react` is the mirror image:
 * every name starts `Icon`, so it collapses to 7 families and signal 1 is the
 * only thing that catches it. The signals cover each other's blind spots.
 *
 * Read the `families` column for where each threshold sits. The largest design
 * system is `react-admin` at 127. The smallest icon set signal 1 misses is
 * `react-feather` at 195. 150 sits in that gap. 250 sits well above it, as
 * the unconditional catch-all for a spread no design system can reach.
 *
 * Read `p/f` for why 150 is safe. The design systems at or above 150 families:
 * none. The design systems under 2 p/f: eleven, and the largest of them is 89
 * families. Nothing measured is in both halves at once, and the nearest design
 * system, `react-admin`, misses on BOTH — 127 families and 2.39 p/f.
 *
 * The gap is not centered, and that is deliberate. The two mistakes do not cost
 * the same. Calling a design system "icons" removes it from onboarding with no
 * trace. Calling an icon set "a design system" seeds a row the user has to
 * notice and remove — the New Project step adds every detection and ignores
 * `confidence` (`new-project-page.tsx`, Mo 2026-09-08: "found means added;
 * remove what is not a design system") — plus the digest crowding described
 * above. Visible and reversible beats silent, so the design-system side keeps
 * the headroom.
 *
 * ## One known miss
 *
 * `evergreen-ui` is judged an icon set. It ships its icons in the same entry
 * as its components: 623 exports, 541 of them icon-named, 82 real components
 * (`Pane`, `Alert`, `Avatar`, `Button`, `Card`). Signal 1 claims the whole
 * package at 86.8%. It did under the old rule too, so this is not a
 * regression. Fixing it means judging the list with the icon-named names
 * REMOVED, which changes signal 1 for every package and changes what count
 * onboarding reports, so it is its own change.
 */
export function looksLikeIconSet(componentNames: readonly string[]): boolean {
  const n = componentNames.length
  if (n < 20) return false

  const iconNamed = componentNames.filter((name) => ICON_NAME_RE.test(name)).length
  if (iconNamed / n >= 0.5) return true

  const families = new Set<string>()
  for (const name of componentNames) families.add(FAMILY_RE.exec(name)?.[0] ?? name)
  if (families.size >= ICON_SET_MIN_FAMILIES) return true

  return families.size >= FLAT_MIN_FAMILIES && n / families.size < FLAT_MAX_PARTS_PER_FAMILY
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
