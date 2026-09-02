/**
 * Authentication contract for the ELEMENT_CONTEXT_MENU listener (audit S10).
 *
 * Before the fix this listener gated on nothing but `data.source ===
 * "desde-bridge"` — a marker inside the payload that any window can
 * write. That let a page framing the editor shell render a real, functional
 * menu at coordinates of its own choosing (S11's clickjacking amplifier), so
 * the sender's identity is the part worth pinning down.
 */

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useElementContextMenu } from "./useElementContextMenu"
import type { ElementContextMenuPayload } from "@/types/bridge"

const PAYLOAD = {
  selector: ".btn",
  menuAnchor: { x: 10, y: 20 },
} as unknown as ElementContextMenuPayload

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
        type: "ELEMENT_CONTEXT_MENU",
        payload: PAYLOAD,
      },
      source: source as Window,
      ...(origin === undefined ? {} : { origin }),
    }),
  )
}

describe("useElementContextMenu — sender authentication", () => {
  it("opens the menu for a message from the real iframe window", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = renderHook(() =>
      useElementContextMenu({ iframeRef: ref, active: true }),
    )

    act(() => emit(contentWindow))

    // Anchor is translated into shell-viewport space by the iframe's rect.
    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })

  it("ignores a well-formed message from a DIFFERENT window", () => {
    const { ref } = makeIframeRef()
    const { result } = renderHook(() =>
      useElementContextMenu({ iframeRef: ref, active: true }),
    )

    act(() => emit({ postMessage: vi.fn() }))

    expect(result.current.menu).toBeNull()
  })

  it("ignores a message from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef("http://localhost:5173/")
    const { result } = renderHook(() =>
      useElementContextMenu({ iframeRef: ref, active: true }),
    )

    // `contentWindow` survives navigation, so only the origin check catches a
    // frame that has relocated itself.
    act(() => emit(contentWindow, "https://evil.example"))
    expect(result.current.menu).toBeNull()

    act(() => emit(contentWindow, "http://localhost:5173"))
    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })
})
