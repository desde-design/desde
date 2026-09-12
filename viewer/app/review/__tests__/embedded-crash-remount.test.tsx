// @vitest-environment jsdom

/**
 * The review shell follows the process-state stream, and the iframe is keyed
 * on the process generation.
 *
 * What this replaces: the shell used to resolve the process ONCE, server-side,
 * then poll the plain prototype-origin route, call `router.refresh()` on a
 * crash, and bump its own `frameEpoch` counter to force the frame to remount
 * (because a refresh alone left React holding the same DOM node — the one
 * already showing the proxy's error page). Codex rounds 2, 4, 5 and 7 each
 * found a defect in one of those pieces.
 *
 * Now the server pushes a new body and the page re-decides from it:
 *
 * - a new `generation` on a running process is a NEW child, so the frame is
 *   keyed on it and React discards the stale DOM node by itself;
 * - a crashed body shows the crashed panel with no page refresh at all;
 * - a running body after that shows the frame again.
 *
 * The loading overlay follows the same key: the bridge hook records the
 * generation it said hello under, so a freshly mounted frame is "not visible
 * yet" even though the frame it replaced had already announced itself.
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
import { installFakeEventSource, openEventSources } from "./fake-event-source"
import type { ProcessStatus } from "../../../server/serve/prototype-processes"

// Mocked so the test can assert the router is NOT asked to refresh any more.
// `useRouterRefresh` falls back to a no-op with no App Router context around
// the tree, which would make "never called" true for the wrong reason.
// `vi.hoisted` because the factory below runs before this module's own
// top-level `const`s exist.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}))

const PROJECT_ID = "proj-embedded-crash"
/** The deployment the page below was server-rendered against. */
const DEPLOYMENT_ID = "dep-1"

const RUNNING_GENERATION_1: ProcessStatus = {
  state: "running",
  port: 4321,
  since: "2026-09-10T00:00:00.000Z",
  generation: 1,
}

const RUNNING_GENERATION_2: ProcessStatus = {
  state: "running",
  port: 4321,
  since: "2026-09-10T00:02:00.000Z",
  generation: 2,
}

/** The same child as `RUNNING_GENERATION_2`, still coming up. */
const STARTING_GENERATION_2: ProcessStatus = { state: "starting", generation: 2 }

/** Generation 1 died and the manager would try again: the page keeps the frame, keyed on the start to come. */
const RETRYABLE_CRASH_OF_1: ProcessStatus = {
  state: "crashed",
  exitCode: 143,
  restarts: 1,
  reason: "The server exited.",
  retryable: true,
  generation: 1,
}

const PERMANENT_CRASH: ProcessStatus = {
  state: "crashed",
  exitCode: 1,
  restarts: 3,
  reason: "The server kept exiting.",
  retryable: false,
  generation: 1,
}

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
  process: RUNNING_GENERATION_1,
  range: null,
  deploymentId: DEPLOYMENT_ID,
}

/**
 * One `origin` body, the way the route sends it. `origin` and `deploymentId`
 * both default to what the page was server-rendered with, so a test only
 * states the one it is about.
 */
