import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express"
import type { AppDeps } from "../create-app"
import { requireInstanceEditor, requireProjectManage } from "../auth/authorize"
import { createCommentChangeBus } from "../comments/change-bus"
import { createAuthRoutes } from "./auth-routes"
import { createCommentsRoutes } from "./comments-routes"
import { createDeploymentsRoutes } from "./deployments-routes"
import { createGithubRoutes } from "./github-routes"
import { createInstanceRoutes } from "./instance-routes"
import { createMembersRoutes } from "./members-routes"
import { createParticipantsRoutes } from "./participants-routes"
import { createProjectRepoRoutes } from "./project-repo-routes"
import { createBuildRoutes } from "./build-routes"
import { createWebhookRoutes } from "./webhook-routes"
import { createProjectsRoutes } from "./projects-routes"
import { createPrototypeOriginRoutes } from "./prototype-origin-routes"
import { createSetupRoutes } from "./setup-routes"
import { createTokensRoutes } from "./tokens-routes"
import { createUnsubscribeRoutes } from "./unsubscribe-routes"

/**
 * The write guard for `POST /projects`, `PATCH /projects/:id`, and
 * `POST /projects/:id/deployments`.
 *
 * It is a thin ROUTER between the two authorization questions those three
 * routes ask, and it holds no rule of its own — that is the point of its
 * current shape. Both branches delegate to `authorize.ts`, so the manage rule
 * has exactly one implementation and this middleware cannot drift from the
 * guards the non-`requireWrite` routes call directly.
 *
 * - **No `:id` param** — i.e. `POST /projects`, which has no project yet to
 *   authorize against. The question is instance-level: may this caller create
 *   projects at all? → `requireInstanceEditor` with `requireWriteScope: true`
 *   (admin authority or the `editor` role; a PAT additionally needs `write`).
 *   A `viewer`-role account is refused here, which is the whole point of that
 *   role existing.
 * - **An `:id` param** — `PATCH /projects/:id` and the bundle upload. The
 *   question is per-project: may this caller MANAGE the project at `:id`? →
 *   `requireProjectManage`, the same guard behind repo connect, builds and
 *   member management.
 *
 * ## What changed in Authorization v2, and why
 *
 * The per-`:id` branch used to check for an access-list ROW: "is this caller
 * a member of the project" (originally "is this caller its `owner`", until
 * `ProjectMember.role` was removed). That is no longer authorization —
 * membership is an access LIST, deciding readability of an `invited` project,
 * and authority is the instance role. So the row check is gone entirely.
 *
 * One deliberate response-code change comes with it. This guard previously
 * never 404'd, on the reasoning that it "never asserts anything about whether
 * the project itself exists." That reasoning was the bug: a 403 on a project
 * the caller cannot read is itself an assertion that it exists, which made
 * `PATCH /projects/:id` an existence oracle for `invited` projects that
 * `requireProjectRead` had been careful to close. `requireProjectManage`
 * answers the byte-identical 404 first, and only 403s a caller who has
 * already been shown the project exists by being able to read it.
 *
 * The second change: a fully anonymous `POST /projects` now gets 403 rather
 * than 401, because `requireInstanceEditor` treats "no credential presented"
 * as nothing to reject — 401 is reserved for a credential that WAS presented
 * and did not resolve. See `requireInstanceRole`'s doc comment; this guard
 * follows it rather than keeping a second opinion.
 *
 * ## What the handlers behind it get for free (M2 review fix)
 *
 * Both delegates park the identity they resolved on `res.locals`, so a handler
 * behind this guard reads it with `getRequestContext(res)` (auth/authorize.ts)
 * instead of calling `resolveReadContext` a second time. `POST /projects` and
 * `PATCH /projects/:id` both did exactly that, for the creator-lockout guard —
 * two full session/PAT resolutions per request, with the handler able in
 * principle to act on a different answer than the gate admitted.
 *
 * The stash happens inside the delegates rather than here, deliberately:
 * `requireProjectManage` returns only the project (its contract is
 * authorization, not data), so this middleware never holds the `:id` branch's
 * context to park. Putting it in `authorize.ts` also means every OTHER guard
 * in that file gets it — `DELETE /projects/:id/members` reads the same way
 * without going through this middleware at all.
 */
