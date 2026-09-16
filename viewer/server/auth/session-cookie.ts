/**
 * Signed session cookie: HMAC-SHA256(sessionId) via `node:crypto`, so a
 * tampered or forged cookie value is rejected before the session id ever
 * reaches storage. The session id itself is not secret (it's an opaque
 * UUID) — the signature exists so a client can't hand us an arbitrary
 * OTHER user's session id and have us trust it.
 *
 * Constant-time compare follows `api-router.ts`'s `tokensMatch` precedent:
 * hash both sides to fixed-length digests before `timingSafeEqual`, so
 * unequal-length inputs (a differently-sized signature, or garbage) can't
 * throw — `timingSafeEqual` requires equal-length buffers.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE_NAME = "viewer_session"

/**
 * The session cookie's name for a given transport.
 *
 * On https the cookie gains the `__Host-` prefix. The browser only accepts a
 * `__Host-` cookie when it is `Secure`, has `Path=/`, and carries no `Domain`
 * attribute. Those are all already true of this cookie, so the prefix adds one
 * new guarantee for free: a `__Host-` cookie cannot be overwritten by a
 * `Domain=`-scoped cookie set from a sibling host. On a subdomain deployment
 * that closes a cookie-tossing / session-fixation vector. Hostile prototype JS
 * on `{slug}.{serveDomain}` can set `viewer_session=<its own signed value>;
 * Domain=<registrable domain>`, which the browser would otherwise deliver to
 * the shell under the plain name. Reading only the `__Host-` name on https
 * means that tossed cookie can never masquerade as the real one.
 *
 * On http (localhost dev) the prefix is dropped, because the cookie is not
 * `Secure` there and the browser rejects a `__Host-` cookie that lacks Secure.
 *
 * Cutover note: this is a hard cutover. On https only the prefixed name is read
 * (see `getCurrentUser` and the logout route), with no unprefixed fallback,
 * because a fallback would re-open exactly the tossing vector this closes. Any
 * https session issued before this change logs out once, which is acceptable
 * while the viewer has no external users.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? `__Host-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME
}

function hmacDigest(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url")
}

/** Constant-time compare of two strings of arbitrary (possibly unequal) length. */
function digestsMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

/** Sign a session id: `<id>.<base64url hmac>`. */
export function signSessionId(secret: string, sessionId: string): string {
  return `${sessionId}.${hmacDigest(secret, sessionId)}`
}

/**
 * Verify a signed session cookie value. Returns the session id on a valid
 * signature, or `null` on any format error, tamper, or wrong-secret
 * mismatch. Never throws.
 */
export function verifySessionCookie(secret: string, raw: string): string | null {
  if (!raw) return null
  // Intentionally the FIRST dot, not `split(".")`: a session id never
  // contains a dot (it's a UUID), so everything after the first dot is
  // the signature, even if IT contains further dots. That's safe — a
  // multi-dot "signature" just can't match the recomputed HMAC — but it
  // means this does not treat "." as a general-purpose field separator.
  const dot = raw.indexOf(".")
  if (dot <= 0 || dot === raw.length - 1) return null
  const sessionId = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)
  const expected = hmacDigest(secret, sessionId)
  if (!digestsMatch(signature, expected)) return null
  return sessionId
}

/** Build the `Set-Cookie` header value that plants a signed session cookie. */
export function serializeSessionCookie(
  value: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${sessionCookieName(opts.secure)}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${opts.maxAgeSeconds}`,
  ]
  if (opts.secure) parts.push("Secure")
  return parts.join("; ")
}

/** Build the `Set-Cookie` header value that clears the session cookie (logout). */
export function clearSessionCookie(opts: { secure: boolean }): string {
  const parts = [
    `${sessionCookieName(opts.secure)}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
  ]
  if (opts.secure) parts.push("Secure")
  return parts.join("; ")
}

