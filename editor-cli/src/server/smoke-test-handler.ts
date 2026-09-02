/**
 * Handlers for the manual smoke-test endpoint.
 *
 *   POST /api/editor/smoke-test  — trigger a smoke run
 *   GET  /api/editor/smoke-test  — list recent run summaries
 *
 * The POST handler:
 *   1. Resolves which routes to exercise (body > config > default "/").
 *   2. Generates a unique run id + per-run artifacts dir.
 *   3. Delegates execution to `runSmoke` (Playwright-based, framework-
 *      neutral, reuses the same runner as the agent verify harness).
 *   4. Persists a summary to the smoke-runs history store.
 *   5. Responds with the summary + the full report.
 *
 * The GET handler returns the persisted run history for the project.
 */

import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { runSmoke } from "../smoke/smoke-runner.js"
import {
  addSmokeRun,
  listSmokeRuns,
} from "./stores/local-smoke-run-store.js"
import {
  resolveStorePath,
  readJsonFile,
} from "./stores/local-store-base.js"
import { readRawBody, BodyTooLargeError } from "./http-body.js"

/**
 * Absolute path to System Chrome on macOS. Passed to `runSmoke` only
 * when it exists so we prefer the already-downloaded system browser
 * over triggering a Playwright chromium download.
 */
const SYSTEM_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

/**
 * Shape of the parsed project config's smoke-test section.
 * All fields are optional — the CLI never requires a config file.
 */
interface SmokeTestConfig {
  routes?: string[]
}
interface ProjectConfig {
  smokeTest?: SmokeTestConfig
}

/** Body accepted by the POST handler. */
interface SmokeTestRequestBody {
  routes?: unknown
}

/** Minimal RouteContext fields required by these handlers. */
interface SmokeHandlerContext {
  viteUrl: string
  canonicalRoot: string
}

/**
 * POST /api/editor/smoke-test — launch a smoke run and persist the
 * result. Body: `{ routes?: string[] }` (all optional).
 */
export async function handleSmokeTestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SmokeHandlerContext,
): Promise<void> {
  // --- Parse body ---
  let raw: string
  try {
    raw = await readRawBody(req)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, reason: err.message })
      return
    }
    throw err
  }
  let body: SmokeTestRequestBody = {}
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw) as SmokeTestRequestBody
    } catch {
      sendJson(res, 400, { ok: false, reason: "Invalid JSON body" })
      return
    }
  }

  // --- Resolve routes: body > config > default. Validate element-wise
  // so a stray non-string can't reach the runner (where it would throw). ---
  const asStringRoutes = (val: unknown): string[] =>
    Array.isArray(val)
      ? val.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : []

  let routes = asStringRoutes(body.routes)
  if (routes.length === 0) {
    const configPath = resolveStorePath(ctx.canonicalRoot, "config.json")
    const config = await readJsonFile<ProjectConfig>(configPath, {})
    routes = asStringRoutes(config.smokeTest?.routes)
  }
  if (routes.length === 0) routes = ["/"]

  // --- Run id + artifacts dir ---
  const runId = randomUUID()
  const artifactsDir = resolveStorePath(
    ctx.canonicalRoot,
    "smoke-runs",
    runId,
  )

  // --- Execute smoke run ---
  try {
    const report = await runSmoke({
      baseUrl: ctx.viteUrl,
      routes,
      expectBridge: true,
      screenshot: true,
      artifactsDir,
      ...(existsSync(SYSTEM_CHROME)
        ? { chromeExecutablePath: SYSTEM_CHROME }
        : {}),
      timeoutMs: 30_000,
      ignoreConsolePatterns: [
        "[vite]",
        "vue-devtools",
        "download the vue devtools",
      ],
    })

    const summary = await addSmokeRun(ctx.canonicalRoot, runId, report)
    sendJson(res, 200, { ok: true, run: summary, report })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Smoke run failed: ${(err as Error).message}`,
    })
  }
}

/**
 * GET /api/editor/smoke-test — return the most recent 20 run summaries
 * for the project's canonical root.
 */
export async function handleSmokeRunsRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: Pick<SmokeHandlerContext, "canonicalRoot">,
): Promise<void> {
  try {
    const runs = await listSmokeRuns(ctx.canonicalRoot, 20)
    sendJson(res, 200, { ok: true, runs })
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      reason: `Failed to list smoke runs: ${(err as Error).message}`,
    })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}
