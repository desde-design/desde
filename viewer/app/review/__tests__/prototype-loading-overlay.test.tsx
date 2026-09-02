// @vitest-environment jsdom

/**
 * The "Loading" overlay must clear on the bridge handshake, not only on the
 * iframe's own load event.
 *
 * MEASURED 2026-09-01: Mo opened the demo project and got a spinner that
 * never went away, over a prototype that had loaded perfectly and was posting
 * `DOM_MUTATED` to the shell the whole time. A `PING` into that same frame
 * answered `BRIDGE_READY` instantly.
 *
 * The cause is a race the load event cannot recover from. This `<iframe>` is
 * part of the SSR'd HTML, so the browser starts fetching the prototype while
 * the shell document is still parsing. If the frame finishes before React
 * hydrates and attaches `onLoad`, that event fired at nobody: there is no
 * replay, and cross-origin rules out reading `contentDocument.readyState`
 * afterwards. `bridge-protocol.md` documents the identical race for
 * `BRIDGE_READY` and closes it with a PING on mount, which the overlay now
 * borrows.
 *
 * The first test below fails against the pre-fix code, where the overlay was
 * gated on `onLoad` alone: nothing ever fires it here, on purpose.
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { ReviewShell, type ReviewShellProject } from "../[slug]/review-shell"
import { BRIDGE_READY, PROTOTYPE_ORIGIN } from "./fake-bridge-frame"

const PROJECT_ID = "proj-loading"

const PROJECT: ReviewShellProject = {
  id: PROJECT_ID,
  slug: "demo",
  name: "Demo project",
  access: "public-link",
  publicLinksEnabled: true,
  serveDomain: null,
  capability: null,
  shellOrigin: "http://localhost:3130",
  prototypeOrigin: PROTOTYPE_ORIGIN,
  mode: "loopback",
}

const ROUTES: Record<string, FetchOverrideResult | (() => FetchOverrideResult)> = {
  [`GET /api/v1/projects/${PROJECT_ID}/comments`]: ok({ comments: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/members`]: ok({ members: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/participants`]: ok({ participants: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}`]: ok({ project: { id: PROJECT_ID, name: PROJECT.name } }),
}

function Scenario({ children }: { children: ReactNode }): ReactNode {
  useFetchOverride(routeTable(ROUTES))
  return children
}

/**
 * A `BRIDGE_READY` exactly as the bridge posts it: from the prototype's
 * origin, and with `event.source` set to the frame the hook is watching.
 * Both gates are real (`use-viewer-bridge.ts`), so a message missing either
 * one is dropped and the test would pass for the wrong reason.
 *
 * `source` is defined onto the event rather than passed to the constructor
 * because jsdom refuses anything but a real `WindowProxy` in the init dict.
 */
function postBridgeReady(): void {
  const frame = document.querySelector("iframe")
  if (!frame) throw new Error("no iframe rendered — the shell changed shape")
  const event = new MessageEvent("message", {
    data: BRIDGE_READY,
    origin: PROTOTYPE_ORIGIN,
  })
  Object.defineProperty(event, "source", { value: frame.contentWindow })
  window.dispatchEvent(event)
}

afterEach(() => {
  cleanup()
})

describe("review shell — the prototype loading overlay", () => {
  it("clears on BRIDGE_READY even when the iframe load event never reaches React", async () => {
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    // The overlay is up before anything reports in. Nothing in this test ever
    // fires `onLoad`, which is precisely the shipped failure: the frame had
    // already loaded before hydration, so the event was lost.
    expect(screen.queryByTestId("prototype-loader")).not.toBeNull()

    postBridgeReady()

    await waitFor(() => {
      expect(screen.queryByTestId("prototype-loader")).toBeNull()
    })
  })

  it("still clears on the iframe load event, for a prototype whose bridge never boots", async () => {
    // A strict CSP or an older bundle can leave the bridge silent. That
    // prototype still renders, so the frame's own event has to keep working
    // as a signal in its own right rather than being replaced.
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    expect(screen.queryByTestId("prototype-loader")).not.toBeNull()

    const frame = document.querySelector("iframe")
    expect(frame).not.toBeNull()
    frame?.dispatchEvent(new Event("load"))

    await waitFor(() => {
      expect(screen.queryByTestId("prototype-loader")).toBeNull()
    })
  })
})
