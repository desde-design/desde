/**
 * `CachedManifestSource` — the *persist* layer of design-system onboarding
 * (see `tasks/design-system-manifest-onboarding.md`).
 *
 * Wraps any `ComponentManifestSource` and persists its extracted manifests
 * to a version-keyed JSON artifact on disk, so the expensive extraction —
 * notably the `vue-dts-meta` TS-checker walk, which builds a `ts.Program`
 * over a library's `.vue.d.ts` files (≈1s for `@acme/icons`'s 530
 * components) — runs once per `package@version`, not on every CLI boot.
 *
 * Cache key = `<key>@<version>[@<context>]@<extractorVersion>.json`. The
 * version comes from the installed package's `package.json`, so bumping the
 * library invalidates automatically (different filename → miss →
 * re-extract). `context` is an optional caller-supplied fingerprint of any
 * *other* input the extraction depends on — for the `vue-dts-meta`
 * extractor, a hash of the active tsconfig, since its compilerOptions /
 * module resolution feed the checker. `EXTRACTOR_VERSION` invalidates the
 * whole cache when *our* extraction / normalization output shape changes,
 * so a tool upgrade never serves stale manifests.
 *
 * Known invalidation gaps — deep inputs that can change extraction output
 * without changing any tracked signal: the target library's *transitive*
 * type dependencies (no `package.json` version bump), and any tsconfig the
 * active one `extends` (the `context` fingerprint hashes only the resolved
 * tsconfig file's own bytes, not its extends chain). Both would require
 * hashing the fully-resolved type graph / config chain, which isn't worth
 * the cost for a local optimization. Recover by bumping `EXTRACTOR_VERSION`
 * or clearing the cache dir.
 *
 * Design notes:
 * - Transparent: same `id` / `framework` / `designSystem` / results as the
 *   inner source. Wrapping is behavior-preserving except for speed.
 * - I/O-tolerant: an unreadable, corrupt, or schema-mismatched cache file
 *   is ignored (re-extract); a failed write is non-fatal (serve from the
 *   inner source). The cache is an optimization, never a correctness
 *   dependency.
 * - Empty extractions are NOT persisted — a transient failure (e.g. a
 *   missing tsconfig) returning zero manifests must not be frozen in until
 *   the next version bump; the next boot retries.
 * - General: works for any source, not just `vue-dts-meta`. First-party
 *   SFC sources are intentionally NOT cached at the call site (their inputs
 *   change as the user edits) — caching is opt-in by the builder.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { desdePathOrNull } from '../../worktree/desde-dir'
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'

/**
 * Bump when the extraction/normalization output shape changes in a way
 * that should invalidate all on-disk caches (e.g. a new prop schema field,
 * a control-classification fix). Independent of any library's version.
 *
 * Bump it for a change in WHAT gets extracted too, not only the shape —
 * discovery and naming count. Missing that is silent by construction: the
 * fix works on a cold cache and the author measures it that way, while every
 * existing prototype keeps serving the stale manifests forever because the
 * key never changed. That is exactly how v1 shipped a Nuxt UI collision fix
 * (Badge 1 prop -> 13, the real component un-shadowed) that no existing user
 * would ever have seen.
 *
 * v2 (2026-08-10): barrel-layout dts discovery (`<dir>/index.d.ts` beside a
 * sibling `<Name>.vue`), collision qualification instead of silent shadowing,
 * and cva variant extraction for React.
 */
export const EXTRACTOR_VERSION = 2

/** Subdir under the prototype root where caches live. */
export const CACHE_DIR_NAME = '.desde/manifests'

/**
 * `<prototypeRoot>/.desde/manifests`, through the `.desde` guard, or `null`
 * when `.desde` (or `manifests` under it) is a symbolic link.
 *
 * Every caller that used to `join(root, CACHE_DIR_NAME)` builds the path
 * here instead, because a plain join follows a hostile symlink and drops
 * the cache outside the working tree. Non-throwing on purpose: this runs on
 * the serving and onboarding paths, and the cache is an optimization —
 * `null` disables caching for that run (extraction still happens) rather
 * than failing manifest serving outright.
 */
