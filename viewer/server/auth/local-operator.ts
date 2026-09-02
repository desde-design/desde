/**
 * Local-operator sign-in: the zero-configuration way to get a session.
 *
 * The pattern is Jupyter's. On boot, when no GitHub sign-in is configured,
 * the process prints a URL carrying a random token. Visiting it mints an
 * ordinary session for an ordinary user row, so ownership, membership,
 * PAT minting and comment authorship all work through their existing code
 * with no special case anywhere downstream. The ONLY thing special about
 * the local operator is how the session started.
 *
 * Threat model, stated plainly: the token is equivalent to a password for
 * the whole deployment, and it is printed to stdout. That is acceptable
 * because it is only ever offered when no real sign-in provider exists,
 * and the viewer's README already requires a trusted network regardless —
 * the build runner executes repository code untrusted. Configure GitHub
 * sign-in and this route does not register at all.
 *
 * The token lives in memory for the process lifetime and is reusable within
 * it. Single-use was considered and rejected: clearing cookies would then
 * require restarting the server, which is a worse failure than a
 * long-lived secret on a machine that already trusts its own stdout.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { ViewerConfig } from "../config"
import { ConflictError } from "../storage/errors"
import type { StorageAdapter, User } from "../storage/types"

export const LOCAL_OPERATOR_EMAIL = "operator@localhost"

/**
 * Should this boot generate and print a local sign-in token?
 *
 * Lives here, not inline in `server/index.ts`, because `index.ts` is the
 * process entry — it calls `next()` and `listen()`, so there is no seam a
 * test can drive it through, and an inline condition would have been
 * unprotected by the whole suite.
 *
 * One condition, and it is load-bearing: a deployment with a real identity
 * provider must never ALSO carry a stdout-printed master key. Mutual exclusion
 * by construction, not by precedence. `auth-routes.ts` enforces the same
 * condition independently at request time, so this is a gate at both ends
 * rather than one gate trusted twice.
 *
 * **A second conjunct on `allowedEmailDomains` used to live here** and was
 * removed with the admission gate (viewer-membership Task 4). Its reason was
 * that `VIEWER_ALLOWED_EMAIL_DOMAINS` was itself an admission gate, rechecked
 * against the stored email on every request (audit K08) — and
 * `operator@localhost` can never be in a real allowlist, so an operator under
 * one would sign in and be dead on their next request. Admission is now
 * `auth/gate.ts`'s job and the env var is converted into stored domain rules
 * at boot (`seedDomainRulesFromEnv`), which have no say over an account that
 * already exists. So the env var no longer has any bearing on whether local
 * sign-in can work, and reading it here would only be a way to disable the
 * one sign-in an unconfigured deployment has.
 */
export function shouldMintLocalOperatorToken(
  config: Pick<ViewerConfig, "githubAuth">,
): boolean {
  return config.githubAuth === null
}

/**
 * The `providerUserId` the operator row is keyed on. Stable, so repeat
 * sign-ins reuse one user.
 *
 * Exported because `storage/migrations.ts` has to recognise this row in raw
 * SQL — migration 1 backfills instance roles and must not mistake the
 * synthetic operator for "the oldest human account". A second hand-written
 * `'local-operator'` literal over there would be a sentinel defined in two
 * places, which is exactly how the two get to disagree.
 */
export const LOCAL_OPERATOR_PROVIDER_USER_ID = "local-operator"

/**
 * Is this user the deployment's local operator?
 *
 * Exported so that a route needing OPERATOR authority — as opposed to the
 * "any signed-in person" authority `requireWrite` grants — can ask without
 * hardcoding the sentinel. `api/setup-routes.ts` is the first such caller:
 * provisioning a GitHub App writes a private key and a client secret that
 * every project on the deployment then builds through, which is not a
 * capability an ordinary signed-in reviewer should hold.
 *
 * Matching on `providerUserId` and not on `email`: the sentinel is
 * UNFORGEABLE because GitHub's own user ids are numeric, so no real GitHub
 * account can ever upsert into this row. `operator@localhost` carries no
 * such guarantee — it is an ordinary string in a column that a future
 * provider, an import, or a seeding script could write.
 */
export function isLocalOperatorUser(user: Pick<User, "provider" | "providerUserId">): boolean {
  return user.provider === "github" && user.providerUserId === LOCAL_OPERATOR_PROVIDER_USER_ID
}

export function createLocalOperatorToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Constant-time compare. Same hash-both-sides-first construction as
 * `authorize.ts`'s `tokensMatch`: `timingSafeEqual` throws on unequal-length
 * buffers, and the candidate here comes straight from a query string.
 */
