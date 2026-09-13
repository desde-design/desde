import type { RequestHandler } from "express"
import type { ViewerConfig } from "../config"
import { isSecurePublicUrl } from "../api/state-cookie"
import type { PrototypeHostScopedRequest } from "../serve/prototype-host-scope"
import { clearTossedSessionCookie, countCookie, sessionCookieName } from "./session-cookie"

/**
 * On plain http, a request that carries the session cookie name twice has
 * a tossed `Domain` copy beside the real one. `getCurrentUser` already reads
 * that as signed out; this clears both spellings so the next request is
 * clean. On https the `__Host-` name cannot be tossed, so there is nothing
 * to do.
 *
 * Skipped on prototype hosts: no session cookie is ever issued or read
 * there, so a doubled cookie a prototype's own JS sent is none of this
 * middleware's business.
 */
export function createSessionCookieHygiene(config: Pick<ViewerConfig, "publicUrl">): RequestHandler {
  const secure = isSecurePublicUrl(config.publicUrl)
  const hostname = new URL(config.publicUrl).hostname
  const name = sessionCookieName(false)
  return (req, res, next) => {
    if (secure || (req as PrototypeHostScopedRequest).prototypeHostScoped === true) {
      next()
      return
    }
    if (countCookie(req.headers.cookie, name) > 1) {
      // Only the `Domain` spelling is cleared (final review, P1). The
      // reviewer's own cookie is host-only, and a sibling host can never
      // plant a host-only cookie, so it is never the planted one; clearing
      // it too let a planted cookie on a narrower `Path` (which this clear
      // cannot reach) stand alone on that subtree and sign the reviewer in as
      // the planter. With the real cookie kept, that subtree reads two
      // cookies and stays signed out until the browser's cookies are cleared,
      // which is a nuisance, not an impersonation.
      res.append("Set-Cookie", clearTossedSessionCookie(hostname))
    }
    next()
  }
}
