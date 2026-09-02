/**
 * Instance-wide operator settings, read from the `instance_settings` key/value
 * table (`StorageAdapter.getInstanceSetting`).
 *
 * Separate from `config.ts` on purpose: `ViewerConfig` is environment the
 * operator sets before boot, whereas these are toggles an admin flips at
 * runtime from the Settings panel.
 *
 * ## Why there is a cache here now (M2 review fix)
 *
 * This module's original comment said the setting is "read per request, not
 * cached — one indexed point lookup", and pointed at a change-bus-invalidated
 * cache as the fix if that ever stopped being acceptable. It stopped being
 * acceptable: `loadProjectReadPolicy` (auth/authorize.ts) is called from
 * `serve-router.ts`, i.e. from the path that serves EVERY prototype asset —
 * every image, font, chunk and stylesheet of a running prototype — not just
 * from JSON API routes measured in tens per session. One extra DB round-trip
 * per asset is a real cost on the hottest path the viewer has.
 *
 * So: a tiny in-process cache with a short TTL, PLUS explicit invalidation on
 * write. The invalidation is what makes it correct; the TTL is only a backstop
 * for a value written by something other than this process.
 *
 * **The cache is keyed by STORAGE INSTANCE** (a `WeakMap`), not module-global.
 * A module-global cached boolean would leak across the many tests that build a
 * fresh `InMemoryStorage` per case — one test's `allowPublicLinks: false`
 * silently deciding another test's read. Keying on the storage object makes
 * every adapter its own cache, and a `WeakMap` means a discarded storage takes
 * its entry with it.
 *
 * **Any writer that is NOT `PATCH /api/v1/instance/settings` must call
 * `invalidateInstanceSettingsCache(storage)` itself.** The route does (see
 * `instance-routes.ts`, immediately after `setInstanceSetting`). A test that
 * pokes `storage.setInstanceSetting` directly is such a writer, and the tests
 * in this repo that do so call the invalidator right after — otherwise the
 * write lands in the database and the read still answers from the cache.
 */

import type { StorageAdapter } from "./storage/types"

/** The `instance_settings` keys the admin Settings panel writes. */
export const ALLOW_PUBLIC_LINKS_KEY = "allowPublicLinks"
export const ALLOW_ANONYMOUS_COMMENTS_KEY = "allowAnonymousComments"

/**
 * How long a cached value survives with no explicit invalidation.
 *
 * Short deliberately. The kill switch is a SECURITY setting, so the window in
 * which a stale `true` can outlive an admin turning public links off is the
 * thing being traded away, and five seconds is small enough that the honest
 * description of the worst case is "the last few asset requests of a page load
 * already in flight". Explicit invalidation is what actually closes it in this
 * process; the TTL only bounds a value written from outside it (a second
 * process against the same SQLite file, or a hand-edited row).
 */
const CACHE_TTL_MS = 5_000

/** Just enough of a storage adapter for this module — see `getAllowPublicLinks`. */
type SettingsStorage = Pick<StorageAdapter, "getInstanceSetting">

interface CacheEntry {
  /** Keyed by `instance_settings` key, so one read never evicts another's. */
  values: Map<string, boolean>
  expiresAt: number
}

const cache = new WeakMap<SettingsStorage, CacheEntry>()

/**
 * Read one boolean instance setting, cached.
 *
 * Both switches decode identically, and the decoding is the load-bearing part:
 *
 * ABSENT → the documented default. The setting did not exist once, so a fresh
 * install that has never opened the Settings panel must keep behaving the way
 * it did before.
 *
 * PRESENT → on only for the literal `"true"`. The asymmetry with the absent
 * case is deliberate: absent means "never configured", which has a documented
 * default, whereas a present value that is neither `"true"` nor `"false"` means
 * the row was written by something other than this product and there is nothing
 * to infer from it. The only writer is `PATCH /api/v1/instance/settings`, which
 * stores `String(boolean)`. `raw !== "false"` would read a corrupted row as ON,
 * which fails open on a security switch.
 */
