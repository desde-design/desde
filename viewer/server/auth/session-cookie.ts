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
