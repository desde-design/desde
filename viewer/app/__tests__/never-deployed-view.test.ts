/**
 * `decideNeverDeployedView` — what the review route shows a MANAGER for a
 * prototype with no finished build.
 *
 * Written 2026-09-10, when a first connect started building on its own (Mo).
 * Before that the page had one action for a manager, "Connect a repository".
 * It reopened the Add dialog even when a repository was already connected,
 * which is how a connected prototype ended up with no way to its first build.
 *
 * A reader who cannot manage never reaches this function. The page gives
 * them the way back and mounts none of the build hooks, because the log
 * stream refuses them.
 *
 * Two inputs arrive as `null` before their request lands AND as a real answer
 * ("no repository", "no build yet"). Every row that reads one checks the
 * matching `...Loaded` flag first, for the reason `decideInitialFlowMode`
 * records: reading a not-yet-loaded null as an answer is how that panel
 * shipped a wrong screen.
 */

import { describe, expect, it } from "vitest"
import {
  decideNeverDeployedView,
  type NeverDeployedInput,
} from "../review/[slug]/never-deployed-view"

/** Everything loaded, a repository connected, no build yet. Rows override one thing. */
function input(over: Partial<NeverDeployedInput> = {}): NeverDeployedInput {
  return {
    detailLoaded: true,
    detailFailed: false,
    hasRepo: true,
    deploymentsLoaded: true,
    latestStatus: null,
    sawBuilding: false,
    ...over,
  }
}

describe("decideNeverDeployedView", () => {
  it("waits for the project rather than reading a not-yet-loaded repo as 'none'", () => {
    expect(decideNeverDeployedView(input({ detailLoaded: false, hasRepo: false }))).toEqual({
      kind: "wait",
    })
  })

  it("says the project failed to load instead of waiting forever", () => {
    expect(decideNeverDeployedView(input({ detailLoaded: false, detailFailed: true }))).toEqual({
      kind: "load-failed",
    })
  })

  it("offers to connect a repository when none is connected", () => {
    expect(decideNeverDeployedView(input({ hasRepo: false }))).toEqual({ kind: "connect" })
    // Whatever the build list says: with no repository there is nothing to build from.
    expect(decideNeverDeployedView(input({ hasRepo: false, deploymentsLoaded: false }))).toEqual({
      kind: "connect",
    })
  })

  it("waits for the build list rather than reading a not-yet-loaded build as 'none'", () => {
    // THE ROW THIS FILE EXISTS FOR. Without it, a page opened mid-build shows
    // Deploy for a moment and then swaps to Building.
    expect(decideNeverDeployedView(input({ deploymentsLoaded: false }))).toEqual({ kind: "wait" })
  })

  it("offers Deploy for a connected repository with no build", () => {
    expect(decideNeverDeployedView(input())).toEqual({ kind: "deploy" })
  })

  it("shows a running build", () => {
    expect(decideNeverDeployedView(input({ latestStatus: "building" }))).toEqual({
      kind: "building",
    })
  })

  it("shows a failed build", () => {
    expect(decideNeverDeployedView(input({ latestStatus: "failed" }))).toEqual({ kind: "failed" })
  })

  it("reloads into the review screen only when this page watched the build finish", () => {
    expect(
      decideNeverDeployedView(input({ latestStatus: "deployed", sawBuilding: true })),
    ).toEqual({ kind: "deployed", reload: true })
    // Arrived to find a finished build but still no active deployment. A
    // reload would land here again, so it would loop. Offer a link instead.
    expect(
      decideNeverDeployedView(input({ latestStatus: "deployed", sawBuilding: false })),
    ).toEqual({ kind: "deployed", reload: false })
  })
})
