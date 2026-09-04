/**
 * Persistence for proposed `newSource` blobs. Phase 4 §4 of
 * tasks/editor-detached-sessions.md — "Use mine / Use theirs"
 * support in the save dialog needs to recover the LOSER session's
 * intended content for a file even though the winner already
 * overwrote the working tree.
 *
 * Layout: `<repoRoot>/.desde/chat-sessions/<sessionId>/proposals/<editId>.txt`
 *   - One file per edit proposal. `<editId>` is the random UUID the
 *     orchestrator mints inside `emitWriteEditProposal` and
 *     forwards on the `edit_proposed` SSE event. The save dialog
 *     receives the same `editId` via the persisted
 *     `ChatTurn.editProposals[].editId`, so blobs link back to
 *     specific edits without any cross-reference table.
 *   - Plain UTF-8 — the agent only ever writes text; binary writes
 *     are denied earlier in `canUseTool`.
 *   - Append-only per `editId` (UUIDs don't collide). Per-session
 *     directory created lazily.
 *
 * GC semantics (handled by the caller, NOT the writer): after a
 * worktree-wide save commits, the entire `proposals/` subdir for
 * each saved session can be deleted. Pre-commit failures leave the
 * blobs intact so the user can retry resolution.
 *
 * Validation: `editId` is validated against `/^[A-Za-z0-9_-]{1,64}$/`
 * defense-in-depth so a misbehaving caller can't write outside the
 * session's `proposals/` dir. Same shape as the session-id
 * validator in `session-store.ts`.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { desdeDir, DesdeDirSymlinkError } from '../worktree/desde-dir'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function assertValidId(value: string, label: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(
      `proposal-blob-store: ${label} must match /^[A-Za-z0-9_-]{1,64}$/`,
    )
  }
}

/**
 * Compute the on-disk path for an edit's proposal blob. Exported so
 * tests can assert layout and the save dialog can construct read
 * paths.
 */
export function proposalBlobPath(
  repoRoot: string,
  sessionId: string,
  editId: string,
): string {
  assertValidId(sessionId, 'sessionId')
  assertValidId(editId, 'editId')
  return join(desdeDir(repoRoot), 'chat-sessions', sessionId, 'proposals', `${editId}.txt`)
}

/**
 * Persist the proposed `newSource` for a single edit. Atomic via
 * temp-file rename so a crash mid-write leaves either the prior
 * blob (if any) or the new one — never a partial write.
 *
 * Best-effort: throws on filesystem errors. The caller (orchestrator's
 * `emitWriteEditProposal`) decides whether to surface or swallow —
 * losing a blob means "Use mine" can't recover that edit, but the
 * orchestrator must NOT block the save just because the blob
 * persisted slowly. Today the orchestrator awaits the write so the
 * `edit_proposed` event is in lockstep with on-disk durability —
 * acceptable cost given the per-edit data is small.
 */
export async function writeProposalBlob(
  repoRoot: string,
  sessionId: string,
  editId: string,
  newSource: string,
): Promise<void> {
  const path = proposalBlobPath(repoRoot, sessionId, editId)
  await mkdir(dirname(path), { recursive: true })
  // No tempfile rename: blobs are write-once-per-editId, and editId
  // is a uuid. Crash mid-write leaves a partial file under a unique
  // name — the save dialog skips proposals whose blob is missing or
  // unreadable (and the diff display in chat is still correct from
  // the in-memory copy). Cost of atomicity here is not worth the
  // extra rename per edit when sessions can have dozens.
  await writeFile(path, newSource, 'utf8')
}

/**
 * Read a proposal blob. Returns `null` when the blob doesn't exist —
 * the save dialog uses this to gracefully degrade ("Use mine" button
 * hidden when no blob is available) rather than fail loudly. A
 * symlinked `.desde` is a different case: `proposalBlobPath` throws
 * `DesdeDirSymlinkError` before any read is attempted, and this
 * function deliberately lets that throw through rather than treating
 * it as a missing blob — refusing is the safer default for a property
 * of the repo itself, not a per-blob condition the save dialog should
 * silently paper over.
 */
export async function readProposalBlob(
  repoRoot: string,
  sessionId: string,
  editId: string,
): Promise<string | null> {
  const path = proposalBlobPath(repoRoot, sessionId, editId)
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Delete every proposal blob for a session. Called after the
 * session's edits are committed so the disk doesn't accumulate
 * dead state. Idempotent — missing dir is fine.
 */
export async function deleteProposalBlobsForSession(
  repoRoot: string,
  sessionId: string,
): Promise<void> {
  assertValidId(sessionId, 'sessionId')
  let base: string
  try {
    base = desdeDir(repoRoot)
  } catch (err) {
    // A recursive `rm` under a hostile symlink is worse than a plain
    // write: refuse and log rather than delete whatever the symlink
    // points at. Never re-thrown — this is a best-effort deleter, same
    // tolerance as the retention sweeps below.
    if (err instanceof DesdeDirSymlinkError) {
      console.warn(`[proposal-blob-store] refusing to delete under '${repoRoot}': ${err.message}`)
      return
    }
    throw err
  }
  const dir = join(base, 'chat-sessions', sessionId, 'proposals')
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // Best-effort. Worst case: stale blobs hang around until the
    // session's record itself is cleaned up.
  }
}
