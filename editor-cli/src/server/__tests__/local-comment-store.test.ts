/**
 * CRUD round-trip + reply + concurrency tests for the local-file
 * CommentStore. The note store is mechanically identical (different
 * namespace) and has its own thinner test file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { CommentCreateInput, CommentReplyInput } from "../../../../src/editor/core"
import type { CommentAuthor } from "../../../../src/types/bridge"
import { createLocalCommentStore } from "../stores/local-comment-store"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-comment-store-test-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const author: CommentAuthor = {
  uid: "user-1",
  displayName: "Mo",
  email: "mo@example.com",
  photoURL: "",
}

const otherAuthor: CommentAuthor = {
  uid: "user-2",
  displayName: "Other",
  email: "other@example.com",
  photoURL: "",
}

function sampleInput(overrides: Partial<CommentCreateInput> = {}): CommentCreateInput {
  return {
    position: {
      anchorSelector: "button.foo",
      page: "/login",
    },
    body: "looks off",
    author,
    ...overrides,
  }
}

describe("createLocalCommentStore", () => {
  it("starts empty when the file does not exist", async () => {
    const store = createLocalCommentStore(tmp)
    expect(await store.list()).toEqual([])
    expect(await store.get("missing")).toBeNull()
  })

  it("create persists and assigns id + number + createdAt", async () => {
    const store = createLocalCommentStore(tmp)
    const c = await store.create(sampleInput())

    expect(c.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(c.number).toBe(1)
    expect(c.resolved).toBe(false)
    expect(c.replies).toEqual([])
    expect(c.mentions).toEqual([])
    expect(c.participantEmails).toEqual([author.email])
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt)

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(c.id)
  })

  it("numbers comments sequentially", async () => {
    const store = createLocalCommentStore(tmp)
    const a = await store.create(sampleInput({ body: "a" }))
    const b = await store.create(sampleInput({ body: "b" }))
    const c = await store.create(sampleInput({ body: "c" }))
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3])
  })

  it("get returns the stored item", async () => {
    const store = createLocalCommentStore(tmp)
    const c = await store.create(sampleInput())
    const fetched = await store.get(c.id)
    expect(fetched).toEqual(c)
  })

  it("update applies the patch and leaves other fields untouched", async () => {
    const store = createLocalCommentStore(tmp)
    const c = await store.create(sampleInput())
    const updated = await store.update(c.id, { resolved: true, body: "fixed" })
    expect(updated.resolved).toBe(true)
    expect(updated.body).toBe("fixed")
    expect(updated.id).toBe(c.id)
    expect(updated.number).toBe(c.number)
    expect(updated.author).toEqual(c.author)
  })

  it("update on a non-existent id rejects with a 'not found' error", async () => {
    const store = createLocalCommentStore(tmp)
    await expect(store.update("nope", { body: "x" })).rejects.toThrow(/not found/i)
  })

  it("delete removes the comment", async () => {
    const store = createLocalCommentStore(tmp)
    const a = await store.create(sampleInput({ body: "a" }))
    const b = await store.create(sampleInput({ body: "b" }))

    await store.delete(a.id)
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(b.id)
  })

  it("delete on a non-existent id rejects with 'not found'", async () => {
    const store = createLocalCommentStore(tmp)
    await expect(store.delete("nope")).rejects.toThrow(/not found/i)
  })

  it("addReply appends to the replies array and updates participant emails", async () => {
    const store = createLocalCommentStore(tmp)
    const c = await store.create(sampleInput())

    const reply: CommentReplyInput = {
      body: "agreed",
      author: otherAuthor,
    }
    const updated = await store.addReply(c.id, reply)

    expect(updated.replies).toHaveLength(1)
    expect(updated.replies[0].body).toBe("agreed")
    expect(updated.replies[0].author.email).toBe(otherAuthor.email)
    expect(updated.participantEmails).toEqual([author.email, otherAuthor.email])
  })

  it("addReply does not duplicate participant emails", async () => {
    const store = createLocalCommentStore(tmp)
    const c = await store.create(sampleInput())
    await store.addReply(c.id, { body: "1st", author })
    const updated = await store.addReply(c.id, { body: "2nd", author })
    expect(updated.participantEmails).toEqual([author.email])
    expect(updated.replies).toHaveLength(2)
  })

  it("survives across store instances (file persistence)", async () => {
    const first = createLocalCommentStore(tmp)
    const c = await first.create(sampleInput())

    const second = createLocalCommentStore(tmp)
    const list = await second.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(c.id)
  })

  it("serializes concurrent creates (no lost updates)", async () => {
    const store = createLocalCommentStore(tmp)
    const N = 25
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.create(sampleInput({ body: `c${i}` })),
      ),
    )
    const list = await store.list()
    expect(list).toHaveLength(N)
    // Numbers should be a permutation of 1..N (no duplicates, no gaps).
    const numbers = list.map((c) => c.number).sort((a, b) => a - b)
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  })
})
