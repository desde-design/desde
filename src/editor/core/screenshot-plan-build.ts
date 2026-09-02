/**
 * Pure builders for screenshot plans (see `tasks/editor-screenshot-flows.md`).
 * Framework- and design-system-neutral — no imports beyond the plan types.
 *
 * `buildRouteEnumerationPlan` turns an enumerated route list (produced by a
 * `RouteEnumerator`, e.g. the Vue impl `enumerateVueRoutes`) into a
 * `navigate → capture(viewport)` plan: one screenshot per page, no interaction,
 * zero LLM. This is the "snapshot all my screens" baseline (Phase 1).
 */

import type { EnumeratedRoute } from "./route-scaffold"
import type { ScreenshotPlan, ScreenshotPlanStep } from "./screenshot-plan"

/** A plan that hasn't been persisted yet — the store assigns `id`/`createdAt`. */
export type UnsavedScreenshotPlan = Omit<ScreenshotPlan, "id" | "createdAt">

export interface RouteEnumerationPlanInput {
  /** Display name for the plan (e.g. "All screens"). */
  name: string
  /** The live prototype base URL the plan replays against. */
  baseUrl: string
  /** Statically-navigable routes to snapshot, in order. */
  routes: EnumeratedRoute[]
}

/** Human label for a route — its `name`, else the path (root shown as "/"). */
function routeLabel(route: EnumeratedRoute): string {
  return route.name?.trim() || route.path
}

/**
 * Build a `navigate → capture(viewport)` plan, one pair per route. Pure; the
 * result is a valid `ScreenshotPlan` minus the store-assigned `id`/`createdAt`
 * (it passes `validateScreenshotPlan`).
 */
export function buildRouteEnumerationPlan(
  input: RouteEnumerationPlanInput,
): UnsavedScreenshotPlan {
  const steps: ScreenshotPlanStep[] = []
  for (const route of input.routes) {
    const label = routeLabel(route)
    steps.push({
      intent: `Navigate to ${label}`,
      kind: "navigate",
      route: route.path,
    })
    steps.push({
      intent: `Capture ${label}`,
      kind: "capture",
      capture: { scope: "viewport", label },
    })
  }

  return {
    name: input.name,
    baseUrl: input.baseUrl,
    source: "route-enumeration",
    steps,
  }
}
