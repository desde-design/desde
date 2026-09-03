/**
 * Tests for `CommentsListPanel` — the Comments-tab UI that replaces
 * the separate CommentPanel / NotePanel mounts in the editor
 * surface. Pure presentational, so the tests focus on:
 *   - interleaved sorting by createdAt desc
 *   - per-row click routes to the correct highlight handler
 *   - the Resolved switch toggles both kinds in sync (Hide moved to the toolbar)
 *   - "Minimize all notes" affordance appears only when notes exist
 *   - empty state shows the merged copy ("No comments")
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { CommentsListPanel } from "./comments-list-panel"
import { useAppStore } from "@/stores"
import type { Comment } from "@/types/bridge"
import type { Note } from "@/types/note"

function makeComment(
  id: string,
  createdAt: string,
  overrides: Partial<Comment> = {},
): Comment {
  return {
    id,
    number: 1,
    body: `comment ${id}`,
    position: { anchorSelector: ".btn", page: "/" },
    author: { uid: "u", displayName: "Alice", email: "", photoURL: "" },
    createdAt,
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
    ...overrides,
  }
}

function makeNote(
  id: string,
  createdAt: string,
  overrides: Partial<Note> = {},
): Note {
  return {
    id,
    number: 1,
    body: `note ${id}`,
    position: { anchorSelector: ".btn", page: "/" },
    author: { uid: "u", displayName: "Bob", email: "", photoURL: "" },
    createdAt,
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
    ...overrides,
  }
}

function makeProps() {
  return {
    onHighlightComment: vi.fn(),
    onHighlightNote: vi.fn(),
    onCommentModeChange: vi.fn(),
    onAddNote: vi.fn(),
    onShowResolvedChange: vi.fn(),
    onShowResolvedNotesChange: vi.fn(),
  }
}

beforeEach(() => {
  useAppStore.setState({
    comments: [],
    notes: [],
    activeCommentId: null,
    activeNoteId: null,
    pinsHidden: false,
    notesHidden: false,
    showResolved: false,
    showResolvedNotes: false,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
  })
})

afterEach(() => {
  useAppStore.setState({
    comments: [],
    notes: [],
    activeCommentId: null,
    activeNoteId: null,
    pinsHidden: false,
    notesHidden: false,
    showResolved: false,
    showResolvedNotes: false,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
  })
})

describe("CommentsListPanel", () => {
  /**
   * Comments with nowhere to go. Without a viewer and project a comment is
   * written to this machine and read by nobody, so inviting one is inviting
   * work that quietly goes nowhere.
   *
   * This replaced the "Local" / "Synced" badge, which carried the same fact in
   * one word with the explanation hidden in a `title` tooltip.
   */
  it("asks for a viewer instead of inviting a comment when none is attached", () => {
    render(
      <CommentsListPanel
        onHighlightComment={vi.fn()}
        onCommentModeChange={vi.fn()}
        onShowResolvedChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId("comments-needs-viewer")).toBeInTheDocument()
    // NOT the "add a comment to get started" invitation.
    expect(screen.queryByTestId("comments-list-empty")).not.toBeInTheDocument()
    expect(screen.getByTestId("comments-viewer-docs-link")).toHaveAttribute(
      "href",
      expect.stringContaining("/docs/viewer/"),
    )
  })

  it("names the missing token when a viewer IS configured", () => {
    render(
      <CommentsListPanel
        syncMode="local"
        needsViewerToken
        onHighlightComment={vi.fn()}
        onCommentModeChange={vi.fn()}
        onShowResolvedChange={vi.fn()}
      />,
    )
    // A different problem from "no viewer at all", and a different fix.
    expect(screen.getByTestId("comments-needs-viewer")).toHaveTextContent(
      /access token/i,
    )
  })

  it("shows the merged empty state when nothing exists", () => {
    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)
    expect(screen.getByTestId("comments-list-empty")).toBeInTheDocument()
    expect(screen.getByText(/^No comments$/i)).toBeInTheDocument()
  })

  it("interleaves comments and notes sorted by createdAt desc", () => {
    useAppStore.setState({
      comments: [
        makeComment("c1", "2026-05-23T10:00:00Z"),
        makeComment("c2", "2026-05-23T13:00:00Z"),
      ],
      notes: [
        makeNote("n1", "2026-05-23T11:00:00Z"),
        makeNote("n2", "2026-05-23T12:00:00Z"),
      ],
    })

    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)
    const rows = [
      screen.getByTestId("annotation-row-comment-c2"),
      screen.getByTestId("annotation-row-note-n2"),
      screen.getByTestId("annotation-row-note-n1"),
      screen.getByTestId("annotation-row-comment-c1"),
    ]
    // Verify document order matches createdAt desc.
    const allRows = screen.getAllByTestId(/^annotation-row-/)
    expect(allRows.map((r) => r.getAttribute("data-testid"))).toEqual(
      rows.map((r) => r.getAttribute("data-testid")),
    )
  })

  it("clicking a comment row routes through onHighlightComment", () => {
    useAppStore.setState({
      comments: [makeComment("c1", "2026-05-23T10:00:00Z")],
    })
    const props = makeProps()
    render(<CommentsListPanel syncMode="viewer" {...props} />)

    fireEvent.click(screen.getByTestId("annotation-row-comment-c1"))
    expect(props.onHighlightComment).toHaveBeenCalledWith("c1")
    expect(useAppStore.getState().activeCommentId).toBe("c1")
  })

  it("clicking a note row routes through onHighlightNote and un-minimizes", () => {
    useAppStore.setState({
      notes: [makeNote("n1", "2026-05-23T10:00:00Z")],
      minimizedNoteIds: new Set(["n1"]),
    })
    const props = makeProps()
    render(<CommentsListPanel syncMode="viewer" {...props} />)

    fireEvent.click(screen.getByTestId("annotation-row-note-n1"))
    expect(props.onHighlightNote).toHaveBeenCalledWith("n1")
    expect(useAppStore.getState().activeNoteId).toBe("n1")
    // toggleNoteMinimized moved n1 out of minimizedNoteIds since it
    // was the only one expanded (slice's "only one expanded at a
    // time" semantics — re-minimizes everyone else, expands target).
    expect(useAppStore.getState().expandedNoteIds.has("n1")).toBe(true)
  })

  it("search narrows the list, says so when nothing matches, and clears", () => {
    useAppStore.setState({
      comments: [
        makeComment("c-hero", "2026-05-23T10:00:00Z", { body: "The hero copy is too long" }),
        makeComment("c-footer", "2026-05-23T11:00:00Z", { body: "Footer links are misaligned" }),
      ],
      notes: [],
    })
    render(<CommentsListPanel syncMode="viewer" {...makeCommentsOnlyProps()} />)
    const search = screen.getByTestId("comment-search") as HTMLInputElement
    fireEvent.change(search, { target: { value: "footer" } })
    expect(screen.queryByTestId("annotation-row-comment-c-hero")).toBeNull()
    expect(screen.getByTestId("annotation-row-comment-c-footer")).toBeInTheDocument()

    fireEvent.change(search, { target: { value: "zzqx" } })
    expect(screen.getByTestId("comment-search-no-matches")).toBeInTheDocument()
    // The field stays on screen so the query can be edited, not only thrown away.
    expect(screen.getByTestId("comment-search")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getAllByTestId(/^annotation-row-/)).toHaveLength(2)
  })

  it("hides resolved rows when Show resolved is off", () => {
    useAppStore.setState({
      comments: [
        makeComment("c-resolved", "2026-05-23T10:00:00Z", { resolved: true }),
        makeComment("c-open", "2026-05-23T11:00:00Z"),
      ],
      notes: [
        makeNote("n-resolved", "2026-05-23T12:00:00Z", { resolved: true }),
      ],
    })
    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)
    expect(screen.queryByTestId("annotation-row-comment-c-resolved")).toBeNull()
    expect(screen.queryByTestId("annotation-row-note-n-resolved")).toBeNull()
    expect(
      screen.getByTestId("annotation-row-comment-c-open"),
    ).toBeInTheDocument()
  })

  it("Minimize-all-notes affordance hides when no notes exist", () => {
    useAppStore.setState({
      comments: [makeComment("c1", "2026-05-23T10:00:00Z")],
      notes: [],
    })
    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)

    // The ⋮ menu carries only the minimize-all entry, so with no notes the
    // menu itself is not rendered.
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument()
    expect(
      screen.queryByText(/(Minimize|Expand) all notes/i),
    ).not.toBeInTheDocument()
  })

  it("shows the merged copy while the note handlers are present", () => {
    // The paired half of the "Notes dormant" block below. It is here so the
    // two states are read side by side, and so a change to the merged copy
    // cannot pass by silently matching the comments-only wording.
    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)
    expect(screen.getByTitle("Add note")).toBeInTheDocument()
    expect(
      screen.getByText("Add a comment or note to get started"),
    ).toBeInTheDocument()
  })

  it("renders a single-initial fallback when author has no photoURL", () => {
    useAppStore.setState({
      comments: [
        makeComment("c1", "2026-05-23T10:00:00Z", {
          author: {
            uid: "x",
            displayName: "Charlie Brown",
            email: "",
            photoURL: "",
          },
        }),
      ],
    })
    render(<CommentsListPanel syncMode="viewer" {...makeProps()} />)

    // No <img>; instead an aria-labelled <span> with ONE initial.
    //
    // "C", not "CB" (Mo, 2026-08-19). Two letters read as a monogram, which is
    // a different kind of thing from "we could not show you this person's
    // picture" — and in a 16px circle they are a smudge. See
    // `src/lib/initials.ts`, which this and the two Viewer avatars now share.
    expect(screen.getByLabelText(/Charlie Brown/i).textContent).toBe("C")
  })
})

