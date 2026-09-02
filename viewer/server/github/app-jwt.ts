/**
 * Builds the short-lived JWT a GitHub App uses to authenticate AS ITSELF
 * (as opposed to as an installation) — the only credential GitHub accepts
 * for `GET /app/installations` and `POST /app/installations/{id}/access_tokens`.
 *
 * No JWT library — `node:crypto`'s `sign`/RS256 covers it in a few lines,
 * matching `github-auth-provider.ts`'s "raw fetch, no new npm dependency"
 * discipline and `session-cookie.ts`'s "hand-roll the signing, it's three
 * primitives" precedent.
 */

import { sign as cryptoSign } from "node:crypto"

/**
 * Backdate `iat` by this many seconds to tolerate clock skew between this
 * process and GitHub's — GitHub's own recommended value.
 */
const CLOCK_SKEW_SECONDS = 60

/**
 * `exp - iat`. GitHub rejects a JWT whose expiration is more than 10
 * minutes from ITS OWN clock's `iat`. Combined with the 60s backdate above,
 * `exp` lands 8 minutes from `Date.now()` — comfortably inside the 10-minute
 * ceiling even accounting for skew in the other direction, so this is a
 * defensive clamp, not a tight fit against the limit.
 */
const TTL_SECONDS = 9 * 60

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return buf.toString("base64url")
}

/**
 * Sign an App-authentication JWT. `now` is injectable for deterministic
 * tests; defaults to the real clock.
 */
export function buildAppJwt(appId: string, privateKeyPem: string, now: Date = new Date()): string {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const iat = nowSeconds - CLOCK_SKEW_SECONDS
  const exp = iat + TTL_SECONDS

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify({ iat, exp, iss: appId }))
  const signingInput = `${header}.${payload}`
  const signature = base64url(cryptoSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKeyPem))

  return `${signingInput}.${signature}`
}
