/**
 * Shell-side adapter that wraps a `ComponentManifestSource` (the
 * existing manifest registry consumed by the inspector via
 * `RemoteManifestSource`) as a synchronous `ManifestLookup` for the
 * attribution function.
 *
 * Why synchronous: `attribute()` is a pure function that runs once
 * per click and shouldn't await any I/O. The manifest source is
 * async (HTTP fetch over /api/editor/manifest), so we resolve
 * lookups against a pre-warmed cache. The shell populates the cache
 * by calling `prefetch()` ahead of attribution — typically on
 * inspection (when the bridge tells us which components are in the
 * chain).
 *
 * Cache shape: a Map keyed by `${name}@${importPath ?? ''}` with a
 * value of `ComponentManifest | null` (null = "looked up, not
 * found"). The null sentinel matters so we don't refetch on every
 * call for components we've already determined have no manifest.
 */

import type { ComponentManifest, ComponentManifestSource } from '../core'
import { isIdentifyingComponentName, type ManifestLookup } from './types'

const NOT_FOUND_SENTINEL = null

export class CachedManifestLookup implements ManifestLookup {
  private readonly cache = new Map<string, ComponentManifest | null>()
  /**
   * Secondary index keyed by component name only (no importPath),
   * holding the most-recently-cached NON-NULL manifest for that name.
   * Backs name-only fallback in `getByName`.
   *
   * Why this exists: the bridge populates `importPath` from the Vue
   * instance's `__file`, but library bundles (Acme DS, etc.) are
   * shipped pre-compiled WITHOUT `__file`, so the runtime chain entry
   * for `<UiLabel>` has no importPath. The shell, however, prefetches
   * library manifests WITH a known importPath (`@acme/design-system`).
   * That asymmetry would make every library lookup miss if the cache
   * key were strictly `name@importPath`. `readImportPath` in
   * build-attribution-context.ts documents the intended contract:
   * "the shell-side registry lookup falls back to name-only resolution"
   * when importPath is unknown. This index implements that fallback.
   */
  private readonly byName = new Map<string, ComponentManifest>()
  /**
   * In-flight promises per key. When two prefetch calls (or
   * duplicate entries in one call) target the same key, the second
   * awaits the first's promise instead of starting another fetch.
   * Entries are removed after the fetch settles; the result lands
   * in `cache` (on success) or nothing (on failure — retried on
   * next prefetch).
   */
  private readonly inFlight = new Map<string, Promise<void>>()
  /**
   * Keys whose most recent `fetchOne` attempt threw (network error, 5xx,
   * etc.) rather than resolving. Load-bearing for the inspection-time drift
   * call site (`useEditorEditing`'s selection-change handler): `getByName`
   * returning `null` is ambiguous between "confirmed no manifest for this
   * component" (the source resolved and said so) and "we never found out"
   * (the fetch itself failed) — both leave the key absent from `cache`.
   * `detectUnknownComponent` fires on `owningManifest === null` alone, so
   * without this distinction a transient fetch failure would read as a
   * confirmed catalog miss and falsely report `unknown-component` on the
   * very first click of a session (before any prior successful prefetch
   * warmed the cache). `hasFailedFetch` lets a caller gate that one signal
   * on "did we actually resolve this, or just fail to find out." Cleared on
   * a later successful fetch for the same key and by `invalidate`.
   */
  private readonly failedKeys = new Set<string>()

  constructor(private readonly source: ComponentManifestSource) {}

  /**
   * Synchronous lookup used by `attribute()`. Returns the cached
   * manifest if `prefetch` has populated the entry, or null
   * otherwise — callers MUST prefetch the relevant component names
   * before attribution; an un-prefetched name returns null and
   * attribution will refuse for that entry.
   *
   * Returning null on cache-miss (rather than throwing) is deliberate:
   * attribution must always produce a result; "no manifest" maps to
   * the existing `refuse` path with a useful diagnostic.
   */
  /**
   * Did the most recent fetch attempt for this key FAIL (as opposed to
   * resolving — successfully or with a confirmed miss)? See the
   * `failedKeys` field doc comment for why this distinction exists and
   * who depends on it. Returns `false` for a key that's still in flight or
   * was never requested — those aren't "failed," they're "not yet known,"
   * and a caller gating on this should treat them the same as a genuine
   * miss (the pre-existing behavior everywhere except the one call site
   * this exists for).
   */
  hasFailedFetch(name: string, importPath?: string): boolean {
    return this.failedKeys.has(keyFor(name, importPath))
  }

  getByName(name: string, importPath?: string): ComponentManifest | null {
    if (importPath !== undefined) {
      // Explicit importPath is a request for THAT library's component
      // contract. Resolve against the exact key only — a miss returns
      // NOT_FOUND rather than falling back to a same-named manifest
      // from a different source. Falling back would misattribute the
      // edit to the wrong component (name-collision / out-of-order
      // prefetch). This also preserves collision disambiguation when
      // two libraries' same-named components are both prefetched with
      // distinct importPaths.
      return this.cache.get(keyFor(name, importPath)) ?? NOT_FOUND_SENTINEL
    }
    // importPath unknown — the common library case, because pre-compiled
    // bundles strip `__file` so the bridge can't determine the source at
    // runtime. Fall back to name-only resolution. `readImportPath` in
    // build-attribution-context.ts documents this contract.
    return this.byName.get(name) ?? NOT_FOUND_SENTINEL
  }

