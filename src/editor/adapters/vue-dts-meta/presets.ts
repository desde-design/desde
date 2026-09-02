/**
 * Discovery presets for `VueDtsMetaManifestSource`.
 *
 * A preset maps an installed package's file layout onto the canonical
 * `VueDtsComponent` triple (`componentName`, `declarationFile`,
 * `exportName`). The extractor's checker walk is shared; presets only
 * differ in how they locate each component's declaration file.
 *
 * Two declaration layouts are recognised (see `collectCandidates`):
 *
 *   1. `<Name>.vue.d.ts` — what `vue-tsc` emits per SFC. The original and
 *      still the most common shape.
 *   2. `<dir>/index.d.ts` sitting beside a sibling `<Name>.vue` — a
 *      hand-authored per-component barrel next to the shipped SFC. PrimeVue
 *      ships 122 components this way (`primevue/button/index.d.ts` beside
 *      `primevue/button/Button.vue`) and shipped zero `*.vue.d.ts`, so
 *      before this layout was recognised the most-installed Vue component
 *      library on npm produced an empty manifest set.
 *
 * The sibling `.vue` is doing two jobs in layout 2 and both are load-bearing:
 * it is the *filter* (an `index.d.ts` with no sibling SFC is a barrel, a
 * composable, or a style entry — PrimeVue ships 152 of those) and it is the
 * *name source* (the directory is lowercased — `button/` — while the runtime
 * component name is `Button`, and no case-restoring transform can recover
 * `DataTable` from `datatable`).
 *
 * Name collisions are resolved by path qualification rather than
 * last-writer-wins — see `assignComponentNames`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type { VueDtsComponent } from './index'

/**
 * Default exclude — skips leading-underscore basenames, which is the
 * widely-used convention for "internal/private" components shipped in
 * the same `dist/types` tree. Auto-scan callers can override with a
 * custom `exclude` regex.
 */
const DEFAULT_EXCLUDE = /(^|[\/\\])_/

/**
 * Directory names that namespace nothing. When a basename collision has to
 * be broken by path qualification, a segment from this set is skipped and
 * the walk continues outward — `runtime/vue/components/Icon` qualifies to
 * `VueIcon`, not `ComponentsIcon`.
 *
 * This mirrors what the frameworks themselves do: Nuxt's `addComponentsDir`
 * and Vue's `components/` auto-import both derive a component name from the
 * path *below* the components root, dropping the container segment.
 */
const GENERIC_PATH_SEGMENTS = new Set([
  'build',
  'cjs',
  'component',
  'components',
  'dist',
  'es',
  'esm',
  'index',
  'lib',
  'runtime',
  'src',
  'type',
  'types',
  'umd',
])

export interface GenericVueDtsDiscoveryOptions {
  /**
   * Sub-roots under `packageRoot` to scan recursively. The first root
   * that exists is used. Defaults to ['dist/types']; callers (including
   * auto-scan) typically pass the already-resolved root.
   */
  dtsRoots?: string[]
  /** RegExp filter on the relative path from a dtsRoot. */
  include?: RegExp
  /**
   * Skip files whose relative path matches. Defaults to `DEFAULT_EXCLUDE`
   * (leading-underscore basenames). Pass an explicit RegExp to override;
   * pass `/(?!)/` to disable.
   */
  exclude?: RegExp
  /**
   * Derive componentName from the absolute file path. Defaults to the
   * declaration's component name (see `collectCandidates`). Collision
   * qualification still applies on top of whatever this returns.
   */
  deriveName?: (file: string, packageRoot: string) => string
}

/** A located declaration file, before name-collision resolution. */
interface DtsCandidate {
  /** Name before qualification — the SFC/basename-derived component name. */
  baseName: string
  declarationFile: string
  /** POSIX-separated path from the dtsRoot it was found under. */
  relPath: string
}

