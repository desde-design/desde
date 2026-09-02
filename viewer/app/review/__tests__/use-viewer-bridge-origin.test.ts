// @vitest-environment jsdom

/**
 * The shell's postMessage origin discipline, in both directions.
 *
 * ## Outbound: why `"*"` had to stop being unconditional
 *
 * The hook used to post every message with `targetOrigin: "*"`, justified on
 * the grounds that a path-mode prototype is sandboxed without
 * `allow-same-origin`, so its document has an OPAQUE origin — and an opaque
 * origin has no serialization that could be named as a `targetOrigin`. That
 * reasoning is still correct, and it is still the reason `"*"` survives in
 * fallback mode.
 *
 * It stops being correct the moment the frame has a REAL origin, which is
 * exactly what prototype-origin isolation gives it. From the adversarial
 * review (`docs/superpowers/research/2026-08-22-prototype-origin-adversarial-
 * review.md`, "Attack 6"):
 *
 * 1. A prototype may always navigate ITSELF, including to
 *    `https://evil.example/collector`.
 * 2. `iframeRef.current.contentWindow` still points at the same frame
 *    afterwards, so the sender-identity gate below still matches and `"*"`
 *    still delivers.
 * 3. The shell keeps posting `SET_COMMENTS` on every change, and a `Comment`
 *    carries bodies, authors and `participantEmails` — verified GitHub
 *    addresses for a reviewer who may see them.
 *
 * So `"*"` exfiltrates every comment on the project to whatever the frame
 * navigated to. Naming the origin closes it: after such a navigation every
 * post silently fails, which is the wanted outcome.
 *
 * ## Inbound: the origin check is ADDED, never substituted
 *
 * `event.source === iframe.contentWindow` stays first and stays the primary
 * gate. It is the only check that survives the opaque-origin case, where
 * `event.origin` is the string `"null"` — shared verbatim by every sandboxed
 * frame, `data:` document and `blob:` document on the page, so it identifies
 * nothing. The origin check is a second gate for the isolated modes, where a
 * real origin exists and a frame that navigated away from it must stop being
 * heard.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useViewerBridge } from "../use-viewer-bridge"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PROTOTYPE_ORIGIN = "http://127.0.0.1:45001"

/**
 * A stand-in for `iframe.contentWindow` that records the `targetOrigin` of
 * every post, and can play the bridge's side back with a chosen `event.origin`.
 *
 * `MessageEvent.source` is a `WindowProxy` in the DOM's type world and jsdom
 * refuses a plain object in the constructor's init, so the event is built
 * first and `source` defined onto it — which is what the hook's identity gate
 * reads.
 */
function makeFakeFrame(): {
  contentWindow: { postMessage: (m: unknown, t: string) => void }
  posted: { type?: string; targetOrigin: string }[]
  emit: (data: unknown, origin: string) => void
} {
  const posted: { type?: string; targetOrigin: string }[] = []
  const contentWindow = {
    postMessage: (m: unknown, targetOrigin: string) => {
      posted.push({ ...(m as { type?: string }), targetOrigin })
    },
  }
  const emit = (data: unknown, origin: string): void => {
    const event = new MessageEvent("message", { data, origin })
    Object.defineProperty(event, "source", { value: contentWindow })
    window.dispatchEvent(event)
  }
  return { contentWindow, posted, emit }
}

function frameRef(frame: ReturnType<typeof makeFakeFrame>) {
  return { current: { contentWindow: frame.contentWindow } as unknown as HTMLIFrameElement }
}

const bridgeReady = { source: "desde-bridge", type: "BRIDGE_READY", payload: {} }

