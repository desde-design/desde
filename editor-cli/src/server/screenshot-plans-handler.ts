/**
 * HTTP handlers for Screenshot Plans CRUD + route-enumeration
 * (tasks/editor-screenshot-flows.md Phase 1). Mirrors the artifact-handler pattern (comments/notes);
 * each plan is one file under `.desde/screenshot-plans/`.
 *
 * Routes:
 *   GET    /api/editor/screenshot-plans                     — list (no screenshots)
 *   POST   /api/editor/screenshot-plans                     — create
 *   POST   /api/editor/screenshot-plans/route-enumeration   — enumerate routes → build + persist a plan
 *   GET    /api/editor/screenshot-plans/:id                 — get one
 *   PATCH  /api/editor/screenshot-plans/:id                 — update
 *   DELETE /api/editor/screenshot-plans/:id                 — delete
 *   GET    /api/editor/screenshot-plans/:id/screenshots     — get screenshots
 *   POST   /api/editor/screenshot-plans/:id/screenshots     — replace screenshots
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { FlowScreenshot } from "../../../src/types/bridge"
import type {
  ScreenshotPlan,
  ScreenshotPlanCreateInput,
  ScreenshotPlanStore,
  ScreenshotPlanUpdatePatch,
} from "../../../src/editor/core"
import {
  buildRouteEnumerationPlan,
  validateScreenshotPlan,
} from "../../../src/editor/core"
import { enumerateVueRoutes } from "../../../src/editor/edit-service/scaffold-vue-route"
import { enumerateReactRoutes } from "../../../src/editor/edit-service/scaffold-react-route"
import { locateRouterFile } from "../../../src/editor/agent-tools/locate-router-file"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"

const ROUTE_PREFIX = "/api/editor/screenshot-plans"

/** Action sub-route handled before the generic `:id` CRUD branch. */
const ENUMERATION_SEGMENT = "route-enumeration"

/** Same generous cap as flows: 4K screenshots are multi-MB base64. */
const SCREENSHOTS_BODY_MAX_BYTES = 50 * 1024 * 1024

export interface ScreenshotPlansHandlerContext {
  store: ScreenshotPlanStore
  /** Active worktree root — used to locate the prototype's router file. */
  repoRoot: string
  /**
   * Detected framework of the supervised prototype. Selects the
   * route-enumeration action's router parser AND the router-file probe:
   * `enumerateVueRoutes` + the Vue candidate list for `vue3`,
   * `enumerateReactRoutes` + the React candidate list for `react` — so a
   * React prototype is enumerated with a React-Router-aware parser rather
   * than running the Vue parser against React-Router source (which would
   * error confusingly or silently find nothing). Defaults to `vue3` when
   * unset (back-compat).
   */
  framework?: "vue3" | "react"
}

export function matchesScreenshotPlansRoute(pathname: string): boolean {
  return pathname === ROUTE_PREFIX || pathname.startsWith(`${ROUTE_PREFIX}/`)
}

/** Validate a create/enumeration plan input. Returns a reason string on failure. */
function planInputError(input: ScreenshotPlanCreateInput): string | null {
  if (!input.name || !input.baseUrl || !input.source || !input.steps) {
    return "Missing required fields: name, baseUrl, source, steps"
  }
  // Stronger than the required-field check: vet the full step shape so a
  // malformed plan can't be persisted (it would crash replay later).
  const check = validateScreenshotPlan({
    ...input,
    id: "pending",
    createdAt: "pending",
  })
  if (!check.valid) return `Invalid plan: ${check.errors.join("; ")}`
  return null
}

