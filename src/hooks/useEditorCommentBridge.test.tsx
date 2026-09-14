import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useRef } from "react"
import { useEditorCommentBridge } from "./useEditorCommentBridge"
import { useAppStore } from "@/stores"

function makeIframeRef(src?: string): {
  ref: { current: HTMLIFrameElement | null }
  postMessage: ReturnType<typeof vi.fn>
  /** The fake `contentWindow` — pass to `emitBridgeMessage` so `event.source`
   *  matches what the hook authenticates against (S10). */
  contentWindow: object
} {
  const postMessage = vi.fn()
  const contentWindow = { postMessage }
  const fakeIframe = { contentWindow, src } as unknown as HTMLIFrameElement
  const ref = { current: fakeIframe }
  return { ref, postMessage, contentWindow }
}

/**
 * Dispatch a bridge message as if it genuinely came from `source` — the
 * iframe's `contentWindow`.
 *
 * S10: the hook no longer trusts the `source` marker inside the payload (any
 * window can write it), so it checks `event.source` against the iframe's
 * content window. A source-less MessageEvent — which is what this helper used
 * to build — is now correctly rejected, hence the added first argument on
 * every call below.
 */
function emitBridgeMessage(
  source: object,
  type: string,
  payload: Record<string, unknown>,
  origin?: string,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "desde-bridge", type, payload },
      source: source as Window,
      ...(origin === undefined ? {} : { origin }),
    }),
  )
}

beforeEach(() => {
  useAppStore.setState({
    activeCommentId: null,
    pendingPosition: null,
    popupAnchorRect: null,
    toolMode: "navigate",
  })
})

afterEach(() => {
  useAppStore.setState({
    activeCommentId: null,
    pendingPosition: null,
    popupAnchorRect: null,
    toolMode: "navigate",
  })
})

