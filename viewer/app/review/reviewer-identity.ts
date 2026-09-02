import type { CommentAuthor } from "@/types/bridge"
import type { ViewerUser } from "../use-current-user"

export const REVIEWER_IDENTITY_STORAGE_KEY = "desde-viewer:identity"

/**
 * Self-declared reviewer identity (Phase 2): a name typed once, kept in
 * localStorage. UNVERIFIED and spoofable by design — real accounts arrive
 * with Phase 3 auth, which links verified users to these snapshots by email.
 * Mirrors oss-comments' createNamePromptIdentity, widened to the repo's
 * CommentAuthor shape.
 */
export function getReviewerIdentity(): CommentAuthor | null {
  try {
    const raw = globalThis.localStorage?.getItem(REVIEWER_IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CommentAuthor
    if (typeof parsed.uid !== "string" || typeof parsed.displayName !== "string") return null
    return parsed
  } catch {
    return null
  }
}

export function saveReviewerIdentity(input: { displayName: string; email?: string }): CommentAuthor {
  const identity: CommentAuthor = {
    uid: `viewer:${crypto.randomUUID()}`,
    displayName: input.displayName.trim(),
    email: input.email?.trim() ?? "",
    photoURL: "",
  }
  globalThis.localStorage?.setItem(REVIEWER_IDENTITY_STORAGE_KEY, JSON.stringify(identity))
  return identity
}

/**
 * Phase 3: prefers the verified, signed-in account over the self-declared
 * (Phase 2) identity. `uid` is minted as `user:<id>` — distinct from the
 * `viewer:<uuid>` prefix `saveReviewerIdentity` uses — so comments authored
 * by a real account are distinguishable from the unverified, spoofable ones.
 * Falls back to `getReviewerIdentity()` when nobody is signed in, and to
 * `null` when there's no signed-in user and no stored identity either.
 */
export function resolveAuthor(user: ViewerUser | null): CommentAuthor | null {
  if (user) {
    return {
      uid: `user:${user.id}`,
      displayName: user.displayName,
      email: user.email,
      photoURL: user.avatarUrl,
    }
  }
  return getReviewerIdentity()
}
