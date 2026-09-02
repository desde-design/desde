/**
 * Shared HTTP helpers for the artifact-store CRUD handlers
 * (comments, notes, flows, canvases). Keeps the per-handler files
 * focused on routing and business logic, not body parsing.
 *
 * The body-reading primitives (`readJsonBody`, `BodyTooLargeError`,
 * `DEFAULT_BODY_MAX_BYTES`) now live in `http-body.ts` — promoted
 * there (Task 7 of the editor audit-fixes plan) so `http-server.ts`'s
 * per-route handlers and `chat-handler.ts`'s chat body share the same
 * capped reader instead of each having its own inline accumulator.
 * Re-exported here so this module's existing consumers (comments,
 * notes, canvases, design-systems, drift, launcher, project-link,
 * screenshot-plans handlers) don't need an import-path change.
 */

import type { ServerResponse } from "node:http"
import {
  DEFAULT_BODY_MAX_BYTES,
  BodyTooLargeError,
  readJsonBody,
  type ReadJsonBodyOpts,
} from "./http-body.js"

export { DEFAULT_BODY_MAX_BYTES, BodyTooLargeError, readJsonBody }
export type { ReadJsonBodyOpts }

/** Send a JSON response with the given status code. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(body))
}

/**
 * Shape an unknown error into a 4xx/5xx response. Known error kinds:
 * - `BodyTooLargeError` → 413
 * - `SyntaxError` (from JSON.parse) → 400
 * - Error messages containing "not found" → 404
 * - Everything else → 500
 */
export function sendStoreError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    sendJson(res, 413, { ok: false, reason: err.message })
    return
  }
  if (err instanceof SyntaxError) {
    sendJson(res, 400, { ok: false, reason: `Invalid JSON body: ${err.message}` })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase().includes("not found")) {
    sendJson(res, 404, { ok: false, reason: message })
    return
  }
  sendJson(res, 500, { ok: false, reason: message })
}

/**
 * Wrap an async handler so thrown errors are converted into well-
 * formed JSON responses. Keeps per-route try/catch from cluttering
 * each handler file.
 */
export async function runHandler(
  res: ServerResponse,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    sendStoreError(res, err)
  }
}
