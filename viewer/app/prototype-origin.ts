/**
 * Where the shell points a browser at a prototype, and under what
 * containment.
 *
 * Both product surfaces that reach a prototype — the review page's iframe
 * (`review/[slug]/review-shell.tsx`) and the dashboard's "Open" link
 * (`projects-list.tsx`) — resolve their URL here, so there is exactly one
 * place that decides "same origin or isolated", and it is the same place
 * that decides the sandbox path mode needs.
 *
 * ## Why this module exists (security audit 2026-08-09, findings B1 + S8)
 *
 * `VIEWER_SERVE_DOMAIN` was implemented end to end on the SERVER — the
 * subdomain rewrite (`server/create-app.ts`), the stronger `connect-src
 * 'self'` policy, the host-only session cookie that is therefore never sent
 * to a prototype origin (`server/serve/subdomain.ts`) — and then nothing
 * ever emitted a subdomain URL. `prototypeOriginFor` had zero callers and
 * both shell surfaces hardcoded `/p/{slug}/`, so an operator who
 * provisioned wildcard DNS and TLS got byte-identical behaviour to one who
 * had not: every reviewer still loaded the prototype on the viewer's own
 * origin, where prototype JS reaches `window.parent` — a realm with no CSP
 * of its own — and `parent.fetch('/api/v1/tokens', …)` mints a durable
 * write-scoped credential as that reviewer (B1). A prototype's own CSP
 * cannot close that: a policy binds the document it is delivered with, and
 * says nothing about `window.parent`.
 *
 * ## Isolation costs the ambient credential — MEASURED
 *
 * Both isolation flavours take the prototype out of the shell's origin, and
 * the reviewer's `viewer_session` cookie does not follow it:
 *
 * - **Subdomain mode**: the cookie is host-only (no `Domain` attribute), so
 *   it is never sent to `{slug}.{serveDomain}` at all. `subdomain.ts` names
 *   this as the point of the mode.
 * - **Path mode + `sandbox`**: dropping `allow-same-origin` puts the
 *   document in an opaque origin, which has a null site-for-cookies, so
 *   `SameSite=Lax` no longer attaches. Measured in Chromium against a
 *   replica of this serve layer, with an identical unsandboxed control on a
 *   second navigation (cookie already in the jar, so no `Set-Cookie`
 *   timing artifact): the iframe's OWN document request still carries the
 *   cookie, and every SUBRESOURCE request — script, image — does not.
 *
 * And `/p/{slug}/**` is authorization-gated per request, subresources
 * included: a `members` project that has members 404s an anonymous read,
 * and so does the bridge bundle itself (`server/serve/__tests__/
 * serve-router.test.ts`, "a 'members' project with members is NOT
 * fetchable" and "is subject to the SAME canReadProject gate"). Isolating
 * such a prototype therefore serves its HTML and then 404s its JS, its CSS
 * and the bridge — a blank review surface, not a contained one.
 *
 * So isolation can only be applied where the prototype's assets do not need
 * the cookie. That used to mean `public-link` projects and the zero-member
 * `members` projects the migration rule keeps world-readable, with every
 * private prototype left same-origin and uncontained — a deliberate,
 * documented, still-open half of B1.
 *
 * ## Closing it: the capability supplies what the cookie no longer can
 *
 * The remaining work was never "sandbox harder", it was "authorize a
 * prototype asset read without the ambient cookie". `server/serve/
 * prototype-capability.ts` does that: a short-lived HMAC over the slug, the
 * deployment id and an expiry, keyed by `VIEWER_SESSION_SECRET`, carried as
 * a path segment (`/p/{slug}/~c/{token}/`) that every relative subresource
 * inherits for free. `app/review/[slug]/page.tsx` mints one for a project
 * the caller has ALREADY been admitted to, and passes it here.
 *
 * With a capability in hand, `anonymouslyReadable` stops gating the
 * sandbox — a private prototype's JS, CSS and bridge all resolve under the
 * capability prefix with no cookie involved, so the review iframe can be
 * sandboxed unconditionally in path mode. `anonymouslyReadable` still gates
 * the SUBDOMAIN href, because that mode is the cookie-free story on a
 * genuinely separate origin and deliberately takes no capability (its
 * cross-origin boundary is already real; a capability would only add a
 * prefix that subdomain mode exists to avoid needing).
 *
 * The one residue: when NO capability can be minted — `auth` unconfigured,
 * so `VIEWER_SESSION_SECRET` is absent — a private prototype falls back to
 * the old same-origin, unsandboxed behaviour. That combination is close to
 * vacuous in practice (no session secret means no sessions, hence no users,
 * hence no project members, hence no private project), and failing closed
 * instead would black-hole the review surface on an unauthenticated
 * deployment for no security gain.
 *
 * ## The path-mode sandbox
 *
 * The absence of `allow-same-origin` IS the mechanism — it is what creates
 * the opaque origin. Two further omissions are equally deliberate: no
 * `allow-popups` (the `window.open('/api/v1/…')` lane, finding B2) and no
 * `allow-top-navigation` (drive-by navigation of the reviewer's tab).
 * `allow-scripts` and `allow-forms` are the minimum a prototype needs to be
 * a prototype. Cost, accepted: an opaque origin has no storage, so a
 * sandboxed prototype touching `localStorage`/`sessionStorage`/
 * `document.cookie` throws (measured: `SecurityError`).
 *
 * ## Loopback and subdomain modes: a real origin, sandboxed anyway
 *
 * Prototype-origin isolation (Milestone 2, `resolvePrototypeEmbed` below)
 * gives some prototypes a REAL origin instead of the shell's — a loopback
 * listener's own `127.0.0.1:{port}`, or a `{slug}.{serveDomain}` host. That
 * changes the storage cost above: on a real origin, `allow-same-origin` is
 * safe to grant (see `CROSS_ORIGIN_IFRAME_SANDBOX`'s own comment for why),
 * so `localStorage`, `document.cookie` and friends work again — the thing
 * the opaque-origin path-mode sandbox above deliberately breaks.
 *
 * Loopback mode's origin boundary has its own cost, worth stating plainly
 * rather than assuming "real origin" means "as isolated as a real deployed
 * host": every loopback port on the machine is reachable by any local
 * process, not just this one, and two prototypes served on the SAME
 * loopback host (`localhost` vs `127.0.0.1`, whichever one the shell is
 * NOT using) at different ports share that host's cookie jar with each
 * other. Acceptable on a single-user laptop, where the whole point is
 * running someone's own dev tools against their own prototypes — but it is
 * not the same guarantee a `{slug}.{serveDomain}` subdomain gives, where
 * every prototype gets a genuinely distinct registrable host.
 */

