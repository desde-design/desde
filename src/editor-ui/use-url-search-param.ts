"use client"

import { useSyncExternalStore } from "react"

/**
 * Vanilla replacement for Next's `useSearchParams`. Subscribes to
 * `popstate`, `hashchange`, AND patched `history.pushState`/`replaceState`
 * so SPA-style URL mutations (Next `router.push`, browser back/forward,
 * hash navigation) all trigger a re-read. SSR snapshot is `null` — the
 * client takes over on hydration. Works identically inside the Next-served
 * `/compose` route and inside the standalone editor CLI bundle (which
 * has no Next runtime).
 *
 * The history-method patches are installed lazily on first subscription
 * and are cumulative — multiple subscribers share one patch, and we never
 * unpatch (pushState/replaceState are global APIs and any other library
 * that patches them would break if we restored mid-session). The custom
 * event keeps the original methods' return values intact.
 */
export function useUrlSearchParam(name: string): string | null {
  return useSyncExternalStore(
    subscribeToUrlChanges,
    () => new URLSearchParams(window.location.search).get(name),
    () => null,
  )
}

const URL_CHANGE_EVENT = "desde:url-change"
const PATCH_MARKER = Symbol.for("desde.useUrlSearchParam.patched")

type PatchedHistoryMethod = History["pushState"] & {
  [PATCH_MARKER]?: true
}

/**
 * Patches `pushState`/`replaceState` to dispatch a custom event on every
 * call. Idempotent: detects existing patching by checking for our symbol
 * marker on the function, so multiple subscribers (or tests that swap
 * the methods between runs) all converge on a patched-once state. Never
 * unpatches — these are global APIs and restoring them mid-session would
 * silently break any other listener that relied on the patched dispatch.
 */
function patchHistoryMethods(): void {
  if (typeof window === "undefined") return
  const dispatch = () => window.dispatchEvent(new Event(URL_CHANGE_EVENT))
  // Native pushState/replaceState arity is 3 (state, unused, url?). We
  // preserve that on the wrappers so libraries that introspect
  // `history.pushState.length` (e.g., some routing/instrumentation
  // shims) keep seeing the expected signature.
  const currentPush = window.history.pushState as PatchedHistoryMethod
  if (!currentPush[PATCH_MARKER]) {
    const originalPush = currentPush
    const patchedPush: PatchedHistoryMethod = function patchedPushState(
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const result = originalPush.call(this, state, unused, url)
      dispatch()
      return result
    }
    patchedPush[PATCH_MARKER] = true
    window.history.pushState = patchedPush
  }
  const currentReplace = window.history.replaceState as PatchedHistoryMethod
  if (!currentReplace[PATCH_MARKER]) {
    const originalReplace = currentReplace
    const patchedReplace: PatchedHistoryMethod = function patchedReplaceState(
      this: History,
      state: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const result = originalReplace.call(this, state, unused, url)
      dispatch()
      return result
    }
    patchedReplace[PATCH_MARKER] = true
    window.history.replaceState = patchedReplace
  }
}

function subscribeToUrlChanges(callback: () => void): () => void {
  patchHistoryMethods()
  window.addEventListener("popstate", callback)
  window.addEventListener("hashchange", callback)
  window.addEventListener(URL_CHANGE_EVENT, callback)
  return () => {
    window.removeEventListener("popstate", callback)
    window.removeEventListener("hashchange", callback)
    window.removeEventListener(URL_CHANGE_EVENT, callback)
  }
}
