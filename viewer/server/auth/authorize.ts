/**
 * The authorization seam (Phase 3b-1 Task 3). `canReadProject` is the single
 * source of truth for "may this caller read this project" — every read path
 * (and the write paths that create data on a project) routes through it, so
 * there is exactly one place the visibility rule can be gotten wrong.
 *
 * Denials must be indistinguishable from a genuine 404 (see
 * `requireProjectRead` below) — a 403 would itself leak that a `members`
 * project with that id exists.
 */

import type { Request, Response } from "express"
import { createHash, timingSafeEqual } from "node:crypto"
import type { ViewerConfig } from "../config"
import type {
  InstanceRole,
  MachineTokenScope,
  Project,
  ProjectMember,
  StorageAdapter,
  User,
} from "../storage/types"
import { getAllowAnonymousComments, getAllowPublicLinks } from "../instance-settings"
import { getCurrentUser } from "./current-user"
import { verifyMachineToken } from "./machine-token"

/**
 * Constant-time token comparison. Hashing both sides to a fixed-length
 * digest before `timingSafeEqual` sidesteps two problems with comparing
 * the raw tokens directly: `timingSafeEqual` throws on unequal-length
 * buffers (which would itself leak the expected length via which branch
 * runs), and naive `!==`/`Buffer.compare` comparisons leak the token's
 * length and prefix through timing. Moved here from `api-router.ts` (which
 * now delegates to `isAdminRequest` below) — same precedent, one copy.
 */
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * True iff the request carries a valid `Authorization: Bearer <adminToken>`
 * header. Pure boolean check — no response side effects — so it can be
 * resolved once per request alongside `getCurrentUser` and reused by both
 * `requireWrite` (api-router.ts, which still owns the 401 response shape
 * for WRITE routes) and `resolveReadContext` below (which folds it into
 * `isAdmin` for READ authorization).
 */
export function isAdminRequest(
  config: Pick<ViewerConfig, "adminToken">,
  req: Pick<Request, "get">,
): boolean {
  const expected = config.adminToken
  if (!expected) return false
  // Same extraction as `resolveReadContext` — deliberately the ONE shared
  // helper, so the two can never disagree about what counts as a bearer
  // (see `extractBearerToken`'s doc comment for why that mattered).
  const token = extractBearerToken(req) ?? ""
  return tokensMatch(token, expected)
}

/**
 * The `Bearer ` scheme prefix, matched CASE-INSENSITIVELY. RFC 7235 §2.1
 * makes the auth-scheme token case-insensitive, and real clients send
 * lowercase (`curl -H "authorization: bearer $TOKEN"`, some proxies,
 * hand-rolled scripts). Matching only the exact `"Bearer "` casing silently
 * discarded such a PAT and took the "no bearer" branch instead — on a
 * `public-link` project that reads as a 200 that LOOKS like the token
 * worked, and a REVOKED token in that shape reads as anonymous rather than
 * 401, which is exactly the failure mode the strict-401 rule below exists
 * to eliminate.
 *
 * The trailing `(\s|$)` rather than a bare space is load-bearing for the
 * SAME reason. Node/Express strips trailing optional whitespace, so a header
 * of `Authorization: Bearer ` (an unset `$TOKEN` in a CI script — the single
 * most common way to send a broken credential) arrives as exactly `"Bearer"`.
 * Against `/^bearer /i` that failed to match, took the "no bearer" branch,
 * and authenticated as anonymous — a silent 200 on any readable project,
 * which is the precise failure this rule exists to prevent, and it directly
 * contradicted the `extractBearerToken` doc comment below claiming an empty
 * token counts as an attempt. Found live; no unit test covered it.
 */
const BEARER_SCHEME = /^bearer(\s|$)/i

/**
 * Extracts the raw bearer value from `Authorization: Bearer <token>` —
 * `null` when the header is absent or doesn't use the `Bearer` scheme (in
 * which case `resolveReadContext` below takes its "no bearer" branch:
 * current behavior, unchanged). A header that DOES use the bearer scheme
 * (even `Bearer ` with an empty token) counts as a bearer ATTEMPT — the
 * caller went out of its way to send one, so it must resolve to either
 * admin or a valid PAT, or fail with 401 (see `resolveReadContext`'s step
 * 4). A non-bearer scheme (`Basic ...`) is NOT an attempt and falls through
 * to anonymous, unchanged. Only Authorization is ever consulted — a PAT in
 * a cookie or a query parameter is never accepted (query params leak into
 * access logs, `Referer`, and browser history).
 *
 * Used by BOTH `isAdminRequest` above and `resolveReadContext` below: one
 * copy, so a future change to what counts as a bearer can't apply to one
 * and not the other.
 */
function extractBearerToken(req: Pick<Request, "get">): string | null {
  const header = req.get("authorization")
  if (!header || !BEARER_SCHEME.test(header)) return null
  // `.slice(6)` past "bearer", then trim: the scheme may have been followed
  // by nothing at all (`"Bearer"`), so slicing a fixed `"bearer ".length`
  // would underflow. An empty result is still an ATTEMPT and must not be
  // conflated with an absent header — it returns `""`, not `null`.
  return header.slice(6).trim()
}

