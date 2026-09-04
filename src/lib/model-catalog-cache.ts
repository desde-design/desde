/**
 * The module-level cache for the chat model catalog, shared by the model
 * picker chip and the LLM credentials hook.
 *
 * `ModelPickerChip` fetches the catalog once per page-load and caches it
 * here so tab switches don't refetch. Saving, removing or toggling a
 * credential changes what the picker should offer, so the credentials hook
 * has to be able to throw the cache away — but a hook reaching into a
 * `src/components/editor/*` file to do that is the wrong direction (hooks
 * live in `/src/hooks`, components in `/src/components`), so the cache
 * itself lives here instead, and both sides import it. `model-picker-chip.tsx`
 * still owns and re-exports `invalidateModelCatalogCache` — this module is
 * its storage, not a second public entry point.
 */
import type { ProviderModelCatalog, SessionModelConfig } from "@/editor/core/model-catalog"

/**
 * The capability fields the chip reads, structurally.
 *
 * Declared here rather than imported from
 * `src/editor/llm-providers/provider-descriptor.ts` because this module ships
 * in the browser bundle and that directory reaches node-only code. It is a
 * SUBSET on purpose: the chip gates on nothing else today, and a structural
 * subset cannot go stale against the server's fuller record the way a
 * hand-copied full duplicate would.
 */
export interface ModelCatalogCapabilitiesLike {
  midTurnSteering: boolean
  vendorRateLimitEvents: boolean
}

export interface ModelCatalogResponse {
  catalogs: Array<ProviderModelCatalog & { capabilities?: ModelCatalogCapabilitiesLike }>
  default: SessionModelConfig
  /**
   * Which provider is THE default, per the server's own rule
   * (`resolveDefaultProviderId`) rather than array position. The chip does
   * not read this today — `catalog.default` already names the right pair —
   * but it is declared here so the response type matches what the server
   * actually sends, and so a future gate has it without another round-trip
   * through the server response shape.
   */
  defaultProviderId?: string
  /**
   * The model the user last chose in this project, already reconciled
   * server-side. `null` = no chat has ever carried a choice (or every
   * saved one is gone) → runtime default.
   */
  lastChosenModel?: SessionModelConfig | null
}

let catalogCache: ModelCatalogResponse | null = null

/**
 * Bumped on every `setCatalogCache`/`invalidateModelCatalogCache` call,
 * INCLUDING an invalidation that leaves `catalogCache` at `null` (a failed
 * first fetch never set it away from `null`, so invalidating it afterward
 * is a null-to-null "change").
 *
 * `ModelPickerChip`'s fetch effect used to key its retry off `catalogCache`
 * itself. After a failed fetch, `catalogCache` was already `null`; calling
 * `invalidateModelCatalogCache()` set it to `null` again, so
 * `useSyncExternalStore`'s snapshot was unchanged, React never re-rendered,
 * and the effect never reran — the chip stayed hidden forever after the
 * user saved a key, the exact case invalidation exists to fix. This counter
 * changes on every invalidation regardless of the cache's own value, so a
 * `useSyncExternalStore` subscription on it always sees the invalidation.
 */
let version = 0

export function getCatalogVersion(): number {
  return version
}

/**
 * What the user picked through the chip since the page loaded.
 *
 * MODULE scope, deliberately, and it has to match `catalogCache`'s lifetime
 * exactly — see `model-picker-chip.tsx`'s doc comment on `pickedThisLoad` for
 * why a `useRef` was the bug this fixed.
 */
let pickedThisLoad: SessionModelConfig | null = null

const listeners = new Set<() => void>()
function notify(): void {
  for (const listener of listeners) listener()
}

export function getCatalogCache(): ModelCatalogResponse | null {
  return catalogCache
}

/**
 * Sets the cache AND notifies subscribers — the chip reads `catalogCache`
 * through `useSyncExternalStore` (`getCatalogCache` is its own snapshot
 * getter), so a fetch landing here is what makes every mounted chip render
 * the fresh catalog, not just the one instance that fetched it.
 */
export function setCatalogCache(value: ModelCatalogResponse | null): void {
  catalogCache = value
  version += 1
  notify()
}

export function getPickedThisLoad(): SessionModelConfig | null {
  return pickedThisLoad
}

export function setPickedThisLoad(value: SessionModelConfig | null): void {
  pickedThisLoad = value
}

/**
 * Bumped ONLY by `invalidateModelCatalogCache` — the one event that means a
 * fetch already in flight is answering a question that no longer applies (a
 * credential save, remove, or dev-mode toggle changed what the catalog
 * should be). `version` above bumps on every write, including an ordinary
 * successful one, because `useSyncExternalStore` needs a change signal even
 * for a null-to-null invalidation (see its doc comment). `setCatalogCacheIfVersion`
 * used to gate on `version` for that same counter, which meant two chips
 * fetching concurrently would discard the SECOND one's write purely because
 * the first one's write had already bumped `version` — not because
 * anything about the catalog had actually gone stale. `epoch` is the
 * narrower signal: it only moves when the answer a fetch was chasing has
 * actually changed underneath it.
 */
let epoch = 0

export function getCatalogEpoch(): number {
  return epoch
}

/**
 * Sets the cache only when `epoch` still equals `expectedEpoch`. A write
 * carrying a stale epoch is discarded instead of applied.
 *
 * This closes a race the plain `setCatalogCache` cannot: a catalog fetch can
 * still be in flight when `invalidateModelCatalogCache()` runs (the user
 * saved a credential while the picker's first fetch was still pending). If
 * the fetch's continuation is queued before the invalidation and happens to
 * run after it in the same microtask drain, a plain `setCatalogCache(body)`
 * would repopulate the cache with the PRE-invalidation catalog. The rerender
 * this causes then sees a non-null cache and never issues the refetch —
 * exactly the case invalidation exists to trigger. The caller captures
 * `getCatalogEpoch()` when the fetch starts and passes it back here; if
 * `invalidateModelCatalogCache()` bumped the epoch in between, this no-ops
 * and the stale body is dropped on the floor. A second fetch that started
 * at the same epoch as a first one that already landed is NOT stale by this
 * rule, even though `version` moved when that first write applied — the
 * question both fetches were answering never changed.
 */
export function setCatalogCacheIfVersion(
  expectedEpoch: number,
  value: ModelCatalogResponse | null,
): void {
  if (epoch !== expectedEpoch) return
  setCatalogCache(value)
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeCatalogCache(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/**
 * Forget the cached catalog and this-page-load pick. Called by
 * `useLlmCredentials` after a key save, key remove, or dev-mode toggle
 * succeeds — the mounted chip(s) see `catalog` go back to `null` (through
 * the same `useSyncExternalStore` subscription `setCatalogCache` notifies),
 * refetch, and a value the fresh catalogs no longer serve reconciles to the
 * runtime default the same way a stale persisted config already does.
 */
export function invalidateModelCatalogCache(): void {
  catalogCache = null
  pickedThisLoad = null
  version += 1
  epoch += 1
  notify()
}
