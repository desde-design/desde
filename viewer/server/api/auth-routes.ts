import { randomUUID } from "node:crypto"
import { Router, type Request, type Response } from "express"
import type { AppDeps } from "../create-app"
import { resolveReadContext } from "../auth/authorize"
import { getCurrentUser } from "../auth/current-user"
import { SIGN_IN_LINK_TTL_MINUTES } from "../auth/auth-constants"
import { revokeAllCredentials } from "../auth/credential-revocation"
import { admitSignIn, matchDomainRule, type SignInProfile } from "../auth/gate"
import {
  generateOneTimeToken,
  oneTimeTokenMatches,
  parseOneTimeToken,
} from "../auth/one-time-token"
import { signInEmail } from "../notify/auth-email"
import {
  linkNotValidPageHtml,
  navigationRequiredPageHtml,
  signInConfirmPageHtml,
} from "./auth-confirm-page"
import { registerAuthPageAssets } from "./auth-page-assets"
import { INVITE_ACCEPT_PATH, SIGN_IN_ACCEPT_PATH, signInUrl } from "./auth-urls"
import { DEFAULT_RETURN_PATH, safeReturnPath } from "./return-path"
import { normalizeEmailInput } from "./validate-email"
import {
  isLocalOperatorUser,
  localOperatorTokensMatch,
  signInLocalOperator,
} from "../auth/local-operator"
import {
  clearSessionCookie,
  readCookie,
  serializeSessionCookie,
  sessionCookieName,
  signSessionId,
  verifySessionCookie,
} from "../auth/session-cookie"
// The state-cookie machinery moved to `state-cookie.ts` when the GitHub App
// Manifest flow needed the same three rules under a DIFFERENT cookie name.
// Copying them would have been two implementations of one security control;
// see that file's doc comment for why the name has to be a parameter.
import {
  clearStateCookie,
  isSecurePublicUrl,
  serializeStateCookie,
  stateCookieName,
  statesMatch,
} from "./state-cookie"

const OAUTH_STATE_COOKIE_NAME = "viewer_oauth_state"
/**
 * Where to land after a successful GitHub sign-in, when the flow was started
 * from somewhere that wants the reader back (2026-08-29).
 *
 * Its own cookie rather than a `next` on the state value, for two reasons:
 * the state is echoed through github.com and this path is nobody's business
 * but ours, and `statesMatch` compares the whole value, so smuggling a second
 * field into it would break the compare. Same HttpOnly/Lax/Secure rules —
 * `state-cookie.ts` is the one place those are written down.
 *
 * The value is only ever a path `safeReturnPath` has already accepted, and it
 * is re-validated on the way OUT as well: a cookie is client-supplied input,
 * so trusting it because we set it once is exactly the assumption an
 * open-redirect lives in.
 */
const OAUTH_RETURN_COOKIE_NAME = "viewer_oauth_return"
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

/**
 * How long a SELF-REQUESTED magic link lives, derived from the ONE constant
 * the email template also reads (`auth-constants.ts`). The number and the
 * sentence a recipient reads must not be able to disagree.
 */
const MAGIC_LINK_EXPIRES_MS = SIGN_IN_LINK_TTL_MINUTES * 60 * 1000

/**
 * How long after minting a link for a subject the route refuses to mint
 * another. See the throttle block in `POST /auth/magic-link`.
 */
const MINT_THROTTLE_MS = 60 * 1000

/**
 * The 409 body `POST /auth/magic-link` answers with when this deployment
 * cannot send mail. One constant because the test that matters asserts every
 * input gets the SAME bytes.
 */
const EMAIL_SIGN_IN_UNAVAILABLE = "Email sign-in isn't set up on this viewer"

/** Where every dead sign-in link lands. See the route's doc comment. */
const LINK_INVALID_REDIRECT = "/denied?reason=link-invalid"

/**
 * The synthetic profile the email lanes present to the gate — see
 * `SignInProfile`'s doc comment. `displayName` is the address's local part
 * because there is no provider to read a real name from, and `provider:
 * "email"` is what stops the gate from writing that placeholder over an
 * existing account's real name and avatar (gate.ts, rung 1).
 */
function emailProfile(email: string, displayName?: string): SignInProfile {
  const at = email.indexOf("@")
  return {
    provider: "email",
    providerUserId: null,
    email,
    displayName: displayName || (at > 0 ? email.slice(0, at) : email),
    avatarUrl: "",
  }
}

/**
 * Audit K08's rule, in one place: refusing a REMOVED account's new sign-in is
 * not enough on its own. Sessions and machine tokens that account minted while
 * it was still active authorize against the STORED row, so they outlive the
 * removal and keep working until something explicitly kills them.
 *
 * Every door into the gate needs this, which is exactly why it is a function.
 * It shipped wired to the GitHub callback and not to the invite route, and the
 * gap survived review because each door reads fine on its own — a removed
 * account clicking an old invite link kept its live session and its PAT. There
 * are three doors now (GitHub, invite, sign-in link) and they share one
 * implementation.
 *
 * Best-effort and never fatal: the caller's refusal redirect is the answer
 * either way, and a storage hiccup here must not turn a policy refusal into a
 * 500.
 *
 * Fix wave 10, item 3: the four revocations below now go through the shared
 * `revokeAllCredentials` (`auth/credential-revocation.ts`) — the same helper
 * `instance-routes.ts` uses when an admin removes or restores a member. That
 * helper runs all four independently via `Promise.allSettled` rather than a
 * sequential await chain, so one failing does not leave the ones after it
 * never even attempted. This call site stays best-effort on top of it — a
 * failure is only logged, never surfaced — because a refused sign-in's
 * response is already decided.
 */
async function revokeStandingCredentials(
  deps: Pick<AppDeps, "storage">,
  userId: string,
  /**
   * The refused account's own address — read straight off the row the
   * caller already looked up, never off the request. Fix wave 9, item 3:
   * needed to reach an EMAIL-linked sign-in token below, which names no
   * account and so cannot be found by `userId` alone.
   */
  email: string,
  via: string,
): Promise<void> {
  const result = await revokeAllCredentials(deps.storage, { id: userId, email })
  for (const failure of result.failures) {
    console.error(
      `[viewer] failed to revoke ${failure.step} for a refused ${via} sign-in:`,
      failure.error,
    )
  }
}

/**
 * The GET half of a one-time link: an inert confirmation page whose one
 * button POSTs back to the same path (see `auth-confirm-page.ts` for why a
 * link must not redeem itself on a bare GET).
 *
 * **Format only.** `parseOneTimeToken` is a pure function of the string, so
 * nothing here touches storage and nothing here can distinguish a live token
 * from a random well-formed one — that distinction is the membership oracle
 * the redemption route's uniform `/denied` redirect exists to close, and
 * rendering it into a page would hand it over for free.
 *
 * `Cache-Control: no-store` because the URL carries a credential: a shared
 * cache, a corporate proxy, or the browser's own back-forward cache holding
 * this page is a copy of that credential nobody asked for.
 */
