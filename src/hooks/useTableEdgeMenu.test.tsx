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

const DOCUMENT_ID = "doc-a"

const PAYLOAD = {
  kind: "row",
  index: 1,
  menuAnchor: { x: 10, y: 20 },
  documentId: DOCUMENT_ID,
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

function emit(
  source: object,
  origin?: string,
  payload: TableEdgeContextMenuPayload = PAYLOAD,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        source: "desde-bridge",
        type: "TABLE_EDGE_CONTEXT_MENU",
        payload,
      },
      source: source as Window,
      ...(origin === undefined ? {} : { origin }),
    }),
  )
}

function render(
  ref: { current: HTMLIFrameElement | null },
  submitChat: (message: string) => void = vi.fn(),
) {
  return renderHook(
    ({ documentId }: { documentId: string | null }) =>
      useTableEdgeMenu({ iframeRef: ref, submitChat, active: true, documentId }),
    { initialProps: { documentId: DOCUMENT_ID as string | null } },
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

/**
 * The menu names a row in ONE document, and its actions submit an instruction
 * built from that document's selectors into a chat turn that can write files.
 * So an event from another page is not opened, and a menu already open when
 * the page changes does not survive it.
 */
describe("useTableEdgeMenu — the menu belongs to one page", () => {
  it("ignores a band menu from another document", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = render(ref)

    act(() =>
      emit(contentWindow, undefined, {
        ...PAYLOAD,
        documentId: "doc-x",
      } as TableEdgeContextMenuPayload),
    )

    expect(result.current.menu).toBeNull()
  })

  it("dismisses an open menu when the page is replaced", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result, rerender } = render(ref)

    act(() => emit(contentWindow))
    expect(result.current.menu).not.toBeNull()

    rerender({ documentId: "doc-b" })

    expect(result.current.menu).toBeNull()
  })

  it("refuses an action chosen after the page was replaced", () => {
    // The last gate, and a real one rather than a duplicate of the dismissal
    // above: the menu state is read from a closure that was built before the
    // page changed, which is what a click handled in the same event turn
    // would see.
    const submitChat = vi.fn()
    const { ref, contentWindow } = makeIframeRef()
    const { result, rerender } = render(ref, submitChat)

    act(() => emit(contentWindow))
    const staleRunAction = result.current.runAction

    rerender({ documentId: "doc-b" })
    act(() => staleRunAction("delete"))

    expect(submitChat).not.toHaveBeenCalled()
  })
})
