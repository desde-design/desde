/**
 * Turn the project's dynamic design-system registry into manifest sources,
 * merged ahead of (and deduped against) the auto-scan in
 * `build-manifest-source.ts`. Kept here — separate from that big lazy-import
 * function — so the per-entry build logic is unit-testable with injected deps
 * (no real TS checker, no filesystem walk).
 *
 * Precedence (spec §10 / open decision #1): a user-registered entry WINS over
 * the auto-scan of the same package. We both order registered sources first
 * (the composite is first-source-wins for props) AND report the registered
 * package names so the caller can skip them in the auto-scan loop.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ComponentManifestSource } from '@/editor/core/manifest'
import type {
  VueDtsComponent,
  VueDtsMetaSourceOptions,
} from '@/editor/adapters/vue-dts-meta'
import type { ReactDtsMetaSourceOptions } from '@/editor/adapters/react-dts-meta'
import type { CachedManifestSourceOptions } from '@/editor/adapters/cached'
import type { RegisteredDesignSystem } from './types'

/**
 * Injected constructors/discoverers (the heavy adapters are lazy-imported by
 * the caller; tests pass fakes).
 */
export interface RegisteredSourceDeps {
  discoverVueDtsComponents: (
    packageRoot: string,
    opts: { dtsRoots?: string[] },
  ) => VueDtsComponent[]
  VueDtsMetaManifestSource: new (o: VueDtsMetaSourceOptions) => ComponentManifestSource
  discoverReactDtsEntries: (packageRoot: string) => string[]
  ReactDtsMetaManifestSource: new (o: ReactDtsMetaSourceOptions) => ComponentManifestSource
  /** Resolve the installed version for the cache key; null → no cache. */
  resolvePackageVersion: (packageRoot: string) => string | null
  /** Wraps a produced source in the on-disk manifest cache decorator. */
  CachedManifestSource: new (o: CachedManifestSourceOptions) => ComponentManifestSource
  /** sha1 of a file's bytes for the cache `context` fingerprint; '' on failure. */
  fingerprintFile: (file: string) => string
}

export interface BuildRegisteredSourcesArgs {
  registry: RegisteredDesignSystem[]
  /** Prototype root — `node_modules/<package>` resolves under it. */
  prototypeRoot: string
  /** Required for both extractors; when null the registry contributes nothing. */
  tsconfigPath: string | null
  /** `.desde/manifests` dir (cache root). */
  cacheDir: string
  deps: RegisteredSourceDeps
  /** Optional sink for skip reasons (a registered package that yields nothing). */
  onSkip?: (packageName: string, reason: string) => void
  /**
   * Optional sink fired once per successfully-built source, so a caller
   * (the health collector in `build-manifest-source.ts`) can record a
   * per-entry health report without this module knowing about
   * `GroundingHealth` — it only reports what it already knows.
   */
  onSource?: (entry: { packageName: string; sourceId: string; discovered: number }) => void
}

export interface BuildRegisteredSourcesResult {
  sources: ComponentManifestSource[]
  /** Package names a source was built for — the auto-scan should skip these. */
  registeredPackages: Set<string>
}

