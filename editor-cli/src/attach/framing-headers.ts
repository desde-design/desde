import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from "node:http"

/**
 * Response headers minus the two that stop the Editor from showing the page.
 *
 * The Editor shows the prototype in an iframe, and the shell that owns that
 * iframe is always on another origin: its own port. A page that answers with
 * `X-Frame-Options: SAMEORIGIN` (or `DENY`), or with a CSP `frame-ancestors`
 * that does not name the shell, is refused by the browser. The frame stays
 * blank white, and the only reason given is a devtools console line nobody
 * sees. MEASURED 2026-09-21 on a Next 16 portfolio whose `next.config.ts`
 * `headers()` set `X-Frame-Options: SAMEORIGIN` on every path, a common
 * security-template default. The same blank frame was measured on plain Vite
 * with `server.headers: { "X-Frame-Options": "SAMEORIGIN" }`.
 *
 * So both are removed. Nothing else is: the rest of the page's CSP keeps
 * applying, because a policy that breaks the app in the Editor should break it
 * the same way it does in the user's own browser tab.
 *
 * Removing rather than rewriting to name the shell is deliberate. A dev server
 * sends neither header unless the project asks for it (Vite, the Editor's
 * default host, does not), so this is the framing posture most prototypes
 * already have in the Editor. The Viewer makes the same call for its proxied
 * server prototypes (`viewer/server/serve/proxy-to-process.ts`,
 * `DROP_RESPONSE`).
 *
 * `Content-Security-Policy-Report-Only` is left alone. It never blocks.
 *
 * Two entry points, one rule ({@link rewriteHeader}): this one for a header
 * object the attach proxy is about to forward, and
 * {@link allowShellFramingOnSend} for the Vite host, which has no proxy in
 * front of it.
 *
 * Returns a new object; the input is not modified.
 */
export function allowShellFraming(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const kept = rewriteHeader(name, value)
    if (kept !== undefined) out[name] = kept
  }
  return out
}

/**
 * Apply {@link allowShellFraming} to whatever `res` ends up sending.
 *
 * It wraps `res.writeHead`, because every way Node sends headers goes through
 * it: an explicit `writeHead`, the implicit one `write`/`end` make, and
 * `flushHeaders`. So it catches `setHeader` calls and a `writeHead` headers
 * argument alike, whichever middleware made them and in whatever order. Vite
 * itself sets `server.headers` with `setHeader`; a user middleware may do
 * either.
 *
 * Call it before anything else sees the response. The Vite host does that
 * from a `request` listener prepended to the http server.
 */
export function allowShellFramingOnSend(res: ServerResponse): void {
  const writeHead = res.writeHead
  res.writeHead = function (this: ServerResponse, statusCode: number, ...rest: unknown[]) {
    // After headers are sent, the original throws ERR_HTTP_HEADERS_SENT. Let
    // it be the one to throw, not a `removeHeader` of ours on the way there.
    if (!this.headersSent) rewriteSetHeaders(this)
    const last = rest.length - 1
    const headers = rest[last]
    if (Array.isArray(headers)) {
      rest[last] = rewriteRawHeaders(headers)
    } else if (headers !== null && typeof headers === "object") {
      rest[last] = allowShellFraming(headers as OutgoingHttpHeaders)
    }
    return Reflect.apply(writeHead, this, [statusCode, ...rest]) as ServerResponse
  } as ServerResponse["writeHead"]
}

/** What one header becomes: `undefined` to drop it, otherwise its value. */
function rewriteHeader(name: string, value: OutgoingHttpHeader): OutgoingHttpHeader | undefined {
  const lower = name.toLowerCase()
  if (lower === "x-frame-options") return undefined
  if (lower === "content-security-policy" && typeof value !== "number") {
    return withoutFrameAncestors(value)
  }
  return value
}

/** Headers already set on `res` with `setHeader`. */
function rewriteSetHeaders(res: ServerResponse): void {
  for (const name of res.getHeaderNames()) {
    const value = res.getHeader(name)
    if (value === undefined) continue
    const kept = rewriteHeader(name, value)
    if (kept === undefined) res.removeHeader(name)
    else if (kept !== value) res.setHeader(name, kept)
  }
}

/**
 * Node's flat `[name, value, name, value, ...]` form of `writeHead` headers.
 * An odd-length list is handed back untouched, so Node's own error for it
 * still fires.
 */
function rewriteRawHeaders(raw: unknown[]): unknown[] {
  if (raw.length % 2 !== 0) return raw
  const out: unknown[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const kept = rewriteHeader(String(raw[i]), raw[i + 1] as OutgoingHttpHeader)
    if (kept !== undefined) out.push(raw[i], kept)
  }
  return out
}

/** `undefined` when nothing but `frame-ancestors` was in the header. */
function withoutFrameAncestors(value: string | string[]): string | string[] | undefined {
  if (Array.isArray(value)) {
    const kept = value
      .map(stripPolicyList)
      .filter((v): v is string => v !== undefined)
    return kept.length > 0 ? kept : undefined
  }
  return stripPolicyList(value)
}

/**
 * One header value, which may hold several policies separated by commas. Node
 * also joins a repeated header with ", ", so two CSP headers arrive here as one
 * string in exactly this form. Each policy is enforced on its own, so each one
 * has to lose its `frame-ancestors`.
 *
 * A value with no `frame-ancestors` in it is returned as it came, byte for
 * byte, rather than re-serialised.
 *
 * Splitting on EVERY comma is correct, not a shortcut: it is what the browser
 * does. CSP3's `serialized-policy-list` is comma-separated with optional
 * whitespace around each comma, and a directive value cannot contain a comma
 * (its grammar excludes `%x2C`, and `path-part` excludes it by name). So
 * `report-uri /a,b` is already two policies to a browser, and re-serialising it
 * as `report-uri /a, b` changes bytes, never meaning. Raised by a codex review
 * 2026-09-21 and ruled on here.
 */
function stripPolicyList(value: string): string | undefined {
  const policies = value.split(",")
  if (!policies.some((policy) => policy.split(";").some(isFrameAncestors))) return value
  const kept = policies
    .map((policy) =>
      policy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive !== "" && !isFrameAncestors(directive))
        .join("; "),
    )
    .filter((policy) => policy !== "")
  return kept.length > 0 ? kept.join(", ") : undefined
}

/** Directive names are case-insensitive, and the name ends at whitespace. */
function isFrameAncestors(directive: string): boolean {
  return directive.trim().split(/\s+/, 1)[0]?.toLowerCase() === "frame-ancestors"
}
