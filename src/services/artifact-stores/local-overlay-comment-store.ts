/**
 * A CommentStore that READS from a real backend and keeps WRITES in memory.
 *
 * The case it exists for is a public demo. The viewer's `allowAnonymousComments`
 * switch lets an operator refuse comment writes from callers with no credential,
 * which is the only complete answer to "anyone on the internet can post on the
 * page linked from our marketing site". But a review surface where the composer
 * is simply disabled shows a visitor the conversation and never lets them try
 * the thing the product is for.
 *
 * So the visitor gets the whole interaction — place a pin, type, watch it
 * appear, reply to it — and none of it leaves their browser. The seeded
 * conversation is real and comes from the server; what they add is theirs alone
 * and disappears when they reload.
 *
 * **This is not a security control and must never be mistaken for one.** It
 * decides what the UI does, in the browser, where the visitor could bypass it by
 * calling the API directly. The server's refusal is what makes anonymous writes
 * impossible; this is what makes the demo good anyway. Ship both.
 *
 * Reads are a UNION: every comment the base store reports, plus the local ones,
 * with local edits shadowing a base comment of the same id. That ordering
 * matters — a visitor who edits a seeded comment must see their own text, and
 * must still see it after the base store's next poll re-reports the original.
 */
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentSubscriber,
  CommentSubscribeError,
  CommentUpdatePatch,
} from "../../editor/core/stores/comment-store"
import { createInMemoryCommentStore } from "../../editor/core/stores/in-memory-comment-store"
import type { Comment } from "../../types/bridge"

export interface LocalOverlayCommentStoreOptions {
  /** The real backend. Read from always; written to only when writes are allowed. */
  base: CommentStore
  /**
   * Whether writes may reach `base` at construction time. Optional, defaulting
   * to `true`, which is what the product has always done and the right reading
   * of a server that does not report the field.
   */
  allowRemoteWrites?: boolean
}

export interface LocalOverlayCommentStore extends CommentStore {
  /**
   * Update whether writes may reach the base store.
   *
   * A method rather than a callback the caller owns, because the answer arrives
   * from the server AFTER the store is constructed and a store rebuilt on it
   * would drop the subscription the surface already holds. Keeping the cell
   * inside the store means a React consumer calls a method from an effect
   * instead of mutating something it memoized, which is the pattern
   * `react-hooks/refs` and the compiler rules actually endorse.
   */
  setAllowRemoteWrites(allowed: boolean): void
}

