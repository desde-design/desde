/**
 * One-click GitHub App creation, via GitHub's App Manifest flow.
 *
 * The alternative this replaces is a twelve-step form on github.com that an
 * operator has to fill in by hand and then copy five values out of into
 * environment variables — including a multi-line PEM. This turns it into:
 * click a button, confirm on GitHub, come back configured, with no restart.
 *
 * ## The three legs, and who owns each
 *
 * 1. `GET /setup/github/manifest` (here) mints a `state` nonce, pairs it
 *    with an HttpOnly cookie, and hands the browser a manifest describing
 *    the App we want.
 * 2. The BROWSER posts that manifest to github.com as a real form — see
 *    `app/setup/create-github-app-button.tsx`. The viewer never talks to
 *    github.com in this leg, and the form's target URL is what decides
 *    whether the App lands on a personal account or an organization.
 * 3. GitHub creates the App and navigates the browser back to
 *    `GET /setup/github/callback?code=…&state=…` (here), which exchanges
 *    the code for credentials, persists them, and reloads the GitHub
 *    runtime in place.
 *
 * ## Verified against docs.github.com, 2026-08-20
 *
 * Everything below that names a GitHub constant was checked, because the
 * plan this came from was written from memory and got two things wrong:
 *
 * - Personal form target `https://github.com/settings/apps/new?state=…`;
 *   organization target
 *   `https://github.com/organizations/ORG/settings/apps/new?state=…`. POST,
 *   with the manifest JSON in a form field literally named `manifest`.
 *   (Both live in the client component, not here.)
 * - `state` is a QUERY PARAMETER on that form target, not a manifest key,
 *   and GitHub echoes it back on the redirect alongside `code`.
 * - Conversion is `POST /app-manifests/{code}/conversions`, unauthenticated,
 *   returning `id`, `slug`, `pem`, `client_id`, `client_secret`,
 *   `webhook_secret`.
 * - The code is valid for ONE HOUR. Our state cookie is stricter at ten
 *   minutes, deliberately — see `state-cookie.ts`.
 * - The App name may not exceed 34 CHARACTERS and must be unique across all
 *   of GitHub. The person can edit it on GitHub's confirmation page, which
 *   is what makes both of those survivable: a truncated or already-taken
 *   name is a field they retype, not a dead end.
 * - `default_permissions` keys are USUALLY the REST API's permission names —
 *   but not for reading a signed-in person's email address. The REST name,
 *   and the name GitHub's docs and the App's own Settings page use, is
 *   `email_addresses`. The MANIFEST endpoint does not accept that name: it
 *   wants `emails`, and sending `email_addresses` there makes GitHub reject
 *   the whole manifest ("Default permission records resource is not
 *   included in the list"). Docs and implementation disagree; the
 *   implementation wins. MEASURED live against github.com, 2026-08-20.
 *
 * ## Who may call these routes: instance-admin authority, not any signed-in person
 *
 * Both are gated by `requireOperator` below, which accepts `hasAdminAuthority`
 * (the admin bearer, OR an `admin`-role session/account) plus a
 * local-operator SESSION, and nothing else.
 *
 * They were briefly gated by `requireWrite`, the guard the rest of the API
 * uses, and that was wrong. With no `:id` in the path `requireWrite` passes
 * ANY signed-in user. On a deployment that has GitHub sign-in configured but
 * no App yet, that is every reviewer who has ever logged in — and completing
 * this flow provisions a private key, a client secret and repository read
 * access under an App on the CREATOR'S GitHub account, which the whole
 * deployment then builds through. A reviewer being able to install
 * themselves as the deployment's GitHub identity is a privilege escalation,
 * not a write.
 *
 * The accepted credentials, and why each:
 *
 * - **The admin bearer.** The README's existing doctrine is that the admin
 *   token IS the operator; it is the only credential that already means
 *   deployment-wide authority.
 * - **An `admin`-role session or PAT-less account** (viewer-membership I2).
 *   Instance Admins can already do everything else that touches the
 *   deployment as a whole — manage members, domains, every project. Provisioning
 *   the GitHub App the whole instance builds through is the same kind of act,
 *   not a narrower one, so gating it to ONLY the out-of-band bearer/operator
 *   session left every instance Admin unable to run a flow the product
 *   otherwise treats as theirs. (A `dsv_` PAT is still refused even when its
 *   owner is an Admin — see below.)
 * - **A local-operator session** (`isLocalOperatorUser`, keyed on the
 *   unforgeable `local-operator` sentinel), independently of its CURRENT row
 *   role. On a zero-config deployment — the flow this feature exists for —
 *   the person clicking the button reached it through the stdout boot token,
 *   so they ARE the operator whether or not their row has since been
 *   demoted from admin by someone else.
 *
 * A machine token is refused even when it belongs to the operator. A `dsv_`
 * token is a long-lived credential meant to be handed to CI, nothing about
 * provisioning a GitHub App is a CI operation, and the callback is a browser
 * navigation regardless.
 *
 * ## The consequence to know about
 *
 * `shouldMintLocalOperatorToken` returns false once GitHub sign-in is
 * configured, so on such a deployment there is NO local operator and the
 * admin bearer is the only key. And a bearer cannot ride the callback: that
 * request is a top-level navigation GitHub performs, and no browser attaches
 * an `Authorization` header to one. So on a sign-in-configured deployment
 * this flow can be started but not finished, and the operator registers the
 * App by hand — the path the README keeps verbatim for GitHub Enterprise and
 * locked-down orgs anyway.
 *
 * That is the correct trade. The alternative is letting any reviewer on such
 * a deployment provision the credentials, which is the defect this replaced.
 */