import { prototypePathPrefix } from "../server/serve/prototype-capability-path"
import type { OriginMode } from "../server/serve/prototype-origin-resolve"
import { prototypeOriginFor } from "../server/serve/subdomain"

/**
 * Re-exported, not defined here any more.
 *
 * The rule it encodes — "public-link, and the instance kill switch is on" —
 * is now needed by a SERVER route as well
 * (`server/api/prototype-origin-routes.ts`), and `server/**` must not import
 * `app/**`. So the one definition moved to
 * `server/serve/prototype-origin-resolve.ts`, which is import-free and was
 * already written to be reachable from a `"use client"` module. Every caller
 * that imports it from here is unaffected.
 */
export { prototypeAnonymouslyReadable } from "../server/serve/prototype-origin-resolve"

/**
 * Which of the three origin modes is in play for one request, as reported by
 * `GET /api/v1/projects/:id/prototype-origin`.
 *
 * Re-exported from the same import-free server module for the same reason:
 * one definition, reachable from both a route and a `"use client"` component.
 * A type import is erased at compile time, so this costs the browser bundle
 * nothing at all.
 */
export type { OriginMode } from "../server/serve/prototype-origin-resolve"

/**
 * The path-mode iframe sandbox. Every omission above is load-bearing —
 * this is not a list to extend when a prototype hits a compatibility snag.
 */
export const PATH_MODE_IFRAME_SANDBOX = "allow-scripts allow-forms"

