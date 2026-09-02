import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { useRef } from "react"

/**
 * The dormant twin of `editor-comments-container.test.tsx`.
 *
 * That file runs every Notes assertion with `EDITOR_NOTES` forced ON, because
 * dormancy covers the product surface and never the gate. This file is the
 * other half of the pair: the same container, with the flag at its shipped
 * default, proving the offering is actually withheld.
 *
 * A separate file rather than a second `describe`, because the flag is read at
 * module load and one module registry cannot hold both states.
 *
 * The three things asserted here map to the three ways Notes reach the user:
 * the CONTROL that creates one, the DATA the panel would list, and the BRIDGE
 * that paints pins inside the iframe. Checking only the button would leave a
 * dormant surface still fetching and still posting.
 */

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/editor-feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/editor-feature-flags")>()),
  EDITOR_NOTES: false,
}))

const mockCommentStore = {
  list: vi.fn(async (): Promise<Comment[]> => []),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  addReply: vi.fn(),
  subscribe: vi.fn((cb: (comments: Comment[]) => void) => {
    void mockCommentStore.list().then((l) => cb(l))
    return () => {}
  }),
}
const mockNoteStore = {
  list: vi.fn(async (): Promise<Note[]> => []),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  addReply: vi.fn(),
}
vi.mock("@/services/artifact-stores", () => ({
  createHttpCommentStore: () => mockCommentStore,
  createHttpNoteStore: () => mockNoteStore,
}))

import { EditorCommentsContainer } from "./editor-comments-container"
import { useEditorCommentStore } from "@/hooks/useEditorCommentStore"
import { useEditorCommentBridge } from "@/hooks/useEditorCommentBridge"
import { useAppStore } from "@/stores"
import type { Comment } from "@/types/bridge"
import type { Note } from "@/types/note"

function TestHarness() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const commentSync = useEditorCommentStore()
  const commentBridge = useEditorCommentBridge(iframeRef, { enabled: true })
  return (
    <>
      <iframe ref={iframeRef} title="test-iframe" />
      <EditorCommentsContainer
        iframeRef={iframeRef}
        commentBridge={commentBridge}
        commentSync={commentSync}
        onCommentModeChange={vi.fn()}
      />
    </>
  )
}

const EMPTY_STORE_STATE = {
  comments: [],
  notes: [],
  activeCommentId: null,
  activeNoteId: null,
  pendingPosition: null,
  pendingNotePosition: null,
  popupAnchorRect: null,
  notePopupAnchorRect: null,
  toolMode: "navigate" as const,
  noteMode: false,
  showResolved: false,
  showResolvedNotes: false,
  pinsHidden: false,
  notesHidden: false,
  minimizedNoteIds: new Set<string>(),
  expandedNoteIds: new Set<string>(),
  noteAnchorRects: {},
}

beforeEach(() => {
  useAppStore.setState(EMPTY_STORE_STATE)
  mockCommentStore.list.mockClear()
  mockNoteStore.list.mockClear()
  mockCommentStore.list.mockResolvedValue([])
  mockNoteStore.list.mockResolvedValue([])
})

afterEach(() => {
  useAppStore.setState(EMPTY_STORE_STATE)
})

describe("EditorCommentsContainer with Notes dormant", () => {
  it("offers no Note button", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())
    expect(screen.queryByTitle("Add note")).not.toBeInTheDocument()
    // The Comment control is untouched, so this is a Notes gate and not a
    // panel that failed to render.
    expect(screen.getByTestId("comments-panel-comment")).toBeInTheDocument()
  })

  it("never fetches notes, so the dormant route is never called", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())
    expect(mockNoteStore.list).not.toHaveBeenCalled()
  })

  it("never posts to the note bridge, so no pins are painted in the iframe", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())
    const iframe = screen.getByTitle("test-iframe") as HTMLIFrameElement
    const postMessage = vi.fn()
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage },
      configurable: true,
    })
    // A note landing in the slice is the strongest trigger the sync effect
    // has. With the bridge disabled it must still post nothing.
    useAppStore.setState({
      notes: [
        {
          id: "n1",
          number: 1,
          body: "note",
          position: { anchorSelector: ".btn", page: "/" },
          author: {
            uid: "u",
            displayName: "U",
            email: "",
            photoURL: "",
          },
          createdAt: "2026-05-24T00:00:00Z",
          resolved: false,
          replies: [],
          mentions: [],
          participantEmails: [],
        } as Note,
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const noteMessages = postMessage.mock.calls.filter((call) =>
      String((call[0] as { type?: string })?.type ?? "").includes("NOTE"),
    )
    expect(noteMessages).toEqual([])
  })

  it("reads as a comments-only surface in its own copy", async () => {
    render(<TestHarness />)
    await waitFor(() => expect(mockCommentStore.list).toHaveBeenCalled())
    expect(screen.getByText("Comments on the prototype")).toBeInTheDocument()
    expect(
      // Reaches the viewer gate first (no viewer in this harness), which is
      // still comments-only copy — the point this test is making. It must not
      // mention notes.
      screen.getByTestId("comments-needs-viewer"),
    ).toBeInTheDocument()
    expect(screen.queryByText(/note/i)).not.toBeInTheDocument()
  })
})