import { createPrivateKey, randomUUID } from "node:crypto"
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express"
import { loadConfig, type ViewerConfig } from "../config"
import type { AppDeps } from "../create-app"
import { hasAdminAuthority, resolveReadContext } from "../auth/authorize"
import { isLocalOperatorUser } from "../auth/local-operator"
import { readCookie } from "../auth/session-cookie"
import { updateRuntimeConfig } from "../runtime-config"
import {
  clearStateCookie,
  isSecurePublicUrl,
  serializeStateCookie,
  stateCookieName,
  statesMatch,
} from "./state-cookie"
import { DEFAULT_RETURN_PATH, safeReturnPath } from "./return-path"

const SETUP_STATE_COOKIE_NAME = "viewer_setup_state"
/**
 * Where the browser should land after the App is created — the same
 * pattern (and the same open-redirect gate, `safeReturnPath`) as the OAuth
 * flow's `viewer_oauth_return`. Minted with the state cookie by the
 * manifest route when the caller passes `?next=…`, honoured by the
 * callback, cleared with the state either way.
 *
 * It exists for the Add-project wizard (Mo, 2026-08-29): setting up the
 * App from inside that flow must land the operator BACK in the flow, not on
 * GitHub's install page with the wizard gone. The wizard's own
 * "Connect GitHub access" leg takes over installation from there. Without
 * `next` the callback keeps its original destination, the App's install
 * page — right for Settings, where there is no flow to resume.
 */
const SETUP_RETURN_COOKIE_NAME = "viewer_setup_return"
const DEFAULT_API_BASE_URL = "https://api.github.com"
const API_VERSION = "2022-11-28"

/**
 * Ceiling on the conversion round trip. `fetch` has no default timeout, so
 * without this a GitHub connection that accepts and then stalls holds the
 * operator's request open until something else in the stack gives up — with
 * no error, no log line, and a browser tab that just spins.
 *
 * 15s is generous for a single unauthenticated POST and still well inside the
 * one hour the code stays valid, so a timeout is always retryable by
 * restarting the flow.
 *
 * MEASURED on Node 25.9: an `AbortSignal.timeout` firing mid-fetch rejects
 * with a `DOMException` named `TimeoutError` (`instanceof Error`, message
 * "The operation was aborted due to timeout", no `cause`). That is a plain
 * rejection, so it lands in the callback's existing catch and becomes the
 * same server-side log plus generic 502 as any other conversion failure —
 * there is no separate abort path to get wrong. The signal covers the body
 * read as well as the request, so a stall part-way through `res.json()` is
 * caught too.
 */
