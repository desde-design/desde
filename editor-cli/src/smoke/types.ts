/**
 * Framework-neutral smoke-test types.
 *
 * The smoke runner loads a *served* prototype in a real headless
 * browser, exercises one or more routes, and reports what broke. It is
 * the shared core behind both surfaces:
 *
 *   - the agent `verify` harness (tasks/scripts), and
 *   - the in-product post-save smoke test (Editor "Checks" tab).
 *
 * Nothing here is framework- or design-system-specific. Routes and selectors
 * are inputs; the checks (console errors, uncaught exceptions, network
 * failures, optional bridge-init, optional selector presence) hold for
 * any substrate. The one Desde-specific concept — the injected
 * bridge — is opt-in via `expectBridge` and never assumed.
 */

/** How long to wait for the page to settle before running checks. */
export type WaitUntil = "load" | "domcontentloaded" | "networkidle"

export interface SmokeRunOptions {
  /** Origin of the served prototype, e.g. `http://127.0.0.1:5173`. */
  baseUrl: string
  /**
   * Route paths appended to `baseUrl` (e.g. `"/"`, `"/models/create"`).
   * Defaults to `["/"]`. Substrate-neutral: the caller decides which
   * routes matter — nothing is hardcoded.
   */
  routes?: string[]
  /**
   * Assert the Desde bridge initialized on each route
   * (`window.__DESDE_BRIDGE_VERSION__` is set). Only meaningful
   * when the prototype is served *through* editor-cli, which injects
   * the bridge. Off by default so the runner stays generic.
   */
  expectBridge?: boolean
  /**
   * Optional CSS selector that must resolve on every route. Use it to
   * assert a just-edited element survived the change. Resolved with
   * `document.querySelector` in-page (no Playwright pseudo-classes).
   */
  expectSelector?: string
  /** Capture a full-page screenshot per route into `artifactsDir`. */
  screenshot?: boolean
  /**
   * Directory for screenshots + `report.json`. When unset, no files are
   * written and `screenshotPath` stays null (report is still returned).
   */
  artifactsDir?: string
  /** Per-route navigation timeout in ms. Default 15000. */
  timeoutMs?: number
  /** Navigation settle condition. Default `"networkidle"`. */
  waitUntil?: WaitUntil
  /**
   * Treat critical sub-resource failures (script/stylesheet/fetch/xhr/
   * document with status >= 400 or a hard request failure) as a route
   * failure. Default true — a failed JS chunk is real breakage. Images/
   * fonts/favicons never count toward `ok`.
   */
  failOnNetworkError?: boolean
  /**
   * Explicit Chrome/Chromium binary. When unset the runner uses the
   * installed Chrome via Playwright's `channel: "chrome"` (no 150 MB
   * download), falling back to bundled chromium.
   */
  chromeExecutablePath?: string
  /** Run headless. Default true. */
  headless?: boolean
  /**
   * Console-error / uncaught-exception messages matching any of these
   * substrings are dropped before they count toward `ok` (and before
   * they're recorded). Real prototypes emit benign noise (devtools
   * hints, third-party analytics) the caller knows to ignore. Match is
   * a plain case-insensitive substring test.
   */
  ignoreConsolePatterns?: string[]
}

export interface FailedRequest {
  url: string
  /** Resource kind per Playwright (`script`, `stylesheet`, `image`, …). */
  resourceType: string
  /** HTTP status for >= 400 responses; null for hard request failures. */
  status: number | null
  /** Playwright failure text for hard failures (DNS, abort, …); else null. */
  failure: string | null
  /** Whether this counts toward route failure (see `failOnNetworkError`). */
  critical: boolean
}

export interface RouteResult {
  route: string
  url: string
  /** Overall verdict for this route (see SmokeReport.ok for composition). */
  ok: boolean
  /** Navigation completed without throwing. */
  loadOk: boolean
  /** Status of the main document response, or null if nav threw. */
  httpStatus: number | null
  /** `console.error` lines captured during load + settle. */
  consoleErrors: string[]
  /** Uncaught exceptions (`pageerror`): `name: message` + first stack line. */
  pageErrors: string[]
  /** Failed sub-resources (all recorded; `.critical` flags the ones that count). */
  failedRequests: FailedRequest[]
  /** Bridge version string if `expectBridge` and it initialized; else null. */
  bridgeVersion: string | null
  /** true/false when `expectBridge` was set; null when not checked. */
  bridgeOk: boolean | null
  /** true/false when `expectSelector` was set; null when not checked. */
  selectorFound: boolean | null
  /** Absolute path to the screenshot, or null. */
  screenshotPath: string | null
  durationMs: number
  /** Harness-level error (navigation threw, timeout, …); null on success. */
  error: string | null
}

export interface SmokeReport {
  /** AND of every route's `ok`. Empty-routes ⇒ false (nothing proven). */
  ok: boolean
  baseUrl: string
  /** ISO timestamp the run started. */
  startedAt: string
  durationMs: number
  routes: RouteResult[]
  /** Directory artifacts were written to, or null. */
  artifactsDir: string | null
}
