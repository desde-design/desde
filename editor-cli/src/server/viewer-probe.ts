import type { IncomingMessage, ServerResponse } from "node:http"
import { readJsonBody } from "./http-body.js"
import { normalizeOrigin } from "./viewer-token-store.js"

/**
 * `POST /api/editor/viewer-auth/probe` — validate a viewer URL + access token
 * and list the projects that token can reach.
 *
 * Exists because of a chicken-and-egg in the connect flow: the comment proxy
 * deliberately forwards only to the ONE project already recorded in
 * `.desde/config.json`, so it cannot be used to discover which projects
 * exist before anything is configured. Probing is the one place a viewer is
 * contacted with a token that is not yet stored.
 *
 * The token is used and DISCARDED — nothing here writes it. Connecting is a
 * separate, explicit step, so a mistyped URL or a wrong token cannot leave a
 * half-configured repo behind.
 */

export const VIEWER_PROBE_ROUTE = "/api/editor/viewer-auth/probe"

interface ViewerProject {
  id: string
  slug: string
  name: string
}

function isViewerProject(v: unknown): v is ViewerProject {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.id === "string" && typeof p.slug === "string" && typeof p.name === "string"
}

export async function handleViewerProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody<{ baseUrl?: unknown; token?: unknown }>(req).catch(
    () => ({}) as { baseUrl?: unknown; token?: unknown },
  )
  const rawBase = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : ""
  const token = typeof body?.token === "string" ? body.token.trim() : ""

  if (!rawBase) {
    sendJson(res, 400, { ok: false, reason: "Enter the viewer's URL." })
    return
  }
  let origin: string
  try {
    const parsed = new URL(rawBase)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme")
    origin = parsed.origin
  } catch {
    sendJson(res, 400, { ok: false, reason: `"${rawBase}" is not a valid URL: include http:// or https://.` })
    return
  }
  // Same shape check the store endpoint uses, so a pasted-wrong value fails
  // HERE with a clear message rather than as an opaque 401 from the viewer.
  if (!/^dsv_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(token)) {
    sendJson(res, 400, {
      ok: false,
      reason: "That does not look like a viewer access token (expected `dsv_…`). Create one in the viewer under Settings.",
    })
    return
  }

  let listRes: Response
  try {
    listRes = await fetch(`${normalizeOrigin(origin)}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
  } catch {
    sendJson(res, 502, {
      ok: false,
      reason: `Could not reach a viewer at ${origin}. Check the URL and that the server is running.`,
    })
    return
  }

  if (listRes.status === 401) {
    // Distinguished from "unreachable" and from "reachable but empty": each
    // has a different fix, and collapsing them into one message is how a
    // connect flow becomes guesswork.
    sendJson(res, 401, { ok: false, reason: "That token was rejected. It may have been revoked, or belong to a different viewer." })
    return
  }
  if (!listRes.ok) {
    sendJson(res, 502, { ok: false, reason: `The viewer answered ${listRes.status}. Is ${origin} really a Desde viewer?` })
    return
  }

  // Alive is not the same as sufficient.
  //
  // The list above only proves READ access, and the viewer's token UI creates
  // read-only tokens by default (write is an unchecked box). So the DEFAULT
  // paste-a-token path used to succeed here, store the credential, and then
  // fail every single comment write with a 403 from `requireProjectWrite` —
  // the connect flow reporting success for a connection that cannot do the
  // one thing it exists for. Public-link projects are no escape either: the
  // proxy always attaches the bearer, so the anonymous-write path is gone.
  //
  // Refuse at connect time, where the message can name the fix.
  const meRes = await fetch(`${normalizeOrigin(origin)}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }).catch(() => null)
  const me = (await meRes?.json().catch(() => null)) as { scopes?: unknown } | null
  const scopes = Array.isArray(me?.scopes) ? (me.scopes as unknown[]).filter((x) => typeof x === "string") : null
  // `null` = this viewer predates `/me` reporting scopes. Accept rather than
  // block: refusing on an older viewer would break connecting to it entirely,
  // which is a worse failure than the 403 this check is trying to pre-empt.
  if (scopes !== null && !scopes.includes("write")) {
    sendJson(res, 400, {
      ok: false,
      reason:
        "That token is read-only, so comments could be read but never posted. " +
        "Create a new token in the viewer under Settings with the WRITE scope ticked, and paste that one.",
    })
    return
  }

  const payload = (await listRes.json().catch(() => null)) as { projects?: unknown } | null
  const projects = Array.isArray(payload?.projects) ? payload.projects.filter(isViewerProject) : []
  // Field-by-field, never the viewer's raw objects: this response reaches the
  // browser, and a future viewer field (a member email, say) should not start
  // flowing there because the shape widened upstream.
  sendJson(res, 200, {
    ok: true,
    origin,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}