const CONVERSION_TIMEOUT_MS = 15_000

/**
 * "The name cannot be longer than 34 characters" — GitHub's App registration
 * docs, verified 2026-08-20. A longer name is rejected outright, so the host
 * segment gets truncated rather than the manifest getting refused.
 */
const MAX_APP_NAME_LENGTH = 34
const APP_NAME_PREFIX = "Desde Viewer ("
const APP_NAME_SUFFIX = ")"

/**
 * GitHub slugs are lowercase alphanumerics and hyphens. The pattern is
 * deliberately a little wider than that and capped, because this value is
 * persisted and later interpolated into `github.com/apps/{slug}` links in
 * the UI — a validated slug means no consumer has to wonder.
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/**
 * The fields we take from GitHub's conversion response. It returns a whole
 * App object as well (`owner`, `permissions`, `html_url`, …); none of it is
 * needed, and not reading it is the cheapest way to be sure none of it gets
 * persisted by accident.
 *
 * `id` is a number in GitHub's response. It is widened here because the
 * value that gets stored is a string (`appId` signs the App JWT as its
 * `iss`), and a stub that supplies the already-stringified form should not
 * be a type error.
 */
export interface ManifestConversion {
  id: number | string
  slug: string
  pem: string
  client_id: string
  client_secret: string
  webhook_secret?: string | null
}

/** The App name, host-stamped and clipped to GitHub's limit. */
export function buildAppName(publicUrl: string): string {
  const host = new URL(publicUrl).host
  const full = `${APP_NAME_PREFIX}${host}${APP_NAME_SUFFIX}`
  if (full.length <= MAX_APP_NAME_LENGTH) return full
  // Keep the LEADING characters of the host: for a long name the
  // distinguishing part is the subdomain (`viewer.`, `staging.`), not the
  // registrable domain every one of the operator's deployments shares.
  const budget = MAX_APP_NAME_LENGTH - APP_NAME_PREFIX.length - APP_NAME_SUFFIX.length
  return `${APP_NAME_PREFIX}${host.slice(0, budget)}${APP_NAME_SUFFIX}`
}

/**
 * True when GitHub could never deliver a webhook to this origin. MEASURED
 * (2026-08-20, live manifest run): GitHub rejects the whole manifest with
 * "Hook url is not supported because it isn't reachable over the public
 * Internet (localhost)" — so a loopback deployment must omit the hook
 * entirely, not merely mark it inactive. Push auto-deploy was never going
 * to work on localhost anyway; a deployed viewer with a public URL still
 * gets the hook provisioned.
 */
function isLoopbackHost(publicUrl: string): boolean {
  const host = new URL(publicUrl).hostname
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  )
}

/**
 * The manifest GitHub pre-fills its App registration form from.
 *
 * Read-only permissions, and no more than the two capabilities the viewer
 * actually has: `contents` is what the build runner clones a repo with, and
 * `emails` is what sign-in falls back to for a GitHub account with no
 * public email (see `auth/github-auth-provider.ts`, which logs a dedicated
 * diagnostic when an App is missing it). `metadata: read` is granted
 * implicitly by GitHub and is not listed. `emails` is the manifest-endpoint
 * name for this permission, not the REST name `email_addresses` — see the
 * MEASURED note on `default_permissions` below.
 */
