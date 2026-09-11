// @vitest-environment jsdom

/**
 * `useLivePrototypeOrigin` — the review page's follow of the process-state
 * stream (`GET /api/v1/projects/:id/prototype-origin/stream`, Task 6).
 *
 * The page used to resolve the process once, server-side, and patch around it
 * with polls, a router refresh and a frame-epoch counter. This hook replaces
 * all of that: the server pushes a new body, the hook keeps the latest one,
 * and the page re-decides what to show from it.
 *
 * Three properties, which are the whole contract:
 *
 * 1. Before the first event it answers the server-rendered body, so the first
 *    paint is not a blank while the stream connects.
 * 2. The LATEST event wins, so a restart is reflected rather than merged.
 * 3. It closes the source on unmount, so leaving the page does not leave a
 *    stream open against the server's per-client connection cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useLivePrototypeOrigin } from "../review/use-live-prototype-origin"
import type { ReviewEmbedOrigin } from "../review/[slug]/prototype-origin-response"
import {
  installFakeEventSource,
  latestEventSource,
  openEventSources,
} from "../review/__tests__/fake-event-source"

const PROJECT_ID = "proj-live"

const INITIAL: ReviewEmbedOrigin = {
  mode: "loopback",
  origin: "http://127.0.0.1:4321",
  serve: "server",
  process: { state: "running", port: 4321, since: "2026-09-11T00:00:00.000Z", generation: 1 },
  range: null,
}

function loopbackBody(process: unknown): unknown {
  return { mode: "loopback", origin: "http://127.0.0.1:4321", serve: "server", process, range: null }
}

afterEach(() => {
  cleanup()
})

describe("useLivePrototypeOrigin", () => {
  it("answers the initial body until the first event arrives", () => {
    installFakeEventSource()
    const { result } = renderHook(() => useLivePrototypeOrigin(PROJECT_ID, INITIAL))

    expect(result.current).toBe(INITIAL)
    // And it opened the stream for THIS project, not the plain route.
    expect(latestEventSource()?.url).toBe(
      `/api/v1/projects/${PROJECT_ID}/prototype-origin/stream`,
    )
  })

  it("does nothing at all when the environment has no EventSource", () => {
    // A server render, and any host without one. The hook must answer the
    // initial body rather than throw.
    vi.stubGlobal("EventSource", undefined)
    const { result } = renderHook(() => useLivePrototypeOrigin(PROJECT_ID, INITIAL))
    expect(result.current).toBe(INITIAL)
  })

  it("takes the latest origin event, replacing the one before it", () => {
    installFakeEventSource()
    const { result } = renderHook(() => useLivePrototypeOrigin(PROJECT_ID, INITIAL))
    const source = latestEventSource()
    expect(source).toBeDefined()

    act(() => {
      source?.dispatch(
        "origin",
        loopbackBody({ state: "crashed", exitCode: 1, restarts: 1, reason: "It exited.", retryable: true }),
      )
    })
    expect(result.current.process?.state).toBe("crashed")

    act(() => {
      source?.dispatch(
        "origin",
        loopbackBody({ state: "running", port: 4322, since: "2026-09-11T00:01:00.000Z", generation: 2 }),
      )
    })
    const process = result.current.process
    expect(process?.state).toBe("running")
    expect(process?.state === "running" ? process.generation : null).toBe(2)
  })

  it("keeps the body it has when an event carries something it cannot parse", () => {
    installFakeEventSource()
    const { result } = renderHook(() => useLivePrototypeOrigin(PROJECT_ID, INITIAL))
    const source = latestEventSource()

    act(() => {
      source?.dispatch(
        "origin",
        loopbackBody({ state: "running", port: 4322, since: "2026-09-11T00:01:00.000Z", generation: 2 }),
      )
    })
    const afterGoodEvent = result.current

    // A body the parser collapses to its fallback shape would blank the page's
    // whole decision, so an unusable event is dropped instead.
    act(() => {
      source?.dispatch("origin", "not an object")
    })
    expect(result.current).toBe(afterGoodEvent)
  })

  it("closes the stream when the component unmounts", () => {
    installFakeEventSource()
    const { unmount } = renderHook(() => useLivePrototypeOrigin(PROJECT_ID, INITIAL))
    expect(openEventSources("/prototype-origin/stream")).toHaveLength(1)

    unmount()
    expect(openEventSources("/prototype-origin/stream")).toHaveLength(0)
  })
})
