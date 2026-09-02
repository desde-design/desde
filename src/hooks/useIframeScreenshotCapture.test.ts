import { renderHook, act } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  useIframeScreenshotCapture,
  type CaptureScreenshotFn,
} from "./useIframeScreenshotCapture"

type IframeRef = React.RefObject<HTMLIFrameElement | null>

interface FakeIframe {
  ref: IframeRef
  /** Pass as `source` to `dispatchBridgeReply` so `event.source` matches
   *  what the hook checks against `iframeRef.current?.contentWindow`. */
  contentWindow: object
}

function iframeRefWith(postMessage: (msg: unknown, target: string) => void): FakeIframe {
  const contentWindow = { postMessage }
  return {
    ref: { current: { contentWindow } } as unknown as IframeRef,
    contentWindow,
  }
}

function dispatchBridgeReply(source: unknown, requestId: string, payload: unknown): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "desde-bridge",
        type: "ELEMENT_SCREENSHOT_CAPTURED",
        requestId,
        payload,
      },
      source: source as Window,
    }),
  )
}

afterEach(() => vi.useRealTimers())

describe("useIframeScreenshotCapture", () => {
  it("posts CAPTURE_ELEMENT_SCREENSHOT and resolves ok with the matching reply", async () => {
    let sentReqId = ""
    const postMessage = vi.fn((msg: unknown) => {
      sentReqId = (msg as { requestId: string }).requestId
    })
    const iframe = iframeRefWith(postMessage)
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))

    let promise!: ReturnType<CaptureScreenshotFn>
    act(() => {
      promise = result.current({ selector: "#hero" })
    })

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "CAPTURE_ELEMENT_SCREENSHOT",
        payload: { selector: "#hero" },
        requestId: sentReqId,
      }),
      "*",
    )

    act(() =>
      dispatchBridgeReply(iframe.contentWindow, sentReqId, {
        png: "data:image/png;base64,AAAA",
        width: 120,
        height: 64,
      }),
    )

    await expect(promise).resolves.toEqual({
      ok: true,
      shot: { dataUrl: "data:image/png;base64,AAAA", width: 120, height: 64 },
    })
  })

  it("resolves a no-iframe failure when there is no iframe window", async () => {
    const ref = { current: null } as IframeRef
    const { result } = renderHook(() => useIframeScreenshotCapture(ref))
    await expect(result.current()).resolves.toEqual({
      ok: false,
      reason: "no-iframe",
      message: expect.any(String),
    })
  })

  it("propagates the bridge-reported reason (selector matched nothing)", async () => {
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))
    let promise!: ReturnType<CaptureScreenshotFn>
    act(() => {
      promise = result.current({ selector: ".nope" })
    })
    act(() => dispatchBridgeReply(iframe.contentWindow, reqId, { error: "no-match" }))
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "no-match",
      message: expect.any(String),
    })
  })

  it("falls back to render-failed for a legacy null payload", async () => {
    let reqId = ""
    const iframe = iframeRefWith((m) => {
      reqId = (m as { requestId: string }).requestId
    })
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))
    let promise!: ReturnType<CaptureScreenshotFn>
    act(() => {
      promise = result.current()
    })
    act(() => dispatchBridgeReply(iframe.contentWindow, reqId, null))
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "render-failed",
      message: expect.any(String),
    })
  })

  it("resolves an aborted failure promptly when the signal aborts before the reply", async () => {
    const controller = new AbortController()
    const iframe = iframeRefWith(() => {})
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))
    let promise!: ReturnType<CaptureScreenshotFn>
    act(() => {
      promise = result.current({}, controller.signal)
    })
    act(() => controller.abort())
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "aborted",
      message: expect.any(String),
    })
  })

  it("resolves aborted immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const postMessage = vi.fn()
    const iframe = iframeRefWith(postMessage)
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))
    await expect(result.current({}, controller.signal)).resolves.toEqual({
      ok: false,
      reason: "aborted",
      message: expect.any(String),
    })
    expect(postMessage).not.toHaveBeenCalled()
  })

  it("ignores replies with a non-matching requestId and times out", async () => {
    vi.useFakeTimers()
    const iframe = iframeRefWith(() => {})
    const { result } = renderHook(() => useIframeScreenshotCapture(iframe.ref))
    let promise!: ReturnType<CaptureScreenshotFn>
    act(() => {
      promise = result.current()
    })
    // A reply for a different request must not resolve this one.
    act(() =>
      dispatchBridgeReply(iframe.contentWindow, "some-other-id", {
        png: "x",
        width: 1,
        height: 1,
      }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "timeout",
      message: expect.any(String),
    })
  })
})