/**
 * The sandbox for a prototype on a REAL, DIFFERENT origin from the shell —
 * loopback or subdomain mode. `resolvePrototypeEmbed` is the only place
 * allowed to emit this string, and only once it has confirmed the
 * prototype's origin is not the shell's. See the fail-closed check there.
 *
 * The one token this adds over `PATH_MODE_IFRAME_SANDBOX` is
 * `allow-same-origin`. It is safe here for a specific reason: on a
 * CROSS-origin frame, `allow-same-origin` only unsets the sandbox's
 * opaque-origin flag and restores the frame's OWN origin. It grants
 * nothing toward the parent (measured: `parent.location` throws
 * `SecurityError`). On a SAME-origin frame the same token is the classic
 * sandbox escape instead: the frame removes its own `sandbox` attribute
 * from the parent DOM and reloads. That is the whole reason the
 * equal-origin check has to run before this constant can ever be chosen,
 * with no exceptions.
 *
 * Everything else stays denied, each for a named reason (copied from
 * `docs/superpowers/research/2026-08-22-prototype-origin-adversarial-
 * review.md`, "Attack 7"):
 *
 * - `allow-popups`: lets the prototype open a credentialed top-level
 *   window pointed at the shell — tab-nabbing, or a phishing window styled
 *   to look like the viewer.
 * - `allow-popups-to-escape-sandbox`: a popup opened this way would not
 *   even inherit the sandbox, which is worse than plain `allow-popups`.
 * - `allow-top-navigation` / `allow-top-navigation-by-user-activation`:
 *   one click inside the prototype could replace the reviewer's whole tab
 *   — for example with a fake sign-in page.
 * - `allow-downloads`: a drive-by file drop onto the reviewer's machine.
 * - `allow-modals`: lets the prototype spoof the browser's own UI with
 *   `alert`/`confirm`/`print`.
 * - `allow-pointer-lock`, `allow-presentation`, `allow-orientation-lock`:
 *   nuisance capabilities a prototype under review has no reason to need.
 * - `allow-storage-access-by-user-activation`: asks for a cross-site
 *   cookie exception. Nothing here needs one — there is no cross-site
 *   cookie relationship to request in the first place.
 * - `allow-same-site-none-cookies`: exists for a cross-site embed that
 *   still wants first-party cookie treatment. Not needed once the origin
 *   is real.
 */
export const CROSS_ORIGIN_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin"

export interface PrototypeTarget {
  slug: string
  /** `VIEWER_SERVE_DOMAIN`, or `null` in the default path mode. */
  serveDomain: string | null
  /** `VIEWER_PUBLIC_URL`; supplies the scheme for an isolated origin. */
  publicUrl: string
  /**
   * Does `/p/{slug}/**` serve to a request carrying no session cookie?
   * See `prototypeAnonymouslyReadable` — and the module doc for why this,
   * of all things, gates the subdomain href.
   */
  anonymouslyReadable: boolean
  /**
   * A minted read capability for this prototype's active deployment
   * (`server/serve/prototype-capability.ts`), or `null`/absent when none
   * applies — an anonymously-readable prototype needs no credential at
   * all, and the dashboard's top-level "Open" link is an ordinary
   * navigation that still carries the cookie.
   */
  capability?: string | null
}

/**
 * The URL a prototype is reached at: its own origin when a serve domain is
 * configured AND the prototype can be read without the session cookie; the
 * shell's path prefix otherwise — carrying the capability segment when one
 * was minted.
 */
export function prototypeHref(target: PrototypeTarget): string {
  if (!target.serveDomain || !target.anonymouslyReadable) {
    // An anonymously-readable prototype takes the bare prefix even if a
    // capability were somehow supplied: it needs no credential, and a
    // capability in a link that gets copied out of the address bar is a
    // credential with a lifetime attached to something that had none.
    return prototypePathPrefix(target.slug, target.anonymouslyReadable ? null : target.capability)
  }
  return `${prototypeOriginFor(target.slug, target.serveDomain, target.publicUrl)}/`
}

export interface PrototypeIframeProps {
  src: string
  /** Omitted (React drops an `undefined` attribute) when no sandbox applies. */
  sandbox: string | undefined
}

