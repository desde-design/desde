/**
 * In-memory CommentStore — the reference implementation.
 *
 * No I/O: state lives in a closure array. Used as a test double for
 * consumers (hooks, panels) and as the simplest possible target for
 * the `commentStoreContract` conformance suite. Because it satisfies
 * the exact same interface — including full-snapshot `subscribe` — a
 * green contract run here proves the contract itself is coherent
 * before pointing it at the file / HTTP / Firestore backends.
 *
 * Field population (number, participantEmails, reply shape) mirrors
 * the local-file store so swapping impls never changes the data.
 */

import type { Comment } from "../../../types/bridge"
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentSubscriber,
  CommentUpdatePatch,
} from "./comment-store"

function nextNumber(items: ReadonlyArray<{ number: number }>): number {
  let max = 0
  for (const item of items) if (item.number > max) max = item.number
  return max + 1
}

function collectParticipants(newEmail: string, existing: string[]): string[] {
  if (!newEmail) return existing
  if (existing.includes(newEmail)) return existing
  return [...existing, newEmail]
}

export function createInMemoryCommentStore(seed: Comment[] = []): CommentStore {
  // Deep-ish clone so callers can't mutate our state through the seed.
  let comments: Comment[] = seed.map((c) => ({ ...c }))
  const listeners = new Set<CommentSubscriber>()

  const snapshot = (): Comment[] => comments.map((c) => ({ ...c }))

  const emit = (): void => {
    const snap = snapshot()
    for (const listener of [...listeners]) {
      try {
        listener(snap)
      } catch {
        // A broken subscriber must not break peers or the mutation.
      }
    }
  }

  return {
    async list() {
      return snapshot()
    },

    async get(id) {
      const found = comments.find((c) => c.id === id)
      return found ? { ...found } : null
    },

    async create(input: CommentCreateInput) {
      const comment: Comment = {
        id: crypto.randomUUID(),
        number: nextNumber(comments),
        position: input.position,
        body: input.body,
        author: input.author,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
        mentions: input.mentions ?? [],
        participantEmails: collectParticipants(input.author.email, []),
      }
      comments = [...comments, comment]
      emit()
      return { ...comment }
    },

    async update(id: string, patch: CommentUpdatePatch) {
      const idx = comments.findIndex((c) => c.id === id)
      if (idx === -1) throw new Error(`Comment ${id} not found`)
      const existing = comments[idx]
      const next: Comment = {
        ...existing,
        body: patch.body ?? existing.body,
        resolved: patch.resolved ?? existing.resolved,
        mentions: patch.mentions ?? existing.mentions,
      }
      comments = comments.map((c, i) => (i === idx ? next : c))
      emit()
      return { ...next }
    },

    async delete(id: string) {
      const filtered = comments.filter((c) => c.id !== id)
      if (filtered.length === comments.length) {
        throw new Error(`Comment ${id} not found`)
      }
      comments = filtered
      emit()
    },

    async addReply(id: string, reply: CommentReplyInput) {
      const idx = comments.findIndex((c) => c.id === id)
      if (idx === -1) throw new Error(`Comment ${id} not found`)
      const existing = comments[idx]
      const next: Comment = {
        ...existing,
        replies: [
          ...existing.replies,
          {
            id: crypto.randomUUID(),
            body: reply.body,
            author: reply.author,
            createdAt: new Date().toISOString(),
            mentions: reply.mentions ?? [],
          },
        ],
        participantEmails: collectParticipants(
          reply.author.email,
          existing.participantEmails,
        ),
      }
      comments = comments.map((c, i) => (i === idx ? next : c))
      emit()
      return { ...next }
    },

    subscribe(listener: CommentSubscriber) {
      listeners.add(listener)
      // Full-snapshot contract: fire once immediately.
      listener(snapshot())
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
