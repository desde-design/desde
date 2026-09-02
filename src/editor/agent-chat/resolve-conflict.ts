/**
 * Conflict resolution primitive — Phase 4 §4 of
 * tasks/editor-detached-sessions.md.
 *
 * Given a session + a conflicted file, applies either:
 *
 *   - "mine":   write the loser's intended `newSource` (recovered from
 *               the latest matching proposal blob) to disk, overwriting
 *               whatever won. Clear the conflict + delete the blob.
 *   - "theirs": no disk write — the file already carries the winner's
 *               content. Just clear the conflict + delete the blob.
 *
 * "Merge" — running 3-way merge against the read-time base — is Phase 4b;
 * this primitive only handles the binary path.
 *
 * Returns a discriminated result so the route can render the correct
 * HTTP shape. Throws for filesystem errors that the caller can't
 * meaningfully recover from (e.g. session record fails to persist after
 * a successful disk write — leaves the worktree inconsistent vs. the
 * session record and that needs surfacing).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

import { deleteProposalBlobsForSession, readProposalBlob } from '../agent-chat-sdk/proposal-blob-store'
import { mergeContent } from './merge-content'
import { saveSession } from './session-store'
import type { ChatSession } from './types'

export type ResolutionKind = 'mine' | 'theirs' | 'merge'

export interface ResolveConflictArgs {
  /** Absolute path to the worktree root. */
  worktreeRoot: string
  /** Pre-loaded session record. The caller already validated it belongs to the project. */
  session: ChatSession
  /**
   * Repo-relative OR absolute file path. The conflicts map keys are
   * absolute (canonical via realpath); the caller may pass either —
   * we normalize before lookup.
   */
  file: string
  resolution: ResolutionKind
}

export type ResolveConflictResult =
  | {
      ok: true
      /**
       * For 'mine' / 'theirs' / clean 'merge': sha256 of whatever now
       * lives on disk. For conflicted 'merge': sha256 of the
       * conflict-marked content (the resolver pane will consume the
       * markers and ack with the user's edited content separately).
       */
      finalHash: string
      /** Number of blobs deleted as part of this resolution. */
      blobsDeleted: number
      /**
       * For 'merge' resolutions: did git merge-file produce a clean
       * result? Undefined for 'mine' / 'theirs'.
       */
      mergeClean?: boolean
      /**
       * For a CONFLICTED 'merge' (mergeClean === false): the
       * merged content with `<<<<<<<` markers, so the resolver pane
       * can render side-by-side and let the user hand-edit. The
       * conflict has NOT been cleared from the session record;
       * the user must call apply-merge-resolution to commit.
       */
      mergeContent?: string
    }
  | {
      ok: false
      status: number
      reason: string
    }

/**
 * Locate the latest edit-proposal in the session whose `files` list
 * includes the requested file. The blob for that editId carries the
 * session's intended newSource for the file. When the session
 * touched the same file across multiple turns, the LATEST proposal
 * wins (matches the SDK's append-only write semantics: each new
 * Write replaces the prior intended state).
 */
function findLatestProposalEditIdForFile(
  session: ChatSession,
  fileRepoRelative: string,
  fileAbsolute: string,
): string | null {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const turn = session.turns[i]
    if (!turn.editProposals) continue
    for (let j = turn.editProposals.length - 1; j >= 0; j--) {
      const proposal = turn.editProposals[j]
      if (!proposal.files) continue
      // Match either shape — the orchestrator persists repo-relative
      // (per `recordProposal` in run-chat-turn-sdk.ts), but be
      // defensive about absolute path mismatches too in case the
      // schema drifts in the future.
      if (
        proposal.files.includes(fileRepoRelative) ||
        proposal.files.includes(fileAbsolute)
      ) {
        return proposal.editId
      }
    }
  }
  return null
}

/**
 * Normalize a caller-supplied file argument to both shapes the
 * session record may use as keys.
 */
function normalizeFile(
  worktreeRoot: string,
  file: string,
): { absolute: string; repoRelative: string } {
  if (isAbsolute(file)) {
    const root = worktreeRoot.endsWith('/') ? worktreeRoot : `${worktreeRoot}/`
    const repoRelative = file === worktreeRoot
      ? ''
      : file.startsWith(root)
        ? file.slice(root.length)
        : file
    return { absolute: file, repoRelative }
  }
  return { absolute: join(worktreeRoot, file), repoRelative: file }
}

