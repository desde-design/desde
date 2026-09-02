/**
 * Shared manifest-source builder used by both the manifest route
 * (`/api/editor/manifest`) and the catalog route
 * (`/api/editor/catalog`).
 *
 * Originally extracted from a Next.js route handler (since removed;
 * the CLI HTTP server at `editor-cli/src/server/manifest-handler.ts`
 * is now the only consumer) so the manifest and catalog endpoints can
 * reuse the same source ordering and discovery logic without duplicating
 * env-var handling, file walks, or storybook URL parsing.
 *
 * Lives in `edit-service/` (alongside `apply-llm-patch.ts`) because
 * it's pure project-tree introspection — no HTTP shape, no Next types.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseStorybookUrls } from './parse-storybook-urls'
import type { ComponentManifestSource } from '@/editor/core/manifest'
import { createHealthCollector } from '@/editor/core/grounding-health'
import type { GroundingHealth } from '@/editor/core/grounding-health'
import type { HintsCacheEntry } from '@/editor/adapters/hints-cache'
import { resolveTsconfig } from '@/editor/core/resolve-tsconfig'

/**
 * Manifest sources in load-bearing priority order. `CompositeManifestSource`
 * is first-source-wins for props, so this order is the actual precedence
 * ladder — earlier entries shadow later ones for the same component.
 */
export const MANIFEST_SOURCE_ORDER = [
  'storybook',
  'vue-component-meta',
  'local-vue',
  'local-react',
  'registered',
  'library-dts-auto-scan',
  'react-dts-auto-scan',
  'hints-cache',
  'storybook-url',
] as const

export type ManifestSourceStep = (typeof MANIFEST_SOURCE_ORDER)[number]

export interface BuildManifestSourceOptions {
  /**
   * Fired once per step, in `MANIFEST_SOURCE_ORDER` order — including
   * steps that contribute zero sources. Lets callers (tests, diagnostics)
   * observe per-step contribution without reaching into the composite.
   */
  onStep?: (step: ManifestSourceStep, sources: ComponentManifestSource[]) => void
}

const COMPONENT_FILE_RE = /\.vue$/i
/** First-party React component files. Tests/stories are excluded below. */
const REACT_COMPONENT_FILE_RE = /\.(tsx|jsx)$/i
const TEST_FILE_RE = /\.(test|spec)\.(tsx|jsx|ts|js)$/i
const STORY_FILE_RE = /\.stories\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
])

/** Any module that can `import` a component — the scan surface for
 *  {@link buildImportUsageIndex}. Broader than the component-file sets: a page
 *  that imports `<Link>` is usually not itself a component definition. */
const IMPORTING_FILE_RE = /\.(vue|[cm]?[jt]sx?)$/i

async function walkFiles(root: string): Promise<{
  components: string[]
  reactComponents: string[]
  stories: string[]
  importingFiles: string[]
}> {
  const components: string[] = []
  const reactComponents: string[] = []
  const stories: string[] = []
  const importingFiles: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (IMPORTING_FILE_RE.test(entry.name)) importingFiles.push(full)
      if (STORY_FILE_RE.test(entry.name)) {
        stories.push(full)
      } else if (COMPONENT_FILE_RE.test(entry.name)) {
        components.push(full)
      } else if (REACT_COMPONENT_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
        reactComponents.push(full)
      }
    }
  }
  await walk(root)
  return { components, reactComponents, stories, importingFiles }
}

/** What a prototype imports from one npm package. */
interface PackageImportUsage {
  /** Names imported from the package anywhere in the prototype. */
  names: Set<string>
  /**
   * Set when the package is imported namespace-style (`import * as I from …`)
   * or default-only. Either makes name-level usage unknowable, so the whole
   * package is treated as "everything possibly used".
   */
  opaque: boolean
}

/**
 * `import { Link } from 'react-router'` / `export { X } from 'antd/es/x'` —
 * matched against the raw module text. Deliberately a regex and not a Babel
 * parse: this runs over EVERY module in the tree (a few thousand on a real
 * app), it needs no positions and no scope analysis, and it must not fail on a
 * file that doesn't parse.
 */
const IMPORT_CLAUSE_RE =
  /(?:^|[\s;}])(?:import|export)\s+(type\s+)?([\s\S]{0,600}?)\s*from\s*['"]([^'"\n]+)['"]/g

/** `antd/es/button` → `antd`; `@scope/pkg/sub` → `@scope/pkg`; relative → null. */
function packageRootOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  return parts[0] ?? null
}

