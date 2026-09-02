/**
 * Local-file NoteStore — JSON file at
 * `<repoRoot>/.desde/notes.json`.
 *
 * Mechanically identical to the local comment store; different
 * file, different namespace, same shape.
 */

import type { Note } from "../../../../src/types/note"
import type {
  NoteCreateInput,
  NoteReplyInput,
  NoteStore,
  NoteUpdatePatch,
} from "../../../../src/editor/core"
import {
  mutate,
  newId,
  nextNumber,
  nowIso,
  readJsonFile,
  resolveStorePath,
  writeJsonFile,
} from "./local-store-base.js"

function notesPath(repoRoot: string): string {
  return resolveStorePath(repoRoot, "notes.json")
}

async function readAll(repoRoot: string): Promise<Note[]> {
  return readJsonFile<Note[]>(notesPath(repoRoot), [])
}

async function writeAll(repoRoot: string, notes: Note[]): Promise<void> {
  await writeJsonFile(notesPath(repoRoot), notes)
}

export function createLocalNoteStore(repoRoot: string): NoteStore {
  const filePath = notesPath(repoRoot)

  return {
    async list() {
      return readAll(repoRoot)
    },

    async get(id) {
      const all = await readAll(repoRoot)
      return all.find((n) => n.id === id) ?? null
    },

    async create(input: NoteCreateInput) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const note: Note = {
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
        all.push(note)
        await writeAll(repoRoot, all)
        return note
      })
    },

    async update(id: string, patch: NoteUpdatePatch) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const idx = all.findIndex((n) => n.id === id)
        if (idx === -1) throw new Error(`Note ${id} not found`)
        const existing = all[idx]
        const next: Note = {
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
        const filtered = all.filter((n) => n.id !== id)
        if (filtered.length === all.length) {
          throw new Error(`Note ${id} not found`)
        }
        await writeAll(repoRoot, filtered)
      })
    },

    async addReply(id: string, reply: NoteReplyInput) {
      return mutate(filePath, async () => {
        const all = await readAll(repoRoot)
        const idx = all.findIndex((n) => n.id === id)
        if (idx === -1) throw new Error(`Note ${id} not found`)
        const existing = all[idx]
        const next: Note = {
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
