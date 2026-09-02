/**
 * Revokes every standing credential kind an account can hold — the single
 * implementation shared by every place that has to guarantee an account is
 * fully locked out, not just refused its NEXT sign-in.
 *
 * Fix wave 10, item 3. The four kinds:
 *
 * 1. Live sessions (`deleteSessionsForUser`)
 * 2. `dsv_` machine tokens (`deleteMachineTokensForUser`)
 * 3. Outstanding sign-in links tied to this ACCOUNT (`deleteSignInTokensForUser`)
 * 4. Outstanding sign-in links tied to this EMAIL ADDRESS
 *    (`deleteSignInTokensForEmail`) — a domain-rule self-serve-join link
 *    names no account, only an address, so it cannot be reached by (3) alone.
 *
 * All four run independently via `Promise.allSettled`, not sequentially. A
 * sequential run that throws partway leaves everything AFTER the throw
 * un-revoked — measured as a real gap: `deleteMachineTokensForUser` failing
 * used to mean the two sign-in-token deletions after it in
 * `instance-routes.ts`'s member-removal route never even ran, leaving an
 * outstanding sign-in link fully redeemable on an account that was supposed
 * to be locked out.
 *
 * Returns which of the four failed rather than throwing, because the two
 * callers do DIFFERENT things with a partial failure:
 *
 * - `instance-routes.ts` (removing or restoring a member — a person-facing
 *   admin action) surfaces it as a 500 rather than silently reporting
 *   success on an account that is still not fully locked out.
 * - `auth-routes.ts`'s `revokeStandingCredentials` (cleanup after a REFUSED
 *   sign-in, where the caller's response is already decided either way)
 *   only logs it — a storage hiccup there must not turn a policy refusal
 *   into a 500.
 */
import type { StorageAdapter } from "../storage/types"

export interface RevokeAllCredentialsResult {
  ok: boolean
  /** One entry per revocation that rejected, in a fixed order — for logging. */
  failures: { step: string; error: unknown }[]
}

/** The subset of `StorageAdapter` this needs — narrow enough that a caller can pass a partial fake in tests without implementing the rest of the interface. */
export type CredentialRevocationStorage = Pick<
  StorageAdapter,
  | "deleteSessionsForUser"
  | "deleteMachineTokensForUser"
  | "deleteSignInTokensForUser"
  | "deleteSignInTokensForEmail"
>

export async function revokeAllCredentials(
  storage: CredentialRevocationStorage,
  user: { id: string; email: string },
): Promise<RevokeAllCredentialsResult> {
  const steps: { step: string; run: () => Promise<unknown> }[] = [
    { step: "sessions", run: () => storage.deleteSessionsForUser(user.id) },
    { step: "machineTokens", run: () => storage.deleteMachineTokensForUser(user.id) },
    { step: "signInTokensForUser", run: () => storage.deleteSignInTokensForUser(user.id) },
    { step: "signInTokensForEmail", run: () => storage.deleteSignInTokensForEmail(user.email) },
  ]
  const settled = await Promise.allSettled(steps.map((s) => s.run()))
  const failures = settled.flatMap((result, i) =>
    result.status === "rejected" ? [{ step: steps[i].step, error: result.reason }] : [],
  )
  return { ok: failures.length === 0, failures }
}
