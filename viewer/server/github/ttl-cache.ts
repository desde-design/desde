/**
 * A tiny absolute-expiry cache used by `github-app-client.ts` (Phase 3c-1b
 * T4). Deliberately NOT a general-purpose LRU library — the two call sites
 * want different expiry sources (a GitHub-supplied `expires_at` for the
 * installation token, a fixed TTL for list reads), so `set` takes an
 * ABSOLUTE expiry timestamp rather than a duration and lets the caller
 * decide how it was computed.
 *
 * `now` is injected rather than read from `Date.now()` so the colocated
 * tests can advance time without sleeping.
 *
 * **Keying is a security property here, not a performance detail.** Every
 * entry this cache holds is derived SOLELY from its key — a key is either a
 * GitHub installation id (the authorization boundary the routes have
 * already verified the caller against) or the singleton App-wide list. No
 * value is ever a function of the CALLER, so there is no key under which
 * one user's entry could be served to another. See `github-app-client.ts`'s
 * cache section and the phase report for the full argument.
 */

export interface TtlCache<K, V> {
  /** The cached value, or `undefined` when absent or expired. */
  get(key: K): V | undefined
  /** Store `value` under `key` until `expiresAtMs` (absolute, same clock as `now`). */
  set(key: K, value: V, expiresAtMs: number): void
  /** Drop everything. Used by tests; also the honest reaction to a config change. */
  clear(): void
}

interface Entry<V> {
  value: V
  expiresAtMs: number
}

/**
 * `maxEntries` bounds memory against a caller who walks a large id space.
 * Eviction is insertion-ordered (JS `Map` iteration order) rather than
 * least-recently-used: an eviction here only costs one extra GitHub call,
 * so the simplest bound that cannot grow without limit is the right one.
 */
export function createTtlCache<K, V>(now: () => number, maxEntries = 256): TtlCache<K, V> {
  const entries = new Map<K, Entry<V>>()

  function pruneExpired(atMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAtMs <= atMs) entries.delete(key)
    }
  }

  return {
    get(key: K): V | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAtMs <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },

    set(key: K, value: V, expiresAtMs: number): void {
      const atMs = now()
      // An already-expired expiry is a legitimate input (a GitHub token
      // whose `expires_at` is within the skew window) — storing it would be
      // a guaranteed miss on the next read, so skip the write entirely.
      if (expiresAtMs <= atMs) {
        entries.delete(key)
        return
      }
      pruneExpired(atMs)
      // Delete-then-set so a re-set moves the key to the END of insertion
      // order; without it, a hot key would keep its original position and
      // be evicted ahead of colder ones.
      entries.delete(key)
      entries.set(key, { value, expiresAtMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },

    clear(): void {
      entries.clear()
    },
  }
}
