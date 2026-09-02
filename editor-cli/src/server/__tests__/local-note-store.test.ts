/**
 * Smoke tests for the local-file NoteStore. The shape is mechanically
 * identical to the CommentStore (same base, different namespace), so
 * we cover the namespace separation and a brief CRUD round-trip
 * rather than re-verifying every code path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { NoteCreateInput } from "../../../../src/editor/core"
import type { AnnotationAuthor } from "../../../../src/types/annotation"
import { createLocalNoteStore } from "../stores/local-note-store"
import { createLocalCommentStore } from "../stores/local-comment-store"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-note-store-test-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const author: AnnotationAuthor = {
  uid: "user-1",
  displayName: "Mo",
  email: "mo@example.com",
  photoURL: "",
}

const sampleInput = (overrides: Partial<NoteCreateInput> = {}): NoteCreateInput => ({
  position: {
    anchorSelector: "div.banner",
    page: "/home",
  },
  body: "remember this",
  author,
  ...overrides,
})

describe("createLocalNoteStore", () => {
  it("round-trips a note through create / get / update / delete", async () => {
    const store = createLocalNoteStore(tmp)
    const created = await store.create(sampleInput())
    expect(created.number).toBe(1)

    const fetched = await store.get(created.id)
    expect(fetched?.body).toBe("remember this")

    const updated = await store.update(created.id, { resolved: true })
    expect(updated.resolved).toBe(true)

    await store.delete(created.id)
    expect(await store.list()).toEqual([])
  })

  it("appends replies and tracks participant emails", async () => {
    const store = createLocalNoteStore(tmp)
    const note = await store.create(sampleInput())
    const replier: AnnotationAuthor = { ...author, uid: "u2", email: "u2@example.com" }
    const updated = await store.addReply(note.id, { body: "+1", author: replier })
    expect(updated.replies).toHaveLength(1)
    expect(updated.participantEmails).toContain(replier.email)
  })

  it("uses a separate file from the comment store (notes != comments)", async () => {
    const commentStore = createLocalCommentStore(tmp)
    const noteStore = createLocalNoteStore(tmp)

    await commentStore.create({
      position: { anchorSelector: "x", page: "/" },
      body: "a comment",
      author: { ...author, photoURL: "" },
    })
    await noteStore.create(sampleInput({ body: "a note" }))

    expect(await commentStore.list()).toHaveLength(1)
    expect(await noteStore.list()).toHaveLength(1)
    expect((await commentStore.list())[0].body).toBe("a comment")
    expect((await noteStore.list())[0].body).toBe("a note")
  })
})
