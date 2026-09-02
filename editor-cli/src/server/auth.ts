import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"

/**
 * Security boundary for the CLI's localhost listener.
 *
 * Per [docs/_archive/composer-runtime-architecture.md#security-boundary](../../../docs/_archive/composer-runtime-architecture.md#security-boundary):
 * the CLI exposes edit/git/auth operations on localhost. Without a gate,
 * any webpage the user visits while Editor is open becomes a remote
 * write primitive into the user's repo — WebSockets have no CORS, and
 * CORS alone is not a CSRF boundary for local write endpoints.
 *
 * V1 minimum implemented here:
 * - **Per-session bearer token.** 256-bit random, generated at boot,
 *   never persisted, rotated on every supervisor restart. Required
 *   on every JSON request (`Authorization: Bearer <token>`).
 * - **Strict Origin check.** Every request must carry
 *   `Origin: http://<host>:<ui-port>`. `null` Origin is rejected.
 *   No wildcard.
 * - **No persistence.** The token lives in this module's closure and
 *   dies with the process.
 *
 * NOT implemented in V1 (deferred to V1.5 / Electron):
 * - WebSocket upgrade gating (V1 doesn't expose WS — events come via
 *   Server-Sent Events from the same authenticated HTTP origin if/when
 *   we need them).
 * - Token rotation mid-session.
 * - OS-keychain storage of the token (Electron V2).
 */

const TOKEN_BYTES = 32 // 256 bits

export interface SecurityContext {
  /** Random per-session bearer token. */
  token: string
  /** The shell UI's origin (`http://<host>:<port>`). Used to validate `Origin` headers. */
  shellOrigin: string
}

export function newSecurityContext(shellOrigin: string): SecurityContext {
  return {
    token: randomBytes(TOKEN_BYTES).toString("hex"),
    shellOrigin,
  }
}

export type AuthCheck =
  | { ok: true }
  | { ok: false; status: number; reason: string }

/**
 * Origin-checking policy.
 *
 * - `"required"` — request MUST carry `Origin: <ctx.shellOrigin>`.
 *   Missing or mismatching Origin returns 403. This is the
 *   browser-CSRF defense and is correct for endpoints called by the
 *   editor UI's own JS (i.e., everything under `/api/*`).
 *
 * - `"if-present"` — if `Origin` is present, it must match exactly;
 *   if absent, bearer-only is sufficient. Used by `/mcp/*`: many MCP
 *   clients (CLI agents, agent runtimes, IDE extensions that proxy
 *   through their own backends) don't send browser-style `Origin`
 *   headers, so requiring it would make the endpoint unreachable for
 *   legitimate consumers. The bearer token is the load-bearing CSRF
 *   defense for MCP requests; the Origin check still rejects
 *   mismatched browser-originated calls (defense in depth).
 *
 * See [docs/editor-mcp-integration.md § Implementation requirements](../../../docs/editor-mcp-integration.md#implementation-requirements).
 */
export type OriginPolicy = "required" | "if-present"

export interface CheckAuthOptions {
  /** Defaults to `"required"` (current behavior, used by `/api/*`). */
  originPolicy?: OriginPolicy
}

/**
 * Validate an incoming HTTP request against the security context.
 *
 * Two checks (in order):
 *   1. Origin per `opts.originPolicy` — see {@link OriginPolicy}.
 *   2. `Authorization: Bearer <ctx.token>` exactly. Constant-time
 *      comparison via length-then-byte-loop to avoid timing leaks
 *      (token is 256 bits but the principle still applies).
 *
 * GET requests for the UI bundle's own assets are NOT routed through
 * this gate — they're served before auth checks because the bundle
 * needs to load to obtain the token. The token is delivered to the UI
 * via the served HTML's inline script tag (see `editor-html.ts`).
 * State-changing endpoints (everything under `/api/` and `/mcp/`)
 * all gate here.
 */
export function checkAuth(
  req: IncomingMessage,
  ctx: SecurityContext,
  opts: CheckAuthOptions = {},
): AuthCheck {
  const policy: OriginPolicy = opts.originPolicy ?? "required"
  const origin = req.headers.origin
  const originPresent = typeof origin === "string" && origin.length > 0
  if (policy === "required") {
    if (!originPresent || origin !== ctx.shellOrigin) {
      return {
        ok: false,
        status: 403,
        reason: `Invalid Origin (expected ${ctx.shellOrigin})`,
      }
    }
  } else {
    // "if-present": Origin is optional, but if sent it MUST match.
    if (originPresent && origin !== ctx.shellOrigin) {
      return {
        ok: false,
        status: 403,
        reason: `Invalid Origin (expected ${ctx.shellOrigin})`,
      }
    }
  }
  const authHeader = req.headers.authorization
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      reason: "Missing or malformed Authorization header",
    }
  }
  const token = authHeader.slice("Bearer ".length)
  if (!constantTimeEqual(token, ctx.token)) {
    return { ok: false, status: 401, reason: "Invalid token" }
  }
  return { ok: true }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