export function requireWrite(deps: AppDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const projectId = req.params.id
    if (projectId === undefined) {
      const ctx = await requireInstanceEditor(deps, req, res, { requireWriteScope: true })
      if (!ctx) return
      next()
      return
    }
    const project = await requireProjectManage(deps, req, res, String(projectId), "modify this project")
    if (!project) return
    next()
  }
}

/**
 * `Sec-Fetch-Dest` values that mean "the browser is loading this URL AS A
 * DOCUMENT" — a top-level navigation (`document`) or a nested browsing
 * context (`iframe`/`frame`/`object`/`embed`). No API client sends any of
 * them: `fetch`/`XHR` are `empty`, a script tag is `script`, an SSE stream
 * is `empty`.
 */
const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame", "object", "embed"])

/**
 * The `/api/v1` paths that ARE legitimately reached as a browser
 * navigation, and are therefore exempt below. Exact paths, never prefixes
 * — a prefix rule would silently re-open the lane for anything nested
 * under them later.
 */
const DOCUMENT_NAVIGATION_ROUTES = new Set([
  // Sign-in: the user clicks an <a>, this 302s them to GitHub.
  "/auth/github",
  // GitHub navigates the browser back here with `code` + `state`.
  "/auth/github/callback",
  // Local-operator sign-in. The whole route exists to be PASTED into a
  // browser from the boot banner, which is a top-level navigation — without
  // this entry the printed URL 403s in every browser that sends
  // Sec-Fetch-Dest (i.e. all of them) and the handler never runs. A curl
  // check cannot catch that, since the guard fails open on the absent
  // header. Exempt from the guard is NOT exempt from auth: a wrong token
  // still 401s.
  "/auth/local",
  // The link in every mention email's footer; answers with an HTML
  // confirmation page, which is what makes it a document by design.
  "/unsubscribe",
  // GitHub navigates the OPERATOR'S BROWSER back here after they create the
  // App from a manifest — a top-level navigation, so `Sec-Fetch-Dest:
  // document`. Without this entry the whole two-click setup flow 403s at its
  // final step, and no curl-driven test can see it (the guard fails open when
  // the header is absent). Its sibling `/setup/github/manifest` is
  // deliberately NOT here: page JS `fetch`es that one, so a document request
  // for it is never legitimate.
  "/setup/github/callback",
])

