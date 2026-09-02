import type { Comment, CommentReply } from "../../../types/bridge"

/**
 * Storage interface for prototype Comments (DOM-anchored).
 *
 * Impls (one per storage backend, all behaviourally identical — they
 * share the `commentStoreContract` conformance suite):
 * - Local file store (CLI) — JSON file under `.desde/comments.json`
 * - HTTP client (browser) — proxies the CLI's `/api/editor/comments`
 * - Firestore (viewer) — subscribes to `desdeProjects/{id}/comments`
 * - In-memory (tests / reference)
 *
 * The `subscribe` method (full-snapshot semantics, adopted from the
 * oss-comments `StorageAdapter`) is what lets the same UI drive a
 * realtime cloud backend and a local file store interchangeably —
 * "sync" is then just a shared backend plus a live subscription.
 *
 * Keep this interface free of I/O concerns so consumers can be tested
 * with the in-memory impl.
 */
export interface CommentStore {
  list(): Promise<Comment[]>
  get(id: string): Promise<Comment | null>
  create(input: CommentCreateInput): Promise<Comment>
  update(id: string, patch: CommentUpdatePatch): Promise<Comment>
  delete(id: string): Promise<void>
  addReply(id: string, reply: CommentReplyInput): Promise<Comment>
  /**
   * Subscribe to the full comment list. The `listener` fires once
   * immediately with the current state, then again on every change
   * (full replacement — the callback always receives the complete
   * list, never a delta). The list is not guaranteed sorted;
   * consumers order it themselves.
   *
   * `onError` (optional) surfaces load failures so consumers can show
   * a retry affordance instead of a silently-empty list — an initial
   * fetch that fails, a poll tick that 500s, an `onSnapshot` error.
   * The subscription stays alive across errors (the next tick / change
   * re-emits through `listener`), so `onError` is advisory, not fatal.
   *
   * Backends with native realtime (Firestore `onSnapshot`) wire it
   * directly; the local-file store fires from an in-process change
   * emitter; the HTTP client polls. Returns an unsubscribe function.
   */
  subscribe(listener: CommentSubscriber, onError?: CommentSubscribeError): () => void
}

/** Full-snapshot subscription callback for {@link CommentStore.subscribe}. */
export type CommentSubscriber = (comments: Comment[]) => void

/** Error callback for {@link CommentStore.subscribe}. */
export type CommentSubscribeError = (error: unknown) => void

export interface CommentCreateInput {
  position: Comment["position"]
  body: string
  author: Comment["author"]
  mentions?: string[]
}

export interface CommentUpdatePatch {
  body?: string
  resolved?: boolean
  mentions?: string[]
}

export interface CommentReplyInput {
  body: string
  author: CommentReply["author"]
  mentions?: string[]
}
