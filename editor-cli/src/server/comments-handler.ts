/**
 * HTTP handlers for Comments CRUD.
 *
 * Routes (relative to /api/editor/comments):
 *   GET    /                — list all
 *   POST   /                — create
 *   GET    /:id             — get one
 *   PATCH  /:id             — update
 *   DELETE /:id             — delete
 *   POST   /:id/replies     — add reply
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentUpdatePatch,
} from "../../../src/editor/core"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"

const ROUTE_PREFIX = "/api/editor/comments"

export interface CommentsHandlerContext {
  store: CommentStore
}

export function matchesCommentsRoute(pathname: string): boolean {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)
}

export async function handleCommentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CommentsHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const subpath = url.pathname.slice(ROUTE_PREFIX.length) // "" | "/:id" | "/:id/replies"

  await runHandler(res, async () => {
    // ── Collection routes (no id) ──────────────────────────────
    if (subpath === "" || subpath === "/") {
      if (req.method === "GET") {
        const all = await ctx.store.list()
        sendJson(res, 200, { ok: true, comments: all })
        return
      }
      if (req.method === "POST") {
        const body = await readJsonBody<CommentCreateInput>(req)
        if (!body.position || !body.body || !body.author) {
          sendJson(res, 400, {
            ok: false,
            reason: "Missing required fields: position, body, author",
          })
          return
        }
        const comment = await ctx.store.create(body)
        sendJson(res, 201, { ok: true, comment })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    // ── Item routes (/:id and /:id/replies) ────────────────────
    const segments = subpath.split("/").filter(Boolean) // ["id"] | ["id", "replies"]
    const [id, sub] = segments

    if (segments.length === 1) {
      if (req.method === "GET") {
        const comment = await ctx.store.get(id)
        if (!comment) {
          sendJson(res, 404, { ok: false, reason: `Comment ${id} not found` })
          return
        }
        sendJson(res, 200, { ok: true, comment })
        return
      }
      if (req.method === "PATCH") {
        const body = await readJsonBody<CommentUpdatePatch>(req)
        const comment = await ctx.store.update(id, body)
        sendJson(res, 200, { ok: true, comment })
        return
      }
      if (req.method === "DELETE") {
        await ctx.store.delete(id)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    if (segments.length === 2 && sub === "replies" && req.method === "POST") {
      const body = await readJsonBody<CommentReplyInput>(req)
      if (!body.body || !body.author) {
        sendJson(res, 400, {
          ok: false,
          reason: "Missing required fields: body, author",
        })
        return
      }
      const comment = await ctx.store.addReply(id, body)
      sendJson(res, 201, { ok: true, comment })
      return
    }

    sendJson(res, 404, { ok: false, reason: `Unknown comments route: ${subpath}` })
  })
}