/**
 * The ONE membership question `canReadProject` needs answered: is THIS caller
 * on THIS project's access list?
 *
 * It was two methods until Authorization v2. The second, `hasAnyMember`, fed
 * the zero-members world-readable migration rule, and it went when that rule
 * did — `"all-members"` says the same thing as a stored value now, so nothing
 * derives readability from a member COUNT any more.
 *
 * Worth keeping the history, because the shape is defensive rather than
 * accidental. Before the two methods there was ONE overloaded function, and
 * "does this project have any member" was asked by calling it with a reserved
 * `userId === ""` sentinel. That failed open two ways: a malformed or empty
 * `ctx.user.id` took the sentinel branch and read as "does ANY member exist"
 * instead of "is THIS user a member", granting access on every locked project
 * that had any member at all; and the convention was invisible in the type, so
 * the obvious direct binding `(pid, uid) => storage.getProjectMember(pid, uid)`
 * compiled, passed every test, and silently made every locked project
 * world-readable. One narrowly named method — never a general-purpose lookup
 * with a magic argument — is what keeps that unwritable.
 */
export interface ProjectMembership {
  /** The caller's own membership row for this project, or `null`. */
  getMember(projectId: string, userId: string): Promise<ProjectMember | null>
}

/** Builds a `ProjectMembership` over a real `StorageAdapter`. */
export function makeProjectMembership(
  storage: Pick<StorageAdapter, "getProjectMember">,
): ProjectMembership {
  return {
    async getMember(projectId, userId) {
      return storage.getProjectMember(projectId, userId)
    },
  }
}

/**
 * The caller identity every predicate below reads. A subset of `ReadContext`
 * (which additionally carries PAT `scopes`), so a `ReadContext` is accepted
 * everywhere one of these is asked for.
 */
export interface AuthorityContext {
  user: User | null
  isAdmin: boolean
}

/**
 * The ONE predicate for "does this caller hold instance-admin authority",
 * covering BOTH ways of holding it: the shared `adminToken` bearer, and an
 * `admin`-role account (session or PAT).
 *
 * It exists because those two were being asked separately at eight sites, and
 * five of them only asked the first — so a role-admin saw less than the
 * operator's bearer at exactly the places where "an admin sees everything" is
 * the whole rule (member emails, build logs, the private repo half). Every
 * such site now calls this, so the two concepts cannot drift apart again.
 *
 * NO status re-check here, deliberately. Both paths that can populate
 * `ctx.user` — `getCurrentUser` for a session, and `resolveReadContext`'s PAT
 * branch — already refuse a non-`active` account, so a `ctx.user` in hand is
 * an active user by construction. Adding a check here would imply the
 * opposite, i.e. that a caller might legitimately arrive holding a removed
 * user, and invite a future caller to skip it. The one place that DOES
 * re-check is `requireInstanceRole`, and that is defence in depth on an
 * authority GRANT, documented as such there.
 */
export function hasAdminAuthority(ctx: AuthorityContext): boolean {
  return ctx.isAdmin || ctx.user?.role === "admin"
}

/**
 * True iff the caller's INSTANCE role permits managing a project they can
 * already read — admin authority, or the `editor` role.
 *
 * "Already read" is a precondition this predicate cannot check and does not
 * try to: it takes no project. Every caller must run the read gate first
 * (`requireProjectManage` does; the field-scoping call sites in
 * `projects-routes.ts` / `deployments-routes.ts` sit downstream of one).
 * Splitting it this way keeps a pure boolean available for the "which fields
 * go in this 200" question, which a guard that writes a 404 cannot answer.
 *
 * Membership rows are NOT consulted. That is the whole shape of v2: a
 * `ProjectMember` row is an ACCESS-LIST entry (it decides readability of an
 * `invited` project), never a grant of authority. Authority is the instance
 * role, and nothing else.
 */
export function hasProjectManageAuthority(ctx: AuthorityContext): boolean {
  return hasAdminAuthority(ctx) || ctx.user?.role === "editor"
}

/**
 * The instance-wide inputs the read rule needs beyond the project itself.
 *
 * One field today, and still a named object rather than a bare boolean: the
 * v1 signature took no policy at all, so every call site had to be revisited
 * when the kill switch arrived. A struct means the next instance-wide input
 * is an added field, not another positional parameter and another sweep.
 */
export interface ProjectReadPolicy {
  allowPublicLinks: boolean
}

/**
 * Loads the read policy for one request. Backed by the short-TTL,
 * explicitly-invalidated cache in `instance-settings.ts` — this runs on the
 * prototype-serving path (once per ASSET), which is why that cache exists.
 */
export async function loadProjectReadPolicy(
  storage: Pick<StorageAdapter, "getInstanceSetting">,
): Promise<ProjectReadPolicy> {
  return { allowPublicLinks: await getAllowPublicLinks(storage) }
}