export interface PrototypeEmbedTarget {
  slug: string
  /** The shell's own origin — normally `VIEWER_PUBLIC_URL`, verbatim. */
  shellOrigin: string
  /**
   * The prototype's own origin, as reported by `GET /api/v1/projects/:id/
   * prototype-origin` (`server/serve/prototype-origin-resolve.ts`'s
   * `PrototypeOriginResponse.origin`). `null` when the server has none to
   * offer right now — no deployment yet, or fallback mode.
   */
  prototypeOrigin: string | null
  /** The mode that response reported. Decides which rule below applies. */
  mode: OriginMode
  /**
   * A minted read capability for this prototype's active deployment, or
   * `null` when none applies. Unused in loopback mode — reaching the
   * listener's ephemeral port is itself the credential there.
   */
  capability: string | null
  /** See `prototypeAnonymouslyReadable`. */
  anonymouslyReadable: boolean
}

/**
 * The complete `{ src, sandbox }` pair for the review iframe, computed from
 * ONE resolved prototype origin so the two can never disagree — the same
 * reason `PrototypeIframeProps`'s own doc gives for returning them
 * together rather than as two independent expressions at the call site.
 *
 * FAIL CLOSED, checked before anything else. `prototypeOrigin` must be
 * non-null, must parse as a URL, and — once both it and `shellOrigin` are
 * normalised with `new URL(x).origin` (lowercases the scheme and host,
 * strips any path or trailing slash, and drops a default port) — must NOT
 * equal the shell's normalised origin. If any of that fails, this treats
 * the request exactly like fallback mode below, no matter what `mode`
 * says. That ordering is what makes it structurally impossible for
 * `CROSS_ORIGIN_IFRAME_SANDBOX` — which carries `allow-same-origin` — to
 * ever go out toward a frame that shares the shell's origin. See
 * `docs/superpowers/research/2026-08-22-prototype-origin-adversarial-
 * review.md`, "The fail-open path", for what that would cost: a complete
 * sandbox escape, restoring finding B1 in its worst form.
 *
 * The three modes, once the origin has passed that check:
 *
 * - **loopback**: `src` is the origin, unconditionally, with no capability
 *   in it. The listener is the credential, so there is nothing to carry.
 * - **subdomain**: `src` adds `?~c={capability}` for a private prototype,
 *   or nothing for an anonymously-readable one. A private prototype with
 *   no capability minted has no way to authorize its document load on this
 *   host at all (the session cookie is host-only and never reaches it), so
 *   that case falls back too — same-host and uncontained is a working
 *   review surface; a document the server would 404 is not.
 * - **prototype-origin**: the single shared `VIEWER_PROTOTYPE_ORIGIN`.
 *   Cross-origin like subdomain, so it gets the same sandbox, but
 *   PATH-NAMESPACED: `src` is `{origin}/p/{slug}/`, plus a `~c/{token}`
 *   PATH segment for a private prototype (never a query or cookie — a
 *   cookie on the shared host would leak between prototypes). A private
 *   prototype with no capability falls back, same reasoning as subdomain.
 * - **fallback** (mode says so, or the origin check above failed): today's
 *   unchanged path-prefix behaviour. `sandbox` is `PATH_MODE_IFRAME_SANDBOX`
 *   when the assets are reachable without the session cookie (anonymously
 *   readable, or a capability is present), and `undefined` — today's
 *   pre-existing, uncontained degradation — otherwise.
 *
 * Both isolated modes get `CROSS_ORIGIN_IFRAME_SANDBOX`, not "no sandbox".
 * Earlier, an isolated origin skipped sandboxing entirely on the reasoning
 * that the origin boundary alone was the containment. That boundary stops
 * the prototype reaching the shell's DOM, but does nothing about
 * `window.open`, top-level navigation or downloads — the three-token
 * sandbox denies those regardless of which origin the frame is on.
 */