function buildAppManifest(publicUrl: string): Record<string, unknown> {
  const loopback = isLoopbackHost(publicUrl)
  return {
    name: buildAppName(publicUrl),
    url: publicUrl,
    redirect_url: `${publicUrl}/api/v1/setup/github/callback`,
    callback_urls: [`${publicUrl}/api/v1/auth/github/callback`],
    // Where GitHub sends the person after they INSTALL the App. Without it
    // the flow ends stranded on github.com's installation-settings page.
    //
    // Deliberately under the same non-loopback guard as hook_attributes,
    // even though a setup redirect happens in the operator's own browser and
    // SHOULD be fine on loopback: the manifest endpoint provably validates
    // some URLs (the hook rejection below is MEASURED) and its docs say
    // nothing about which, and a rejected manifest on a localhost deployment
    // would break the zero-config first boot to gain nothing. Omitting it
    // there keeps exactly the pre-setup_url behavior. If a live loopback
    // manifest run ever proves it accepted, lift it out of the guard.
    ...(loopback ? {} : { setup_url: publicUrl }),
    // Omitted on loopback — see isLoopbackHost. default_events goes with
    // the hook: events without a webhook are meaningless.
    ...(loopback
      ? {}
      : {
          hook_attributes: { url: `${publicUrl}/api/v1/webhooks/github`, active: true },
          default_events: ["push"],
        }),
    // MEASURED 2026-09-01, and the reason this is `true`: GitHub uses this
    // one flag for two different things. It gates who may INSTALL the App on
    // repositories, which is what the previous `false` was reasoning about,
    // and it also gates who may AUTHORIZE it to sign in. With `false`, only
    // the account that created the App can complete
    // `/login/oauth/authorize`; every other account gets a bare 404 from
    // GitHub, with nothing on our side to explain it. A second account hit
    // exactly that during the release stress test.
    //
    // That made the one-click setup unusable for the product's actual shape.
    // This viewer is a multi-user tool whose GitHub App IS the sign-in
    // method, so an App nobody else can authorize is an instance that can
    // never admit a second person through GitHub.
    //
    // Installable by strangers is not the exposure it sounds like. Anyone may
    // start the OAuth flow, and `admitSignIn` (auth/gate.ts) still refuses
    // them: the viewer is invite-only, and authenticating is not being
    // admitted. Someone installing this App on their OWN repositories grants
    // them nothing here, because installations are only ever read back
    // through the caller's own GitHub identity.
    public: true,
    default_permissions: {
      contents: "read",
      // MEASURED (2026-08-20, live manifest run): the manifest endpoint
      // accepts `emails`, NOT the REST permission name `email_addresses` —
      // sending the REST name fails the whole manifest with "Default
      // permission records resource is not included in the list". The REST
      // docs and the manifest implementation disagree; the implementation
      // wins. The created App still shows "Email addresses: Read-only".
      emails: "read",
    },
  }
}

/**
 * Narrows GitHub's response, throwing a reason that names the offending
 * FIELD and never its value — this message reaches the server log, and two
 * of these fields are secrets.
 *
 * The PEM is parsed, not merely type-checked. `loadConfig` already does that
 * for an env-supplied key, and without it here a truncated PEM would persist
 * cleanly and then fail on the first GitHub API call, long after the flow
 * that could have reported it.
 */
function readConversion(value: unknown): ManifestConversion {
  if (value === null || typeof value !== "object") {
    throw new Error("conversion response was not a JSON object")
  }
  const body = value as Record<string, unknown>

  const rawId = body.id
  const appId = typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : ""
  if (!/^[0-9]+$/.test(appId)) throw new Error("conversion response has no numeric `id`")

  const slug = body.slug
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new Error("conversion response has no usable `slug`")
  }

  const pem = body.pem
  if (typeof pem !== "string") throw new Error("conversion response has no `pem`")
  try {
    createPrivateKey(pem)
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unparseable"
    throw new Error(`conversion response \`pem\` is not a private key (${reason})`)
  }

  const clientId = body.client_id
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new Error("conversion response has no `client_id`")
  }
  const clientSecret = body.client_secret
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new Error("conversion response has no `client_secret`")
  }

  const webhookSecret = body.webhook_secret
  if (webhookSecret !== undefined && webhookSecret !== null && typeof webhookSecret !== "string") {
    throw new Error("conversion response has a non-string `webhook_secret`")
  }

  return {
    id: appId,
    slug,
    pem,
    client_id: clientId,
    client_secret: clientSecret,
    ...(typeof webhookSecret === "string" && webhookSecret.length > 0
      ? { webhook_secret: webhookSecret }
      : {}),
  }
}

