import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useRef } from "react"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

/**
 * Notes went dormant 2026-08-14 (see `EDITOR_NOTES`), and this file is the
 * suite that covers them. Dormancy covers the product surface and never the
 * gate: a dormant surface whose tests rot is one that cannot be un-dormanted,
 * so every assertion here runs with the surface turned ON.
 *
 * The dormant half lives in `editor-comments-container.notes-dormant.test.tsx`,
 * because the flag is read at module load and one file cannot hold both states.
 * Only the one key is overridden, so every other flag keeps its real value.
 */
vi.mock("@/lib/editor-feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/editor-feature-flags")>()),
  EDITOR_NOTES: true,
}))

// Stub both HTTP store factories. We don't go through the
// `useLocal*({ store })` override here so the test exercises the
// real factory entry path used by the container.
const mockCommentStore = {
  list: vi.fn(async (): Promise<Comment[]> => []),
  get: vi.fn(),
  create: vi.fn(async () => ({
    id: "c-server-1",
    number: 1,
    body: "Hello",
    position: { anchorSelector: ".btn", page: "/" },
    author: {
      uid: "cli-local",
      displayName: "Local user",
      email: "",
      photoURL: "",
    },
    createdAt: "2026-05-24T00:00:00Z",
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
  })),
  update: vi.fn(),
  delete: vi.fn(),
  addReply: vi.fn(),
  subscribe: vi.fn(
    (cb: (comments: Comment[]) => void, onError?: (e: unknown) => void) => {
      void mockCommentStore
        .list()
        .then((l) => cb(l))
        .catch((e) => onError?.(e))
      return () => {}
    },
  ),
}
const mockNoteStore = {
  list: vi.fn(async (): Promise<Note[]> => []),
  get: vi.fn(),
  create: vi.fn(async () => ({
    id: "n-server-1",
    number: 1,
    body: "Hello",
    position: { anchorSelector: ".btn", page: "/" },
    author: {
      uid: "cli-local",
      displayName: "Local user",
      email: "",
      photoURL: "",
    },
    createdAt: "2026-05-24T00:00:00Z",
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
  })),
  update: vi.fn(),
  delete: vi.fn(),
  addReply: vi.fn(),
}
vi.mock("@/services/artifact-stores", () => ({
  createHttpCommentStore: () => mockCommentStore,
  createHttpNoteStore: () => mockNoteStore,
}))

import { EditorCommentsContainer } from "./editor-comments-container"
import { requestCommentMode } from "./request-comment-mode"
import { useEditorToolMode } from "@/hooks/useEditorToolMode"
import { useEditorCommentStore } from "@/hooks/useEditorCommentStore"
import { useEditorCommentBridge } from "@/hooks/useEditorCommentBridge"
import { useAppStore } from "@/stores"
import type { Comment } from "@/types/bridge"
import type { Note } from "@/types/note"

/**
 * Stands in for `EditorSurface`: the comment bridge and comment store are
 * mounted HERE (as they are in the product since 2026-08-14) and handed to
 * the container as props. Wiring them for real, rather than stubbing them,
 * is what keeps the end-to-end assertions in this file honest.
 */
