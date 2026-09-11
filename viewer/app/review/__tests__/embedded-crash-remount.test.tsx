// @vitest-environment jsdom

/**
 * Codex round 5, Fix 1 — a retryable crash noticed while a server
 * prototype's iframe is embedded must reload the FRAME, not only the page.
 *
 * `useProcessRecovery({ mode: "embedded" })` used to call only
 * `router.refresh()` on a retryable crash. The server render still answers
 * `embed` (the crash is retryable, so `decidePrototypeEmbed` keeps showing
 * the frame), and the iframe's `src` and identity are unchanged, so React
 * keeps the SAME DOM node — the one already showing the proxy's error page.
 * No new request ever reaches the proxy, `ensure()` is never called, and the
 * poll keeps seeing `crashed` forever.
 *
 * The fix: the shell keeps a `frameEpoch` counter and renders the iframe
 * with `key={frameEpoch}`. The embedded poll's callback bumps the epoch
 * (forcing React to unmount the old iframe and mount a fresh one, whose own
 * request restarts the child) AND still calls the router refresh, so a crash
 * that is past the restart budget still lands on the crashed panel once the
 * server re-renders.
 *
 * This test fails against the pre-fix code: the iframe DOM node identity
 * never changes, because nothing keys it.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { ReviewShell, type ReviewShellProject } from "../[slug]/review-shell"
import type { ProcessStatus } from "../../../server/serve/prototype-processes"

// `useRouterRefresh` falls back to a no-op when there is no real Next App
// Router context around the tree (see its own doc comment) — which is
// exactly this render harness. Mocked here so the test can observe the
// SAME callback's other half: that a retryable crash still asks the router
// to refresh, alongside remounting the frame. `vi.hoisted` because the
// factory below runs before this module's own top-level `const`s exist.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const PROJECT_ID = "proj-embedded-crash"

const PROJECT: ReviewShellProject = {
  id: PROJECT_ID,
  slug: "ai-gateway",
  name: "AI Gateway",
  access: "public-link",
  publicLinksEnabled: true,
  serveDomain: null,
  capability: null,
  shellOrigin: "http://localhost:3130",
  prototypeOrigin: "http://127.0.0.1:4321",
  mode: "loopback",
  serve: "server",
  process: { state: "running", port: 4321, since: "2026-09-10T00:00:00.000Z" },
  range: null,
}

const RETRYABLE_CRASH: ProcessStatus = {
  state: "crashed",
  exitCode: 1,
  restarts: 1,
  reason: "The server exited.",
  retryable: true,
}

function loopbackBody(process: ProcessStatus): unknown {
  return { mode: "loopback", origin: "http://127.0.0.1:4321", serve: "server", process, range: null }
}

const ROUTES: Record<string, FetchOverrideResult | (() => FetchOverrideResult)> = {
  [`GET /api/v1/projects/${PROJECT_ID}/comments`]: ok({ comments: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/members`]: ok({ members: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/participants`]: ok({ participants: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}`]: ok({ project: { id: PROJECT_ID, name: PROJECT.name } }),
  // The embedded poll's route. Every call reports the crash — the point of
  // this test is what the FIRST poll does, not the cadence.
  [`GET /api/v1/projects/${PROJECT_ID}/prototype-origin`]: () => ok(loopbackBody(RETRYABLE_CRASH)),
}

function Scenario({ children }: { children: ReactNode }): ReactNode {
  useFetchOverride(routeTable(ROUTES))
  return children
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * The bridge protocol's `BRIDGE_READY` handshake, as the shell's own message
 * listener (`use-viewer-bridge.ts`) would see it arrive from the real
 * iframe. Dispatched on `window`, not the iframe element, because that is
 * where the listener is attached; `source` has to be the iframe's own
 * `contentWindow` (the listener's identity gate) and `origin` has to match
 * `PROJECT.prototypeOrigin` (its origin gate).
 */
function sendBridgeReady(iframe: HTMLIFrameElement): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "desde-bridge", type: "BRIDGE_READY" },
        origin: PROJECT.prototypeOrigin as string,
        source: iframe.contentWindow,
      }),
    )
  })
}

describe("review shell — an embedded server prototype's retryable crash", () => {
  it("remounts the iframe and refreshes the router on the first poll", async () => {
    vi.useFakeTimers()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    const before = document.querySelector("iframe")
    expect(before, "no iframe rendered — the shell changed shape").not.toBeNull()

    // The embedded poll's fast cadence (`EMBEDDED_FAST_POLL_MS` in
    // `use-process-recovery.ts`) is 5s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    const after = document.querySelector("iframe")
    expect(after, "no iframe rendered after the poll").not.toBeNull()
    // The DOM node itself must be a different object — a `src` that merely
    // stayed the same string would not have re-fetched anything.
    expect(after).not.toBe(before)
    expect(refresh).toHaveBeenCalled()
  })

  /**
   * Codex round 7, Fix 5. `prototypeVisible` used to be `prototypeLoaded ||
   * bridgeReadyEpoch > 0`. `bridgeReadyEpoch` only ever goes up — it is never
   * reset — so once the ORIGINAL frame's bridge had said hello even once,
   * the loading overlay was gone for good: after a round-5 remount the
   * REPLACEMENT frame is a cold start with no bridge yet, but
   * `bridgeReadyEpoch` was already positive from the old frame, and the
   * overlay never came back to say so.
   *
   * This test fails against the pre-fix code: the overlay stays hidden after
   * the remount even though the new frame has said nothing yet.
   */
  it("shows the loading overlay again after a remount, even though the old frame's bridge had already said hello", async () => {
    vi.useFakeTimers()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    const before = document.querySelector("iframe")
    expect(before, "no iframe rendered — the shell changed shape").not.toBeNull()
    expect(document.querySelector('[data-testid="prototype-loader"]'), "loader missing before any signal").not.toBeNull()

    // The original frame's bridge says hello, clearing the overlay.
    sendBridgeReady(before as HTMLIFrameElement)
    expect(document.querySelector('[data-testid="prototype-loader"]'), "loader did not clear on BRIDGE_READY").toBeNull()

    // The embedded poll's first tick remounts the frame (same trigger as the
    // first test above).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    const after = document.querySelector("iframe")
    expect(after).not.toBe(before)
    // The replacement frame is a fresh cold start: nothing has loaded it and
    // its own bridge has not said hello yet, so the overlay must be back —
    // not stuck hidden on the strength of the OLD frame's epoch.
    expect(
      document.querySelector('[data-testid="prototype-loader"]'),
      "loader did not come back for the remounted frame",
    ).not.toBeNull()
  })
})
