/**
 * Framework-neutral browser smoke runner.
 *
 * Loads a served prototype in a real headless browser and reports what
 * broke per route: console errors, uncaught exceptions, failed network
 * sub-resources, optional bridge-init, optional selector presence, and
 * an optional screenshot. Pure-ish: the only side effect is writing
 * artifacts when `artifactsDir` is set.
 *
 * Shared by the agent `verify` harness and the in-product post-save
 * smoke test. See ./types.ts for the contract and the design rationale.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import { chromium, type Browser, type Page } from "playwright"
import type {
  FailedRequest,
  RouteResult,
  SmokeReport,
  SmokeRunOptions,
} from "./types"

/** Resource kinds whose failure indicates real breakage (vs. an image/font/favicon). */
const CRITICAL_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "stylesheet",
  "fetch",
  "xhr",
])

/**
 * Launch a browser without forcing a Playwright download. Prefers an
 * explicit binary, then the installed Chrome (`channel: "chrome"`),
 * then bundled chromium as a last resort.
 */
async function launchBrowser(opts: SmokeRunOptions): Promise<Browser> {
  const headless = opts.headless ?? true
  if (opts.chromeExecutablePath) {
    return chromium.launch({ executablePath: opts.chromeExecutablePath, headless })
  }
  try {
    return await chromium.launch({ channel: "chrome", headless })
  } catch {
    // No system Chrome — fall back to whatever chromium Playwright has.
    return chromium.launch({ headless })
  }
}

function joinUrl(baseUrl: string, route: string): string {
  if (/^https?:\/\//i.test(route)) return route
  const base = baseUrl.replace(/\/+$/, "")
  const suffix = route.startsWith("/") ? route : `/${route}`
  return `${base}${suffix}`
}

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase()
  return patterns.some((p) => lower.includes(p.toLowerCase()))
}

function sanitizeRoute(route: string, index: number): string {
  const slug = route.replace(/^https?:\/\//i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")
  return `route-${index}-${slug || "root"}`
}

/** Exercise a single route in its own browser context (isolated listeners). */
async function runRoute(
  browser: Browser,
  opts: SmokeRunOptions,
  route: string,
  index: number,
): Promise<RouteResult> {
  const url = joinUrl(opts.baseUrl, route)
  const timeoutMs = opts.timeoutMs ?? 15_000
  const waitUntil = opts.waitUntil ?? "networkidle"
  const ignore = opts.ignoreConsolePatterns ?? []
  const failOnNetworkError = opts.failOnNetworkError ?? true
  const startedAt = Date.now()

  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedRequests: FailedRequest[] = []

  const context = await browser.newContext()
  const page: Page = await context.newPage()

  page.on("console", (msg) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (ignore.length && matchesAny(text, ignore)) return
    consoleErrors.push(text)
  })
  page.on("pageerror", (err) => {
    const firstStackLine = (err.stack ?? "").split("\n")[1]?.trim()
    const text = `${err.name}: ${err.message}${firstStackLine ? ` (${firstStackLine})` : ""}`
    if (ignore.length && matchesAny(text, ignore)) return
    pageErrors.push(text)
  })
  page.on("response", (resp) => {
    const status = resp.status()
    if (status < 400) return
    const resourceType = resp.request().resourceType()
    failedRequests.push({
      url: resp.url(),
      resourceType,
      status,
      failure: null,
      critical: CRITICAL_RESOURCE_TYPES.has(resourceType),
    })
  })
  page.on("requestfailed", (req) => {
    const resourceType = req.resourceType()
    failedRequests.push({
      url: req.url(),
      resourceType,
      status: null,
      failure: req.failure()?.errorText ?? "request failed",
      critical: CRITICAL_RESOURCE_TYPES.has(resourceType),
    })
  })

  let loadOk = false
  let httpStatus: number | null = null
  let bridgeVersion: string | null = null
  let bridgeOk: boolean | null = null
  let selectorFound: boolean | null = null
  let screenshotPath: string | null = null
  let error: string | null = null

  try {
    const response = await page.goto(url, { waitUntil, timeout: timeoutMs })
    httpStatus = response?.status() ?? null
    loadOk = true

    if (opts.expectBridge) {
      try {
        const handle = await page.waitForFunction(
          () =>
            (window as unknown as { __DESDE_BRIDGE_VERSION__?: string })
              .__DESDE_BRIDGE_VERSION__ ?? null,
          null,
          { timeout: timeoutMs },
        )
        bridgeVersion = (await handle.jsonValue()) as string
        bridgeOk = typeof bridgeVersion === "string" && bridgeVersion.length > 0
      } catch {
        bridgeOk = false
      }
    }

    if (opts.expectSelector) {
      selectorFound = await page.evaluate(
        (sel) => !!document.querySelector(sel),
        opts.expectSelector,
      )
    }

    if (opts.screenshot && opts.artifactsDir) {
      screenshotPath = path.join(opts.artifactsDir, `${sanitizeRoute(route, index)}.png`)
      await fs.mkdir(opts.artifactsDir, { recursive: true })
      await page.screenshot({ path: screenshotPath, fullPage: true })
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await context.close().catch(() => {})
  }

  const hasCriticalNetworkFailure = failedRequests.some((r) => r.critical)
  const ok =
    loadOk &&
    error === null &&
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    bridgeOk !== false &&
    selectorFound !== false &&
    (!failOnNetworkError || !hasCriticalNetworkFailure)

  return {
    route,
    url,
    ok,
    loadOk,
    httpStatus,
    consoleErrors,
    pageErrors,
    failedRequests,
    bridgeVersion,
    bridgeOk,
    selectorFound,
    screenshotPath,
    durationMs: Date.now() - startedAt,
    error,
  }
}

/**
 * Run the smoke checks over every configured route and return a
 * structured report. Routes run sequentially (one browser, fresh
 * context each) — predictable resource use and clean per-route logs
 * matter more than wall-clock for a handful of routes.
 */
export async function runSmoke(options: SmokeRunOptions): Promise<SmokeReport> {
  const routes = options.routes && options.routes.length > 0 ? options.routes : ["/"]
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()

  const browser = await launchBrowser(options)
  const results: RouteResult[] = []
  try {
    for (let i = 0; i < routes.length; i++) {
      results.push(await runRoute(browser, options, routes[i], i))
    }
  } finally {
    await browser.close().catch(() => {})
  }

  const report: SmokeReport = {
    // Empty route list can't happen (defaulted above), but an all-empty
    // run should never read as "passed nothing".
    ok: results.length > 0 && results.every((r) => r.ok),
    baseUrl: options.baseUrl,
    startedAt,
    durationMs: Date.now() - startedAtMs,
    routes: results,
    artifactsDir: options.artifactsDir ?? null,
  }

  if (options.artifactsDir) {
    await fs.mkdir(options.artifactsDir, { recursive: true })
    await fs.writeFile(
      path.join(options.artifactsDir, "report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    )
  }

  return report
}
