/**
 * Runs the shared CommentStore conformance suite against the
 * local-file store — proving it behaves identically to the in-memory
 * reference, including full-snapshot `subscribe` fired from the
 * in-process change emitter. Backend-specific CRUD/persistence edge
 * cases live in `local-comment-store.test.ts`; this file only asserts
 * contract parity.
 */

import { afterAll } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createLocalCommentStore } from "../stores/local-comment-store"
import { commentStoreContract } from "@/editor/core/stores/__tests__/comment-store-contract"

// Each store gets its own tmp dir so file-backed subscriptions never
// cross-talk. All dirs are removed once the suite finishes.
const tmpDirs: string[] = []

commentStoreContract("local-file", {
  makeStore: async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "comment-store-contract-"),
    )
    tmpDirs.push(dir)
    return createLocalCommentStore(dir)
  },
})

afterAll(async () => {
  await Promise.all(
    tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  )
})