  /**
   * Warm the cache for a set of components. Idempotent across
   * duplicates and concurrent callers: a key already cached is
   * skipped, and a key with an in-flight fetch reuses that
   * fetch's promise instead of issuing another. Failures to fetch
   * a single entry don't abort the batch — they leave the entry
   * as `not in cache`, which the synchronous lookup treats as
   * `null` (refuse).
   */
  async prefetch(entries: Array<{ name: string; importPath?: string }>): Promise<void> {
    // Deduplicate by key first so the batch never issues duplicate
    // fetches for the same key from a single call.
    const wantedKeys = new Set<string>()
    const wantedEntries: Array<{ name: string; importPath?: string; key: string }> = []
    for (const entry of entries) {
      const key = keyFor(entry.name, entry.importPath)
      if (wantedKeys.has(key)) continue
      if (this.cache.has(key)) continue
      // A non-identifying name (the bridge's `<anonymous>` placeholder — see
      // NON_IDENTIFYING_COMPONENT_NAME) can never resolve, so don't spend a
      // round-trip finding that out. Cache it as a CONFIRMED miss, NOT via
      // `failedKeys`: `hasFailedFetch` means "we never found out" and gates the
      // `unknown-component` drift signal, so recording a definite answer there
      // would suppress a real signal class. `getByName` returns null either way,
      // which is what attribution already handles.
      if (!isIdentifyingComponentName(entry.name)) {
        this.cache.set(key, NOT_FOUND_SENTINEL)
        continue
      }
      wantedKeys.add(key)
      wantedEntries.push({ ...entry, key })
    }
    if (wantedEntries.length === 0) return
    await Promise.all(
      wantedEntries.map((entry) => this.fetchOne(entry.name, entry.key)),
    )
  }

  /**
   * Fetch one entry, deduplicating against any concurrent fetch
   * for the same key. The shared promise is registered in
   * `inFlight` BEFORE the async IIFE body starts so concurrent
   * callers observe it; cleared when the fetch settles regardless
   * of outcome.
   *
   * Why a deferred-promise pattern instead of `(async () => {...})()`
   * with set-after: async function bodies run synchronously up to
   * the first await, so a `source.getComponent` that throws
   * SYNCHRONOUSLY (or whose callee throws before returning a
   * promise) would walk through the IIFE's try/catch/finally — and
   * delete the in-flight key — BEFORE the set ever ran. The set
   * would then register an already-settled promise that future
   * prefetches reuse forever, never retrying. Pre-registering the
   * deferred promise closes that window.
   */
  private async fetchOne(name: string, key: string): Promise<void> {
    const existing = this.inFlight.get(key)
    if (existing) return existing
    let resolveDone!: () => void
    const promise = new Promise<void>((r) => { resolveDone = r })
    this.inFlight.set(key, promise)
    void (async () => {
      try {
        const manifest = await this.source.getComponent(name)
        this.cache.set(key, manifest)
        if (manifest) this.byName.set(name, manifest)
        // A successful resolution — even a confirmed miss (`manifest ===
        // null`) — supersedes any earlier failure recorded for this key.
        this.failedKeys.delete(key)
      } catch {
        // Leave the cache un-set; subsequent prefetch retries. Record the
        // failure so `hasFailedFetch` can distinguish this from a
        // confirmed miss until a later fetch actually resolves.
        this.failedKeys.add(key)
      } finally {
        this.inFlight.delete(key)
        resolveDone()
      }
    })()
    return promise
  }

  /**
   * Drop cached entries. Used when the manifest registry changes
   * (e.g., user edited a component's defineProps and hot reload
   * fired). Pass no args to clear everything; pass entries to clear
   * just those keys. Does NOT cancel in-flight fetches — those
   * complete normally and may repopulate the cache if `invalidate`
   * fired during the request window; callers that need a hard
   * reset should invalidate AFTER awaiting the prior prefetch.
   */
  invalidate(entries?: Array<{ name: string; importPath?: string }>): void {
    if (!entries) {
      this.cache.clear()
      this.byName.clear()
      this.failedKeys.clear()
      return
    }
    for (const entry of entries) {
      this.cache.delete(keyFor(entry.name, entry.importPath))
      this.failedKeys.delete(keyFor(entry.name, entry.importPath))
      // Drop the name-only fallback too. In a name-collision scenario
      // this is slightly over-eager (it forgets the other importPath's
      // manifest for name-only lookups until re-prefetched), but the
      // exact-key cache for the surviving importPath is untouched, so
      // explicit-importPath lookups remain correct.
      this.byName.delete(entry.name)
    }
  }
}

function keyFor(name: string, importPath?: string): string {
  return `${name}@${importPath ?? ''}`
}
