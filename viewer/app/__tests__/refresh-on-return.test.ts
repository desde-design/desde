/**
 * `shouldRefreshOnReturn` — when coming back to this tab re-reads GitHub.
 *
 * Asked for 2026-09-10 (Mo: "once we notice that the tab is selected after
 * sending them out to do the github app, we refresh the credentials"), after
 * a setup where the only way to see the new state was a hard refresh.
 *
 * The whole subtlety is telling "came back" apart from "clicked something".
 * `focus` fires on every click into the window, so a refresh hung on it alone
 * would issue requests all day; a refresh hung on nothing would never fire at
 * all. Both failure modes are invisible from inside a `useEffect`, which is
 * why the decision is a function.
 */

import { describe, expect, it } from "vitest"
import { RETURN_REFRESH_MIN_INTERVAL_MS, shouldRefreshOnReturn } from "../refresh-on-return"

const NOW = 1_757_500_000_000

/** Back from a genuine trip away, with nothing in the way. Rows override one thing. */
function state(over: Partial<Parameters<typeof shouldRefreshOnReturn>[0]> = {}) {
  return {
    wasAway: true,
    active: true,
    busy: false,
    lastRefreshedAt: null as number | null,
    now: NOW,
    ...over,
  }
}

describe("shouldRefreshOnReturn", () => {
  it("refreshes on the first return after being away", () => {
    expect(shouldRefreshOnReturn(state())).toBe(true)
  })

  it("does not refresh on a focus that follows no absence", () => {
    // The event that fires when the reader clicks back into the window after
    // dismissing an OS notification, or after any of the other things that
    // blur nothing. They never left, so nothing can have changed.
    expect(shouldRefreshOnReturn(state({ wasAway: false }))).toBe(false)
  })

  it("does nothing for a reader this panel never fetched for", () => {
    // Signed out, or read-only. There is no stale data to correct, and the
    // request would only earn a 401.
    expect(shouldRefreshOnReturn(state({ active: false }))).toBe(false)
  })

  it("does not refresh under a write in flight", () => {
    // A save is running and will reload on its own. Refetching underneath it
    // races that reload, and the reader watches fields move for no reason
    // they could name.
    expect(shouldRefreshOnReturn(state({ busy: true }))).toBe(false)
  })

  it("holds a floor between refreshes", () => {
    const last = NOW - 1_000
    expect(shouldRefreshOnReturn(state({ lastRefreshedAt: last }))).toBe(false)
  })

  it("refreshes again once the floor has passed", () => {
    const last = NOW - RETURN_REFRESH_MIN_INTERVAL_MS
    expect(shouldRefreshOnReturn(state({ lastRefreshedAt: last }))).toBe(true)
    expect(
      shouldRefreshOnReturn(state({ lastRefreshedAt: last - 60_000 })),
    ).toBe(true)
  })

  it("keeps the floor short enough that a real trip to GitHub is never inside it", () => {
    /*
     * Not a tautology dressed as a test — it is the reason the number is what
     * it is, and the thing a later tuning pass has to preserve.
     *
     * The trip this hook exists for is: leave, load github.com, find the
     * installation, change repository access, come back. That is several page
     * loads on someone else's servers. A floor anywhere near it would swallow
     * the one refresh that matters and leave the reader exactly where they
     * started, with nothing on screen to say why.
     */
    expect(RETURN_REFRESH_MIN_INTERVAL_MS).toBeLessThan(10_000)
  })
})
