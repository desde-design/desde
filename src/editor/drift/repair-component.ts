/**
 * Granular repair — Phase 5 Task 4 of the grounding rearchitecture
 * (`.superpowers/sdd/2026-07-29-grounding-phase5-drift/task-4-brief.md`):
 * given a drift signal that says ONE component's cached manifest may be
 * stale (`hint-miss` / `unknown-props`, see `REPAIRABLE_DRIFT_KINDS` in
 * `src/editor/core/drift.ts`), re-extract JUST that component and patch
 * it into the on-disk manifest cache — never a full package re-extract,
 * never a whole-graph rebuild.
 *
 * **Two V1 scope cuts closed 2026-07-30.** Both were originally out of
 * scope; both are now supported:
 *
 *   - **React.** Vue has a per-component re-extract unit (`.vue.d.ts`); React
 *     doesn't — `ReactDtsMetaManifestSource` always enumerates every export
 *     of the package's type-declaration entry file(s), so a single-component
 *     repair pays a whole-entry parse. That cost was the original blocker;
 *     re-examined, it's acceptable — a repair fires at most once per
 *     drifted component per process and is already serialized through
 *     `editor-cli/src/server/repair-queue.ts`. `deps.reextractReact`
 *     re-extracts via the package's entry files and this module patches
 *     ONLY the drifted component's manifest into the cache, same discipline
 *     as the Vue path.
 *   - **Ingested (npm/repo) registered entries.** A registered entry whose
 *     `packageRoot` points outside `node_modules` (materialized under
 *     `.desde/ingested/…` by npm-spec or git-repo onboarding) used to
 *     refuse outright. This module now mirrors
 *     `build-registered-sources.ts`'s exact resolution: `packageRoot` (and
 *     `tsconfigPath`) overrides are resolved relative to the prototype root
 *     WITH a containment guard, and the cache identity uses the entry's own
 *     `version` (not the installed `package.json` version — a mutable
 *     scratch branch keeps the same version across commits) instead of
 *     `resolvePackageVersion`.
 *
 * **Deviation from the task brief's minimal `RepairDeps` sketch.** The
 * brief lists three deps (`reextractVue`, `patchCache`, `invalidate`) and
 * `repairComponent`'s args as `{ entryKey, component, importPath,
 * prototypeRoot, deps }`. That's not enough information to actually locate
 * WHICH installed package/tsconfig backs a given `(component, importPath)`
 * pair — `reextractVue`'s own signature takes an already-resolved
 * `declarationFile`, so *something* upstream of it has to run discovery
 * first. This module adds the missing seam explicitly (rather than
 * silently baking package-resolution assumptions into a giant
 * `reextractVue` closure): `discoverVueDtsComponents`,
 * `resolveTsconfigPath`, `resolvePackageVersion`, and `fingerprintFile` are
 * added to `RepairDeps`, and `designSystem` is added to `repairComponent`'s
 * args (the caller already has it on `DriftEntry.designSystem`). All four
 * additions are cheap, non-TS-program functions — injecting them keeps
 * `repairComponent` fully unit-testable with fakes (no real fs, no real TS
 * checker), matching this task's "TDD with injected deps (no real TS
 * program in unit tests)" constraint and the same pattern
 * `build-registered-sources.ts` already uses for its own `RegisteredSourceDeps`.
 *
 * **The invalidation bound (read before wiring the shell side).** The
 * composite/grounding memo (`GroundingService`, memoized per canonical root
 * for the process lifetime) has NO granular invalidation path — this
 * module does NOT add one. What `repairComponent` actually does:
 *
 *   1. Patches the ONE changed component into the on-disk cache file
 *      (`patchCachedComponent`) — correct for the NEXT process/rebuild.
 *   2. Calls `deps.invalidate(component, importPath)` — a hook for an
 *      IN-PROCESS `CachedManifestLookup` to drop its cached entry. On the
 *      CLI server there is no such lookup (`CachedManifestLookup` is
 *      shell/browser state) — the server's `invalidate` is necessarily a
 *      no-op (see `createDefaultRepairDeps` below). The REAL live-session
 *      fix reaches the shell via the drift-handler HTTP response's
 *      `invalidate: Array<{ name; importPath? }>` field
 *      (`editor-cli/src/server/drift-handler.ts`), which Task 5's shell
 *      code must consume by calling its own `CachedManifestLookup.invalidate(...)`.
 *
 * The server's in-memory `CompositeManifestSource` / `GroundingService`
 * still serves the OLD value until the next full grounding rebuild — this
 * module does not touch it, by design (see the brief: "do NOT add
 * whole-graph invalidation here"). If that gap proves user-visible in the
 * Task 6 live check, the documented escalation is `resetGroundingCache()`
 * for the affected root (accepts the cost of a full rebuild on the next
 * manifest/catalog request).
 */

