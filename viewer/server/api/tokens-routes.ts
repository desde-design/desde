import { Router, type Request } from "express"
import type { AppDeps } from "../create-app"
import { hasAdminAuthority, lacksWriteScope, resolveReadContext } from "../auth/authorize"
import { generateMachineToken } from "../auth/machine-token"
import type { MachineToken, MachineTokenScope, User } from "../storage/types"

const VALID_SCOPES: readonly MachineTokenScope[] = ["read", "write"]
const MAX_NAME_CHARS = 64
const MIN_EXPIRES_DAYS = 1
const MAX_EXPIRES_DAYS = 365
/**
 * Applied when the caller omits `expiresInDays`. Deliberately the same as
 * `MAX_EXPIRES_DAYS` rather than something shorter: the goal of audit S17 is
 * that no token is IMMORTAL, not that tokens are short-lived. Picking a
 * surprising 30-day default would break long-running CI integrations for a
 * security gain the expiry horizon already delivers.
 */
const DEFAULT_EXPIRES_DAYS = MAX_EXPIRES_DAYS
const MS_PER_DAY = 24 * 60 * 60 * 1000
/**
 * Per-user cap on live machine tokens. Without one, a signed-in user (or
 * anything driving their session) can mint unboundedly many rows, each of
 * which is a live credential the `GET /tokens` UI then has to render and
 * the owner has to reason about. 50 is far above any plausible legitimate
 * use (one per machine / CI job) and far below "a problem." Revoking frees
 * a slot — the cap is on tokens that currently EXIST, not on lifetime
 * mints.
 */
const MAX_TOKENS_PER_USER = 50

/**
 * The wire shape for a machine token — deliberately hand-built (field by
 * field), never a spread of the storage `MachineToken` entity. That's what
 * keeps `tokenHash` (the persisted secret digest) structurally unable to
 * leak into a response: a future field added to `MachineToken` doesn't
 * silently start round-tripping here the way `{ ...token }` would.
 */
export interface MachineTokenView {
  id: string
  name: string
  scopes: MachineTokenScope[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

function toTokenView(token: MachineToken): MachineTokenView {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
  }
}

function validateName(v: unknown): string | null {
  if (typeof v !== "string") return "name is required"
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS) {
    return `name must be 1-${MAX_NAME_CHARS} characters`
  }
  return null
}

function validateScopes(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return "scopes must be a non-empty array"
  const seen = new Set<string>()
  for (const s of v) {
    if (typeof s !== "string" || !(VALID_SCOPES as readonly string[]).includes(s)) {
      return `scopes must be a non-empty subset of ${VALID_SCOPES.join(", ")}`
    }
    if (seen.has(s)) return "scopes must not contain duplicates"
    seen.add(s)
  }
  return null
}

function validateExpiresInDays(v: unknown): string | null {
  if (v === undefined) return null
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_EXPIRES_DAYS || v > MAX_EXPIRES_DAYS) {
    return `expiresInDays must be an integer between ${MIN_EXPIRES_DAYS} and ${MAX_EXPIRES_DAYS}`
  }
  return null
}

type SessionAuthResult = { user: User } | { status: 401 | 403; error: string }

