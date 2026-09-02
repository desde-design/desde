/**
 * Behavior lock for `chat:navigate` — the load-gated state machine extracted
 * from `editor-surface.tsx` in Task 21 (editor-audit-fixes-plan).
 *
 * The agent's `navigate` tool and the deterministic screenshot-plan replay both
 * depend on the EXACT semantics asserted here: the same-page short circuit, the
 * post-load correlation guard (a `ROUTE_CHANGED` still queued from the OLD page
 * must not settle the navigation), the hash-only same-document path, the 2s
 * post-load best-effort settle, the 15s ceiling, and the abort/error strings.
 * These had no unit coverage before the extraction — this is the regression net
 * that proves the move was behavior-preserving.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useEditorBridgeHandlers } from "./useEditorBridgeHandlers"
import { useAppStore } from "@/stores"

const CANONICAL = "http://localhost:5173/"

/**
 * Minimal iframe stand-in: a real EventTarget (so add/removeEventListener and
 * dispatchEvent behave) plus a plain `src` property. A jsdom <iframe> would
 * kick off its own navigation on `src` writes and fire `load` on its own
 * schedule, which is exactly the timing this suite is asserting.
 */
function makeIframe(src = CANONICAL): HTMLIFrameElement {
  const el = new EventTarget() as unknown as HTMLIFrameElement
  ;(el as unknown as { src: string }).src = src
  // S10: the ROUTE_CHANGED listener now authenticates `event.source` against
  // the frame's content window, so the stand-in needs one to stand for.
  ;(el as unknown as { contentWindow: object }).contentWindow = {
    postMessage() {},
  }
  return el
}

function contentWindowOf(iframe: HTMLIFrameElement): Window {
  return (iframe as unknown as { contentWindow: Window }).contentWindow
}

function srcOf(iframe: HTMLIFrameElement): string {
  return (iframe as unknown as { src: string }).src
}

function renderHandlers(iframe: HTMLIFrameElement | null) {
  const ref = { current: iframe }
  const { result } = renderHook(() =>
    useEditorBridgeHandlers({
      iframeRef: ref,
      prototypeUrl: CANONICAL,
      editorSelection: null,
      supportsRenderedValueRead: () => true,
      supportsMeasurementsRead: () => true,
      selectMany: async () => [],
      captureScreenshot: async () => ({
        ok: false,
        reason: "timeout",
        message: "unused",
      }),
      semanticTarget: {
        resolveTarget: async () => null,
        performInteract: async () => null,
      },
      readRenderedValue: async () => null,
      readMeasurements: async () => null,
    }),
  )
  return (payload: unknown, signal?: AbortSignal) =>
    result.current.bridgeHandlers["chat:navigate"](payload, signal)
}

/**
 * Emit the bridge's ROUTE_CHANGED as if it genuinely came from `iframe`.
 *
 * S10: the handler no longer trusts the `source` marker inside the payload —
 * it requires `event.source === iframe.contentWindow` and an `event.origin`
 * matching the document it was told to load. Both are stamped here; the old
 * source-less, origin-less event this helper used to build is now correctly
 * rejected.
 */
function emitRouteChanged(iframe: HTMLIFrameElement, url: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "desde-bridge", type: "ROUTE_CHANGED", payload: { url } },
      source: contentWindowOf(iframe),
      origin: new URL(url).origin,
    }),
  )
}

beforeEach(() => {
  useAppStore.setState({
    currentPageUrl: null,
    currentDisplayRoute: null,
    currentSourceFile: null,
  })
})
afterEach(() => vi.useRealTimers())

describe("chat:navigate — argument validation", () => {
  it("refuses an empty route", async () => {
    const navigate = renderHandlers(makeIframe())
    await expect(navigate({ route: "  " })).resolves.toEqual({
      ok: false,
      error: "navigate requires a non-empty { route }.",
    })
  })

  it("refuses an unparseable route", async () => {
    const navigate = renderHandlers(makeIframe())
    useAppStore.getState().setCurrentPageInfo(null, "not-a-url")
    await expect(navigate({ route: "/next" })).resolves.toEqual({
      ok: false,
      error: "navigate: '/next' is not a valid route.",
    })
  })

  it("refuses when the iframe is not mounted", async () => {
    const navigate = renderHandlers(null)
    await expect(navigate({ route: "/next" })).resolves.toEqual({
      ok: false,
      error: "navigate: iframe is not mounted.",
    })
  })
})

