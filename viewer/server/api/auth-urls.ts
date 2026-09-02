/**
 * The absolute URLs the two one-time-token families are handed out as:
 * `dsi_` invite links and `dss_` sign-in links.
 *
 * ## Why this is a module and not two local helpers
 *
 * The invite URL used to be built inside `instance-routes.ts`, which was fine
 * while exactly one router minted links. Task 14 added a second family that is
 * minted from BOTH routers — `auth-routes.ts` puts a sign-in URL into a magic
 * link email, `instance-routes.ts` returns one from the admin-issued link
 * route — so a local helper would have become two copies of one construction.
 *
 * The specific bug that shape produces is already on the record. The plan's
 * URL template said `${origin}/auth/invite/${token}`, while the route it
 * resolves to is mounted at `/api/v1/auth/invite/<token>` like every other
 * route in this router. The revealed link 404ed in a real browser and every
 * test still passed, because each test split the TOKEN out of the URL and
 * rebuilt the request path by hand — so nothing ever asked the app to resolve
 * the URL it had just produced.
 *
 * Hence: one constant per family, one origin rule, and (in the suites) a
 * drift-proof test that takes the RETURNED url, keeps only its path, and GETs
 * that path on the same app.
 */

import type { Request } from "express"
import type { AppDeps } from "../create-app"

/**
 * The origin a link is built against: `deps.config.publicUrl` when set
 * (always, in practice — `loadConfig` defaults it to
 * `http://localhost:{port}`), falling back to the request's own origin so a
 * URL is still produced even in a hypothetical future where that default goes
 * away.
 */
function linkOrigin(deps: Pick<AppDeps, "config">, req: Request): string {
  if (deps.config.publicUrl) return deps.config.publicUrl
  const host = req.get("host") ?? "localhost"
  return `${req.protocol}://${host}`
}

/**
 * The invite-ACCEPTANCE route's full path, `/api/v1` included — see the file
 * comment for why the prefix is written here rather than inferred.
 *
 * Exported since the GET/POST split (fix wave 6): the confirmation page the
 * GET renders has to name the path its form posts to, and that path must be
 * the one the emailed URL was built from. A second literal in `auth-routes.ts`
 * would be a way for the two to drift — the exact failure this module was
 * created to stop.
 */
export const INVITE_ACCEPT_PATH = "/api/v1/auth/invite"

/** The sign-in-link route's full path. Same discipline as the invite one. */
export const SIGN_IN_ACCEPT_PATH = "/api/v1/auth/signin"

export function inviteAcceptUrl(deps: Pick<AppDeps, "config">, req: Request, token: string): string {
  return `${linkOrigin(deps, req)}${INVITE_ACCEPT_PATH}/${token}`
}

export function signInUrl(deps: Pick<AppDeps, "config">, req: Request, token: string): string {
  return `${linkOrigin(deps, req)}${SIGN_IN_ACCEPT_PATH}/${token}`
}
