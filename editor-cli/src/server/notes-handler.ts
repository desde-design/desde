/**
 * HTTP handlers for Notes CRUD. Mirrors comments-handler — same
 * shape, different store + route prefix.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  NoteCreateInput,
  NoteReplyInput,
  NoteStore,
  NoteUpdatePatch,
} from "../../../src/editor/core"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"

const ROUTE_PREFIX = "/api/editor/notes"

export interface NotesHandlerContext {
  store: NoteStore
}

export function matchesNotesRoute(pathname: string): boolean {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)
}

export async function handleNotesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: NotesHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const subpath = url.pathname.slice(ROUTE_PREFIX.length)

  await runHandler(res, async () => {
    if (subpath === "" || subpath === "/") {
      if (req.method === "GET") {
        const all = await ctx.store.list()
        sendJson(res, 200, { ok: true, notes: all })
        return
      }
      if (req.method === "POST") {
        const body = await readJsonBody<NoteCreateInput>(req)
        if (!body.position || !body.body || !body.author) {
          sendJson(res, 400, {
            ok: false,
            reason: "Missing required fields: position, body, author",
          })
          return
        }
        const note = await ctx.store.create(body)
        sendJson(res, 201, { ok: true, note })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    const segments = subpath.split("/").filter(Boolean)
    const [id, sub] = segments

    if (segments.length === 1) {
      if (req.method === "GET") {
        const note = await ctx.store.get(id)
        if (!note) {
          sendJson(res, 404, { ok: false, reason: `Note ${id} not found` })
          return
        }
        sendJson(res, 200, { ok: true, note })
        return
      }
      if (req.method === "PATCH") {
        const body = await readJsonBody<NoteUpdatePatch>(req)
        const note = await ctx.store.update(id, body)
        sendJson(res, 200, { ok: true, note })
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
      const body = await readJsonBody<NoteReplyInput>(req)
      if (!body.body || !body.author) {
        sendJson(res, 400, {
          ok: false,
          reason: "Missing required fields: body, author",
        })
        return
      }
      const note = await ctx.store.addReply(id, body)
      sendJson(res, 201, { ok: true, note })
      return
    }

    sendJson(res, 404, { ok: false, reason: `Unknown notes route: ${subpath}` })
  })
}