describe("useViewerBridge — outbound targetOrigin", () => {
  it("names the prototype origin in loopback mode, so a frame that navigates away stops receiving", () => {
    const frame = makeFakeFrame()
    renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" }),
    )

    expect(frame.posted.length).toBeGreaterThan(0)
    for (const message of frame.posted) {
      expect(message.targetOrigin).toBe(PROTOTYPE_ORIGIN)
    }
  })

  it("names the prototype origin in subdomain mode too", () => {
    const frame = makeFakeFrame()
    renderHook(() =>
      useViewerBridge(frameRef(frame), {
        prototypeOrigin: "https://acme.desde.test",
        mode: "subdomain",
      }),
    )

    expect(frame.posted.map((m) => m.targetOrigin)).toContain("https://acme.desde.test")
  })

  it("normalises the origin it was handed, so a trailing slash never becomes an unmatchable target", () => {
    const frame = makeFakeFrame()
    renderHook(() =>
      useViewerBridge(frameRef(frame), {
        prototypeOrigin: "http://127.0.0.1:45001/",
        mode: "loopback",
      }),
    )

    expect(frame.posted.map((m) => m.targetOrigin)).toContain(PROTOTYPE_ORIGIN)
  })

  it("keeps `\"*\"` in fallback mode, where the frame's opaque origin cannot be named", () => {
    const frame = makeFakeFrame()
    renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: null, mode: "fallback" }),
    )

    expect(frame.posted.map((m) => m.targetOrigin)).toContain("*")
  })

  // The case a mode check alone would get wrong. `mode: "loopback"` with no
  // origin is the "nothing built yet" answer, and `resolvePrototypeEmbed`
  // turns it into the same-host sandboxed embed — an opaque frame. Pinning a
  // name there would drop every message and leave the review surface dead,
  // which is the same class of failure the BRIDGE_READY race produced.
  it("keeps `\"*\"` when the mode is isolated but no origin was resolved", () => {
    const frame = makeFakeFrame()
    renderHook(() => useViewerBridge(frameRef(frame), { prototypeOrigin: null, mode: "loopback" }))

    expect(frame.posted.map((m) => m.targetOrigin)).toContain("*")
  })

  it("keeps `\"*\"` when the origin it was handed does not parse", () => {
    const frame = makeFakeFrame()
    renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: "not a url", mode: "loopback" }),
    )

    expect(frame.posted.map((m) => m.targetOrigin)).toContain("*")
  })
})

describe("useViewerBridge — inbound origin gate", () => {
  it("handles a message from the right source AND the pinned origin", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" }),
    )

    act(() => frame.emit(bridgeReady, PROTOTYPE_ORIGIN))

    expect(result.current.bridgeReadyEpoch).toBeGreaterThan(0)
  })

  // The frame navigated itself somewhere else. Identity still matches — it is
  // the same window handle — so this is exactly the case the origin gate was
  // added for.
  it("drops a message from the right source but a DIFFERENT origin", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" }),
    )

    act(() => frame.emit(bridgeReady, "https://evil.example"))

    expect(result.current.bridgeReadyEpoch).toBe(0)
  })

  // `"null"` is what an opaque origin serializes to, and in an isolated mode
  // the frame is NOT opaque — it has `allow-same-origin` on a real origin. A
  // message claiming otherwise is not the prototype we embedded.
  it("drops an opaque-origin message in an isolated mode", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" }),
    )

    act(() => frame.emit(bridgeReady, "null"))

    expect(result.current.bridgeReadyEpoch).toBe(0)
  })

  it("accepts the opaque origin in fallback mode — that IS the sandboxed prototype", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: null, mode: "fallback" }),
    )

    act(() => frame.emit(bridgeReady, "null"))

    expect(result.current.bridgeReadyEpoch).toBeGreaterThan(0)
  })

  // The pre-existing, uncontained degradation: a private prototype with no
  // capability gets no sandbox at all, so its frame is genuinely on the
  // shell's own origin and posts from it.
  it("accepts the shell's own origin in fallback mode — the unsandboxed degradation", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: null, mode: "fallback" }),
    )

    act(() => frame.emit(bridgeReady, window.location.origin))

    expect(result.current.bridgeReadyEpoch).toBeGreaterThan(0)
  })

  it("drops a third-party origin in fallback mode", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: null, mode: "fallback" }),
    )

    act(() => frame.emit(bridgeReady, "https://evil.example"))

    expect(result.current.bridgeReadyEpoch).toBe(0)
  })

  // The identity gate is still FIRST and still does the work no origin check
  // can: a same-origin opener or a sibling frame posting the right origin is
  // still not our iframe.
  it("still drops a right-origin message from the wrong source", () => {
    const frame = makeFakeFrame()
    const { result } = renderHook(() =>
      useViewerBridge(frameRef(frame), { prototypeOrigin: PROTOTYPE_ORIGIN, mode: "loopback" }),
    )

    act(() => {
      const event = new MessageEvent("message", { data: bridgeReady, origin: PROTOTYPE_ORIGIN })
      Object.defineProperty(event, "source", { value: { postMessage: () => {} } })
      window.dispatchEvent(event)
    })

    expect(result.current.bridgeReadyEpoch).toBe(0)
  })
})
