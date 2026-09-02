import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"
import type { ChatMessage } from "./useEditorChat"

/**
 * A failure is exactly one banner.
 *
 * There used to be two renderers for the same event: an `error` MESSAGE (shown
 * by ChatStatusBanners, dismissible) and `bucket.error` (shown by a bare div in
 * the chat panel, permanent). An HTTP failure set both, so it drew two banners
 * saying the same thing and only one could be dismissed.
 *
 * Deleting the div was not enough on its own, which is what these pin: the
 * stream-failure path set ONLY `bucket.error`, so with the div gone it would
 * have failed silently. Every path has to append a message, and no path may
 * append two.
 */
describe("useEditorChat — one banner per failure", () => {
  const baseOpts = { bridgeHandlers: {} }
  type ErrorMessage = Extract<ChatMessage, { kind: "error" }>
  const errors = (msgs: readonly ChatMessage[]): ErrorMessage[] =>
    msgs.filter((m): m is ErrorMessage => m.kind === "error")

  it("raises exactly one banner for an HTTP failure, carrying the body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      text: async () => "session cost ceiling reached",
    })

    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      await result.current.submit("hello")
    })

    await waitFor(() => expect(errors(result.current.messages)).toHaveLength(1))
    const banner = errors(result.current.messages)[0]
    // The message used to say only `HTTP 429` while the body went to the
    // second banner. With one banner it has to carry both.
    expect(banner.reason).toContain("429")
    expect(banner.reason).toContain("session cost ceiling reached")
  })

  it("raises a banner for a stream failure, which used to raise none", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"))

    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      await result.current.submit("hello")
    })

    await waitFor(() => expect(errors(result.current.messages)).toHaveLength(1))
    expect(errors(result.current.messages)[0].reason).toContain("socket hang up")
  })

  it("stays silent when the user aborts, which is not a failure", async () => {
    const abort = new Error("aborted")
    abort.name = "AbortError"
    fetchMock.mockRejectedValue(abort)

    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      await result.current.submit("hello")
    })

    expect(errors(result.current.messages)).toHaveLength(0)
  })

  it("lets the banner be dismissed", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"))

    const { result } = renderHook(() => useEditorChat(baseOpts))
    await act(async () => {
      await result.current.submit("hello")
    })
    await waitFor(() => expect(errors(result.current.messages)).toHaveLength(1))

    const id = errors(result.current.messages)[0].id
    act(() => result.current.dismissMessage(id))
    expect(errors(result.current.messages)).toHaveLength(0)
  })
})