/**
 * Which component NAMES the prototype actually imports from which npm package.
 *
 * This is the exact signal behind the bare-name tie-break in
 * {@link buildManifestSource}: a package that is installed and imported, but
 * never under the name being resolved, is not what the user clicked. Measured
 * on a real React app, `Link` is imported from `react-router` in every file
 * that uses one and never from `lucide-react` — even though lucide also
 * exports a `Link` (the chain-link icon) and supplies 92% of the catalogue.
 *
 * Bounded on purpose: only names the prototype's own modules name explicitly.
 * A namespace or default import makes the package opaque, and an unseen
 * package produces no entry — both read as "no signal", never as "unused".
 */
async function buildImportUsageIndex(
  files: readonly string[],
): Promise<Map<string, PackageImportUsage>> {
  const index = new Map<string, PackageImportUsage>()
  const record = (pkg: string): PackageImportUsage => {
    let entry = index.get(pkg)
    if (!entry) {
      entry = { names: new Set(), opaque: false }
      index.set(pkg, entry)
    }
    return entry
  }

  await Promise.all(
    files.map(async (file) => {
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        return
      }
      if (!text.includes('from')) return
      IMPORT_CLAUSE_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = IMPORT_CLAUSE_RE.exec(text)) !== null) {
        const clause = match[2] ?? ''
        const pkg = packageRootOf(match[3] ?? '')
        if (!pkg) continue
        const entry = record(pkg)
        if (clause.includes('*')) {
          entry.opaque = true
          continue
        }
        const braceStart = clause.indexOf('{')
        // `import Button, { type ButtonProps } from 'antd/es/button'` — the
        // default binding's local name is the importer's choice, but it is
        // overwhelmingly the export's own name, and recording it can only
        // REDUCE demotion. Erring that way is the safe direction.
        const head = (braceStart >= 0 ? clause.slice(0, braceStart) : clause)
          .replace(/^\s*type\s+/, '')
          .replace(/,\s*$/, '')
          .trim()
        if (/^[A-Za-z_$][\w$]*$/.test(head)) entry.names.add(head)
        if (braceStart < 0) {
          // Default-only or side-effect import: no named list to learn from.
          entry.opaque = true
          continue
        }
        const braced = clause.slice(braceStart + 1, clause.lastIndexOf('}'))
        for (const raw of braced.split(',')) {
          // `Foo as Bar` — the PACKAGE's name is the left side.
          const name = raw.split(/\bas\b/)[0].replace(/^\s*type\s+/, '').trim()
          if (name) entry.names.add(name)
        }
      }
    }),
  )
  return index
}

/**
 * Gate for the `react-dts-auto-scan` step: does the PROTOTYPE ITSELF declare
 * `react` (in `dependencies` or `devDependencies`)? Distinct from the
 * per-library check inside `scanInstalledReactLibraries` (whether a
 * candidate library depends on react) — this is "is this even a React
 * project" before we bother scanning its dependency tree at all.
 */
async function prototypeDeclaresReact(root: string): Promise<boolean> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  return 'react' in (pkg.dependencies ?? {}) || 'react' in (pkg.devDependencies ?? {})
}

/**
 * Build the composite manifest source for the prototype.
 *
 * The CLI passes its repo root explicitly via `rootOverride` because it
 * never sets `EDITOR_PROTOTYPE_ROOT` — this is where `node_modules` and the
 * prototype tsconfig live (branch mode has no separate worktree; there is
 * only the one repo root). When no argument is provided the function falls
 * back to `EDITOR_PROTOTYPE_ROOT` (kept for legacy callers and tests).
 * Returns null when no root is resolvable or the path is unreadable —
 * caller should respond 503.
 *
 * Alongside the composite source, returns a {@link GroundingHealth} report:
 * one entry per step that either constructed a source or was explicitly
 * skipped for a structural reason (a step that contributes nothing because
 * there was nothing to contribute — an empty registry, no scanned libraries —
 * gets no entry; there's nothing to report). See `src/editor/core/grounding-health.ts`.
 */