export function manifestCacheDir(prototypeRoot: string): string | null {
  return desdePathOrNull(prototypeRoot, 'manifests')
}

/**
 * Resolve a package's installed version by reading its `package.json`.
 * Returns `null` when the file is missing, unreadable, or has no
 * `version` field — caller should treat the cache as disabled for
 * that package on this run.
 */
export function resolvePackageVersion(packageRoot: string): string | null {
  const pkgJson = join(packageRoot, 'package.json')
  if (!existsSync(pkgJson)) return null
  try {
    const data = JSON.parse(readFileSync(pkgJson, 'utf8')) as {
      version?: unknown
    }
    return typeof data.version === 'string' && data.version.length > 0
      ? data.version
      : null
  } catch {
    return null
  }
}

/**
 * Resolve the version a design-system entry's hints-cache file must be
 * keyed/looked-up under — the ONE rule shared by the reader
 * (`build-manifest-source.ts`'s `hintsCacheEntries`, which builds the key a
 * `HintsCacheManifestSource` looks a file up under) and the writer
 * (`design-systems-handler.ts`'s `generate-hints` route, which builds the
 * key a run WRITES the file under). The two MUST agree, or a
 * `generate-hints` run following an un-refreshed `npm install` upgrade
 * writes a file under a version the reader never looks under (M1 follow-up,
 * commit 8ee6ef8a fixed the reader; this closes the writer side).
 *
 * An entry WITHOUT a `packageRoot` override lives at
 * `node_modules/<package>` and can be upgraded by a plain `npm install`
 * without the user ever hitting the explicit `/refresh` route — its
 * recorded `entry.version` is only an onboard-time snapshot, so re-resolve
 * the CURRENTLY installed version, falling back to `entry.version` only
 * when that resolution fails (package missing/unreadable). An entry WITH a
 * `packageRoot` override (npm/repo-ingested) has no live `node_modules`
 * install to re-check — its scratch materialization at onboard/refresh time
 * IS the record, so `entry.version` stays authoritative.
 */
export function resolveHintsCacheVersion(
  realRoot: string,
  entry: { package: string; version: string; packageRoot?: string },
): string {
  if (entry.packageRoot) return entry.version
  return resolvePackageVersion(join(realRoot, 'node_modules', entry.package)) ?? entry.version
}

/** sha1 of a file's bytes for cache `context` fingerprints; '' on failure. */
export function fingerprintFile(file: string): string {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return ''
  }
}

interface CacheFile {
  /** On-disk format version. */
  schema: 1
  extractorVersion: number
  sourceId: string
  packageVersion: string
  /** Fingerprint of other extraction inputs (e.g. tsconfig); '' if none. */
  context: string
  manifests: ComponentManifest[]
}

/**
 * Read + validate a cache file's raw shape, synchronously. Shared by
 * {@link readCachedComponent} and {@link patchCachedComponent} — both need
 * the same "is this file even a cache file we can trust" gate as the
 * class's own (async) `readCache`, minus the per-instance `packageVersion`/
 * `context`/`sourceId` comparison (those callers have a whole
 * `CachedManifestSource` to compare against; these two operate on a bare
 * path handed to them by `repairComponent`, which already picked the path
 * it wants by construction — filename IS the key/version/context match).
 * Returns `null` on any missing/unreadable/unparseable/schema-mismatched
 * file — never throws.
 */
function readCacheFileSync(cacheFile: string): CacheFile | null {
  let text: string
  try {
    text = readFileSync(cacheFile, 'utf8')
  } catch {
    return null // missing/unreadable → treat as no cache
  }
  try {
    const parsed = JSON.parse(text) as Partial<CacheFile>
    if (
      parsed.schema !== 1 ||
      parsed.extractorVersion !== EXTRACTOR_VERSION ||
      !Array.isArray(parsed.manifests)
    ) {
      return null // stale schema / corrupt → treat as no cache
    }
    return parsed as CacheFile
  } catch {
    return null // unparseable → treat as no cache
  }
}

