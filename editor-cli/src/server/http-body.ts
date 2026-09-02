/**
 * Shared, byte-capped request-body reader for every editor-cli HTTP
 * handler.
 *
 * Before this module existed, `readJsonBody` (originally in
 * `artifact-http.ts`, added per codex round-1 review) was the only
 * capped reader in the codebase — the artifact-store CRUD routes used
 * it, but `http-server.ts` had ~11 inline
 * `for await (const chunk of req) raw += chunk` accumulators with NO
 * size cap at all (an authenticated POST with a multi-hundred-MB body
 * would accumulate one giant string in memory before anything looked
 * at it). Task 7 of the editor audit-fixes plan promotes the capped
 * reader here so every call site — `http-server.ts`'s per-route
 * handlers, `artifact-http.ts`'s CRUD routes, and `chat-handler.ts`'s
 * large image-carrying chat body — shares one implementation.
 */

import type { IncomingMessage } from "node:http"

/** Default body-size cap: routes that don't specify get this. */
export const DEFAULT_BODY_MAX_BYTES = 256 * 1024 // 256 KiB

/**
 * Body cap for routes whose payloads carry full source-file strings
 * (e.g. `/api/editor/edit`, `/api/editor/llm-fallback`,
 * `/api/editor/edit-iteration`). Comfortably above real SFC sizes
 * while still bounding worst case.
 */
export const EDIT_BODY_MAX_BYTES = 1024 * 1024 // 1 MiB

export interface ReadBodyOpts {
  /** Maximum body size in bytes before throwing `BodyTooLargeError`. */
  maxBytes?: number
}

/** @deprecated kept as an alias — `readJsonBody`'s original opts name. */
export type ReadJsonBodyOpts = ReadBodyOpts

/** Thrown when the request body exceeds the configured cap. Route
 * handlers map this to a 413 in their own error-response shape. */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`)
    this.maxBytes = maxBytes
    this.name = "BodyTooLargeError"
  }
}

/**
 * Read the full request body as a UTF-8 string, enforcing a byte cap.
 *
 * Throws `BodyTooLargeError` once accumulated bytes exceed `maxBytes`.
 * Accumulation stops immediately (the loop exits via throw), but the
 * underlying socket is deliberately left alone — callers that still
 * need to flush an error response down `res` require the response
 * stream to stay open; the http server drains whatever unread bytes
 * remain on the request stream after the response ends.
 */
export async function readRawBody(
  req: IncomingMessage,
  opts: ReadBodyOpts = {},
): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_MAX_BYTES
  let received = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buf.length
    if (received > maxBytes) {
      throw new BodyTooLargeError(maxBytes)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Read the request body, enforce a byte cap, and parse as JSON.
 *
 * Throws `BodyTooLargeError` when the body exceeds `maxBytes` and a
 * `SyntaxError` when the body isn't valid JSON. An empty (or
 * whitespace-only) body parses as `{}` rather than throwing — this is
 * the historical `readJsonBody` behavior the artifact-store CRUD
 * handlers depend on.
 */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
  opts: ReadJsonBodyOpts = {},
): Promise<T> {
  const raw = await readRawBody(req, opts)
  if (raw.trim().length === 0) return {} as T
  return JSON.parse(raw) as T
}
