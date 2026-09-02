/**
 * Tests for the `useLocalNotes` hook — the CLI-side parallel of the
 * Firestore-backed `useNotes`. Mirrors the `useLocalComments` test
 * suite shape (HTTP store calls, optimistic + reconcile, rollback,
 * concurrent writes, fallback author, enabled gate) and adds the
 * one Note-specific assertion: minimization state must NOT reset on
 * targeted mutations.
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
  useLocalNotes,
  FALLBACK_NOTE_AUTHOR,
} from "./useLocalNotes"
import { useAppStore } from "@/stores"
import type { Note } from "@/types/note"
import type { NoteStore } from "@/editor/core"

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

function fakeNote(id: string, body: string, number: number): Note {
  return {
    id,
    number,
    position: { anchorSelector: ".btn", page: "/" },
    body,
    author: FALLBACK_NOTE_AUTHOR,
    createdAt: "2026-05-24T00:00:00Z",
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
  }
}

type MockStore = NoteStore & {
  list: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  addReply: ReturnType<typeof vi.fn>
}

function makeMockStore(): MockStore {
  return {
    list: vi.fn(async () => [] as Note[]),
    get: vi.fn(async () => null),
    create: vi.fn(async () => fakeNote("n-new", "new note", 1)),
    update: vi.fn(async () => fakeNote("n1", "patched", 1)),
    delete: vi.fn(async () => undefined),
    addReply: vi.fn(async () => fakeNote("n1", "with reply", 1)),
  } as unknown as MockStore
}

beforeEach(() => {
  useAppStore.setState({
    notes: [],
    noteProjectId: null,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
  })
})

afterEach(() => {
  useAppStore.setState({
    notes: [],
    noteProjectId: null,
    minimizedNoteIds: new Set<string>(),
    expandedNoteIds: new Set<string>(),
  })
  vi.restoreAllMocks()
})

describe("useLocalNotes", () => {
  it("loads notes via store.list on mount and populates the slice", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeNote("n1", "first", 1),
      fakeNote("n2", "second", 2),
    ])
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(store.list.mock.calls.length).toBe(1)
    const notes = useAppStore.getState().notes
    expect(notes.map((n) => n.id)).toEqual(["n1", "n2"])
  })

  it("seeds minimizedNoteIds from the initial load", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeNote("n1", "first", 1),
      fakeNote("n2", "second", 2),
    ])
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // Loaded notes start minimized (slice's setNotes computes
    // minimized = all - expanded; expandedNoteIds is empty).
    const minimized = useAppStore.getState().minimizedNoteIds
    expect([...minimized].sort()).toEqual(["n1", "n2"])
  })

  it("addNote optimistically inserts, posts, replaces with server response", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    store.create.mockResolvedValueOnce(fakeNote("n-real", "Hello!", 1))
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addNote("Hello!", {
        anchorSelector: ".btn",
        page: "/",
      })
    })

    expect(store.create.mock.calls.length).toBe(1)
    expect(store.list.mock.calls.length).toBe(1)
    expect(useAppStore.getState().notes.map((n) => n.id)).toEqual([
      "n-real",
    ])
  })

  it("addNote rolls back when the store throws", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    store.create.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addNote("Hello", {
        anchorSelector: ".btn",
        page: "/",
      })
    })

    expect(useAppStore.getState().notes).toEqual([])
    expect(result.current.error).toMatch(/Failed to add note/)
  })

  it("toggleResolved patches via store and replaces with server response", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([fakeNote("n1", "x", 1)])
    store.update.mockResolvedValueOnce({
      ...fakeNote("n1", "x", 1),
      resolved: true,
    })
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.toggleResolved("n1")
    })

    expect(store.update).toHaveBeenCalledWith("n1", { resolved: true })
    expect(useAppStore.getState().notes[0].resolved).toBe(true)
  })

  it("toggleResolved rolls back on failure", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([fakeNote("n1", "x", 1)])
    store.update.mockRejectedValueOnce(new Error("nope"))
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.toggleResolved("n1")
    })

    expect(useAppStore.getState().notes[0].resolved).toBe(false)
    expect(result.current.error).toMatch(/Failed to update note/)
  })

  it("deleteNote removes locally and via store", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeNote("n1", "x", 1),
      fakeNote("n2", "y", 2),
    ])
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteNote("n1")
    })

    expect(store.delete).toHaveBeenCalledWith("n1")
    expect(useAppStore.getState().notes.map((n) => n.id)).toEqual(["n2"])
  })

  it("deleteNote restores at original index when the store throws", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeNote("n1", "x", 1),
      fakeNote("n2", "y", 2),
      fakeNote("n3", "z", 3),
    ])
    store.delete.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.deleteNote("n2")
    })

    expect(useAppStore.getState().notes.map((n) => n.id)).toEqual([
      "n1",
      "n2",
      "n3",
    ])
  })

  it("concurrent addNotes don't clobber each other", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    let resolveFirst!: (n: Note) => void
    store.create.mockImplementationOnce(
      () =>
        new Promise<Note>((resolve) => {
          resolveFirst = resolve
        }),
    )
    store.create.mockResolvedValueOnce(fakeNote("n-real-B", "B", 2))
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let firstPromise!: Promise<Note | null>
    await act(async () => {
      firstPromise = result.current.addNote("A", {
        anchorSelector: ".a",
        page: "/",
      })
      await Promise.resolve()
      await result.current.addNote("B", {
        anchorSelector: ".b",
        page: "/",
      })
    })

    let snapshot = useAppStore.getState().notes
    expect(snapshot.find((n) => n.id === "n-real-B")).toBeTruthy()
    expect(
      snapshot.find((n) => n.body === "A" && n.id.startsWith("optimistic-")),
    ).toBeTruthy()

    await act(async () => {
      resolveFirst(fakeNote("n-real-A", "A", 1))
      await firstPromise
    })

    snapshot = useAppStore.getState().notes
    expect(snapshot.map((n) => n.id).sort()).toEqual(["n-real-A", "n-real-B"])
  })

  it("addReply appends a reply via targeted replace", async () => {
    const store = makeMockStore()
    const seed = fakeNote("n1", "thread", 1)
    store.list.mockResolvedValueOnce([seed])
    store.addReply.mockResolvedValueOnce({
      ...seed,
      replies: [
        {
          id: "r-server",
          body: "thanks",
          author: FALLBACK_NOTE_AUTHOR,
          createdAt: "2026-05-24T00:01:00Z",
          mentions: [],
        },
      ],
    })
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addReply("n1", "thanks")
    })

    expect(store.addReply).toHaveBeenCalledWith("n1", {
      body: "thanks",
      author: FALLBACK_NOTE_AUTHOR,
    })
    expect(useAppStore.getState().notes[0].replies).toHaveLength(1)
    expect(useAppStore.getState().notes[0].replies[0].id).toBe("r-server")
  })

  it("stays inert when enabled=false", async () => {
    const store = makeMockStore()
    renderHook(() => useLocalNotes({ store, enabled: false }))
    await new Promise((r) => setTimeout(r, 0))
    expect(store.list.mock.calls.length).toBe(0)
  })

  it("addNote passes the configured author override", async () => {
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([])
    const customAuthor = {
      uid: "cli:mo@mac",
      displayName: "mo",
      email: "",
      photoURL: "",
    }
    const { result } = renderHook(() =>
      useLocalNotes({ store, author: customAuthor }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.addNote("hello", {
        anchorSelector: ".x",
        page: "/",
      })
    })

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ author: customAuthor }),
    )
  })


  it("targeted mutations do NOT reset user-toggled minimize state", async () => {
    // Key Note-specific invariant: the slice's `setNotes` setter
    // recomputes minimizedNoteIds. If targeted updates routed through
    // it, the user's per-note expand/minimize state would reset on
    // every write. Verify direct setState bypasses that.
    const store = makeMockStore()
    store.list.mockResolvedValueOnce([
      fakeNote("n1", "first", 1),
      fakeNote("n2", "second", 2),
    ])
    const { result } = renderHook(() => useLocalNotes({ store }))
    await waitFor(() => expect(result.current.loading).toBe(false))

    // Simulate user expanding n1 (toggleNoteMinimized would do this).
    act(() => {
      useAppStore.setState({
        minimizedNoteIds: new Set(["n2"]),
        expandedNoteIds: new Set(["n1"]),
      })
    })

    // Trigger a targeted mutation — toggling resolved on n2.
    store.update.mockResolvedValueOnce({
      ...fakeNote("n2", "second", 2),
      resolved: true,
    })
    await act(async () => {
      await result.current.toggleResolved("n2")
    })

    // User's expand of n1 must survive.
    const minimized = useAppStore.getState().minimizedNoteIds
    const expanded = useAppStore.getState().expandedNoteIds
    expect([...minimized]).toEqual(["n2"])
    expect([...expanded]).toEqual(["n1"])
  })
})
