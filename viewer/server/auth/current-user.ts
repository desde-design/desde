/**
 * Session-cookie → `User` reader. Used by route guards (Task 3's
 * `GET /api/v1/me` and any future auth-gated route) and by anything else
 * that needs "who is this request, if anyone."
 *
 * Deliberately takes `{ storage, config }` rather than the full `AppDeps`
 * so it's trivially unit-testable, and takes only the parts of `Request`
 * it needs (`headers.cookie`) so it has no other Express coupling.
 *
 * Contract: NEVER throws. Every failure mode — no cookie, malformed or
 * tampered cookie, wrong secret, no matching session row, an expired
 * session, a storage error — resolves to `null`. A route guard built on
 * this can treat "not signed in" and "something went wrong resolving the
 * session" identically: fail closed, never 500.
 */

import type { Request } from "express"
import type { ViewerConfig } from "../config"
import type { StorageAdapter, User } from "../storage/types"
import { readCookie, sessionCookieName, verifySessionCookie } from "./session-cookie"
import { isSecurePublicUrl } from "../api/state-cookie"

export interface CurrentUserDeps {
  storage: StorageAdapter
  config: ViewerConfig
}

export async function getCurrentUser(
  deps: CurrentUserDeps,
  req: Pick<Request, "headers">,
): Promise<User | null> {
  try {
    // Hard cutover: on an https deployment ONLY the `__Host-viewer_session`
    // name is read. There is deliberately no unprefixed fallback — accepting
    // the plain name on https would re-open the tossing vector `__Host-` exists
    // to close (see `sessionCookieName`).
    const secure = isSecurePublicUrl(deps.config.publicUrl)
    const raw = readCookie(req.headers.cookie, sessionCookieName(secure))
    if (!raw) return null

    const sessionId = verifySessionCookie(deps.config.sessionSecret, raw)
    if (!sessionId) return null

    const session = await deps.storage.getSession(sessionId)
    if (!session) return null

    if (session.expiresAt <= new Date().toISOString()) {
      // Opportunistic cleanup — best-effort, never lets a delete failure
      // turn an expired session into a thrown error.
      await deps.storage.deleteSession(sessionId).catch(() => {})
      return null
    }

    const user = await deps.storage.getUser(session.userId)
    if (!user) return null

    // Re-evaluate the CONTINUING entitlement on every request, not just at
    // sign-in (audit K08). The entitlement is now membership status: `removed`
    // is a soft delete, so the row survives — every old comment, membership and
    // mention still resolves to a name — but the account itself is finished,
    // and this is what stops its unexpired session cookie from outliving it.
    //
    // This REPLACED a re-evaluation of `VIEWER_ALLOWED_EMAIL_DOMAINS`. That env
    // var is an ADMISSION gate now: it seeds instance domain rules once at boot
    // (`seedDomainRulesFromEnv`) and the sign-in gate decides with them. Kept
    // here it was actively wrong — with the allowlist set and no GitHub App
    // configured, the local operator (`operator@localhost`, in nobody's
    // allowlist) signed in and was then null on the very next request.
    //
    // Checked here rather than at each call site because this is the one place
    // a session becomes a `User`; a per-route check is the kind that gets
    // forgotten on the next route added.
    if (user.status !== "active") {
      // Drop the session too, so the next request costs nothing and the
      // browser stops presenting a credential that can no longer work.
      await deps.storage.deleteSession(sessionId).catch(() => {})
      return null
    }

    return user
  } catch {
    return null
  }
}