export async function handleScreenshotPlansRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ScreenshotPlansHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const subpath = url.pathname.slice(ROUTE_PREFIX.length)

  await runHandler(res, async () => {
    if (subpath === "" || subpath === "/") {
      if (req.method === "GET") {
        const all = await ctx.store.list()
        sendJson(res, 200, { ok: true, plans: all })
        return
      }
      if (req.method === "POST") {
        const body = await readJsonBody<ScreenshotPlanCreateInput>(req)
        const err = planInputError(body)
        if (err) {
          sendJson(res, 400, { ok: false, reason: err })
          return
        }
        const plan = await ctx.store.create(body)
        sendJson(res, 201, { ok: true, plan })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    const segments = subpath.split("/").filter(Boolean)
    const [id, sub] = segments

    // ── Route-enumeration action — intercept BEFORE generic `:id` CRUD ──────
    if (segments.length === 1 && id === ENUMERATION_SEGMENT) {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
        return
      }
      // Framework-keyed dispatch: locate + parse the router config with the
      // matching per-framework probe/enumerator. Defaults to vue3 (back-compat).
      const framework = ctx.framework === "react" ? "react" : "vue3"
      const enumerateRoutes = framework === "react" ? enumerateReactRoutes : enumerateVueRoutes

      const body = await readJsonBody<{
        name?: string
        baseUrl?: string
        routerFile?: string
      }>(req)
      if (!body.baseUrl) {
        sendJson(res, 400, { ok: false, reason: "Missing required field: baseUrl" })
        return
      }
      const located = await locateRouterFile(ctx.repoRoot, body.routerFile, framework)
      if (!located.ok) {
        sendJson(res, 422, { ok: false, reason: located.reason })
        return
      }
      const result = enumerateRoutes({
        routerSource: located.source,
        routerFile: located.repoRel,
      })
      if (!result.ok) {
        sendJson(res, 422, { ok: false, reason: result.reason })
        return
      }
      const routes = result.routes ?? []
      if (routes.length === 0) {
        sendJson(res, 422, {
          ok: false,
          reason: "No statically-navigable routes found in the router.",
          skipped: result.skipped ?? [],
        })
        return
      }
      const unsaved = buildRouteEnumerationPlan({
        name: body.name?.trim() || "All screens",
        baseUrl: body.baseUrl,
        routes,
      })
      const plan = await ctx.store.create(unsaved)
      sendJson(res, 201, { ok: true, plan, skipped: result.skipped ?? [] })
      return
    }

    if (segments.length === 1) {
      if (req.method === "GET") {
        const plan = await ctx.store.get(id)
        if (!plan) {
          sendJson(res, 404, { ok: false, reason: `Screenshot plan ${id} not found` })
          return
        }
        sendJson(res, 200, { ok: true, plan })
        return
      }
      if (req.method === "PATCH") {
        const body = await readJsonBody<ScreenshotPlanUpdatePatch>(req)
        const existing = await ctx.store.get(id)
        if (!existing) {
          sendJson(res, 404, { ok: false, reason: `Screenshot plan ${id} not found` })
          return
        }
        // Validate the MERGED plan so a PATCH can't persist a malformed plan
        // the create path would reject (e.g. a capture step missing its spec) —
        // replay + canvas consumers assume stored plans are valid. Mirrors
        // store.update's merge.
        const merged: ScreenshotPlan = {
          ...existing,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.steps !== undefined ? { steps: body.steps } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        }
        const check = validateScreenshotPlan(merged)
        if (!check.valid) {
          sendJson(res, 400, {
            ok: false,
            reason: `Invalid plan: ${check.errors.join("; ")}`,
          })
          return
        }
        const plan = await ctx.store.update(id, body)
        sendJson(res, 200, { ok: true, plan })
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

    if (segments.length === 2 && sub === "screenshots") {
      // Both GET and POST require the parent plan to exist — otherwise
      // saveScreenshots would orphan a directory, and GET would return []
      // indistinguishably from "no screenshots yet" (handler convention).
      const parent = await ctx.store.get(id)
      if (!parent) {
        sendJson(res, 404, { ok: false, reason: `Screenshot plan ${id} not found` })
        return
      }
      if (req.method === "GET") {
        const screenshots = await ctx.store.getScreenshots(id)
        sendJson(res, 200, { ok: true, screenshots })
        return
      }
      if (req.method === "POST") {
        const body = await readJsonBody<{ screenshots: FlowScreenshot[] }>(req, {
          maxBytes: SCREENSHOTS_BODY_MAX_BYTES,
        })
        if (!Array.isArray(body.screenshots)) {
          sendJson(res, 400, {
            ok: false,
            reason: "Missing required field: screenshots (array)",
          })
          return
        }
        await ctx.store.saveScreenshots(id, body.screenshots)
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 405, { ok: false, reason: `Method ${req.method} not allowed` })
      return
    }

    sendJson(res, 404, { ok: false, reason: `Unknown screenshot-plans route: ${subpath}` })
  })
}
