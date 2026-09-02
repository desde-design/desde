/**
 * Review-surface factory for editor-cli.
 *
 * Creates the per-turn {@link ReviewSurface} the chat agent drives for its
 * view+drive operations (navigate / interact / capture / verify reads). One
 * surface is created per chat turn and disposed when the turn ends; the Chromium
 * process is launched LAZILY (only if the agent actually calls a view/drive
 * tool), so a turn that never screenshots pays nothing. Per-turn lifecycle keeps
 * concurrent chat sessions from fighting over one headless page and avoids any
 * cross-turn leak.
 *
 * Escape hatch (NOT a dark launch — the surface is the default): set
 * `EDITOR_REVIEW_SURFACE=bridge` (or `off`/`0`) to force the agent back onto
 * the bridge → user's live iframe, the prior behavior.
 */

import type { ReviewSurface } from "../../../src/editor/core/review-surface.js"

import {
  launchReviewBrowser,
  PlaywrightReviewSurface,
  type PlaywrightReviewSurfaceOptions,
} from "./playwright-review-surface.js"

export { PlaywrightReviewSurface, type PlaywrightReviewSurfaceOptions }

/** Whether the isolated review surface is enabled (default true). */
export function isReviewSurfaceEnabled(): boolean {
  const v = (process.env.EDITOR_REVIEW_SURFACE ?? "").trim().toLowerCase()
  return v !== "bridge" && v !== "off" && v !== "0" && v !== "false"
}

/**
 * Memoized one-time check: is the isolated surface usable in this process?
 * Returns false (no probe) when disabled via env; otherwise tries to launch +
 * close a headless browser ONCE and caches the result. Lets the caller skip
 * surface creation — and transparently keep the bridge path — in environments
 * with no system Chrome AND no installed Playwright browsers, instead of failing
 * the agent's first navigate/capture/get_page_info with a launch error.
 */
let launchableMemo: boolean | undefined
export async function canLaunchReviewSurface(
  opts: { chromeExecutablePath?: string } = {},
): Promise<boolean> {
  if (!isReviewSurfaceEnabled()) return false
  if (launchableMemo !== undefined) return launchableMemo
  try {
    const b = await launchReviewBrowser(opts)
    await b.close()
    launchableMemo = true
  } catch (err) {
    console.warn(
      `[editor-cli] isolated review surface unavailable (no launchable browser): ${
        (err as Error).message
      }. Agent self-review will use the live iframe via the bridge.`,
    )
    launchableMemo = false
  }
  return launchableMemo
}

/** Test hook: reset the memoized launch probe between tests. */
export function __resetReviewSurfaceLaunchMemoForTest(): void {
  launchableMemo = undefined
}

/**
 * Create a review surface for one chat turn, or `null` when disabled / no
 * prototype URL is known (→ the agent falls back to the bridge). The caller
 * passes it to the SDK runtime and MUST `dispose()` it when the turn ends.
 */
export function createReviewSurface(
  opts: PlaywrightReviewSurfaceOptions,
): ReviewSurface | null {
  if (!isReviewSurfaceEnabled()) return null
  if (!opts.viteUrl) return null
  return new PlaywrightReviewSurface(opts)
}
