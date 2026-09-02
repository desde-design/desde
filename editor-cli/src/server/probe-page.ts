/**
 * `createProbePage` — the CLI's concrete `ProbePage` for the Phase 4
 * "rendering hints at scale" probe driver
 * (`src/editor/hints/probe-driver.ts`).
 *
 * A dedicated, isolated headless browser page used ONLY to mount
 * design-system components at the compose-isolation route
 * (`/__compose/component/...`, served by `composeIsolationPlugin` — see
 * `vite-supervisor.ts`'s plugin registration) for hint generation. It never
 * touches the user's live iframe and is never shared with the
 * `PlaywrightReviewSurface`'s own browser — separate lifecycles, separate
 * concerns: the review surface drives verification against the user's
 * actual running prototype; this drives isolated, throwaway component
 * mounts purely to observe where sentinel prop/slot values render.
 *
 * Reuses `launchReviewBrowser` (Chrome-first launch strategy, bundled
 * Chromium fallback) and `gotoSettled` (bounded-settle navigation — never
 * `networkidle`, which a Vite HMR socket keeps from ever resolving) from
 * `playwright-review-surface.ts` rather than re-deriving them.
 *
 * Lifecycle is the CALLER's responsibility (Task 3's
 * `generate-hints-run.ts`): open ONE probe page per design-system run
 * (concurrency 1 — sequential mounts across all of that system's
 * components), probe every component against it, then `close()` once at
 * the end. `probeComponent` (`probe-driver.ts`) never calls `close()`
 * itself — browser lifecycle is deliberately kept out of that module.
 */

import { launchReviewBrowser, gotoSettled } from "../review-surface/playwright-review-surface.js"
import type { ProbePage } from "../../../src/editor/hints/probe-driver.js"

export interface CreateProbePageOptions {
  /** Explicit Chrome binary; otherwise channel:chrome → bundled chromium (same order `launchReviewBrowser` uses). */
  chromeExecutablePath?: string
  /** Viewport width. Defaults to 1280 — isolation pages don't need to match the user's viewport. */
  viewportWidth?: number
  /** Viewport height. Defaults to 800. */
  viewportHeight?: number
}

/**
 * Boots a fresh headless browser + context + page implementing `ProbePage`.
 * Throws if no browser can launch (no system Chrome AND no installed
 * Playwright browsers) — the caller (Task 3's generate-hints run) should
 * treat that as "hint generation unavailable," not crash the CLI.
 */
export async function createProbePage(opts: CreateProbePageOptions = {}): Promise<ProbePage> {
  const browser = await launchReviewBrowser({ chromeExecutablePath: opts.chromeExecutablePath })
  const context = await browser.newContext({
    viewport: {
      width: opts.viewportWidth ?? 1280,
      height: opts.viewportHeight ?? 800,
    },
    deviceScaleFactor: 1,
  })
  // Mirrors the review surface's own init script: the CLI runs this TS
  // source under tsx (esbuild), which can rewrite named inner declarations
  // into `__name(fn, "name")` calls that exist in the Node module scope but
  // NOT in the browser page the closure/string is evaluated in. A harmless
  // identity shim neutralizes it regardless of whether any of this file's
  // (or the probe driver's) specific evaluate strings actually need it.
  await context.addInitScript(
    "globalThis.__name = globalThis.__name || function (f) { return f };",
  )
  const page = await context.newPage()

  let closed = false

  return {
    async goto(url: string): Promise<void> {
      await gotoSettled(page, url)
    },
    async evaluate<T>(fn: string): Promise<T> {
      return page.evaluate<T>(fn)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}
