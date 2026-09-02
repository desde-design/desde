/**
 * Save-time GC for proposal blobs. Phase 4 §4 of
 * tasks/editor-detached-sessions.md.
 *
 * After a successful worktree-wide save, every chat-session's
 * `proposals/` directory can be deleted — the auto-applied edits are
 * now in git, and any unresolved conflicts the user wanted to flip via
 * "Use mine" should have been resolved BEFORE the save (the worktree
 * is canonical).
 *
 * **Trigger-semantics shift (audit Task 15, codex round 1).** This
 * module predates Task 15 and was written for worktree-session mode's
 * TERMINAL save (Commit-promotes-to-main, one-shot). It was never
 * actually wired to a trigger until Task 15 connected it to branch
 * mode's nav-bar Commit — a ROUTINE, repeatable action a designer
 * fires many times per editing session, not a terminal one. Under the
 * original "delete every session's proposals/ unconditionally" logic
 * that distinction is load-bearing: a routine Commit can easily land
 * while a DIFFERENT session still has an unresolved multi-file
 * conflict sitting in the save dialog — sweeping that session's blobs
 * out from under it would make `resolve-conflict.ts`'s "mine"/"merge"
 * paths 409 with no way to recover the loser's intended content ever
 * again. So the sweep now SKIPS any session whose persisted
 * `conflicts` map is non-empty — its blobs stay until the conflict is
 * resolved (which itself deletes the blob, see `resolve-conflict.ts`)
 * or the session record is independently cleaned up.
 *
 * Best-effort: failures log a warning but don't break the save flow.
 * Worst case: stale blobs sit on disk until the user manually GC's
 * the `.desde/chat-sessions/` tree or until the session record
 * itself gets cleaned up (restart-clear, etc.).
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { deleteProposalBlobsForSession } from './proposal-blob-store'

/**
 * Sweep every chat-session under the worktree's
 * `.desde/chat-sessions/` tree and delete its `proposals/`
 * subdir — UNLESS that session's persisted `conflicts` map is
 * non-empty (see the module header's "trigger-semantics shift" note).
 * Returns the number of sessions actually cleared (for logging
 * upstream); sessions skipped for having unresolved conflicts are not
 * counted.
 */
export async function gcAllProposalBlobs(repoRoot: string): Promise<number> {
  const dir = join(repoRoot, '.desde', 'chat-sessions')
  let entries: string[]
  try {
    entries = await readdir(dir, { withFileTypes: true }).then((dirents) =>
      dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    // Other errors: log and bail out; don't break the save.
    console.warn(
      `[proposal-blob-gc] failed to read .desde/chat-sessions: ${(err as Error).message}`,
    )
    return 0
  }
  let cleared = 0
  for (const sessionId of entries) {
    if (await sessionHasUnresolvedConflicts(repoRoot, sessionId)) {
      continue
    }
    // The directory naming uses sessionId verbatim (validated by the
    // store's writes). Delegate to the store's per-session delete so
    // path-traversal validation runs once more.
    try {
      await deleteProposalBlobsForSession(repoRoot, sessionId)
      cleared++
    } catch (err) {
      console.warn(
        `[proposal-blob-gc] failed to clear proposals for ${sessionId}: ${(err as Error).message}`,
      )
    }
  }
  return cleared
}

/**
 * Best-effort check of `<sessionId>.json`'s persisted `conflicts` map.
 * Missing or malformed session files (no record on disk, or a parse
 * failure) are treated as "no conflicts" — there's nothing to protect,
 * and the pre-existing GC-tolerance discipline in this module is to
 * degrade toward sweeping rather than toward silently accumulating
 * blobs forever on an unreadable record.
 */
async function sessionHasUnresolvedConflicts(
  repoRoot: string,
  sessionId: string,
): Promise<boolean> {
  const sessionFile = join(repoRoot, '.desde', 'chat-sessions', `${sessionId}.json`)
  try {
    const raw = await readFile(sessionFile, 'utf8')
    const parsed = JSON.parse(raw) as { conflicts?: Record<string, unknown> }
    return !!parsed.conflicts && Object.keys(parsed.conflicts).length > 0
  } catch {
    return false
  }
}