/**
 * The real exchange. Unauthenticated by design — the one-hour, single-use
 * `code` IS the credential.
 *
 * The thrown error carries only the status, never the response body, for the
 * same reason `github/github-app-client.ts` does: on the success path that
 * body is a private key and a client secret, and an error path that
 * stringifies "whatever came back" is one GitHub change away from writing
 * them to the log.
 */
async function exchangeManifestCodeWithGitHub(
  code: string,
  apiBaseUrl: string,
): Promise<ManifestConversion> {
  const res = await fetch(`${apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
    signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`GitHub App Manifest conversion failed with status ${res.status}`)
  }
  // Returned WITHOUT validating, on purpose. `readConversion` runs at the
  // single call site in the route below, so GitHub's real response and an
  // injected test stub are held to exactly the same gate — validating here
  // as well would make the real path the only one that is checked twice and
  // the stub path the only one that could ever slip something through.
  return (await res.json()) as ManifestConversion
}

/**
 * A GitHub Enterprise Server operator's `VIEWER_GITHUB_API_BASE_URL` only
 * reaches `ViewerConfig` through a `githubAuth`/`githubApp` block, and by
 * the time this route runs neither necessarily exists — `githubApp` in
 * particular cannot, or the route would have 409'd. `githubAuth` is the one
 * that can, so it is the one consulted.
 *
 * The manifest form target itself is github.com-hardcoded in the client, so
 * the flow as a whole is not GHES-ready either way; this at least keeps the
 * two halves from disagreeing on a deployment that has configured sign-in
 * against GHES already.
 */
function resolveApiBaseUrl(config: ViewerConfig): string {
  return config.githubApp?.apiBaseUrl ?? config.githubAuth?.apiBaseUrl ?? DEFAULT_API_BASE_URL
}

/**
 * Clears the state cookie before ANYTHING else runs on the callback —
 * including the auth guard, including the already-configured check.
 *
 * A state nonce is single-use regardless of outcome, and putting the clear
 * in the handler would leave it live on exactly the paths that never reach
 * the handler (an expired session, a replay after the App already exists).
 * Nothing downstream sets another cookie, so `setHeader` here cannot clobber
 * one later.
 */
function clearSetupState(secure: boolean): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Set-Cookie", [
      clearStateCookie(SETUP_STATE_COOKIE_NAME, secure),
      clearStateCookie(SETUP_RETURN_COOKIE_NAME, secure),
    ])
    next()
  }
}

/**
 * The 403 body. One plain sentence, and deliberately NOT the byte-identical
 * 404 that `authorize.ts` uses for a private project: that pattern exists to
 * hide whether a resource EXISTS, and these routes' existence is not secret
 * — the settings GitHub section links to them. What must not leak is
 * anything about the deployment's configuration, and a fixed sentence leaks
 * nothing.
 *
 * "Admin", not "deployment operator" (Mo, 2026-08-31: "I don't know what a
 * deployment operator is... is it a role?") — the everyday holder of this
 * authority IS the Admin role the members panel shows; the boot-token
 * fallback in `requireOperator` is an edge the reader of a 403 never needs
 * named.
 */
const OPERATOR_ONLY = "Only an admin of this viewer can set up the GitHub App."

/**
 * `hasAdminAuthority` (the admin bearer, or an `admin`-role session/account),
 * or a local-operator session. See this file's doc comment for why "any
 * signed-in user" is the wrong bar here, and why instance Admins now clear
 * it (I2) where they previously did not.
 *
 * Status discipline matches the rest of the API: no credential, or one that
 * resolves to nobody, is 401 (missing credential); a credential that is
 * perfectly valid but belongs to someone who is not the operator is 403
 * (insufficient authority).
 */
function requireOperator(deps: AppDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    // Checked FIRST, ahead of `hasAdminAuthority` — a PAT is refused here
    // even when its owner is an instance Admin or the operator. `scopes ===
    // null` means "not a machine token"; provisioning a GitHub App is not a
    // CI operation, and the callback leg is a browser navigation regardless.
    if (ctx.scopes !== null) {
      res.status(403).json({ error: OPERATOR_ONLY })
      return
    }
    // The admin bearer asserts authority, not an identity, so it authorizes
    // with or without a session cookie alongside. An `admin`-role
    // session/PAT-less account (I2) authorizes the same way, because the
    // `scopes !== null` check above already ruled out the PAT case for it.
    if (hasAdminAuthority(ctx)) {
      next()
      return
    }
    if (!ctx.user) {
      res.status(401).json({ error: "Unauthorized" })
      return
    }
    // The local-operator fallback, for a row that has since been DEMOTED off
    // `admin` by someone else — `hasAdminAuthority` above would already have
    // matched an un-demoted operator row, since `ensureLocalOperatorUser`
    // creates it at `admin`. This is what keeps possession of the boot token
    // meaning "operator" even after that.
    if (!isLocalOperatorUser(ctx.user)) {
      res.status(403).json({ error: OPERATOR_ONLY })
      return
    }
    next()
  }
}