function TestHarness({
  onPinClicked,
  onEscalateToChat,
  setEditorActive = vi.fn(async () => {}),
}: {
  onPinClicked?: (id: string, kind: "comment" | "note") => void
  onEscalateToChat?: (prompt: string) => boolean
  setEditorActive?: (active: boolean) => Promise<void>
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const commentSync = useEditorCommentStore()
  const commentBridge = useEditorCommentBridge(iframeRef, {
    enabled: true,
    onPinClicked: (id) => onPinClicked?.(id, "comment"),
  })
  const { requestToolMode } = useEditorToolMode({
    setEditorActive,
    enterCommentMode: commentBridge.enterCommentMode,
    exitCommentMode: commentBridge.exitCommentMode,
  })
  return (
    <>
      <iframe ref={iframeRef} title="test-iframe" />
      <EditorCommentsContainer
        iframeRef={iframeRef}
        commentBridge={commentBridge}
        commentSync={commentSync}
        onCommentModeChange={(next) => {
          if (!next) {
            requestToolMode("navigate")
            return
          }
          requestCommentMode({
            resolving: commentSync.resolving,
            resolveFailed: commentSync.resolveFailed,
            setToolMode: requestToolMode,
          })
        }}
        onPinClicked={onPinClicked}
        onEscalateToChat={onEscalateToChat}
      />
    </>
  )
}

beforeEach(() => {
  useAppStore.setState({
    comments: [],
    notes: [],
    activeCommentId: null,
    activeNoteId: null,
    pendingPosition: null,
    pendingNotePosition: null,
    popupAnchorRect: null,
    notePopupAnchorRect: null,
    toolMode: "navigate",
    noteMode: false,
    showResolved: false,
    showResolvedNotes: false,
    pinsHidden: false,
    notesHidden: false,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
    noteAnchorRects: {},
  })
  mockCommentStore.list.mockClear()
  mockCommentStore.create.mockClear()
  mockNoteStore.list.mockClear()
  mockNoteStore.create.mockClear()
  mockCommentStore.list.mockResolvedValue([])
  mockNoteStore.list.mockResolvedValue([])
})

afterEach(() => {
  useAppStore.setState({
    comments: [],
    notes: [],
    activeCommentId: null,
    activeNoteId: null,
    pendingPosition: null,
    pendingNotePosition: null,
    popupAnchorRect: null,
    notePopupAnchorRect: null,
    toolMode: "navigate",
    noteMode: false,
    showResolved: false,
    showResolvedNotes: false,
    pinsHidden: false,
    notesHidden: false,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
    noteAnchorRects: {},
  })
})

describe("EditorCommentsContainer", () => {
  it("mounts and renders the merged comments panel with empty state", async () => {
    render(<TestHarness />)
    expect(
      screen.getByTestId("editor-comments-container"),
    ).toBeInTheDocument()
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mockNoteStore.list).toHaveBeenCalledTimes(1))
    // With no viewer attached the panel now asks for one instead of inviting
    // a comment that nobody could read. Same empty surface, honest content.
    expect(screen.getByTestId("comments-needs-viewer")).toBeInTheDocument()
  })

  it("clicking the Comment button posts ENTER_COMMENT_MODE and drops Select", async () => {
    const setEditorActive = vi.fn(async () => {})
    render(<TestHarness setEditorActive={setEditorActive} />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    })

    // Button text is "Comment" — title="Add comment" is a tooltip
    // hint, but the accessible name comes from the text content. Use
    // the title selector so the assertion can read like the intent.
    const addButton = screen.getByTitle(/Add comment/i)
    fireEvent.click(addButton)

    expect(postMessage).toHaveBeenCalledWith(
      { type: "ENTER_COMMENT_MODE" },
      "*",
    )
    // The panel's Comment button is fed the SAME lifted handler as the
    // toolbar's, so it gets the Select teardown too.
    expect(setEditorActive).toHaveBeenCalledWith(false)
    expect(useAppStore.getState().toolMode).toBe("comment")
  })

  // The panel's Comment button used to be enter-only, so a mode started
  // anywhere could not be ended here.
  it("the panel's Comment button can also EXIT the mode it started", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    })

    const button = screen.getByTestId("comments-panel-comment")
    fireEvent.click(button)
    expect(button.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(button)
    expect(button.getAttribute("aria-pressed")).toBe("false")
    expect(postMessage).toHaveBeenCalledWith({ type: "EXIT_COMMENT_MODE" }, "*")
  })

  it("clicking the Note button posts ENTER_NOTE_MODE", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockNoteStore.list).toHaveBeenCalled())

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    })

    const addButton = screen.getByTitle(/Add note/i)
    fireEvent.click(addButton)

    expect(postMessage).toHaveBeenCalledWith(
      { type: "ENTER_NOTE_MODE" },
      "*",
    )
  })

  it("fires onPinClicked with kind 'comment' for COMMENT_PIN_CLICKED", async () => {
    const onPinClicked = vi.fn()
    render(<TestHarness onPinClicked={onPinClicked} />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())

    // S10: the comment/note bridge hooks authenticate `event.source` against
    // the iframe's content window — the `source` marker inside the payload is
    // forgeable and no longer sufficient on its own. Every dispatch in this
    // file therefore names the window it is pretending to come from.
    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "desde-bridge",
          type: "COMMENT_PIN_CLICKED",
          payload: {
            commentId: "c-xyz",
            pinRect: { top: 0, left: 0, width: 10, height: 10 },
          },
        },
        source: iframe.contentWindow,
      }),
    )

    expect(onPinClicked).toHaveBeenCalledWith("c-xyz", "comment")
  })

  it("fires onPinClicked with kind 'note' for NOTE_PIN_CLICKED", async () => {
    const onPinClicked = vi.fn()
    render(<TestHarness onPinClicked={onPinClicked} />)
    await waitFor(() => expect(mockNoteStore.list).toHaveBeenCalled())

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "desde-bridge",
          type: "NOTE_PIN_CLICKED",
          payload: {
            noteId: "n-xyz",
            pinRect: { top: 0, left: 0, width: 10, height: 10 },
          },
        },
        source: iframe.contentWindow,
      }),
    )

    expect(onPinClicked).toHaveBeenCalledWith("n-xyz", "note")
  })

  it("syncs comments AND notes to the bridge after BRIDGE_READY", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    })

    // Both containers hold back the initial sync until BRIDGE_READY.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "desde-bridge",
          type: "BRIDGE_READY",
          payload: {},
        },
        source: iframe.contentWindow,
      }),
    )

    useAppStore.setState({
      comments: [
        {
          id: "c1",
          number: 1,
          body: "hi",
          position: { anchorSelector: ".btn", page: "/" },
          author: { uid: "u", displayName: "u", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
      notes: [
        {
          id: "n1",
          number: 1,
          body: "note",
          position: { anchorSelector: ".btn", page: "/" },
          author: { uid: "u", displayName: "u", email: "", photoURL: "" },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        },
      ],
    })

    await waitFor(() => {
      const setComments = postMessage.mock.calls.find(
        (c) => (c[0] as { type?: string }).type === "SET_COMMENTS",
      )
      const setNotes = postMessage.mock.calls.find(
        (c) => (c[0] as { type?: string }).type === "SET_NOTES",
      )
      expect(setComments).toBeTruthy()
      expect(setNotes).toBeTruthy()
    })
  })

  it("re-sends SET_NOTES when minimizedNoteIds changes", async () => {
    // The container's useLocalNotes refreshes on mount and overwrites
    // the slice's notes with the store list — so seed the MOCK STORE,
    // not the slice directly. (Seeding the slice gets clobbered by
    // the initial refresh.)
    mockNoteStore.list.mockResolvedValueOnce([
      {
        id: "n1",
        number: 1,
        body: "x",
        position: { anchorSelector: ".btn", page: "/" },
        author: { uid: "u", displayName: "u", email: "", photoURL: "" },
        createdAt: "2026-05-24T00:00:00Z",
        resolved: false,
        replies: [],
        mentions: [],
        participantEmails: [],
      },
    ])

    render(<TestHarness />)
    await waitFor(() => expect(mockNoteStore.list).toHaveBeenCalled())
    await waitFor(() => {
      expect(useAppStore.getState().notes).toHaveLength(1)
    })

    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { postMessage },
    })

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          source: "desde-bridge",
          type: "BRIDGE_READY",
          payload: {},
        },
        source: iframe.contentWindow,
      }),
    )

    await waitFor(() => {
      expect(
        postMessage.mock.calls.some(
          (c) => (c[0] as { type?: string }).type === "SET_NOTES",
        ),
      ).toBe(true)
    })

    const callsBefore = postMessage.mock.calls.length

    // Toggle minimization — should trigger another SET_NOTES.
    useAppStore.setState({ minimizedNoteIds: new Set(["n1"]) })

    await waitFor(() => {
      expect(postMessage.mock.calls.length).toBeGreaterThan(callsBefore)
      const lastSetNotes = postMessage.mock.calls
        .filter((c) => (c[0] as { type?: string }).type === "SET_NOTES")
        .pop()
      const payload = (lastSetNotes?.[0] as { payload?: unknown[] }).payload as
        | { id: string; minimized: boolean }[]
        | undefined
      expect(payload?.[0].minimized).toBe(true)
    })
  })

  it("'Fix with AI' on a comment escalates a grounded prompt to chat and closes the thread", async () => {
    mockCommentStore.list.mockResolvedValueOnce([
      {
        id: "c-fix",
        number: 7,
        body: "Make this larger, cc @[Mo](mo@x.com)",
        position: { anchorSelector: "#app > main > h1", page: "/dashboard" },
        author: { uid: "u", displayName: "Reviewer", email: "", photoURL: "" },
        createdAt: "2026-05-24T00:00:00Z",
        resolved: false,
        replies: [],
        mentions: [],
        participantEmails: [],
      },
    ])
    const onEscalateToChat = vi.fn((_prompt: string) => true)
    render(<TestHarness onEscalateToChat={onEscalateToChat} />)
    await waitFor(() => expect(useAppStore.getState().comments).toHaveLength(1))

    // Open the comment thread (what a pin click does).
    useAppStore.setState({ activeCommentId: "c-fix" })

    const fixButton = await screen.findByText(/Fix with AI/i)
    fireEvent.click(fixButton)

    expect(onEscalateToChat).toHaveBeenCalledTimes(1)
    const prompt = onEscalateToChat.mock.calls[0][0]
    expect(prompt).toContain("comment #7")
    expect(prompt).toContain("Make this larger, cc @Mo") // mention decoded
    expect(prompt).toContain("selector: #app > main > h1")
    expect(prompt).toContain('page "/dashboard"')

    // Thread closes after handing off.
    expect(useAppStore.getState().activeCommentId).toBeNull()
  })

  it("keeps the comment thread OPEN when the chat handoff is rejected", async () => {
    mockCommentStore.list.mockResolvedValueOnce([
      {
        id: "c-reject",
        number: 2,
        body: "fix me",
        position: { anchorSelector: ".btn", page: "/" },
        author: { uid: "u", displayName: "Reviewer", email: "", photoURL: "" },
        createdAt: "2026-05-24T00:00:00Z",
        resolved: false,
        replies: [],
        mentions: [],
        participantEmails: [],
      },
    ])
    // Handoff rejected (e.g. edit session not active yet).
    const onEscalateToChat = vi.fn((_prompt: string) => false)
    render(<TestHarness onEscalateToChat={onEscalateToChat} />)
    await waitFor(() => expect(useAppStore.getState().comments).toHaveLength(1))
    useAppStore.setState({ activeCommentId: "c-reject" })

    fireEvent.click(await screen.findByText(/Fix with AI/i))

    expect(onEscalateToChat).toHaveBeenCalledTimes(1)
    // Intent preserved: the thread stays open so the user can retry.
    expect(useAppStore.getState().activeCommentId).toBe("c-reject")
  })

  it("hides the 'Fix with AI' button when no chat handoff is wired", async () => {
    mockCommentStore.list.mockResolvedValueOnce([
      {
        id: "c-nofix",
        number: 1,
        body: "no fix button here",
        position: { anchorSelector: ".btn", page: "/" },
        author: { uid: "u", displayName: "u", email: "", photoURL: "" },
        createdAt: "2026-05-24T00:00:00Z",
        resolved: false,
        replies: [],
        mentions: [],
        participantEmails: [],
      },
    ])
    render(<TestHarness />) // no onEscalateToChat
    await waitFor(() => expect(useAppStore.getState().comments).toHaveLength(1))
    useAppStore.setState({ activeCommentId: "c-nofix" })

    // The thread renders (Reply present) but no Fix affordance.
    expect(await screen.findByText(/Reply/i)).toBeInTheDocument()
    expect(screen.queryByText(/Fix with AI/i)).not.toBeInTheDocument()
  })

  it("surfaces a single retry banner that refreshes BOTH stores", async () => {
    mockCommentStore.list.mockRejectedValueOnce(new Error("bad comments"))
    render(<TestHarness />)

    await waitFor(() => {
      expect(screen.getByTestId("comments-error-banner")).toBeInTheDocument()
    })

    // Retry should call both list() methods again.
    mockCommentStore.list.mockResolvedValueOnce([])
    mockNoteStore.list.mockResolvedValueOnce([])
    const initialCallsC = mockCommentStore.list.mock.calls.length
    const initialCallsN = mockNoteStore.list.mock.calls.length

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }))

    await waitFor(() => {
      expect(mockCommentStore.list.mock.calls.length).toBeGreaterThan(
        initialCallsC,
      )
      expect(mockNoteStore.list.mock.calls.length).toBeGreaterThan(
        initialCallsN,
      )
    })
  })
})