export async function resolveSessionConflict(
  args: ResolveConflictArgs,
): Promise<ResolveConflictResult> {
  const { worktreeRoot, session, resolution } = args
  const { absolute, repoRelative } = normalizeFile(worktreeRoot, args.file)
  const conflicts = session.conflicts ?? {}
  const conflictEntry = conflicts[absolute] ?? conflicts[repoRelative]
  if (!conflictEntry) {
    return {
      ok: false,
      status: 404,
      reason: `No conflict recorded for '${args.file}' in this session.`,
    }
  }

  let finalHash: string
  const blobsDeleted = 0
  let mergeClean: boolean | undefined
  let mergeContentOut: string | undefined

  if (resolution === 'merge') {
    // 3-way merge: base (from PreToolUse Read hook sidecar) + mine
    // (from proposal blob) + theirs (current working tree). Phase 4b.
    const editId = findLatestProposalEditIdForFile(session, repoRelative, absolute)
    if (!editId) {
      return {
        ok: false,
        status: 409,
        reason: `Cannot merge '${args.file}': no proposal blob is recorded for this session.`,
      }
    }
    const mineBlob = await readProposalBlob(worktreeRoot, session.id.sessionId, editId)
    if (mineBlob === null) {
      return {
        ok: false,
        status: 409,
        reason: `Cannot merge '${args.file}': proposal blob for editId=${editId} is missing on disk.`,
      }
    }
    // Base content lives at
    // `<repoRoot>/.desde/chat-sessions/<sessionId>/bases/<sha>.txt`
    // courtesy of the Phase 4 §2 PreToolUse Read hook. The
    // conflictEntry already carries `hashAtRead` so we know which
    // sha to load.
    const basePath = join(
      worktreeRoot,
      '.desde',
      'chat-sessions',
      session.id.sessionId,
      'bases',
      `${conflictEntry.hashAtRead}.txt`,
    )
    let baseContent: string
    try {
      baseContent = await readFile(basePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          ok: false,
          status: 409,
          reason: `Cannot merge '${args.file}': base snapshot for hashAtRead=${conflictEntry.hashAtRead.slice(0, 8)} is missing. The session may have been created before base-content capture was enabled.`,
        }
      }
      return {
        ok: false,
        status: 500,
        reason: `Failed to read base snapshot: ${(err as Error).message}`,
      }
    }
    let theirsContent: string
    try {
      theirsContent = await readFile(absolute, 'utf8')
    } catch (err) {
      return {
        ok: false,
        status: 500,
        reason: `Failed to read current file '${args.file}': ${(err as Error).message}`,
      }
    }
    const mergeResult = await mergeContent({
      base: baseContent,
      mine: mineBlob,
      theirs: theirsContent,
      labels: {
        mine: `${session.id.sessionId} (mine)`,
        theirs: 'on disk (theirs)',
        base: `read-time base`,
      },
    })
    if (!mergeResult.ok) {
      return { ok: false, status: 500, reason: mergeResult.reason }
    }
    if (mergeResult.clean) {
      try {
        await writeFile(absolute, mergeResult.content, 'utf8')
      } catch (err) {
        return {
          ok: false,
          status: 500,
          reason: `Failed to write merged content to '${args.file}': ${(err as Error).message}`,
        }
      }
      finalHash = await sha256(mergeResult.content)
      mergeClean = true
    } else {
      // Conflicted merge: do NOT write to disk + do NOT clear the
      // conflict. Return the marker-bearing content so the
      // resolver-pane UI can render it. The user's apply-merge-
      // resolution call lands the final content + clears the
      // conflict in a follow-up endpoint.
      finalHash = await sha256(mergeResult.content)
      mergeClean = false
      mergeContentOut = mergeResult.content
      return {
        ok: true,
        finalHash,
        blobsDeleted,
        mergeClean,
        mergeContent: mergeContentOut,
      }
    }
  } else if (resolution === 'mine') {
    // Find the latest proposal-blob for this file in this session,
    // then write it to disk. Without a blob we can't recover the
    // loser's intended content — fail clearly.
    const editId = findLatestProposalEditIdForFile(session, repoRelative, absolute)
    if (!editId) {
      return {
        ok: false,
        status: 409,
        reason: `Cannot use mine for '${args.file}': no proposal blob is recorded for this session. The blob may have been GC'd, or the file was never written by this session.`,
      }
    }
    const blob = await readProposalBlob(worktreeRoot, session.id.sessionId, editId)
    if (blob === null) {
      return {
        ok: false,
        status: 409,
        reason: `Cannot use mine for '${args.file}': proposal blob for editId=${editId} is missing on disk.`,
      }
    }
    try {
      await writeFile(absolute, blob, 'utf8')
    } catch (err) {
      return {
        ok: false,
        status: 500,
        reason: `Failed to write '${args.file}': ${(err as Error).message}`,
      }
    }
    finalHash = await sha256(blob)
  } else {
    // "theirs" — the file already has the winning content; just
    // confirm the on-disk hash matches what the conflict recorded
    // as `hashAtWrite`. If it doesn't, the file was touched again
    // between the conflict detection and now — surface it.
    finalHash = conflictEntry.hashAtWrite
  }

  // Clear the conflict from the session record + persist. Use
  // BOTH potential key shapes so a defensive double-key situation
  // (shouldn't happen but doesn't hurt) cleans up cleanly.
  const nextConflicts = { ...conflicts }
  delete nextConflicts[absolute]
  delete nextConflicts[repoRelative]
  const nextSession: ChatSession = {
    ...session,
    conflicts: Object.keys(nextConflicts).length > 0 ? nextConflicts : undefined,
  }
  // Codex round 2 audit (Task 15 Batch 5 gate, P2): `resolveSessionConflict`
  // does exactly ONE `saveSession` per invocation and neither `nextSession`
  // nor `session` is read again after this call — the stale-in-memory
  // pattern that bit `chat-handler.ts` (a save trims turns, but the caller
  // keeps using its pre-save reference for a LATER save in the same
  // request) can't occur here. Not reassigning/returning the persisted
  // (possibly-trimmed) session is safe by construction, not an oversight.
  try {
    await saveSession(worktreeRoot, nextSession)
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: `Failed to persist resolved session: ${(err as Error).message}`,
    }
  }

  // GC the proposal blob(s) for this session. Best-effort — leaving
  // a blob behind only costs disk; the next session-wide clear
  // (or the per-blob path being re-used by a fresh editId) cleans
  // it up. We don't enumerate per-file because the entire session
  // is GC'd at save commit time anyway; for now, leave the blobs
  // alone and rely on save-time cleanup. Documented gap.
  void blobsDeleted

  return {
    ok: true,
    finalHash,
    blobsDeleted,
    ...(mergeClean !== undefined ? { mergeClean } : {}),
  }
}