import { join, resolve, sep } from 'node:path'
import type { ComponentManifest } from '../core'
import { resolveTsconfig } from '../core/resolve-tsconfig'
import type { VueDtsComponent } from '../adapters/vue-dts-meta'
import {
  CACHE_DIR_NAME,
  EXTRACTOR_VERSION,
  fingerprintFile,
  patchCachedComponent,
  readCachedComponent,
  resolvePackageVersion,
  sanitize,
} from '../adapters/cached'
import { createLocalRegistryStore } from '../onboarding/registry-store'
import { registeredCacheName } from '../onboarding/build-registered-sources'
import type { RegisteredDesignSystem } from '../onboarding/types'
// Cheap fs-only discovery (reads `package.json`, no `typescript` import) —
// unlike `vue-dts-meta`'s `discoverVueDtsComponents` (whose sibling
// `presets.ts` imports the class that pulls in the TS compiler), this is
// safe to import statically; no lazy-import treatment needed.
import { discoverReactDtsEntries } from '../adapters/react-dts-meta/presets'

export interface RepairDeps {
  /** Vue single-component re-extract: builds a one-element `VueDtsMetaManifestSource` and resolves `componentName` from it. */
  reextractVue: (args: {
    componentName: string
    declarationFile: string
    tsconfigPath: string
    designSystem: string
    importPath: string
  }) => Promise<ComponentManifest | null>
  /**
   * React "whole-entry" re-extract (Carry-forward A, closed 2026-07-30).
   * React has no per-component declaration marker the way Vue's
   * `.vue.d.ts` is — `ReactDtsMetaManifestSource` always enumerates every
   * export of the package's type-declaration entry file(s), so a
   * single-component repair necessarily pays a whole-entry parse. Builds a
   * `ReactDtsMetaManifestSource` over `entryFiles` and resolves
   * `componentName` from the resulting map; the caller patches ONLY that
   * one component's manifest into the on-disk cache.
   */
  reextractReact: (args: {
    componentName: string
    entryFiles: string[]
    tsconfigPath: string
    designSystem: string
    importPath: string
  }) => Promise<ComponentManifest | null>
  /** Same function as `../adapters/cached`'s `patchCachedComponent` — injected for testability. */
  patchCache: typeof patchCachedComponent
  /** Same function as `../adapters/cached`'s `readCachedComponent` — used to decide `unchanged` vs `repaired`. */
  readCache: typeof readCachedComponent
  /** Invalidate just this component so the next lookup re-reads. See the module doc's "invalidation bound" section for what this can and can't do on the server. */
  invalidate: (component: string, importPath?: string) => void
  /**
   * Resolve the REGISTERED design-system entry backing this `importPath`, if
   * any (Task 5 carry-forward fix) — `null` when the package is only
   * auto-scanned (never explicitly registered/attached). When present, the
   * on-disk cache file for this component lives under the registered entry's
   * distinct `registeredCacheName()` key, NOT the auto-scan's bare package
   * name — see `cacheFilePathFor`'s doc comment for why conflating the two
   * silently resolved to a missing file for every registered entry.
   *
   * `designSystem` (codex P2, 2026-07-30) disambiguates when the registry
   * holds multiple entries sharing the same `importPath` but differing in
   * `designSystem`/`dtsRoots` (`buildRegisteredSources` gives each its own
   * `registeredCacheName()` key) — required to match when the drift signal
   * carries one. When the drift signal has no `designSystem` AND more than
   * one registered entry shares the importPath, implementations must refuse
   * (throw) rather than guess which one served the drifted manifest — the
   * caller's outer try/catch turns that into a `failed` outcome with the
   * thrown message as the reason.
   */
  findRegisteredEntry: (
    importPath: string,
    prototypeRoot: string,
    designSystem?: string,
  ) => Promise<RegisteredDesignSystem | null>
  /** Cheap fs discovery (no TS program) — resolves a component name to its `.vue.d.ts` declaration file under a package root. */
  discoverVueDtsComponents: (
    packageRoot: string,
    opts: { dtsRoots?: string[] },
  ) => Promise<VueDtsComponent[]>
  /**
   * Cheap fs discovery (no TS program, no lazy import needed — see
   * `createDefaultRepairDeps`) — resolves a package's type-declaration
   * ENTRY file(s) for React's whole-entry re-extract (Carry-forward A).
   * Sync; mirrors `react-dts-meta/presets`'s `discoverReactDtsEntries`
   * exactly (reads `package.json` `types`/`typings`/`exports["."].types`).
   */
  discoverReactDtsEntries: (packageRoot: string) => string[]
  /** Resolve the prototype's tsconfig path — `core/resolve-tsconfig.ts`'s `resolveTsconfig`, shared with `build-manifest-source.ts` and `onboarding/orchestrator.ts`. */
  resolveTsconfigPath: (prototypeRoot: string) => Promise<string | null>
  /** Resolve an installed package's version from its `package.json`; `null` → cache disabled for that package. */
  resolvePackageVersion: (packageRoot: string) => string | null
  /** sha1 of a file's bytes, for the cache `context` fingerprint. */
  fingerprintFile: (file: string) => string
}

