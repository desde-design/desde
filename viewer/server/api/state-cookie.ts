/**
 * The CSRF `state` cookie shared by every redirect-out-and-back flow.
 *
 * Two flows use it now: GitHub sign-in (`auth-routes.ts`, cookie
 * `viewer_oauth_state`) and GitHub App Manifest creation
 * (`setup-routes.ts`, cookie `viewer_setup_state`). Both send the operator
 * to github.com and both get navigated back with a `state` query parameter
 * that has to be matched against something the attacker cannot forge.
 *
 * It lives here rather than in `auth-routes.ts` because the two flows need
 * DIFFERENT cookie names and must not clobber each other: an operator who
 * starts the manifest flow in one tab and signs in in another would
 * otherwise have the second flow overwrite the first flow's state, and the
 * first would come back a 400. So the name is a parameter, not a constant
 * baked into the helper.
 *
 * The three rules these helpers exist to keep identical across flows:
 *
 * 1. `HttpOnly` — page JS never reads the cookie, so an XSS in a served
 *    prototype cannot lift the value and forge a matching callback.
 * 2. `SameSite=Lax` — the cookie must ride the top-level navigation GitHub
 *    performs back to us (Lax does; Strict would not), and must NOT ride a
 *    cross-site subresource request.
 * 3. `Secure` iff the deployment is https. Setting it unconditionally would
 *    make the cookie undeliverable on the `http://localhost` deployment that
 *    is the default, which presents as "sign-in always says invalid state".
 */

import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Ten minutes. Long enough for a human to read GitHub's confirmation screen,
 * short enough that an abandoned flow does not leave a live nonce sitting in
 * the browser all day.
 *
 * Deliberately SHORTER than GitHub's own one-hour expiry on a manifest
 * `code` (verified 2026-08-20: "You must complete all three steps in the
 * GitHub App Manifest flow within one hour"). We are the stricter of the two
 * clocks on purpose — an expired state is a clean 400 from us, whereas an
 * expired code is a 422 from GitHub that we can only report as a generic
 * 502.
 */
const STATE_COOKIE_MAX_AGE_SECONDS = 600

/**
 * Constant-time compare, same hash-both-sides-first technique as
 * `api-router.ts`'s `tokensMatch` / `session-cookie.ts`'s `digestsMatch` —
 * `timingSafeEqual` throws on unequal-length buffers, and a naive `===`
 * leaks length/prefix via timing. The `state` param is attacker-controlled
 * (it is a query string), so this can't be `===`.
 */
export function statesMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * The state cookie's name for a given transport, given the flow's own base name
 * (`viewer_oauth_state` or `viewer_setup_state`).
 *
 * Same `__Host-` rule as the session cookie (see `sessionCookieName`). On https
 * the prefix locks the cookie to host-only, `Path=/`, `Secure` (all already
 * true here), so a sibling `{slug}.{serveDomain}` host cannot toss a
 * `Domain=`-scoped cookie in under this name to satisfy the CSRF check. On http
 * the prefix is dropped, because the browser rejects a `__Host-` cookie that is
 * not `Secure`. The read on https honours ONLY the prefixed name (a hard
 * cutover, no unprefixed fallback).
 */
export function stateCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base
}

export function serializeStateCookie(name: string, value: string, secure: boolean): string {
  const parts = [
    `${stateCookieName(name, secure)}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${STATE_COOKIE_MAX_AGE_SECONDS}`,
  ]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

export function clearStateCookie(name: string, secure: boolean): string {
  const parts = [`${stateCookieName(name, secure)}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"]
  if (secure) parts.push("Secure")
  return parts.join("; ")
}

/** `publicUrl` is validated absolute http(s) in `config.ts` — `startsWith` is all that's needed. */
export function isSecurePublicUrl(publicUrl: string): boolean {
  return publicUrl.startsWith("https://")
}
