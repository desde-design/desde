import { describe, it, expect, beforeEach } from "vitest"
import { useAppStore } from "@/stores"
import type { Comment } from "@/types/bridge"

const mockAuthor = {
  uid: "test-user-001",
  displayName: "Test User",
  email: "test@example.com",
  photoURL: "",
}

const mockPosition = {
  anchorSelector: '[data-flow-id="test-input"]',
  page: "/contact",
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
    number: 1,
    position: mockPosition,
    body: "Test comment",
    author: mockAuthor,
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [mockAuthor.email],
    ...overrides,
  }
}

// `addComment` / `addReply` / `toggleResolved` / `deleteComment` were removed
// 2026-08-08 (dead code audit — the only mount site for `CommentThreadPopup`,
// `editor-comments-container.tsx`, unconditionally passes HTTP-backed
// overrides for all four, so the slice-backed fallback was unreachable).
// These tests now seed `comments` directly via `setState` and cover only the
// surviving slice actions.
describe("comment-slice", () => {
  beforeEach(() => {
    useAppStore.setState({
      comments: [],
      activeCommentId: null,
      showResolved: false,
      pinsHidden: false,
      pendingPosition: null,
    })
  })

  it("sets the comment list", () => {
    const comment = makeComment()
    useAppStore.getState().setComments([comment])

    const { comments } = useAppStore.getState()
    expect(comments).toHaveLength(1)
    expect(comments[0].id).toBe(comment.id)
  })

  it("filters comments by page", () => {
    useAppStore.getState().setComments([
      makeComment({ id: "c1", position: mockPosition }),
      makeComment({ id: "c2", position: { anchorSelector: "#app", page: "/" } }),
    ])

    const { getCommentsForPage } = useAppStore.getState()
    const contactComments = getCommentsForPage("/contact")
    expect(contactComments).toHaveLength(1)
    expect(contactComments[0].id).toBe("c1")

    const homeComments = getCommentsForPage("/")
    expect(homeComments).toHaveLength(1)
    expect(homeComments[0].id).toBe("c2")
  })

  it("sets and clears pending position", () => {
    const { setPendingPosition } = useAppStore.getState()

    setPendingPosition(mockPosition)
    expect(useAppStore.getState().pendingPosition).toEqual(mockPosition)

    setPendingPosition(null)
    expect(useAppStore.getState().pendingPosition).toBeNull()
  })

  it("sets active comment", () => {
    useAppStore.getState().setComments([makeComment({ id: "c1" })])
    const { setActiveComment } = useAppStore.getState()

    setActiveComment("c1")
    expect(useAppStore.getState().activeCommentId).toBe("c1")

    setActiveComment(null)
    expect(useAppStore.getState().activeCommentId).toBeNull()
  })
})
