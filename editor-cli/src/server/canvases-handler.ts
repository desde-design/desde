/**
 * HTTP handlers for Canvas CRUD.
 *
 * Routes:
 *   GET    /api/editor/canvases                                       — list
 *   POST   /api/editor/canvases                                       — create
 *   GET    /api/editor/canvases/:id                                   — get one
 *   PATCH  /api/editor/canvases/:id                                   — update
 *   DELETE /api/editor/canvases/:id                                   — delete
 *
 *   GET    /api/editor/canvases/:id/frames                            — list frames
 *   POST   /api/editor/canvases/:id/frames                            — create frame
 *   PATCH  /api/editor/canvases/:id/frames/:frameId                   — update frame
 *   DELETE /api/editor/canvases/:id/frames/:frameId                   — delete frame
 *
 *   GET    /api/editor/canvases/:id/edges                             — list edges
 *   POST   /api/editor/canvases/:id/edges                             — create edge
 *   PATCH  /api/editor/canvases/:id/edges/:edgeId                     — update edge
 *   DELETE /api/editor/canvases/:id/edges/:edgeId                     — delete edge
 *
 *   GET    /api/editor/canvases/:id/annotations                       — list
 *   POST   /api/editor/canvases/:id/annotations                       — create
 *   PATCH  /api/editor/canvases/:id/annotations/:annotationId         — update
 *   DELETE /api/editor/canvases/:id/annotations/:annotationId         — delete
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type {
  CanvasAnnotationCreateInput,
  CanvasAnnotationUpdatePatch,
  CanvasCreateInput,
  CanvasEdgeCreateInput,
  CanvasEdgeUpdatePatch,
  CanvasFrameCreateInput,
  CanvasFrameUpdatePatch,
  CanvasStore,
  CanvasUpdatePatch,
} from "../../../src/editor/core"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"

// Frame create/update bodies carry full-page screenshot data URLs — the
// 256 KiB default JSON cap 413s every real capture (found in the Phase 6
// works pass: "Screenshot -> canvas" silently failed). Same 50 MiB ceiling
// as the screenshot-plans screenshots route.
const FRAME_BODY_MAX_BYTES = 50 * 1024 * 1024

const ROUTE_PREFIX = "/api/editor/canvases"

export interface CanvasesHandlerContext {
  store: CanvasStore
}

export function matchesCanvasesRoute(pathname: string): boolean {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)
}

export async function handleCanvasesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CanvasesHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const subpath = url.pathname.slice(ROUTE_PREFIX.length)
  const segments = subpath.split("/").filter(Boolean)

  await runHandler(res, async () => {
    // ── /api/editor/canvases ─────────────────────────────────
    if (segments.length === 0) {
      if (req.method === "GET") {
        const canvases = await ctx.store.listCanvases()
        sendJson(res, 200, { ok: true, canvases })
        return
      }
      if (req.method === "POST") {
        const body = await readJsonBody<CanvasCreateInput>(req)
        if (!body.name) {
          sendJson(res, 400, { ok: false, reason: "Missing required field: name" })
          return
        }
        const canvas = await ctx.store.createCanvas(body)
        sendJson(res, 201, { ok: true, canvas })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    const [canvasId, kind, childId] = segments

    // ── /api/editor/canvases/:id ─────────────────────────────
    if (segments.length === 1) {
      if (req.method === "GET") {
        const canvas = await ctx.store.getCanvas(canvasId)
        if (!canvas) {
          sendJson(res, 404, { ok: false, reason: `Canvas ${canvasId} not found` })
          return
        }
        sendJson(res, 200, { ok: true, canvas })
        return
      }
      if (req.method === "PATCH") {
        const body = await readJsonBody<CanvasUpdatePatch>(req)
        const canvas = await ctx.store.updateCanvas(canvasId, body)
        sendJson(res, 200, { ok: true, canvas })
        return
      }
      if (req.method === "DELETE") {
        await ctx.store.deleteCanvas(canvasId)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    // ── /api/editor/canvases/:id/{frames|edges|annotations}[/:childId] ──
    // Codex round-1: reject extra trailing segments. Without this,
    //   DELETE /canvases/:id/frames/:frameId/anything
    // dispatches to the same handler as the well-formed URL, because
    // `[canvasId, kind, childId]` ignores segments[3+].
    if (segments.length > 3) {
      sendJson(res, 404, {
        ok: false,
        reason: `Unknown canvas route: ${subpath}`,
      })
      return
    }
    if (kind === "frames") {
      await handleFramesRoute(req, res, ctx, canvasId, childId)
      return
    }
    if (kind === "edges") {
      await handleEdgesRoute(req, res, ctx, canvasId, childId)
      return
    }
    if (kind === "annotations") {
      await handleAnnotationsRoute(req, res, ctx, canvasId, childId)
      return
    }

    sendJson(res, 404, { ok: false, reason: `Unknown canvas route: ${subpath}` })
  })
}

async function handleFramesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CanvasesHandlerContext,
  canvasId: string,
  frameId: string | undefined,
): Promise<void> {
  if (!frameId) {
    if (req.method === "GET") {
      const frames = await ctx.store.listFrames(canvasId)
      sendJson(res, 200, { ok: true, frames })
      return
    }
    if (req.method === "POST") {
      const body = await readJsonBody<CanvasFrameCreateInput>(req, { maxBytes: FRAME_BODY_MAX_BYTES })
      const validation = validateFrameCreate(body)
      if (validation) {
        sendJson(res, 400, { ok: false, reason: validation })
        return
      }
      const frame = await ctx.store.createFrame(canvasId, body)
      sendJson(res, 201, { ok: true, frame })
      return
    }
    sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
    return
  }

  if (req.method === "PATCH") {
    const body = await readJsonBody<CanvasFrameUpdatePatch>(req, { maxBytes: FRAME_BODY_MAX_BYTES })
    const frame = await ctx.store.updateFrame(canvasId, frameId, body)
    sendJson(res, 200, { ok: true, frame })
    return
  }
  if (req.method === "DELETE") {
    await ctx.store.deleteFrame(canvasId, frameId)
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
}

async function handleEdgesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CanvasesHandlerContext,
  canvasId: string,
  edgeId: string | undefined,
): Promise<void> {
  if (!edgeId) {
    if (req.method === "GET") {
      const edges = await ctx.store.listEdges(canvasId)
      sendJson(res, 200, { ok: true, edges })
      return
    }
    if (req.method === "POST") {
      const body = await readJsonBody<CanvasEdgeCreateInput>(req)
      if (!body.sourceFrameId || !body.targetFrameId) {
        sendJson(res, 400, {
          ok: false,
          reason: "Missing required fields: sourceFrameId, targetFrameId",
        })
        return
      }
      const edge = await ctx.store.createEdge(canvasId, body)
      sendJson(res, 201, { ok: true, edge })
      return
    }
    sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
    return
  }

  if (req.method === "PATCH") {
    const body = await readJsonBody<CanvasEdgeUpdatePatch>(req)
    const edge = await ctx.store.updateEdge(canvasId, edgeId, body)
    sendJson(res, 200, { ok: true, edge })
    return
  }
  if (req.method === "DELETE") {
    await ctx.store.deleteEdge(canvasId, edgeId)
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
}

async function handleAnnotationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CanvasesHandlerContext,
  canvasId: string,
  annotationId: string | undefined,
): Promise<void> {
  if (!annotationId) {
    if (req.method === "GET") {
      const annotations = await ctx.store.listAnnotations(canvasId)
      sendJson(res, 200, { ok: true, annotations })
      return
    }
    if (req.method === "POST") {
      const body = await readJsonBody<CanvasAnnotationCreateInput>(req)
      const validation = validateAnnotationCreate(body)
      if (validation) {
        sendJson(res, 400, { ok: false, reason: validation })
        return
      }
      const annotation = await ctx.store.createAnnotation(canvasId, body)
      sendJson(res, 201, { ok: true, annotation })
      return
    }
    sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
    return
  }

  if (req.method === "PATCH") {
    const body = await readJsonBody<CanvasAnnotationUpdatePatch>(req)
    const annotation = await ctx.store.updateAnnotation(canvasId, annotationId, body)
    sendJson(res, 200, { ok: true, annotation })
    return
  }
  if (req.method === "DELETE") {
    await ctx.store.deleteAnnotation(canvasId, annotationId)
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
}

// ── Request-body validators ─────────────────────────────────────
//
// Lightweight structural checks at the handler boundary. The codex
// round-1 review flagged that prior checks like `!body.position`
// would let through `position: {}` (an object, but missing x/y). The
// validators below return a `string` reason on failure and `null` on
// success, mirroring the existing handler conventions.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function validateLayout(layout: unknown): string | null {
  if (!layout || typeof layout !== "object") return "layout must be an object"
  const l = layout as Record<string, unknown>
  if (!isFiniteNumber(l.x) || !isFiniteNumber(l.y)) {
    return "layout.x and layout.y must be finite numbers"
  }
  if (!isFiniteNumber(l.width) || !isFiniteNumber(l.height)) {
    return "layout.width and layout.height must be finite numbers"
  }
  if (l.width < 0 || l.height < 0) {
    return "layout.width and layout.height must be non-negative"
  }
  return null
}

function validateFrameCreate(body: CanvasFrameCreateInput): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object"
  if (typeof body.label !== "string" || body.label.length === 0) {
    return "label must be a non-empty string"
  }
  if (typeof body.capturedUrl !== "string" || body.capturedUrl.length === 0) {
    return "capturedUrl must be a non-empty string"
  }
  if (typeof body.baseUrl !== "string" || body.baseUrl.length === 0) {
    return "baseUrl must be a non-empty string"
  }
  const layoutErr = validateLayout(body.layout)
  if (layoutErr) return layoutErr
  return null
}

function validatePosition(position: unknown): string | null {
  if (!position || typeof position !== "object") return "position must be an object"
  const p = position as Record<string, unknown>
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
    return "position.x and position.y must be finite numbers"
  }
  return null
}

function validateSize(size: unknown): string | null {
  if (!size || typeof size !== "object") return "size must be an object"
  const s = size as Record<string, unknown>
  if (!isFiniteNumber(s.width) || !isFiniteNumber(s.height)) {
    return "size.width and size.height must be finite numbers"
  }
  if (s.width < 0 || s.height < 0) {
    return "size.width and size.height must be non-negative"
  }
  return null
}

function validateAnnotationCreate(body: CanvasAnnotationCreateInput): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object"
  if (body.kind !== "comment" && body.kind !== "text") {
    return 'kind must be "comment" or "text"'
  }
  if (typeof body.body !== "string") {
    return "body must be a string"
  }
  const positionErr = validatePosition(body.position)
  if (positionErr) return positionErr
  const sizeErr = validateSize(body.size)
  if (sizeErr) return sizeErr
  return null
}
