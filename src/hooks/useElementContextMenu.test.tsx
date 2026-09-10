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

const DOCUMENT_ID = "doc-a"

const PAYLOAD = {
  selector: ".btn",
  menuAnchor: { x: 10, y: 20 },
  documentId: DOCUMENT_ID,
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

function emit(
  source: object,
  origin?: string,
  payload: ElementContextMenuPayload = PAYLOAD,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "desde-bridge",
        type: "ELEMENT_CONTEXT_MENU",
        payload,
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
      useElementContextMenu({
        iframeRef: ref,
        active: true,
        documentId: DOCUMENT_ID,
      }),
    )

    act(() => emit(contentWindow))

    // Anchor is translated into shell-viewport space by the iframe's rect.
    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })

  it("ignores a well-formed message from a DIFFERENT window", () => {
    const { ref } = makeIframeRef()
    const { result } = renderHook(() =>
      useElementContextMenu({
        iframeRef: ref,
        active: true,
        documentId: DOCUMENT_ID,
      }),
    )

    act(() => emit({ postMessage: vi.fn() }))

    expect(result.current.menu).toBeNull()
  })

  it("ignores a message from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef("http://localhost:5173/")
    const { result } = renderHook(() =>
      useElementContextMenu({
        iframeRef: ref,
        active: true,
        documentId: DOCUMENT_ID,
      }),
    )

    // `contentWindow` survives navigation, so only the origin check catches a
    // frame that has relocated itself.
    act(() => emit(contentWindow, "https://evil.example"))
    expect(result.current.menu).toBeNull()

    act(() => emit(contentWindow, "http://localhost:5173"))
    expect(result.current.menu?.shellAnchor).toEqual({ x: 110, y: 220 })
  })
})

/**
 * The menu names an element in ONE document. "Open in editor" reads that
 * element's `authoredAt`, so a menu that outlived its page opens the departed
 * page's file.
 */
describe("useElementContextMenu — the menu belongs to one page", () => {
  function renderWithDocument(ref: { current: HTMLIFrameElement | null }) {
    return renderHook(
      ({ documentId }: { documentId: string | null }) =>
        useElementContextMenu({ iframeRef: ref, active: true, documentId }),
      { initialProps: { documentId: DOCUMENT_ID as string | null } },
    )
  }

  it("ignores a menu event from another document", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = renderWithDocument(ref)

    act(() =>
      emit(contentWindow, undefined, {
        ...PAYLOAD,
        documentId: "doc-x",
      } as ElementContextMenuPayload),
    )

    expect(result.current.menu).toBeNull()
  })

  it("dismisses an open menu when the page is replaced", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result, rerender } = renderWithDocument(ref)

    act(() => emit(contentWindow))
    expect(result.current.menu).not.toBeNull()

    rerender({ documentId: "doc-b" })

    expect(result.current.menu).toBeNull()
  })
})
