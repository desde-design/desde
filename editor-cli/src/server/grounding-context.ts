/**
 * Process-memoized {@link GroundingService} for the CLI HTTP server.
 *
 * One service instance per canonical root, shared by the manifest + catalog +
 * design-tokens endpoints (and the agent's grounding tools, once wired). This
 * is where the memoization the manifest handler used to own now lives — lifted
 * up from "manifest source" to the whole grounding bundle, so every grounding
 * consumer reads the SAME sources.
 *
 * The factory lives in `src/editor/` and is loaded via a DI loader (mirrors
 * the `applicatorLoaders` / `designTokensLoaders` pattern) so tests can inject
 * a stub service without touching the build boundary.
 */
import type { GroundingService } from "../../../src/editor/core"

export interface GroundingLoaders {
  loadCreateGroundingService: () => Promise<
    typeof import("../../../src/editor/grounding/create-grounding-service.js")
  >
  /**
   * Sink for the one-line `[grounding] …` boot summary (see
   * {@link getGroundingService}). Defaults to `console.log`; tests inject a
   * capturing function instead.
   */
  logger?: (msg: string) => void
}

export const defaultGroundingLoaders: GroundingLoaders = {
  loadCreateGroundingService: () =>
    import("../../../src/editor/grounding/create-grounding-service.js"),
}

let cached: Promise<GroundingService> | null = null
let cachedRoot: string | null = null
// Guards the boot-summary log line so it fires once per process (per
// memoized service), not once per request/caller. Reset alongside the memo.
let loggedBootSummary = false

/**
 * Resolve the memoized GroundingService for `canonicalRoot`. A failed
 * construction is NOT cached (the promise is cleared) so a transient error
 * doesn't wedge the grounding endpoints for the rest of the session.
 */
export async function getGroundingService(
  canonicalRoot: string,
  loaders: GroundingLoaders = defaultGroundingLoaders,
): Promise<GroundingService> {
  if (cached && cachedRoot === canonicalRoot) return cached
  cachedRoot = canonicalRoot
  loggedBootSummary = false
  const logger = loaders.logger ?? console.log
  cached = (async () => {
    const { createGroundingService } = await loaders.loadCreateGroundingService()
    const service = createGroundingService({ root: canonicalRoot })
    return withBootSummaryLog(service, canonicalRoot, logger)
  })().catch((err) => {
    cached = null
    cachedRoot = null
    throw err
  })
  return cached
}

/**
 * Wraps `getManifestSource()` so that after its FIRST successful resolution
 * (per memoized service), the health report — if one was built — is logged
 * as a single `[grounding] <n> sources, <k> skipped, <e> failed — <root>`
 * line. `n`/`k`/`e` come from `getGroundingHealth()`'s source statuses; `e`
 * also folds in `runtimeErrors`. A `null` health (nothing built yet) logs
 * nothing — there is no summary to report.
 *
 * `loggedBootSummary` is reserved synchronously (set `true` immediately after
 * the `!loggedBootSummary` check, before awaiting `getGroundingHealth()`) so
 * two `getManifestSource()` calls racing concurrently — realistic on cold
 * boot, when the manifest and catalog endpoints fire at once — can't both
 * pass the check before either sets the flag and both log a line.
 */
function withBootSummaryLog(
  service: GroundingService,
  root: string,
  logger: (msg: string) => void,
): GroundingService {
  return {
    ...service,
    async getManifestSource() {
      const result = await service.getManifestSource()
      if (!loggedBootSummary) {
        // Reserve synchronously (before the `await` below) so two concurrent
        // calls racing past the check above can't both fall through: JS
        // guarantees this synchronous section runs to completion before any
        // other continuation of this same function can observe the flag, so
        // only the winner proceeds to fetch health and log.
        loggedBootSummary = true
        const health = await service.getGroundingHealth()
        if (health) {
          const ok = health.sources.filter((s) => s.status === "ok").length
          const skipped = health.sources.filter((s) => s.status === "skipped").length
          const failed =
            health.sources.filter((s) => s.status === "failed").length +
            health.runtimeErrors.length
          logger(`[grounding] ${ok} sources, ${skipped} skipped, ${failed} failed (${root})`)
        }
      }
      return result
    },
  }
}

/** What warming the memo did. Diagnostic only; nothing branches on it. */
export type GroundingMemoWarmResult =
  | { ok: true; ms: number }
  | { ok: false; reason: string; ms: number }

/**
 * Build the composite manifest source into the memo, ahead of any request.
 *
 * This is the ASYNC half of a cold start only: the file walk, the import
 * index and the per-library discovery, ~1.4s of I/O on a shadcn repo. It
 * deliberately never calls `listComponents()`: each library source extracts
 * on first touch, and that extraction is synchronous checker work that
 * would freeze this process (and with it the Editor page loading in the
 * browser) for the ~10-20s it takes. The extraction is warmed out of
 * process instead, see `manifest-prewarm.ts`, and lands on disk as cache
 * files; the composite built here reads those on the first click.
 *
 * Goes through the SAME memoized service the routes read, so a request that
 * arrives mid-build joins it rather than starting a second one. Never
 * throws: a failed construction is not memoized (see
 * {@link getGroundingService}), so the first request retries on its own.
 */
export async function warmGroundingMemo(
  canonicalRoot: string,
  loaders: GroundingLoaders = defaultGroundingLoaders,
): Promise<GroundingMemoWarmResult> {
  const logger = loaders.logger ?? console.log
  const startedAt = Date.now()
  try {
    const grounding = await getGroundingService(canonicalRoot, loaders)
    const source = await grounding.getManifestSource()
    const ms = Date.now() - startedAt
    if (!source) {
      logger(`[grounding] no manifest source for ${canonicalRoot}`)
      return { ok: false, reason: "no manifest source", ms }
    }
    return { ok: true, ms }
  } catch (err) {
    const ms = Date.now() - startedAt
    const reason = err instanceof Error ? err.message : String(err)
    logger(
      `[grounding] building the manifest source failed (non-fatal, the first selection retries): ${reason}`,
    )
    return { ok: false, reason, ms }
  }
}

/** Reset the memoized service. Exported for tests. */
export function resetGroundingCache(): void {
  cached = null
  cachedRoot = null
  loggedBootSummary = false
}