async function getBooleanSetting(
  storage: SettingsStorage,
  key: string,
  whenAbsent: boolean,
): Promise<boolean> {
  const now = Date.now()
  const entry = cache.get(storage)
  if (entry && entry.expiresAt > now) {
    const hit = entry.values.get(key)
    if (hit !== undefined) return hit
  }

  const raw = await storage.getInstanceSetting(key)
  const value = raw === null ? whenAbsent : raw === "true"
  const fresh =
    entry && entry.expiresAt > now ? entry : { values: new Map<string, boolean>(), expiresAt: now + CACHE_TTL_MS }
  fresh.values.set(key, value)
  cache.set(storage, fresh)
  return value
}

/**
 * Drops the cached settings for one storage adapter, so the next read goes
 * back to the database.
 *
 * Called by `PATCH /api/v1/instance/settings` right after the write. Takes the
 * storage rather than clearing everything, for the same reason the cache is
 * keyed by it: one adapter's write says nothing about another adapter's state,
 * and a global clear would make the cache's isolation depend on nobody ever
 * writing from a second storage in the same process (which the test suite does
 * constantly).
 */
export function invalidateInstanceSettingsCache(storage: SettingsStorage): void {
  cache.delete(storage)
}

/**
 * The public-link kill switch: may an anonymous holder of a `public-link`
 * project's URL read it?
 *
 * ABSENT → `true`. Public links were unconditionally on before this setting
 * existed, and the demo project seeded on first boot is `public-link`, so a
 * fresh install that has never opened the Settings panel must keep working.
 *
 * PRESENT → on only for the literal `"true"`. Note the asymmetry with the
 * absent case, and that it is deliberate: absent means "never configured",
 * which is a state with a documented default, whereas a present value that
 * is neither `"true"` nor `"false"` means the row was written by something
 * other than this product and there is nothing to infer from it. The only
 * writer is `PATCH /api/v1/instance/settings`, which stores
 * `String(boolean)`, so an unrecognized value can only reach here from a
 * hand-edited database — and the safe reading of a corrupted kill switch is
 * that the kill switch is ON. `raw !== "false"` would have read the same row
 * as "public links enabled", which fails open.
 *
 * Takes the storage narrow (`Pick<…, "getInstanceSetting">`) rather than
 * `AppDeps` so the serve layer, the API routes and the authorization seam can
 * all call it without any of them depending on the Express app's dep bundle.
 *
 * Cached — see this module's header for the rule that keeps the cache honest.
 * The DECODING above is unchanged by the cache: a cache hit returns exactly
 * the boolean a fresh read of the same row would have produced.
 */
export async function getAllowPublicLinks(storage: SettingsStorage): Promise<boolean> {
  return getBooleanSetting(storage, ALLOW_PUBLIC_LINKS_KEY, true)
}

/**
 * May a caller with NO credential at all post, edit or delete comments on a
 * project it can read?
 *
 * ABSENT → `true`, because that is what the product has always done and the
 * code says so outright: "anonymous review links are the product"
 * (`requireProjectWrite`, authorize.ts). Turning this off is a deliberate
 * choice for a deployment whose projects are reachable by strangers.
 *
 * The case it exists for is a public demo instance, where the project is
 * `public-link` so anyone can open it, and anonymous writes therefore mean
 * anyone on the internet can leave, edit and delete comments on it. That is
 * correct for a review link shared with named colleagues and wrong for a URL on
 * a marketing page.
 *
 * It gates WRITES only. Anonymous reads are unaffected, so a visitor still sees
 * the conversation; they just cannot join it.
 */
export async function getAllowAnonymousComments(storage: SettingsStorage): Promise<boolean> {
  return getBooleanSetting(storage, ALLOW_ANONYMOUS_COMMENTS_KEY, true)
}