/**
 * The access rule, exhaustively. Evaluated in this order:
 *
 * 1. `access: "public-link"` AND `policy.allowPublicLinks` → readable by
 *    ANYONE, including an anonymous caller. This is the anonymous-review-link
 *    product. With the kill switch off, a `public-link` project behaves
 *    exactly as `"all-members"` — it is not hidden from the people who could
 *    already see it, it just stops being reachable without signing in.
 * 2. Admin authority — the `adminToken` bearer or an `admin`-role account
 *    (see `hasAdminAuthority`) → readable. Both, together, because a
 *    role-admin seeing less than the shared bearer is the exact drift this
 *    branch was split into two checks to avoid.
 * 3. Signed in, `access: "all-members"` → readable. That is its whole
 *    meaning: every admitted member of this instance.
 * 4. Signed in, `access: "public-link"` under a DISABLED kill switch →
 *    readable. Rule 1 already returned for the enabled case, so reaching the
 *    switch below on a `public-link` project means the switch is off, and off
 *    means "behaves as all-members".
 * 5. Signed in, `access: "invited"`, and the caller holds an access-list row
 *    → readable.
 * 6. Otherwise: no.
 *
 * **Every branch is an explicit ALLOW; the fallthrough is DENY.** Written as
 * a switch rather than the shorter `access !== "invited" → true`, which was
 * equivalent only by the accident of `ProjectAccess` having exactly three
 * values: a fourth value would have become readable by every signed-in user
 * with no compile error and no failing test. The `never` annotation in the
 * default branch makes adding one a BUILD failure here, and the `return
 * false` under it makes a value from outside the union entirely — a
 * hand-edited database row — unreadable rather than readable.
 *
 * **The zero-members world-readable migration rule is DELETED.** Until v2 a
 * project with no member rows was readable by anyone at all; `"all-members"`
 * inherited that as a literal "signed in or not" branch. It now requires
 * sign-in. `hasAnyMember` went with it — membership is consulted for exactly
 * one question now (`"invited"`, is THIS caller listed), never for a count.
 *
 * `ctx.user` is an ACTIVE user by construction — both resolution paths refuse
 * a `removed` account before it can reach here. See `hasAdminAuthority`.
 */
export async function canReadProject(
  ctx: AuthorityContext,
  project: Project,
  membership: ProjectMembership,
  policy: ProjectReadPolicy,
): Promise<boolean> {
  if (project.access === "public-link" && policy.allowPublicLinks) return true
  if (hasAdminAuthority(ctx)) return true
  const user = ctx.user
  if (!user) return false
  switch (project.access) {
    case "all-members":
    case "public-link":
      return true
    case "invited":
      return (await membership.getMember(project.id, user.id)) !== null
    default: {
      // Unreachable for any `ProjectAccess` value — which is the point. The
      // annotation is the compile-time guard (a new value stops assigning to
      // `never`); the `return false` is the runtime one.
      const unhandledAccess: never = project.access
      void unhandledAccess
      return false
    }
  }
}

export interface AuthorizeDeps {
  storage: StorageAdapter
  config: ViewerConfig
}

/**
 * The resolved identity of a request: who it is, whether it's the admin,
 * and — for a machine-token (PAT) request — what scopes that token carries.
 *
 * `scopes: null` means "not a machine token" (a browser session, or nobody
 * at all) — NOT "unscoped/all scopes." A human in a browser is not
 * scope-limited in the read sense (every read route inherits `user`/
 * `isAdmin` exactly as before Phase 3b-2), but write authorization (T4's
 * `requireWrite`) treats `scopes: null` as "no PAT, no write authority" —
 * so this distinction is load-bearing, not cosmetic. Never encode a session
 * as `["read","write"]`.
 */
export interface ReadContext {
  user: User | null
  isAdmin: boolean
  scopes: MachineTokenScope[] | null
}

/**
 * Either a resolved `ReadContext`, or `{ error }` when the request carried
 * an `Authorization: Bearer` header that matched neither the admin token
 * nor a live machine token (Phase 3b-2 Task 3, step 4). Mirrors the
 * `{ author } | { error }` shape `resolveWriteAuthor` (comments-routes.ts)
 * already uses elsewhere in this codebase.
 */
export type ReadContextResult = ReadContext | { error: string }

/**
 * Where a guard parks the identity it resolved, so the handler behind it does
 * not resolve the same request a second time (M2 review fix).
 *
 * ## Why this exists
 *
 * Every guard in this file starts by calling `resolveReadContext`, which reads
 * the session cookie (a storage lookup) or verifies a machine token (a hash +
 * a storage lookup). Several handlers then need the caller's identity for
 * something PAST the gate — deciding which fields go in the 200, or whether a
 * creator must be added to an access list — and the only way to get it was to
 * call `resolveReadContext` again. `PATCH /projects/:id` did exactly that:
 * two full identity resolutions per request, with the second one able, in
 * principle, to disagree with the first.
 *
 * So each guard stashes what it resolved and the handler reads it back. One
 * resolution per request, and the handler is looking at the SAME identity the
 * gate admitted rather than a second opinion about it.
 *
 * ## The contract
 *
 * - Every guard in this file stashes the context the moment it has one AND has
 *   admitted the caller past its read/role gate — `requireInstanceRole` on
 *   admission, `requireReadableProject` once the project is readable. A guard
 *   that refuses AFTER that point (the manage guards' final 403) has already
 *   ended the request, so no handler ever observes the stashed value.
 * - `getRequestContext` returns `null` on a request that reached the handler
 *   without passing one of those guards. It is `ReadContext | null` and not a
 *   throwing accessor for that reason: "no guard ran" is a real state, and a
 *   handler that can be mounted without a guard must decide what it means
 *   rather than crash.
 */
interface RequestContextLocals {
  ctx?: ReadContext
}

/**
 * Parks `ctx` on `res.locals` for the handler behind this guard.
 *
 * Tolerates a `res` with no `locals` — Express always provides one, but the
 * hand-rolled response doubles in this repo's unit tests (see
 * `authorize.test.ts`'s `fakeRes`) do not, and a guard must not start throwing
 * on them just because it now records something.
 */
