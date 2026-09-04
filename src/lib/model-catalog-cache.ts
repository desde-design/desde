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
  notify()
}

export function getPickedThisLoad(): SessionModelConfig | null {
  return pickedThisLoad
}

export function setPickedThisLoad(value: SessionModelConfig | null): void {
  pickedThisLoad = value
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
  notify()
}