export async function buildManifestSource(
  rootOverride?: string,
  opts?: BuildManifestSourceOptions,
): Promise<{ source: ComponentManifestSource; health: GroundingHealth } | null> {
  const root = rootOverride ?? process.env.EDITOR_PROTOTYPE_ROOT
  if (!root) return null

  let realRoot: string
  try {
    realRoot = await fs.realpath(root)
  } catch {
    return null
  }

  const collector = createHealthCollector(realRoot)

  const [{ components, reactComponents, stories, importingFiles }, tsconfigPath] =
    await Promise.all([walkFiles(realRoot), resolveTsconfig(realRoot)])
  const importUsage = await buildImportUsageIndex(importingFiles)

  // Lazy-import the heavy adapters so a deployment without Vue compiler
  // devDeps installed doesn't error at module-load time.
  const [
    { LocalVueManifestSource },
    { LocalReactManifestSource },
    { VueComponentMetaManifestSource },
    { StorybookManifestSource },
    { discoverVueDtsComponents },
    { VueDtsMetaManifestSource },
    { scanInstalledVueLibraries },
    { PACKAGE_OVERRIDES },
    {
      CACHE_DIR_NAME,
      resolvePackageVersion,
      resolveHintsCacheVersion,
      CachedManifestSource,
      fingerprintFile,
    },
    { StorybookUrlManifestSource },
    { CompositeManifestSource },
    { createLocalRegistryStore },
    { buildRegisteredSources },
    { discoverReactDtsEntries },
    { ReactDtsMetaManifestSource },
    { scanInstalledReactLibraries },
    { HintsCacheManifestSource, hintCacheFilePath, readHintCache },
  ] = await Promise.all([
    import('@/editor/adapters/local-vue'),
    import('@/editor/adapters/local-react'),
    import('@/editor/adapters/vue-component-meta'),
    import('@/editor/adapters/storybook'),
    import('@/editor/adapters/vue-dts-meta/presets'),
    import('@/editor/adapters/vue-dts-meta'),
    import('@/editor/adapters/vue-dts-meta/auto-scan'),
    import('@/editor/adapters/vue-dts-meta/overrides'),
    import('@/editor/adapters/cached'),
    import('@/editor/adapters/storybook-url'),
    import('@/editor/adapters/composite'),
    import('@/editor/onboarding/registry-store'),
    import('@/editor/onboarding/build-registered-sources'),
    import('@/editor/adapters/react-dts-meta/presets'),
    import('@/editor/adapters/react-dts-meta'),
    import('@/editor/adapters/react-dts-meta/auto-scan'),
    import('@/editor/adapters/hints-cache'),
  ])

  const storybook = new StorybookManifestSource({
    storyFiles: stories,
    designSystem: 'storybook',
  })
  collector.record({
    step: 'storybook',
    sourceId: storybook.id,
    discovered: stories.length,
    status: 'ok',
  })

  const vueComponentMeta = tsconfigPath
    ? new VueComponentMetaManifestSource({
        tsconfigPath,
        componentFiles: components,
        designSystem: 'first-party',
      })
    : null
  if (vueComponentMeta) {
    collector.record({
      step: 'vue-component-meta',
      sourceId: vueComponentMeta.id,
      discovered: components.length,
      status: 'ok',
    })
  } else {
    collector.record({
      step: 'vue-component-meta',
      sourceId: 'vue-component-meta',
      discovered: 0,
      status: 'skipped',
      reason: 'no tsconfig',
    })
  }

  const localVue = new LocalVueManifestSource({
    componentFiles: components,
    designSystem: 'first-party',
  })
  collector.record({
    step: 'local-vue',
    sourceId: localVue.id,
    discovered: components.length,
    status: 'ok',
  })

  // First-party React components — props + inferred rendering hints from JSX.
  // Globs .tsx/.jsx, so it's a no-op on a Vue project (no such component files)
  // and vice-versa; no explicit framework gate needed.
  const localReact = new LocalReactManifestSource({
    componentFiles: reactComponents,
    designSystem: 'first-party',
  })
  collector.record({
    step: 'local-react',
    sourceId: localReact.id,
    discovered: reactComponents.length,
    status: 'ok',
  })

  // Per-project dynamic registry (self-serve onboarding, Phase 6 §10). User-
  // registered design systems are layered OVER the static auto-scan: a
  // registered entry wins over the auto-scan of the same package (ordered
  // first below; the auto-scan loop skips registered packages). A missing /
  // malformed registry file reads as empty (never breaks serving).
  const cacheDirForRegistry = path.join(realRoot, CACHE_DIR_NAME)
  const registry = await createLocalRegistryStore(realRoot).list()
  const { sources: registeredSources, registeredPackages } = buildRegisteredSources({
    registry,
    prototypeRoot: realRoot,
    tsconfigPath,
    cacheDir: cacheDirForRegistry,
    deps: {
      discoverVueDtsComponents,
      VueDtsMetaManifestSource,
      discoverReactDtsEntries,
      ReactDtsMetaManifestSource,
      resolvePackageVersion,
      CachedManifestSource,
      fingerprintFile,
    },
    onSkip: (packageName, reason) => {
      collector.record({
        step: 'registered',
        sourceId: packageName,
        packageName,
        discovered: 0,
        status: 'skipped',
        reason,
      })
    },
    onSource: ({ packageName, sourceId, discovered }) => {
      collector.record({
        step: 'registered',
        sourceId,
        packageName,
        discovered,
        status: 'ok',
      })
    },
  })

  // Full-fidelity live extraction from every installed Vue library
  // that ships `*.vue.d.ts` declarations. Runs the real TS checker over
  // each library's resolved `$props` type — same fidelity as
  // vue-component-meta over source, but with no source required.
  //
  // Auto-scan picks up installed libraries with no per-library code at
  // all; `PACKAGE_OVERRIDES` is the escape hatch for non-default layouts,
  // internal-helper filtering, or `designSystem` re-stamping.
  //
  // Ordered ahead of `hints-cache`: the composite is first-source-wins for
  // props but overlays rendering hints from every source, so the generated
  // hints in the on-disk hint cache still merge onto these props.
  // Shared by both the Vue and React auto-scan loops below: all these
  // sources share the same prototype tsconfig, so hashing it once and
  // reusing it for every wrap avoids wasted per-package work.
  const cacheDir = path.join(realRoot, CACHE_DIR_NAME)
  // A null tsconfig contributes a distinct, stable context key rather than a
  // fingerprint. That is what makes the React loop's no-config fallback safe to
  // cache: a prototype that later ADDS a tsconfig moves off this key and
  // re-extracts, instead of serving manifests built under the default options.
  const tsconfigContext = tsconfigPath ? fingerprintFile(tsconfigPath) : 'no-tsconfig-v1'

  // Packages the `hints-cache` step (below) will consult for
  // generated/inferred rendering hints. Collected from the SAME loops
  // that build the props sources — registered entries first (so a package
  // registered under a re-stamped `designSystem` doesn't get double-counted
  // under its raw package name by the auto-scan loops below, which skip
  // anything in `registeredPackages`).
  //
  // Live version resolution (M1 fix): for an entry WITHOUT a `packageRoot`
  // override — i.e. living at `node_modules/<package>` — the registry's
  // `entry.version` is only an onboard-time snapshot, so it goes stale the
  // moment the user `npm install`s an upgrade without hitting the explicit
  // `/refresh` route. `resolveHintsCacheVersion` (`adapters/cached`) is the
  // ONE shared implementation of this rule — the writer
  // (`design-systems-handler.ts`'s generate-hints route) calls the exact
  // same helper so the two can't drift apart again.
  const hintsCacheEntries: HintsCacheEntry[] = registry.map((entry) => {
    const packageVersion = resolveHintsCacheVersion(realRoot, entry)
    return {
      packageName: entry.package,
      packageVersion,
      designSystem: entry.designSystem,
      framework: entry.framework,
      importPath: entry.importPath,
    }
  })

  const libraryDtsSources: ComponentManifestSource[] = []
  if (tsconfigPath) {
    const scanned = await scanInstalledVueLibraries(realRoot)
    for (const { packageName, packageRoot, dtsRoot } of scanned) {
      // A registered entry takes precedence over the auto-scan of the same
      // package — skip the auto-scan dupe (the registered source is built above).
      if (registeredPackages.has(packageName)) continue
      const override = PACKAGE_OVERRIDES[packageName] ?? {}
      if (override.enabled === false) continue
      const discovery = override.discovery ?? {
        dtsRoots: [path.relative(packageRoot, dtsRoot) || '.'],
      }
      const components = discoverVueDtsComponents(packageRoot, discovery)
      if (components.length === 0) continue
      const packageVersion = resolvePackageVersion(packageRoot)
      const hintsDesignSystem = override.designSystem ?? packageName
      if (packageVersion) {
        hintsCacheEntries.push({
          packageName,
          packageVersion,
          designSystem: hintsDesignSystem,
          framework: 'vue3',
          importPath: packageName,
        })
      }
      const sourceId = `${packageName}-vue-dts`
      const inner = new VueDtsMetaManifestSource({
        id: sourceId,
        tsconfigPath,
        components,
        framework: 'vue3',
        designSystem: override.designSystem ?? packageName,
        importPath: packageName,
      })
      const healthEntry = collector.record({
        step: 'library-dts-auto-scan',
        sourceId,
        packageName,
        discovered: components.length,
        status: 'ok',
      })
      libraryDtsSources.push(
        packageVersion
          ? new CachedManifestSource({
              inner,
              cacheDir,
              key: packageName,
              version: packageVersion,
              context: tsconfigContext,
              onCacheEvent: (event) => {
                healthEntry.cache = event
              },
            })
          : inner,
      )
    }
  } else {
    collector.record({
      step: 'library-dts-auto-scan',
      sourceId: 'library-dts-auto-scan',
      discovered: 0,
      status: 'skipped',
      reason: 'no tsconfig',
    })
  }

  // React analogue of the Vue auto-scan above: full-fidelity live extraction
  // from every installed React library that (a) the prototype itself
  // declares as a dependency, (b) declares `react` in ITS OWN dependencies
  // or peerDependencies, and (c) resolves a `.d.ts` entry. Bounded to the
  // prototype's declared deps (see `scanInstalledReactLibraries` — React has
  // no `.vue.d.ts`-style marker, so an unbounded `node_modules` walk would
  // build a TS program over every typed package in the tree).
  //
  // Gated on the prototype itself being a React project — scanning is
  // pointless (and the per-dependency package.json reads are wasted work)
  // on a non-React prototype.
  // NOT gated on `tsconfigPath`, unlike the Vue loops above. A React prototype
  // written in plain JavaScript ships neither a tsconfig nor a jsconfig, and
  // that is an ordinary shape rather than a broken one — MEASURED 2026-08-16
  // (`tasks/react-hint-generation-phase0.md` § 7.7), the skip cost such a
  // prototype every installed library manifest while the auto-scan below found
  // its packages perfectly well. `buildProgram` falls back to
  // `DEFAULT_DTS_OPTIONS` for a null config; see `adapters/ts-program.ts` for
  // why defaults rather than a written file.
  //
  // The Vue loops keep their gate deliberately: `vue-component-meta` is a
  // different tool with its own config requirement, and a JavaScript Vue app
  // carries `jsconfig.json` (see `resolve-tsconfig.ts`), so the gap measured
  // here is React's alone. Widening Vue's gate without measuring it would be
  // the mistake this file keeps writing down.
  const reactDtsSources: ComponentManifestSource[] = []
  if (!(await prototypeDeclaresReact(realRoot))) {
    collector.record({
      step: 'react-dts-auto-scan',
      sourceId: 'react-dts-auto-scan',
      discovered: 0,
      status: 'skipped',
      reason: 'prototype does not declare react',
    })
  } else {
    const scannedReact = await scanInstalledReactLibraries(realRoot)
    for (const { packageName, packageRoot, entryFiles } of scannedReact) {
      // Same registered-precedence + override rules as the Vue loop. The
      // override's `discovery` field is Vue-shaped (dtsRoots/include/exclude
      // for `.vue.d.ts` discovery) and does not apply to React's
      // entry-file-based discovery — only `enabled` and `designSystem` are
      // honored here.
      if (registeredPackages.has(packageName)) continue
      const override = PACKAGE_OVERRIDES[packageName] ?? {}
      if (override.enabled === false) continue
      const packageVersion = resolvePackageVersion(packageRoot)
      if (packageVersion) {
        hintsCacheEntries.push({
          packageName,
          packageVersion,
          designSystem: override.designSystem ?? packageName,
          framework: 'react',
          importPath: packageName,
        })
      }
      const sourceId = `${packageName}-react-dts`
      const inner = new ReactDtsMetaManifestSource({
        id: sourceId,
        tsconfigPath,
        entryFiles,
        framework: 'react',
        designSystem: override.designSystem ?? packageName,
        importPath: packageName,
      })
      const healthEntry = collector.record({
        step: 'react-dts-auto-scan',
        sourceId,
        packageName,
        // Component count is only known after extraction (the checker walks
        // the entry file's exports); `discovered` here counts resolved
        // entry FILES, not components — reporting what's known cheaply at
        // construction time.
        discovered: entryFiles.length,
        status: 'ok',
      })
      reactDtsSources.push(
        packageVersion
          ? new CachedManifestSource({
              inner,
              cacheDir,
              key: packageName,
              version: packageVersion,
              context: tsconfigContext,
              onCacheEvent: (event) => {
                healthEntry.cache = event
              },
            })
          : inner,
      )
    }
  }

  const allowlist = (process.env.EDITOR_STORYBOOK_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const storybookUrlSources = parseStorybookUrls(
    process.env.EDITOR_STORYBOOK_URLS,
    { allowlist },
  ).map(
    ({ baseUrl, designSystem, importPath }) =>
      new StorybookUrlManifestSource({
        baseUrl,
        designSystem,
        importPath,
      }),
  )
  // One entry per configured URL — this is a variable-count discovery step
  // (like `registered` / `library-dts-auto-scan`), not a single fixed source;
  // zero configured URLs means nothing to report, not a skip.
  for (const s of storybookUrlSources) {
    collector.record({ step: 'storybook-url', sourceId: s.id, discovered: 0, status: 'ok' })
  }

  // `hints-cache` — serves generated/inferred `rendering` hints (see
  // `src/editor/adapters/hints-cache/index.ts`) for the packages
  // collected by the loops above. Ordered AFTER the props sources in
  // `MANIFEST_SOURCE_ORDER` — it contributes hints, never props, and the
  // composite overlays hints from a lower-priority source onto the props
  // winner. One `HintsCacheManifestSource` PER ENTRY (each
  // scoped to its own package's hint file), pushed in entry order — NOT one
  // source shared over every package. A shared source previously refused
  // with `null` whenever two packages' hint files both named the same
  // component (e.g. two design systems each shipping a "Button"), which
  // meant NEITHER package's hints ever surfaced; per-package sources have no
  // such ambiguity by construction, and the composite's
  // `isPlausiblySameComponent` identity guard (matching `designSystem`/
  // `importPath` against the props winner) picks the right one. One health
  // entry per hint FILE actually found on disk (not one per candidate
  // package) — most packages have never had hints generated, and that's not
  // a "skip," just nothing to report.
  const hintsCacheSources: ComponentManifestSource[] = []
  for (const entry of hintsCacheEntries) {
    hintsCacheSources.push(new HintsCacheManifestSource({ cacheDir, entry }))
    const file = hintCacheFilePath(cacheDir, entry.packageName, entry.packageVersion)
    const hintFile = readHintCache(file)
    if (!hintFile) continue
    collector.record({
      step: 'hints-cache',
      sourceId: `${entry.packageName}-hints-cache`,
      packageName: entry.packageName,
      discovered: Object.keys(hintFile.hints).length,
      status: 'ok',
    })
  }

  // Declarative, order-pinned composition: each step emits its
  // contribution (possibly empty) and `onStep` observes it before the
  // sources are flattened into the composite. The order here IS
  // `MANIFEST_SOURCE_ORDER` — keep the two in sync.
  const sources: ComponentManifestSource[] = []
  const emit = (step: ManifestSourceStep, stepSources: ComponentManifestSource[]) => {
    opts?.onStep?.(step, stepSources)
    sources.push(...stepSources)
  }
  emit('storybook', [storybook])
  emit('vue-component-meta', vueComponentMeta ? [vueComponentMeta] : [])
  emit('local-vue', [localVue])
  emit('local-react', [localReact])
  // Registered (user-onboarded) sources win over the auto-scan for props.
  emit('registered', registeredSources)
  emit('library-dts-auto-scan', libraryDtsSources)
  emit('react-dts-auto-scan', reactDtsSources)
  emit('hints-cache', hintsCacheSources)
  emit('storybook-url', storybookUrlSources)

  const source = new CompositeManifestSource({
    sources,
    // The concrete policy behind the composite's per-name tie-break: a
    // library component is an improbable answer for a bare name the
    // prototype demonstrably imports from somewhere else. Only ever
    // reorders — see `deprioritizeCandidate`'s contract.
    deprioritizeCandidate: (manifest, name) => {
      // First-party components carry no `importPath`. They are the whole
      // point of the ordering — never demote one.
      if (!manifest.importPath) return false
      const usage = importUsage.get(manifest.importPath)
      // Package never imported here, or imported opaquely (`import * as`,
      // default-only) → no signal, so no demotion.
      if (!usage || usage.opaque) return false
      return !usage.names.has(name)
    },
    onSourceError: (sourceId, methodName, err) => {
      collector.recordRuntimeError(sourceId, methodName, err)
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[CompositeManifestSource] source ${sourceId}.${methodName} threw: ${msg}`)
    },
  })

  return { source, health: collector.health }
}