function setRequestContext(res: Response, ctx: ReadContext): void {
  const holder = res as { locals?: RequestContextLocals }
  const locals = holder.locals ?? {}
  locals.ctx = ctx
  holder.locals = locals
}

/**
 * The identity the guard in front of this handler resolved, or `null` if no
 * guard ran. See `RequestContextLocals` above for the full contract.
 */
export function getRequestContext(res: Response): ReadContext | null {
  return (res as { locals?: RequestContextLocals }).locals?.ctx ?? null
}

/**
 * Resolves "who is this request" ONCE — session cookie, admin bearer, PAT
 * bearer, or a rejected bearer. Bearer precedence, in order:
 *
 * 1. No `Authorization: Bearer` header at all → current (pre-3b-2) behavior
 *    exactly: cookie, else anonymous. `scopes: null`.
 * 2. Bearer matches `config.adminToken` → `isAdmin: true`. `user` is STILL
 *    resolved from the cookie independently (unchanged from before this
 *    task) — the admin bearer grants admin privilege, it does not assert an
 *    identity of its own. `scopes: null` (an admin bearer is not a PAT).
 * 3. Bearer parses and verifies as a live machine token → `user` = the
 *    token's owning user (NOT the cookie's — the bearer fully supersedes
 *    it in this branch), `scopes` = the token's scopes.
 * 4. Bearer present but matches NEITHER of the above → `{ error }`. This is
 *    a deliberate behavior change from pre-3b-2: the caller must NOT fall
 *    through to the session cookie. A revoked or mistyped CI/machine token
 *    silently "working" because the browser making the request happens to
 *    also be logged in is the single most confusing failure mode a machine
 *    credential can have — so a bad bearer always wins over a good cookie,
 *    never the reverse. Every caller of this function must check
 *    `"error" in result` and respond 401 (never write a response inside
 *    this function itself — several callers, e.g. the comments SSE
 *    handler, need to keep composing their own response after this call).
 */
export async function resolveReadContext(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
): Promise<ReadContextResult> {
  const bearer = extractBearerToken(req)
  if (bearer === null) {
    const user = await getCurrentUser(deps, req)
    return { user, isAdmin: false, scopes: null }
  }
  if (isAdminRequest(deps.config, req)) {
    const user = await getCurrentUser(deps, req)
    return { user, isAdmin: true, scopes: null }
  }
  const verified = await verifyMachineToken({ storage: deps.storage }, bearer)
  if (verified) {
    // Same continuing-entitlement re-evaluation the session path does in
    // `getCurrentUser` (audit K08). A PAT is the longer-lived of the two
    // credentials, so it is the one for which "outlives the user's
    // entitlement" matters most — without this, removing an account leaves
    // every token it ever minted fully functional until each one's own expiry.
    //
    // This replaced an `isEmailAllowed` re-check for the reason spelled out in
    // `current-user.ts`: the env allowlist is an admission gate now, and status
    // is the entitlement.
    //
    // Deliberately the SAME `{ error: "Invalid credentials" }` a bad token
    // gets. A distinct message would turn this branch into an oracle for "that
    // token is real, its owner was removed", which is a fact about the
    // instance's membership that the holder of a dead credential has no claim
    // to.
    if (verified.user.status !== "active") {
      return { error: "Invalid credentials" }
    }
    return { user: verified.user, isAdmin: false, scopes: verified.token.scopes }
  }
  return { error: "Invalid credentials" }
}

/**
 * `resolveReadContext`, but an unrecognized bearer DEGRADES TO THE NO-BEARER
 * BRANCH — the session cookie is still honoured — instead of producing an
 * `{ error }` the caller must 401 on. Used by exactly two call sites — the
 * prototype serve router and the root-asset fallback — and nowhere else.
 *
 * Why the serve path is lenient where `/api/v1/**` is strict:
 *
 * - **Enforcing bearer validity on static asset delivery buys nothing.**
 *   Ignoring the bearer reaches the IDENTICAL authorization outcome as
 *   rejecting it, because a bad bearer can never grant more than the same
 *   request sent without it — which the caller can always do. `canReadProject`
 *   still runs on the degraded context, so an unreadable project still 404s.
 *   There is no access this leniency opens up.
 * - **It actively breaks real prototypes.** Prototypes routinely stub an
 *   auth header against a mocked API: `fetch('/api/models', { headers: {
 *   Authorization: 'Bearer demo-token' } })`. `rewriteRootRelativeUrls`
 *   rewrites that to `/p/{slug}/api/models`, the path-scoped `connect-src`
 *   permits it, and the mock JSON is a real file in the build — so it is a
 *   plain asset fetch that must serve 200. A 401 there breaks the prototype
 *   with nothing on screen explaining why, including on `public-link`
 *   prototypes shared by anonymous link.
 *
 * The "a silently-successful bad credential is the most confusing failure
 * mode" argument that justifies the strict 401 is about a MACHINE CLIENT
 * HITTING THE API — where the bearer is the whole point of the request. It
 * does not transfer to file delivery, where the bearer is usually not even
 * addressed to the viewer. Keep `/api/v1/**` strict; keep this lenient.
 */