/**
 * Read a single cookie's value out of a raw `Cookie` request header.
 * Returns `null` when the header is absent, the cookie isn't present, or
 * the value fails to `decodeURIComponent` (malformed percent-encoding).
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  const prefix = `${name}=`
  for (const rawPart of header.split(";")) {
    const part = rawPart.trim()
    if (!part.startsWith(prefix)) continue
    const raw = part.slice(prefix.length)
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }
  return null
}

/** How many times `name` appears in a raw `Cookie` header. */
export function countCookie(header: string | undefined, name: string): number {
  if (!header) return 0
  const prefix = `${name}=`
  let count = 0
  for (const rawPart of header.split(";")) {
    if (rawPart.trim().startsWith(prefix)) count++
  }
  return count
}

/**
 * Expires a session cookie that a sibling host planted with a `Domain`
 * attribute (a "tossed" cookie). The shell never sets a `Domain` cookie
 * itself, so one can only come from a prototype on `{slug}.<serve domain>`
 * on plain http, where the `__Host-` prefix that closes this on https is not
 * available. Only the plain name can be tossed; the prefixed one cannot
 * carry `Domain` at all.
 *
 * Guard it with `canCarryDomainCookie` — on a host where a `Domain` cookie is
 * not a DISTINCT cookie, this clear deletes the reviewer's real session.
 */
export function clearTossedSessionCookie(hostname: string): string {
  return `${sessionCookieName(false)}=; Domain=${hostname}; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

/**
 * Can a `Domain` attribute produce a cookie the browser keeps SEPARATELY from
 * this host's own host-only cookie?
 *
 * The whole tossed-cookie defence assumes it can: it clears the `Domain`
 * spelling and deliberately leaves the reviewer's host-only cookie alone, on
 * the reasoning that a sibling host can only ever plant the former. That
 * reasoning holds for a normal hostname, and the browser agrees — measured in
 * Chrome, a `Domain=desde.localhost` clear leaves a host-only
 * `desde.localhost` cookie untouched.
 *
 * It does NOT hold for a hostname that cannot take a `Domain` attribute at
 * all: a single label (`localhost`, or a bare LAN name) and an IP literal.
 * There the browser stores the "Domain" cookie as host-only, which makes it
 * the SAME cookie as the real one, and a `Max-Age=0` on it deletes the
 * session that was just issued. Measured: on `localhost` and on `127.0.0.1`
 * the session cookie does not survive the response that sets it, so sign-in
 * appears to succeed — the `sessions` row is written, the redirect happens —
 * and every subsequent request is anonymous. `VIEWER_PUBLIC_URL=http://localhost:<port>`
 * is the documented Safari fallback, so this was reachable by a supported
 * configuration, not just by a test harness.
 *
 * Nothing is lost by skipping the clear there. A host with no dot has no
 * subdomain siblings to be tossed from in the first place, and a prototype
 * sharing a bare `localhost` with the shell (loopback mode, where prototypes
 * differ only by PORT) can set the real host-only cookie directly — which
 * this clear could never have distinguished anyway.
 *
 * curl cannot reproduce the bug, because it keys host-only and `Domain`
 * cookies separately. A browser is the only thing that shows it.
 */
export function canCarryDomainCookie(hostname: string): boolean {
  // `new URL(...).hostname` brackets an IPv6 literal; be tolerant of both.
  if (hostname.startsWith("[") || hostname.includes(":")) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false
  return hostname.includes(".")
}

/**
 * Every `Set-Cookie` a sign-in answers with: the session cookie, and on http
 * the clear for a tossed `Domain` copy, so a planted cookie never outlives
 * the reviewer's own sign-in.
 *
 * The clear is omitted on https (the `__Host-` name cannot be tossed) and on
 * a host that cannot carry a `Domain` cookie, where it would delete the very
 * cookie beside it — see `canCarryDomainCookie`.
 */
export function sessionCookieHeaders(
  value: string,
  opts: { secure: boolean; maxAgeSeconds: number; publicHostname: string },
): string[] {
  const cookie = serializeSessionCookie(value, { secure: opts.secure, maxAgeSeconds: opts.maxAgeSeconds })
  if (opts.secure || !canCarryDomainCookie(opts.publicHostname)) return [cookie]
  return [cookie, clearTossedSessionCookie(opts.publicHostname)]
}