/**
 * Resolves the caller for every route in this file — SESSION-AUTHENTICATED
 * ONLY (Phase 3b-2 Task 4). A machine token must never be usable to mint,
 * list, or revoke a machine token: that would turn any leaked token into a
 * self-renewing foothold (mint a fresh one before the original is noticed
 * and revoked). So identity here comes from the session cookie alone —
 * never from a PAT bearer, and never from the admin bearer either, since
 * `createMachineToken` needs a `userId` to own the token and neither the
 * admin bearer nor a bare PAT resolves to a durable account the way a
 * signed-in session does.
 *
 * Layered on `resolveReadContext` (not a second independent bearer parse)
 * so the SAME bearer-classification logic (admin / PAT / garbage) is used
 * everywhere in the app — this function only adds an extra restriction on
 * top, it doesn't re-derive the classification itself:
 *
 * 1. `"error" in ctx` (a bearer present but invalid) → 401. Same global
 *    rule as every other `resolveReadContext` caller (Task 3): a bad bearer
 *    is never silently treated as "check the cookie instead."
 * 2. `ctx.scopes !== null` (the bearer resolved AS a live machine token,
 *    read- or write-scoped, doesn't matter) → 403, explicitly, with a
 *    message naming the reason. This is the specific case Task 4 requires
 *    a test for: a PAT presented to `/tokens` doesn't quietly 401 as "not
 *    signed in" (which would look like a generic auth failure) — it 403s
 *    as "this credential specifically isn't allowed here," which is a
 *    different, more actionable signal for whoever wrote the CI script.
 * 3. Otherwise (no bearer, or the admin bearer — which never asserts an
 *    identity of its own, see `resolveReadContext`'s doc comment) → the
 *    session cookie is the only remaining source of identity. Present →
 *    proceed as that user. Absent → 401 "sign in required."
 */
async function resolveSessionOnlyUser(
  deps: Pick<AppDeps, "storage" | "config">,
  req: Pick<Request, "headers" | "get">,
): Promise<SessionAuthResult> {
  const ctx = await resolveReadContext(deps, req)
  if ("error" in ctx) return { status: 401, error: ctx.error }
  if (ctx.scopes !== null) {
    return { status: 403, error: "Personal access tokens cannot manage tokens" }
  }
  if (!ctx.user) return { status: 401, error: "Sign in required" }
  return { user: ctx.user }
}

/**
 * `/api/v1/tokens` — user-owned, named, scoped, revocable personal access
 * tokens (Phase 3b-2 Task 4). Every route is session-authenticated only —
 * see `resolveSessionOnlyUser` above for why the admin bearer and PATs are
 * BOTH excluded, not just PATs.
 */