export async function resolveReadContextLenient(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
): Promise<ReadContext> {
  const ctx = await resolveReadContext(deps, req)
  if (!("error" in ctx)) return ctx
  // Degrade to the NO-BEARER branch, not to nobody. `resolveReadContext`
  // returns `{error}` only when a bearer was present and unrecognized, and
  // the prototype case above is exactly that: a browser that IS carrying a
  // valid session cookie, whose page JS happens to attach an unrelated
  // `Authorization` header. Returning a hardcoded anonymous context here
  // would drop that cookie, so a signed-in member viewing a `members`
  // project would 404 on the asset — re-breaking the very prototype this
  // leniency exists to keep working, on the deployment shape most likely
  // to be real. Falling back to the cookie grants nothing extra: it is
  // byte-identical to the same browser omitting the header, which it can
  // already do.
  const user = await getCurrentUser(deps, req)
  return { user, isAdmin: false, scopes: null }
}

/** The single 403 message every write-scope refusal uses. */
export const WRITE_SCOPE_REQUIRED = "This action requires a write-scoped token"

/**
 * True when the caller presented a machine token that does NOT carry the
 * `write` scope. `scopes === null` means "not a machine token" (a browser
 * session, the admin bearer, or nobody at all) and is deliberately NOT
 * restricted here — those callers keep exactly the authority they had
 * before Phase 3b-2.
 *
 * Why refusing a `read` PAT is correct and not merely pedantic: `read`
 * means read. A client that genuinely wants anonymous-level write access
 * can simply omit the `Authorization` header — so refusing a read-PAT is
 * never STRICTER than anonymous on a `public-link` project (the caller has
 * a trivially available fallback). On a `members` project the PAT is the
 * ONLY thing granting access at all, so honoring a write through it would
 * be a genuine escalation beyond what the token's scope says it can do.
 * Either way the refusal costs nothing and closes the escalation.
 */
export function lacksWriteScope(ctx: ReadContext): boolean {
  return ctx.scopes !== null && !ctx.scopes.includes("write")
}

/**
 * A caller with NO credential at all: no session, no personal access token, not
 * the admin bearer.
 *
 * Note this is NOT `ctx.user === null`. A machine token resolves to its owning
 * user, so `user` is set for a PAT request; and the admin bearer resolves to no
 * user at all while being the most authoritative caller there is. Both would be
 * misread by the shorter check.
 */
export function isAnonymous(ctx: ReadContext): boolean {
  return ctx.user === null && !ctx.isAdmin && ctx.scopes === null
}

/** The single 403 message every anonymous-write refusal uses. */
export const ANONYMOUS_WRITE_REFUSED = "Sign in to comment on this project"

/** The single 403 message every instance-admin refusal uses. */
export const ADMIN_ROLE_REQUIRED = "This action requires the admin role"

/** The single 403 message every instance-editor refusal uses. */
export const EDITOR_ROLE_REQUIRED = "This action requires the editor role"

/**
 * The shared body of `requireInstanceAdmin` / `requireInstanceEditor`.
 *
 * Order of refusals, and why:
 *
 * 1. **Bad bearer → 401.** A credential that resolves to nothing must never
 *    read as "authenticated but unauthorized"; that is `resolveReadContext`'s
 *    step-4 rule and it wins over everything below.
 * 2. **Missing write scope → 403.** A property of the CREDENTIAL alone,
 *    identical for every caller, so answering it first reveals strictly less
 *    than answering it last. Same ordering (and same reason) as
 *    `requireProjectWrite`.
 * 3. **The role check itself.** The `adminToken` bearer satisfies both guards
 *    unconditionally — it is the operator's out-of-band escape hatch, and an
 *    instance whose only admin was removed has nothing else left. Otherwise
 *    the caller must be a signed-in (or PAT-owning) user who is BOTH `active`
 *    and holding one of the accepted roles.
 *
 * The `status` re-check here is defence in depth, not the primary control:
 * both paths that can populate `ctx.user` — `getCurrentUser` and the PAT
 * branch of `resolveReadContext` — already refuse a non-active account. It
 * stays because this is an authority grant, and a third resolution path added
 * later must fail closed here rather than silently inherit an admin role from
 * a removed row.
 *
 * Unlike `requireProjectRead`, a refusal here is a plain 403 rather than a
 * disguised 404: these guards protect INSTANCE routes, whose existence is a
 * property of the software and not a secret about anybody's data. The
 * byte-identical-404 discipline exists to avoid confirming that a particular
 * PROJECT exists, and there is no project id in play.
 *
 * An ANONYMOUS caller — no bearer, no cookie — gets the same 403, not a 401.
 * 401 is reserved for a credential that was presented and did not resolve;
 * there is nothing here to reject. That also matches
 * `requireProjectManage`, which already 403s an anonymous caller, and
 * the viewer never issues a `WWW-Authenticate` challenge for anything.
 */
