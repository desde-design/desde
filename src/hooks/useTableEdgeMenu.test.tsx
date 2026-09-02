/**
 * Authentication contract for the TABLE_EDGE_CONTEXT_MENU listener (audit
 * S10). Same shape and same stakes as `useElementContextMenu`: the payload's
 * `source` marker is forgeable, and a forged menu renders wherever the sender
 * asks.
 */

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useTableEdgeMenu } from "./useTableEdgeMenu"
import type { TableEdgeContextMenuPayload } from "@/types/bridge"

const PAYLOAD = {
  kind: "row",
  index: 1,
  menuAnchor: { x: 10, y: 20 },
} as unknown as TableEdgeContextMenuPayload

function makeIframeRef(src?: string): {
  ref: { current: HTMLIFrameElement | null }
  contentWindow: object
} {
  const contentWindow = { postMessage: vi.fn() }
  const iframe = {
    contentWindow,
    src,
    getBoundingClientRect: () => ({ left: 100, top: 200 }) as DOMRect,
  } as unknown as HTMLIFrameElement
  return { ref: { current: iframe }, contentWindow }
}

function emit(source: object, origin?: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "desde-bridge",
        type: "TABLE_EDGE_CONTEXT_MENU",
        payload: PAYLOAD,
      },
      source: source as Window,
      ...(origin === undefined ? {} : { origin }),
    }),
  )
}

function render(ref: { current: HTMLIFrameElement | null }) {
  return renderHook(() =>
    useTableEdgeMenu({ iframeRef: ref, submitChat: vi.fn(), active: true }),
  )
}

describe("useTableEdgeMenu — sender authentication", () => {
  it("opens the menu for a message from the real iframe window", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = render(ref)

    act(() => emit(contentWindow))

    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })

  it("ignores a well-formed message from a DIFFERENT window", () => {
    const { ref } = makeIframeRef()
    const { result } = render(ref)

    act(() => emit({ postMessage: vi.fn() }))

    expect(result.current.menu).toBeNull()
  })

  it("ignores a message from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef("http://localhost:5173/")
    const { result } = render(ref)

    act(() => emit(contentWindow, "https://evil.example"))
    expect(result.current.menu).toBeNull()

    act(() => emit(contentWindow, "http://localhost:5173"))
    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })
})