describe("chat:navigate — same-page short circuit", () => {
  it("reports alreadyThere without touching the iframe", async () => {
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/reports?tab=a")

    await expect(navigate({ route: "/reports?tab=a" })).resolves.toEqual({
      ok: true,
      output: { route: "/reports?tab=a", alreadyThere: true },
    })
    expect(srcOf(iframe)).toBe(CANONICAL)
  })

  it("does NOT short-circuit a query-only change on the same pathname", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/search?q=old")

    const p = navigate({ route: "/search?q=new" })
    expect(srcOf(iframe)).toBe("http://localhost:5173/search?q=new")

    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      emitRouteChanged(iframe, "http://localhost:5173/search?q=new")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/search?q=new", alreadyThere: false },
    })
  })
})

describe("chat:navigate — load gate", () => {
  it("IGNORES a ROUTE_CHANGED that arrives before the iframe load", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/b" })
    let settled = false
    void p.then(() => {
      settled = true
    })

    // A stale ROUTE_CHANGED still queued from the OLD page.
    await act(async () => {
      emitRouteChanged(iframe, "http://localhost:5173/a")
    })
    expect(settled).toBe(false)

    // Now the real navigation lands.
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      emitRouteChanged(iframe, "http://localhost:5173/b")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/b", alreadyThere: false },
    })
  })

  it("adopts the route the bridge actually reports (router redirect)", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/private" })
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      emitRouteChanged(iframe, "http://localhost:5173/login?next=/private")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/login?next=/private", alreadyThere: false },
    })
  })

  // S10 — the payload's `source` marker is forgeable by any window, so the
  // load gate is not the only thing standing between a hostile frame and the
  // agent's idea of where it is. Both halves of the guard are locked here.
  it("IGNORES a ROUTE_CHANGED from a DIFFERENT window, then accepts the real one", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/b" })
    let settled = false
    void p.then(() => {
      settled = true
    })

    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      // Perfect envelope, right origin — wrong sender.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "desde-bridge",
            type: "ROUTE_CHANGED",
            payload: { url: "https://evil.example/pwned" },
          },
          source: { postMessage() {} } as unknown as Window,
          origin: "http://localhost:5173",
        }),
      )
    })
    expect(settled).toBe(false)

    await act(async () => {
      emitRouteChanged(iframe, "http://localhost:5173/b")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/b", alreadyThere: false },
    })
  })

  it("IGNORES a ROUTE_CHANGED from the right window at the WRONG origin", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/b" })
    let settled = false
    void p.then(() => {
      settled = true
    })

    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      // The frame relocated itself: `contentWindow` is stable across
      // navigation, so only the origin half catches this.
      emitRouteChanged(iframe, "https://evil.example/pwned")
    })
    expect(settled).toBe(false)

    await act(async () => {
      emitRouteChanged(iframe, "http://localhost:5173/b")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/b", alreadyThere: false },
    })
  })

  it("settles best-effort 2s after load when no ROUTE_CHANGED ever arrives", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/b" })
    await act(async () => {
      iframe.dispatchEvent(new Event("load"))
      await vi.advanceTimersByTimeAsync(2_000)
    })

    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/b", alreadyThere: false },
    })
    // The top-level ROUTE_CHANGED listener never ran, so the handler itself
    // must have refreshed the current-page slice.
    expect(useAppStore.getState().currentPageUrl).toBe("http://localhost:5173/b")
  })

  it("opens the gate immediately for a hash-only (same-document) nav", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/p")

    // No `load` event is dispatched — a fragment nav fires none.
    const p = navigate({ route: "/p#reviews" })
    await act(async () => {
      emitRouteChanged(iframe, "http://localhost:5173/p#reviews")
    })
    await expect(p).resolves.toEqual({
      ok: true,
      output: { route: "/p#reviews", alreadyThere: false },
    })
  })
})