async function requireInstanceRole(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  accepted: readonly InstanceRole[],
  refusal: string,
  opts?: { requireWriteScope?: boolean },
): Promise<ReadContext | null> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) {
    res.status(401).json({ error: ctx.error })
    return null
  }
  if (opts?.requireWriteScope && lacksWriteScope(ctx)) {
    res.status(403).json({ error: WRITE_SCOPE_REQUIRED })
    return null
  }
  // Deliberately `ctx.isAdmin` and NOT `hasAdminAuthority` — the one place in
  // the codebase where that substitution would be wrong. A role-admin is
  // admitted by the NEXT line instead, which additionally re-checks `status`.
  // Folding them together here would route role-admins around that check,
  // which is this guard's documented defence in depth. Nothing is refused as a
  // result: `admin` is in `accepted` for both wrappers.
  if (ctx.isAdmin) {
    setRequestContext(res, ctx)
    return ctx
  }
  if (ctx.user && ctx.user.status === "active" && accepted.includes(ctx.user.role)) {
    setRequestContext(res, ctx)
    return ctx
  }
  res.status(403).json({ error: refusal })
  return null
}

/**
 * Resolves the context and requires instance-admin authority: the adminToken
 * bearer, OR an active user with role `"admin"` (session or PAT; a PAT
 * additionally needs the `write` scope for mutating routes — pass
 * `requireWriteScope: true` from every non-GET route). Responds 401 (bad
 * bearer), 403 (authenticated but not admin / missing scope) itself and
 * returns null; otherwise returns the resolved context.
 *
 * `requireWriteScope` is a separate opt-in rather than something this guard
 * infers, because a role and a scope answer different questions — "may this
 * PERSON do it" versus "may this CREDENTIAL" — and only the route knows
 * whether it mutates. Omit it on a mutating route and a leaked read-only PAT
 * belonging to an admin can administer the instance.
 */
export async function requireInstanceAdmin(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  opts?: { requireWriteScope?: boolean },
): Promise<ReadContext | null> {
  return requireInstanceRole(deps, req, res, ["admin"], ADMIN_ROLE_REQUIRED, opts)
}

/**
 * Same shape as `requireInstanceAdmin`, but admits role `"editor"` OR
 * `"admin"` (the adminToken bearer counts). NOT YET WIRED to any route —
 * Milestone 2 is what calls this, from `POST /projects` (project
 * create/manage), per the viewer-membership plan.
 *
 * `admin` is listed explicitly rather than derived by comparing roles:
 * `InstanceRole` is deliberately not ordered (see its declaration), so every
 * gate names the roles it accepts and a future role cannot silently inherit
 * authority by sorting above `editor`.
 */
export async function requireInstanceEditor(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  opts?: { requireWriteScope?: boolean },
): Promise<ReadContext | null> {
  return requireInstanceRole(deps, req, res, ["editor", "admin"], EDITOR_ROLE_REQUIRED, opts)
}

/**
 * Looks up a project by id and returns it ONLY if the caller may read it.
 * Sends the 404 itself — `{ error: "Project not found" }`, the exact shape
 * every JSON route already used for "no such project" (projects,
 * deployments, comments, participants) — for BOTH "doesn't exist" and
 * "exists but unreadable", so the two are indistinguishable from the
 * outside (a 403 here would itself confirm existence). Callers whose
 * not-found response has a different shape (the serve router's plain-text
 * body, the root-asset-fallback middleware's bare `next()`) don't use this
 * helper — they compose `resolveReadContext` + `canReadProject` +
 * `makeProjectMembership` directly and keep their own response.
 */
export async function requireProjectRead(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
): Promise<Project | null> {
  return (await requireProjectReadWithPolicy(deps, req, res, projectId))?.project ?? null
}

/** What `requireProjectReadWithPolicy` hands back — everything the read gate already had to compute. */
export interface ProjectReadAccess {
  project: Project
  /** The identity the gate admitted. Also parked on `res.locals` — see `getRequestContext`. */
  ctx: ReadContext
  /** The instance-wide policy the readability decision was made against. */
  policy: ProjectReadPolicy
}

/**
 * `requireProjectRead`, but handing back the context and the policy the gate
 * already loaded instead of throwing them away (M2 review fix).
 *
 * `GET /projects/:id` needs all three: the project, the caller (to decide
 * whether the private repo half is included) and `allowPublicLinks` (which it
 * returns to the client as `publicLinksEnabled`). It used to re-resolve the
 * caller AND re-read the setting after the guard returned — three storage
 * round-trips for two facts the guard had in hand a moment earlier, and, worse,
 * a `publicLinksEnabled` in the response that was read at a DIFFERENT instant
 * from the one that decided readability. One read, one answer.
 *
 * `requireProjectRead` keeps its `Project | null` shape and is now a thin
 * projection of this, so every caller that only wants the gate is unaffected.
 */
export async function requireProjectReadWithPolicy(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
): Promise<ProjectReadAccess | null> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) {
    res.status(401).json({ error: ctx.error })
    return null
  }
  const readable = await readableProjectWithPolicy(deps, res, ctx, projectId)
  if (!readable) return null
  setRequestContext(res, ctx)
  return { project: readable.project, ctx, policy: readable.policy }
}

/**
 * The read gate itself, shared by every project guard: look the project up,
 * run `canReadProject` against a freshly loaded policy, and answer the
 * byte-identical `{ error: "Project not found" }` 404 for BOTH "no such
 * project" and "exists but you may not read it".
 *
 * Extracted because it was written out three times inside this file, and three
 * copies of the rule that decides whether a project's existence is disclosed
 * is three chances for one of them to drift — the one thing this seam exists
 * to make impossible. It takes an ALREADY-RESOLVED context rather than the
 * request: every caller must answer its own 401 first (a statement about the
 * CREDENTIAL must never be sequenced after a statement about the RESOURCE),
 * and `requireProjectWrite`/`requireProjectManage` additionally answer the
 * scope refusal before this point, since that too is a property of the
 * credential alone and identical for every project id.
 *
 * Returns the policy alongside the project so a caller that also needs it does
 * not load it twice — see `requireProjectReadWithPolicy`.
 */