export function localOperatorTokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest()
  const digestB = createHash("sha256").update(b).digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * Finds the operator user, creating it on first use.
 *
 * `provider: "github"` is a deliberate lie of convenience — inventing a
 * `"local"` variant would ripple through the storage contract, both impls,
 * and the contract suite for a field nothing branches on. The identity is
 * still unambiguous because `providerUserId` is a fixed sentinel that GitHub
 * can never issue (its ids are numeric). Revisit if a second real provider
 * ever lands.
 *
 * The role is `admin` ONLY on the CREATING call, and that is definitional
 * rather than a policy choice: the only way to reach this function on a
 * fresh instance is to hold the boot token, which was printed to the
 * server's own stdout — whoever has it owns the process.
 *
 * On a REPEAT call the existing row is returned exactly as stored,
 * including its role — nothing here re-promotes it back to `admin`. That is
 * deliberate: another admin can demote the operator's row from the Members
 * panel like any other account, and once they have, the boot token must
 * keep signing in as the row that admin decided on, not silently reassert
 * `admin` every time. (`isLocalOperatorUser`, checked independently of the
 * row's CURRENT role, is what still recognizes a demoted operator as "the
 * operator" for the one narrow action that stays theirs regardless — the
 * GitHub App setup flow, `api/setup-routes.ts`'s `requireOperator`. For
 * everything else a demoted operator is bound by their demoted role like
 * anyone else.)
 *
 * The rest of the profile — email, display name, avatar — IS a genuine
 * constant, so nothing there is refreshed on a repeat call either; there is
 * simply nothing an update could carry for those fields.
 *
 * ## The lookup and the create are two awaits, so it has to be idempotent
 *
 * "Not found, therefore create" is a read followed by a write with a gap in
 * between, and both halves of the boot flow can be in that gap at once: the
 * boot banner's URL is routinely opened in two tabs, and `signInLocalOperator`
 * calls this on every hit. Whichever caller loses writes into a UNIQUE
 * constraint — storage refuses a second row holding `operator@localhost` — and
 * the loser used to surface that as a 500 on a sign-in that had, in fact,
 * succeeded for the other tab.
 *
 * So a `ConflictError` here is re-read, not re-thrown: the row the winner just
 * created is exactly the row this call was going to return anyway, which makes
 * the function idempotent under concurrency rather than merely usually
 * correct.
 *
 * The re-read is what decides it, not the error type alone. If the row still
 * is not there, the conflict was about something else — most plausibly
 * `operator@localhost` held by a DIFFERENT provider identity, which is a real
 * refusal and must not be swallowed — so the original error is rethrown
 * untouched.
 */
export async function ensureLocalOperatorUser(storage: StorageAdapter): Promise<User> {
  const existing = await storage.getUserByProviderIdentity(
    "github",
    LOCAL_OPERATOR_PROVIDER_USER_ID,
  )
  if (existing) return existing

  try {
    return await storage.createUser({
      provider: "github",
      providerUserId: LOCAL_OPERATOR_PROVIDER_USER_ID,
      email: LOCAL_OPERATOR_EMAIL,
      displayName: "Local operator",
      avatarUrl: "",
      role: "admin",
    })
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err
    const raced = await storage.getUserByProviderIdentity(
      "github",
      LOCAL_OPERATOR_PROVIDER_USER_ID,
    )
    if (raced) return raced
    throw err
  }
}

export type LocalOperatorSignInResult =
  | { admitted: true; sessionId: string }
  | { admitted: false }

/**
 * Mints a session for the local operator — UNLESS that row has been
 * explicitly `removed` (Fix wave M1 review).
 *
 * This bypasses `admitSignIn`/`gate.ts` entirely (it isn't a provider
 * sign-in), so without this check `removed` had no effect here: an admin
 * could remove the operator's account from the Members panel and the same
 * printed boot token would keep minting fresh sessions for it forever — the
 * one credential a removal is supposed to kill.
 *
 * Once removed, the boot token holder can no longer self-admit through this
 * route. Recovery is out of band: another admin restores the row from the
 * Members panel, or someone holding the separate `adminToken` bearer acts in
 * its place. There is deliberately no third way back in — the same
 * "never a second way in" rule this file's own doc comment states for the
 * boot token generally.
 */
export async function signInLocalOperator(
  storage: StorageAdapter,
  maxAgeSeconds: number,
): Promise<LocalOperatorSignInResult> {
  const user = await ensureLocalOperatorUser(storage)
  if (user.status === "removed") return { admitted: false }
  const session = await storage.createSession({
    userId: user.id,
    expiresAt: new Date(Date.now() + maxAgeSeconds * 1000).toISOString(),
  })
  return { admitted: true, sessionId: session.id }
}