/**
 * The two genuinely top-level-navigation routes whose exempt path cannot be a
 * fixed string in the Set above — `/auth/invite/<token>` and
 * `/auth/signin/<token>`. Their token is a URL PATH SEGMENT (unlike
 * `/auth/local`'s query-string token or `/unsubscribe`'s), so a fresh link
 * mints a fresh path every time. They are matched as bounded prefixes rather
 * than added to the Set: exempt when the path starts with one of these AND the
 * remainder contains no further `/`, so a path nested one level deeper
 * (`/auth/invite/<token>/extra`) is refused exactly like
 * `/auth/github/callback/extra` is below — the token segment itself is the
 * only thing this widens, not "everything under `/auth/invite/`."
 *
 * **Restricted to `dest === "document"` specifically — not the whole
 * `DOCUMENT_DESTINATIONS` set (fix, code review).** Every OTHER entry in
 * `DOCUMENT_NAVIGATION_ROUTES` is safe under iframe/frame/object/embed too,
 * because each needs something an embedding page can't supply on its own:
 * `/auth/github`+callback needs GitHub's own state/code round trip,
 * `/auth/local` needs the out-of-band boot-token secret, `/unsubscribe` and
 * `/setup/github/callback` carry no session side effect a GET can trigger.
 * These two are different: POSSESSION of the token alone is sufficient to
 * spend it, with no further exchange. A same-origin prototype (path mode)
 * that knows or is served a valid link could
 * `<iframe src="/api/v1/auth/invite/<token>">` and silently swap the visiting
 * user's session cookie to whatever account that token resolves to —
 * invisible, no click required, exactly the auxiliary-context credential read
 * this guard exists to close. A real click on either link is always a
 * TOP-LEVEL navigation (an emailed `<a href>`, or a pasted URL), which is
 * `Sec-Fetch-Dest: document` and nothing else — so narrowing these exemptions
 * to `document` costs the legitimate flows nothing.
 *
 * `/auth/signin/<token>` (viewer-membership Task 14) gets the IDENTICAL
 * treatment because it is the identical hazard, and it shares this code path
 * rather than getting a second bounded-prefix check of its own: a copy is a
 * place for the `document`-only narrowing to be forgotten on one of them.
 *
 * **The exemption is method-blind, and both verbs need it (fix wave 6).**
 * Since the GET/POST split, the GET renders a confirmation page and the POST
 * that page's form performs is what redeems — and a form submission is itself
 * a top-level navigation carrying `Sec-Fetch-Dest: document`, so refusing it
 * here would break the button. Nothing widens: an iframe/frame/object/embed
 * POST is refused exactly like the GET of the same shape.
 *
 * What this guard cannot do for the POST is refuse an ABSENT header — it
 * fails open there by design, for curl and every other non-browser client.
 * The redemption route therefore carries its own `document`-required check
 * (`requireDocumentNavigation`, auth-routes.ts) so a scripted POST with no
 * `Sec-Fetch-*` headers at all cannot spend the token either. Two gates, one
 * for embedding and one for absence; neither subsumes the other.
 */
const TOKEN_PATH_NAVIGATION_PREFIXES = ["/auth/invite/", "/auth/signin/"]

function isDocumentNavigationExempt(path: string, dest: string): boolean {
  if (DOCUMENT_NAVIGATION_ROUTES.has(path)) return true
  if (dest !== "document") return false
  return TOKEN_PATH_NAVIGATION_PREFIXES.some(
    (prefix) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
  )
}

/**
 * Refuses `/api/v1/**` requests the browser is fetching as a DOCUMENT.
 *
 * Closes the auxiliary-browsing-context read (security audit finding B2).
 * Under path serving a prototype is same-origin with the API, and no CSP
 * directive governs `window.open`: `connect-src` covers fetch/XHR,
 * `frame-src`/`object-src` cover NESTED contexts, `form-action` covers form
 * submission, and CSP3's `navigate-to` was never shipped in any browser.
 * So a hostile prototype could `window.open('/api/v1/projects')` — a
 * same-origin GET navigation, so the `SameSite=Lax` session cookie
 * attaches — and then read `w.document.body.textContent` straight off the
 * popup. `Cross-Origin-Opener-Policy` cannot fix it either, because opener
 * and popup are the SAME origin, which is exactly the case COOP keeps
 * together.
 *
 * `Sec-Fetch-Dest` is the right discriminator because the browser sets it
 * and page JS cannot: it is a forbidden header name, so `fetch` cannot
 * override it and no attacker-controlled markup can spoof it. It is a
 * fail-open signal for a client that omits it (pre-16.4 Safari, non-browser
 * callers) — which is the correct default, since refusing on absence would
 * lock out every headless client, and the durable containment for a hostile
 * prototype is origin isolation (`app/prototype-origin.ts`), not this.
 *
 * The refusal itself carries `Content-Security-Policy: sandbox`. Without
 * it a 403 is still a same-origin document in the opener's hands, and
 * `w.document.write('<script>fetch("/api/v1/tokens"…)')` would turn the
 * blocked popup into a general credentialed API agent — the sandbox gives
 * the error page an opaque origin, so the opener cannot touch it at all.
 *
 * It ALSO carries `frame-ancestors 'none'`, on the same header. This is not
 * decoration: `create-app.ts`'s shell-wide `frame-ancestors 'none'`
 * middleware runs upstream of this guard, but `res.setHeader` REPLACES a
 * header rather than appending to it, and this handler calls it again below
 * — so without repeating the directive here, this exact refusal (reached by
 * `DOCUMENT_DESTINATIONS`'s "iframe" entry, among others) would silently
 * drop the shell's framing protection on the one response an attacker
 * chose to hit. `sandbox` alone does not substitute for it: `sandbox`
 * governs what the REFUSAL document itself may do, not whether something
 * else may frame it.
 */
