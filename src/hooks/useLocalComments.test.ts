/**
 * Tests for the `useLocalComments` hook — the CLI-side parallel of
 * the Firestore-backed `useComments`. Verifies HTTP store calls,
 * optimistic insert + reconcile, and rollback on failure.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import {
  useLocalComments,
  FALLBACK_COMMENT_AUTHOR,
} from "./useLocalComments"
import { useAppStore } from "@/stores"
import type { Comment } from "@/types/bridge"
import type { CommentStore } from "@/editor/core"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

function fakeComment(id: string, body: string, number: number): Comment {
  return {
    id,
    number,
    position: { anchorSelector: ".btn", page: "/" },
    body,
    author: FALLBACK_COMMENT_AUTHOR,
    createdAt: "2026-05-24T00:00:00Z",
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
  }
}

type MockStore = CommentStore & {
  list: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  addReply: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}

function makeMockStore(): MockStore {
  const store = {
    list: vi.fn(async () => [] as Comment[]),
    get: vi.fn(async () => null),
    create: vi.fn(async () => fakeComment("c-new", "new comment", 1)),
    update: vi.fn(async () => fakeComment("c1", "patched", 1)),
    delete: vi.fn(async () => undefined),
    addReply: vi.fn(async () => fakeComment("c1", "with reply", 1)),
    // Mirror the real stores: emit the current list once on subscribe.
    // The hook drives its initial load through this (no separate poll
    // in the mock), so `list` is called exactly once on mount.
    subscribe: vi.fn(
      (cb: (comments: Comment[]) => void, onError?: (e: unknown) => void) => {
        void store
          .list()
          .then((l) => cb(l))
          .catch((e) => onError?.(e))
        return () => {}
      },
    ),
  } as unknown as MockStore
  return store
}

beforeEach(() => {
  useAppStore.setState({
    comments: [],
    commentProjectId: null,
  })
})

afterEach(() => {
  useAppStore.setState({ comments: [], commentProjectId: null })
  vi.restoreAllMocks()
})

describe("useLocalComments", () => {
  it("loads comments via store.list on mount and populates the slice", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeComment("c1", "first", 1),
      fakeComment("c2", "second", 2),
    ])
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(store.list.mock.calls.length).toBe(1)
    const comments = useAppStore.getState().comments
    expect(comments.map((c) => c.id)).toEqual(["c1", "c2"])
  })

  it("addComment optimistically inserts, posts, replaces with server response", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    store.create.mockResolvedValueOnce(fakeComment("c-real", "Hello!", 1))
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addComment("Hello!", {
        anchorSelector: ".btn",
        page: "/",
      })
    })

    expect(store.create.mock.calls.length).toBe(1)
    // No second list refetch — targeted replace instead.
    expect(store.list.mock.calls.length).toBe(1)
    expect(useAppStore.getState().comments.map((c) => c.id)).toEqual([
      "c-real",
    ])
  })

  it("addComment rolls back when the store throws", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    store.create.mockRejectedValueOnce(
      new Error("boom"),
    )
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addComment("Hello", {
        anchorSelector: ".btn",
        page: "/",
      })
    })

    expect(useAppStore.getState().comments).toEqual([])
    expect(result.current.error).toMatch(/Failed to add comment/)
  })

  it("toggleResolved patches via store and replaces with server response", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([fakeComment("c1", "x", 1)])
    store.update.mockResolvedValueOnce({
      ...fakeComment("c1", "x", 1),
      resolved: true,
    })
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.toggleResolved("c1")
    })

    expect(store.update).toHaveBeenCalledWith("c1", { resolved: true })
    expect(useAppStore.getState().comments[0].resolved).toBe(true)
  })

  it("toggleResolved rolls back on failure", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeComment("c1", "x", 1),
    ])
    store.update.mockRejectedValueOnce(
      new Error("nope"),
    )
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.toggleResolved("c1")
    })

    expect(useAppStore.getState().comments[0].resolved).toBe(false)
    expect(result.current.error).toMatch(/Failed to update comment/)
  })

  it("deleteComment removes locally and via store", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeComment("c1", "x", 1),
      fakeComment("c2", "y", 2),
    ])
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteComment("c1")
    })

    expect(store.delete).toHaveBeenCalledWith("c1")
    expect(useAppStore.getState().comments.map((c) => c.id)).toEqual(["c2"])
  })

  it("deleteComment restores at original index when the store throws", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeComment("c1", "x", 1),
      fakeComment("c2", "y", 2),
      fakeComment("c3", "z", 3),
    ])
    store.delete.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteComment("c2")
    })

    // c2 returns to index 1 — original position preserved.
    expect(useAppStore.getState().comments.map((c) => c.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ])
  })

  it("concurrent addComments don't clobber each other", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    // Make the first create slow so the second can interleave.
    let resolveFirst!: (c: Comment) => void
    store.create.mockImplementationOnce(
      () =>
        new Promise<Comment>((resolve) => {
          resolveFirst = resolve
        }),
    )
    store.create.mockResolvedValueOnce(fakeComment("c-real-B", "B", 2))
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Fire two adds back-to-back.
    let firstPromise!: Promise<Comment | null>
    await act(async () => {
      firstPromise = result.current.addComment("A", {
        anchorSelector: ".a",
        page: "/",
      })
      await Promise.resolve()
      await result.current.addComment("B", {
        anchorSelector: ".b",
        page: "/",
      })
    })

    // After B resolves, the slice has B as a real record AND A as an
    // optimistic record.
    let snapshot = useAppStore.getState().comments
    expect(snapshot.find((c) => c.id === "c-real-B")).toBeTruthy()
    expect(
      snapshot.find((c) => c.body === "A" && c.id.startsWith("optimistic-")),
    ).toBeTruthy()

    // Now resolve A — it should replace just its optimistic record,
    // leaving B alone.
    await act(async () => {
      resolveFirst(fakeComment("c-real-A", "A", 1))
      await firstPromise
    })

    snapshot = useAppStore.getState().comments
    expect(snapshot.map((c) => c.id).sort()).toEqual(["c-real-A", "c-real-B"])
  })

  it("addReply appends a reply via targeted replace", async () => {
    const store = makeMockStore()
    const seed = fakeComment("c1", "thread", 1)
    store.list.mockResolvedValueOnce([seed])
    store.addReply.mockResolvedValueOnce({
      ...seed,
      replies: [
        {
          id: "r-server",
          body: "thanks",
          author: FALLBACK_COMMENT_AUTHOR,
          createdAt: "2026-05-24T00:01:00Z",
          mentions: [],
        },
      ],
    })
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addReply("c1", "thanks")
    })

    expect(store.addReply).toHaveBeenCalledWith("c1", {
      body: "thanks",
      author: FALLBACK_COMMENT_AUTHOR,
      mentions: [],
    })
    expect(useAppStore.getState().comments[0].replies).toHaveLength(1)
    expect(useAppStore.getState().comments[0].replies[0].id).toBe("r-server")
  })

  it("does not duplicate when a realtime snapshot delivers the comment mid-create", async () => {
    // Reproduces the Firestore duplication: onSnapshot inserts the real
    // comment before the optimistic→real swap runs. Must end with ONE copy.
    const store = makeMockStore()
    let emit: ((comments: Comment[]) => void) | null = null
    store.subscribe = vi.fn(
      (cb: (comments: Comment[]) => void) => {
        emit = cb
        cb([]) // initial empty snapshot
        return () => {}
      },
    )
    const real = fakeComment("comment-real", "hi", 1)
    store.create = vi.fn(async () => {
      // Realtime snapshot lands mid-write, before create() resolves.
      emit?.([real])
      return real
    })
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addComment("hi", { anchorSelector: ".b", page: "/" })
    })

    expect(useAppStore.getState().comments.map((c) => c.id)).toEqual([
      "comment-real",
    ])
  })

  it("stays inert when enabled=false", async () => {
    const store = makeMockStore()
    renderHook(() => useLocalComments({ store, enabled: false }))
    await new Promise((r) => setTimeout(r, 0))
    expect(store.list.mock.calls.length).toBe(0)
  })

  it("addComment passes the configured author override", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    const customAuthor = {
      uid: "cli:mo@mac",
      displayName: "mo",
      email: "",
      photoURL: "",
    }
    const { result } = renderHook(() =>
      useLocalComments({ store, author: customAuthor }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addComment("hello", {
        anchorSelector: ".x",
        page: "/",
      })
    })

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ author: customAuthor }),
    )
  })

  // The Viewer's comment routes notify from the `mentions` ARRAY and never
  // parse the body text, so a mention the Editor fails to extract here
  // renders as a mention and reaches nobody. Both write paths are covered:
  // the bug would be equally silent on either.
  it("sends the mention ids extracted from a new comment's body", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addComment("ping @[Rin](p_rin) and @[Sam](p_sam)", {
        anchorSelector: ".x",
        page: "/",
      })
    })

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: ["p_rin", "p_sam"] }),
    )
  })

  it("sends the mention ids extracted from a reply's body", async () => {
    const store = makeMockStore()
    const seed = fakeComment("c1", "thread", 1)
    store.list.mockResolvedValueOnce([seed])
    store.addReply.mockResolvedValueOnce({
      ...seed,
      replies: [
        {
          id: "r-server",
          body: "over to @[Rin](p_rin)",
          author: FALLBACK_COMMENT_AUTHOR,
          createdAt: "2026-05-24T00:01:00Z",
          mentions: ["p_rin"],
        },
      ],
    })
    const { result } = renderHook(() => useLocalComments({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addReply("c1", "over to @[Rin](p_rin)")
    })

    expect(store.addReply).toHaveBeenCalledWith("c1", {
      body: "over to @[Rin](p_rin)",
      author: FALLBACK_COMMENT_AUTHOR,
      mentions: ["p_rin"],
    })
  })

})
