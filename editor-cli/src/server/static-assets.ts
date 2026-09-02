/**
 * Shared static-file serving for the editor UI bundle.
 *
 * Both HTTP surfaces serve the SAME built React bundle
 * (`editor-cli/ui-src/dist`) — the editor's `http-server.ts` (with the
 * `__DESDE_CLI__` bootstrap) and the pre-project `launcher-server.ts`
 * (with the `__DESDE_LAUNCHER__` bootstrap). `main.tsx` branches on
 * which bootstrap global is present. This module holds the pieces they
 * share: MIME map, path-traversal containment, SPA-fallback static serving,
 * and the index.html rewrite that injects the bootstrap `<script src>`
 * (external-file form so a strict CSP without 'unsafe-inline' still works).
 */

import { createReadStream, statSync, readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  extname,
  join,
  resolve as resolvePath,
  relative as pathRelative,
  sep as pathSep,
} from "node:path"
import { resolveUiBundleRoot as resolvePayloadUiBundleRoot } from "../payload-paths.js"

/**
 * Default location of the built editor UI bundle. Shared by the editor core
 * and the launcher so both serve identical assets — also imported directly by
 * `launcher-server.ts`, which is why the fix for packaged-app path resolution
 * lives HERE rather than being threaded through `CoreOptions`: both call
 * sites get it for free.
 *
 * Delegates to `payload-paths.ts` (env-override in a packaged app, the
 * checkout walk-up otherwise) rather than computing its own — this module no
 * longer knows or cares which depth it's running from.
 */
export function resolveUiBundleRoot(): string {
  return resolvePayloadUiBundleRoot()
}

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

/**
 * Stable URL for the bootstrap script (sets the `window.__DESDE_*`
 * global with the per-session token etc.). Same path on both servers.
 */
export const BOOTSTRAP_PATH = "/__desde/bootstrap.js"

/**
 * Cross-platform containment check. Returns true iff `child` is the
 * same path as `parent` or a descendant. Uses `path.relative` instead
 * of a string-suffix-with-`/` test so Windows (`\`) and POSIX (`/`)
 * both work.
 */
export function isContainedBy(child: string, parent: string): boolean {
  if (child === parent) return true
  const rel = pathRelative(parent, child)
  if (rel === "" || rel === ".") return true
  if (rel === "..") return false
  if (rel.startsWith(".." + pathSep)) return false
  // path.relative returns the platform separator. Defensive fallback for
  // mixed separators (e.g., a path constructed with `/` on Windows).
  if (rel.startsWith("../")) return false
  return true
}

export interface StaticAssetContext {
  /** Absolute path to the built UI bundle (`<dist>/index.html` etc.). */
  uiBundleRoot: string
  /** Origin used to parse request URLs (e.g. `http://127.0.0.1:4321`). */
  shellOrigin: string
}

/**
 * Anti-framing headers shared by every HTML-serving path in this module
 * (S11). Neither `serveIndexHtml` nor `serveStatic` set anything that
 * stops embedding: without this, an attacker page can `<iframe>` the
 * running editor (or launcher) shell — the frame's origin genuinely IS
 * this server, so the bootstrap script loads and the per-session token
 * populates exactly as it would top-level — and UI-redress a click into
 * a real, unconfirmed action (e.g. the branch menu's "Push", which has
 * no confirmation dialog). `X-Frame-Options: DENY` covers older
 * browsers; `Content-Security-Policy: frame-ancestors 'none'` is the
 * modern equivalent and, unlike X-Frame-Options' ALLOW-FROM, composes
 * correctly with nested frames. The editor only ever frames the
 * PROTOTYPE (a different origin/port) — never the reverse — so refusing
 * ALL framing here costs the product nothing.
 */
export function applyFramingHeaders(res: ServerResponse): void {
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'")
}

/**
 * Serve the per-session bootstrap script body with the defense-in-depth
 * headers both servers need:
 *   - Cross-Origin-Resource-Policy: same-origin → Chromium-family browsers
 *     refuse to expose the response (and the token in it) to a cross-origin
 *     `<script>`/fetch initiator.
 *   - X-Content-Type-Options: nosniff → blocks content-type-sniffing detours.
 *   - Cache-Control: no-store → tokens rotate per process restart; never cache.
 *
 * `body` is the full JS statement, e.g.
 * `window.__DESDE_LAUNCHER__={...};`.
 */
export function serveBootstrapJs(res: ServerResponse, body: string): void {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.end(body)
}

/**
 * Serve `index.html` from the bundle with the bootstrap `<script>` injected
 * just before `</head>` (or prepended if no `</head>`). Sync `<script>` (no
 * `defer`/`async`) so it executes before the deferred `<script type="module">`
 * for main.tsx — that's the order the React bundle's module-load reads the
 * bootstrap global in.
 */
export function serveIndexHtml(
  res: ServerResponse,
  ctx: StaticAssetContext,
): void {
  const indexPath = resolvePath(join(ctx.uiBundleRoot, "index.html"))
  let html: string
  try {
    html = readFileSync(indexPath, "utf-8")
  } catch (err) {
    applyFramingHeaders(res)
    res.statusCode = 500
    res.end(
      `UI bundle index.html missing at ${indexPath}: ${(err as Error).message}`,
    )
    return
  }
  const bootstrap = `<script src="${BOOTSTRAP_PATH}"></script>`
  const out = html.includes("</head>")
    ? html.replace("</head>", `${bootstrap}\n</head>`)
    : bootstrap + html
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  applyFramingHeaders(res)
  res.end(out)
}

/**
 * Serve files from the UI bundle. Path-traversal protection: resolve the
 * requested path under `uiBundleRoot` and reject anything that escapes.
 * Unknown paths fall back to `index.html` so SPA routing works.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StaticAssetContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", ctx.shellOrigin)
  let pathname = url.pathname
  if (pathname === "/" || pathname === "") pathname = "/index.html"

  const requested = resolvePath(join(ctx.uiBundleRoot, pathname))
  if (!isContainedBy(requested, ctx.uiBundleRoot)) {
    res.statusCode = 403
    res.end("forbidden")
    return
  }

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(requested)
  } catch {
    // SPA fallback: serve index.html for unknown routes so client-side
    // routing can take over.
    return serveIndexHtml(res, ctx)
  }
  if (!stat.isFile()) {
    return serveIndexHtml(res, ctx)
  }

  if (requested === resolvePath(join(ctx.uiBundleRoot, "index.html"))) {
    return serveIndexHtml(res, ctx)
  }

  const ext = extname(requested).toLowerCase()
  const mime = MIME_TYPES[ext] ?? "application/octet-stream"
  res.setHeader("Content-Type", mime)
  res.setHeader("Content-Length", stat.size)
  applyFramingHeaders(res)
  createReadStream(requested).pipe(res)
}
