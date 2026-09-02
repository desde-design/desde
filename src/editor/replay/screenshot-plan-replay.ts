/**
 * Deterministic screenshot-plan replay (tasks/editor-screenshot-flows.md
 * Phase 1b). Walks a plan's steps and produces one screenshot per `capture`
 * step — **no LLM, no agent**. The two side-effecting primitives (navigate the
 * prototype, capture a screenshot) are injected, so this module is pure and
 * unit-testable with stubs; the real impls live in the React shell
 * (editor-surface) where the iframe + bridge are.
 *
 * Framework-neutral: it imports only the plan + screenshot types.
 */

import type { FlowScreenshot } from "../../types/bridge"
import type {
  ScreenshotCapture,
  ScreenshotPlan,
  ScreenshotPlanStep,
} from "../core/screenshot-plan"

/** Drive the prototype to a route. Resolves once the page has settled. */
export type ReplayNavigate = (
  route: string,
  signal: AbortSignal,
) => Promise<{ ok: boolean; error?: string }>

/**
 * Capture for a `capture` step. `spec` carries the step's scope/selector so a
 * `scope: "selector"` step screenshots that element, not the whole viewport.
 * Resolves null on failure/timeout/abort.
 */
export type ReplayCapture = (
  spec: ScreenshotCapture,
  signal: AbortSignal,
) => Promise<{ dataUrl: string; width: number; height: number } | null>

/**
 * Resolve + perform an `interact` step (Phase 2). Resolves the step's semantic
 * target to a live element and acts (click/fill/select). `needsHeal` signals a
 * target MISS — deterministic replay can't proceed, so the loop stops and the
 * step is surfaced for the Phase-4 healer. `resolvedSelector` is the
 * last-known-good selector to write back into the plan (Phase 4).
 */
export type ReplayInteract = (
  step: ScreenshotPlanStep,
  signal: AbortSignal,
) => Promise<{
  ok: boolean
  needsHeal?: boolean
  resolvedSelector?: string
  error?: string
}>

export interface ReplayStepError {
  /** Index of the offending step in `plan.steps`. */
  stepIndex: number
  message: string
}

/** A step that couldn't be resolved deterministically — for the Phase-4 healer. */
export interface ReplayNeedsHeal {
  stepIndex: number
  intent: string
}

export interface ScreenshotPlanReplayResult {
  /** One per successful `capture` step, keyed by that step's plan index. */
  screenshots: FlowScreenshot[]
  errors: ReplayStepError[]
  /** Set when an interact step's target missed — replay stopped here. */
  needsHeal?: ReplayNeedsHeal
  /** True if the run stopped early because the signal aborted. */
  aborted: boolean
}

/**
 * UI-facing replay callback the React shell exposes (editor-surface owns the
 * iframe + bridge primitives; the on-canvas "generate a flow" orchestration —
 * `onCanvasFlowTurnComplete` — calls this to capture real screenshots for a
 * plan the agent just saved). Distinct from {@link RunScreenshotPlanReplayOpts}
 * (which takes the injected lower-level navigate/capture fns) — this is the
 * high-level "replay this whole plan" entry.
 */
export type ReplayScreenshotPlan = (
  plan: ScreenshotPlan,
  opts?: {
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
  },
) => Promise<ScreenshotPlanReplayResult>

export interface RunScreenshotPlanReplayOpts {
  navigate: ReplayNavigate
  capture: ReplayCapture
  /** Resolve+act for `interact` steps. Omit for navigate-only plans (Phase 1). */
  interact?: ReplayInteract
  signal?: AbortSignal
  /** Called after each capture step is processed (success or not). */
  onProgress?: (done: number, total: number) => void
}

/**
 * Replay a plan deterministically: navigate to each route, capture the
 * viewport at each `capture` step. A capture is taken only if the most recent
 * navigate succeeded — otherwise we'd snapshot the wrong page, so it's skipped
 * and recorded as an error. `interact` steps are not produced by
 * route-enumeration plans (Phase 1); they're skipped here and handled by the
 * Phase-2 semantic replay engine.
 *
 * The returned `FlowScreenshot.stepIndex` is the **capture step's index in
 * `plan.steps`** — the same key `adaptPlanToFlow`/the store use, so the canvas
 * attaches each shot to the right node.
 */