/**
 * Notes are dormant by default (`EDITOR_NOTES`, product decision 2026-08-14).
 * The panel never reads that flag: the container withholds the four note
 * handlers, and their absence is what the panel gates on. So these tests drop
 * the handlers rather than mocking a module, which is also the only way to
 * assert the rule the props document.
 */
function makeCommentsOnlyProps() {
  return {
    onHighlightComment: vi.fn(),
    onCommentModeChange: vi.fn(),
    onShowResolvedChange: vi.fn(),
  }
}

describe("CommentsListPanel with Notes dormant", () => {
  it("offers no Note button, and keeps the Comment control", () => {
    render(<CommentsListPanel syncMode="viewer" {...makeCommentsOnlyProps()} />)
    expect(screen.queryByTitle("Add note")).not.toBeInTheDocument()
    expect(screen.getByTestId("comments-panel-comment")).toBeInTheDocument()
  })

  it("drops note rows from the merged list, keeping comment rows", () => {
    useAppStore.setState({
      comments: [makeComment("c1", "2026-05-23T10:00:00Z")],
      notes: [makeNote("n1", "2026-05-23T11:00:00Z")],
    })
    render(<CommentsListPanel syncMode="viewer" {...makeCommentsOnlyProps()} />)
    expect(screen.getByTestId("annotation-row-comment-c1")).toBeInTheDocument()
    expect(
      screen.queryByTestId("annotation-row-note-n1"),
    ).not.toBeInTheDocument()
  })

  it("reads as a comments-only surface in its empty state", () => {
    render(<CommentsListPanel syncMode="viewer" {...makeCommentsOnlyProps()} />)
    expect(
      screen.getByText("Add a comment to get started"),
    ).toBeInTheDocument()
  })

  it("hides the minimize-all-notes item even when notes exist in the store", () => {
    useAppStore.setState({ notes: [makeNote("n1", "2026-05-23T11:00:00Z")] })
    render(<CommentsListPanel syncMode="viewer" {...makeCommentsOnlyProps()} />)
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument()
    expect(
      screen.queryByText(/(Minimize|Expand) all notes/i),
    ).not.toBeInTheDocument()
  })
})
