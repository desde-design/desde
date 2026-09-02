/**
 * Shared CommentStore conformance suite.
 *
 * Ported from the oss-comments `storageAdapterContract`
 * (packages/adapter-testkit/src/contract.ts) and adapted to
 * Desde' `CommentStore` interface + `CommentAuthor` shape
 * (`uid`, not oss-comments' `id`).
 *
 * Every backend — in-memory, local-file, HTTP, Firestore — runs this
 * against a fresh, empty store to guarantee identical CRUD + realtime
 * semantics. That equivalence is what makes "swap the storage backend
 * and the editor/viewer behave the same" a checked property rather
 * than a hope. Vendor-backed adapters run it against a local emulator.
 *
 * This file is intentionally NOT named `*.test.ts` — it exports a
 * helper that per-backend `*.test.ts` files invoke, so vitest doesn't
 * collect it as a standalone suite.
 */

import { describe, expect, it } from "vitest"
import type { CommentStore } from "@/editor/core"
import type { CommentAuthor } from "@/types/bridge"

const author: CommentAuthor = {
  uid: "user-1",
  displayName: "Ada",
  email: "ada@example.com",
  photoURL: "",
}

const samplePosition = {
  anchorSelector: "#hero",
  page: "/",
}

export interface CommentStoreContractOptions {
  /** Async factory returning a fresh, empty store for each test. */
  makeStore: () => Promise<CommentStore> | CommentStore
  /** Optional teardown after each test. */
  cleanup?: () => Promise<void> | void
  /** Skip realtime assertions for backends that don't support subscribe. */
  skipRealtime?: boolean
}

export function commentStoreContract(
  name: string,
  opts: CommentStoreContractOptions,
): void {
  describe(`CommentStore contract: ${name}`, () => {
    async function fresh(): Promise<CommentStore> {
      return await opts.makeStore()
    }

    it("starts empty", async () => {
      const store = await fresh()
      expect(await store.list()).toEqual([])
      await opts.cleanup?.()
    })

    it("creates and lists with sequential numbering", async () => {
      const store = await fresh()
      const c1 = await store.create({ position: samplePosition, body: "first", author })
      const c2 = await store.create({ position: samplePosition, body: "second", author })
      expect(c1.number).toBe(1)
      expect(c2.number).toBe(2)
      expect(c1.id).not.toBe(c2.id)
      expect(c1.resolved).toBe(false)
      expect(c1.createdAt).toBeTruthy()
      expect(await store.list()).toHaveLength(2)
      await opts.cleanup?.()
    })

    it("gets by id and returns null for missing", async () => {
      const store = await fresh()
      const c = await store.create({ position: samplePosition, body: "x", author })
      expect((await store.get(c.id))?.body).toBe("x")
      expect(await store.get("nope")).toBeNull()
      await opts.cleanup?.()
    })

    it("updates body and resolved", async () => {
      const store = await fresh()
      const c = await store.create({ position: samplePosition, body: "x", author })
      const updated = await store.update(c.id, { body: "y", resolved: true })
      expect(updated.body).toBe("y")
      expect(updated.resolved).toBe(true)
      expect((await store.get(c.id))?.resolved).toBe(true)
      await opts.cleanup?.()
    })

    it("rejects update / delete on a missing id", async () => {
      const store = await fresh()
      await expect(store.update("nope", { body: "x" })).rejects.toThrow()
      await expect(store.delete("nope")).rejects.toThrow()
      await opts.cleanup?.()
    })

    it("adds replies and tracks participants", async () => {
      const store = await fresh()
      const c = await store.create({ position: samplePosition, body: "x", author })
      const other: CommentAuthor = {
        uid: "user-2",
        displayName: "Bo",
        email: "bo@example.com",
        photoURL: "",
      }
      const withReply = await store.addReply(c.id, { body: "re", author: other })
      expect(withReply.replies).toHaveLength(1)
      expect(withReply.replies[0]!.body).toBe("re")
      expect(withReply.participantEmails).toContain(author.email)
      expect(withReply.participantEmails).toContain(other.email)
      await opts.cleanup?.()
    })

    it("deletes", async () => {
      const store = await fresh()
      const c = await store.create({ position: samplePosition, body: "x", author })
      await store.delete(c.id)
      expect(await store.list()).toHaveLength(0)
      expect(await store.get(c.id)).toBeNull()
      await opts.cleanup?.()
    })

    if (!opts.skipRealtime) {
      it("fires subscribe immediately with the current snapshot", async () => {
        const store = await fresh()
        await store.create({ position: samplePosition, body: "seed", author })
        const seen: number[] = []
        const unsub = store.subscribe((comments) => seen.push(comments.length))
        // Allow async (read-backed) adapters a tick to deliver the first snapshot.
        await new Promise((r) => setTimeout(r, 60))
        expect(seen[seen.length - 1]).toBe(1)
        unsub()
        await opts.cleanup?.()
      })

      it("notifies subscribers on change", async () => {
        const store = await fresh()
        const seen: number[] = []
        const unsub = store.subscribe((comments) => seen.push(comments.length))
        await store.create({ position: samplePosition, body: "x", author })
        await new Promise((r) => setTimeout(r, 60))
        expect(seen[seen.length - 1]).toBe(1)
        unsub()
        await opts.cleanup?.()
      })

      it("stops notifying after unsubscribe", async () => {
        const store = await fresh()
        const seen: number[] = []
        const unsub = store.subscribe((comments) => seen.push(comments.length))
        await new Promise((r) => setTimeout(r, 60))
        unsub()
        const countAtUnsub = seen.length
        await store.create({ position: samplePosition, body: "x", author })
        await new Promise((r) => setTimeout(r, 60))
        expect(seen.length).toBe(countAtUnsub)
        await opts.cleanup?.()
      })
    }
  })
}