export async function runScreenshotPlanReplay(
  plan: ScreenshotPlan,
  opts: RunScreenshotPlanReplayOpts,
): Promise<ScreenshotPlanReplayResult> {
  const { navigate, capture, interact, signal, onProgress } = opts
  const screenshots: FlowScreenshot[] = []
  const errors: ReplayStepError[] = []

  // Total = number of capture steps (what `onProgress` counts toward).
  const total = plan.steps.filter((s) => s.kind === "capture").length
  let done = 0

  // Tracks whether the most recent navigate succeeded, so a capture after a
  // failed navigate is skipped rather than snapshotting a stale/wrong page.
  let navigateOk = true

  const isAborted = (): boolean => signal?.aborted ?? false

  for (let i = 0; i < plan.steps.length; i++) {
    if (isAborted()) {
      return { screenshots, errors, aborted: true }
    }
    const step = plan.steps[i]

    if (step.kind === "navigate") {
      if (!step.route) {
        navigateOk = false
        errors.push({ stepIndex: i, message: "navigate step has no route" })
        continue
      }
      try {
        const res = await navigate(step.route, signal ?? new AbortController().signal)
        navigateOk = res.ok
        if (!res.ok) {
          errors.push({
            stepIndex: i,
            message: res.error ?? `navigation to ${step.route} failed`,
          })
        }
      } catch (err) {
        navigateOk = false
        errors.push({ stepIndex: i, message: (err as Error).message })
      }
      continue
    }

    if (step.kind === "capture") {
      if (!navigateOk) {
        errors.push({
          stepIndex: i,
          message: "skipped capture: the preceding navigation failed",
        })
        done++
        onProgress?.(done, total)
        continue
      }
      // Validated plans always carry a capture spec for kind=capture; fall
      // back to viewport defensively rather than crash on a malformed plan.
      const cap: ScreenshotCapture = step.capture ?? {
        scope: "viewport",
        label: step.intent || "capture",
      }
      try {
        const shot = await capture(cap, signal ?? new AbortController().signal)
        if (shot) {
          screenshots.push({
            stepIndex: i,
            dataUrl: shot.dataUrl,
            width: shot.width,
            height: shot.height,
          })
        } else {
          errors.push({ stepIndex: i, message: "capture failed or timed out" })
        }
      } catch (err) {
        errors.push({ stepIndex: i, message: (err as Error).message })
      }
      done++
      onProgress?.(done, total)
      continue
    }

    if (step.kind === "interact") {
      if (!interact) {
        // No resolver injected (e.g. a navigate-only run got an interact step).
        // A capture after an un-performed interaction would be wrong, so mark
        // the lane unsafe and keep going (the next navigate resets it).
        navigateOk = false
        errors.push({
          stepIndex: i,
          message: "interact step requires the semantic resolver (none injected)",
        })
        continue
      }
      try {
        const res = await interact(step, signal ?? new AbortController().signal)
        if (res.needsHeal) {
          // Target miss — deterministic replay can't continue. Stop and surface
          // the step for the Phase-4 healer (validate-before-write-back there).
          return { screenshots, errors, needsHeal: { stepIndex: i, intent: step.intent }, aborted: false }
        }
        if (!res.ok) {
          // A non-miss failure (e.g. the act threw) — stop, don't snapshot a
          // half-applied interaction.
          errors.push({ stepIndex: i, message: res.error ?? "interaction failed" })
          return { screenshots, errors, aborted: false }
        }
      } catch (err) {
        errors.push({ stepIndex: i, message: (err as Error).message })
        return { screenshots, errors, aborted: false }
      }
      continue
    }

    // Any future kind.
    errors.push({
      stepIndex: i,
      message: `step kind '${step.kind}' is not supported by deterministic replay`,
    })
  }

  return { screenshots, errors, aborted: isAborted() }
}
