/**
 * Pure URL helpers for the editor CLI iframe deeplink / refresh behavior
 * (NEXT.md §9). Two concerns, both kept side-effect-free so they're unit-
 * testable without a DOM:
 *
 *  1. `resolveCliIframeUrl` — on a hard refresh the shell's `?url=` param
 *     already carries the prototype page the user had navigated to (the route
 *     mirror below keeps it current). Preserving it is what makes a deeplink
 *     survive reload instead of bouncing to the seed page. But the stored
 *     URL's ORIGIN can go stale if the dev server's port changed since it was
 *     written (the CLI was restarted while a tab stayed open), so we re-base
 *     the origin onto the freshly-injected `viteUrl` while keeping the stored
 *     path/search/hash. A malformed stored URL falls back to `viteUrl`.
 *
 *  2. `mirrorLiveRouteToShellUrl` — when the prototype iframe navigates
 *     (bridge `ROUTE_CHANGED`), mirror its live pathname/search/hash into the
 *     shell's `?url=` param so the address bar deeplinks to the current page.
 *     The canonical dev-server origin the iframe was SEEDED with is kept (the
 *     live payload may carry a per-session worktree origin that won't exist
 *     after a reload); only the path is adopted. Returns the next shell href,
 *     or `null` when nothing changed / either URL is unparseable.
 */

/**
 * Resolve the URL the CLI iframe should load on (re)mount. `existing` is the
 * current `?url=` value (null on a fresh open). Returns the URL to use:
 *   - no existing → `viteUrl`
 *   - existing with a stale origin → `viteUrl` origin + existing path/search/hash
 *   - existing already on the fresh origin → returned unchanged
 *   - existing unparseable → `viteUrl`
 */
export function resolveCliIframeUrl(existing: string | null, viteUrl: string): string {
  if (!existing) return viteUrl
  try {
    const stored = new URL(existing)
    const fresh = new URL(viteUrl)
    if (stored.origin === fresh.origin) return existing
    fresh.pathname = stored.pathname
    fresh.search = stored.search
    fresh.hash = stored.hash
    return fresh.toString()
  } catch {
    // Stored `?url=` isn't a valid absolute URL — fall back to the fresh
    // viteUrl so the iframe still loads something real.
    return viteUrl
  }
}

/**
 * Compute the next shell href that mirrors the live prototype route into
 * `?url=`, keeping the canonical (seeded) origin. Returns `null` when the
 * result would be identical to `currentShellHref` (no replaceState needed) or
 * when `canonicalPrototypeUrl` / `livePayloadUrl` can't be parsed.
 */
export function mirrorLiveRouteToShellUrl(
  canonicalPrototypeUrl: string,
  livePayloadUrl: string,
  currentShellHref: string,
): string | null {
  try {
    const canonical = new URL(canonicalPrototypeUrl)
    const live = new URL(livePayloadUrl)
    canonical.pathname = live.pathname
    canonical.search = live.search
    canonical.hash = live.hash
    const shellUrl = new URL(currentShellHref)
    shellUrl.searchParams.set('url', canonical.toString())
    const next = shellUrl.toString()
    return next !== currentShellHref ? next : null
  } catch {
    // Unparseable canonical/live URL — skip address mirroring.
    return null
  }
}
