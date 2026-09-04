/**
 * Onboarding orchestrator (spec §5) — the single entry point every surface
 * calls to add a design system. This milestone (6.3a) implements the
 * `installed` source (the package is already in the prototype's node_modules,
 * the dogfood-primary "use what my prototype imports" case). The `npm` and
 * `repo` sources carry an extra wrinkle — their package lives in a scratch dir,
 * not `node_modules/<pkg>`, so the registry entry needs a packageRoot override
 * — and land in 6.3b / 6.5.
 *
 * Algorithm: ingest → detect framework → build a RegisteredDesignSystem entry
 * → build its manifest source → coverage → register → return. All I/O is
 * injected ({@link OnboardDeps}) so the orchestrator is unit-testable with
 * fakes; `createDefaultOnboardDeps` wires the real adapters (lazy-imported).
 */

import path from 'node:path'
import type { ComponentManifestSource, FrameworkId } from '@/editor/core/manifest'
import { resolveTsconfig } from '@/editor/core/resolve-tsconfig'
import { desdePath } from '@/editor/worktree/desde-dir'
import type { FrameworkDetection } from './detect-framework'
import type { ComputeCoverageOptions } from './coverage'
import type {
  CoverageReport,
  OnboardRequest,
  OnboardResult,
  OnboardStage,
  RegisteredDesignSystem,
  RegistryStore,
} from './types'

export interface OnboardDeps {
  detectFramework: (packageRoot: string) => FrameworkDetection
  resolvePackageVersion: (packageRoot: string) => string | null
  /** Resolve the prototype's tsconfig (anchors the TS checker — `installed`). */
  resolveTsconfig: (prototypeRoot: string) => Promise<string | null>
  /** Build a manifest source for one registered entry (wraps buildRegisteredSources). */
  buildSource: (
    entry: RegisteredDesignSystem,
    prototypeRoot: string,
    tsconfigPath: string,
  ) => ComponentManifestSource | null
  computeCoverage: (
    source: ComponentManifestSource,
    opts?: ComputeCoverageOptions,
  ) => Promise<CoverageReport>
  /**
   * Install an npm spec on demand into a hermetic scratch dir and return its
   * resolved root + its OWN tsconfig (which resolves the package's deps). Only
   * called for the `npm` source. Omitted ⇒ `npm` onboarding is unavailable.
   */
  ingestNpm?: (opts: { spec: string; scratchRoot: string }) => Promise<{
    package: string
    version: string
    packageRoot: string
    tsconfigPath: string
  }>
  /**
   * Clone + install (+ optionally build) a git repo into a scratch dir. Only
   * called for the `repo` source. `allowBuild` gates running the repo's build
   * script (arbitrary code). Omitted ⇒ `repo` onboarding is unavailable.
   */
  ingestRepo?: (opts: {
    url: string
    ref?: string
    subdir?: string
    scratchRoot: string
    allowBuild?: boolean
  }) => Promise<{
    package: string
    version: string
    packageRoot: string
    tsconfigPath: string
    commit?: string
  }>
  store: RegistryStore
  /** Injectable clock (ISO string). */
  now: () => string
}

interface Ingested {
  packageName: string
  packageRoot: string
  version: string
  tsconfigPath: string
  /** Prototype-relative package root when not at `node_modules/<pkg>` (npm). */
  entryPackageRootRel?: string
  /**
   * Prototype-relative tsconfig to PERSIST on the entry, when serving can't use
   * the prototype's own (npm scratch installs). Omitted for `installed`.
   */
  entryTsconfigRel?: string
  /** Full commit SHA from repo ingest (repo-kind sources only). */
  commit?: string
}