/**
 * Read one component's manifest out of an existing on-disk cache file,
 * without loading/deserializing it into a `CachedManifestSource` instance.
 * Used by `repairComponent` (Phase 5 Task 4 of the grounding drift plan) to
 * compare a freshly re-extracted manifest against what's cached before
 * deciding whether a patch is actually needed (`unchanged` vs `repaired`).
 *
 * Returns `null` when the file is missing/corrupt, or doesn't contain
 * `componentName` — synchronous and best-effort, same posture as the rest
 * of this module (never throws).
 */
export function readCachedComponent(
  cacheFile: string,
  componentName: string,
): ComponentManifest | null {
  const file = readCacheFileSync(cacheFile)
  if (!file) return null
  return file.manifests.find((m) => m.name === componentName) ?? null
}

/**
 * Replace ONE component's manifest inside an existing on-disk cache file,
 * preserving every other component entry and every other file-level field
 * (`packageVersion` / `context` / `sourceId` / `extractorVersion`)
 * byte-identical. Appends the entry when `manifest.name` wasn't already
 * present — a repair can legitimately add a component the original
 * extraction missed (e.g. a `.vue.d.ts` that failed to parse the first
 * time and was silently skipped).
 *
 * Same atomic tmp+rename discipline as the class's private `writeCache`
 * (a concurrent reader never observes a torn/partial JSON), and the same
 * missing/corrupt-file gate as `readCache` — returns `false`, never
 * throws, and never writes, when the file can't be read+validated OR the
 * write itself fails. This is the ONE read-modify-write path onto an
 * existing cache artifact; every other write in this module
 * (`writeCache`) replaces the WHOLE array from a fresh extraction.
 *
 * Synchronous by design (unlike the class's async read/write path): this
 * runs once, off any request's hot path, triggered by a single drift
 * repair — there's no concurrent-request pressure here to justify async
 * I/O, and a plain boolean return keeps `repairComponent`'s call site
 * simple (no extra `await`-then-check ceremony beyond what it already has
 * for the async re-extract itself).
 *
 * Caller's responsibility: pick a `cacheFile` that already matches the
 * package/version/context this manifest belongs to (i.e., the same
 * filename `CachedManifestSource` would derive for that package) — this
 * function does not verify that, since it has no instance-level
 * expectations to check against.
 */
export function patchCachedComponent(cacheFile: string, manifest: ComponentManifest): boolean {
  const file = readCacheFileSync(cacheFile)
  if (!file) return false

  const idx = file.manifests.findIndex((m) => m.name === manifest.name)
  const manifests =
    idx >= 0
      ? file.manifests.map((m, i) => (i === idx ? manifest : m))
      : [...file.manifests, manifest]
  const payload: CacheFile = { ...file, manifests }

  try {
    mkdirSync(dirname(cacheFile), { recursive: true })
    // Unique temp file + rename, same as `writeCache` — a second process
    // reading concurrently never sees a torn/partial JSON.
    const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, cacheFile)
    return true
  } catch {
    return false
  }
}

export interface CachedManifestSourceOptions {
  /** The source whose extraction is being cached. */
  inner: ComponentManifestSource
  /**
   * Absolute directory for cache artifacts
   * (e.g. `<prototype-root>/.desde/manifests`). Created on first write.
   */
  cacheDir: string
  /** Stable cache-key stem — typically the sanitized package name. */
  key: string
  /** Installed package version; a change re-keys (invalidates) the cache. */
  version: string
  /**
   * Optional fingerprint of any *other* input the extraction depends on
   * (e.g. a hash of the active tsconfig for checker-backed sources). A
   * change re-keys the cache. Omit when the package version is the only
   * input.
   */
  context?: string
  /**
   * Optional observer invoked once per `load()` with `'hit'` when the
   * on-disk cache satisfied the request, or `'miss'` when extraction ran.
   * Best-effort instrumentation only — never affects control flow.
   */
  onCacheEvent?: (event: 'hit' | 'miss') => void
}

