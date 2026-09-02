/**
 * Runs the shared CommentStore conformance suite against the
 * in-memory reference implementation. This is the canary: if the
 * contract itself is malformed, it fails here first, before any
 * I/O-backed backend.
 */

import { createInMemoryCommentStore } from "@/editor/core"
import { commentStoreContract } from "./comment-store-contract"

commentStoreContract("in-memory", {
  makeStore: () => createInMemoryCommentStore(),
})
