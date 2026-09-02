import { renderHook, act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  useIframeBridgeRequest,
  type IframeBridgeRequestFn,
} from "./useIframeBridgeRequest"

type IframeRef = React.RefObject<HTMLIFrameElement | null>

interface FakeIframe {
  ref: IframeRef
  /** The fake `contentWindow` object — pass as the third arg to
   *  `dispatchReply`/`emitRaw` so `event.source` matches what the hook
   *  checks against `iframeRef.current?.contentWindow`. */
  contentWindow: object
}

function iframeRefWith(postMessage: (msg: unknown, target: string) => void): FakeIframe {
  const contentWindow = { postMessage }
  return {
    ref: { current: { contentWindow } } as unknown as IframeRef,
    contentWindow,
  }
}

/** Dispatch a bridge-sourced reply as if it came from `source` (normally an
 *  iframe's `contentWindow`) — sets both the BRIDGE_SOURCE envelope marker
 *  (`data.source`) and the postMessage `event.source` the hook now also
 *  checks against `iframeRef.current?.contentWindow`. */
function dispatchReply(
  source: unknown,
  requestId: string,
  payload: unknown,
  type = "PONG",
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "desde-bridge", type, requestId, payload },
      source: source as Window,
    }),
  )
}

/** Dispatch a raw `message` event data blob verbatim — used for the
 *  no-source / wrong-source spoof cases where `dispatchReply`'s always-stamp
 *  default would defeat the point. `source` sets `event.source`. */
function emitRaw(source: unknown, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, source: source as Window }),
  )
}

/** A simple string-echo config: reply payload is resolved verbatim; the
 *  failure paths are tagged so tests can tell them apart. */
function makeConfig(timeoutMs = 5000) {
  return {
    replyTypes: ["PONG"],
    timeoutMs,
    extractPayload: (data: { type: string; payload: unknown }) => data.payload as string,
    onNoIframe: () => "no-iframe",
    onTimeout: () => "timeout",
    onAbort: () => "abort",
  }
}

afterEach(() => vi.useRealTimers())

describe("useIframeBridgeRequest", () => {
  it("posts the request type + payload and resolves with the extracted reply", async () => {
    let sentReqId = ""
    const postMessage = vi.fn((msg: unknown) => {
      sentReqId = (msg as { requestId: string }).requestId
    })
    const iframe = iframeRefWith(postMessage)
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )

    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", { foo: "bar" })
    })

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "PING", payload: { foo: "bar" }, requestId: sentReqId }),
      "*",
    )

    act(() => dispatchReply(iframe.contentWindow, sentReqId, "hello"))
    await expect(promise).resolves.toBe("hello")
  })

  it("resolves onTimeout when no reply arrives within timeoutMs", async () => {
    vi.useFakeTimers()
    const iframe = iframeRefWith(() => {})
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig(1000)),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await expect(promise).resolves.toBe("timeout")
  })

  it("resolves onAbort immediately when the signal is already aborted (no postMessage)", async () => {
    const controller = new AbortController()
    controller.abort()
    const postMessage = vi.fn()
    const iframe = iframeRefWith(postMessage)
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    await expect(result.current("PING", {}, controller.signal)).resolves.toBe("abort")
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("resolves onAbort when the signal fires after the request is in flight", async () => {
    const controller = new AbortController()
    const iframe = iframeRefWith(() => {})
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {}, controller.signal)
    })
    act(() => controller.abort())
    await expect(promise).resolves.toBe("abort")
  })

  it("resolves onNoIframe when there is no contentWindow", async () => {
    const ref = { current: null } as IframeRef
    const { result } = renderHook(() => useIframeBridgeRequest(ref, makeConfig()))
    await expect(result.current("PING", {})).resolves.toBe("no-iframe")
  })

  it("ignores a reply with no bridge source marker (spoofed)", async () => {
    vi.useFakeTimers()
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig(1000)),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    act(() =>
      emitRaw(iframe.contentWindow, { type: "PONG", requestId: reqId, payload: "spoofed" }),
    )
    act(() =>
      emitRaw(iframe.contentWindow, {
        source: "evil",
        type: "PONG",
        requestId: reqId,
        payload: "spoofed",
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await expect(promise).resolves.toBe("timeout")
  })

  it("ignores a reply whose postMessage event.source isn't the tracked iframe's contentWindow (spoofed)", async () => {
    vi.useFakeTimers()
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const impostor = { postMessage: () => {} }
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig(1000)),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    // Correctly-stamped BRIDGE_SOURCE envelope, but posted from a window
    // that isn't this hook's tracked iframe — must still be ignored.
    act(() => dispatchReply(impostor, reqId, "spoofed"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await expect(promise).resolves.toBe("timeout")
  })

  it("ignores a reply whose type is not in replyTypes", async () => {
    vi.useFakeTimers()
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig(1000)),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    act(() => dispatchReply(iframe.contentWindow, reqId, "wrong-type", "SOMETHING_ELSE"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await expect(promise).resolves.toBe("timeout")
  })

  it("does not double-settle on a late reply arriving after timeout already settled it", async () => {
    vi.useFakeTimers()
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig(1000)),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await expect(promise).resolves.toBe("timeout")
    // Late reply after the timeout already settled — must be a silent no-op,
    // not a second resolve (which would be swallowed by the Promise anyway,
    // but exercises that the pendingRef entry was cleaned up, not double-fired).
    expect(() =>
      act(() => dispatchReply(iframe.contentWindow, reqId, "too-late")),
    ).not.toThrow()
  })

  it("does not double-settle on a reply arriving after abort already settled it", async () => {
    const controller = new AbortController()
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {}, controller.signal)
    })
    act(() => controller.abort())
    await expect(promise).resolves.toBe("abort")
    // A reply that arrives after abort must not clobber the already-resolved
    // value — same promise, still "abort", not overwritten.
    act(() => dispatchReply(iframe.contentWindow, reqId, "too-late"))
    await expect(promise).resolves.toBe("abort")
  })

  it("resolves concurrent requests independently, each to its own reply", async () => {
    const postMessage = vi.fn()
    const iframe = iframeRefWith(postMessage)
    const { result } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    let p1!: ReturnType<IframeBridgeRequestFn<string>>
    let p2!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      p1 = result.current("PING", { n: 1 })
      p2 = result.current("PING", { n: 2 })
    })
    const [id1, id2] = postMessage.mock.calls.map(
      (c) => (c[0] as { requestId: string }).requestId,
    )
    expect(id1).not.toBe(id2)
    // Reply to the second request first — order must not matter.
    act(() => dispatchReply(iframe.contentWindow, id2, "second"))
    act(() => dispatchReply(iframe.contentWindow, id1, "first"))
    await expect(p1).resolves.toBe("first")
    await expect(p2).resolves.toBe("second")
  })

  it("drains in-flight requests to onAbort on unmount so callers never hang", async () => {
    const iframe = iframeRefWith(() => {})
    const { result, unmount } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    let promise!: ReturnType<IframeBridgeRequestFn<string>>
    act(() => {
      promise = result.current("PING", {})
    })
    act(() => unmount())
    await expect(promise).resolves.toBe("abort")
  })

  it("removes its message listener on unmount (no stale handling after teardown)", async () => {
    const addSpy = vi.spyOn(window, "addEventListener")
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const iframe = iframeRefWith(() => {})
    const { unmount } = renderHook(() =>
      useIframeBridgeRequest(iframe.ref, makeConfig()),
    )
    expect(addSpy).toHaveBeenCalledWith("message", expect.any(Function))
    unmount()
    expect(removeSpy).toHaveBeenCalledWith("message", expect.any(Function))
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