async function readableProjectWithPolicy(
  deps: AuthorizeDeps,
  res: Response,
  ctx: AuthorityContext,
  projectId: string,
): Promise<{ project: Project; policy: ProjectReadPolicy } | null> {
  const project = await deps.storage.getProject(projectId)
  const policy = await loadProjectReadPolicy(deps.storage)
  const readable = project
    ? await canReadProject(ctx, project, makeProjectMembership(deps.storage), policy)
    : false
  if (!project || !readable) {
    res.status(404).json({ error: "Project not found" })
    return null
  }
  return { project, policy }
}

/**
 * THE read gate, for a route that has already resolved (and 401'd) its own
 * caller and wants to keep composing its own response afterward.
 *
 * Exported as of the M2 review fix. It was private, on the reasoning that a
 * caller outside this module holding only "is it readable" would be one
 * `res.status(403)` away from re-opening the existence oracle. What actually
 * happened is what always happens to a rule that is unavailable: `GET
 * /projects/:id/members` and `GET /projects/:id/deployments` each hand-inlined
 * a COPY of it, because each needs the resolved `ctx` after the gate to decide
 * field scoping. Two hand-written copies of the disclosure rule is strictly
 * worse than one exported function, so this is the supported way to compose
 * it — and the 404 is still written HERE, by this function, not by the caller.
 *
 * Named `requireReadableProject` rather than the old internal
 * `readableProjectOr404`: a `require*` name says it can end the request, which
 * is the one property a caller must not miss.
 */
export async function requireReadableProject(
  deps: AuthorizeDeps,
  res: Response,
  ctx: ReadContext,
  projectId: string,
): Promise<Project | null> {
  const readable = await readableProjectWithPolicy(deps, res, ctx, projectId)
  if (!readable) return null
  setRequestContext(res, ctx)
  return readable.project
}

/** What `requireProjectWrite` hands back: the project AND the resolved caller. */
export interface ProjectWriteAccess {
  project: Project
  ctx: ReadContext
}

/**
 * The write sibling of `requireProjectRead`: same readability gate (same
 * byte-identical 404 for "doesn't exist" and "exists but unreadable"), PLUS
 * the machine-token write-scope check (`lacksWriteScope`). Every MUTATING
 * route that is gated only on project readability — comment create / edit /
 * delete / reply, participant invite — uses this instead of
 * `requireProjectRead`, so a leaked `read`-scoped PAT cannot write.
 *
 * Deliberately returns the resolved `ReadContext` alongside the project:
 * the comment write routes need it to attribute the write to the caller's
 * REAL identity (`resolveWriteAuthor` in comments-routes.ts), which for a
 * PAT request is the token's owning user — not whatever cookie happened to
 * ride along. Re-resolving the context inside those handlers would both
 * duplicate the storage round-trip and reintroduce the PAT-vs-cookie
 * mismatch this returns it to prevent.
 *
 * Ordering: the scope refusal answers BEFORE the project lookup. A scope
 * refusal is a property of the credential alone, identical for every
 * project id (existent or not), so answering it first reveals strictly
 * less than answering it last — and skips a lookup that can't matter.
 *
 * NOTE: this deliberately does NOT change the public-write comment model.
 * An anonymous caller (no bearer at all → `scopes: null`) can still post,
 * edit, and delete comments on any project it can read. That is
 * pre-existing, deliberate (anonymous review links are the product), and
 * out of scope here — this guard only stops a SCOPED credential from
 * exceeding its scope.
 */
export async function requireProjectWrite(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
): Promise<ProjectWriteAccess | null> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) {
    res.status(401).json({ error: ctx.error })
    return null
  }
  if (lacksWriteScope(ctx)) {
    res.status(403).json({ error: WRITE_SCOPE_REQUIRED })
    return null
  }
  // The anonymous-write switch. Like the scope refusal above, this is a
  // property of the CREDENTIAL (or its absence) rather than of the project, so
  // it is identical for every project id and answering it before the lookup
  // reveals strictly less than answering it after.
  //
  // Default ON: anonymous review links are the product, and this route has
  // always accepted them. An operator turns it off for a deployment whose
  // projects are reachable by strangers, where "anyone can read" would
  // otherwise also mean "anyone can post, edit and delete".
  if (isAnonymous(ctx) && !(await getAllowAnonymousComments(deps.storage))) {
    res.status(403).json({ error: ANONYMOUS_WRITE_REFUSED })
    return null
  }
  const project = await requireReadableProject(deps, res, ctx, projectId)
  if (!project) return null
  return { project, ctx }
}

/** The single 403 body every project-manage refusal uses. */
export function manageRefusal(action: string): string {
  return `Only editors and admins may ${action}`
}