export interface RepairOutcome {
  /**
   * `'repaired'` — a prior cached manifest EXISTED, the re-extracted one
   * differed, and the cache was patched to the new value.
   * `'unchanged'` — a prior cached manifest existed and was deep-equal to
   * the re-extracted one; nothing was written.
   * `'seeded'` — no prior cached entry existed at all (cache miss, or the
   * on-disk key predates this fix) — a fresh manifest was written but there
   * was nothing to compare it against, so this is NOT evidence the manifest
   * was actually stale/wrong. Callers that branch on `'unchanged'` to tell
   * the user "the manifest matched, so your hints are the likely stale
   * part" must treat `'seeded'` the same way — `'repaired'` alone should
   * imply a real prior/next diff was found.
   */
  outcome: 'repaired' | 'unchanged' | 'seeded' | 'failed' | 'unsupported'
  reason?: string
}

/**
 * Re-extract ONE component's manifest and patch it into the on-disk cache
 * if it actually changed. Never throws — every failure mode is reported as
 * an outcome, matching the advisory-first posture of the rest of the drift
 * pipeline.
 *
 * Vue AND React (Carry-forward A, closed 2026-07-30; dispatch fixed
 * 2026-07-30 codex review): a registered entry with `framework: 'react'`
 * goes straight to the React whole-entry re-extract (`deps.reextractReact`)
 * — no guessing needed, the registry already knows. An auto-scanned
 * (unregistered) importPath carries no framework signal of its own, so this
 * function prefers the PRIOR CACHED manifest's own `framework` field
 * (per-COMPONENT truth) when one exists, and only falls back to probing Vue
 * discovery first (today's convention) — then React entry-file discovery
 * (`deps.discoverReactDtsEntries`) when Vue finds nothing FOR THIS
 * PACKAGE — when there's no prior cache entry to consult. The package-wide
 * probe is NOT a safe per-component signal on its own: a dual-framework
 * package (ships both Vue and React components) can have Vue discovery
 * find ≥1 component while the SPECIFIC drifted component is a React
 * export, which the cached-`framework` preference now catches instead of
 * misdispatching to Vue and failing. `unsupported` is reserved for a
 * package that looks like NEITHER — no `*.vue.d.ts` under the resolved
 * package root AND no resolvable React `.d.ts` entry (or, for a
 * React-registered entry, no entry file resolvable via its `dtsRoots`
 * override or the package's declared `types`/`typings`/`exports`).
 *
 * Ingested (npm/repo) registered entries (Carry-forward B, closed
 * 2026-07-30): a registered entry's `packageRoot` / `tsconfigPath`
 * overrides (materialized under `.desde/ingested/…` by npm-spec or
 * git-repo onboarding) are now resolved and honored — mirroring
 * `build-registered-sources.ts`'s exact rule, containment guard included —
 * instead of refusing outright. The cache identity for such an entry uses
 * `entry.version` (the onboard-time version, which folds in the resolved
 * commit for a repo source) rather than `resolvePackageVersion`, since a
 * mutable scratch package's `package.json` version is not a trustworthy
 * invalidation key.
 *
 * REGISTERED vs auto-scanned cache key (Task 5 carry-forward fix): a
 * user-REGISTERED design-system entry (`build-registered-sources.ts`) is
 * cached under a hashed `<package>#reg-<hash>` key
 * (`registeredCacheName(entry)`), not the auto-scan's bare package name.
 * `deps.findRegisteredEntry` resolves which convention applies for this
 * `importPath` — see `cacheFilePathFor`'s doc comment for the two formulas.
 * Before this fix, a registered entry always resolved the auto-scan key,
 * which doesn't exist for it, so repair always reported `failed` for the
 * primary "attach an installed design system" customer path.
 *
 * Registered `dtsRoots` (codex P2, 2026-07-30): the SAME `findRegisteredEntry`
 * resolution above is also used to pass `{ dtsRoots: entry.dtsRoots }` into
 * `discoverVueDtsComponents` — a registered design system whose declarations
 * live outside the default `dist/types` probe order (normal serving already
 * honors this via `build-registered-sources.ts`'s `dtsRoots: entry.dtsRoots`)
 * used to report `unsupported`/component-not-found here even though the
 * component is extractable, because discovery always used the default probe
 * order regardless of the registry. An auto-scan entry (`findRegisteredEntry`
 * resolves `null`) passes `dtsRoots: undefined`, unchanged from before.
 *
 * Registered PACKAGE identity, not importPath (codex P2, 2026-07-30): once a
 * registered entry is resolved, the package root used for discovery AND
 * version resolution is derived from `entry.package` — the same
 * `node_modules/<package>` join `build-registered-sources.ts` uses for
 * normal serving — not the drift signal's `importPath`. A registered entry's
 * `importPath` can legitimately be a subpath or otherwise differ from the
 * installed package name; before this fix repair always resolved
 * `node_modules/<importPath>`, which doesn't exist for such an entry, so
 * discovery always came back empty and repair reported unsupported/
 * component-not-found and never patched. Auto-scan (no registered entry) is
 * unchanged: `importPath` IS the package name in that convention.
 *
 * Registered entry disambiguation by design system (codex P2, 2026-07-30):
 * the registry legitimately supports multiple entries sharing the same
 * `importPath` but differing in `designSystem`/`dtsRoots`
 * (`buildRegisteredSources` gives each its own `registeredCacheName()` key).
 * `deps.findRegisteredEntry` now also takes the drift entry's `designSystem`
 * and requires it to match when present. When the drift signal has no
 * `designSystem` and more than one registered entry shares the importPath,
 * `findRegisteredEntry` can't tell which one served the manifest that
 * drifted — it refuses (throws, caught by this function's outer try/catch)
 * rather than guessing and silently patching the wrong cache file.
 */
