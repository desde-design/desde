/**
 * Tests for `useEditorNoteBridge` — postMessage send/receive
 * contract, BRIDGE_READY epoch, cross-page highlight deferral,
 * source-filtering, enabled gate, and the one Note-specific listener
 * (`NOTE_ANCHOR_POSITIONS`) that the Comment bridge has no parallel
 * for.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useEditorNoteBridge } from "./useEditorNoteBridge"
import { useAppStore } from "@/stores"

function makeIframeRef(src?: string): {
  ref: { current: HTMLIFrameElement | null }
  postMessage: ReturnType<typeof vi.fn>
  /** The fake `contentWindow` — pass to `emitBridgeMessage` so `event.source`
   *  matches what the hook authenticates against (S10). */
  contentWindow: object
} {
  const postMessage = vi.fn()
  const contentWindow = { postMessage }
  const fakeIframe = { contentWindow, src } as unknown as HTMLIFrameElement
  const ref = { current: fakeIframe }
  return { ref, postMessage, contentWindow }
}

/**
 * Dispatch a bridge message as if it genuinely came from `source` — the
 * iframe's `contentWindow`.
 *
 * S10: the hook no longer trusts the `source` marker inside the payload (any
 * window can write it), so it checks `event.source` against the iframe's
 * content window. A source-less MessageEvent — which is what this helper used
 * to build — is now correctly rejected, hence the added first argument on
 * every call below.
 */
function emitBridgeMessage(
  source: object,
  type: string,
  payload: unknown,
  origin?: string,
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "desde-bridge", type, payload },
      source: source as Window,
      ...(origin === undefined ? {} : { origin }),
    }),
  )
}

beforeEach(() => {
  useAppStore.setState({
    activeNoteId: null,
    pendingNotePosition: null,
    notePopupAnchorRect: null,
    noteMode: false,
    toolMode: "navigate",
    noteAnchorRects: {},
  })
})

afterEach(() => {
  useAppStore.setState({
    activeNoteId: null,
    pendingNotePosition: null,
    notePopupAnchorRect: null,
    noteMode: false,
    toolMode: "navigate",
    noteAnchorRects: {},
  })
})