describe("useEditorCommentBridge", () => {
  // These two are pure senders now. The mode itself is owned by
  // `useEditorToolMode`, which calls them; writing it here as well would put
  // two authors on one mirror.
  it("enterCommentMode posts ENTER_COMMENT_MODE and leaves the mode to its owner", () => {
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.enterCommentMode()
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "ENTER_COMMENT_MODE" },
      "*",
    )
    expect(useAppStore.getState().toolMode).toBe("navigate")
  })

  it("exitCommentMode posts EXIT_COMMENT_MODE and leaves the mode to its owner", () => {
    const { ref, postMessage } = makeIframeRef()
    useAppStore.setState({ toolMode: "comment" })
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.exitCommentMode()
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "EXIT_COMMENT_MODE" },
      "*",
    )
    expect(useAppStore.getState().toolMode).toBe("comment")
  })

  // Drop path: Escape during placement. The bridge deactivates its own
  // placement overlay and posts EXIT_COMMENT_MODE back up. Nothing listened
  // for it before, so the shell kept claiming a mode the user had left.
  it("EXIT_COMMENT_MODE from the bridge drops the shell out of comment mode", () => {
    const { ref, contentWindow } = makeIframeRef()
    useAppStore.setState({ toolMode: "comment" })
    renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      emitBridgeMessage(contentWindow, "EXIT_COMMENT_MODE", {})
    })

    expect(useAppStore.getState().toolMode).toBe("navigate")
  })

  it("COMMENT_ANCHOR_STATUS populates offTargetCommentIds (unanchored + fallback)", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      emitBridgeMessage(contentWindow, "COMMENT_ANCHOR_STATUS", {
        unanchored: ["c1"],
        fallback: ["c2", "c3"],
      })
    })

    expect([...result.current.offTargetCommentIds].sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ])

    // A follow-up status with everything resolved clears the set.
    act(() => {
      emitBridgeMessage(contentWindow, "COMMENT_ANCHOR_STATUS", {
        unanchored: [],
        fallback: [],
      })
    })
    expect(result.current.offTargetCommentIds.size).toBe(0)
  })

  it("highlightComment, setShowResolved, setPinsHidden, syncComments post correct messages", () => {
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.highlightComment("c1")
      result.current.setShowResolved(true)
      result.current.setPinsHidden(false)
      result.current.syncComments([])
    })

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { type: "HIGHLIGHT_COMMENT", payload: { commentId: "c1" } },
      "*",
    )
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { type: "SET_SHOW_RESOLVED", payload: true },
      "*",
    )
    expect(postMessage).toHaveBeenNthCalledWith(
      3,
      { type: "SET_PINS_HIDDEN", payload: false },
      "*",
    )
    expect(postMessage).toHaveBeenNthCalledWith(
      4,
      { type: "SET_COMMENTS", payload: [] },
      "*",
    )
  })

  it("COMMENT_PIN_CLICKED message updates slice + fires onPinClicked", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() =>
      useEditorCommentBridge(ref, { onPinClicked }),
    )

    act(() => {
      emitBridgeMessage(contentWindow, "COMMENT_PIN_CLICKED", {
        commentId: "c-9",
        pinRect: { top: 100, left: 200, width: 24, height: 24 },
      })
    })

    expect(useAppStore.getState().activeCommentId).toBe("c-9")
    expect(onPinClicked).toHaveBeenCalledWith("c-9")
  })

  // Comment placement is STICKY: the bridge un-arms its own placement overlay
  // when a pin lands, but the TOOL stays picked so the next click can drop
  // another pin. This hook used to write `navigate` here, which is what ended
  // the tool after one comment. The re-arm lives in
  // `useStickyCommentPlacement`, which has the end-to-end coverage.
  it("NEW_COMMENT_POSITION message updates pendingPosition and KEEPS comment mode", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onNewCommentPosition = vi.fn()
    useAppStore.setState({ toolMode: "comment" })
    renderHook(() =>
      useEditorCommentBridge(ref, { onNewCommentPosition }),
    )

    act(() => {
      emitBridgeMessage(contentWindow, "NEW_COMMENT_POSITION", {
        anchorSelector: ".btn-primary",
        page: "/login",
        anchorX: 100,
        anchorY: 200,
        elementRect: { top: 90, left: 100, width: 200, height: 40 },
      })
    })

    const state = useAppStore.getState()
    expect(state.pendingPosition).toEqual({
      anchorSelector: ".btn-primary",
      page: "/login",
      anchorX: 100,
      anchorY: 200,
    })
    expect(state.toolMode).toBe("comment")
    expect(onNewCommentPosition).toHaveBeenCalledTimes(1)
    // No pinRect in this payload, so the composer falls back to the element.
    expect(state.popupAnchorRect).toEqual({ top: 90, left: 100, width: 200, height: 40 })
  })

  // The click point the pin is placed at, and the composer that has to open
  // beside it. Both are carried on this one message, and both are read out of
  // it field by field on the way to the store — so a field dropped here is
  // dropped silently, with the comment still saving and just landing in the
  // wrong place.
  it("carries the click point through, and anchors the composer to the pin", () => {
    const { ref, contentWindow } = makeIframeRef()
    useAppStore.setState({ toolMode: "comment" })
    renderHook(() => useEditorCommentBridge(ref, {}))

    act(() => {
      emitBridgeMessage(contentWindow, "NEW_COMMENT_POSITION", {
        anchorSelector: ".hero",
        page: "/",
        anchorX: 296,
        anchorY: 397,
        offsetRatioX: 0.25,
        offsetRatioY: 0.75,
        // Complete rects, because the bridge emits complete ones and the
        // popup's placement reads `right`/`bottom` as well as `left`/`top`.
        // An abbreviated fixture here quietly tests a shape the wire never
        // carries (found by codex, 2026-09-13).
        pinRect: { x: 296, y: 397, top: 397, left: 296, right: 328, bottom: 429, width: 32, height: 32 },
        elementRect: { x: 100, y: 200, top: 200, left: 100, right: 900, bottom: 500, width: 800, height: 300 },
      })
    })

    const state = useAppStore.getState()
    expect(state.pendingPosition).toEqual({
      anchorSelector: ".hero",
      page: "/",
      anchorX: 296,
      anchorY: 397,
      offsetRatioX: 0.25,
      offsetRatioY: 0.75,
    })
    // The PIN, not the 800px-wide element it sits inside. The popup places
    // itself off `left`/`right`/`top`/`bottom`, so the whole rect matters and
    // not just the corner.
    expect(state.popupAnchorRect).toEqual({
      x: 296, y: 397, top: 397, left: 296, right: 328, bottom: 429, width: 32, height: 32,
    })
  })

  // This message comes from the iframe, which runs the CUSTOMER's prototype
  // code. The bridge clamps on the way out, but nothing makes the bridge the
  // only possible sender, and a ratio is multiplied by a live element width at
  // render time — `NaN` writes "NaNpx" into style.left, which the browser
  // drops silently, leaving a comment that saves and then cannot be found.
  it.each([
    ["above 1", 2],
    ["negative", -0.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "0.5"],
    ["only one of the pair", undefined],
  ])("drops a ratio that is %s, falling back to corner placement", (_label, bad) => {
    const { ref, contentWindow } = makeIframeRef()
    useAppStore.setState({ toolMode: "comment" })
    renderHook(() => useEditorCommentBridge(ref, {}))

    act(() => {
      emitBridgeMessage(contentWindow, "NEW_COMMENT_POSITION", {
        anchorSelector: ".hero",
        page: "/",
        anchorX: 1,
        anchorY: 2,
        offsetRatioX: bad,
        offsetRatioY: 0.75,
        elementRect: { x: 100, y: 200, top: 200, left: 100, right: 900, bottom: 500, width: 800, height: 300 },
      })
    })

    // Neither survives: a half-present pair is not a placement.
    expect(useAppStore.getState().pendingPosition).toEqual({
      anchorSelector: ".hero",
      page: "/",
      anchorX: 1,
      anchorY: 2,
    })
  })

  it("ignores messages from a different source", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() =>
      useEditorCommentBridge(ref, { onPinClicked }),
    )

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "some-other-thing",
            type: "COMMENT_PIN_CLICKED",
            payload: { commentId: "x" },
          },
          source: contentWindow as unknown as Window,
        }),
      )
    })

    expect(onPinClicked).not.toHaveBeenCalled()
  })

  // S10 — the payload's `source` marker is a routing convenience, not a
  // credential. These two lock the checks that replaced it.
  it("ignores a well-formed bridge message from a DIFFERENT window", () => {
    const { ref } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() => useEditorCommentBridge(ref, { onPinClicked }))

    // An attacker window holding a handle to the shell: perfect envelope,
    // wrong sender.
    const otherWindow = { postMessage: vi.fn() }
    act(() => {
      emitBridgeMessage(otherWindow, "COMMENT_PIN_CLICKED", { commentId: "x" })
    })

    expect(onPinClicked).not.toHaveBeenCalled()

    // The same message from the real iframe window IS handled — proving the
    // rejection above is about the sender, not about the payload.
    const { contentWindow } = makeIframeRef()
    ref.current = { contentWindow, src: undefined } as unknown as HTMLIFrameElement
    act(() => {
      emitBridgeMessage(contentWindow, "COMMENT_PIN_CLICKED", { commentId: "c-ok" })
    })
    expect(onPinClicked).toHaveBeenCalledWith("c-ok")
  })

  it("ignores a message from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef("http://localhost:5173/")
    const onPinClicked = vi.fn()
    renderHook(() => useEditorCommentBridge(ref, { onPinClicked }))

    // The frame navigated itself somewhere hostile: `contentWindow` is stable
    // across navigation, so only the origin check catches this.
    act(() => {
      emitBridgeMessage(
        contentWindow,
        "COMMENT_PIN_CLICKED",
        { commentId: "x" },
        "https://evil.example",
      )
    })
    expect(onPinClicked).not.toHaveBeenCalled()

    act(() => {
      emitBridgeMessage(
        contentWindow,
        "COMMENT_PIN_CLICKED",
        { commentId: "c-ok" },
        "http://localhost:5173",
      )
    })
    expect(onPinClicked).toHaveBeenCalledWith("c-ok")
  })

  // K12 — comment bodies and the `cli:user@host` identity ride this channel,
  // so the outbound post names the prototype origin instead of broadcasting.
  it("posts to the resolved prototype origin when the iframe src is known", () => {
    const { ref, postMessage } = makeIframeRef("http://localhost:5173/app")
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.enterCommentMode()
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "ENTER_COMMENT_MODE" },
      "http://localhost:5173",
    )
  })

  it("stays inert when enabled=false (no post, no window listener)", () => {
    const { ref, postMessage, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    const { result } = renderHook(() =>
      useEditorCommentBridge(ref, { enabled: false, onPinClicked }),
    )

    act(() => {
      result.current.enterCommentMode()
    })
    expect(postMessage).not.toHaveBeenCalled()

    act(() => {
      emitBridgeMessage(contentWindow, "COMMENT_PIN_CLICKED", { commentId: "x" })
    })
    expect(onPinClicked).not.toHaveBeenCalled()
  })

  it("BRIDGE_READY increments bridgeReadyEpoch", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = renderHook(() => useEditorCommentBridge(ref))
    expect(result.current.bridgeReadyEpoch).toBe(0)
    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    expect(result.current.bridgeReadyEpoch).toBe(1)
    // A second handshake (iframe reload) bumps again so the
    // container's sync effect re-runs.
    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    expect(result.current.bridgeReadyEpoch).toBe(2)
  })

  it("highlightComment defers HIGHLIGHT_COMMENT until BRIDGE_READY for a cross-page target", async () => {
    vi.useFakeTimers()
    const { ref, postMessage, contentWindow } = makeIframeRef()
    useAppStore.setState({
      comments: [
        {
          id: "c-far",
          number: 1,
          body: "x",
          position: { anchorSelector: ".btn", page: "/signup" },
          author: { uid: "", displayName: "", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
      currentDisplayRoute: "/login",
    })
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.highlightComment("c-far")
    })

    // Only NAVIGATE has fired yet — HIGHLIGHT_COMMENT is pending.
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: "NAVIGATE", payload: { page: "/signup" } },
      "*",
    )

    // Bridge handshakes on the new page.
    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    // setTimeout(200) drains the deferred highlight.
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "HIGHLIGHT_COMMENT", payload: { commentId: "c-far" } },
      "*",
    )
    vi.useRealTimers()
  })

  it("highlightComment skips NAVIGATE when target page matches current route", () => {
    const { ref, postMessage } = makeIframeRef()
    useAppStore.setState({
      comments: [
        {
          id: "c-here",
          number: 1,
          body: "x",
          position: { anchorSelector: ".btn", page: "/login" },
          author: { uid: "", displayName: "", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
      currentDisplayRoute: "/login",
    })
    const { result } = renderHook(() => useEditorCommentBridge(ref))

    act(() => {
      result.current.highlightComment("c-here")
    })

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: "HIGHLIGHT_COMMENT", payload: { commentId: "c-here" } },
      "*",
    )
  })

  it("does not post when iframeRef.current is null", () => {
    const { result } = renderHook(() => {
      const nullRef = useRef<HTMLIFrameElement>(null)
      return useEditorCommentBridge(nullRef)
    })

    expect(() => {
      act(() => {
        result.current.enterCommentMode()
      })
    }).not.toThrow()
  })
})