export async function onboardDesignSystem(
  req: OnboardRequest,
  deps: OnboardDeps,
  onProgress?: (stage: OnboardStage) => void,
): Promise<OnboardResult> {
  onProgress?.('ingesting')
  const { packageName, packageRoot, version, tsconfigPath, entryPackageRootRel, entryTsconfigRel, commit } =
    await ingest(req, deps)

  onProgress?.('detecting')
  const detection = deps.detectFramework(packageRoot)
  if (detection.framework === 'unknown') {
    throw new Error(
      `Couldn't detect a supported framework for '${packageName}'. It ships neither *.vue.d.ts (Vue) nor a resolvable React .d.ts types entry.`,
    )
  }
  const framework: FrameworkId = detection.framework

  // dtsRoots: Vue → the auto-scan's dtsRoot (relative); React → the detected
  // entry FILES, made package-root-relative (buildRegisteredSources resolves
  // them back). Either may be undefined → the extractor's default discovery.
  let dtsRoots: string[] | undefined
  if (detection.framework === 'vue3') {
    dtsRoots = [detection.dtsRoot]
  } else {
    // `r.startsWith('..')` alone would also drop a legally-named entry
    // file whose name happens to start with two dots (`..config.d.ts`) —
    // require the `..` + separator an actual escape carries (Task 14
    // review round-2 P2 audit; same bug class as `toRel` in
    // `agent-chat-sdk/edit-ack.ts`, found via the same grep).
    const rels = detection.entryFiles
      .map((f) => path.relative(packageRoot, f))
      .filter((r) => r && r !== '..' && !r.startsWith('..' + path.sep))
    if (rels.length > 0) dtsRoots = rels
  }

  const designSystem = req.designSystem ?? packageName
  const entry: RegisteredDesignSystem = {
    id: packageName, // one registration per package; re-onboarding replaces (refresh)
    source: req.source,
    package: packageName,
    version,
    framework,
    designSystem,
    importPath: packageName,
    ...(dtsRoots ? { dtsRoots } : {}),
    ...(entryPackageRootRel ? { packageRoot: entryPackageRootRel } : {}),
    ...(entryTsconfigRel ? { tsconfigPath: entryTsconfigRel } : {}),
    ...(commit ? { resolvedCommit: commit } : {}),
    // Persist the build consent so a later refresh can reuse it without
    // re-asking — only meaningful for `repo` sources (installed/npm never
    // run a build).
    ...(req.source.kind === 'repo' ? { allowBuild: req.allowBuild } : {}),
    addedAt: deps.now(),
  }

  onProgress?.('extracting')
  const source = deps.buildSource(entry, req.prototypeRoot, tsconfigPath)
  if (!source) {
    throw new Error(
      `Could not build a manifest source for '${packageName}' (no components discovered under its declarations).`,
    )
  }

  onProgress?.('computing-coverage')
  const coverage = await deps.computeCoverage(source)

  // Register only after a successful extraction so a broken add doesn't leave a
  // dangling registry entry that breaks serving.
  onProgress?.('registering')
  await deps.store.add(entry)

  return {
    package: packageName,
    version,
    framework,
    designSystem,
    importPath: packageName,
    coverage,
    registryEntryId: entry.id,
  }
}

/**
 * Where ingested packages are installed. An npm install or a git clone lands
 * here, so it goes through the `.desde` symlink guard like every other writer
 * under `.desde/` — a prototype that ships `.desde` as a link would otherwise
 * have a whole package tree written wherever the link points. Throws on a
 * symlinked `.desde`, which `ingest` reports the same way it reports every
 * other unusable source.
 */
function ingestScratchRoot(prototypeRoot: string): string {
  return desdePath(prototypeRoot, 'ingested')
}

/**
 * Step 1 of the spec algorithm: resolve the source into a concrete package on
 * disk + the tsconfig that resolves its types. `installed` reads node_modules +
 * the prototype tsconfig; `npm` installs into a hermetic scratch dir and uses
 * THAT install's own tsconfig (which resolves the package's deps).
 */
async function ingest(req: OnboardRequest, deps: OnboardDeps): Promise<Ingested> {
  if (req.source.kind === 'installed') {
    const packageName = req.source.package
    // Validate before it becomes a path: a name with `../` or separators would
    // make `path.join(..., 'node_modules', name)` escape node_modules and let a
    // crafted request read/persist entries for arbitrary paths.
    if (!isValidNpmPackageName(packageName)) {
      throw new Error(
        `Invalid package name '${packageName}'. Expected an npm package name (optionally scoped).`,
      )
    }
    const packageRoot = path.join(req.prototypeRoot, 'node_modules', packageName)
    const version = deps.resolvePackageVersion(packageRoot)
    if (!version) {
      throw new Error(
        `'${packageName}' is not installed in ${req.prototypeRoot}/node_modules (no readable package.json). Install it, then add it.`,
      )
    }
    const tsconfigPath = await deps.resolveTsconfig(req.prototypeRoot)
    if (!tsconfigPath) {
      throw new Error(
        `No tsconfig found under ${req.prototypeRoot}. The type extractor needs one to resolve component props.`,
      )
    }
    return { packageName, packageRoot, version, tsconfigPath }
  }

  if (req.source.kind === 'npm') {
    if (!deps.ingestNpm) {
      throw new Error('npm onboarding is not available (no ingest runner wired).')
    }
    const installed = await deps.ingestNpm({
      spec: req.source.spec,
      scratchRoot: ingestScratchRoot(req.prototypeRoot),
    })
    if (!isValidNpmPackageName(installed.package)) {
      throw new Error(`npm spec '${req.source.spec}' resolved to an invalid package name.`)
    }
    return {
      packageName: installed.package,
      packageRoot: installed.packageRoot,
      version: installed.version,
      tsconfigPath: installed.tsconfigPath,
      // The scratch package isn't at node_modules/<pkg> — record its real root
      // AND its own tsconfig so serving (build-registered-sources) can resolve +
      // re-extract it on a cache miss. The prototype's tsconfig can't see the
      // scratch package's deps.
      entryPackageRootRel: path.relative(req.prototypeRoot, installed.packageRoot),
      entryTsconfigRel: path.relative(req.prototypeRoot, installed.tsconfigPath),
    }
  }

  if (req.source.kind === 'repo') {
    if (!deps.ingestRepo) {
      throw new Error('repo onboarding is not available (no ingest runner wired).')
    }
    const installed = await deps.ingestRepo({
      url: req.source.url,
      ref: req.source.ref,
      subdir: req.source.subdir,
      scratchRoot: ingestScratchRoot(req.prototypeRoot),
      allowBuild: req.allowBuild,
    })
    if (!isValidNpmPackageName(installed.package)) {
      throw new Error(`repo '${req.source.url}' resolved to an invalid package name.`)
    }
    return {
      packageName: installed.package,
      packageRoot: installed.packageRoot,
      version: installed.version,
      tsconfigPath: installed.tsconfigPath,
      // Same as npm: the clone isn't at node_modules/<pkg> — persist its real
      // root + scratch tsconfig so serving re-extracts on a cache miss.
      entryPackageRootRel: path.relative(req.prototypeRoot, installed.packageRoot),
      entryTsconfigRel: path.relative(req.prototypeRoot, installed.tsconfigPath),
      ...(installed.commit ? { commit: installed.commit } : {}),
    }
  }

  throw new Error(`Unknown onboarding source kind: ${JSON.stringify(req.source)}`)
}