describe("useEditorNoteBridge", () => {
  it("enterNoteMode posts ENTER_NOTE_MODE and sets slice noteMode true", () => {
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.enterNoteMode()
    })

    expect(postMessage).toHaveBeenCalledWith({ type: "ENTER_NOTE_MODE" }, "*")
    expect(useAppStore.getState().noteMode).toBe(true)
  })

  // A comment-mode drop path. The bridge's ENTER_NOTE_MODE handler calls
  // `pins.exitPlacementMode()`, so asking for a note ends comment placement
  // inside the iframe. The shell has to record that, or both Comment
  // controls keep claiming a mode the bridge already left.
  it("enterNoteMode drops the shell out of comment mode", () => {
    const { ref } = makeIframeRef()
    useAppStore.setState({ toolMode: "comment" })
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.enterNoteMode()
    })

    expect(useAppStore.getState().toolMode).toBe("navigate")
  })

  it("exitNoteMode posts EXIT_NOTE_MODE and sets slice noteMode false", () => {
    const { ref, postMessage } = makeIframeRef()
    useAppStore.setState({ noteMode: true })
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.exitNoteMode()
    })

    expect(postMessage).toHaveBeenCalledWith({ type: "EXIT_NOTE_MODE" }, "*")
    expect(useAppStore.getState().noteMode).toBe(false)
  })

  it("setShowResolved, setNotesHidden post correct messages", () => {
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.setShowResolved(true)
      result.current.setNotesHidden(true)
    })

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { type: "SET_SHOW_RESOLVED_NOTES", payload: true },
      "*",
    )
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { type: "SET_NOTES_HIDDEN", payload: true },
      "*",
    )
  })

  it("syncNotes maps Note → BridgeNote and includes minimized flag", () => {
    const { ref, postMessage } = makeIframeRef()
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.syncNotes(
        [
          {
            id: "n1",
            number: 1,
            position: { anchorSelector: ".btn", page: "/" },
            body: "x",
            author: { uid: "", displayName: "u", email: "", photoURL: "" },
            createdAt: "2026-05-24T00:00:00Z",
            resolved: false,
            replies: [],
            mentions: [],
            participantEmails: [],
          },
          {
            id: "n2",
            number: 2,
            position: { anchorSelector: ".other", page: "/" },
            body: "y",
            author: { uid: "", displayName: "u", email: "", photoURL: "" },
            createdAt: "2026-05-24T00:00:00Z",
            resolved: true,
            replies: [],
            mentions: [],
            participantEmails: [],
          },
        ],
        new Set(["n2"]),
      )
    })

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "SET_NOTES",
        payload: [
          expect.objectContaining({ id: "n1", minimized: false }),
          expect.objectContaining({ id: "n2", minimized: true }),
        ],
      },
      "*",
    )
  })

  it("NOTE_PIN_CLICKED updates slice + fires onPinClicked", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() => useEditorNoteBridge(ref, { onPinClicked }))

    act(() => {
      emitBridgeMessage(contentWindow, "NOTE_PIN_CLICKED", {
        noteId: "n-9",
        pinRect: { top: 100, left: 200, width: 24, height: 24 },
      })
    })

    expect(useAppStore.getState().activeNoteId).toBe("n-9")
    expect(onPinClicked).toHaveBeenCalledWith("n-9")
  })

  it("NEW_NOTE_POSITION updates pendingNotePosition + exits note mode", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onNewNotePosition = vi.fn()
    useAppStore.setState({ noteMode: true })
    renderHook(() => useEditorNoteBridge(ref, { onNewNotePosition }))

    act(() => {
      emitBridgeMessage(contentWindow, "NEW_NOTE_POSITION", {
        anchorSelector: ".btn-primary",
        page: "/login",
        anchorX: 100,
        anchorY: 200,
        elementRect: { top: 90, left: 100, width: 200, height: 40 },
      })
    })

    const state = useAppStore.getState()
    expect(state.pendingNotePosition).toEqual({
      anchorSelector: ".btn-primary",
      page: "/login",
      anchorX: 100,
      anchorY: 200,
    })
    expect(state.noteMode).toBe(false)
    expect(onNewNotePosition).toHaveBeenCalledTimes(1)
  })

  it("NOTE_ANCHOR_POSITIONS converts array to Record<noteId, rect>", () => {
    const { ref, contentWindow } = makeIframeRef()
    renderHook(() => useEditorNoteBridge(ref))

    const r1 = { top: 10, left: 20, width: 24, height: 24 }
    const r2 = { top: 100, left: 200, width: 24, height: 24 }
    act(() => {
      emitBridgeMessage(contentWindow, "NOTE_ANCHOR_POSITIONS", [
        { noteId: "n1", rect: r1 },
        { noteId: "n2", rect: r2 },
      ])
    })

    expect(useAppStore.getState().noteAnchorRects).toEqual({
      n1: r1,
      n2: r2,
    })
  })

  it("ignores messages from a different source", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() => useEditorNoteBridge(ref, { onPinClicked }))

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            source: "some-other-thing",
            type: "NOTE_PIN_CLICKED",
            payload: { noteId: "x" },
          },
          source: contentWindow as unknown as Window,
        }),
      )
    })

    expect(onPinClicked).not.toHaveBeenCalled()
  })

  // S10 — the payload's `source` marker is a routing convenience, not a
  // credential. These two lock the checks that replaced it.
  it("ignores a well-formed bridge message from a DIFFERENT window", () => {
    const { ref, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    renderHook(() => useEditorNoteBridge(ref, { onPinClicked }))

    const otherWindow = { postMessage: vi.fn() }
    act(() => {
      emitBridgeMessage(otherWindow, "NOTE_PIN_CLICKED", { noteId: "x" })
    })
    expect(onPinClicked).not.toHaveBeenCalled()

    // The same message from the real iframe window IS handled — proving the
    // rejection above is about the sender, not about the payload.
    act(() => {
      emitBridgeMessage(contentWindow, "NOTE_PIN_CLICKED", { noteId: "n-ok" })
    })
    expect(onPinClicked).toHaveBeenCalledWith("n-ok")
  })

  it("ignores a message from the right window at the WRONG origin", () => {
    const { ref, contentWindow } = makeIframeRef("http://localhost:5173/")
    const onPinClicked = vi.fn()
    renderHook(() => useEditorNoteBridge(ref, { onPinClicked }))

    // The frame navigated itself somewhere hostile: `contentWindow` is stable
    // across navigation, so only the origin check catches this.
    act(() => {
      emitBridgeMessage(
        contentWindow,
        "NOTE_PIN_CLICKED",
        { noteId: "x" },
        "https://evil.example",
      )
    })
    expect(onPinClicked).not.toHaveBeenCalled()

    act(() => {
      emitBridgeMessage(
        contentWindow,
        "NOTE_PIN_CLICKED",
        { noteId: "n-ok" },
        "http://localhost:5173",
      )
    })
    expect(onPinClicked).toHaveBeenCalledWith("n-ok")
  })

  // K12 — note bodies + author identity ride this channel, so the outbound
  // post names the prototype origin instead of broadcasting.
  it("posts to the resolved prototype origin when the iframe src is known", () => {
    const { ref, postMessage } = makeIframeRef("http://localhost:5173/app")
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.enterNoteMode()
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "ENTER_NOTE_MODE" },
      "http://localhost:5173",
    )
  })

  it("stays inert when enabled=false (no post, no window listener)", () => {
    const { ref, postMessage, contentWindow } = makeIframeRef()
    const onPinClicked = vi.fn()
    const { result } = renderHook(() =>
      useEditorNoteBridge(ref, { enabled: false, onPinClicked }),
    )

    act(() => {
      result.current.enterNoteMode()
    })
    expect(postMessage).not.toHaveBeenCalled()

    act(() => {
      emitBridgeMessage(contentWindow, "NOTE_PIN_CLICKED", { noteId: "x" })
    })
    expect(onPinClicked).not.toHaveBeenCalled()
  })

  it("BRIDGE_READY increments bridgeReadyEpoch", () => {
    const { ref, contentWindow } = makeIframeRef()
    const { result } = renderHook(() => useEditorNoteBridge(ref))
    expect(result.current.bridgeReadyEpoch).toBe(0)
    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    expect(result.current.bridgeReadyEpoch).toBe(1)
    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    expect(result.current.bridgeReadyEpoch).toBe(2)
  })

  it("highlightNote defers HIGHLIGHT_NOTE until BRIDGE_READY for a cross-page target", () => {
    vi.useFakeTimers()
    const { ref, postMessage, contentWindow } = makeIframeRef()
    useAppStore.setState({
      notes: [
        {
          id: "n-far",
          number: 1,
          body: "x",
          position: { anchorSelector: ".btn", page: "/signup" },
          author: { uid: "", displayName: "", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
      currentDisplayRoute: "/login",
    })
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.highlightNote("n-far")
    })

    // Only NAVIGATE has fired — HIGHLIGHT_NOTE is pending.
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: "NAVIGATE", payload: { page: "/signup" } },
      "*",
    )

    act(() => {
      emitBridgeMessage(contentWindow, "BRIDGE_READY", {})
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(postMessage).toHaveBeenCalledWith(
      { type: "HIGHLIGHT_NOTE", payload: { noteId: "n-far" } },
      "*",
    )
    vi.useRealTimers()
  })

  it("highlightNote skips NAVIGATE when target page matches current route", () => {
    const { ref, postMessage } = makeIframeRef()
    useAppStore.setState({
      notes: [
        {
          id: "n-here",
          number: 1,
          body: "x",
          position: { anchorSelector: ".btn", page: "/login" },
          author: { uid: "", displayName: "", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
      currentDisplayRoute: "/login",
    })
    const { result } = renderHook(() => useEditorNoteBridge(ref))

    act(() => {
      result.current.highlightNote("n-here")
    })

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(
      { type: "HIGHLIGHT_NOTE", payload: { noteId: "n-here" } },
      "*",
    )
  })
})