function sendSignInConfirmation(
  res: Response,
  expectedPrefix: "dsi" | "dss",
  token: string,
  basePath: string,
): void {
  res.setHeader("Cache-Control", "no-store")
  const parsed = parseOneTimeToken(token)
  if (!parsed || parsed.prefix !== expectedPrefix) {
    res.status(404).type("html").send(linkNotValidPageHtml())
    return
  }
  // Safe to interpolate: `parseOneTimeToken` matched the whole string against
  // `^(dsi|dss)_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$`, so there is nothing in it
  // that needs URL-encoding. It is HTML-escaped in the template regardless.
  res.status(200).type("html").send(signInConfirmPageHtml(`${basePath}/${token}`))
}

/**
 * The POST half's own guard: a redemption must arrive as a top-level
 * navigation FROM THIS SITE, which is what submitting the confirmation
 * page's own form is.
 *
 * `createDocumentDestinationGuard` (api-router.ts) already refuses these two
 * paths for every OTHER document destination — iframe, frame, object, embed —
 * so the only case left there is the header being ABSENT, where that guard
 * deliberately fails OPEN so curl and every non-browser client keep working.
 * Failing open is right for a read; it is wrong for the one request that
 * spends a credential, because "no `Sec-Fetch-*` at all" is precisely what a
 * scripted or scanner-issued POST looks like. `Sec-Fetch-Dest` is a forbidden
 * header name, so page JS cannot forge it and only a real browser navigation
 * produces it.
 *
 * **`Sec-Fetch-Site` (fix wave 7, item 3) closes the gap `Sec-Fetch-Dest`
 * alone leaves open: `document` says the request is a top-level navigation,
 * it does not say where the navigation STARTED.** A cross-site page can
 * carry a real `<a href>` to this exact path, or an auto-submitting form —
 * both are `document` too. The confirmation page's own form submit is
 * always `same-origin` (page and action share this origin), so that is the
 * only value accepted; a cross-site value or an absent header are refused
 * the same way, for the same "an absent forbidden header is what a script
 * looks like" reasoning the dest check already uses.
 *
 * Refused BEFORE the token is claimed — a refusal must never burn the link.
 *
 * **HTML, not JSON, on refusal (fix wave 7, item 4).** The caller here is
 * always a real browser mid-navigation — it just submitted the confirmation
 * page's form — so a bare `{"error":…}` body renders as unreadable raw text
 * with no way forward. That is the ordinary shape of a browser old enough to
 * send no Fetch Metadata headers at all (Safari before 16.4): the refusal is
 * routine there, not an attack, and deserves a page that says so and how to
 * recover. `navigationRequiredPageHtml` echoes no token and offers no form —
 * see its own doc comment. Status stays 403 either way.
 */
function requireDocumentNavigation(req: Request, res: Response): boolean {
  const dest = (req.get("sec-fetch-dest") ?? "").toLowerCase()
  const site = (req.get("sec-fetch-site") ?? "").toLowerCase()
  if (dest === "document" && site === "same-origin") return true
  // Parity with `sendSignInConfirmation`'s GET page (fix wave 8, item 3):
  // this refusal is reached by the same credential-bearing URL, so a shared
  // cache or the browser's own back-forward cache must not hold a copy.
  res.setHeader("Cache-Control", "no-store")
  res.status(403).type("html").send(navigationRequiredPageHtml())
  return false
}

/**
 * The session-mint sequence, extracted from the two byte-identical copies
 * this file used to carry: the GitHub callback and the invite-accept route
 * each built an expiry, created the storage row, signed the session id, and
 * serialized it into a `Set-Cookie` value — the same four lines, twice.
 *
 * Returns the serialized cookie VALUE rather than writing the header itself,
 * because the call sites don't agree on how to attach it: the GitHub callback
 * `res.append`s (there is already a state cookie on the response, and
 * `setHeader` would clobber it), the invite and sign-in-link routes
 * `res.setHeader` (nothing else on those responses uses `Set-Cookie`). That's
 * the one thing left for each call site to keep doing itself.
 */
async function mintSessionCookieValue(
  deps: Pick<AppDeps, "storage" | "config">,
  userId: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
  const session = await deps.storage.createSession({ userId, expiresAt })
  const signed = signSessionId(deps.config.sessionSecret, session.id)
  return serializeSessionCookie(signed, {
    secure: isSecurePublicUrl(deps.config.publicUrl),
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
  })
}

/**
 * Sign-in and identity.
 *
 * ## Every route here registers unconditionally
 *
 * It did not use to. `/auth/github` and `/auth/github/callback` were
 * registered only when `config.githubAuth` was set, and `/auth/local` only
 * when it was null; both decisions were taken ONCE, when the router was
 * built.
 *
 * The GitHub App Manifest flow makes that wrong in both directions. It
 * produces a real identity provider mid-process, and routes are registered
 * at construction — so an App created that way would have a live provider
 * that no registered route could reach, and GitHub sign-in would 404 until a
 * restart: exactly the restart the runtime holder exists to remove.
 * Symmetrically, the stdout-printed local-operator token would keep working
 * alongside that new real provider, which is precisely the "never a second
 * way in" rule the local route is built on.
 *
 * So registration is now static and the DECISION is per-request, read off
 * `deps.github.authProvider` (see `github-runtime.ts`):
 *
 * - `GET /me` and `POST /auth/logout` — always answer. Both are capabilities
 *   of the SESSION, and a session no longer requires GitHub.
 * - `GET /auth/github` and `GET /auth/github/callback` — fall through when
 *   there is no provider.
 * - `GET /auth/local` — the inverse guard: it falls through the moment a
 *   provider EXISTS, so the printed token stops working when the manifest flow
 *   completes rather than at the next restart. It also 404s when no
 *   `localOperatorToken` was minted at boot.
 *
 * ## Why the disabled cases call `next()` rather than sending a 404
 *
 * A hand-written 404 body is a FINGERPRINT. `/auth/local` answering
 * `{"error":"Not found"}` while an unregistered path answers
 * `{"error":"Not found: GET /api/v1/auth/local"}` tells an anonymous caller
 * the difference between "this deployment minted a boot token and has since
 * grown a real provider" and "no token was ever minted" — a fact about the
 * deployment's credentials, given away for free, on an unauthenticated route.
 *
 * Falling through hands the request to the router's own terminal 404
 * (`api-router.ts`), which is the exact response an unregistered path
 * produces. Not a similar one: the same code path, so the two cannot drift
 * apart later either.
 */
