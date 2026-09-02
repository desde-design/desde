/**
 * Authentication contract for the ROUTE_CHANGED listener (audit S10).
 *
 * This one mattered more than its siblings: it writes `currentPageUrl` /
 * `currentSourceFile`, which flow verbatim into the agent's `get_page_info`
 * tool result and pin the next `navigate`. A forged ROUTE_CHANGED from any
 * window holding a handle to the shell used to be enough to poison it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useEditorPinnedSelection } from "./useEditorPinnedSelection"
import { useAppStore } from "@/stores"

const CANONICAL = "http://localhost:5173/"

function makeIframeRef(): {
  ref: { current: HTMLIFrameElement | null }
  contentWindow: object
} {
  const contentWindow = { postMessage: vi.fn() }
  const iframe = { contentWindow, src: CANONICAL } as unknown as HTMLIFrameElement
  return { ref: { current: iframe }, contentWindow }
}

function emitRouteChanged(source: object, url: string, origin?: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "desde-bridge",
        type: "ROUTE_CHANGED",
        payload: { url, sourceFile: "src/App.vue" },
      },
      source: source as Window,
      origin: origin ?? new URL(url).origin,
    }),
  )
}

function render(ref: { current: HTMLIFrameElement | null }) {
  return renderHook(() =>
    useEditorPinnedSelection({
      iframeRef: ref,
      prototypeUrl: CANONICAL,
      selectBySelector: undefined,
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

describe("useEditorPinnedSelection — sender authentication", () => {
  it("mirrors the live route for a message from the real iframe window", () => {
    const { ref, contentWindow } = makeIframeRef()
    render(ref)

    act(() => emitRouteChanged(contentWindow, "http://localhost:5173/reports"))

    expect(useAppStore.getState().currentPageUrl).toBe(
      "http://localhost:5173/reports",
    )
    expect(useAppStore.getState().currentSourceFile).toBe("src/App.vue")
  })

  it("ignores a well-formed ROUTE_CHANGED from a DIFFERENT window", () => {
    const { ref } = makeIframeRef()
    render(ref)

    act(() =>
      emitRouteChanged(
        { postMessage: vi.fn() },
        "http://localhost:5173/attacker-chosen",
      ),
    )

    expect(useAppStore.getState().currentPageUrl).toBeNull()
  })

  it("ignores a ROUTE_CHANGED from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef()
    render(ref)

    // The frame relocated itself; `contentWindow` is unchanged, so only the
    // origin check (against the frozen `prototypeUrl`) catches it.
    act(() =>
      emitRouteChanged(contentWindow, "https://evil.example/pwned"),
    )
    expect(useAppStore.getState().currentPageUrl).toBeNull()
  })
})