/**
 * Generic recursive walk: under each dtsRoot, find every component
 * declaration (both layouts described at the top of this file), derive
 * `componentName`, and return the `default`-export triple. Covers the
 * real-world layouts measured in the onboarding doc — nested-per-component
 * (`<Name>/<Name>.vue.d.ts`), flat (`<Name>.vue.d.ts`), categorised
 * (`<category>/<Name>.vue.d.ts`), deeply nested
 * (`container/**\/<Name>.vue.d.ts`), and per-component barrel
 * (`<name>/index.d.ts` + `<Name>.vue`) — with one strategy.
 */
export function discoverVueDtsComponents(
  packageRoot: string,
  opts: GenericVueDtsDiscoveryOptions = {},
): VueDtsComponent[] {
  const roots = (opts.dtsRoots ?? ['dist/types']).map((r) => join(packageRoot, r))
  const candidates = collectCandidates(roots, opts, packageRoot)
  const names = assignComponentNames(candidates)
  return candidates.map((c) => ({
    componentName: names.get(c)!,
    declarationFile: c.declarationFile,
    exportName: 'default',
  }))
}

function collectCandidates(
  roots: string[],
  opts: GenericVueDtsDiscoveryOptions,
  packageRoot: string,
): DtsCandidate[] {
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE
  const out: DtsCandidate[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    if (!existsSync(root)) continue
    walk(root, root)
  }
  return out

  function walk(dir: string, root: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Sorted so the emitted order is filesystem-independent (readdir order
    // is not stable across platforms).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const files = entries.filter((e) => e.isFile())
    for (const entry of files) {
      const baseName = componentNameForFile(entry.name, files, dir)
      if (!baseName) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full)
      if (opts.include && !opts.include.test(rel)) continue
      if (exclude.test(rel)) continue
      if (seen.has(full)) continue
      seen.add(full)
      out.push({
        baseName: opts.deriveName ? opts.deriveName(full, packageRoot) : baseName,
        declarationFile: full,
        relPath: rel.split(sep).join('/'),
      })
    }

    // A nested `node_modules` holds a *dependency's* components, not this
    // package's. Descending into it both mis-attributes them and makes the
    // walk unbounded once a package root is itself a scan root.
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue
      walk(join(dir, entry.name), root)
    }
  }
}

/**
 * Which component (if any) a file in `dir` declares.
 *
 * `*.vue.d.ts` names itself. `index.d.ts` only counts when a sibling
 * `<Name>.vue` *named after its directory* identifies it: an exact match
 * first (`button/` → `Button.vue`), then the shortest name that merely
 * extends the directory (`angledown/` → `AngleDownIcon.vue`).
 *
 * The directory link is load-bearing, not decoration. PrimeVue colocates
 * internals with the public component — `button/` also ships
 * `BaseButton.vue`, `datatable/` ships fourteen SFCs — and only the
 * directory says which one `index.d.ts` declares. The looser rule "there
 * is exactly one sibling `.vue`, use it" was tried and measured worse: it
 * bought nothing PrimeVue needs and invented a bogus component out of
 * Nuxt's internal `dist/pages/runtime/index.d.ts` + `app.vue`, where the
 * colocation is a coincidence rather than an assertion.
 */
function componentNameForFile(
  fileName: string,
  siblings: { name: string }[],
  dir: string,
): string | null {
  if (fileName.endsWith('.vue.d.ts')) return basename(fileName, '.vue.d.ts')
  if (fileName !== 'index.d.ts') return null
  const dirKey = normalizeIdent(basename(dir))
  // An unnameable directory can't assert anything; `startsWith('')` would
  // otherwise match every sibling.
  if (!dirKey) return null
  let best: string | null = null
  for (const sibling of siblings) {
    if (!sibling.name.endsWith('.vue')) continue
    const name = sibling.name.slice(0, -'.vue'.length)
    const key = normalizeIdent(name)
    if (key === dirKey) return name
    if (!key.startsWith(dirKey)) continue
    // Shortest extension wins, then lexicographic — `tree/` prefers
    // `Tree.vue` over `TreeNode.vue`, deterministically.
    if (best === null || key.length < normalizeIdent(best).length) best = name
    else if (key.length === normalizeIdent(best).length && name < best) best = name
  }
  return best
}

