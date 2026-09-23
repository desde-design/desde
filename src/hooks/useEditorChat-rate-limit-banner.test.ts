import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const fetchMock = vi.fn()
vi.mock("@/lib/editor-fetch", () => ({
  editorFetch: (...args: unknown[]) => fetchMock(...args),
}))

import { useEditorChat } from "./useEditorChat"

/**
 * A 429 reaches the client as two frames, in this order: `rate_limit_warning`
 * (carrying the vendor's `retry-after` when it sent one) and then `api_retry`.
 * The warning is the one that says how long the wait is. The retry frame used
 * to replace it, so for the whole wait the user saw only the generic retry
 * banner.
 */

/**
 * An SSE Response that streams the given events and then stays OPEN. Closing
 * the stream clears both banners (the submit cleanup does), and these tests
 * read the bucket while the retry wait is still going on. `close` ends it.
 */
function openSseResponse(events: object[]): { response: Response; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      const text = events.map((e) => `data:${JSON.stringify(e)}\n\n`).join("")
      c.enqueue(new TextEncoder().encode(text))
    },
  })
  return {
    response: { ok: true, body, text: async () => "" } as unknown as Response,
    close: () => controller.close(),
  }
}

// No `turn_complete` either: it clears both banners too.
const warning = {
  kind: "rate_limit_warning",
  turnId: "turn-1",
  status: "rejected",
  retryAfterSeconds: 30,
}
const retry = (errorStatus: number | null) => ({
  kind: "api_retry",
  turnId: "turn-1",
  retryDelayMs: 30_000,
  attempt: 1,
  maxRetries: 3,
  errorStatus,
})

async function bannersAfter(events: object[]): Promise<string[]> {
  const stream = openSseResponse([{ kind: "turn_start", turnId: "turn-1" }, ...events])
  fetchMock.mockImplementation(() => stream.response)
  const { result } = renderHook(() => useEditorChat({ bridgeHandlers: {} }))
  let submitted!: Promise<void>
  act(() => {
    submitted = result.current.submit("hello")
  })
  const banners = (): string[] =>
    result.current.messages
      .filter((m) => m.kind === "rate_limit_warning" || m.kind === "api_retry")
      .map((m) => m.kind)
  // The last frame of every case is an `api_retry`.
  await waitFor(() => expect(banners()).toContain("api_retry"))
  const seen = banners()
  await act(async () => {
    stream.close()
    await submitted
  })
  return seen
}

describe("useEditorChat: the rate-limit warning and the retry that follows it", () => {
  afterEach(() => fetchMock.mockReset())

  it("keeps the warning, with its wait, when the retry is for the same 429", async () => {
    expect(await bannersAfter([warning, retry(429)])).toEqual([
      "rate_limit_warning",
      "api_retry",
    ])
  })

  it("still replaces the warning when the retry is for something else", async () => {
    expect(await bannersAfter([warning, retry(503)])).toEqual(["api_retry"])
  })

  it("replaces an earlier retry either way, so retries never stack", async () => {
    expect(await bannersAfter([warning, retry(429), retry(429)])).toEqual([
      "rate_limit_warning",
      "api_retry",
    ])
  })
})