function loopbackBody(
  process: ProcessStatus,
  body: { origin?: string | null; deploymentId?: string } = {},
): unknown {
  return {
    mode: "loopback",
    origin: body.origin === undefined ? PROJECT.prototypeOrigin : body.origin,
    serve: "server",
    process,
    range: null,
    deploymentId: body.deploymentId ?? DEPLOYMENT_ID,
  }
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

/** The shell's own origin stream, as this test drives it. */
function stream() {
  const [source] = openEventSources("/prototype-origin/stream")
  if (!source) throw new Error("the review shell opened no prototype-origin stream")
  return source
}

/** Push one `origin` event, the way the route sends it. */
function pushOrigin(
  process: ProcessStatus,
  body: { origin?: string | null; deploymentId?: string } = {},
): void {
  act(() => {
    stream().dispatch("origin", loopbackBody(process, body))
  })
}

/**
 * The bridge protocol's `BRIDGE_READY`, as the shell's own listener
 * (`use-viewer-bridge.ts`) would see it arrive from the real iframe.
 * Dispatched on `window`, where the listener is attached; `source` has to be
 * the iframe's own `contentWindow` (the identity gate) and `origin` has to
 * match the prototype's origin (the origin gate).
 *
 * `source` is defined onto the event rather than passed to the constructor
 * because jsdom refuses anything but a real `WindowProxy` in the init dict.
 */
function sendBridgeReady(iframe: HTMLIFrameElement): void {
  const event = new MessageEvent("message", {
    data: { source: "desde-bridge", type: "BRIDGE_READY" },
    origin: PROJECT.prototypeOrigin as string,
  })
  Object.defineProperty(event, "source", { value: iframe.contentWindow })
  act(() => {
    window.dispatchEvent(event)
  })
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector("iframe")
}

afterEach(() => {
  cleanup()
  // One mock for the whole file, so a test that expects no refresh must not
  // inherit a call from the test before it.
  refresh.mockClear()
})

describe("review shell — following the process-state stream", () => {
  it("remounts the iframe when the process comes back under a new generation", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    const before = frame()
    expect(before, "no iframe rendered — the shell changed shape").not.toBeNull()

    // The same generation the page rendered under: nothing has restarted, so
    // the frame must be left alone.
    pushOrigin(RUNNING_GENERATION_1)
    expect(frame(), "the frame remounted for a body that changed nothing").toBe(before)

    // A new child. The DOM node itself has to be a different object — a `src`
    // that merely stayed the same string would re-fetch nothing.
    pushOrigin(RUNNING_GENERATION_2)
    const after = frame()
    expect(after, "no iframe rendered after the restart").not.toBeNull()
    expect(after).not.toBe(before)
  })

  /**
   * A cold start is ONE new child, so it is one remount. The status used to
   * carry no generation while `starting`, so the shell keyed that body on
   * the constant `"static"`: the frame remounted when the start began and
   * again when it finished, and the second remount threw away the frame that
   * had just loaded the app it was waiting for.
   */
  it("does not remount the frame when the child it is waiting on comes up", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    pushOrigin(STARTING_GENERATION_2)
    const starting = frame()
    expect(starting, "no iframe rendered while the process was starting").not.toBeNull()

    pushOrigin(RUNNING_GENERATION_2)
    expect(frame(), "the frame remounted for the child it was already waiting on").toBe(starting)
  })

  /**
   * A retryable crash is one restart, so it is one remount: the crashed body
   * keys the frame on the generation the restart will have, and the
   * `starting` and `running` bodies that follow carry that same generation.
   * Keying the crash on a constant remounted twice, and the first of those
   * frames' request was still waiting on the cold start when the second
   * threw it away (live run, 2026-09-11).
   */
  it("remounts the frame exactly once across a retryable crash and the restart that follows", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )
    const before = frame()
    expect(before).not.toBeNull()

    pushOrigin(RETRYABLE_CRASH_OF_1)
    const afterCrash = frame()
    expect(afterCrash, "a retryable crash must keep a frame up, since its request is the restart").not.toBeNull()
    expect(afterCrash).not.toBe(before)

    pushOrigin(STARTING_GENERATION_2)
    expect(frame(), "the frame remounted again when the restart began").toBe(afterCrash)

    pushOrigin(RUNNING_GENERATION_2)
    expect(frame(), "the frame remounted again when the restart finished").toBe(afterCrash)
    expect(refresh).not.toHaveBeenCalled()
  })

  /**
   * The live body decides where the frame POINTS, not just whether there is
   * one. `embedTarget` used to be built from the server-rendered prop, so a
   * rebuild that opened a listener on a new port remounted the frame onto the
   * old one — a port whose listener is gone.
   */
  it("points the frame at the origin the live body names", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )
    expect(frame()?.getAttribute("src")).toBe(`${PROJECT.prototypeOrigin}/`)

    pushOrigin(RUNNING_GENERATION_2, { origin: "http://127.0.0.1:4499" })

    expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:4499/")
  })

  /**
   * The idle reaper stops a child on purpose. A remount here would send a
   * request that starts it again, so an open tab would rotate cold starts
   * for ever and the reaper would never win (final review, N1). The frame
   * keeps its document; the next click in it restarts the child.
   */
  it("keeps the frame when the process is stopped by the reaper", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )
    const before = frame()
    pushOrigin({ state: "stopped" })
    expect(frame(), "the frame remounted for a stopped body, which would restart the child").toBe(before)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("shows the crashed panel for a crashed body, without refreshing the page", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )
    expect(frame()).not.toBeNull()

    pushOrigin(PERMANENT_CRASH)

    expect(document.querySelector('[data-testid="prototype-crashed"]')).not.toBeNull()
    expect(frame(), "the frame stayed up next to the crashed panel").toBeNull()
    // The whole point of the stream: the panel swaps in from client state, so
    // nothing asks Next to re-render the page.
    expect(refresh).not.toHaveBeenCalled()
  })

  it("shows the frame again once the process is running after a crash", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    pushOrigin(PERMANENT_CRASH)
    expect(document.querySelector('[data-testid="prototype-crashed"]')).not.toBeNull()

    pushOrigin(RUNNING_GENERATION_2)
    expect(document.querySelector('[data-testid="prototype-crashed"]')).toBeNull()
    expect(frame(), "the frame did not come back for the restarted process").not.toBeNull()
    expect(refresh).not.toHaveBeenCalled()
  })

  /**
   * A NEW DEPLOYMENT is the one thing client state cannot absorb.
   *
   * Everything else the stream reports is a fact about the same build, and the
   * page re-decides from it with no server round trip — that is the whole
   * point of the stream, and the tests above assert `refresh` is never called
   * for any of it. A new deployment is different: on a private prototype the
   * capability in the iframe's URL was minted server-side for the PREVIOUS
   * deployment, and only the server can mint the next one. Two server builds
   * can also both be at generation 1, and a static rebuild has no process at
   * all, so neither the generation nor the origin can stand in for the
   * deployment's identity.
   */
  it("asks the router to re-render once when the live body names a new deployment", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    pushOrigin(RUNNING_GENERATION_1, { deploymentId: "dep-2" })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("does not re-render for a body naming the deployment the page was rendered with", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    pushOrigin(RUNNING_GENERATION_1)
    pushOrigin(RUNNING_GENERATION_2)

    expect(refresh).not.toHaveBeenCalled()
  })

  /**
   * The stream keeps sending bodies for the new deployment — a heartbeat
   * re-resolve, every later process transition — and the page goes on
   * rendering with the old `initial` until Next hands it a new one. Without a
   * guard, each of those bodies would ask for another refresh.
   */
  it("does not re-render again for a repeat of the same new deployment", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    pushOrigin(RUNNING_GENERATION_1, { deploymentId: "dep-2" })
    pushOrigin(RUNNING_GENERATION_2, { deploymentId: "dep-2" })
    pushOrigin(RUNNING_GENERATION_2, { deploymentId: "dep-2" })

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  /**
   * The refresh above is only half of what a new deployment needs. A rebuild
   * can leave the iframe's URL byte-identical — a static prototype's path
   * never names the deployment, a subdomain is one string for every build —
   * and `router.refresh()` keeps this client component and its DOM, so React
   * reuses the same iframe node and the browser never requests the new build.
   * The key has to move as well.
   */
  it("remounts the frame for a new deployment reporting the same generation", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    const before = frame()
    expect(before).not.toBeNull()

    pushOrigin(RUNNING_GENERATION_1, { deploymentId: "dep-2" })

    const after = frame()
    expect(after, "no iframe rendered after the rebuild").not.toBeNull()
    expect(after, "the frame kept the previous deployment's DOM node").not.toBe(before)
  })

  /** A static prototype has no process at all, so only the deployment can say a rebuild happened. */
  it("remounts the frame for a new static deployment", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={{ ...PROJECT, serve: "static", process: undefined }} />
      </Scenario>,
    )

    const before = frame()
    expect(before).not.toBeNull()

    act(() => {
      stream().dispatch("origin", {
        mode: "loopback",
        origin: PROJECT.prototypeOrigin,
        serve: "static",
        range: null,
        deploymentId: "dep-2",
      })
    })

    const after = frame()
    expect(after, "no iframe rendered after the static rebuild").not.toBeNull()
    expect(after, "the frame kept the previous static build's DOM node").not.toBe(before)
  })

  /**
   * Codex round 7, Fix 5, carried over to the generation. `prototypeVisible`
   * used to read a bridge-ready counter that only ever went up, so once the
   * ORIGINAL frame's bridge had said hello the overlay was gone for good —
   * including over a replacement frame that was still cold-starting. The
   * bridge hook now records WHICH generation it said hello under, and the
   * shell compares that against the generation on screen.
   */
  it("brings the loading overlay back for the replacement frame", () => {
    installFakeEventSource()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    const before = frame()
    expect(before).not.toBeNull()
    expect(
      document.querySelector('[data-testid="prototype-loader"]'),
      "loader missing before any signal",
    ).not.toBeNull()

    sendBridgeReady(before as HTMLIFrameElement)
    expect(
      document.querySelector('[data-testid="prototype-loader"]'),
      "loader did not clear on BRIDGE_READY",
    ).toBeNull()

    pushOrigin(RUNNING_GENERATION_2)
    const after = frame()
    expect(after).not.toBe(before)
    expect(
      document.querySelector('[data-testid="prototype-loader"]'),
      "loader did not come back for the remounted frame",
    ).not.toBeNull()

    // And it clears again on the NEW frame's own handshake.
    sendBridgeReady(after as HTMLIFrameElement)
    expect(
      document.querySelector('[data-testid="prototype-loader"]'),
      "loader did not clear for the replacement frame's own handshake",
    ).toBeNull()
  })
})