export function createLocalOverlayCommentStore(
  options: LocalOverlayCommentStoreOptions,
): LocalOverlayCommentStore {
  const { base } = options
  let remoteWritesAllowed = options.allowRemoteWrites ?? true
  const allowRemoteWrites = (): boolean => remoteWritesAllowed
  /**
   * Comments the visitor CREATED here. Delegated to the shared in-memory
   * reference implementation rather than reimplemented, so numbering and
   * participant collection match every other store.
   */
  const created = createInMemoryCommentStore()
  /**
   * Edits and replies the visitor made to a SEEDED comment, by id.
   *
   * Separate from `created` because those comments belong to the base store: an
   * in-memory `update` would throw "not found", and re-creating them locally
   * would change their ids and duplicate them in the merge. An override is the
   * smallest thing that expresses "the server's copy, but with my change on
   * top", and it survives the base store's next poll re-reporting the original.
   */
  const overrides = new Map<string, Comment>()
  /** Ids deleted locally, so a base re-report does not resurrect them. */
  const deletedLocally = new Set<string>()

  let baseSnapshot: Comment[] = []
  let createdSnapshot: Comment[] = []
  const listeners = new Set<CommentSubscriber>()

  function merged(): Comment[] {
    const out: Comment[] = []
    for (const c of baseSnapshot) {
      if (deletedLocally.has(c.id)) continue
      out.push(overrides.get(c.id) ?? c)
    }
    return [...out, ...createdSnapshot]
  }

  function emit(): void {
    const snapshot = merged()
    for (const listener of listeners) listener(snapshot)
  }

  async function refreshCreated(): Promise<void> {
    createdSnapshot = await created.list()
  }

  /** The current local view of one comment, whichever mechanism holds it. */
  function currentLocal(id: string): Comment | null {
    return merged().find((c) => c.id === id) ?? null
  }

  /** True when `id` is a comment this overlay created, rather than a seeded one. */
  function isLocallyCreated(id: string): boolean {
    return createdSnapshot.some((c) => c.id === id)
  }

  return {
    async list(): Promise<Comment[]> {
      baseSnapshot = await base.list()
      await refreshCreated()
      return merged()
    },

    async get(id: string): Promise<Comment | null> {
      return currentLocal(id)
    },

    async create(input: CommentCreateInput): Promise<Comment> {
      if (allowRemoteWrites()) return base.create(input)
      const comment = await created.create(input)
      await refreshCreated()
      emit()
      return comment
    },

    async update(id: string, patch: CommentUpdatePatch): Promise<Comment> {
      if (allowRemoteWrites()) return base.update(id, patch)
      if (isLocallyCreated(id)) {
        const updated = await created.update(id, patch)
        await refreshCreated()
        emit()
        return updated
      }
      const existing = currentLocal(id)
      if (existing === null) throw new Error(`Comment not found: ${id}`)
      const updated: Comment = {
        ...existing,
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.resolved !== undefined ? { resolved: patch.resolved } : {}),
        ...(patch.mentions !== undefined ? { mentions: patch.mentions } : {}),
      }
      overrides.set(id, updated)
      emit()
      return updated
    },

    async delete(id: string): Promise<void> {
      if (allowRemoteWrites()) return base.delete(id)
      if (isLocallyCreated(id)) {
        await created.delete(id)
        await refreshCreated()
      } else {
        deletedLocally.add(id)
        overrides.delete(id)
      }
      emit()
    },

    async addReply(id: string, reply: CommentReplyInput): Promise<Comment> {
      if (allowRemoteWrites()) return base.addReply(id, reply)
      if (isLocallyCreated(id)) {
        const replied = await created.addReply(id, reply)
        await refreshCreated()
        emit()
        return replied
      }
      const existing = currentLocal(id)
      if (existing === null) throw new Error(`Comment not found: ${id}`)
      const replies = [
        ...(existing.replies ?? []),
        {
          id: `local-reply-${existing.id}-${(existing.replies?.length ?? 0) + 1}`,
          body: reply.body,
          author: reply.author,
          createdAt: new Date().toISOString(),
          ...(reply.mentions ? { mentions: reply.mentions } : {}),
        },
      ]
      const updated: Comment = { ...existing, replies } as Comment
      overrides.set(id, updated)
      emit()
      return updated
    },

    setAllowRemoteWrites(allowed: boolean): void {
      remoteWritesAllowed = allowed
    },

    subscribe(listener: CommentSubscriber, onError?: CommentSubscribeError): () => void {
      listeners.add(listener)
      const unsubscribeBase = base.subscribe((comments) => {
        baseSnapshot = comments
        emit()
      }, onError)
      // NO synchronous first emission, and the comment that used to be here
      // was the bug. It said this matched "the contract every other
      // implementation follows"; it does not. Neither `http-comment-store`
      // nor `viewer-http-comment-store` emits on subscribe. Both fetch, then
      // emit when data arrives.
      //
      // What the immediate emit did instead: `baseSnapshot` starts empty, so
      // it handed the consumer `[]` before the backend had answered. The
      // review shell treats ANY emission as loaded (`setHasLoadedOnce(true)`,
      // `setLoadError(null)`), so a subsequent load FAILURE could no longer
      // reach its own branch, which is gated on `!hasLoadedOnce`. The reader
      // saw "No comments" for a list that had failed to load. Found by a
      // codex review.
      //
      // But NOT silent when there is already something local to say. A
      // comment created before this listener subscribed would otherwise be
      // invisible to it forever: the mutation's own `emit()` fired when there
      // were no listeners, and if the base never answers, nothing fires
      // again. That also breaks `CommentStore.subscribe`'s contract, which is
      // to hand a full snapshot. Removing the emission outright was an
      // over-correction, caught by a third codex round on the fix itself.
      //
      // So the rule is about CONTENT, not timing: emit what is known, say
      // nothing when nothing is known. An empty first emission is the only
      // one that misleads, because it is indistinguishable from a loaded
      // empty list.
      if (createdSnapshot.length > 0 || overrides.size > 0 || deletedLocally.size > 0) {
        listener(merged())
      }
      return () => {
        listeners.delete(listener)
        unsubscribeBase()
      }
    },
  }
}
