import type { FlowScreenshot } from "../../../types/bridge"
import type { ScreenshotPlan, ScreenshotPlanStep } from "../screenshot-plan"

/**
 * Storage interface for durable screenshot plans (see
 * `tasks/editor-screenshot-flows.md`). Mirrors `FlowStore`: plan metadata
 * and screenshot blobs are persisted separately because screenshots are
 * large.
 *
 * Unlike `FlowStore` (one `flows.json` array), each plan is stored as its
 * own file at `.desde/screenshot-plans/<id>.json` — the spec's "data
 * plan" the replay engine interprets. Screenshots reuse the existing
 * `FlowScreenshot` blob shape, keyed by the index of the `capture` step
 * that produced them.
 */
export interface ScreenshotPlanStore {
  list(): Promise<ScreenshotPlan[]>
  get(id: string): Promise<ScreenshotPlan | null>
  create(input: ScreenshotPlanCreateInput): Promise<ScreenshotPlan>
  update(id: string, patch: ScreenshotPlanUpdatePatch): Promise<ScreenshotPlan>
  delete(id: string): Promise<void>

  /** Persist screenshots for a plan. Replaces existing screenshots. */
  saveScreenshots(planId: string, screenshots: FlowScreenshot[]): Promise<void>
  /** Read screenshots for a plan. Empty array if none persisted. */
  getScreenshots(planId: string): Promise<FlowScreenshot[]>
}

export interface ScreenshotPlanCreateInput {
  name: string
  baseUrl: string
  source: ScreenshotPlan["source"]
  prompt?: string
  steps: ScreenshotPlanStep[]
}

export interface ScreenshotPlanUpdatePatch {
  name?: string
  steps?: ScreenshotPlanStep[]
  prompt?: string
}
