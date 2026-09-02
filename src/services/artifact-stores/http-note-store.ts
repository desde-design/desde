/**
 * HTTP client for the CLI's `/api/editor/notes` routes. Mirrors
 * the comment-store client — same shape, different prefix.
 */

import type { Note } from "@/types/note"
import type {
  NoteCreateInput,
  NoteReplyInput,
  NoteStore,
  NoteUpdatePatch,
} from "@/editor/core"
import {
  artifactFetch,
  assertSafeId,
  isArray,
  isMissingArtifactError,
  isObject,
  requireField,
} from "./shared"

const ROUTE = "/api/editor/notes"

const isNote = (v: unknown): v is Note => isObject(v)
const isNoteArray = (v: unknown): v is Note[] => isArray(v) && v.every(isNote)

export function createHttpNoteStore(): NoteStore {
  return {
    async list() {
      const resp = await artifactFetch<unknown>(ROUTE)
      return requireField<Note[]>(resp, "notes", isNoteArray)
    },
    async get(id) {
      assertSafeId(id, "noteId")
      try {
        const resp = await artifactFetch<unknown>(`${ROUTE}/${encodeURIComponent(id)}`)
        return requireField<Note>(resp, "note", isNote)
      } catch (err) {
        if (isMissingArtifactError(err)) return null
        throw err
      }
    },
    async create(input: NoteCreateInput) {
      const resp = await artifactFetch<unknown>(ROUTE, {
        method: "POST",
        body: input,
      })
      return requireField<Note>(resp, "note", isNote)
    },
    async update(id: string, patch: NoteUpdatePatch) {
      assertSafeId(id, "noteId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(id)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<Note>(resp, "note", isNote)
    },
    async delete(id: string) {
      assertSafeId(id, "noteId")
      await artifactFetch(`${ROUTE}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    },
    async addReply(id: string, reply: NoteReplyInput) {
      assertSafeId(id, "noteId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(id)}/replies`,
        { method: "POST", body: reply },
      )
      return requireField<Note>(resp, "note", isNote)
    },
  }
}
