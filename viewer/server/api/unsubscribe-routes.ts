import { Router, type Request, type Response } from "express"
import type { AppDeps } from "../create-app"
import { resolveProjectName } from "../notify/outbox-drain"
import { unsubscribeConfirmationHtml, verifyUnsubscribeToken } from "../notify/mention-email"

/**
 * Shared by GET and POST — see the route registrations below for why both
 * exist. No `requireAdmin`: this route IS the auth boundary — the signed
 * token (minted by `signUnsubscribeToken`, only ever embedded server-side)
 * is what proves the caller is the intended recipient, so a bearer-token
 * guard would be redundant and would also break clicking the link from a
 * plain email client (or a mail client's automated one-click POST).
 *
 * Returns HTML (the confirmation page a human clicked into from their inbox
 * sees), not JSON like the rest of the API — errors stay JSON for
 * consistency with every other route, only the success path is HTML.
 */
async function handleUnsubscribe(deps: AppDeps, req: Request, res: Response): Promise<void> {
  const secret = deps.config.unsubscribeSecret
  if (!secret) {
    res.status(404).json({ error: "Unsubscribe links are not configured" })
    return
  }

  const token = typeof req.query.token === "string" ? req.query.token : ""
  if (!token) {
    res.status(400).json({ error: "token is required" })
    return
  }

  const payload = await verifyUnsubscribeToken(secret, token)
  if (!payload) {
    res.status(400).json({ error: "Invalid or expired unsubscribe token" })
    return
  }

  // `scope=global` records a `{participantId, projectId: null}` row — kept
  // working (StorageAdapter.recordOptout/isOptedOut both still support it)
  // for forward-compat with Phase 3 identity unification, but as of today it
  // only ever suppresses the ONE project the clicked link belongs to (see
  // `unsubscribeConfirmationHtml`'s doc comment for why). The confirmation
  // copy below never claims broader scope than that project, regardless of
  // `scope`.
  const scope: "project" | "global" = req.query.scope === "global" ? "global" : "project"
  await deps.storage.recordOptout({
    participantId: payload.participantId,
    projectId: scope === "global" ? null : payload.projectId,
  })

  const project = await deps.storage.getProject(payload.projectId)
  const html = unsubscribeConfirmationHtml({
    projectName: resolveProjectName(project, payload.projectId),
  })
  res.status(200).type("html").send(html)
}

export function createUnsubscribeRoutes(deps: AppDeps): Router {
  const router = Router()

  // `GET /api/v1/unsubscribe?token=…[&scope=global]` — the link every
  // mention email's footer points at (clicked from a browser or a plain
  // email client).
  router.get("/unsubscribe", (req: Request, res: Response) => handleUnsubscribe(deps, req, res))

  // `POST /api/v1/unsubscribe?token=…` — RFC 8058 one-click unsubscribe.
  // `smtp-email-provider.ts` advertises `List-Unsubscribe-Post:
  // List-Unsubscribe=One-Click` on every email carrying a `List-Unsubscribe`
  // header, which tells Gmail/Yahoo/etc. the URI accepts a bodyless POST —
  // without this route that POST 404s, so mail-client one-click unsubscribe
  // silently failed (Fix 4, phase-2b-2 review). Shares the exact same
  // handler as GET: the token lives in the query string either way, and
  // nothing here reads the request body.
  router.post("/unsubscribe", (req: Request, res: Response) => handleUnsubscribe(deps, req, res))

  return router
}