export function buildRegisteredSources(
  args: BuildRegisteredSourcesArgs,
): BuildRegisteredSourcesResult {
  const { registry, prototypeRoot, tsconfigPath, cacheDir, deps, onSkip, onSource } = args
  const sources: ComponentManifestSource[] = []
  const registeredPackages = new Set<string>()

  const realRoot = path.resolve(prototypeRoot)
  for (const entry of registry) {
    // Per-entry tsconfig. An `npm`-ingested entry carries its OWN scratch
    // tsconfig (the prototype's can't resolve the scratch package's deps), and
    // must build even when the prototype has no usable tsconfig. Containment-
    // guard the override; fall back to the global prototype tsconfig otherwise.
    let entryTsconfig: string | null
    if (entry.tsconfigPath) {
      const resolved = path.resolve(realRoot, entry.tsconfigPath)
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
        onSkip?.(entry.package, `tsconfigPath escapes the prototype root (${entry.tsconfigPath})`)
        continue
      }
      entryTsconfig = resolved
    } else {
      entryTsconfig = tsconfigPath
    }
    if (!entryTsconfig) {
      onSkip?.(entry.package, 'no tsconfig available to extract this entry')
      continue
    }
    // Resolve the package root. An `npm`-ingested package carries an explicit
    // prototype-relative `packageRoot` (e.g. `.desde/ingested/…`); else it
    // lives at `node_modules/<package>`. Containment-guard the override so a
    // hand-edited entry can't point the extractor outside the prototype.
    let packageRoot: string
    if (entry.packageRoot) {
      const resolved = path.resolve(realRoot, entry.packageRoot)
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
        onSkip?.(entry.package, `packageRoot escapes the prototype root (${entry.packageRoot})`)
        continue
      }
      packageRoot = resolved
    } else {
      packageRoot = path.join(realRoot, 'node_modules', entry.package)
    }
    if (entry.framework === 'react') {
      // React: explicit dtsRoots are entry FILES — accept only `.d.ts` paths
      // (a directory has no source file for the TS checker → empty manifests).
      // When none qualify, fall back to resolving the package's declared types
      // entry (robust auto-discovery).
      const explicitEntryFiles = (entry.dtsRoots ?? [])
        .filter((r) => /\.d\.ts$/i.test(r))
        .map((r) => path.join(packageRoot, r))
      const entryFiles =
        explicitEntryFiles.length > 0
          ? explicitEntryFiles
          : deps.discoverReactDtsEntries(packageRoot)
      if (entryFiles.length === 0) {
        onSkip?.(entry.package, 'no resolvable React .d.ts entry')
        continue
      }
      const reactSourceId = `${entry.package}-registered`
      const reactInner = new deps.ReactDtsMetaManifestSource({
        id: reactSourceId,
        tsconfigPath: entryTsconfig,
        entryFiles,
        framework: 'react',
        designSystem: entry.designSystem,
        importPath: entry.importPath,
      })
      onSource?.({ packageName: entry.package, sourceId: reactSourceId, discovered: entryFiles.length })
      // Cache invalidation — mirrors the Vue branch below: for an `installed`
      // (node_modules) package, track the INSTALLED version so an upgrade
      // busts the cache; for a SCRATCH package (npm/repo, carries a
      // `packageRoot` override) use the onboard-time `entry.version` instead
      // (the package.json version isn't the cache identity there).
      const packageVersion = entry.packageRoot
        ? entry.version
        : (deps.resolvePackageVersion(packageRoot) ?? entry.version)
      sources.push(
        packageVersion
          ? new deps.CachedManifestSource({
              inner: reactInner,
              cacheDir,
              key: registeredCacheName(entry),
              version: packageVersion,
              context: deps.fingerprintFile(entryTsconfig),
            })
          : reactInner,
      )
      registeredPackages.add(entry.package)
      continue
    }

    // Vue (default): discover `*.vue.d.ts` under the registered dtsRoots.
    const components = deps.discoverVueDtsComponents(packageRoot, {
      dtsRoots: entry.dtsRoots,
    })
    if (components.length === 0) {
      onSkip?.(entry.package, 'no *.vue.d.ts components discovered')
      continue
    }
    // Cache invalidation. For an `installed` (node_modules) package, track the
    // INSTALLED version so an upgrade busts the cache — re-read it. For a SCRATCH
    // package (npm/repo, carries a `packageRoot` override), the package.json
    // version is NOT the cache identity (a mutable git branch keeps the same
    // version across commits), so use the onboard-time `entry.version` the
    // orchestrator computed (it folds in the resolved commit for repos).
    const packageVersion = entry.packageRoot
      ? entry.version
      : (deps.resolvePackageVersion(packageRoot) ?? entry.version)
    const vueSourceId = `${entry.package}-registered`
    const vueInner = new deps.VueDtsMetaManifestSource({
      id: vueSourceId,
      tsconfigPath: entryTsconfig,
      components,
      framework: 'vue3',
      designSystem: entry.designSystem,
      importPath: entry.importPath,
    })
    onSource?.({ packageName: entry.package, sourceId: vueSourceId, discovered: components.length })
    sources.push(
      packageVersion
        ? new deps.CachedManifestSource({
            inner: vueInner,
            cacheDir,
            // Registry-SPECIFIC cache key. The auto-scan keys only on
            // packageName+version, so reusing the bare package name here
            // would let a registered entry read the auto-scan's cached JSON
            // (wrong designSystem/importPath stamp). The hash folds in every
            // field that changes the extracted output (designSystem,
            // importPath, dtsRoots) so editing the registry entry also busts
            // the cache; version stays the packageVersion below.
            key: registeredCacheName(entry),
            version: packageVersion,
            context: deps.fingerprintFile(entryTsconfig),
          })
        : vueInner,
    )
    registeredPackages.add(entry.package)
  }

  return { sources, registeredPackages }
}

/**
 * Distinct cache identity for a registered source (Vue or React):
 * `<package>#reg-<hash>` where the hash covers the output-affecting fields.
 * Keeps registered manifests cached (onboarded systems can be large) without
 * colliding with the auto-scan cache for the same package, and re-extracts
 * when the entry is edited. Folds in `framework` (`fw`) too — flipping an
 * entry's framework changes which extractor branch runs (Vue's `.vue.d.ts`
 * discovery vs React's `discoverReactDtsEntries`/entry-file resolution), so
 * that switch must also bust the cache instead of replaying the old
 * framework's cached JSON under the new one. One-time invalidation for
 * existing registered entries is harmless (cache miss → re-extract).
 *
 * Exported (Phase 5 Task 5 carry-forward fix) so `src/editor/drift/
 * repair-component.ts` can reconstruct the SAME on-disk cache filename for a
 * REGISTERED entry — before this fix, granular repair always resolved the
 * auto-scan's bare-package-name key, which doesn't exist for a registered
 * entry, so repair on an attached design system (the primary customer path)
 * always reported `failed`.
 */
export function registeredCacheName(entry: RegisteredDesignSystem): string {
  const identity = JSON.stringify({
    ds: entry.designSystem,
    ip: entry.importPath,
    roots: [...(entry.dtsRoots ?? [])].sort(),
    fw: entry.framework,
  })
  const hash = createHash('sha1').update(identity).digest('hex').slice(0, 10)
  return `${entry.package}#reg-${hash}`
}
