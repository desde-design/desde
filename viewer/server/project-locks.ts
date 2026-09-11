import { createKeyedLock } from "./keyed-lock"

/**
 * An in-process mutex, one per project id, for the two write paths that must
 * never interleave on the same project: deleting it, and starting a new
 * deployment for it.
 *
 * Fix wave 10, item 2. Without this, a `DELETE /projects/:id` and a build (or
 * bundle-upload) start could race on the SAME project: `deleteProject`
 * cascades the project's own deployment rows away, and a build-start racing
 * in the same window could read the project as still existing, create a
 * fresh deployment row, and hand it to a runner that then writes an asset
 * directory nothing will ever serve or clean up — a build stranded under a
 * project that no longer exists. `withProjectLock` makes those two paths
 * serialize on the SAME project id, so one of them always sees the other's
 * committed result rather than a half-finished one.
 *
 * This is a single-process lock — it does nothing across multiple Node
 * processes. That is consistent with the rest of the viewer: it is a
 * self-hostable single-process app (see CLAUDE.md), so there is no second
 * process to race against.
 *
 * **Callers must not nest a `withProjectLock` call for the SAME project id
 * inside another one's `fn`.** The lock is not reentrant: an inner call
 * queues behind the outer call's own tail, which cannot settle until the
 * inner call resolves — a deadlock. Nothing here detects or prevents that;
 * it is a contract on callers, not a runtime check.
 */

const projectLocks = createKeyedLock()

/**
 * Runs `fn` with the lock for `projectId` held, waiting for every earlier
 * contender on the SAME project id to finish first (success or failure
 * alike — a thrown `fn` still releases the lock). Contenders on a DIFFERENT
 * project id never wait on each other.
 *
 * Resolves or rejects with exactly what `fn` did. The lock is released
 * before that settles, so awaiting the returned promise is enough — there is
 * no separate "unlock" call.
 */
export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return projectLocks.run(projectId, fn)
}
