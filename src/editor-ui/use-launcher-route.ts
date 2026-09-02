"use client"

import { useCallback, useEffect, useState } from "react"
import type { NewProjectSource } from "@/components/editor/launcher/new-project-page"

/**
 * The launcher's two views, in the URL.
 *
 * Added 2026-08-17, when New Project stopped being a modal. A modal's expected
 * exit is Escape or Cancel and Back is nobody's instinct; a full PAGE's is the
 * browser Back button, and on this launcher that used to leave the app
 * entirely. Refresh also dropped you back on the list mid-wizard with no sign
 * anything had been going on.
 *
 * ## Why not react-router
 *
 * Three views and one parameter each. A router library brings a dependency, a
 * knip declaration and a provider tree to answer two branches. This is the
 * whole of it.
 *
 * ## Why the HASH and not a query param or a path
 *
 * The gallery already owns `?gallery=…` on this same origin
 * (`parseGalleryParams`), so a query param would put two unrelated routers in
 * one search string. A real path would need the CLI's static server to rewrite
 * unknown paths to index.html, which is a server change for a client concern.
 *
 * ## What is routed: the VIEW, not the STEP
 *
 * `#/new` is one entry however deep into the wizard you are. The flow owns its
 * own step transitions and knows which are legal (the name step needs a
 * resolved path, the design-system step needs a name); putting steps in
 * history would add a second, dumber navigation model beside the working one,
 * and Back would be able to land on a step whose preconditions have been
 * undone. Back from anywhere in the wizard returns to the list, which is what
 * leaving a page means.
 *
 * The cost, stated plainly: Back mid-wizard discards the wizard. That is the
 * same thing Cancel already does, so it is not a new way to lose work.
 */
export type LauncherRoute =
  | { view: "projects" }
  | { view: "new-project"; source: NewProjectSource | null }
  /**
   * Settings for ONE project, named by its absolute path.
   *
   * The path is the parameter because that is the launcher API's own key: it
   * edits a project the CLI has not booted, so there is no `repoRoot` and no
   * project id to route on. A path in a hash is not a secret — it is already
   * printed on the card the user clicked.
   */
  | { view: "project-settings"; path: string }

const NEW_PROJECT_PREFIX = "#/new"
const SETTINGS_PREFIX = "#/settings"

/** `#/new?source=clone` → `{ view: "new-project", source: "clone" }`. */
export function parseLauncherRoute(hash: string): LauncherRoute {
  if (hash.startsWith(SETTINGS_PREFIX)) {
    const q = hash.slice(SETTINGS_PREFIX.length)
    // Same end-of-route check `#/new` needs: `#/settingsish` starts with the
    // prefix and is not this route.
    if (q !== "" && !q.startsWith("?")) return { view: "projects" }
    const path = new URLSearchParams(q.startsWith("?") ? q.slice(1) : "").get("path")
    // No path means no project to show settings FOR. Falling back to the list
    // is the only honest render; an empty settings page would be a page about
    // nothing.
    if (!path) return { view: "projects" }
    return { view: "project-settings", path }
  }
  if (!hash.startsWith(NEW_PROJECT_PREFIX)) return { view: "projects" }
  const q = hash.slice(NEW_PROJECT_PREFIX.length)
  // The prefix has to END the route, not merely start it: `#/newish` passes
  // `startsWith("#/new")` and is not this route. Caught by the colocated test
  // before it shipped. Anything after the prefix must be a query string.
  if (q !== "" && !q.startsWith("?")) return { view: "projects" }
  // `URLSearchParams` on the fragment after `?`. An absent or unrecognised
  // source is null rather than a default: the flow's own source step is the
  // right place to ask, and guessing "local" would skip a question.
  const params = new URLSearchParams(q.startsWith("?") ? q.slice(1) : "")
  const raw = params.get("source")
  const source: NewProjectSource | null =
    raw === "local" || raw === "clone" ? raw : null
  return { view: "new-project", source }
}

export function launcherRouteHash(route: LauncherRoute): string {
  if (route.view === "projects") return "#/"
  if (route.view === "project-settings") {
    // Encoded: a path can hold spaces, `#`, `&` and `?`, every one of which
    // would otherwise end or split the fragment.
    return `${SETTINGS_PREFIX}?path=${encodeURIComponent(route.path)}`
  }
  return route.source ? `${NEW_PROJECT_PREFIX}?source=${route.source}` : NEW_PROJECT_PREFIX
}

export function useLauncherRoute(): {
  route: LauncherRoute
  navigate: (next: LauncherRoute) => void
} {
  const [route, setRoute] = useState<LauncherRoute>(() =>
    // Initialised from the URL, not from a default: a reload on `#/new` has to
    // come back on `#/new`, which is half the reason this exists.
    parseLauncherRoute(typeof window === "undefined" ? "" : window.location.hash),
  )

  useEffect(() => {
    const onHashChange = () => setRoute(parseLauncherRoute(window.location.hash))
    window.addEventListener("hashchange", onHashChange)
    // Re-read on mount too: the hash can change between the `useState`
    // initialiser and this effect attaching.
    onHashChange()
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  const navigate = useCallback((next: LauncherRoute) => {
    const hash = launcherRouteHash(next)
    if (window.location.hash === hash) {
      // Assigning an identical hash fires no `hashchange`, so the state would
      // never catch up on a no-op navigation. Set it directly instead.
      setRoute(next)
      return
    }
    // Assignment, not `replaceState`: this is what pushes the history entry
    // that makes Back work at all.
    window.location.hash = hash
  }, [])

  return { route, navigate }
}
