/**
 * Focused test for the HTTP CommentStore's polling `subscribe`.
 *
 * The full CRUD contract can't run against this store without a live
 * CLI server (that's the route-level integration test in editor-cli),
 * so here we mock `fetch` and assert just the subscription semantics:
 * immediate emit, change-gated re-emit, and clean teardown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Comment } from "@/types/bridge"
import { createHttpCommentStore } from "."

type FetchSig = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

let fetchMock: ReturnType<typeof vi.fn<FetchSig>>
let realFetch: typeof fetch
let current: Comment[]

function comment(id: string, number: number): Comment {
  return {
    id,
    number,
    position: { anchorSelector: `#el-${id}`, page: "/" },
    body: `c-${id}`,
    author: { uid: "u", displayName: "U", email: "u@x.com", photoURL: "" },
    createdAt: new Date(0).toISOString(),
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
  }
}

beforeEach(() => {
  current = []
  fetchMock = vi.fn<FetchSig>(async () =>
    new Response(JSON.stringify({ comments: current }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  )
  realFetch = global.fetch
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = realFetch
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("createHttpCommentStore().subscribe", () => {
  it("emits immediately, then only when the list changes", async () => {
    const store = createHttpCommentStore({ pollIntervalMs: 10 })
    const seen: number[] = []
    const unsub = store.subscribe((comments) => seen.push(comments.length))

    // Immediate first poll → empty snapshot.
    await tick(30)
    expect(seen).toEqual([0])

    // A change is picked up on the next poll.
    current = [comment("a", 1)]
    await tick(30)
    expect(seen[seen.length - 1]).toBe(1)

    // Idle polls with no change don't re-emit.
    const countBeforeIdle = seen.length
    await tick(40)
    expect(seen.length).toBe(countBeforeIdle)

    unsub()
  })

  it("stops polling after unsubscribe", async () => {
    const store = createHttpCommentStore({ pollIntervalMs: 10 })
    const seen: number[] = []
    const unsub = store.subscribe((comments) => seen.push(comments.length))
    await tick(30)
    unsub()
    const callsAtUnsub = fetchMock.mock.calls.length
    const seenAtUnsub = seen.length

    current = [comment("a", 1), comment("b", 2)]
    await tick(40)

    // No further fetches or emits once unsubscribed.
    expect(fetchMock.mock.calls.length).toBe(callsAtUnsub)
    expect(seen.length).toBe(seenAtUnsub)
  })
})