export async function repairComponent(args: {
  entryKey: string
  component: string
  importPath?: string
  designSystem?: string
  prototypeRoot: string
  deps: RepairDeps
}): Promise<RepairOutcome> {
  const { component, importPath, designSystem, prototypeRoot, deps } = args

  try {
    if (!importPath) {
      return {
        outcome: 'failed',
        reason: 'drift entry has no importPath; cannot resolve the owning package',
      }
    }

    // Resolve the registered entry (if any) FIRST: whether an ingested
    // (npm/repo) `packageRoot`/`tsconfigPath` override applies, and which
    // framework to extract with, both come from here. `designSystem`
    // disambiguates when the registry holds multiple entries sharing this
    // importPath — `findRegisteredEntry` throws (caught below) rather than
    // guessing when it can't tell which one served the manifest that drifted.
    const registeredEntry = await deps.findRegisteredEntry(importPath, prototypeRoot, designSystem)
    const realPrototypeRoot = resolve(prototypeRoot)

    // Tsconfig: an ingested registered entry (npm/repo onboarding) carries
    // its OWN scratch tsconfig — the prototype's own tsconfig can't resolve
    // the scratch package's deps (Carry-forward B; mirrors
    // `build-registered-sources.ts`'s identical rule). Containment-guard the
    // override; fall back to the prototype's own tsconfig otherwise.
    let tsconfigPath: string | null
    if (registeredEntry?.tsconfigPath) {
      const resolvedTsconfig = resolve(realPrototypeRoot, registeredEntry.tsconfigPath)
      if (
        resolvedTsconfig !== realPrototypeRoot &&
        !resolvedTsconfig.startsWith(realPrototypeRoot + sep)
      ) {
        return {
          outcome: 'failed',
          reason: `registered entry tsconfigPath escapes the prototype root (${registeredEntry.tsconfigPath})`,
        }
      }
      tsconfigPath = resolvedTsconfig
    } else {
      tsconfigPath = await deps.resolveTsconfigPath(prototypeRoot)
    }
    if (!tsconfigPath) {
      return { outcome: 'failed', reason: 'no tsconfig available to re-extract' }
    }

    // Package root: an ingested registered entry carries an explicit
    // prototype-relative `packageRoot` (e.g. `.desde/ingested/…`)
    // instead of living at `node_modules/<package>` (Carry-forward B; same
    // containment rule as `build-registered-sources.ts`). Otherwise resolve
    // under `node_modules` — the registered entry's own `package` field when
    // one was resolved (a registered `importPath` can legitimately be a
    // subpath or otherwise differ from the installed package name), else the
    // drift signal's own `importPath` for the auto-scan case (importPath IS
    // the package name there).
    //
    // The identity fed into either branch may come from the registered
    // entry's trusted config OR the drift entry's `importPath`, which is
    // ultimately DOM-derived (the bridge's runtime component-chain
    // extraction) — not a value this process itself chose. Resolve + contain
    // it before using it in any fs path so a crafted/unusual value (e.g.
    // `../../../../etc`) can't make discovery walk outside the prototype's
    // tree.
    let packageRoot: string
    if (registeredEntry?.packageRoot) {
      const resolved = resolve(realPrototypeRoot, registeredEntry.packageRoot)
      if (resolved !== realPrototypeRoot && !resolved.startsWith(realPrototypeRoot + sep)) {
        return {
          outcome: 'failed',
          reason: `registered entry packageRoot escapes the prototype root (${registeredEntry.packageRoot})`,
        }
      }
      packageRoot = resolved
    } else {
      const packageIdentity = registeredEntry?.package ?? importPath
      const nodeModulesRoot = resolve(prototypeRoot, 'node_modules')
      const resolved = resolve(nodeModulesRoot, packageIdentity)
      if (resolved !== nodeModulesRoot && !resolved.startsWith(nodeModulesRoot + sep)) {
        return {
          outcome: 'failed',
          reason: `resolved package "${packageIdentity}" resolves outside node_modules; refusing to repair`,
        }
      }
      packageRoot = resolved
    }

    // Cache identity — resolved SPECULATIVELY here (moved up, codex review
    // 2026-07-30) so the prior cached manifest can be read and used as a
    // framework-dispatch signal below. An ingested entry (Carry-forward B)
    // uses its onboard-time `entry.version` — a mutable git branch keeps the
    // same `package.json` version across commits, so that version isn't a
    // trustworthy invalidation key. Installed packages (registered or
    // auto-scanned) use the REAL installed version so an `npm install`
    // upgrade busts the cache — same rule `build-registered-sources.ts` uses.
    //
    // "Speculative" matters: an unresolvable version does NOT fail the
    // repair here. It only means there's no prior cache to consult for the
    // framework signal, so the framework decision below falls through to
    // the heuristic. The REAL, repair-failing version check stays in its
    // original position — after discovery/target-resolution, right before
    // extraction (see below) — so a genuinely `unsupported` package (no
    // `*.vue.d.ts` AND no React entry) still reports `unsupported` even when
    // its version also happens to be unresolvable, instead of a version
    // failure masking it.
    const packageVersion: string | null = registeredEntry?.packageRoot
      ? registeredEntry.version
      : (deps.resolvePackageVersion(packageRoot) ?? registeredEntry?.version ?? null)
    let context = ''
    let cacheFile: string | null = null
    if (packageVersion) {
      context = deps.fingerprintFile(tsconfigPath)
      cacheFile = registeredEntry
        ? registeredCacheFilePathFor(prototypeRoot, registeredEntry, packageVersion, context)
        : cacheFilePathFor(prototypeRoot, importPath, packageVersion, context)
    }

    // Read the prior cached manifest ONCE, up front (when a cache file could
    // even be identified) — used both as a framework-dispatch signal below
    // (for the auto-scan case) and later to decide
    // `repaired`/`unchanged`/`seeded`. Reading it here rather than after
    // re-extraction closes a dispatch bug (codex review 2026-07-30): see the
    // framework-decision comment immediately below.
    const priorCached = cacheFile ? deps.readCache(cacheFile, component) : null

    // Framework + discovery. A registered entry KNOWS its framework
    // (`entry.framework`) — no guessing needed, and its `dtsRoots` override
    // (codex P2, 2026-07-30) is honored for whichever branch applies (Vue:
    // directories to scan for `*.vue.d.ts`; React: explicit `.d.ts` entry
    // files).
    //
    // An auto-scanned entry (`registeredEntry` null) carries no framework
    // signal of its own, so prefer, in order: (1) the PRIOR CACHED
    // manifest's own `framework` field, when one exists — this is
    // per-COMPONENT truth, unlike (2) below; (2) only when there's no prior
    // cache to consult, probe Vue discovery first (today's convention) and
    // fall back to React entry-file discovery (Carry-forward A) when Vue
    // finds nothing FOR THIS PACKAGE.
    //
    // Why (1) matters (codex review 2026-07-30): "Vue discovery found ≥1
    // component" is a PACKAGE-WIDE fact, not a per-component one. A
    // dual-framework package (ships both Vue and React components — e.g. a
    // design system mid-migration) can have `discovered.length > 0` from
    // OTHER Vue components even when THIS drifted component is a React
    // export; committing to Vue on that package-wide signal alone made the
    // `vueTarget` lookup fail and return `failed`, never reaching the React
    // fallback for that component. The cached manifest's `framework` is
    // recorded per-component at its original extraction time, so it isn't
    // fooled by a sibling component's framework.
    let vueTarget: VueDtsComponent | undefined
    let reactEntryFiles: string[] = []
    let framework: 'vue3' | 'react'

    if (registeredEntry?.framework === 'react') {
      framework = 'react'
      reactEntryFiles = resolveReactEntryFiles(deps, packageRoot, registeredEntry.dtsRoots)
      if (reactEntryFiles.length === 0) {
        return {
          outcome: 'unsupported',
          reason: `no resolvable React .d.ts entry under ${packageRoot}`,
        }
      }
    } else if (registeredEntry) {
      framework = 'vue3'
      const discovered = await deps.discoverVueDtsComponents(packageRoot, {
        dtsRoots: registeredEntry.dtsRoots,
      })
      if (discovered.length === 0) {
        return {
          outcome: 'unsupported',
          reason: `no *.vue.d.ts declarations discovered under ${packageRoot}: an unconventional dtsRoots layout`,
        }
      }
      vueTarget = discovered.find((d) => d.componentName === component)
      if (!vueTarget) {
        return {
          outcome: 'failed',
          reason: `component "${component}" not found among ${discovered.length} discovered .vue.d.ts declarations under ${packageRoot}`,
        }
      }
    } else if (priorCached?.framework === 'react') {
      framework = 'react'
      reactEntryFiles = deps.discoverReactDtsEntries(packageRoot)
      if (reactEntryFiles.length === 0) {
        return {
          outcome: 'unsupported',
          reason: `no resolvable React .d.ts entry under ${packageRoot}`,
        }
      }
    } else if (priorCached && priorCached.framework !== 'react') {
      framework = 'vue3'
      const discovered = await deps.discoverVueDtsComponents(packageRoot, { dtsRoots: undefined })
      vueTarget = discovered.find((d) => d.componentName === component)
      if (!vueTarget) {
        return {
          outcome: 'failed',
          reason: `component "${component}" not found among ${discovered.length} discovered .vue.d.ts declarations under ${packageRoot}`,
        }
      }
    } else {
      // Genuinely unknown — no registration, no prior cache entry to
      // consult. Fall back to the package-wide probe-Vue-first heuristic.
      const discovered = await deps.discoverVueDtsComponents(packageRoot, { dtsRoots: undefined })
      if (discovered.length > 0) {
        framework = 'vue3'
        vueTarget = discovered.find((d) => d.componentName === component)
        if (!vueTarget) {
          return {
            outcome: 'failed',
            reason: `component "${component}" not found among ${discovered.length} discovered .vue.d.ts declarations under ${packageRoot}`,
          }
        }
      } else {
        reactEntryFiles = deps.discoverReactDtsEntries(packageRoot)
        if (reactEntryFiles.length === 0) {
          return {
            outcome: 'unsupported',
            reason:
              `no *.vue.d.ts declarations and no resolvable React .d.ts entry discovered under ` +
              `${packageRoot}: not a supported design-system package layout`,
          }
        }
        framework = 'react'
      }
    }

    // The REAL version-resolution gate, in its original position (after
    // discovery/target-resolution, before extraction) — see the "Cache
    // identity" comment above for why this isn't checked speculatively at
    // the top: an `unsupported` (no *.vue.d.ts / no React entry) outcome
    // from the discovery block above must still win over this when both
    // conditions occur together, which an early return here would prevent.
    if (!packageVersion || !cacheFile) {
      return {
        outcome: 'failed',
        reason: 'could not resolve installed package version; cache is disabled for this package',
      }
    }

    let manifest: ComponentManifest | null
    if (framework === 'react') {
      manifest = await deps.reextractReact({
        componentName: component,
        entryFiles: reactEntryFiles,
        tsconfigPath,
        designSystem: designSystem ?? importPath,
        importPath,
      })
    } else {
      if (!vueTarget) {
        // Unreachable in practice — every path that sets `framework = 'vue3'`
        // above either returns early or assigns `vueTarget`. Guards TS
        // narrowing across the branches rather than asserting with `!`.
        return { outcome: 'failed', reason: 'internal: no Vue declaration file resolved' }
      }
      manifest = await deps.reextractVue({
        componentName: component,
        declarationFile: vueTarget.declarationFile,
        tsconfigPath,
        designSystem: designSystem ?? importPath,
        importPath,
      })
    }
    if (!manifest) {
      return { outcome: 'failed', reason: 're-extraction returned no manifest' }
    }

    // Reuse the SAME cache read from before the framework decision — no
    // second `deps.readCache` call. The file/component identity it was read
    // under (`cacheFile`, `component`) hasn't changed since.
    const cached = priorCached
    if (cached && manifestsEqual(cached, manifest)) {
      return {
        outcome: 'unchanged',
        reason:
          're-extracted manifest matches the cached one; drift is likely stale rendering ' +
          'hints or a DOM/selector mismatch, not stale props',
      }
    }

    const patched = deps.patchCache(cacheFile, manifest)
    if (!patched) {
      return {
        outcome: 'failed',
        reason: `could not patch on-disk cache at ${cacheFile} (missing or corrupt)`,
      }
    }

    deps.invalidate(component, importPath)

    // No prior cache entry to diff against (cache miss, or a stale-era key
    // this component was never written under) — a fresh manifest was
    // written, but that's NOT the same claim as "a stale one was corrected".
    // Report `seeded` so the trust path (drift panel / handler invalidate
    // list) doesn't tell the user their manifest problem is solved when
    // nothing was actually compared.
    if (!cached) {
      return {
        outcome: 'seeded',
        reason: 'no prior cache entry to compare; wrote a fresh manifest',
      }
    }
    return { outcome: 'repaired' }
  } catch (err) {
    // repairComponent must never throw — an unexpected error anywhere in
    // this chain (a discovery helper throwing, a re-extract rejecting) is
    // just another `failed` outcome, not an unhandled rejection the
    // fire-and-forget caller (the drift handler) would have to guard again.
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve the React entry `.d.ts` file(s) to whole-entry re-extract for a
 * REGISTERED entry (Carry-forward A). Mirrors `build-registered-sources.ts`'s
 * identical rule: an explicit `dtsRoots` override is treated as entry FILES
 * (only `.d.ts` paths qualify — a directory has no source file for the TS
 * checker), falling back to `deps.discoverReactDtsEntries`'s auto-discovery
 * (the package's declared `types`/`typings`/`exports["."].types`) when none
 * qualify or no override was given.
 */
function resolveReactEntryFiles(
  deps: RepairDeps,
  packageRoot: string,
  dtsRoots: string[] | undefined,
): string[] {
  const explicitEntryFiles = (dtsRoots ?? [])
    .filter((r) => /\.d\.ts$/i.test(r))
    .map((r) => join(packageRoot, r))
  return explicitEntryFiles.length > 0 ? explicitEntryFiles : deps.discoverReactDtsEntries(packageRoot)
}

/**
 * Reconstruct the cache filename the auto-scan pipeline uses for this
 * package's props source (`build-manifest-source.ts`'s
 * `library-dts-auto-scan` loop: `key = packageName`, `version =
 * resolvePackageVersion(packageRoot)`, `context =
 * fingerprintFile(tsconfigPath)`) — mirrors `CachedManifestSource`'s
 * private filename formula (`${sanitize(key)}@${sanitize(version)}${ctx}@v${EXTRACTOR_VERSION}.json`)
 * exactly, using the SAME exported `sanitize`/`EXTRACTOR_VERSION`, so the
 * patch lands under the identical file the next boot's `CachedManifestSource`
 * reads. Duplicated here (not refactored into a shared export) because the
 * class computes this from constructor options it already has, and this
 * call site starts from different inputs (a bare `importPath`, not a `key`
 * option) with no instance to ask.
 *
 * Only covers AUTO-SCANNED packages (bare package name as the key). A
 * REGISTERED (onboarded/attached) design-system entry is cached under
 * `registeredCacheName()`'s distinct `<package>#reg-<hash>` key instead —
 * see {@link registeredCacheFilePathFor}, the sibling function `repairComponent`
 * uses when `deps.findRegisteredEntry` resolves one for this `importPath`.
 */
function cacheFilePathFor(
  prototypeRoot: string,
  importPath: string,
  packageVersion: string,
  context: string,
): string {
  const ctx = context ? `@${sanitize(context)}` : ''
  return join(
    prototypeRoot,
    CACHE_DIR_NAME,
    `${sanitize(importPath)}@${sanitize(packageVersion)}${ctx}@v${EXTRACTOR_VERSION}.json`,
  )
}

/**
 * Sibling to {@link cacheFilePathFor} for a REGISTERED design-system entry
 * (Task 5 carry-forward fix): uses `registeredCacheName(entry)` — the SAME
 * hashed `<package>#reg-<hash>` key `build-registered-sources.ts` keys its
 * own `CachedManifestSource` under — instead of the auto-scan's bare
 * `importPath`. Same filename formula otherwise
 * (`${sanitize(key)}@${sanitize(version)}${ctx}@v${EXTRACTOR_VERSION}.json`),
 * so the patch lands under the identical file the registered entry's own
 * `CachedManifestSource` reads on the next boot/rebuild.
 */
function registeredCacheFilePathFor(
  prototypeRoot: string,
  entry: RegisteredDesignSystem,
  packageVersion: string,
  context: string,
): string {
  const ctx = context ? `@${sanitize(context)}` : ''
  return join(
    prototypeRoot,
    CACHE_DIR_NAME,
    `${sanitize(registeredCacheName(entry))}@${sanitize(packageVersion)}${ctx}@v${EXTRACTOR_VERSION}.json`,
  )
}

/**
 * Structural deep-equal, restricted to the fields that matter for
 * attribution/inspector fidelity (props/slots/events/rendering) — a
 * `ComponentManifest`'s `id`/`source`/`extensions` bookkeeping fields can
 * legitimately differ between two independently-run extractions without
 * that being meaningful "drift." Plain-object/array/primitive recursion
 * (no functions/Dates/cycles in this data), order-sensitive for arrays —
 * a re-extract that reorders props IS a change worth patching. Written by
 * hand rather than `JSON.stringify`-comparing to avoid false positives
 * from incidental key-insertion-order differences between two otherwise-
 * identical objects.
 */
function manifestsEqual(a: ComponentManifest, b: ComponentManifest): boolean {
  return (
    deepEqual(a.props, b.props) &&
    deepEqual(a.slots ?? [], b.slots ?? []) &&
    deepEqual(a.events ?? [], b.events ?? []) &&
    deepEqual(a.rendering ?? [], b.rendering ?? [])
  )
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aRec = a as Record<string, unknown>
    const bRec = b as Record<string, unknown>
    const aKeys = Object.keys(aRec)
    const bKeys = Object.keys(bRec)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k) => Object.hasOwn(bRec, k) && deepEqual(aRec[k], bRec[k]))
  }
  return false
}