export function createSetupRoutes(deps: AppDeps): Router {
  const router = Router()
  // `publicUrl` is boot-stable (see `GithubRuntime.config`), so both the
  // cookie's Secure flag and every URL in the manifest can be settled here.
  const publicUrl = deps.config.publicUrl
  const secure = isSecurePublicUrl(publicUrl)

  const operator = requireOperator(deps)

  const exchange =
    deps.exchangeManifestCode ??
    ((code: string) => exchangeManifestCodeWithGitHub(code, resolveApiBaseUrl(deps.github.config)))

  router.get("/setup/github/manifest", operator, (req, res) => {
    // The LIVE config, not `deps.config`. After a completed manifest flow the
    // boot snapshot still says "no App", and answering off it would offer a
    // second App to anyone who reloaded the setup page without restarting —
    // which is the entire scenario the runtime holder exists for.
    if (deps.github.config.githubApp) {
      res.status(409).json({ error: "This deployment already has a GitHub App configured" })
      return
    }

    const state = randomUUID()
    // `?next=…` rides its own cookie, exactly like the OAuth flow's
    // `viewer_oauth_return` (`auth-routes.ts`): gated by `safeReturnPath`, so
    // it is only ever a same-origin path, and cleared rather than set when
    // there is nothing to carry.
    const returnPath = safeReturnPath(req.query.next)
    res.setHeader("Set-Cookie", [
      serializeStateCookie(SETUP_STATE_COOKIE_NAME, state, secure),
      returnPath === DEFAULT_RETURN_PATH
        ? clearStateCookie(SETUP_RETURN_COOKIE_NAME, secure)
        : serializeStateCookie(SETUP_RETURN_COOKIE_NAME, returnPath, secure),
    ])
    // A per-request CSRF nonce. An intermediary that cached this by URL would
    // hand every operator the same state, and only the first of them would
    // hold the matching cookie.
    res.setHeader("Cache-Control", "private, no-store")
    res.setHeader("Vary", "Cookie, Authorization")
    res.json({ manifest: buildAppManifest(publicUrl), state })
  })

  router.get("/setup/github/callback", clearSetupState(secure), operator, async (req, res) => {
    if (deps.github.config.githubApp) {
      // A replayed or concurrent callback. Refusing rather than overwriting:
      // the credentials on disk are backing a live App the operator has
      // probably already installed, and silently swapping them out would
      // break every project connected through it.
      res.status(409).json({ error: "This deployment already has a GitHub App configured" })
      return
    }

    const stateParam = typeof req.query.state === "string" ? req.query.state : ""
    // Hard cutover: on https ONLY `__Host-viewer_setup_state` is read.
    const stateCookie = readCookie(
      req.headers.cookie,
      stateCookieName(SETUP_STATE_COOKIE_NAME, secure),
    )
    if (!stateCookie || !stateParam || !statesMatch(stateParam, stateCookie)) {
      res.status(400).json({ error: "Invalid or missing setup state" })
      return
    }

    const code = typeof req.query.code === "string" ? req.query.code : ""
    if (!code) {
      res.status(400).json({ error: "code is required" })
      return
    }

    let conversion: ManifestConversion
    try {
      conversion = readConversion(await exchange(code))
    } catch (err) {
      // Generic outward, detailed inward — same discipline as the OAuth
      // callback. The detail here can name a field but never a value.
      console.error("[viewer] GitHub App Manifest conversion failed:", err)
      res.status(502).json({ error: "Failed to create the GitHub App" })
      return
    }

    // Re-checked AFTER the network round trip, not only before it. The
    // check above and this write are separated by an `await`, and two setup
    // tabs opened before either finished would both pass the first check,
    // both create a real App on GitHub, and the second would silently
    // overwrite the first — leaving an orphaned App the operator has no way
    // to notice. Refusing here keeps the first App: it costs the second
    // operator a spent code and an App they must delete, which is strictly
    // better than a deployment quietly pointing at the wrong one.
    if (deps.github.config.githubApp) {
      console.warn(
        "[viewer] discarding a second GitHub App created concurrently — this deployment was " +
          "configured while the conversion was in flight. Delete the unused App on GitHub.",
      )
      res.status(409).json({ error: "This deployment already has a GitHub App configured" })
      return
    }

    try {
      updateRuntimeConfig(deps.config.dataDir, {
        githubApp: {
          appId: String(conversion.id),
          slug: conversion.slug,
          privateKeyPem: conversion.pem,
          clientId: conversion.client_id,
          clientSecret: conversion.client_secret,
          ...(conversion.webhook_secret ? { webhookSecret: conversion.webhook_secret } : {}),
        },
      })
    } catch (err) {
      // The App now exists on GitHub but this viewer cannot remember it —
      // an unwritable data directory, most likely. Say so plainly in the log:
      // the operator's recovery is to fix the directory and delete the App,
      // and nothing about that is guessable from a 502 alone.
      console.error("[viewer] failed to persist the new GitHub App credentials:", err)
      res.status(500).json({ error: "Failed to save the GitHub App credentials" })
      return
    }

    // Re-read from source rather than patching the in-memory config: the
    // env-wins precedence lives in `loadConfig`, and duplicating it here is
    // exactly how the two would drift.
    deps.github.reload(loadConfig())

    // Back to the flow that started this, when one said where it lives —
    // the Add-project wizard resumes and its own "Connect GitHub access"
    // leg handles installing the new App. With no return path the original
    // destination stands: the App's install page, which is right for a
    // setup begun from Settings. `safeReturnPath` runs AGAIN on the cookie
    // value, so a tampered cookie degrades to "/" rather than an open
    // redirect — and "/" is the default, which falls through to the install
    // page.
    const returnCookie = readCookie(
      req.headers.cookie,
      stateCookieName(SETUP_RETURN_COOKIE_NAME, secure),
    )
    const returnPath = safeReturnPath(returnCookie)
    res.redirect(
      302,
      returnPath === DEFAULT_RETURN_PATH
        ? `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`
        : returnPath,
    )
  })

  return router
}
