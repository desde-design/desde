"use client"

/**
 * Re-read GitHub state when the reader comes back to this tab.
 *
 * Mo, 2026-09-10: "once we notice that the tab is selected after sending them
 * out to do the github app, we refresh the credentials."
 *
 * ## What this is for, and what it cannot do
 *
 * Granting an App access to more repositories happens on github.com, and the
 * reader does it in another tab or another window. Nothing tells this page
 * about it. Before this, the panel kept showing the answer it had read
 * before they left, and the only way out was reloading.
 *
 * What it reliably fixes is **whether a GitHub App is configured at all**.
 * That changes when the reader finishes creating one, it is read from the
 * live runtime config, and there is no snapshot in front of it. This is the
 * case Mo's "refresh the credentials" names, and the one to trust.
 *
 * **Two things this hook does NOT bring fully up to date, and neither may be
 * described as if it did.** Both are sign-in snapshots, because the OAuth
 * callback is the only place a user token exists and none is stored
 * (`server/github/caller-installations.ts`):
 *
 * - **The account list.** Installing the App on a NEW account cannot become
 *   visible without signing in again. The panel already offers exactly that,
 *   under "Not seeing an account? Refresh GitHub access".
 * - **Which repositories the reader may personally connect.** The repository
 *   LIST is a live call, so a repository granted while they were away does
 *   reappear in it. Connecting it is gated separately, against a per-user
 *   repo set captured at sign-in (security audit B4, enforced in
 *   `project-repo-routes.ts`), and that set does not move here. So the row
 *   can show up and the connect still refuse until the reader signs in
 *   again.
 *
 * That last mismatch is a real one and it predates this hook: the list route
 * does not apply the per-caller filter the connect route does. Refreshing
 * makes it easier to run into, not worse than it was. It is written down
 * here so nobody reads this hook as having closed it.
 *
 * ## Why a pure decision plus a thin hook
 *
 * The same split `decideAccessFlowCheck` and `decideInitialFlowMode` use in
 * this directory. A listener that fires and correctly declines to do anything
 * is indistinguishable from a listener that is silently broken, and browser
 * events are the least pleasant thing in this codebase to drive from a test.
 * The decision is a function; the hook only wires events to it.
 */

import { useCallback, useEffect, useRef } from "react"

/**
 * How long after one refresh before another may run.
 *
 * The events below fire more often than a reader actually goes anywhere:
 * `focus` lands on every click back into the window, including the one that
 * dismisses an OS notification. Without a floor, a reader who alt-tabs while
 * reading would issue a burst of requests they did not ask for.
 *
 * Three seconds is short enough that a genuine trip to GitHub and back is
 * never inside it — the fastest possible round trip is several page loads on
 * someone else's servers.
 */
export const RETURN_REFRESH_MIN_INTERVAL_MS = 3_000

export interface ReturnRefreshState {
  /**
   * The reader was actually away: this tab was hidden, or the window lost
   * focus, at some point since the last refresh.
   *
   * The gate that makes this a "came back" signal rather than a "clicked
   * something" one. A `focus` event with nothing before it is not a return.
   */
  wasAway: boolean
  /**
   * This panel makes these requests for this reader at all.
   *
   * False for a reader who is signed out or cannot manage: the panel never
   * fetched the data, so there is nothing to bring up to date and a request
   * would only earn a 401.
   */
  active: boolean
  /**
   * A write is in flight. Refetching under one would race the reload that
   * follows it, and the reader would watch fields change under a spinner for
   * no reason they could name.
   */
  busy: boolean
  /** `Date.now()` when this hook last refreshed, or null if it never has. */
  lastRefreshedAt: number | null
  now: number
}

export function shouldRefreshOnReturn(state: ReturnRefreshState): boolean {
  if (!state.wasAway) return false
  if (!state.active) return false
  if (state.busy) return false
  if (state.lastRefreshedAt === null) return true
  return state.now - state.lastRefreshedAt >= RETURN_REFRESH_MIN_INTERVAL_MS
}

export interface UseRefreshOnReturnArgs {
  /** See {@link ReturnRefreshState.active}. */
  active: boolean
  /** See {@link ReturnRefreshState.busy}. */
  busy: boolean
  /** Re-read whatever went stale while the reader was away. */
  refresh: () => void
}

/**
 * Runs `refresh` when the reader returns to this tab, at most once every
 * {@link RETURN_REFRESH_MIN_INTERVAL_MS}.
 *
 * Both events are listened for, because neither one alone covers leaving:
 *
 * - `visibilitychange` is the tab being switched away from and back. It does
 *   NOT fire when the whole browser window goes behind another application —
 *   the tab is still the visible one in a window nobody is looking at.
 * - `focus` / `blur` on the window covers that second case, and fires far
 *   more loosely, which is what the interval floor is for.
 *
 * `refresh` is held in a ref rather than listed as a dependency. The
 * listeners must not be torn down and re-added on every render — a caller
 * naturally passes a closure over its own fetches, and re-subscribing on each
 * of those state changes is how a return event gets dropped between the
 * removal and the add.
 */
export function useRefreshOnReturn({ active, busy, refresh }: UseRefreshOnReturnArgs): void {
  const refreshRef = useRef(refresh)
  // The flags travel the same way, for the same reason: read at event time,
  // never re-subscribed on.
  const activeRef = useRef(active)
  const busyRef = useRef(busy)

  /*
   * Written in an effect with NO dependency array, not during render.
   * Assigning to `ref.current` while rendering is a lint error here
   * (`react-hooks/refs`) and it earns the rule: React may render a component
   * without committing it, so a render-time write can publish a value from
   * work that was thrown away.
   *
   * No array means "after every render", which is what keeps these current.
   * The gap it leaves is the instant between commit and this effect, and no
   * event can land in it: the values below change only as a result of the
   * reader acting, and the browser cannot deliver a focus event in the middle
   * of React's own commit.
   */
  useEffect(() => {
    refreshRef.current = refresh
    activeRef.current = active
    busyRef.current = busy
  })

  const wasAwayRef = useRef(false)
  const lastRefreshedAtRef = useRef<number | null>(null)

  const onReturn = useCallback(() => {
    const now = Date.now()
    if (
      !shouldRefreshOnReturn({
        wasAway: wasAwayRef.current,
        active: activeRef.current,
        busy: busyRef.current,
        lastRefreshedAt: lastRefreshedAtRef.current,
        now,
      })
    ) {
      // The away flag is cleared either way. A return that was declined —
      // because a save was running, say — is still a return, and leaving the
      // flag set would fire the refresh on the next unrelated click instead.
      wasAwayRef.current = false
      return
    }
    wasAwayRef.current = false
    lastRefreshedAtRef.current = now
    refreshRef.current()
  }, [])

  useEffect(() => {
    if (typeof document === "undefined") return

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        wasAwayRef.current = true
        return
      }
      onReturn()
    }
    const onBlur = (): void => {
      wasAwayRef.current = true
    }

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onReturn)
    return () => {
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onReturn)
    }
  }, [onReturn])
}
