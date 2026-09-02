import type { IncomingMessage, ServerResponse } from "node:http"
import { normalizeOrigin, readViewerToken } from "./viewer-token-store.js"

/**
 * Proxies the Editor's comment traffic to a Desde **viewer**, attaching
 * the viewer personal access token server-side.
 *
 * ## Why a proxy rather than handing the token to the browser
 *
 * The obvious wiring is to fetch the PAT into the Editor UI and pass it to
 * `createViewerHttpCommentStore` as `authToken`. That puts a long-lived
 * credential — one that can read every project its owner can see, and mint
 * deployments — into browser memory, in a page that renders a live prototype.
 * The whole point of Phase 3b-2's design was that a PAT is a bearer secret
 * with real reach; putting it where page script can reach it gives that up
 * for convenience.
 *
 * Proxying costs one handler and buys: the token never leaves the CLI
 * process, and `createViewerHttpCommentStore` needs no change at all — it
 * simply points `baseUrl` at this endpoint and sends no auth of its own.
 *
 * ## Why this is not an open proxy
 *
 * Anything that can reach the CLI's HTTP server could otherwise use it as a
 * general-purpose authenticated client for the viewer. Three constraints,
 * all enforced here:
 *
 *  - only the ONE configured viewer origin is a valid destination;
 *  - only `/api/v1/**` paths forward at all;
 *  - only the ONE configured project id — so the token cannot be used to
 *    reach a different project on the same viewer, even though it would
 *    have permission to.
 *
 * The last one is the important one: it makes the proxy's authority a strict
 * subset of the token's, so a bug here cannot escalate beyond this project.
 */

export const VIEWER_PROXY_PREFIX = "/api/editor/viewer"

export interface ViewerProxyConfig {
  /** Configured viewer base URL, e.g. `https://viewer.example.com`. */
  baseUrl: string | null
  /** The project id ON THE VIEWER this repo is associated with. */
  projectId: string | null
}

/** Extracts the `/api/v1/...` suffix, or null when the path isn't proxyable. */
export function proxyTargetPath(url: string): string | null {
  const path = url.split("?")[0] ?? ""
  if (!path.startsWith(`${VIEWER_PROXY_PREFIX}/`)) return null
  const rest = path.slice(VIEWER_PROXY_PREFIX.length)
  // Must be an API path. Anything else (a prototype asset, the shell, an
  // auth route) has no business being reached with this token.
  if (!rest.startsWith("/api/v1/")) return null
  // Reject dot segments, INCLUDING percent-encoded ones.
  //
  // A literal `..` check alone is not enough, and the gap was exploitable
  // (found by codex review 2026-08-09, then reproduced). `new URL` decodes
  // `%2e%2e` and then normalizes it, so
  //   /api/v1/projects/<configured>/%2e%2e/<other>/comments
  // contains no literal `..`, passes `isAllowedProjectPath` as the CONFIGURED
  // project, and is then normalized to `/api/v1/projects/<other>/comments`
  // before the fetch — spending the stored viewer PAT outside the one project
  // this proxy is allowed to touch.
  //
  // `%2f` is NOT part of the same bug (`new URL` leaves an encoded slash
  // encoded, so it cannot create a new segment), but decoding each segment
  // catches every spelling of a dot segment at once rather than enumerating
  // the ones known to be dangerous today.
  for (const segment of rest.split("/")) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // Malformed percent-encoding. `new URL` tolerates it, we do not: an
      // input we cannot interpret is one we cannot claim to have validated.
      return null
    }
    if (decoded === ".." || decoded === ".") return null
  }
  return rest
}

/**
 * True iff the path addresses the configured project.
 *
 * `/api/v1/projects/{id}/...` must match exactly. Paths that name no project
 * (`/api/v1/me`, `/api/v1/health`) are refused rather than allowed: this
 * proxy exists for one project's comments, and a permissive default is how
 * a narrow credential path becomes a general one.
 */
export function isAllowedProjectPath(apiPath: string, projectId: string): boolean {
  const segments = apiPath.split("?")[0]?.split("/").filter(Boolean) ?? []
  // ["api","v1","projects","<id>", ...]
  return segments[0] === "api" && segments[1] === "v1" && segments[2] === "projects" && segments[3] === projectId
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export async function handleViewerProxy(
  req: IncomingMessage,
  res: ServerResponse,
  config: ViewerProxyConfig,
): Promise<boolean> {
  const apiPath = proxyTargetPath(req.url ?? "")
  if (apiPath === null) return false

  if (!config.baseUrl || !config.projectId) {
    res.writeHead(503, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        error:
          "No viewer is configured for this repo. Set `platformBaseUrl` and `projectId` in .desde/config.json.",
      }),
    )
    return true
  }
  if (!isAllowedProjectPath(apiPath, config.projectId)) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "This proxy only forwards requests for the configured project" }))
    return true
  }

  const token = await readViewerToken(config.baseUrl)
  if (!token) {
    // 401 rather than 503: the viewer IS configured, the caller simply has
    // no credential for it, and the UI's remedy ("paste a token") differs
    // from the unconfigured case's ("edit your config").
    res.writeHead(401, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "No viewer token stored. Add one in the Editor's project menu." }))
    return true
  }

  const query = (req.url ?? "").includes("?") ? `?${(req.url ?? "").split("?").slice(1).join("?")}` : ""
  const target = new URL(`${normalizeOrigin(config.baseUrl)}${apiPath}${query}`)

  // Re-check the AUTHORIZATION on the normalized target, not just on the
  // string we parsed. `new URL` decodes and collapses path segments, so the
  // path checked above and the path actually requested are not guaranteed to
  // be the same string — and it is the second one that reaches the viewer
  // carrying the PAT. Validating the parsed form alone is how the
  // `%2e%2e` escape above worked.
  //
  // `proxyTargetPath` now rejects dot segments in every spelling, so this
  // should be unreachable; it is kept because "validate exactly what you are
  // about to send" is the property that stays true when someone adds the next
  // URL-shape special case, and a duplicated cheap check is a much better
  // failure mode than a bypassed expensive one.
  if (!isAllowedProjectPath(target.pathname, config.projectId)) {
    res.writeHead(403, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "This proxy only forwards requests for the configured project" }))
    return true
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: req.headers.accept ?? "application/json",
  }
  if (req.headers["content-type"]) headers["Content-Type"] = String(req.headers["content-type"])

  const method = req.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req)

  let upstream: Response
  try {
    upstream = await fetch(target, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}) })
  } catch (error) {
    // The viewer being unreachable is an expected operational state (laptop
    // offline, server down), not a crash — the Editor keeps working locally.
    res.writeHead(502, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: `Could not reach the viewer at ${normalizeOrigin(config.baseUrl)}` }))
    void error
    return true
  }

  const outHeaders: Record<string, string> = {}
  const contentType = upstream.headers.get("content-type")
  if (contentType) outHeaders["Content-Type"] = contentType
  // Deliberately NOT forwarded: `set-cookie` (a viewer session cookie must
  // never be planted on the Editor's origin) and any auth header.
  res.writeHead(upstream.status, outHeaders)

  if (!upstream.body) {
    res.end(Buffer.from(await upstream.arrayBuffer()))
    return true
  }
  // Streamed rather than buffered so the comment SSE endpoint works — a
  // buffered proxy would hold the response open forever and deliver nothing.
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
  } catch {
    // Client disconnected mid-stream, or upstream dropped. Nothing to
    // report — just stop writing.
  } finally {
    res.end()
    reader.cancel().catch(() => {})
  }
  return true
}
