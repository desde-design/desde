import type { Note } from "../../../types/note"
import type { AnnotationAuthor, AnnotationReply } from "../../../types/annotation"

/**
 * Storage interface for project-level Notes (DOM-anchored, identical
 * shape to Comments — different storage namespace and semantics).
 */
export interface NoteStore {
  list(): Promise<Note[]>
  get(id: string): Promise<Note | null>
  create(input: NoteCreateInput): Promise<Note>
  update(id: string, patch: NoteUpdatePatch): Promise<Note>
  delete(id: string): Promise<void>
  addReply(id: string, reply: NoteReplyInput): Promise<Note>
}

export interface NoteCreateInput {
  position: Note["position"]
  body: string
  author: AnnotationAuthor
  mentions?: string[]
}

export interface NoteUpdatePatch {
  body?: string
  resolved?: boolean
  mentions?: string[]
}

export interface NoteReplyInput {
  body: string
  author: AnnotationReply["author"]
  mentions?: string[]
}
