import { useEffect, useRef } from "react"

/**
 * One shared `window.fetch` router for every fixture that needs to answer a
 * specific endpoint with canned data.
 *
 * **Why a router rather than each fixture saving and restoring `window.fetch`.**
 * That was the original design and it produced a wrong screenshot. Each fixture
 * captured the current `window.fetch`, replaced it, and restored its captured
 * copy on unmount. When React swaps one keyed state for another it renders the
 * NEW tree before running the OLD tree's effect cleanups — so the outgoing
 * fixture's "restore" ran after the incoming fixture had already installed its
 * own patch, and put the stale function back. Measured symptom: reaching
 * `swap/empty-catalog` by clicking over from `connect-viewer-dialog/unreachable`
 * rendered a POPULATED catalog, 3 times out of 3. A fixture showing the
 * opposite of what its label claims is the one failure this catalog exists to
 * prevent.
 *
 * Two further faults of save/restore, both fixed here: patching during
 * `render()` re-ran on every re-render (theme toggle, action-log append), so
 * wrappers stacked; and a fixture that unmounted without its cleanup winning
 * left its patch installed for the rest of the page session, which made the
 * harness's own populated catalog unreachable after one visit to
 * `swap/empty-catalog`.
 *
 * The router owns `window.fetch` exactly once. Fixtures register an override
 * and remove only their OWN entry, so cleanup order stops mattering: a late
 * cleanup can no longer clobber a live registration, because it never touches
 * the wrapper itself.
 */

/**
 * What an override hands back for a matched request.
 *
 * `pending` and `networkError` exist because two of the states a gallery most
 * needs are not response BODIES at all. A "Loading…" state is a request that
 * has not settled, and an offline state is a request that rejected — a router
 * that could only return `{status, body}` could reach neither, and every
 * loading state in both catalogs would have to be faked some other way.
 */
export type FetchOverrideResult =
  | { status: number; body: unknown }
  /** Never settles — holds the caller in its loading state. */
  | { pending: true }
  /** Rejects, as `fetch` does when the request never reaches a server. */
  | { networkError: true }

interface FetchOverride {
  /** Which requests this override answers. Everything else passes through. */
  match: (url: string, init?: RequestInit) => boolean
  /** JSON body to return, or a full response spec when status matters. */
  respond: (url: string, init?: RequestInit) => FetchOverrideResult
}

const active = new Map<symbol, FetchOverride>()

/**
 * Marks the installed wrapper so re-installation is idempotent AND survives
 * something else replacing `window.fetch` underneath us. Vitest's
 * `vi.unstubAllGlobals()` does exactly that between tests: it restores the
 * pre-stub `fetch`, discarding our wrapper. Checking for the marker (rather
 * than a module-level `installed` boolean) means the next registration
 * re-wraps whatever is current instead of silently never applying again.
 */
const ROUTER_MARK = "__desdeGalleryFetchRouter"

type MarkedFetch = typeof window.fetch & { [ROUTER_MARK]?: true }

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function ensureInstalled(): void {
  const current = window.fetch as MarkedFetch
  if (current[ROUTER_MARK]) return

  // Chain onto whatever is current — the self-host harness's mock backend, or
  // the registry test's blanket stub — so every endpoint a fixture does NOT
  // claim keeps working.
  const passthrough = current.bind(window)

  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    // Newest registration wins. During a state switch both the outgoing and
    // incoming fixtures are briefly registered; the incoming one was inserted
    // last, and Map preserves insertion order.
    const overrides = [...active.values()]
    for (let i = overrides.length - 1; i >= 0; i--) {
      const override = overrides[i]
      if (!override.match(url, init)) continue
      const result = override.respond(url, init)
      // A never-settling promise, not a delayed one: the caller is meant to
      // stay in its loading state for as long as the fixture is on screen.
      if ("pending" in result) return new Promise<Response>(() => {})
      if ("networkError" in result) {
        throw new TypeError(`Failed to fetch (gallery fixture): ${url}`)
      }
      const { status, body } = result
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    }
    return passthrough(input, init)
  }) as MarkedFetch

  wrapped[ROUTER_MARK] = true
  window.fetch = wrapped
}

