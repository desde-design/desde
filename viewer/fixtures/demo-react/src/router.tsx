import { useCallback, useEffect, useState } from "react"

/**
 * A ~40-line router, rather than a dependency.
 *
 * The viewer sends a Content-Security-Policy on every prototype response, so
 * this fixture may not reach a CDN, and its `package.json` deliberately
 * carries nothing but React. Three routes do not justify changing either of
 * those facts.
 *
 * PATH routing, not hash. Two reasons, and the first is the load-bearing one:
 * the viewer's serve layer already falls back to `index.html` on any
 * extensionless miss (`serve-router.ts`), which is exactly what a client-side
 * path route needs, and Vite's dev server does the same by default. The
 * second is that a comment's page key is `pathname + hash`
 * (`src/bridge/anchor-pins.ts`), so real paths give reviewers a readable
 * `/p/demo/workspaces` instead of `/p/demo/#workspaces`.
 */
export const ROUTES = ["", "workspaces", "settings"] as const
export type Route = (typeof ROUTES)[number]

/**
 * Where this prototype is mounted, derived at runtime rather than baked in.
 *
 * The same build is served from four different places: `/p/demo/` in the
 * viewer's path mode, the root of a loopback port, the root of a subdomain,
 * and `/` under Vite in the Editor. Hard-coding a base would work in exactly
 * one of them.
 *
 * Derivation: if the last path segment names a route, the base is everything
 * before it. Otherwise the whole path is the base.
 */
function splitPath(pathname: string): { base: string; route: Route } {
  const segments = pathname.split("/").filter(Boolean)
  const last = segments[segments.length - 1]
  const named = ROUTES.find((r) => r !== "" && r === last)
  if (named) return { base: "/" + segments.slice(0, -1).join("/") + "/", route: named }
  return { base: pathname.endsWith("/") ? pathname : pathname + "/", route: "" }
}

/**
 * The base is read ONCE, at module load, from the URL the document was
 * actually served at.
 *
 * Re-deriving it per navigation would be wrong: after `pushState` to
 * `/p/demo/workspaces` the trailing segment is a route name, so a second
 * derivation still returns `/p/demo/` — but a route named after a path
 * segment of the mount point would not survive that, and the served URL is
 * the only unambiguous evidence.
 */
const BASE = splitPath(window.location.pathname).base

/**
 * `base + route`, with NO trailing slash on a named route.
 *
 * That is not cosmetic. `vite.config.ts` sets `base: "./"`, so every asset URL
 * is relative and resolves against the DIRECTORY of the current URL. At
 * `/p/demo/workspaces` that directory is `/p/demo/` and the assets load. Add a
 * trailing slash and the directory becomes `/p/demo/workspaces/`, where
 * nothing exists and the page renders blank with no error worth reading.
 */
export const href = (route: Route): string => (route === "" ? BASE : BASE + route)

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => splitPath(window.location.pathname).route)

  useEffect(() => {
    const onPop = () => setRoute(splitPath(window.location.pathname).route)
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const navigate = useCallback((next: Route) => {
    window.history.pushState({}, "", href(next))
    setRoute(next)
    window.scrollTo(0, 0)
  }, [])

  return [route, navigate]
}