async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Phase 4b — apply the user's hand-edited merge resolution. Called
 * from the resolver pane after the user has stripped conflict
 * markers from the merge output. Writes the final content to disk,
 * clears the conflict from the session record, and returns the
 * post-write hash.
 *
 * Refuses if the supplied content still contains conflict markers —
 * that's a strong signal the user clicked Apply too early.
 */
export interface ApplyMergeResolutionArgs {
  worktreeRoot: string
  session: ChatSession
  file: string
  /** The user's hand-edited content — no `<<<<<<<` markers allowed. */
  resolvedContent: string
}

export async function applyMergeResolution(
  args: ApplyMergeResolutionArgs,
): Promise<ResolveConflictResult> {
  const { worktreeRoot, session, resolvedContent } = args
  const { absolute, repoRelative } = normalizeFile(worktreeRoot, args.file)
  const conflicts = session.conflicts ?? {}
  const conflictEntry = conflicts[absolute] ?? conflicts[repoRelative]
  if (!conflictEntry) {
    return {
      ok: false,
      status: 404,
      reason: `No conflict recorded for '${args.file}' in this session.`,
    }
  }
  const { containsConflictMarkers } = await import('./merge-content')
  if (containsConflictMarkers(resolvedContent)) {
    return {
      ok: false,
      status: 400,
      reason: `Resolved content still contains conflict markers. Strip the <<<<<<< / ======= / >>>>>>> blocks before applying.`,
    }
  }
  try {
    await writeFile(absolute, resolvedContent, 'utf8')
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: `Failed to write '${args.file}': ${(err as Error).message}`,
    }
  }
  const finalHash = await sha256(resolvedContent)
  const nextConflicts = { ...conflicts }
  delete nextConflicts[absolute]
  delete nextConflicts[repoRelative]
  const nextSession: ChatSession = {
    ...session,
    conflicts: Object.keys(nextConflicts).length > 0 ? nextConflicts : undefined,
  }
  // Same audit note as `resolveSessionConflict` above: ONE `saveSession`
  // per invocation, `nextSession` unused afterward — no stale-in-memory
  // reference survives this call, so no fix needed here.
  try {
    await saveSession(worktreeRoot, nextSession)
  } catch (err) {
    return {
      ok: false,
      status: 500,
      reason: `Failed to persist resolved session: ${(err as Error).message}`,
    }
  }
  return { ok: true, finalHash, blobsDeleted: 0 }
}

// Re-export the blob store's GC helper so callers don't need a
// second import when they handle the post-save sweep.
export { deleteProposalBlobsForSession }