/**
 * Make a string safe as a single filesystem path segment. Exported so
 * sibling cache-key builders (e.g. `hints-cache/index.ts`'s
 * `hintCacheFilePath`) reuse the exact same sanitization instead of
 * duplicating it.
 */
export function sanitize(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'x'
}

export class CachedManifestSource implements ComponentManifestSource {
  readonly id: string
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly inner: ComponentManifestSource
  private readonly cacheFile: string
  private readonly version: string
  private readonly context: string
  private readonly onCacheEvent?: (event: 'hit' | 'miss') => void
  private loaded: Promise<Map<string, ComponentManifest>> | null = null

  constructor(options: CachedManifestSourceOptions) {
    this.inner = options.inner
    this.id = options.inner.id
    this.framework = options.inner.framework
    this.designSystem = options.inner.designSystem
    this.version = options.version
    this.context = options.context ?? ''
    this.onCacheEvent = options.onCacheEvent
    const ctx = this.context ? `@${sanitize(this.context)}` : ''
    this.cacheFile = join(
      options.cacheDir,
      `${sanitize(options.key)}@${sanitize(options.version)}${ctx}@v${EXTRACTOR_VERSION}.json`,
    )
  }

  async listComponents(): Promise<ComponentManifest[]> {
    return Array.from((await this.ensure()).values())
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    return (await this.ensure()).get(name) ?? null
  }

  invalidate(): void {
    this.loaded = null
    ;(this.inner as { invalidate?: () => void }).invalidate?.()
  }

  /** Single-flight: read the cache, else extract via inner and persist. */
  private ensure(): Promise<Map<string, ComponentManifest>> {
    if (!this.loaded) this.loaded = this.load()
    return this.loaded
  }

  private async load(): Promise<Map<string, ComponentManifest>> {
    const cached = await this.readCache()
    if (cached) {
      this.onCacheEvent?.('hit')
      return toMap(cached)
    }
    this.onCacheEvent?.('miss')

    const manifests = await this.inner.listComponents()
    // Don't freeze a transient empty extraction; let the next boot retry.
    if (manifests.length > 0) await this.writeCache(manifests)
    return toMap(manifests)
  }

  private async readCache(): Promise<ComponentManifest[] | null> {
    let text: string
    try {
      text = await fs.readFile(this.cacheFile, 'utf8')
    } catch {
      return null // missing → miss
    }
    try {
      const parsed = JSON.parse(text) as Partial<CacheFile>
      if (
        parsed.schema !== 1 ||
        parsed.extractorVersion !== EXTRACTOR_VERSION ||
        parsed.packageVersion !== this.version ||
        parsed.context !== this.context ||
        parsed.sourceId !== this.id ||
        !Array.isArray(parsed.manifests)
      ) {
        return null // stale / corrupt → miss, re-extract
      }
      return parsed.manifests
    } catch {
      return null // unparseable → miss
    }
  }

  private async writeCache(manifests: ComponentManifest[]): Promise<void> {
    const payload: CacheFile = {
      schema: 1,
      extractorVersion: EXTRACTOR_VERSION,
      sourceId: this.id,
      packageVersion: this.version,
      context: this.context,
      manifests,
    }
    try {
      await fs.mkdir(dirname(this.cacheFile), { recursive: true })
      // Write to a unique temp file then atomically rename, so a second
      // process reading concurrently never sees a torn/partial JSON.
      const tmp = `${this.cacheFile}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8')
      await fs.rename(tmp, this.cacheFile)
    } catch {
      // Non-fatal: caching is an optimization, not a correctness dependency.
    }
  }
}

function toMap(manifests: ComponentManifest[]): Map<string, ComponentManifest> {
  const map = new Map<string, ComponentManifest>()
  for (const m of manifests) map.set(m.name, m)
  return map
}
