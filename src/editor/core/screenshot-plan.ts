/**
 * Screenshot-plan data model — the durable, semantic plan that replaces
 * low-level step replay (see `tasks/editor-screenshot-flows.md`).
 *
 * A plan is produced once (by the agent Planner or route-enumeration) and
 * then replayed cheaply and deterministically: navigate → resolve a
 * semantic target → act → capture. A target that fails to resolve escalates
 * a single step to the agent to self-heal, which rewrites the cached
 * selector back into the plan.
 *
 * These types are **framework- and design-system-neutral** — no Vue / React
 * / xyflow imports. The semantic target is an accessibility-tree locator
 * (role + accessible-name, visible-text fallback), borrowed from
 * Playwright's resilient-locator doctrine, not a CSS path. The canvas
 * adapter that turns a REPLAYED plan (plan + captured screenshots) into
 * React Flow nodes lives outside core (`src/utils/canvas-screenshot-plan.ts`).
 */

/**
 * A resilient, framework-neutral pointer to a live element. Resolved at
 * replay time against the accessibility tree; `resolvedSelector` caches the
 * last-known-good CSS selector so deterministic replay can skip re-resolution
 * until it misses (heal rewrites it).
 */
export interface SemanticTarget {
  /** ARIA role, e.g. "button". */
  role?: string
  /** Accessible name, e.g. "Create model". */
  name?: string
  /** Visible-text fallback. */
  text?: string
  /** Human/NL intent — what the agent re-resolves against on heal. */
  description: string
  /** Last-known-good CSS selector (replay cache; heal rewrites it). */
  resolvedSelector?: string
}

export type ScreenshotPlanStepKind = "navigate" | "interact" | "capture"
export type ScreenshotPlanAction = "click" | "fill" | "select"
export type ScreenshotCaptureScope = "viewport" | "selector"

export interface ScreenshotCapture {
  scope: ScreenshotCaptureScope
  /** Required when `scope === "selector"`. */
  selector?: string
  label: string
}

export interface ScreenshotPlanStep {
  /** NL description of the step. */
  intent: string
  kind: ScreenshotPlanStepKind
  /** kind=navigate — pathname + optional hash. */
  route?: string
  /** kind=interact. */
  action?: ScreenshotPlanAction
  /** kind=interact. */
  target?: SemanticTarget
  /** kind=interact (fill / select). */
  value?: string
  /** kind=capture. */
  capture?: ScreenshotCapture
}

export type ScreenshotPlanSource =
  | "prompt"
  | "route-enumeration"

export interface ScreenshotPlan {
  id: string
  name: string
  baseUrl: string
  source: ScreenshotPlanSource
  /** Original NL description (source=prompt). */
  prompt?: string
  steps: ScreenshotPlanStep[]
  createdAt: string
}

const VALID_SOURCES: ReadonlySet<string> = new Set<ScreenshotPlanSource>([
  "prompt",
  "route-enumeration",
])
const VALID_ACTIONS: ReadonlySet<string> = new Set<ScreenshotPlanAction>([
  "click",
  "fill",
  "select",
])
const VALID_SCOPES: ReadonlySet<string> = new Set<ScreenshotCaptureScope>([
  "viewport",
  "selector",
])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0
}

export interface PlanValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate the shape of a screenshot plan. Pure — no I/O, no imports beyond
 * this module. Used as a guard before persistence and before replay so a
 * malformed plan fails loudly instead of crashing the replay engine.
 *
 * Accepts `unknown` so it can also vet plans read off disk or returned by
 * the agent Planner.
 */
export function validateScreenshotPlan(plan: unknown): PlanValidationResult {
  const errors: string[] = []

  if (typeof plan !== "object" || plan === null) {
    return { valid: false, errors: ["plan must be an object"] }
  }
  const p = plan as Record<string, unknown>

  if (!isNonEmptyString(p.id)) errors.push("id must be a non-empty string")
  if (!isNonEmptyString(p.name)) errors.push("name must be a non-empty string")
  if (!isNonEmptyString(p.baseUrl)) {
    errors.push("baseUrl must be a non-empty string")
  }
  if (!isNonEmptyString(p.createdAt)) {
    errors.push("createdAt must be a non-empty string")
  }
  if (typeof p.source !== "string" || !VALID_SOURCES.has(p.source)) {
    errors.push(
      `source must be one of ${[...VALID_SOURCES].join(", ")}`,
    )
  }

  if (!Array.isArray(p.steps)) {
    errors.push("steps must be an array")
    return { valid: errors.length === 0, errors }
  }

  p.steps.forEach((rawStep, i) => {
    const where = `steps[${i}]`
    if (typeof rawStep !== "object" || rawStep === null) {
      errors.push(`${where} must be an object`)
      return
    }
    const step = rawStep as Record<string, unknown>

    if (!isNonEmptyString(step.intent)) {
      errors.push(`${where}.intent must be a non-empty string`)
    }

    switch (step.kind) {
      case "navigate":
        if (!isNonEmptyString(step.route)) {
          errors.push(`${where}.route is required for kind=navigate`)
        }
        break
      case "interact":
        if (typeof step.action !== "string" || !VALID_ACTIONS.has(step.action)) {
          errors.push(
            `${where}.action must be one of ${[...VALID_ACTIONS].join(", ")}`,
          )
        }
        if (
          typeof step.target !== "object" ||
          step.target === null ||
          !isNonEmptyString((step.target as Record<string, unknown>).description)
        ) {
          errors.push(
            `${where}.target with a non-empty description is required for kind=interact`,
          )
        }
        if (
          (step.action === "fill" || step.action === "select") &&
          typeof step.value !== "string"
        ) {
          errors.push(`${where}.value is required for action=${step.action}`)
        }
        break
      case "capture": {
        const cap = step.capture
        if (typeof cap !== "object" || cap === null) {
          errors.push(`${where}.capture is required for kind=capture`)
          break
        }
        const c = cap as Record<string, unknown>
        if (typeof c.scope !== "string" || !VALID_SCOPES.has(c.scope)) {
          errors.push(
            `${where}.capture.scope must be one of ${[...VALID_SCOPES].join(", ")}`,
          )
        }
        if (!isNonEmptyString(c.label)) {
          errors.push(`${where}.capture.label must be a non-empty string`)
        }
        if (c.scope === "selector" && !isNonEmptyString(c.selector)) {
          errors.push(
            `${where}.capture.selector is required when scope=selector`,
          )
        }
        break
      }
      default:
        errors.push(
          `${where}.kind must be one of navigate, interact, capture`,
        )
    }
  })

  return { valid: errors.length === 0, errors }
}
