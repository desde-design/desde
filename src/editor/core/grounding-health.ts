/**
 * `GroundingHealth` — a diagnostic report over how the manifest bundle for a
 * prototype root was assembled: which of `MANIFEST_SOURCE_ORDER`'s steps
 * contributed sources, which were skipped and why, and any runtime error a
 * source threw after construction (surfaced by `CompositeManifestSource`'s
 * `onSourceError`).
 *
 * Framework-neutral by design: this module imports nothing from
 * `src/editor/adapters/*` — only string ids and counts, so it stays usable
 * from `core` without pulling in Vue/React/Vite specifics. The editor/
 * onboarding surfaces that DO know about concrete sources (
 * `src/editor/edit-service/build-manifest-source.ts`,
 * `src/editor/onboarding/build-registered-sources.ts`) populate it via
 * `HealthCollector`.
 */

/** Health of one manifest source constructed while building the bundle. */
export interface SourceHealthEntry {
  /** Which `MANIFEST_SOURCE_ORDER` step produced this entry. */
  step: string
  sourceId: string
  packageName?: string
  /** Items known at construction (discovered components/files); extraction may differ. */
  discovered: number
  cache?: 'hit' | 'miss'
  status: 'ok' | 'skipped' | 'failed'
  reason?: string
}

/** A source that threw after construction, surfaced via `onSourceError`. */
export interface GroundingRuntimeError {
  sourceId: string
  method: string
  message: string
  at: string
}

/** Full health report for one build of the composite manifest source. */
export interface GroundingHealth {
  root: string
  builtAt: string
  sources: SourceHealthEntry[]
  runtimeErrors: GroundingRuntimeError[]
}

/**
 * Accumulates a `GroundingHealth` report while a manifest bundle is built.
 * `record()` returns the stored (mutable) entry so a caller that learns more
 * about a source AFTER recording it (e.g. `CachedManifestSource`'s
 * `onCacheEvent`, fired the first time the source is actually read) can patch
 * the same entry in place rather than re-recording it.
 */
export interface HealthCollector {
  readonly health: GroundingHealth
  /** Appends `entry` to `health.sources` and returns the stored copy. */
  record(entry: SourceHealthEntry): SourceHealthEntry
  /** Appends a runtime error, stringifying `error` (Error or not). */
  recordRuntimeError(sourceId: string, method: string, error: unknown): void
}

export function createHealthCollector(root: string): HealthCollector {
  const health: GroundingHealth = {
    root,
    builtAt: new Date().toISOString(),
    sources: [],
    runtimeErrors: [],
  }

  return {
    health,
    record(entry: SourceHealthEntry): SourceHealthEntry {
      // Copy so a caller mutating the entry it was handed can't accidentally
      // alias a shared literal — the returned value IS the stored value.
      const stored: SourceHealthEntry = { ...entry }
      health.sources.push(stored)
      return stored
    },
    recordRuntimeError(sourceId: string, method: string, error: unknown): void {
      const message = error instanceof Error ? error.message : String(error)
      health.runtimeErrors.push({
        sourceId,
        method,
        message,
        at: new Date().toISOString(),
      })
    },
  }
}
