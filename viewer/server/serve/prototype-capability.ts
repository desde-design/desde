/**
 * A short-lived, cookie-free read capability for ONE deployment of ONE
 * prototype — the thing that lets the review iframe be sandboxed even when
 * the prototype is private (security audit finding B1).
 *
 * ## The problem it solves
 *
 * `app/prototype-origin.ts` documents the measurement in full; the short
 * version is that origin isolation and cookie-based prototype authorization
 * were mutually exclusive as built:
 *
 * - `/p/{slug}/**` authorizes EVERY response through `canReadProject` —
 *   the HTML, the JS bundle, the CSS, and the bridge bundle alike.
 * - Sandboxing the iframe without `allow-same-origin` gives the document an
 *   opaque origin, whose site-for-cookies is null, so the `SameSite=Lax`
 *   `viewer_session` cookie stops attaching to its SUBRESOURCE requests
 *   (measured in Chromium against a replica of this serve layer, with an
 *   unsandboxed control).
 *
 * So sandboxing a private prototype served its HTML and then 404'd
 * everything the page needed. The previous fix wave therefore sandboxed
 * only prototypes whose assets already load anonymously, and left private
 * ones same-origin and uncontained — a deliberate, documented, still-open
 * gap.
 *
 * This module closes it by supplying the credential the cookie can no
 * longer be: one carried in the prototype's own URL PREFIX, which every
 * relative subresource inherits for free (see
 * `prototype-capability-path.ts`).
 *
 * ## Shape and bounds
 *
 * `<expiry-base36>.<hmac-base64url>`, where the HMAC covers a
 * domain-separated, length-prefixed encoding of the slug, the deployment id
 * and the expiry, keyed by `VIEWER_SESSION_SECRET`.
 *
 * - **Scoped to one project AND one deployment.** The slug and deployment
 *   id are INPUTS to the MAC, not fields inside the token — the verifier
 *   recomputes the signature from the slug in the request path and the
 *   project's current `activeDeploymentId`. A token minted for project A
 *   therefore cannot verify under project B's slug: there is no comparison
 *   step to forget, because a mismatch simply produces a different MAC.
 * - **Expires in minutes.** `CAPABILITY_TTL_MS` below.
 * - **Read-only, and only here.** Nothing under `/api/v1/**` parses the
 *   `~c` segment or calls `verifyPrototypeCapability`, so a leaked
 *   capability grants exactly "fetch this deployment's static files" — not
 *   a comment write, not a token mint, not project metadata.
 * - **Never persisted, never logged.** It is derived on demand from the
 *   secret; there is no table to leak and no revocation list to maintain,
 *   which is what keeps the expiry short rather than long.
 * - **Additive.** A missing, malformed, expired or forged capability leaves
 *   the request on the pre-existing cookie/PAT path in `serve-router.ts`,
 *   which still ends in the byte-identical 404. The capability can only
 *   ever grant access the cookie ALSO would have granted at mint time; it
 *   cannot widen anything.
 *
 * ## Why `VIEWER_SESSION_SECRET` and not a new secret
 *
 * The capability's blast radius is strictly smaller than a forged session
 * cookie's (which that same secret already signs), so a separate secret
 * would add an operator-visible knob, a rotation story, and a "viewer boots
 * with sessions but not prototype isolation" failure mode, in exchange for
 * no security property. `config.sessionSecret` is always present now (see
 * `mintPrototypeCapability` for what that means for the old "auth
 * unconfigured" fallback below).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

/**
 * How long a minted capability is good for.
 *
 * The tension: too short and a long-lived review tab starts 404ing
 * lazily-loaded chunks; too long and a capability leaked through browser
 * history or a shared screenshot stays live. 30 minutes covers a normal
 * review session in one page load (the review page re-mints on every
 * render, so a reload always refreshes it) while keeping a leaked token
 * useless well inside the working day.
 *
 * KNOWN BOUND, stated plainly: a review tab left open past the TTL will
 * 404 any subresource it has not already fetched, until the page is
 * reloaded. Re-minting without a reload would mean changing the iframe's
 * `src`, which reloads the prototype and discards its state — strictly
 * worse. If this proves annoying in practice the fix is a silent re-mint
 * endpoint plus a service-worker-free URL rewrite, not a longer TTL.
 */
export const CAPABILITY_TTL_MS = 30 * 60 * 1000

/**
 * Domain separation. Ensures a signature produced here can never be
 * mistaken for — or replayed as — a session cookie signature, which is
 * derived from the same secret (`auth/session-cookie.ts`).
 */
const CAPABILITY_DOMAIN = "desde-viewer/prototype-capability/v1"

/**
 * Refuse to even hash an absurd token. A capability is ~55 characters; a
 * megabyte of path segment is not a typo, and bounding the work before the
 * HMAC keeps a flood of junk requests cheap.
 */
const MAX_TOKEN_LENGTH = 256

/**
 * Length-prefixed, not just delimiter-joined. `${slug}\n${deploymentId}` is
 * ambiguous if either value could contain the delimiter — slugs cannot
 * today, but a signing preimage is exactly the wrong place to depend on a
 * validation rule enforced somewhere else, because the failure is silent
 * and grants access rather than denying it.
 */