/**
 * Resolve basename collisions by qualifying with path segments.
 *
 * Two declarations can legitimately share a basename — `@nuxt/ui` ships
 * `runtime/components/Badge.vue.d.ts` (registered at runtime as `UBadge`)
 * and `runtime/components/prose/Badge.vue.d.ts` (`ProseBadge`), plus three
 * router-specific builds of `Link`. Thirteen names collide there across 29
 * files. Returning both under one name meant the extractor's
 * `Map<name, manifest>` silently kept whichever the walk reached last — on
 * that package, the MDC prose variant, so `Badge` resolved to a 1-prop
 * `{ ui }` shape and the real `as/label/color/variant/size/icon/avatar` was
 * discarded. Sixteen of 187 components were lost that way.
 *
 * Rules:
 *   - The **shallowest** path keeps the bare name; ties break
 *     lexicographically. Depth *is* qualification in every layout this walk
 *     supports — the primary public tree sits at the dts root and specialised
 *     subtrees (`prose/`, `overrides/vue-router/`) hang below it, which is
 *     also how the libraries' own path→name conventions read those
 *     directories. It is a rule about what the path means, not about which
 *     file `readdir` happened to yield first.
 *   - Every other path is *kept*, under a name qualified by its nearest
 *     distinguishing directory segment (`prose/Badge` → `ProseBadge`,
 *     `overrides/vue-router/Link` → `VueRouterLink`) — which is exactly the
 *     name those components carry at runtime. Dropping them would trade one
 *     silent loss for another; a qualified name that no template ever uses
 *     simply never gets looked up.
 */
function assignComponentNames(
  candidates: DtsCandidate[],
): Map<DtsCandidate, string> {
  const groups = new Map<string, DtsCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.baseName)
    if (group) group.push(candidate)
    else groups.set(candidate.baseName, [candidate])
  }

  // Reserve every bare name up front so a qualified name can never collide
  // with a bare one belonging to a group processed later.
  const taken = new Set(groups.keys())
  const assigned = new Map<DtsCandidate, string>()

  for (const [baseName, group] of groups) {
    if (group.length === 1) {
      assigned.set(group[0], baseName)
      continue
    }
    const ordered = [...group].sort(compareByQualification)
    assigned.set(ordered[0], baseName)
    for (const candidate of ordered.slice(1)) {
      const name = qualifyName(baseName, candidate.relPath, taken)
      taken.add(name)
      assigned.set(candidate, name)
    }
  }
  return assigned
}

/** Shallowest path first, then lexicographic — fully deterministic. */
function compareByQualification(a: DtsCandidate, b: DtsCandidate): number {
  const depth = a.relPath.split('/').length - b.relPath.split('/').length
  if (depth !== 0) return depth
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
}

function qualifyName(
  baseName: string,
  relPath: string,
  taken: Set<string>,
): string {
  const dirs = relPath.split('/').slice(0, -1).reverse()
  let name = baseName
  for (const segment of dirs) {
    if (GENERIC_PATH_SEGMENTS.has(segment.toLowerCase())) continue
    const part = pascalCase(segment)
    if (!part) continue
    // `color-mode/ColorModeSelect` — the segment is already spelled in the
    // name, so prefixing it would only stutter.
    if (normalizeIdent(name).startsWith(normalizeIdent(part))) continue
    name = part + name
    if (!taken.has(name)) return name
  }
  // Every segment was generic, already spelled, or still ambiguous. A
  // deterministic ordinal beats dropping the declaration.
  let n = 2
  while (taken.has(`${name}${n}`)) n++
  return `${name}${n}`
}

function pascalCase(segment: string): string {
  return segment
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function normalizeIdent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}