/**
 * THE project-management guard, for routes that MUTATE: rename, change
 * `access`, connect or disconnect a repository, trigger a build, upload a
 * bundle, and add or remove members. A GET carrying manage-level data —
 * today only the build-log stream — uses `requireProjectManageRead` below,
 * which is this guard minus the write-scope requirement.
 *
 * Grants, in full:
 *   - the `adminToken` bearer;
 *   - an active `admin`-role account (session or PAT);
 *   - an active `editor`-role account that can READ this project — which by
 *     `canReadProject` v2 means an `all-members` project, a `public-link`
 *     project, or an `invited` project they hold an access-list row on.
 * Everyone else — the `viewer` role, and anonymous — gets 403.
 *
 * Replaces `requireProjectOwnerOrAdmin`, which asked a question the data
 * model can no longer answer: `ProjectMember` carried a `role` until Task 9
 * and does not any more. A membership row is now an ACCESS-LIST entry and
 * nothing else. Authority comes from the INSTANCE role, so "who may manage
 * this project" is finally one rule instead of a per-project one — which is
 * also why an editor can manage an `all-members` project without being
 * listed on it: nothing distinguishes them from anyone else who could be.
 *
 * ## The response ladder, and why it is ordered this way
 *
 * 1. **Bad bearer → 401.** A credential that resolves to nothing is never
 *    "authenticated but unauthorized" (`resolveReadContext` step 4).
 * 2. **Missing write scope → 403.** A property of the CREDENTIAL alone, so
 *    identical for every project id, existent or not — answering it before
 *    the lookup reveals strictly less than answering it after, and skips a
 *    lookup that cannot matter. Unconditional on THIS guard, because every
 *    route behind it mutates; `requireProjectManageRead` is the same ladder
 *    with this rung removed, and its doc explains why a GET must not ask.
 * 3. **Not readable, or no such project → the byte-identical 404.** Both
 *    cases produce the same `{ error: "Project not found" }`, so the guard
 *    is not an existence oracle for `invited` projects.
 * 4. **Readable but not authorized → 403.** Safe by then, and only then: the
 *    caller has already been told the project exists by being able to read
 *    it, so the 403 discloses nothing new. This is the ONE ordering rule
 *    that matters here — a 403 sequenced before the read check would leak
 *    the existence of every project on the instance.
 *
 * Composes `resolveReadContext` + `canReadProject` + `makeProjectMembership`
 * directly rather than calling `requireProjectRead` and re-resolving the
 * context — the pattern that helper's doc comment calls out for callers that
 * need a different response shape after the read gate.
 */
export async function requireProjectManage(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
  /**
   * What the caller was trying to do, interpolated into the 403 body. Every
   * call site passes one: this guard covers member management, repo
   * connect/disconnect, builds and project settings alike, and telling
   * someone who tried to attach a GitHub repo that they may not "manage
   * members" is a genuinely misleading error.
   */
  action = "manage this project",
): Promise<Project | null> {
  return requireManageAuthority(deps, req, res, projectId, action, true)
}

/**
 * The READ-shaped sibling of `requireProjectManage`, for a GET whose PAYLOAD
 * is manage-level but which mutates nothing. One caller today: `GET
 * /deployments/:id/log/stream`.
 *
 * Identical in every respect but one — it does NOT require the credential to
 * be `write`-scoped.
 *
 * That difference is a correctness fix, not a convenience. The build log is
 * served twice: streamed by that route, and embedded as `Deployment.buildLog`
 * by `GET /projects/:id/deployments`, which is scope-blind like every read
 * path (a `read` PAT reading is exactly what a `read` PAT is for). With the
 * stream on the unconditional-write-scope guard, a read-scoped PAT belonging
 * to an admin was refused `WRITE_SCOPE_REQUIRED` on the stream and handed the
 * identical bytes by the list — so the stream's gate was decoration, and the
 * comment in `build-routes.ts` claiming the two "must agree or neither gates
 * anything" was describing a state that did not hold.
 *
 * The rule the split encodes: **scope follows the VERB, authority follows the
 * ROLE.** `lacksWriteScope` answers "may this CREDENTIAL mutate", which is a
 * question a GET has no business asking; `hasProjectManageAuthority` answers
 * "may this PERSON see manage-level data", which is the whole gate here.
 *
 * Two named exports rather than an options flag on one, deliberately: an
 * optional `{ requireWriteScope }` defaults silently, and the direction it
 * would have to default in for the mutating routes to stay safe is the
 * opposite of the one that reads naturally. A mutating route cannot reach
 * this function by forgetting an argument — it has to call a differently
 * named thing.
 */
export async function requireProjectManageRead(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
  action = "view this project's build details",
): Promise<Project | null> {
  return requireManageAuthority(deps, req, res, projectId, action, false)
}

/** The shared body of the two manage guards above. */
async function requireManageAuthority(
  deps: AuthorizeDeps,
  req: Pick<Request, "headers" | "get">,
  res: Response,
  projectId: string,
  action: string,
  /**
   * True for the mutating guard. Without the scope check a leaked
   * `read`-scoped PAT belonging to an editor could add an attacker's account
   * to a project's access list — a privilege that survives revoking the
   * token. See `lacksWriteScope`.
   */
  mutates: boolean,
): Promise<Project | null> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) {
    res.status(401).json({ error: ctx.error })
    return null
  }
  if (mutates && lacksWriteScope(ctx)) {
    res.status(403).json({ error: WRITE_SCOPE_REQUIRED })
    return null
  }
  const project = await requireReadableProject(deps, res, ctx, projectId)
  if (!project) return null
  if (hasProjectManageAuthority(ctx)) return project
  res.status(403).json({ error: manageRefusal(action) })
  return null
}