export function createTokensRoutes(deps: AppDeps): Router {
  const router = Router()

  router.post("/tokens", async (req, res) => {
    const auth = await resolveSessionOnlyUser(deps, req)
    if ("error" in auth) {
      res.status(auth.status).json({ error: auth.error })
      return
    }

    const { name, scopes, expiresInDays } = (req.body ?? {}) as Record<string, unknown>
    const error = validateName(name) ?? validateScopes(scopes) ?? validateExpiresInDays(expiresInDays)
    if (error) {
      res.status(400).json({ error })
      return
    }

    // The cap counts LIVE tokens only. An expired token is a dead credential
    // — `verifyMachineToken` already 401s it — so counting it would lock a
    // user out of minting a replacement until they manually deleted rows,
    // which is exactly when they most need one. (Check-then-create is not
    // transactional: two concurrent requests at the boundary can both pass,
    // overshooting by the number of in-flight creates. The cap is a guard
    // against unbounded growth, not an invariant, so that is acceptable.)
    const nowIso = new Date().toISOString()
    const existing = (await deps.storage.listMachineTokensForUser(auth.user.id)).filter(
      (t) => t.expiresAt === null || t.expiresAt > nowIso,
    )
    if (existing.length >= MAX_TOKENS_PER_USER) {
      res.status(400).json({
        error: `You already have the maximum of ${MAX_TOKENS_PER_USER} personal access tokens. Revoke one before creating another.`,
      })
      return
    }

    const gen = generateMachineToken()
    // An omitted `expiresInDays` used to mint a token that NEVER expires
    // (audit S17). Combined with the absence of any operator-side revocation
    // path, that made a leaked `dsv_` a permanent credential: the only way to
    // retire it was for the holder to delete it themselves, which is precisely
    // what an attacker will not do. It now defaults to the same bound an
    // explicit request is already capped at, so every token has a horizon.
    const days = typeof expiresInDays === "number" ? expiresInDays : DEFAULT_EXPIRES_DAYS
    const expiresAt = new Date(Date.now() + days * MS_PER_DAY).toISOString()
    // Reconstructed field by field from the validated raw payload (mass-
    // assignment protection — same discipline `comments-routes.ts`'s
    // `sanitizePosition`/`sanitizeAuthor` use), not passed through as-is:
    // `scopes` is de-duplicated and re-typed as `MachineTokenScope[]` only
    // after `validateScopes` has proven every element is one of the two
    // known literals.
    const created = await deps.storage.createMachineToken({
      id: gen.id,
      userId: auth.user.id,
      name: (name as string).trim(),
      scopes: Array.from(new Set(scopes as MachineTokenScope[])),
      tokenHash: gen.tokenHash,
      expiresAt,
    })

    // The ONLY point in the token's lifecycle where the plaintext is ever
    // sent anywhere — never logged, never persisted (see machine-token.ts).
    res.status(201).json({ token: gen.token, ...toTokenView(created) })
  })

  router.get("/tokens", async (req, res) => {
    const auth = await resolveSessionOnlyUser(deps, req)
    if ("error" in auth) {
      res.status(auth.status).json({ error: auth.error })
      return
    }
    const tokens = await deps.storage.listMachineTokensForUser(auth.user.id)
    res.json({ tokens: tokens.map(toTokenView) })
  })

  router.delete("/tokens/:id", async (req, res) => {
    const auth = await resolveSessionOnlyUser(deps, req)
    if ("error" in auth) {
      res.status(auth.status).json({ error: auth.error })
      return
    }
    const id = String(req.params.id)
    const token = await deps.storage.getMachineToken(id)
    // 404 (never 403) for a token belonging to someone else — same
    // no-existence-oracle rule Phase 3b-1 established for projects
    // (authorize.ts): a byte-identical response for "no such id" and
    // "exists, but not yours" means a caller can't use this endpoint to
    // enumerate other users' token ids.
    if (!token || token.userId !== auth.user.id) {
      res.status(404).json({ error: "Token not found" })
      return
    }
    await deps.storage.deleteMachineToken(id)
    res.status(204).end()
  })

  /**
   * Operator-side revocation of EVERY token belonging to one user.
   *
   * Audit S17: `deleteMachineTokensForUser` existed in both storage impls and
   * had zero callers, so there was no way for the person running the viewer to
   * retire a compromised credential — `/tokens` is session-cookie-only, which
   * means revocation required the holder to cooperate. That is the wrong actor
   * when the credential has leaked or the person has left.
   *
   * Fix wave M1 review: originally gated on `isAdminRequest` alone — the raw
   * `adminToken` bearer, nothing else — so an instance ADMIN (a `role:
   * "admin"` account with no shared token in hand) could not revoke a
   * compromised user's tokens without also holding the operator's bearer.
   * Widened to accept EITHER credential, via `requireInstanceAdmin` (which
   * already covers the adminToken bearer too — see its doc comment in
   * `authorize.ts`).
   *
   * Composed by hand rather than calling `requireInstanceAdmin(deps, req,
   * res, …)` directly, because that helper writes its own 401/403 on refusal
   * and this route's refusal must stay a 404: the test this route has always
   * had (`tokens-routes.test.ts`, "revokes every token for a user on an admin
   * request") pins that an unauthorized caller is indistinguishable from a
   * route that does not exist — no existence oracle for user ids. Same
   * primitives `requireInstanceAdmin` is built from (`resolveReadContext` +
   * `lacksWriteScope` + `hasAdminAuthority`), same admission ladder
   * (adminToken bearer, or an active `admin`-role session/PAT with write
   * scope), different response shape on refusal — the same pattern
   * `requireProjectManage` uses in `authorize.ts` for its own
   * different-shape refusal.
   *
   * Idempotent, and it does NOT disclose whether the user exists or held any
   * tokens — same no-existence-oracle rule as the DELETE above.
   */
  router.post("/admin/users/:userId/tokens/revoke-all", async (req, res) => {
    const ctx = await resolveReadContext(deps, req)
    const isInstanceAdmin =
      !("error" in ctx) && !lacksWriteScope(ctx) && hasAdminAuthority(ctx)
    if (!isInstanceAdmin) {
      res.status(404).json({ error: "Not found" })
      return
    }
    await deps.storage.deleteMachineTokensForUser(String(req.params.userId))
    res.status(204).end()
  })

  return router
}