/**
 * Production `RepairDeps`: the real Vue re-extract (lazy-imports
 * `vue-dts-meta` + its `presets` module, both of which pull in the
 * `typescript` compiler — kept out of this module's static import graph so
 * a CLI boot that never triggers a repair never pays that cost) and the
 * real React whole-entry re-extract (same lazy-import treatment for
 * `react-dts-meta`'s index — its `presets` module is cheap fs-only and IS
 * imported statically at the top of this file, see the import's comment),
 * the real on-disk cache read/patch, and a no-op `invalidate` (see the
 * module doc's "invalidation bound" — the server has no in-process
 * `CachedManifestLookup` to invalidate; that's shell/browser state reached
 * via the drift-handler HTTP response instead).
 */
export function createDefaultRepairDeps(): RepairDeps {
  return {
    async reextractVue({ componentName, declarationFile, tsconfigPath, designSystem, importPath }) {
      const { VueDtsMetaManifestSource } = await import('../adapters/vue-dts-meta')
      const source = new VueDtsMetaManifestSource({
        tsconfigPath,
        components: [{ componentName, declarationFile }],
        designSystem,
        importPath,
      })
      return source.getComponent(componentName)
    },
    async reextractReact({ componentName, entryFiles, tsconfigPath, designSystem, importPath }) {
      const { ReactDtsMetaManifestSource } = await import('../adapters/react-dts-meta')
      const source = new ReactDtsMetaManifestSource({
        tsconfigPath,
        entryFiles,
        designSystem,
        importPath,
      })
      return source.getComponent(componentName)
    },
    patchCache: patchCachedComponent,
    readCache: readCachedComponent,
    invalidate: () => {
      // Intentional no-op — see the module doc's "invalidation bound"
      // section. The server has no live `CachedManifestLookup` instance to
      // clear; the real signal for the shell is the drift-handler
      // response's `invalidate` list.
    },
    async findRegisteredEntry(importPath, prototypeRoot, designSystem) {
      const registered = await createLocalRegistryStore(prototypeRoot).list()
      const candidates = registered.filter((entry) => entry.importPath === importPath)
      if (designSystem !== undefined) {
        // The drift signal names a design system — require it to match.
        // Zero matches means this importPath just isn't registered under
        // that design system (auto-scan path); never ambiguous, since
        // designSystem narrows to at most the entries that share BOTH keys.
        return candidates.find((entry) => entry.designSystem === designSystem) ?? null
      }
      if (candidates.length > 1) {
        // No designSystem to disambiguate and more than one registered
        // entry shares this importPath (legitimate: entries can differ in
        // designSystem/dtsRoots while importing from the same path) — don't
        // guess which one served the manifest that drifted. `repairComponent`
        // never lets this escape (the whole body is wrapped in try/catch),
        // so this surfaces as a `failed` outcome with this message as the
        // reason, same as any other resolution failure in this function.
        throw new Error(
          `ambiguous registered entry: ${candidates.length} registered design systems share ` +
            `importPath "${importPath}" and the drift signal carries no designSystem to ` +
            'disambiguate; refusing to guess which one to repair',
        )
      }
      return candidates[0] ?? null
    },
    async discoverVueDtsComponents(packageRoot, opts) {
      const { discoverVueDtsComponents } = await import('../adapters/vue-dts-meta/presets')
      return discoverVueDtsComponents(packageRoot, opts)
    },
    discoverReactDtsEntries,
    // Shared with build-manifest-source.ts (serving) and onboarding/
    // orchestrator.ts — see resolve-tsconfig.ts (audit Task 20 dedup). It's
    // dependency-free (only node:fs/node:path), so importing it here
    // doesn't pull in the adapter set the way importing
    // build-manifest-source.ts itself would.
    resolveTsconfigPath: resolveTsconfig,
    resolvePackageVersion,
    fingerprintFile,
  }
}
