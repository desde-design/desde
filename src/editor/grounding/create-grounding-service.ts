/**
 * Composition root for {@link GroundingService}.
 *
 * Assembles the three grounding seams over the existing, already-cached
 * builders — it does NOT reimplement caching:
 *   - manifest  → `buildManifestSource` (heavy; lazy-memoized here)
 *   - tokens    → `DeferredDesignTokenSource` over `buildDesignTokenSources`
 *     (the SAME pinned token-source builder `loadDesignTokens` uses — see
 *     `edit-service/design-tokens-source.ts`)
 *   - knowledge → `loadCachedProjectKnowledge` (process-cached by realpath)
 *
 * Lives under `src/editor/` (not the CLI) so the same factory backs both the
 * inspector endpoints (via the CLI's memoized `getGroundingService`) and the
 * agent's grounding tools — one source of truth, two consumers.
 */
import type { ComponentManifestSource, GroundingHealth, GroundingService } from '../core'
import { DeferredDesignTokenSource } from '../edit-service/design-tokens-source'
import { buildManifestSource } from '../edit-service/build-manifest-source'
import { loadCachedProjectKnowledge } from '../edit-service/load-project-knowledge'

export interface CreateGroundingServiceOptions {
  /** Canonical prototype root — where `node_modules` + conventions live. */
  root: string
  /** Repo-relative POSIX paths to exclude from project-knowledge discovery. */
  excludeFiles?: readonly string[]
}

export function createGroundingService(
  opts: CreateGroundingServiceOptions,
): GroundingService {
  const { root, excludeFiles } = opts

  // Same pinned token-source builder `loadDesignTokens` uses, wrapped in a
  // `DeferredDesignTokenSource` so this stays synchronous (`buildDesignTokenSources`
  // is async — it discovers stylesheets before composing). Default composite
  // error handling: a bad source (an unreadable stylesheet) is warned + skipped,
  // never blanks the rest.
  const tokens = new DeferredDesignTokenSource(root)

  // Building the composite manifest (Volar program for first-party extraction)
  // is expensive, so defer to first use and reuse for the process lifetime. A
  // failed build drops the cached rejection so the next request retries —
  // parity with the memoization the manifest handler used to own.
  //
  // `manifestPromise` carries the `{ source, health }` bundle (the memoized
  // slot); `sourceOnlyPromise` is derived from it ONCE, at the same time, so
  // `getManifestSource()` keeps returning the SAME promise object on repeat
  // calls (tests assert reference equality) instead of a fresh `.then()`
  // wrapper each time. `built` is set as a side effect of `manifestPromise`
  // resolving, so `getGroundingHealth()` never needs to await a build.
  let manifestPromise: Promise<{
    source: ComponentManifestSource
    health: GroundingHealth
  } | null> | null = null
  let sourceOnlyPromise: Promise<ComponentManifestSource | null> | null = null
  let built: { source: ComponentManifestSource; health: GroundingHealth } | null = null

  return {
    getManifestSource(): Promise<ComponentManifestSource | null> {
      if (!manifestPromise) {
        manifestPromise = buildManifestSource(root)
          .then((result) => {
            built = result
            return result
          })
          .catch((err) => {
            manifestPromise = null
            sourceOnlyPromise = null
            throw err
          })
        sourceOnlyPromise = manifestPromise.then((result) => result?.source ?? null)
      }
      return sourceOnlyPromise as Promise<ComponentManifestSource | null>
    },
    tokens,
    getProjectKnowledge() {
      return loadCachedProjectKnowledge({ prototypeRoot: root, excludeFiles })
    },
    async getGroundingHealth(): Promise<GroundingHealth | null> {
      return built?.health ?? null
    },
  }
}