function signCapability(secret: string, slug: string, deploymentId: string, exp: number): string {
  const preimage =
    `${CAPABILITY_DOMAIN}\n` +
    `${slug.length}:${slug}\n` +
    `${deploymentId.length}:${deploymentId}\n` +
    `${exp}`
  return createHmac("sha256", secret).update(preimage).digest("base64url")
}

/**
 * Constant-time comparison of two signature strings. Same construction as
 * `auth/authorize.ts`'s `tokensMatch` and for the same two reasons:
 * `timingSafeEqual` throws on unequal-length buffers (and which branch runs
 * would itself leak the expected length), and a naive `!==` leaks the
 * common prefix through timing. Hashing both sides first makes the compared
 * buffers a fixed 32 bytes regardless of input.
 */
function signaturesMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

export interface MintCapabilityArgs {
  /** `config.sessionSecret` in real server code; `null` is only used by tests. `null` disables minting. */
  secret: string | null
  slug: string
  /** The project's `activeDeploymentId`. `null` disables minting. */
  deploymentId: string | null
  /** Injectable clock, for tests. */
  now?: number
  /** Injectable TTL, for tests. Defaults to `CAPABILITY_TTL_MS`. */
  ttlMs?: number
}

/**
 * Mints a capability, or returns `null` when one cannot be minted.
 *
 * `null` is a legitimate, safe outcome, not an error: it means the caller
 * should fall back to the pre-capability behaviour (an unsandboxed
 * same-origin iframe authorized by the session cookie). That mainly
 * happens when the deployment has not been published yet. The secret itself
 * is now always present (`config.sessionSecret`), so the "auth unconfigured"
 * arm of this function is unreachable in the real server and remains only
 * for callers that pass an explicit null in tests. Note that the old
 * reasoning here — "no auth means no users, so no project is private" — is
 * no longer true: local-operator sign-in creates real users and real
 * members with no GitHub App configured at all.
 *
 * The CALLER is responsible for only minting for a caller that may read the
 * project. `app/review/[slug]/page.tsx` mints after `GET /api/v1/projects`
 * has already filtered to readable projects — this function deliberately
 * takes no request and performs no authorization of its own, so that it
 * cannot be mistaken for the gate.
 */
export function mintPrototypeCapability(args: MintCapabilityArgs): string | null {
  const { secret, slug, deploymentId } = args
  if (!secret || !deploymentId) return null
  const now = args.now ?? Date.now()
  const ttlMs = args.ttlMs ?? CAPABILITY_TTL_MS
  const exp = Math.floor((now + ttlMs) / 1000)
  return `${exp.toString(36)}.${signCapability(secret, slug, deploymentId, exp)}`
}

export interface VerifyCapabilityArgs {
  /** The raw segment from the URL. Untrusted. */
  token: string
  /** `config.sessionSecret` in real server code; `null` is only used by tests. `null` refuses everything. */
  secret: string | null
  /** The slug from the request path. */
  slug: string
  /** The project's CURRENT `activeDeploymentId`. */
  deploymentId: string | null
  /** Injectable clock, for tests. */
  now?: number
}

/**
 * True iff `token` is a live capability for exactly this slug + deployment.
 *
 * Every refusal returns the same `false` — the caller turns that into the
 * ordinary cookie-authorized path, whose denial is the byte-identical 404.
 * There is deliberately no error channel and no reason string: a reason
 * would end up in a log or a response body, and the audit's standing rule
 * for this surface is that "exists but unreadable" and "does not exist"
 * must stay indistinguishable.
 *
 * Ordering note: the expiry is checked BEFORE the MAC. That is safe (the
 * expiry is itself covered by the MAC, so a forged one cannot verify) and
 * strictly conservative — it can only reject tokens the MAC check would
 * also have had to reject.
 */
export function verifyPrototypeCapability(args: VerifyCapabilityArgs): boolean {
  const { token, secret, slug, deploymentId } = args
  if (!secret || !deploymentId) return false
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return false
  }

  const dot = token.indexOf(".")
  if (dot <= 0 || dot === token.length - 1) return false
  const expPart = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  // Canonical base36 only. Without this, `0a` / `00a` / `A` would all decode
  // to the same expiry, so one live capability would have unboundedly many
  // spellings — harmless for access control (each spelling has its own MAC
  // over the SAME numeric `exp`, so they all verify) but it turns a single
  // token into a family, which is exactly the sort of thing that makes a
  // future "have I seen this token" check quietly wrong.
  if (!/^[0-9a-z]+$/.test(expPart)) return false
  const exp = Number.parseInt(expPart, 36)
  if (!Number.isSafeInteger(exp) || exp <= 0) return false
  if (exp.toString(36) !== expPart) return false

  const now = args.now ?? Date.now()
  if (exp * 1000 <= now) return false

  return signaturesMatch(signature, signCapability(secret, slug, deploymentId, exp))
}
