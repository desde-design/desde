/**
 * Expired-credential sweep — periodically deletes `Session` rows past their
 * `expiresAt` (`StorageAdapter.deleteExpiredSessions`), `SignInToken` rows
 * past theirs (`deleteExpiredSignInTokens`), and (M2) `InstanceInvite` rows
 * that are UNUSED, UNREVOKED, and past theirs (`deleteExpiredInstanceInvites`)
 * — a used or revoked invite is left alone regardless of age, since it is an
 * audit trail rather than a live credential.
 *
 * `getCurrentUser` (`current-user.ts`) already deletes a session
 * opportunistically the moment it's read and found expired, but that only
 * catches sessions someone actually presents a cookie for. A session from a
 * user who never comes back (or whose cookie was cleared) would sit in
 * storage forever without this sweep.
 *
 * Runs unconditionally, regardless of whether `config.githubAuth` is
 * configured — session rows can exist independently of the current GitHub
 * sign-in config (e.g. GitHub sign-in was enabled, sessions were created,
 * then the env vars were removed), and the sweep itself doesn't touch
 * anything auth-specific, just the storage table. Same shape as
 * `outbox-drain.ts`'s tick/scheduler split,
 * including its hardening: the storage call is inside a try/catch so a
 * single bad tick (a locked/busy db handle, a storage IO error) logs and
 * lets the next tick proceed, and the scheduler's invocation carries a
 * `.catch(...)` as belt-and-braces in case a future change reintroduces an
 * unguarded throw path. Either one alone would be enough; together neither
 * a change to this file nor to the scheduler can reintroduce the crash.
 * Without both, an uncaught rejection inside a `setInterval` callback is an
 * unhandled rejection at the process level, which crashes the whole process
 * on Node >=15.
 */

import type { StorageAdapter } from "../storage/types"

export interface SessionSweepDeps {
  storage: StorageAdapter
}

/** Default interval between sweep ticks: 6 hours. */
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Runs one sweep pass. Exported so tests can invoke a single tick directly
 * instead of racing a real interval timer.
 */
export async function runSessionSweepTick(deps: SessionSweepDeps): Promise<void> {
  const now = new Date().toISOString()
  try {
    const deleted = await deps.storage.deleteExpiredSessions(now)
    if (deleted > 0) {
      console.log(`[viewer] session sweep: deleted ${deleted} expired session(s)`)
    }
  } catch (err) {
    console.error("[viewer] session sweep: tick failed:", err)
  }

  // Sign-in tokens ride the same tick (viewer-membership Task 14). They need
  // sweeping MORE than sessions do, not less: a session row requires somebody
  // to have signed in, whereas `POST /auth/magic-link` is unauthenticated, and
  // on an instance with a domain rule every address at that domain is a row an
  // anonymous caller can cause to be written. Redemption sets `usedAt` rather
  // than deleting, so without this pass the table only grows.
  //
  // Its OWN try/catch, deliberately: a failure sweeping one table must not
  // skip the other. Sharing a block would make a busy `sessions` delete
  // silently cancel the sign-in-token pass for that tick, and the two tables
  // have no reason to fail together.
  try {
    const deleted = await deps.storage.deleteExpiredSignInTokens(now)
    if (deleted > 0) {
      console.log(`[viewer] session sweep: deleted ${deleted} expired sign-in token(s)`)
    }
  } catch (err) {
    console.error("[viewer] session sweep: sign-in token tick failed:", err)
  }

  // Instance invites ride the same tick too (viewer-membership M2). They
  // need this less urgently than sign-in tokens do — invites are
  // admin-minted, not an unauthenticated write surface — but a table that
  // only ever grows is still worth trimming. `deleteExpiredInstanceInvites`
  // leaves a USED or REVOKED row alone regardless of age; only one nobody
  // ever acted on is swept.
  //
  // Its OWN try/catch, same reasoning as the sign-in-token pass above: a
  // failure on one table must not skip either of the others.
  try {
    const deleted = await deps.storage.deleteExpiredInstanceInvites(now)
    if (deleted > 0) {
      console.log(`[viewer] session sweep: deleted ${deleted} expired instance invite(s)`)
    }
  } catch (err) {
    console.error("[viewer] session sweep: instance invite tick failed:", err)
  }
}

/**
 * Starts the periodic sweep, running once immediately at boot and then on
 * `intervalMs` (default 6 hours). Returns a stop function; safe to call once
 * at shutdown.
 */
export function startSessionSweep(
  deps: SessionSweepDeps & { intervalMs?: number },
): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_SESSION_SWEEP_INTERVAL_MS

  // Sweep once at boot — don't wait a full interval before the first pass.
  void runSessionSweepTick(deps).catch((err) => {
    console.error("[viewer] session sweep tick failed:", err)
  })

  const timer = setInterval(() => {
    // Belt-and-braces alongside the try/catch inside runSessionSweepTick
    // itself: even if a future change reintroduces an unguarded throw path,
    // this `.catch` keeps it from becoming an unhandled rejection here.
    void runSessionSweepTick(deps).catch((err) => {
      console.error("[viewer] session sweep tick failed:", err)
    })
  }, intervalMs)
  return () => clearInterval(timer)
}
