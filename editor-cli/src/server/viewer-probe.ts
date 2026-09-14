import type { IncomingMessage, ServerResponse } from "node:http"
import { readOriginRemoteUrl } from "./git-remote.js"
import { readJsonBody } from "./http-body.js"
import { readProjectConfig } from "./project-config.js"
import {
  normalizeOrigin,
  readDefaultViewerOrigin,
  readViewerToken,
} from "./viewer-token-store.js"

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

/**
 * Which project this checkout already belongs to, when the viewer knows.
 *
 * `null` whenever anything is uncertain: no repo context, no identity to ask
 * with, the viewer said `mint` or `conflict`, or it named a project this token
 * cannot actually see. A wrong pre-selection is worse than none — it points
 * someone's comments at another prototype while looking like it did the work
 * for them — so every unsure case falls back to the plain list.
 */
interface ProjectMatch {
  projectId: string
  /**
   * What matched, for the dialog to say out loud. `identity` is the id
   * committed in `.desde/config.json`; `repo` is the git remote used as a
   * discovery index.
   */
  by: "identity" | "repo"
}

/**
 * Ask the viewer whether it already has a prototype for this checkout.
 *
 * The machinery is not new. `POST /api/v1/projects/resolve` has matched on
 * the embedded identity id and fallen back to the git remote since the
 * auto-link work (2026-08-26), and `viewer-resolve.ts` already calls it at
 * boot against the machine's DEFAULT viewer. What it never covered is the
 * dialog: connecting to a viewer for the first time, or to a second one,
 * listed every project and pre-selected `projects[0]` — the first row the
 * viewer happened to return, unrelated to the repo in front of you.
 *
 * Read-only and best effort, like every other read here. It runs after the
 * token has been accepted, so a failure at this point means the connect flow
 * offers a plain list, which is exactly what it offered before.
 */
async function findProjectMatch(
  origin: string,
  token: string,
  repoRoot: string,
  visibleProjectIds: ReadonlySet<string>,
): Promise<ProjectMatch | null> {
  const config = await readProjectConfig(repoRoot)
  const embeddedId = config.ok ? (config.config.project?.id ?? "") : ""
  const remoteUrl = (await readOriginRemoteUrl(repoRoot)) ?? ""
  // The endpoint 400s on neither, and a checkout with no remote and no
  // committed identity genuinely has nothing to match on.
  if (!embeddedId && !remoteUrl) return null

  let body: unknown
  try {
    const resolved = await fetch(`${normalizeOrigin(origin)}/api/v1/projects/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ...(embeddedId ? { embeddedId } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
      }),
    })
    if (!resolved.ok) return null
    body = await resolved.json()
  } catch {
    return null
  }

  const decision = body as { decision?: unknown; project?: { id?: unknown } }
  if (decision.decision !== "adopt") return null
  const projectId = typeof decision.project?.id === "string" ? decision.project.id : ""
  if (!projectId) return null

  // The resolve route is deliberately public-read, so it answers for projects
  // this token may not be able to open. Pre-selecting one of those would put
  // the dialog in a state where Connect fails on a row the user never chose.
  if (!visibleProjectIds.has(projectId)) return null

  // Which of the two keys did it? The response does not say, so this is
  // inferred from what was sent rather than asserted: with no embedded id in
  // the repo, the remote is the only thing it can have matched on. When both
  // were sent, the route's own precedence is identity first, so that is the
  // honest label.
  return { projectId, by: embeddedId ? "identity" : "repo" }
}

/**
 * `repoRoot` is optional so the probe stays callable with no repo context
 * (its own tests, and any future caller that has a token but no checkout).
 * Without it the response simply carries no match.
 */
export async function handleViewerProbe(
  req: IncomingMessage,
  res: ServerResponse,
  repoRoot?: string,
): Promise<void> {
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

  const result = await collectViewerProjects(origin, token, repoRoot)
  sendJson(res, result.status, result.body)
}

/**
 * Everything the probe does once a URL and token are in hand: list the
 * viewer's projects, refuse a read-only token, and work out which project
 * this checkout already is.
 *
 * Extracted 2026-09-14 so `GET /api/editor/viewer-auth/projects` can reuse it
 * with the STORED credential. The project-scoped "Viewer project" dialog must
 * not ask for a URL and token the machine already has, and duplicating the
 * write-scope refusal into a second handler is how one of two copies quietly
 * stops refusing.
 */
export async function collectViewerProjects(
  origin: string,
  token: string,
  repoRoot?: string,
): Promise<{ status: number; body: unknown }> {
  let listRes: Response
  try {
    listRes = await fetch(`${normalizeOrigin(origin)}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
  } catch {
    return jsonResult(502, {
      ok: false,
      reason: `Could not reach a viewer at ${origin}. Check the URL and that the server is running.`,
    })
  }

  if (listRes.status === 401) {
    // Distinguished from "unreachable" and from "reachable but empty": each
    // has a different fix, and collapsing them into one message is how a
    // connect flow becomes guesswork.
    return jsonResult(401, { ok: false, reason: "That token was rejected. It may have been revoked, or belong to a different viewer." })
  }
  if (!listRes.ok) {
    return jsonResult(502, { ok: false, reason: `The viewer answered ${listRes.status}. Is ${origin} really a Desde viewer?` })
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
    return jsonResult(400, {
      ok: false,
      reason:
        "That token is read-only, so comments could be read but never posted. " +
        "Create a new token in the viewer under Settings with the WRITE scope ticked, and paste that one.",
    })
  }

  const payload = (await listRes.json().catch(() => null)) as { projects?: unknown } | null
  const projects = Array.isArray(payload?.projects) ? payload.projects.filter(isViewerProject) : []

  const match =
    repoRoot === undefined
      ? null
      : await findProjectMatch(origin, token, repoRoot, new Set(projects.map((p) => p.id)))

  // Field-by-field, never the viewer's raw objects: this response reaches the
  // browser, and a future viewer field (a member email, say) should not start
  // flowing there because the shape widened upstream.
  return jsonResult(200, {
    ok: true,
    origin,
    projects: projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name })),
    ...(match ? { match } : {}),
  })
}

function jsonResult(status: number, body: unknown): { status: number; body: unknown } {
  return { status, body }
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

export const VIEWER_PROJECTS_ROUTE = "/api/editor/viewer-auth/projects"

/**
 * `GET /api/editor/viewer-auth/projects` — the projects on the machine's
 * DEFAULT viewer, using the credential already stored for it.
 *
 * The project-scoped "Viewer project" dialog picks which project this repo is,
 * and nothing more (Mo, 2026-09-14: "just have the affordance for the project
 * link, not the whole viewer"). Asking again for a URL and token the machine
 * already holds is what made that dialog indistinguishable from the
 * editor-level one.
 *
 * Answers 409 rather than an error when there is no viewer or no token: that
 * is not a failure, it is a prerequisite the user has not met yet, and the
 * dialog says so and points at the editor-level setting. The token itself
 * never leaves this process — only the project list does.
 */
export async function handleViewerProjectsRequest(
  res: ServerResponse,
  repoRoot?: string,
): Promise<void> {
  const origin = await readDefaultViewerOrigin()
  if (!origin) {
    sendJson(res, 409, { ok: false, reason: "no-viewer" })
    return
  }
  const token = await readViewerToken(origin)
  if (!token) {
    sendJson(res, 409, { ok: false, reason: "no-token", origin })
    return
  }
  const result = await collectViewerProjects(origin, token, repoRoot)
  sendJson(res, result.status, result.body)
}
