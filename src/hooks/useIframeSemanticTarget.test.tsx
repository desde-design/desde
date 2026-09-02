import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useIframeSemanticTarget } from "./useIframeSemanticTarget"

function makeIframeRef(): {
  ref: { current: HTMLIFrameElement | null }
  postMessage: ReturnType<typeof vi.fn>
  /** Pass as `source` to `emit` so `event.source` matches what the hook
   *  checks against `iframeRef.current?.contentWindow`. */
  contentWindow: object
} {
  const postMessage = vi.fn()
  const contentWindow = { postMessage }
  const fakeIframe = { contentWindow } as unknown as HTMLIFrameElement
  return { ref: { current: fakeIframe }, postMessage, contentWindow }
}

/** Pull the requestId the hook generated from its outgoing postMessage. */
function lastRequestId(postMessage: ReturnType<typeof vi.fn>): string {
  const calls = postMessage.mock.calls
  return (calls[calls.length - 1][0] as { requestId: string }).requestId
}

function emit(source: unknown, data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }))
}

afterEach(() => vi.useRealTimers())

describe("useIframeSemanticTarget — reply source filtering", () => {
  it("settles on a bridge-marked TARGET_RESOLVED reply", async () => {
    const { ref, postMessage, contentWindow } = makeIframeRef()
    const { result } = renderHook(() => useIframeSemanticTarget(ref))

    let resolved: unknown
    await act(async () => {
      const p = result.current.resolveTarget({ role: "button", name: "Save" })
      const reqId = lastRequestId(postMessage)
      emit(contentWindow, {
        source: "desde-bridge",
        type: "TARGET_RESOLVED",
        requestId: reqId,
        payload: { found: true, selector: "#save" },
      })
      resolved = await p
    })

    expect(resolved).toEqual({ found: true, selector: "#save" })
  })

  it("IGNORES a spoofed reply with no bridge source marker", async () => {
    vi.useFakeTimers()
    const { ref, postMessage, contentWindow } = makeIframeRef()
    const { result } = renderHook(() => useIframeSemanticTarget(ref))

    const p = result.current.performInteract({ selector: "#x", action: "click" })
    const reqId = lastRequestId(postMessage)

    // A prototype/third-party script forges the reply (no `source`).
    emit(contentWindow, {
      type: "INTERACT_PERFORMED",
      requestId: reqId,
      payload: { ok: true },
    })
    // Also a wrong-source forge.
    emit(contentWindow, {
      source: "evil",
      type: "INTERACT_PERFORMED",
      requestId: reqId,
      payload: { ok: true },
    })

    // Neither settled the promise — it only resolves (null) when the
    // round-trip times out.
    await act(async () => {
      vi.advanceTimersByTime(15_000)
    })
    await expect(p).resolves.toBeNull()
  })

  it("IGNORES a correctly bridge-marked reply from the wrong event.source (spoofed window)", async () => {
    vi.useFakeTimers()
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useIframeSemanticTarget(ref))

    const p = result.current.performInteract({ selector: "#x", action: "click" })
    const reqId = lastRequestId(postMessage)
    const impostor = { postMessage: () => {} }

    emit(impostor, {
      source: "desde-bridge",
      type: "INTERACT_PERFORMED",
      requestId: reqId,
      payload: { ok: true },
    })

    await act(async () => {
      vi.advanceTimersByTime(15_000)
    })
    await expect(p).resolves.toBeNull()
  })
})