export function createAuthRoutes(deps: AppDeps): Router {
  const router = Router()

  // The illustration and the wordmark's typeface, for the server-rendered
  // sign-in pages below. Public, credential-free and cacheable, unlike every
  // other route in this file.
  registerAuthPageAssets(router)

  // Always available, GitHub-configured or not: identity resolution no
  // longer depends on GitHub being configured — a session is a capability
  // of the viewer itself (`config.sessionSecret` is always present).
  // `authEnabled` is what lets a caller
  // (e.g. Task 4's sign-in chip) distinguish "signed out" from "auth isn't
  // configured on this deployment at all" — `user: null` alone is
  // ambiguous between those two states, `authEnabled` disambiguates it.
  router.get("/me", async (req, res) => {
    // Phase 3b-2: resolve through `resolveReadContext`, not `getCurrentUser`,
    // so this endpoint obeys the same bearer rules as every other route under
    // `/api/v1/**`. It previously read the cookie ONLY, which made `/me` the
    // single bearer-blind route in the API — and it is precisely the route a
    // machine client points at to ask "is my token alive?". A valid PAT got
    // `{"user":null}` and a valid PAT, a revoked PAT, and no credential at
    // all were byte-identical, so a token holder had no way to tell a live
    // credential from a dead one. Found by live acceptance; the unit suite
    // was green at 658.
    const ctx = await resolveReadContext({ storage: deps.storage, config: deps.config }, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const user = ctx.user
    // Per-user response keyed only on the `Cookie` header — an intermediary
    // cache (nginx `proxy_cache`, Varnish, a CDN) that doesn't know that
    // would happily store this by URL alone and serve user A's identity to
    // user B. `no-store` forbids caching outright; `Vary: Cookie` is
    // belt-and-braces for any cache that ignores `no-store` but does
    // respect `Vary`.
    res.setHeader("Cache-Control", "private, no-store")
    // `Authorization` as well as `Cookie`: this response is keyed on the
    // BEARER too (resolveReadContext accepts a PAT, and `scopes` describes
    // that PAT specifically). An intermediary that ignores `no-store` but
    // honours `Vary` — exactly the cache this header is defending against —
    // would otherwise be free to serve one token holder's identity and
    // scopes to a different token, or to an anonymous caller.
    res.setHeader("Vary", "Cookie, Authorization")
    // `scopes` completes the "is my token alive?" answer this route already
    // exists to give: alive is not the same as sufficient. A machine client
    // otherwise cannot discover what its own credential may do, so a
    // read-scoped PAT looks identical to a write-scoped one until the first
    // write 403s — and the Editor's connect flow accepted exactly that,
    // storing a token that could never post a comment (the viewer's token UI
    // defaults to read-only, so this is the DEFAULT path, not an edge case).
    //
    // No disclosure concern: a caller learns only what its own credential
    // carries. `null` means "not a machine token" — a browser session, which
    // is not scope-limited in the same way — and is deliberately distinct
    // from `[]`.
    // `authEnabled` stays keyed on GitHub sign-in specifically, not on
    // whether a session is possible (it always is now).
    //
    // Read off the RUNTIME, not `deps.config`. The boot snapshot answers
    // "was GitHub configured when this process started", and after the
    // manifest flow that is a different question from "can this visitor sign
    // in with GitHub right now" — which is the one the account menu asks.
    // The live provider is also the more honest predicate: it is the very
    // thing `/auth/github` checks, so the advertisement and the route it
    // advertises cannot disagree.
    const provider = deps.github.authProvider
    res.json({
      user,
      authEnabled: provider !== undefined,
      // The path a signed-out visitor should be sent to, or null when this
      // deployment has no provider they can use. Deliberately omits the
      // local-operator URL: that one carries a secret in its query string
      // and reaches its operator through stdout, never through a public
      // endpoint.
      signInUrl: provider !== undefined ? "/api/v1/auth/github" : null,
      // Whether `/signin` (Task 15) should offer the email form.
      //
      // This used to read `deps.config.email` on the stated grounds that
      // "SMTP has no equivalent live reconfiguration story: it is set once,
      // at boot". That stopped being true on 2026-08-26, when mail settings
      // became editable from the instance settings page. It now asks the live
      // provider the same question `POST /auth/magic-link` gates on, so the
      // form appears and disappears with the setting instead of with a
      // restart.
      //
      // `deps.config.email` is still updated in step by the settings route,
      // so the two agree — but only one of them is the thing that actually
      // sends, and that is the one to ask.
      emailSignInEnabled: deps.email?.isConfigured() ?? false,
      scopes: ctx.scopes,
    })
  })

  // Computed once: `publicUrl` is boot-stable (see `GithubRuntime.config`),
  // and every cookie-setting route below needs it — `/auth/local` and
  // `/auth/logout` included, both of which answer whether or not GitHub
  // sign-in is configured.
  const secure = isSecurePublicUrl(deps.config.publicUrl)

  // Registered whenever a boot token was minted at all. The mutual exclusion
  // with GitHub sign-in did not go away — it moved INTO the handler, because
  // it now has to hold against a provider that appears mid-process. A
  // deployment with a real identity provider must not also carry a
  // stdout-printed master key, and "must not" has to mean "from the instant
  // the provider exists", not "from the next restart".
  const localToken = deps.localOperatorToken
  if (localToken) {
    router.get("/auth/local", async (req, res, next) => {
      // The inverse of the GitHub guard below, checked FIRST and before any
      // await: once a real provider exists this route is gone. `next()`, not a
      // 404 of its own — see the fingerprinting note in this file's doc
      // comment.
      if (deps.github.authProvider) {
        next()
        return
      }
      const supplied = typeof req.query.token === "string" ? req.query.token : ""
      if (!supplied || !localOperatorTokensMatch(supplied, localToken)) {
        res.status(401).json({ error: "Invalid sign-in token" })
        return
      }
      const result = await signInLocalOperator(deps.storage, SESSION_MAX_AGE_SECONDS)
      if (!result.admitted) {
        // The operator's row was explicitly removed (Members panel, or the
        // adminToken bearer) — the boot token holder can no longer self-admit
        // once that happens. Recovery is another admin restoring the row, or
        // the adminToken bearer acting in its place; there is no third way
        // back in. Same `/denied` shape every other gate refusal uses, so
        // this never becomes a membership oracle either.
        res.redirect(302, "/denied")
        return
      }
      const signed = signSessionId(deps.config.sessionSecret, result.sessionId)
      res.setHeader(
        "Set-Cookie",
        serializeSessionCookie(signed, { secure, maxAgeSeconds: SESSION_MAX_AGE_SECONDS }),
      )
      res.redirect(302, "/")
    })
  }

  // Unconditional, and deliberately so. Signing out needs only the session
  // secret (always present) and storage — nothing about it is GitHub-specific.
  // It used to be registered behind a `if (!githubAuth) return router` early
  // return, which left a local-operator session with no way to end: the
  // account menu's sign-out 404'd on exactly the deployment that has no other
  // way in. That early return is gone now (registration is static, the
  // decision is per-request), but this route must stay outside any provider
  // check for the same reason it was moved.
  router.post("/auth/logout", async (req, res) => {
    // On https the live cookie is `__Host-viewer_session`; read only that name,
    // matching the hard cutover in `getCurrentUser`.
    const raw = readCookie(req.headers.cookie, sessionCookieName(secure))
    if (raw) {
      const sessionId = verifySessionCookie(deps.config.sessionSecret, raw)
      // Deleting the storage row (not just clearing the cookie) is the
      // point: a stolen/cached cookie value must stop working too, not
      // merely disappear from this one browser.
      if (sessionId) await deps.storage.deleteSession(sessionId)
    }
    res.setHeader("Set-Cookie", clearSessionCookie({ secure }))
    res.status(204).send()
  })

  // `publicUrl` is boot-stable (see `GithubRuntime.config`), so the redirect
  // URI can still be computed once, at construction.
  //
  // This MUST stay derived from `config.publicUrl`. It must never be built
  // from the request's Host header, even though other per-request values
  // (the bridge's `data-shell-origin`, the prototype CSP's `frame-ancestors`)
  // legitimately are. Here is why.
  //
  // `/auth/github` is exempt from the document-navigation guard (it has to
  // be — a real sign-in click is a top-level navigation, which is exactly
  // what that guard would otherwise refuse). That means a hostile prototype
  // can self-navigate an iframe straight into this route:
  // `location.href = "/api/v1/auth/github"`. If this route answered with a
  // `redirect_uri` naming whatever host the framed request arrived on, the
  // OAuth callback would return to THAT host, mint the state cookie there,
  // and complete a full sign-in — handing the reviewer's session to the
  // prototype's own origin. `config.publicUrl` is what stops it: the
  // callback always returns to the shell's real host, so a state cookie set
  // on a prototype host never matches, and the exchange fails.
  //
  // Do not generalise this the way `shellOrigin` is generalised elsewhere.
  // See the adversarial review, Attack 1b ("Iframe self-navigation to an API
  // route") — this is the one line it names as load-bearing and accidental.
  const redirectUri = `${deps.config.publicUrl}/api/v1/auth/github/callback`

  router.get("/auth/github", (req, res, next) => {
    const provider = deps.github.authProvider
    if (!provider) {
      next()
      return
    }
    const state = randomUUID()
    res.setHeader("Set-Cookie", serializeStateCookie(OAUTH_STATE_COOKIE_NAME, state, secure))
    /*
      `?next=` — where to land afterwards. Validated HERE rather than at the
      callback so a hostile value never reaches a cookie at all; see
      `safeReturnPath`, which is total and falls back to "/".

      This ALWAYS writes the cookie: the real path when there is one, and an
      expiry otherwise. Only writing it in the first case left a real defect
      (found by a codex review, 2026-08-29): a connect flow that is abandoned
      before its callback leaves the cookie standing for its full ten minutes,
      and an ordinary sign-in started in that window would consume it. Someone
      who pressed "Sign in" from the dashboard would be redirected into a repo
      dialog they had walked away from, and on into GitHub, because the stale
      path still carried the flow's own marker.
    */
    const returnPath = safeReturnPath(req.query.next)
    res.append(
      "Set-Cookie",
      returnPath === DEFAULT_RETURN_PATH
        ? clearStateCookie(OAUTH_RETURN_COOKIE_NAME, secure)
        : serializeStateCookie(OAUTH_RETURN_COOKIE_NAME, returnPath, secure),
    )
    res.redirect(302, provider.authorizeUrl(state, redirectUri))
  })

  router.get("/auth/github/callback", async (req, res, next) => {
    // Local const, read before this handler's first await — the field is
    // mutable, so narrowing on `deps.github.authProvider` would not survive
    // the `exchangeCode` await below, and a reload mid-callback must not swap
    // the provider out from under a half-finished exchange.
    const provider = deps.github.authProvider
    if (!provider) {
      next()
      return
    }
    const stateParam = typeof req.query.state === "string" ? req.query.state : ""
    // Hard cutover: on https ONLY `__Host-viewer_oauth_state` is read, so a
    // plain-named cookie tossed by a sibling host cannot satisfy this check.
    const stateCookie = readCookie(
      req.headers.cookie,
      stateCookieName(OAUTH_STATE_COOKIE_NAME, secure),
    )

    /*
      Where the flow asked to land, read BEFORE anything can fail.

      Re-validated rather than trusted: this arrives as a cookie, which is
      client-supplied input, and "we set it ourselves a minute ago" is
      precisely the assumption an open-redirect lives inside.
    */
    const returnCookie = readCookie(
      req.headers.cookie,
      stateCookieName(OAUTH_RETURN_COOKIE_NAME, secure),
    )

    /*
      Both cookies cleared on every response path from here down, success or
      failure. The state cookie is single-use regardless of outcome, and the
      return cookie has to die with it: a callback that 400s on a bad state
      used to leave the return path standing for its full ten minutes, so the
      NEXT sign-in would consume it and be steered into a flow that had
      already failed.
    */
    res.setHeader("Set-Cookie", [
      clearStateCookie(OAUTH_STATE_COOKIE_NAME, secure),
      clearStateCookie(OAUTH_RETURN_COOKIE_NAME, secure),
    ])

    if (!stateCookie || !stateParam || !statesMatch(stateParam, stateCookie)) {
      res.status(400).json({ error: "Invalid or missing OAuth state" })
      return
    }

    const code = typeof req.query.code === "string" ? req.query.code : ""
    if (!code) {
      res.status(400).json({ error: "code is required" })
      return
    }

    let profile
    try {
      profile = await provider.exchangeCode(code, redirectUri)
    } catch (err) {
      // Never echo the provider's raw error body to the client — it can
      // carry provider-internal detail that isn't ours to expose. Log it
      // server-side and answer with a generic message instead.
      console.error("[viewer] GitHub OAuth exchange failed:", err)
      res.status(502).json({ error: "Failed to complete GitHub sign-in" })
      return
    }

    // Who this browser ALREADY was, resolved once and used twice: the
    // admission gate needs it (rung 4 — the local-operator handoff), and so
    // does the membership handoff further down. Deliberately resolved BEFORE
    // admission, because admission is what replaces the session, and after it
    // the previous identity is no longer discoverable.
    //
    // `getCurrentUser` rather than reading the cookie directly, so an expired,
    // forged or swept session is `null` here exactly as it is on every other
    // route. It never throws.
    const previous = await getCurrentUser({ storage: deps.storage, config: deps.config }, req)

    // THE admission decision, at the ONE place an account is created. Run
    // after the provider exchange (a verified email is the only one worth
    // checking — a client-supplied one would be worthless) and before anything
    // is written, so a refused sign-in leaves no user row, no session, and
    // nothing for a later membership invite to resolve against.
    const admission = await admitSignIn({ storage: deps.storage }, profile, {
      localOperatorHandoff: previous !== null && isLocalOperatorUser(previous),
    })

    if (!admission.admitted) {
      if (admission.reason === "removed") {
        // Refusing the NEW sign-in is not enough on its own (audit K08).
        // Sessions and machine tokens this account minted while it was still
        // active outlive the removal — they authorize against the STORED row,
        // and nothing in this branch writes to it. So revoke what the account
        // already holds.
        //
        // Best-effort and never fatal: the redirect is the answer either way,
        // and a storage hiccup here must not turn a policy refusal into a 500.
        try {
          const refused =
            (await deps.storage.getUserByProviderIdentity(
              profile.provider,
              profile.providerUserId,
            )) ??
            // Same normalization the gate applies, so this fallback looks for
            // the row the gate actually found and refused.
            (await deps.storage.getUserByEmail(profile.email.trim().toLowerCase()))
          if (refused) await revokeStandingCredentials(deps, refused.id, refused.email, "GitHub")
        } catch (err) {
          console.error("[viewer] failed to look up a refused sign-in's account:", err)
        }
      }
      // The reason is logged, never shown. `/denied` is byte-identical
      // whatever the cause, so this endpoint cannot be used as a membership
      // oracle: "not invited", "removed" and "conflict" must look the same to
      // an anonymous visitor, or the sign-in page becomes a way to ask which
      // addresses have accounts here.
      console.warn(`[viewer] refused sign-in for ${profile.email} (${admission.reason})`)
      // A redirect, not a JSON 403: this leg of the flow is a top-level
      // browser navigation, so the person must land on a page that explains
      // itself rather than on a raw error body.
      res.redirect(302, "/denied")
      return
    }

    const user = admission.user

    // Ownership handoff across the local → GitHub cutover.
    //
    // Projects created in local mode (the seeded demo included) are owned by
    // the synthetic `operator@localhost` row. The instant a real provider
    // exists, `/auth/local` stops answering — so nobody can ever BE that user
    // again, while the person's GitHub identity is a different row owning
    // nothing. Manual recovery existed (admin bearer → POST members), but the
    // DEFAULT path stranded every project silently.
    //
    // This callback is the one moment where both identities are present at
    // once, which is what makes it the only place the handoff can happen.
    //
    // **Possession of a live local-operator session at this exact moment is
    // the proof of being the operator.** That token was printed to the
    // server's own stdout, so holding a session minted from it is the same
    // evidence the local sign-in route already accepted. Nothing is inferred
    // from the GitHub side, and nothing is claimed: an arbitrary stranger
    // signing in through GitHub carries no operator cookie, so this block is
    // inert for them. That is why there is no race here to lose.
    //
    // `previous` is the ONE `getCurrentUser` lookup for this request, resolved
    // above the gate — the same evidence decides both the gate's rung 4 and
    // this block, so they cannot disagree about whether an operator session
    // was present.
    try {
      if (previous && isLocalOperatorUser(previous)) {
        const projectIds = await deps.storage.listProjectsForUser(previous.id)
        for (const projectId of projectIds) {
          const membership = await deps.storage.getProjectMember(projectId, previous.id)
          if (!membership) continue
          // The operator's OWN row is deliberately left in place. This is a
          // copy, not a move: removing it would trip last-member removal
          // rules and orphan the history their id is stamped on.
          //
          // Idempotent by construction: `addProjectMember` is a no-op for an
          // existing (projectId, userId) pair, so a second sign-in with the
          // cookie still present does nothing new.
          await deps.storage.addProjectMember({
            projectId,
            userId: user.id,
          })
        }
        if (projectIds.length > 0) {
          console.log(
            `[viewer] handed ${projectIds.length} local-operator membership(s) to ${user.email}`,
          )
        }
      }
    } catch (err) {
      // Best-effort, exactly like the installations capture below. The
      // manual paths (Members panel, admin bearer) still exist, so a storage
      // hiccup here must degrade — never fail the sign-in the person just
      // completed and lock them out of the deployment entirely.
      console.error("[viewer] failed to hand local-operator memberships to the GitHub user:", err)
    }

    // C2: close the operator's OWN session now that the handoff has
    // completed. Without this, the boot-printed token's session stays alive
    // in parallel with the brand-new GitHub session — two live ways to act
    // as an admin where the person only meant to switch to the one they just
    // signed in with. The token is a shared secret printed to the server's
    // own stdout (see `local-operator.ts`'s threat model); a session it
    // minted has no reason to keep working once its holder has proven who
    // they are some other way.
    //
    // Scoped to `deleteSessionsForUser`, not the fuller
    // `revokeStandingCredentials` — this is a cleanup of the operator's OWN
    // browser session, not a removal, so any machine token the operator
    // separately minted is left alone.
    //
    // Best-effort, same posture as the membership handoff just above: a
    // storage hiccup here must not fail the sign-in the person just completed.
    if (previous && isLocalOperatorUser(previous)) {
      try {
        await deps.storage.deleteSessionsForUser(previous.id)
      } catch (err) {
        console.error("[viewer] failed to close the local-operator session after handoff:", err)
      }
    }

    // Phase 3c-1b: record which GitHub App installations this user can see.
    // THE ONLY WRITER of that set — it is authorization input for the
    // connect-repo surface, so it must never be derivable from anything a
    // client sends. `undefined` (the provider didn't answer, or isn't a
    // GitHub App provider at all) deliberately leaves the previous set
    // intact; `[]` deliberately clears it, because "can see none" is a real
    // answer. See `ProviderProfile.installationIds`.
    if (profile.installations !== undefined) {
      try {
        await deps.storage.setUserInstallations(
          user.id,
          profile.installations,
          new Date().toISOString(),
        )
      } catch (err) {
        // A storage hiccup here must not block sign-in: the failure mode is
        // restrictive (the stale-or-absent set authorizes nothing until the
        // next successful sign-in), so failing the whole login would trade a
        // recoverable degradation for an outright lockout.
        console.error("[viewer] failed to record GitHub App installations for user:", err)
      }
    }

    // `res.append` here (not `setHeader`, which would clobber the state
    // cookie set above) so both Set-Cookie headers reach the client.
    res.append("Set-Cookie", await mintSessionCookieValue(deps, user.id))

    // Back where the flow started, when it asked. Read and cleared at the top
    // of this handler, so an abandoned or failed flow cannot steer a later
    // sign-in.
    res.redirect(302, safeReturnPath(returnCookie))
  })

  /**
   * The invite link's landing page. Renders, claims nothing — see
   * `sendSignInConfirmation` and `auth-confirm-page.ts`. The POST below is
   * where acceptance actually happens.
   */
  router.get("/auth/invite/:token", (req, res) => {
    sendSignInConfirmation(res, "dsi", String(req.params.token), INVITE_ACCEPT_PATH)
  })

  /**
   * Invite acceptance (viewer-membership Task 6) — the email lane's
   * equivalent of the GitHub callback above. `/instance/invites` mints URLs
   * of the form `/auth/invite/<token>`; the GET above is what they resolve
   * to, and this is what its button posts to.
   *
   * **A POST, not the GET (fix wave 6).** Possession of the URL is sufficient
   * to spend the token, and a URL in an email is fetched by things that are
   * not the recipient — unfurlers, mail security scanners, gateway
   * prefetchers. Every one of those burned the invite before the person
   * clicked. A POST is issued by none of them.
   *
   * Unconditional, like `/auth/logout`: accepting an invite needs only the
   * session secret and storage, nothing GitHub-specific, so it must work on
   * an instance that never configures GitHub at all.
   *
   * The 4-step sequence the brief specifies, in order:
   *
   * 1. Parse the token (`dsi` prefix only — a `dss`/garbage token is not
   *    this route's business).
   * 2. Look the row up by the parsed id.
   * 3. Constant-time hash match against the stored `tokenHash`.
   * 4. Reject an EXPIRED or REVOKED invite.
   *
   * All four failure modes collapse to the SAME redirect —
   * `/denied?reason=invite-invalid` — for the same reason `/denied` itself
   * is reason-blind for a refused gate: distinguishing "wrong token" from
   * "expired" from "revoked" would let a prober narrow down which is true
   * for a given link, and none of that is actionable for a visitor holding
   * a dead link anyway.
   *
   * **`usedAt` IS checked, and a used invite is SPENT (I1).** This used to be
   * deliberately skipped: a second click on an already-used link still
   * reached `admitSignIn`, which readmitted the caller through the gate's
   * rung 1 (existing account, found by email). That made a leaked or
   * screenshotted invite link a live credential to that account for its
   * WHOLE 7-day expiry window, usable by anyone who obtained it, not only
   * the person who first clicked it. A used invite now only ever does one
   * more thing: recognise a caller who is ALREADY signed in, this session, as
   * the exact account the first click created — a convenience for a stale
   * tab or a double-click, not a second admission. Anyone else — no session,
   * or a session for a different account — gets the same
   * `/denied?reason=invite-invalid` as a garbage or expired token. `POST
   * /instance/invites` is the other half of closing this: it refuses to
   * mint an invite for an email that already has an account, active or
   * removed, so a "used invite, no matching account yet" state cannot arise
   * from this route's own creation path — only from an invite that predates
   * an account created some other way.
   */
  router.post("/auth/invite/:token", async (req, res) => {
    if (!requireDocumentNavigation(req, res)) return
    const token = String(req.params.token)
    const parsed = parseOneTimeToken(token)
    const invite =
      parsed && parsed.prefix === "dsi" ? await deps.storage.getInstanceInvite(parsed.id) : null
    const nowIso = new Date().toISOString()
    const usable =
      invite !== null &&
      oneTimeTokenMatches(token, invite.tokenHash) &&
      invite.revokedAt === null &&
      invite.expiresAt > nowIso

    if (!usable) {
      res.redirect(302, "/denied?reason=invite-invalid")
      return
    }

    if (invite.usedAt !== null) {
      // Spent. The only thing this link is still good for is a shortcut back
      // to a session the browser ALREADY has for the account it created —
      // never a fresh admission. `getCurrentUser` never throws (an expired,
      // forged or swept session reads as `null`, same as everywhere else).
      const current = await getCurrentUser({ storage: deps.storage, config: deps.config }, req)
      if (current && current.email === invite.email) {
        res.redirect(302, "/")
        return
      }
      res.redirect(302, "/denied?reason=invite-invalid")
      return
    }

    // Synthetic email-flow profile — see `emailProfile` above.
    const admission = await admitSignIn({ storage: deps.storage }, emailProfile(invite.email), {
      invite,
    })

    if (!admission.admitted) {
      if (admission.reason === "removed") {
        // Symmetric with the GitHub callback's removed-refusal above (audit
        // K08): an old invite link is just another door into the same gate,
        // and a removed account's outstanding session/PAT credentials must
        // not survive a refusal reached through THIS door any more than one
        // reached through GitHub. Best-effort and never fatal — the redirect
        // below is the answer either way.
        try {
          const refused = await deps.storage.getUserByEmail(invite.email)
          if (refused) await revokeStandingCredentials(deps, refused.id, refused.email, "invite")
        } catch (err) {
          console.error("[viewer] failed to look up a refused invite sign-in's account:", err)
        }
      }
      // Generic /denied, no reason — same "never a membership oracle" rule
      // the GitHub callback follows for every refusal reason.
      console.warn(`[viewer] refused invite sign-in for ${invite.email} (${admission.reason})`)
      res.redirect(302, "/denied")
      return
    }

    const user = admission.user
    res.setHeader("Set-Cookie", await mintSessionCookieValue(deps, user.id))
    res.redirect(302, "/")
  })

  /**
   * `POST /auth/magic-link` — ask for a sign-in link by email
   * (viewer-membership Task 14).
   *
   * Two audiences, one response:
   *
   * - an **active** account at that address → a `dss_` token bound to that
   *   `userId`, mailed as a sign-in link;
   * - **no** account, but a domain rule matches the address → a `dss_` token
   *   bound to the ADDRESS, which the gate turns into a new account at the
   *   rule's role when the link is clicked (self-serve domain join);
   * - anything else — an unknown address, or a REMOVED account — nothing is
   *   minted and nothing is sent.
   *
   * ## The oracle rule, and why it shapes the whole handler
   *
   * All three cases answer `202 {"ok":true}`, byte for byte. An
   * unauthenticated endpoint that answered differently for a member would be a
   * membership directory: submit an address, read the response, learn whether
   * that person has an account on this instance — for every address anybody
   * cares to try. That is the same fact `/denied` is reason-blind to protect,
   * and `requireProjectRead`'s byte-identical 404 protects for projects.
   *
   * Three consequences follow, and each is load-bearing:
   *
   * 1. The SMTP check runs FIRST, before the body is even looked at, so the
   *    409 is also identical for every input. A 409 that arrived only for some
   *    addresses would leak by omission.
   * 2. A failed or throwing send still answers 202. The provider's verdict is
   *    a fact about the mail server, but surfacing it here would tell a prober
   *    that a send was ATTEMPTED — which is the membership fact itself.
   * 3. Storage faults are caught for the same reason and logged, never
   *    surfaced.
   *
   * A malformed address is the ONE thing that does answer differently (400).
   * That is not a leak: `normalizeEmailInput` is a pure function of the
   * submitted string, so its answer is something the caller already knew
   * before they sent it, and swallowing it would silently eat a typo instead
   * of telling the person their address is wrong.
   *
   * ## The send is DETACHED, and the response does not wait for it
   *
   * An identical body is not much use if the two cases take visibly different
   * amounts of time to produce it. Awaiting an SMTP round trip inline means a
   * member's request takes as long as the mail server does — hundreds of
   * milliseconds, sometimes seconds — while a stranger's returns in about one.
   * That is not a subtle side channel; it is the membership answer, read off a
   * stopwatch, on a route whose entire design constraint is that there isn't
   * one.
   *
   * So the send is started and the 202 goes out without waiting for it.
   * `.then(onOk, onErr)` rather than a bare floating promise: a provider that
   * breaks its "never throws" contract must land in a log line, not in an
   * unhandled rejection.
   *
   * **Stated honestly: this shrinks the timing channel, it does not close
   * it.** The three no-send cases do not even do the same amount of storage
   * work as each other, let alone as the minting one:
   *
   * | Case | Storage work |
   * | --- | --- |
   * | removed account | one `getUserByEmail` |
   * | unknown address, no rule | `getUserByEmail` + `listDomainRules` |
   * | active member | + a throttle lookup, + one `createSignInToken` write |
   * | domain-rule join | + `countUsers`, + throttle, + the write |
   *
   * So the paths remain distinguishable to somebody willing to average over
   * many samples. Closing that completely would mean doing every lookup on
   * every path and detaching the mint as well — a token written after its own
   * response is a worse bargain than a measurable microsecond. The rate
   * limiter (the `auth` lane, see `rate-limit.ts`) is what bounds how many
   * samples a prober gets, and the per-subject throttle below bounds what they
   * achieve even when they can tell the cases apart.
   */
  router.post("/auth/magic-link", async (req, res) => {
    // FIRST — see the doc comment. The provider, not `config.email`: it is
    // what can actually send, and answering 202 for a send with nowhere to go
    // would be invisible to everybody by construction.
    const provider = deps.email
    if (!provider) {
      res.status(409).json({ error: EMAIL_SIGN_IN_UNAVAILABLE })
      return
    }

    const { email: rawEmail } = (req.body ?? {}) as Record<string, unknown>
    // `normalizeEmailInput` (viewer-membership X5) trims, refuses anything
    // still carrying whitespace or a control character (the classic
    // `victim@example.test\r\nBcc: attacker@evil.test` header-injection
    // payload — this address is handed to a mail transport), runs
    // `isValidEmail`'s loose shape check, and lowercases. Same normalization
    // the gate applies, so the lookup here and the admission decision on the
    // click agree about which row is meant.
    const email = normalizeEmailInput(rawEmail)
    if (email === null) {
      res.status(400).json({ error: "email is invalid" })
      return
    }

    try {
      // Which VARIANT of `dss_` token to mint, or null for "send nothing".
      // Written out rather than folded into one expression because the third
      // case is the one people get wrong, and it deserves to be visible: a
      // `removed` account is in NEITHER branch. The gate refuses it at rung 1
      // whatever its domain rule says, so a link would be a dead end — and
      // mailing one to an address whose access was deliberately revoked is a
      // small harm of its own.
      let mint: { userId: string | null; email: string | null } | null = null
      const existing = await deps.storage.getUserByEmail(email)
      if (existing) {
        // The LOCAL-OPERATOR row is excluded, and this is not a detail. That
        // identity is reachable through exactly one door by design — a token
        // printed to the server's own stdout — and `/auth/local` switches
        // itself off the instant a real provider appears, precisely so a
        // deployment never has two ways into it. Mailing that account a
        // sign-in link would build the second way in, addressed to
        // `operator@localhost`, which on a host running its own MTA is a
        // mailbox somebody may actually be able to read.
        if (existing.status === "active" && !isLocalOperatorUser(existing)) {
          mint = { userId: existing.id, email: null }
        }
      } else if (await matchDomainRule(deps.storage, email)) {
        // …but NOT on an empty instance. This route decides to send because a
        // domain rule matched; redemption re-runs the WHOLE gate ladder, where
        // first-user bootstrap (rung 4) sits above the domain rule (rung 5) so
        // that an empty instance always ends up with an admin. Put those two
        // together — a deployment configured with a GitHub App (so no
        // local-operator row exists) whose `VIEWER_ALLOWED_EMAIL_DOMAINS` was
        // seeded into `viewer` rules at boot — and the FIRST person at that
        // domain to type their address into a sign-in box is admitted as
        // INSTANCE ADMIN, having proved only that they can read their own
        // mail.
        //
        // Neither half is wrong on its own, so neither half is what changes.
        // An empty instance's first account must arrive through a path
        // somebody explicitly opened: GitHub sign-in, the boot-printed
        // local-operator URL, or an adminToken-minted invite. A self-serve
        // domain join is a way to join an instance that already exists, not a
        // way to found one.
        //
        // `countUsers` counts REMOVED accounts too, so an instance whose only
        // account was deleted does not read as empty and reopen this.
        if ((await deps.storage.countUsers()) > 0) {
          mint = { userId: null, email }
        } else {
          // Debug-level only. At warn/error this would be an anonymous caller
          // writing to the operator's log at will.
          console.debug(
            "[viewer] magic-link: domain rule matched on a viewer with no accounts; " +
              "the first account must come from GitHub sign-in, the local-operator URL, or an invite",
          )
        }
      }

      // Per-subject mint throttle. The `auth` rate-limit lane allows 60
      // requests a minute per IP, which without this is 3,600 real emails an
      // hour — to a member's mailbox, or to arbitrary addresses at a ruled
      // domain, from an UNAUTHENTICATED route. That is a mail-bomb relay and
      // a sender-reputation problem before it is anything else.
      //
      // A live unclaimed link is also simply the answer to "send me a link":
      // the person already has one, and minting a second silently invalidates
      // nothing while doubling the mail. Claimed links deliberately do NOT
      // throttle — a spent link must be replaceable immediately.
      //
      // The response does not change. A throttled caller gets the same 202 as
      // everyone else; telling them they were throttled would say "yes, that
      // address is one we send to", which is the oracle the whole route is
      // shaped to avoid.
      if (mint) {
        const now = new Date()
        const recent = await deps.storage.hasRecentSignInTokenForSubject(mint, {
          now: now.toISOString(),
          createdAfter: new Date(now.getTime() - MINT_THROTTLE_MS).toISOString(),
        })
        if (recent) mint = null
      }

      if (mint) {
        const gen = generateOneTimeToken("dss")
        await deps.storage.createSignInToken({
          id: gen.id,
          ...mint,
          tokenHash: gen.tokenHash,
          expiresAt: new Date(Date.now() + MAGIC_LINK_EXPIRES_MS).toISOString(),
        })
        // The ONE place this plaintext is ever written to anything. Never
        // logged, and never in a response — the body below is a constant.
        const { subject, html } = signInEmail({ signInUrl: signInUrl(deps, req, gen.token) })
        // Detached on purpose — see this route's doc comment. Both handlers
        // are supplied so a provider that breaks its never-throws contract
        // becomes a log line rather than an unhandled rejection.
        void provider.send(email, subject, html).then(
          (ok) => {
            if (!ok) console.error(`[viewer] failed to send a sign-in link to ${email}`)
          },
          (err: unknown) => console.error(`[viewer] sending a sign-in link to ${email} threw:`, err),
        )
      }
    } catch (err) {
      // Logged, never surfaced: the response is a constant for a constant
      // SMTP state, and an error shape that varied with the input would be
      // the oracle this route exists to avoid.
      console.error("[viewer] magic-link request failed:", err)
    }

    res.status(202).json({ ok: true })
  })

  /**
   * The sign-in link's landing page — the invite page's twin. Claims
   * nothing; the POST below redeems.
   */
  router.get("/auth/signin/:token", (req, res) => {
    sendSignInConfirmation(res, "dss", String(req.params.token), SIGN_IN_ACCEPT_PATH)
  })

  /**
   * `POST /auth/signin/:token` — redeem a sign-in link. The GET above renders
   * the page whose button posts here; the GET itself touches no storage, so a
   * link-preview bot or a mail scanner following the URL can no longer spend
   * a token the recipient has not clicked yet.
   *
   * Structurally the invite route's twin (parse → look up by id →
   * constant-time hash match → validity checks → gate → session cookie), with
   * two deliberate differences:
   *
   * - **`usedAt` IS checked, and claimed atomically.** The invite route also
   *   treats a used token as spent, but with one narrow exception: a
   *   same-session, same-email re-click there is recognized as a shortcut
   *   back to the account the first click created, and just redirects to
   *   `/` without re-admitting through the gate. This route has no such
   *   exception — a used sign-in link is dead on any re-click, session or
   *   no. A sign-in link is a credential rather than an introduction: one
   *   use, then dead. The claim happens BEFORE the gate runs, so even a
   *   refused redemption burns the token — a link the gate turned away
   *   must not be retryable.
   * - **Every failing outcome is the same redirect**,
   *   `/denied?reason=link-invalid`: a wrong token, an expired one, an
   *   already-used one, a vanished user row, and a gate refusal all land
   *   there. Splitting them would tell whoever holds the link which of those
   *   is true, and none of it is actionable for someone holding a dead link.
   *
   * The token carries EITHER a `userId` (an existing account: a magic link or
   * an admin-issued link) or an `email` (self-serve domain join, no account
   * yet) — exactly one, enforced by storage. Both build an `email`-provider
   * profile, which is what stops a redeemed link from writing a placeholder
   * name and a blank avatar over a real GitHub profile (gate.ts, rung 1).
   *
   * Nothing here decides admission. The gate does, on every click, which is
   * why a domain rule deleted between mint and click refuses: a minted link is
   * a way to prove control of an address, not a standing grant.
   */
  router.post("/auth/signin/:token", async (req, res) => {
    if (!requireDocumentNavigation(req, res)) return
    const token = String(req.params.token)
    const parsed = parseOneTimeToken(token)
    const row =
      parsed && parsed.prefix === "dss" ? await deps.storage.getSignInToken(parsed.id) : null
    const nowIso = new Date().toISOString()
    const usable =
      row !== null &&
      oneTimeTokenMatches(token, row.tokenHash) &&
      row.usedAt === null &&
      row.expiresAt > nowIso

    if (!usable) {
      res.redirect(302, LINK_INVALID_REDIRECT)
      return
    }

    // Atomic and single-use. Two simultaneous clicks (the mail client's link
    // pre-fetch racing the human) cannot both win: the loser's claim returns
    // false and it is refused like any other dead link.
    if (!(await deps.storage.claimSignInToken(row.id, nowIso))) {
      res.redirect(302, LINK_INVALID_REDIRECT)
      return
    }

    let profile: SignInProfile
    if (row.userId !== null) {
      const target = await deps.storage.getUser(row.userId)
      if (!target) {
        // The account was hard-deleted between mint and click. Same redirect
        // as every other dead link — the holder can do nothing about it.
        res.redirect(302, LINK_INVALID_REDIRECT)
        return
      }
      // The stored row's own email, never one from the request: the token
      // names an account, and the gate finds that account by address.
      profile = emailProfile(target.email, target.displayName)
    } else if (row.email !== null) {
      profile = emailProfile(row.email)
    } else {
      // Unreachable: storage enforces exactly one of `userId`/`email` in both
      // impls. Refused explicitly anyway rather than coerced to `""`, because
      // an empty address reaching the gate on an EMPTY instance would hit the
      // first-user bootstrap rung and mint an admin account with no email —
      // a narrowing convenience turning into an account nobody asked for.
      console.error(`[viewer] sign-in token ${row.id} has neither userId nor email`)
      res.redirect(302, LINK_INVALID_REDIRECT)
      return
    }

    const admission = await admitSignIn({ storage: deps.storage }, profile)

    if (!admission.admitted) {
      if (admission.reason === "removed") {
        try {
          const refused = await deps.storage.getUserByEmail(profile.email)
          if (refused) await revokeStandingCredentials(deps, refused.id, refused.email, "sign-in link")
        } catch (err) {
          console.error("[viewer] failed to look up a refused sign-in link's account:", err)
        }
      }
      console.warn(`[viewer] refused sign-in link for ${profile.email} (${admission.reason})`)
      res.redirect(302, LINK_INVALID_REDIRECT)
      return
    }

    res.setHeader("Set-Cookie", await mintSessionCookieValue(deps, admission.user.id))
    res.redirect(302, "/")
  })

  return router
}