/**
 * npm package name shape (optionally `@scope/`), case-insensitive. Rejects path
 * separators, `..`, leading dots — anything that could escape `node_modules`.
 */
function isValidNpmPackageName(name: string): boolean {
  return /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)
}

/**
 * Wire the real adapters (lazy-imported) into {@link OnboardDeps} for one
 * prototype root. The API route (6.3b) calls this; tests inject fakes instead.
 */
export async function createDefaultOnboardDeps(prototypeRoot: string): Promise<OnboardDeps> {
  const [
    { detectFramework },
    { computeCoverage },
    { createLocalRegistryStore },
    { buildRegisteredSources },
    { discoverVueDtsComponents },
    { VueDtsMetaManifestSource },
    { discoverReactDtsEntries },
    { ReactDtsMetaManifestSource },
    { ingestNpmPackage },
    { ingestRepo },
    { CACHE_DIR_NAME, resolvePackageVersion, CachedManifestSource, fingerprintFile },
  ] = await Promise.all([
    import('./detect-framework'),
    import('./coverage'),
    import('./registry-store'),
    import('./build-registered-sources'),
    import('@/editor/adapters/vue-dts-meta/presets'),
    import('@/editor/adapters/vue-dts-meta'),
    import('@/editor/adapters/react-dts-meta/presets'),
    import('@/editor/adapters/react-dts-meta'),
    import('@/editor/ingest/npm-package'),
    import('@/editor/ingest/git-repo'),
    import('@/editor/adapters/cached'),
  ])
  const cacheDir = path.join(prototypeRoot, CACHE_DIR_NAME)

  return {
    detectFramework,
    resolvePackageVersion,
    // Shared with build-manifest-source.ts (serving) and repair-component.ts
    // (single-component re-extraction) — see resolve-tsconfig.ts (audit
    // Task 20 dedup). Keeps onboarding and serving agreeing on which
    // tsconfig anchors the TS checker, including the
    // EDITOR_PROTOTYPE_TSCONFIG override.
    resolveTsconfig,
    ingestNpm: async ({ spec, scratchRoot }) => {
      const r = await ingestNpmPackage({ spec, scratchRoot })
      return {
        package: r.package,
        version: r.version,
        packageRoot: r.packageRoot,
        tsconfigPath: r.tsconfigPath,
      }
    },
    ingestRepo: async ({ url, ref, subdir, scratchRoot, allowBuild }) => {
      const r = await ingestRepo({ url, ref, subdir, scratchRoot, allowBuild })
      return {
        package: r.package,
        // Fold the clone commit into the version so the manifest cache busts
        // when a mutable branch advances (package.json version often doesn't).
        version: r.commit ? `${r.version}+git.${r.commit.slice(0, 12)}` : r.version,
        packageRoot: r.packageRoot,
        tsconfigPath: r.tsconfigPath,
        ...(r.commit ? { commit: r.commit } : {}),
      }
    },
    buildSource: (entry, root, tsconfigPath) => {
      const { sources } = buildRegisteredSources({
        registry: [entry],
        prototypeRoot: root,
        tsconfigPath,
        cacheDir,
        deps: {
          discoverVueDtsComponents,
          VueDtsMetaManifestSource,
          discoverReactDtsEntries,
          ReactDtsMetaManifestSource,
          resolvePackageVersion,
          CachedManifestSource,
          fingerprintFile,
        },
      })
      return sources[0] ?? null
    },
    computeCoverage,
    store: createLocalRegistryStore(prototypeRoot),
    now: () => new Date().toISOString(),
  }
}
