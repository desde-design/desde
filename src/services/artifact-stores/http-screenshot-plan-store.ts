/**
 * HTTP client for the CLI's `/api/editor/screenshot-plans` routes
 * (tasks/editor-screenshot-flows.md Phase 1). Mirrors http-flow-store.ts.
 *
 * Beyond the canonical `ScreenshotPlanStore` CRUD, it adds `createFromRoutes`
 * — the route-enumeration endpoint that reads the prototype's router, builds a
 * `navigate → capture(viewport)` plan, persists it, and returns the plan plus
 * any routes intentionally skipped (dynamic / catch-all / redirect-only).
 */

import type { FlowScreenshot } from "@/types/bridge"
import type {
  ScreenshotPlan,
  ScreenshotPlanCreateInput,
  ScreenshotPlanStore,
  ScreenshotPlanUpdatePatch,
  SkippedRoute,
} from "@/editor/core"
import {
  artifactFetch,
  assertSafeId,
  isArray,
  isMissingArtifactError,
  isObject,
  requireField,
} from "./shared"

const ROUTE = "/api/editor/screenshot-plans"

const isPlan = (v: unknown): v is ScreenshotPlan => isObject(v)
const isPlanArray = (v: unknown): v is ScreenshotPlan[] =>
  isArray(v) && v.every(isPlan)

const isScreenshot = (v: unknown): v is FlowScreenshot => isObject(v)
const isScreenshotArray = (v: unknown): v is FlowScreenshot[] =>
  isArray(v) && v.every(isScreenshot)

export interface CreateFromRoutesInput {
  /** Display name for the plan. Defaults server-side to "All screens". */
  name?: string
  /** The live prototype base URL the plan replays against. */
  baseUrl: string
  /** Optional explicit router file (repo-relative); auto-detected otherwise. */
  routerFile?: string
}

export interface CreateFromRoutesResult {
  plan: ScreenshotPlan
  skipped: SkippedRoute[]
}

/** The flow store interface plus the route-enumeration convenience method. */
export interface HttpScreenshotPlanStore extends ScreenshotPlanStore {
  createFromRoutes(input: CreateFromRoutesInput): Promise<CreateFromRoutesResult>
}

export function createHttpScreenshotPlanStore(): HttpScreenshotPlanStore {
  return {
    async list() {
      const resp = await artifactFetch<unknown>(ROUTE)
      return requireField<ScreenshotPlan[]>(resp, "plans", isPlanArray)
    },
    async get(id) {
      assertSafeId(id, "planId")
      try {
        const resp = await artifactFetch<unknown>(`${ROUTE}/${encodeURIComponent(id)}`)
        return requireField<ScreenshotPlan>(resp, "plan", isPlan)
      } catch (err) {
        if (isMissingArtifactError(err)) return null
        throw err
      }
    },
    async create(input: ScreenshotPlanCreateInput) {
      const resp = await artifactFetch<unknown>(ROUTE, {
        method: "POST",
        body: input,
      })
      return requireField<ScreenshotPlan>(resp, "plan", isPlan)
    },
    async createFromRoutes(input: CreateFromRoutesInput) {
      const resp = await artifactFetch<unknown>(`${ROUTE}/route-enumeration`, {
        method: "POST",
        body: input,
      })
      const plan = requireField<ScreenshotPlan>(resp, "plan", isPlan)
      const skipped =
        isObject(resp) && isArray((resp as Record<string, unknown>).skipped)
          ? ((resp as Record<string, unknown>).skipped as SkippedRoute[])
          : []
      return { plan, skipped }
    },
    async update(id: string, patch: ScreenshotPlanUpdatePatch) {
      assertSafeId(id, "planId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(id)}`,
        { method: "PATCH", body: patch },
      )
      return requireField<ScreenshotPlan>(resp, "plan", isPlan)
    },
    async delete(id: string) {
      assertSafeId(id, "planId")
      await artifactFetch(`${ROUTE}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    },
    async saveScreenshots(planId: string, screenshots: FlowScreenshot[]) {
      assertSafeId(planId, "planId")
      await artifactFetch(
        `${ROUTE}/${encodeURIComponent(planId)}/screenshots`,
        { method: "POST", body: { screenshots } },
      )
    },
    async getScreenshots(planId: string) {
      assertSafeId(planId, "planId")
      const resp = await artifactFetch<unknown>(
        `${ROUTE}/${encodeURIComponent(planId)}/screenshots`,
      )
      return requireField<FlowScreenshot[]>(resp, "screenshots", isScreenshotArray)
    },
  }
}