describe("chat:navigate — origin pinning + failure paths", () => {
  it("pins an absolute route onto the LIVE origin", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://127.0.0.1:6001/a")

    void navigate({ route: "https://canonical.example/deep?x=1" })
    expect(srcOf(iframe)).toBe("http://127.0.0.1:6001/deep?x=1")
  })

  it("falls back to the iframe's own src before any ROUTE_CHANGED", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe("http://127.0.0.1:6001/start")
    const navigate = renderHandlers(iframe)

    void navigate({ route: "/next" })
    expect(srcOf(iframe)).toBe("http://127.0.0.1:6001/next")
  })

  it("times out after 15s with the no-load error", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")

    const p = navigate({ route: "/b" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    await expect(p).resolves.toEqual({
      ok: false,
      error: "navigation to '/b' timed out (no load).",
    })
  })

  it("resolves as aborted when the turn signal fires", async () => {
    vi.useFakeTimers()
    const iframe = makeIframe()
    const navigate = renderHandlers(iframe)
    useAppStore.getState().setCurrentPageInfo(null, "http://localhost:5173/a")
    const controller = new AbortController()

    const p = navigate({ route: "/b" }, controller.signal)
    await act(async () => {
      controller.abort()
    })
    await expect(p).resolves.toEqual({ ok: false, error: "navigation aborted" })
  })
})

describe("ask_user_question", () => {
  it("surfaces the pending question and resolves on answer", async () => {
    const ref = { current: makeIframe() }
    const { result } = renderHook(() =>
      useEditorBridgeHandlers({
        iframeRef: ref,
        prototypeUrl: CANONICAL,
        editorSelection: null,
        supportsRenderedValueRead: () => true,
        supportsMeasurementsRead: () => true,
        selectMany: async () => [],
        captureScreenshot: async () => ({
          ok: false,
          reason: "timeout",
          message: "unused",
        }),
        semanticTarget: {
          resolveTarget: async () => null,
          performInteract: async () => null,
        },
        readRenderedValue: async () => null,
        readMeasurements: async () => null,
      }),
    )

    let answered: unknown
    await act(async () => {
      void result.current.bridgeHandlers
        .ask_user_question({ question: "Which?", options: ["a", "b"] })
        .then((r) => {
          answered = r
        })
    })
    expect(result.current.pendingQuestion?.question).toBe("Which?")

    await act(async () => {
      result.current.pendingQuestion?.resolve({
        ok: true,
        output: { selected: ["a"] },
      })
    })
    expect(answered).toEqual({ ok: true, output: { selected: ["a"] } })
    expect(result.current.pendingQuestion).toBeNull()
  })

  it("dismisses a prior pending question when a second arrives", async () => {
    const ref = { current: makeIframe() }
    const { result } = renderHook(() =>
      useEditorBridgeHandlers({
        iframeRef: ref,
        prototypeUrl: CANONICAL,
        editorSelection: null,
        supportsRenderedValueRead: () => true,
        supportsMeasurementsRead: () => true,
        selectMany: async () => [],
        captureScreenshot: async () => ({
          ok: false,
          reason: "timeout",
          message: "unused",
        }),
        semanticTarget: {
          resolveTarget: async () => null,
          performInteract: async () => null,
        },
        readRenderedValue: async () => null,
        readMeasurements: async () => null,
      }),
    )

    let first: unknown
    await act(async () => {
      void result.current.bridgeHandlers
        .ask_user_question({ question: "First?", options: ["a"] })
        .then((r) => {
          first = r
        })
    })
    await act(async () => {
      void result.current.bridgeHandlers.ask_user_question({
        question: "Second?",
        options: ["b"],
      })
    })

    expect(first).toEqual({ ok: false, error: "user dismissed the question" })
    expect(result.current.pendingQuestion?.question).toBe("Second?")
  })
})
