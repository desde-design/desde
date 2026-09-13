import type { RequestHandler } from "express"
import type { ViewerConfig } from "../config"
import { isSecurePublicUrl } from "../api/state-cookie"
import type { PrototypeHostScopedRequest } from "../serve/prototype-host-scope"
import { clearSessionCookie, clearTossedSessionCookie, countCookie, sessionCookieName } from "./session-cookie"

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
      res.append("Set-Cookie", [clearSessionCookie({ secure: false }), clearTossedSessionCookie(hostname)])
    }
    next()
  }
}
