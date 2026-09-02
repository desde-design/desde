/**
 * The URL GRAMMAR of a prototype read capability — and nothing else.
 *
 * Split out from `prototype-capability.ts` (which mints and verifies) for
 * one mechanical reason: `app/prototype-origin.ts` builds the iframe's
 * `src`, and it is reachable from a `"use client"` module
 * (`app/projects-list.tsx`), so anything it imports is bundled for the
 * browser. `prototype-capability.ts` imports `node:crypto`, which a client
 * bundle cannot resolve. This file has no imports at all, so both sides can
 * share ONE definition of the segment and the prefix instead of writing the
 * `~c` literal twice and letting them drift.
 *
 * ## Why a path PREFIX rather than a query parameter or a header
 *
 * The capability's whole job is to authorize a prototype's SUBRESOURCE
 * reads (its JS bundle, its CSS, the bridge) in a context where the
 * reviewer's session cookie does not attach — see `app/prototype-origin.ts`
 * for the measurement. A prototype's own asset URLs are relative (or
 * root-relative and rewritten by `rewriteRootRelativeUrls`), and a relative
 * URL inherits the document's path prefix automatically. Nothing in the
 * prototype has to know the capability exists, and no build step has to
 * cooperate. A query parameter would be dropped by relative resolution; a
 * header cannot be attached to a `<script src>` at all.
 *
 * ## `~c` is a reserved segment
 *
 * A leading `~` is not emitted as an output directory by any bundler in
 * common use (Vite, CRA, Next static export, Parcel, Rollup), which is the
 * same reasoning `__desde/` already rests on in `serve-router.ts`. The
 * pair `~c/<token>` is consumed unconditionally when it appears as the
 * FIRST segment under `/p/{slug}/`, so a build that did somehow ship a
 * top-level `~c` directory would have it shadowed. That is a documented
 * trade, not an accident.
 */

/** The reserved first segment that introduces a capability token. */
export const CAPABILITY_SEGMENT = "~c"

/**
 * The cookie a prototype SUBDOMAIN sets to carry a verified read capability
 * across the frame's own subresource requests.
 *
 * Subdomain mode has no path prefix to hang the `~c/<token>` segment off — the
 * prototype owns `/` on its origin — so the token arrives on the document's
 * `?~c=` query and the serve router promotes it to this cookie. The frame is
 * same-site with the shell (same registrable domain), so a `SameSite=Lax`
 * cookie rides the frame's own subresource requests without the query being
 * repeated in every relative URL.
 *
 * The name lives HERE, beside the capability grammar and import-free, so the
 * serve router and its tests share one definition. It is deliberately NOT the
 * session cookie name: this cookie is host-only on `{slug}.{serveDomain}` and
 * grants only "read this deployment's static files", never a session.
 */
export const CAPABILITY_COOKIE_NAME = "dsv_cap"

/**
 * The `dsv_cap` cookie's name for a given transport.
 *
 * On https the `__Host-` prefix makes the cookie host-only, `Path=/`, `Secure`
 * (all already true of this cookie), which is what stops a sibling
 * `{slug}.{serveDomain}` host tossing a `Domain=`-scoped `dsv_cap` in under this
 * name. On http the prefix is dropped, because a `__Host-` cookie without
 * `Secure` is rejected by the browser. The read on https honours ONLY the
 * prefixed name (a hard cutover, no unprefixed fallback).
 *
 * Import-free like the rest of this module, so the client bundle that reaches
 * `app/prototype-origin.ts` still builds.
 */
export function capabilityCookieName(secure: boolean): string {
  return secure ? `__Host-${CAPABILITY_COOKIE_NAME}` : CAPABILITY_COOKIE_NAME
}

/**
 * The character set a capability token may use — exactly what
 * `mintPrototypeCapability` can emit (base36 expiry, `.`, base64url MAC).
 *
 * This is a SAFETY gate, not a tidiness one, and it lives here rather than
 * in the verifier because it has to run BEFORE the token is used, not
 * before it is trusted. The recognised token becomes the document's path
 * prefix, and `serve-router.ts` interpolates that prefix into
 * `<base href="…">` and into rewritten `src="…"`/`href="…"` attribute
 * values (`html-inject.ts`). A token containing a `"` would therefore break
 * out of the attribute and inject markup into the served page — a reflected
 * XSS into precisely the same-origin realm finding B1 is about. Refusing
 * the split for anything outside this set makes the prefix injection-proof
 * by construction, whatever the HTML rewriters do downstream.
 *
 * A rejected token is not an error: the segments stay part of the asset
 * path, so the request resolves (or 404s) exactly as it would have before
 * capabilities existed.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/

/**
 * True iff `token` uses only the capability charset (`SAFE_TOKEN`).
 *
 * Exported so `serve-router.ts` can gate a `?~c=` query value and a `dsv_cap`
 * cookie value with the SAME rule the path-segment split (`splitCapabilityPrefix`)
 * already applies, rather than re-inlining the regex and letting the two drift.
 * It is a SAFETY gate on every channel the token can arrive through: the value
 * becomes an input to `verifyPrototypeCapability` and, in the path form, to the
 * HTML rewriters — so a value outside this set is refused before anything else
 * looks at it, on the query and the cookie exactly as on the path segment.
 */
export function isSafeCapabilityToken(token: string): boolean {
  return SAFE_TOKEN.test(token)
}

/**
 * The path prefix every URL of a prototype hangs off: `/p/{slug}/`, or
 * `/p/{slug}/~c/{token}/` when a capability is in play.
 *
 * This is the ONE builder — `serve-router.ts` uses it for `<base href>`,
 * for `rewriteRootRelativeUrls` and for the bridge's `<script src>`, and
 * `app/prototype-origin.ts` uses it for the iframe `src`. A prefix that
 * disagreed between the document's URL and the URLs rewritten into it would
 * send every subresource to a path with no capability on it, which is
 * exactly the 404 storm this whole mechanism exists to prevent.
 */
export function prototypePathPrefix(slug: string, capability: string | null | undefined): string {
  const base = `/p/${slug}/`
  return capability ? `${base}${CAPABILITY_SEGMENT}/${capability}/` : base
}

export interface CapabilitySplit {
  /** The raw token, still unverified. `null` when the URL carried none. */
  token: string | null
  /** The remaining path segments — the asset path within the deployment. */
  segments: string[]
}

/**
 * Strips a leading `~c/<token>` from an already-decoded segment list.
 *
 * Purely syntactic: it says nothing about whether the token is valid, and
 * the caller MUST still verify it (`verifyPrototypeCapability`) before
 * treating the request as authorized. Splitting the grammar from the
 * verification is deliberate — an unverified token and an absent one must
 * follow the identical cookie-authorized code path afterwards, so that a
 * garbage capability can never be more permissive, or produce a different
 * response, than no capability at all.
 */
export function splitCapabilityPrefix(segments: string[]): CapabilitySplit {
  if (segments.length >= 2 && segments[0] === CAPABILITY_SEGMENT) {
    const token = segments[1] ?? ""
    if (SAFE_TOKEN.test(token)) return { token, segments: segments.slice(2) }
  }
  return { token: null, segments }
}
