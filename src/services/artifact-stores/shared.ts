/**
 * Shared HTTP-client helpers for the artifact-store factories.
 *
 * The CLI's shell UI installs a global fetch interceptor at boot
 * (editor-cli/ui-src/src/main.tsx) that attaches
 * `Authorization: Bearer <token>` to every `/api/*` request.
 * `editorFetch` is a documented PASSTHROUGH — it adds no headers of its
 * own (asserted by editor-fetch.test.ts). An earlier version of this
 * comment claimed it attached an `X-Editor-Session` header; no such header
 * exists anywhere. We still route through it so there is one place to add
 * cross-cutting request behavior if that is ever needed.
 *
 * Server-side error envelope (from artifact-http.ts):
 *   { ok: false, reason: string, [extra]: ... }
 * On 4xx/5xx we throw an `ArtifactStoreError` carrying the reason
 * + status + raw body so callers can branch on it (e.g. show a
 * "not found" banner instead of a generic error toast).
 */

import { editorFetch } from "@/lib/editor-fetch"

export class ArtifactStoreError extends Error {
  readonly status: number
  readonly reason: string
  readonly body: unknown
  readonly isArtifactStoreError = true as const
  constructor(status: number, reason: string, body: unknown) {
    super(`${status}: ${reason}`)
    this.name = "ArtifactStoreError"
    this.status = status
    this.reason = reason
    this.body = body
  }
}

/**
 * Cross-realm-safe brand check. `instanceof ArtifactStoreError`
 * fails when consumer code and the error were loaded from
 * different module copies (HMR, duplicate bundles). Codex
 * round-3: prefer this in consumer branches.
 */
export function isArtifactStoreError(err: unknown): err is ArtifactStoreError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isArtifactStoreError?: unknown }).isArtifactStoreError === true &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { reason?: unknown }).reason === "string"
  )
}

/**
 * True when an error is the typed "not found" envelope from the
 * server-side store helpers — status 404 + body matching the
 * `{ ok: false, reason: "<...> not found" }` shape. Codex round-3:
 * `get(id)` callers should only treat THIS as "missing artifact";
 * a bare 404 from a route typo / proxy fallback / etc. should
 * propagate as an error.
 */
export function isMissingArtifactError(err: unknown): boolean {
  if (!isArtifactStoreError(err)) return false
  if (err.status !== 404) return false
  // The server uses /not found/i in its reason messages
  // (see artifact-http.ts:sendStoreError). Match on that to
  // distinguish from generic 404s like "Unknown API endpoint".
  return /not found/i.test(err.reason)
}

interface RequestOpts {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/**
 * Issue a JSON request against the local editor-cli HTTP server
 * and parse the response. Throws `ArtifactStoreError` on non-2xx
 * responses so callers can rely on the typed success return.
 */
export async function artifactFetch<TResponse>(
  path: string,
  opts: RequestOpts = {},
): Promise<TResponse> {
  const method = opts.method ?? "GET"
  const init: RequestInit = {
    method,
    signal: opts.signal,
  }
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" }
    init.body = JSON.stringify(opts.body)
  }
  const res = await editorFetch(path, init)
  // Codex round-3: capture the raw text so the error body is
  // preserved even when the response isn't JSON (proxy HTML, etc).
  let rawText = ""
  try {
    rawText = await res.text()
  } catch {
    // Swallow — the response object is likely already consumed. Fall
    // through with an empty body. The status code is still meaningful.
  }

  let parsed: unknown = null
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText)
    } catch {
      // Non-JSON body — keep `parsed = null`, surface rawText below
      // in the error path.
    }
  }

  if (!res.ok) {
    const reason =
      isObjectWithStringReason(parsed) && parsed.reason
        ? parsed.reason
        : res.statusText
    throw new ArtifactStoreError(res.status, reason, parsed ?? rawText)
  }

  if (rawText.length === 0) return {} as TResponse
  if (parsed === null) {
    // 2xx with a non-JSON body. Shouldn't happen for our routes —
    // surface as a server-shape error rather than a silent {} cast.
    throw new ArtifactStoreError(
      res.status,
      "Server returned a non-JSON success body",
      rawText,
    )
  }
  return parsed as TResponse
}

function isObjectWithStringReason(v: unknown): v is { reason: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "reason" in v &&
    typeof (v as { reason: unknown }).reason === "string"
  )
}

/**
 * Codex round-3 defense: reject ids that contain path-traversal
 * characters before building the URL. `encodeURIComponent` does
 * not encode literal `.` and `..`, so `get("..")` would produce
 * `/api/.../..` which URL normalization resolves outside the
 * intended route before the request leaves the browser. Today
 * artifact ids are server-generated UUIDs (no dots), but
 * validating at the boundary is cheap insurance.
 */
export function assertSafeId(id: string, label: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (id === "." || id === "..") {
    throw new TypeError(`${label} '${id}' is not allowed`)
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new TypeError(`${label} must not contain slashes`)
  }
  if (id.includes("\x00")) {
    throw new TypeError(`${label} must not contain null bytes`)
  }
}

/** Helper: extract a required field from a parsed response. */
export function requireField<T>(
  resp: unknown,
  field: string,
  validator: (v: unknown) => v is T,
): T {
  if (typeof resp !== "object" || resp === null) {
    throw new ArtifactStoreError(
      500,
      `Server response missing object body`,
      resp,
    )
  }
  const value = (resp as Record<string, unknown>)[field]
  if (!validator(value)) {
    throw new ArtifactStoreError(
      500,
      `Server response missing or malformed '${field}'`,
      resp,
    )
  }
  return value
}

export const isArray = (v: unknown): v is unknown[] => Array.isArray(v)

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
