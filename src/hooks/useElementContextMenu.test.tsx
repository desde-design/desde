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
import { createRoot } from "react-dom/client"
import { useLayoutEffect, useState } from "react"
import { useElementContextMenu } from "./useElementContextMenu"
import type { ElementContextMenuState } from "./useElementContextMenu"
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

  /**
   * The bug this guards against: syncing `documentIdRef` in a PASSIVE
   * effect (`useEffect`) instead of a LAYOUT one. A passive effect is
   * scheduled onto a later macrotask, separate from the commit that clears
   * `menu`, so a `message` event delivered in the gap between the two would
   * still match the ref's stale value and reopen the menu the dismissal
   * just closed. `useLayoutEffect` has no such gap: React runs it
   * synchronously, right after the commit, in the same turn. That is
   * before anything queued on the event loop, including a `message` event,
   * gets a chance to run.
   *
   * This cannot be built with `renderHook` / `act()` from testing-library:
   * `act()` deliberately collapses a render and its passive effects into
   * one atomic flush, so there is never a moment where one has happened and
   * the other has not. It is reproduced here by driving a real
   * `ReactDOMClient` root directly (bypassing `act()`, so updates take
   * their normal, unforced timing) and waiting for exactly one of React's
   * OWN macrotasks in between. In this Node/jsdom environment React's
   * Scheduler schedules that work with `setImmediate` (checked ahead of
   * `MessageChannel` in `scheduler`'s own fallback chain, and Node always
   * has `setImmediate`), so the wait here uses `setImmediate` too. A
   * `setTimeout(fn, 0)` wait lands in a different phase of Node's event
   * loop and is not reliably ordered against it, which is what made an
   * earlier version of this test flaky. React logs a "not wrapped in act"
   * warning for driving updates this way on purpose; it is expected and
   * silenced below.
   *
   * `state` (rather than plain outer variables reassigned from inside
   * `Harness`) is required by this repo's render-purity lint rules: a
   * component may not reassign or mutate a value declared outside it
   * during render, only from inside an effect. `state` is written from a
   * `useLayoutEffect` in `Harness` for the same reason `documentIdRef`
   * itself now is: a passive effect here would reintroduce exactly the
   * lag this test is trying to measure around, on the OBSERVATION side
   * instead of the fix's side.
   */
  it("does not reopen the menu for a departed-document event delivered after the commit but before the ref's own effect flush", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { ref, contentWindow } = makeIframeRef()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

    const state: {
      setDocumentId: ((id: string) => void) | null
      latestMenu: ElementContextMenuState | null | undefined
    } = { setDocumentId: null, latestMenu: undefined }
    function Harness() {
      const [documentId, setId] = useState<string | null>(DOCUMENT_ID)
      const { menu } = useElementContextMenu({ iframeRef: ref, active: true, documentId })
      useLayoutEffect(() => {
        state.setDocumentId = setId
        state.latestMenu = menu
      }, [setId, menu])
      return null
    }

    try {
      root.render(<Harness />)
      // The mount effect (which binds the listener) needs its own
      // macrotask, separate from the render that set `setDocumentId`.
      // Waiting only for the render is not enough, so this re-sends the
      // open event on each tick until it lands, rather than guessing a
      // fixed tick count for how many the environment needs to settle.
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
})
