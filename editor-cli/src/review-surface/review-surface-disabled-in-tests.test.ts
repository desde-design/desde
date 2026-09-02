/**
 * The default `npm test` suite must never launch a real browser.
 *
 * `vitest.config.ts` already excluded `src/__smoke__/` for that reason, but
 * the exclusion was defeated from inside the product: the mini-turn edit lane
 * calls `createReviewSurface()`, which probes by launching and closing a
 * headless Chromium and then launches a second one. Any test reaching that
 * lane with a truthy `viteUrl` paid for both, pointed at a dev server that was
 * never running.
 *
 * MEASURED: 1.4s for that pair on an idle machine, 26s under the full parallel
 * suite. `http-server-mini-turn-lock.integration.test.ts` has a 30s budget, so
 * it passed alone and timed out in the full run.
 *
 * This test pins the `EDITOR_REVIEW_SURFACE=off` entry in `vitest.config.ts`.
 * Deleting that entry brings the browser launches back, and the only symptom
 * would be an unrelated-looking timeout in a different file.
 */
import { describe, expect, it } from "vitest"
import { canLaunchReviewSurface, isReviewSurfaceEnabled } from "./index.js"

describe("review surface is disabled for the test suite", () => {
  it("reads the off switch from vitest.config.ts", () => {
    expect(process.env.EDITOR_REVIEW_SURFACE).toBe("off")
    expect(isReviewSurfaceEnabled()).toBe(false)
  })

  it("refuses to launch without probing, so no browser starts", async () => {
    // The probe is what launches Chromium, and the flag check sits ahead of
    // it. Deliberately NOT asserted with a stopwatch: a wall-clock budget is
    // what made the original failure look like a port race, and any budget
    // loose enough to survive a loaded machine is also loose enough to let a
    // 1.4s launch through.
    await expect(canLaunchReviewSurface()).resolves.toBe(false)
  })
})