/**
 * Answer `match`ing requests with `respond()` for as long as this component is
 * mounted.
 *
 * Registration happens during RENDER, deliberately. A host component's own
 * fetch typically fires from ITS mount effect, and child effects run before a
 * wrapping parent's, so registering from an effect here would lose the race and
 * the fixture would sometimes show the un-overridden response.
 *
 * MUST be called from a real component (a fixture that returns an element),
 * never from a `SurfaceState.render` body directly — `render()` executes inside
 * `GalleryOverlay`'s own render, so a hook there would join the overlay's hook
 * list and switching to a state that doesn't call it would change the hook
 * count between renders.
 */
export function useFetchOverride(override: FetchOverride): void {
  const token = useRef<symbol | null>(null)
  if (token.current === null) token.current = Symbol("gallery-fetch-override")

  ensureInstalled()
  active.set(token.current, override)

  useEffect(() => {
    const id = token.current
    return () => {
      if (id) active.delete(id)
    }
  }, [])
}

/** Convenience for the common case: a 200 with a fixed JSON body. */
export function jsonOverride(
  match: (url: string) => boolean,
  body: unknown,
): FetchOverride {
  return { match, respond: () => ({ status: 200, body }) }
}

/**
 * A whole endpoint table as ONE override.
 *
 * The single-endpoint form above suits the Editor, where a fixture usually
 * stubs one route. A Viewer screen loads itself from four or five endpoints at
 * once (`/me`, the project, its members, its deployments), and registering
 * five separate overlapping overrides per state made the catalog hard to read
 * and easy to get wrong. Here the fixture writes one table and anything it
 * does not name falls through to the harness's baseline backend.
 *
 * Keys are matched by `startsWith` against the path (query string stripped),
 * longest key first, so `/api/v1/projects/p1/members` wins over
 * `/api/v1/projects`. Methods are matched exactly when the key names one:
 * `"POST /api/v1/tokens"`.
 */
export function routeTable(
  table: Record<string, FetchOverrideResult | (() => FetchOverrideResult)>,
): FetchOverride {
  const entries = Object.entries(table)
    .map(([key, value]) => {
      const [maybeMethod, ...rest] = key.split(" ")
      const hasMethod = rest.length > 0
      return {
        method: hasMethod ? maybeMethod.toUpperCase() : null,
        path: hasMethod ? rest.join(" ") : key,
        value,
      }
    })
    // Longest path first so a more specific route is never shadowed by a
    // prefix of itself.
    .sort((a, b) => b.path.length - a.path.length)

  const find = (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]
    const method = (init?.method ?? "GET").toUpperCase()
    return entries.find(
      (entry) =>
        path.startsWith(entry.path) && (entry.method === null || entry.method === method),
    )
  }

  return {
    match: (url, init) => find(url, init) !== undefined,
    respond: (url, init) => {
      const entry = find(url, init)
      if (!entry) return { status: 404, body: { error: "no gallery route" } }
      return typeof entry.value === "function" ? entry.value() : entry.value
    },
  }
}

/** `{ status: 200, body }` — the common cell in a `routeTable`. */
export function ok(body: unknown): FetchOverrideResult {
  return { status: 200, body }
}

/** A failing response with the viewer API's `{ error }` body shape. */
export function fail(status: number, error?: string): FetchOverrideResult {
  return { status, body: error === undefined ? {} : { error } }
}

/** A request that never settles — holds the caller on its loading state. */
export const PENDING: FetchOverrideResult = { pending: true }

/** A request that rejects, as it would with no server listening. */
export const NETWORK_ERROR: FetchOverrideResult = { networkError: true }
