/**
 * Authentication contract for the TABLE_EDGE_CONTEXT_MENU listener (audit
 * S10). Same shape and same stakes as `useElementContextMenu`: the payload's
 * `source` marker is forgeable, and a forged menu renders wherever the sender
 * asks.
 */

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { createRoot } from "react-dom/client"
import { useLayoutEffect, useState } from "react"
import { useTableEdgeMenu } from "./useTableEdgeMenu"
import type { TableEdgeMenuState } from "./useTableEdgeMenu"
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

  /**
   * Same race as `useElementContextMenu`'s version of this test, and the
   * same bug this guards against: syncing `documentIdRef` in a PASSIVE
   * effect (`useEffect`) instead of a LAYOUT one. A passive effect is
   * scheduled onto a later macrotask, separate from the commit that clears
   * `menu`, so a `message` event delivered in the gap would still match the
   * ref's stale value and reopen the menu. `useLayoutEffect` has no such
   * gap: React runs it synchronously, right after the commit.
   *
   * This cannot be built with `renderHook` / `act()` either, for the same
   * reason as the other hook: `act()` collapses a render and its passive
   * effects into one atomic flush, so there is never a moment where one has
   * happened and the other has not. It is reproduced by driving a real
   * `ReactDOMClient` root directly (bypassing `act()`, so updates take
   * their normal, unforced timing) and waiting for exactly one of React's
   * OWN macrotasks in between. In this Node/jsdom environment React's
   * Scheduler schedules that work with `setImmediate` (checked ahead of
   * `MessageChannel` in `scheduler`'s own fallback chain, and Node always
   * has `setImmediate`), so the wait here uses `setImmediate` too. A
   * `setTimeout(fn, 0)` wait lands in a different phase of Node's event
   * loop and is not reliably ordered against it. React logs a "not wrapped
   * in act" warning for driving updates this way on purpose; it is
   * expected and silenced below.
   */
  it("does not reopen the menu for a departed-document event delivered after the commit but before the ref's own effect flush", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { ref, contentWindow } = makeIframeRef()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

    // `state` (rather than plain outer variables reassigned from inside
    // `Harness`) is required by this repo's render-purity lint rules: a
    // component may not reassign or mutate a value declared outside it
    // during render, only from inside an effect. `state` is written from a
    // `useLayoutEffect` in `Harness` for the same reason `documentIdRef`
    // itself now is: a passive effect here would reintroduce exactly the
    // lag this test is trying to measure around, on the OBSERVATION side
    // instead of the fix's side.
    const state: {
      setDocumentId: ((id: string) => void) | null
      latestMenu: TableEdgeMenuState | null | undefined
    } = { setDocumentId: null, latestMenu: undefined }
    function Harness() {
      const [documentId, setId] = useState<string | null>(DOCUMENT_ID)
      const { menu } = useTableEdgeMenu({
        iframeRef: ref,
        submitChat: vi.fn(),
        active: true,
        documentId,
      })
      useLayoutEffect(() => {
        state.setDocumentId = setId
        state.latestMenu = menu
      }, [setId, menu])
      return null
    }

    try {
      root.render(<Harness />)
      // The mount effect (which binds the listener) needs its own
      // macrotask, separate from the render that set `setDocumentId`, so
      // this re-sends the open event on each tick until it lands, rather
      // than guessing a fixed tick count for how many the environment
      // needs to settle.
      for (let tick = 0; tick < 50 && state.latestMenu == null; tick++) {
        emit(contentWindow)
        await macrotask()
      }
      expect(state.latestMenu).not.toBeNull() // the open committed

      // Change the document the way `enterDocument` really does: an
      // ordinary state setter call, not a forced-synchronous API.
      state.setDocumentId!("doc-b")
      await macrotask() // exactly the commit that clears `menu`, nothing more
      expect(state.latestMenu).toBeNull()

      // The departed page's event, delivered right after that commit and
      // before a PASSIVE ref-sync effect would have had its macrotask yet.
      emit(contentWindow)

      // A few more ticks so a wrongly-reopened menu (the bug) has time to
      // commit and show up in `state.latestMenu` before the final
      // assertion.
      await macrotask()
      await macrotask()
      await macrotask()

      expect(state.latestMenu).toBeNull()
    } finally {
      root.unmount()
      document.body.removeChild(container)
      errorSpy.mockRestore()
    }
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