export function resolvePrototypeEmbed(target: PrototypeEmbedTarget): PrototypeIframeProps {
  const isolatedOrigin = resolveIsolatedOrigin(target.prototypeOrigin, target.shellOrigin)

  if (isolatedOrigin && target.mode === "loopback") {
    return { src: `${isolatedOrigin}/`, sandbox: CROSS_ORIGIN_IFRAME_SANDBOX }
  }

  if (isolatedOrigin && target.mode === "subdomain") {
    if (target.anonymouslyReadable) {
      return { src: `${isolatedOrigin}/`, sandbox: CROSS_ORIGIN_IFRAME_SANDBOX }
    }
    if (target.capability) {
      return {
        src: `${isolatedOrigin}/?~c=${target.capability}`,
        sandbox: CROSS_ORIGIN_IFRAME_SANDBOX,
      }
    }
    // Private, and no capability to authorize the document load: fall
    // through to fallback below rather than emit a subdomain URL the
    // server would 404.
  }

  if (isolatedOrigin && target.mode === "prototype-origin") {
    // The single shared origin: cross-origin from the shell, so the
    // cross-origin sandbox applies, but PATH-NAMESPACED under `/p/{slug}/`
    // because no prototype owns `/` on the shared host. The capability rides
    // the PATH (`~c/{token}`), NOT a query or a cookie: a `dsv_cap` cookie on
    // the shared host would be sent to every prototype on it (cross-prototype
    // leak), which is exactly why this mode reuses the path form the shell's
    // own path mode uses.
    if (target.anonymouslyReadable) {
      return {
        src: `${isolatedOrigin}${prototypePathPrefix(target.slug, null)}`,
        sandbox: CROSS_ORIGIN_IFRAME_SANDBOX,
      }
    }
    if (target.capability) {
      return {
        src: `${isolatedOrigin}${prototypePathPrefix(target.slug, target.capability)}`,
        sandbox: CROSS_ORIGIN_IFRAME_SANDBOX,
      }
    }
    // Private, and no capability to authorize the subresource reads: fall
    // through to the same-host path prefix below rather than emit a shared
    // origin URL whose assets the server would 404.
  }

  // Fallback: `mode === "fallback"`, no usable isolated origin (the
  // fail-closed check above), or a subdomain request this prototype
  // cannot authorize without the cookie it will never receive there.
  const cookieFreeAssets = target.anonymouslyReadable || Boolean(target.capability)
  return {
    src: prototypePathPrefix(target.slug, target.anonymouslyReadable ? null : target.capability),
    sandbox: cookieFreeAssets ? PATH_MODE_IFRAME_SANDBOX : undefined,
  }
}

/**
 * The normalised prototype origin when it is safe to isolate toward, or
 * `null` when it is not: absent, unparsable, or equal to the shell's own
 * origin after normalisation. See `resolvePrototypeEmbed`'s doc for why
 * this runs before anything else.
 */
function resolveIsolatedOrigin(prototypeOrigin: string | null, shellOrigin: string): string | null {
  if (!prototypeOrigin) return null
  try {
    const prototype = new URL(prototypeOrigin).origin
    const shell = new URL(shellOrigin).origin
    return prototype === shell ? null : prototype
  } catch {
    // Either URL failed to parse. Fail closed: no isolated origin.
    return null
  }
}

/**
 * The origin the review iframe's document will ACTUALLY be on, or `null` when
 * it will not be on one this shell can name — either because the embed fell
 * back to the shell's own path prefix, or because that fallback is sandboxed
 * into an opaque origin.
 *
 * The shell pins its outbound `postMessage` target to this value
 * (`review/use-viewer-bridge.ts`), which is what stops a prototype that
 * navigates ITSELF to a hostile page from continuing to receive every comment
 * body and participant email the shell posts (`docs/superpowers/research/
 * 2026-08-22-prototype-origin-adversarial-review.md`, "Attack 6").
 *
 * DERIVED from `resolvePrototypeEmbed`'s own answer rather than re-deciding
 * the same question, and that is the whole design of this function. Three of
 * that resolver's branches produce an isolated origin and then decline to use
 * it: an origin equal to the shell's, a loopback mode with nothing built, and
 * a private subdomain with no capability. A second copy of that switch would
 * only have to drift once for the shell to pin a target the frame is not on —
 * and the failure would be silent and total, because a message posted to a
 * mismatched target is dropped with no error anywhere. Reading the resolved
 * `src` back means there is one decision, not two that have to agree.
 *
 * A relative `src` (the path prefix) throws in `new URL`, which is exactly the
 * `null` this wants: same-host means either an opaque origin (sandboxed) or
 * the shell's own, and neither is a prototype origin worth pinning.
 */
export function prototypeEmbedOrigin(target: PrototypeEmbedTarget): string | null {
  const { src } = resolvePrototypeEmbed(target)
  try {
    return new URL(src).origin
  } catch {
    return null
  }
}
