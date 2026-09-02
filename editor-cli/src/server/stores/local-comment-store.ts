/**
 * Local-file CommentStore — JSON file at
 * `<repoRoot>/.desde/comments.json`.
 *
 * v1 chooses one file per collection for simplicity. If concurrent
 * write contention or file size becomes a problem, splitting into
 * per-comment files is an internal-only change (the interface
 * doesn't expose layout).
 */

import type { Comment } from "../../../../src/types/bridge"
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentUpdatePatch,
} from "../../../../src/editor/core"
import {
  mutate,
  newId,
  nextNumber,
  notifyFileChange,
  nowIso,
  onFileChange,
  readJsonFile,
  resolveStorePath,
  writeJsonFile,
} from "./local-store-base.js"

function commentsPath(repoRoot: string): string {
  return resolveStorePath(repoRoot, "comments.json")
}

async function readAll(repoRoot: string): Promise<Comment[]> {
  return readJsonFile<Comment[]>(commentsPath(repoRoot), [])
}

async function writeAll(repoRoot: string, comments: Comment[]): Promise<void> {
  const filePath = commentsPath(repoRoot)
  await writeJsonFile(filePath, comments)
  // Signal subscribers after the atomic rename lands, so their re-read
  // observes the new content.
  notifyFileChange(filePath)
}

export function createLocalCommentStore(repoRoot: string): CommentStore {
  const filePath = commentsPath(repoRoot)

  return {
    async list() {
      return readAll(repoRoot)
    },

    async get(id) {
      const all = await readAll(repoRoot)
      return all.find((c) => c.id === id) ?? null
    },

    async create(input: CommentCreateInput) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const comment: Comment = {
          id: newId(),
          number: nextNumber(all),
          position: input.position,
          body: input.body,
          author: input.author,
          createdAt: nowIso(),
          resolved: false,
          replies: [],
          mentions: input.mentions ?? [],
          participantEmails: collectParticipants(input.author.email, []),
        }
        all.push(comment)
        await writeAll(repoRoot, all)
        return comment
      })
    },

    async update(id: string, patch: CommentUpdatePatch) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const idx = all.findIndex((c) => c.id === id)
        if (idx === -1) throw new Error(`Comment ${id} not found`)
        const existing = all[idx]
        const next: Comment = {
          ...existing,
          body: patch.body ?? existing.body,
          resolved: patch.resolved ?? existing.resolved,
          mentions: patch.mentions ?? existing.mentions,
        }
        all[idx] = next
        await writeAll(repoRoot, all)
        return next
      })
    },

    async delete(id: string) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const filtered = all.filter((c) => c.id !== id)
        if (filtered.length === all.length) {
          throw new Error(`Comment ${id} not found`)
        }
        await writeAll(repoRoot, filtered)
      })
    },

    async addReply(id: string, reply: CommentReplyInput) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const idx = all.findIndex((c) => c.id === id)
        if (idx === -1) throw new Error(`Comment ${id} not found`)
        const existing = all[idx]
        const next: Comment = {
          ...existing,
          replies: [
            ...existing.replies,
            {
              id: newId(),
              body: reply.body,
              author: reply.author,
              createdAt: nowIso(),
              mentions: reply.mentions ?? [],
            },
          ],
          participantEmails: collectParticipants(
            reply.author.email,
            existing.participantEmails,
          ),
        }
        all[idx] = next
        await writeAll(repoRoot, all)
        return next
      })
    },

    subscribe(listener, onError) {
      let active = true
      // Re-read the file and hand the full list to the subscriber.
      // Reads are lock-free (atomic rename) and fire after the write
      // that triggered them, so the snapshot is always coherent.
      const emit = () => {
        void readAll(repoRoot)
          .then((all) => {
            if (active) listener(all)
          })
          .catch((err) => {
            // A transient read failure shouldn't tear down the
            // subscription; the next change re-emits. Surface it so
            // the consumer can show a retry affordance.
            if (active) onError?.(err)
          })
      }
      const unsubscribe = onFileChange(filePath, emit)
      // Full-snapshot contract: fire once immediately with current state.
      emit()
      return () => {
        active = false
        unsubscribe()
      }
    },
  }
}

function collectParticipants(
  newEmail: string,
  existing: string[],
): string[] {
  if (!newEmail) return existing
  if (existing.includes(newEmail)) return existing
  return [...existing, newEmail]
}