export function createDocumentDestinationGuard(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const dest = req.get("sec-fetch-dest")
    const normalizedDest = dest?.toLowerCase() ?? ""
    if (!dest || !DOCUMENT_DESTINATIONS.has(normalizedDest)) {
      next()
      return
    }
    // Express's default (non-strict) routing matches `/unsubscribe/` to the
    // `/unsubscribe` route, so normalize the trailing slash rather than let
    // it decide whether an emailed link works.
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path
    if (isDocumentNavigationExempt(path, normalizedDest)) {
      next()
      return
    }
    res.status(403)
    res.setHeader("Content-Security-Policy", "sandbox; frame-ancestors 'none'")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.json({ error: "This endpoint may not be loaded as a document" })
  }
}

export function createApiRouter(deps: AppDeps): Router {
  const router = Router()

  // Must be first: before any route, including the unauthenticated ones.
  // This guard is not bypassable by the page that triggers the request —
  // `Sec-Fetch-Dest` is set by the browser and cannot be spoofed by page JS.
  //
  // A referer-based guard used to sit here too (`prototype-origin-guard.ts`,
  // deleted — its own doc said plainly "do not treat this guard as
  // containment against a hostile prototype, that's CSP's job," and once a
  // prototype gets a real origin its referer names that origin rather than
  // this one, so the check would have gone permanently inert while still
  // reading as a security control to the next person here). CSP
  // (`resolvePrototypeCsp` in `serve-router.ts`) and the Host-scoping
  // middleware in `create-app.ts` are what actually stop a hostile
  // prototype from reaching this API.
  router.use(createDocumentDestinationGuard())

  const guard = requireWrite(deps)
  const changeBus = deps.changeBus ?? createCommentChangeBus()
  // The auth provider and the App client used to be built HERE, lazily, from
  // `deps.config`. They moved to `github-runtime.ts` because construction at
  // router-build time bakes in the config as of that moment: the App Manifest
  // flow produces credentials after the router exists, and a client built
  // once at construction can never see them. The routes below now read
  // `deps.github.*` per request instead.

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", profile: deps.config.profile })
  })

  router.use(createProjectsRoutes(deps, guard))
  // Its own module, mounted after the project routes it shares a path prefix
  // with — `/projects/:id/prototype-origin` is longer than `/projects/:id`, so
  // neither shadows the other. See `prototype-origin-routes.ts` for why the
  // one route that can open a socket lives apart from the CRUD.
  router.use(createPrototypeOriginRoutes(deps))
  router.use(createDeploymentsRoutes(deps, guard))
  router.use(createCommentsRoutes({ ...deps, changeBus }))
  router.use(createParticipantsRoutes(deps))
  router.use(createMembersRoutes(deps))
  router.use(createInstanceRoutes(deps))
  router.use(createTokensRoutes(deps))
  router.use(createUnsubscribeRoutes(deps))
  router.use(createAuthRoutes(deps))
  router.use(createGithubRoutes(deps))
  router.use(createProjectRepoRoutes(deps))
  router.use(createBuildRoutes(deps))
  router.use(createWebhookRoutes(deps))
  router.use(createSetupRoutes(deps))

  // Scoped to this router only (mounted at /api/v1 in create-app.ts), so it
  // cannot shadow /p/** or the Next-served dashboard. Without this, an
  // unknown /api/v1/* path falls through to the Next handler and returns
  // its HTML 404 page instead of JSON — a client parsing API responses
  // would choke on that.
  router.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` })
  })

  return router
}
