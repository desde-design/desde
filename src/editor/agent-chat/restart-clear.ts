/**
 * Phase 5 of tasks/editor-detached-sessions.md — restart cleanup
 * for stale in-flight chat sessions.
 *
 * Why it exists: a editor-cli process that crashes (or is killed)
 * mid-turn leaves the affected `ChatSession` file on disk with
 * `status: "in-flight"`. The session's actual turn never finished;
 * the `activeTurns` lock is gone (it was process-local); the
 * concurrency cap doesn't know about it. Without cleanup the chat
 * tab strip would render the session with a "Running…" indicator
 * forever and the next startup wouldn't know which sessions to treat
 * as live.
 *
 * What it does: scan `.desde/chat-sessions/`, find every JSON
 * file whose persisted `status === "in-flight"`, rewrite it to
 * `status: "cancelled", statusReason: "restart-clear"`. The on-disk
 * file is preserved (we don't delete the transcript); the tab strip
 * filters cancelled out via `listSessionsForProject`.
 *
 * What it does NOT do:
 *   - Delete any files (forensic value of the transcript preserved).
 *   - Cancel currently-live sessions in the current process — only
 *     sessions persisted as `in-flight` from a PRIOR process.
 *   - Touch the working tree. Branch-mode edits land on disk directly,
 *     independent of chat-session bookkeeping; the checked-out branch
 *     is canonical for "what was written," and a crashed CLI process
 *     leaves it exactly as it was at the moment of the crash.
 *
 * Run once per CLI process at startup, BEFORE any new chat request
 * is handled. The primitive is idempotent — running twice without
 * any intervening in-flight turn is a no-op.
 */

import { readdir, readFile, rename, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { desdePath } from '../worktree/desde-dir'
import {
  normalizeLoadedSession,
  projectIdForRepoRoot,
} from './session-store'
import type { ChatSession } from './types'

/**
 * Reason text stamped on `statusReason` for cleared sessions. Drawer
 * tooltips render this verbatim so users can tell "your CLI restarted
 * mid-turn" from "the turn failed mid-stream."
 */
export const RESTART_CLEAR_REASON = 'restart-clear'

export interface RestartClearResult {
  /** Number of sessions whose `status` was rewritten this pass. */
  cleared: number
  /** Number of session files scanned (independent of action taken). */
  scanned: number
  /** Errors encountered per file. Best-effort: one bad file doesn't abort the pass. */
  errors: { file: string; reason: string }[]
}

/**
 * Run the restart-clear pass against `repoRoot`. Safe to call when
 * `<repoRoot>/.desde/chat-sessions/` doesn't exist — returns a
 * zero result. Errors are collected per-file; the pass continues
 * past any single failure so a corrupt JSON file doesn't strand the
 * remaining sessions.
 */
export async function runRestartClear(
  repoRoot: string,
): Promise<RestartClearResult> {
  const expectedProjectId = projectIdForRepoRoot(repoRoot)
  const result: RestartClearResult = { cleared: 0, scanned: 0, errors: [] }

  // Boot path: this runs before the CLI serves anything, and its own
  // contract is "never block CLI boot". A `.desde` the repo ships as a
  // symlink is reported like any other unreadable directory.
  let dir: string
  try {
    dir = desdePath(repoRoot, 'chat-sessions')
  } catch (err) {
    result.errors.push({ file: repoRoot, reason: (err as Error).message })
    return result
  }

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result
    // Other readdir failures (EACCES, etc.) — collect + return so the
    // caller can log. Don't throw; restart must never block CLI boot.
    result.errors.push({
      file: dir,
      reason: `readdir failed: ${(err as Error).message}`,
    })
    return result
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.includes('.tmp-')) continue
    const path = join(dir, entry)
    const expectedSessionId = entry.slice(0, -'.json'.length)
    result.scanned++
    let tmp: string | null = null
    try {
      const raw = await readFile(path, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Corrupt file — already a problem on the listing endpoint
        // which silently skips it. Not our job to repair.
        result.errors.push({ file: entry, reason: 'malformed JSON' })
        continue
      }
      // Codex round-1 #6: validate the schema + projectId + sessionId
      // matches the filename before rewriting. Reusing the same
      // normalizer as the listing endpoint keeps the two views in
      // sync; a foreign-project record in the same dir is silently
      // skipped (the listing already does this).
      const normalized = normalizeLoadedSession(
        parsed,
        expectedProjectId,
        expectedSessionId,
      )
      if (!normalized) continue
      if (normalized.status !== 'in-flight') continue
      // Rewrite to cancelled. Use the same tempfile + rename pattern
      // as `saveSession` so a crash mid-write leaves either the prior
      // file intact or the new one fully written.
      const now = new Date().toISOString()
      const cleared: ChatSession = {
        ...normalized,
        status: 'cancelled',
        statusReason: RESTART_CLEAR_REASON,
        statusUpdatedAt: now,
        updatedAt: now,
      }
      tmp = `${path}.tmp-${randomUUID()}`
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmp, JSON.stringify(cleared, null, 2), 'utf8')
      await rename(tmp, path)
      tmp = null
      result.cleared++
    } catch (err) {
      result.errors.push({
        file: entry,
        reason: `restart-clear failed: ${(err as Error).message}`,
      })
      // Codex round-1 #9: clean up the tempfile if write succeeded
      // but rename failed (or write threw mid-stream). Otherwise
      // the tempfile accumulates forever. unlink is best-effort —
      // a residual orphan is harmless (listing filters .tmp-).
      if (tmp) {
        try {
          await unlink(tmp)
        } catch {
          // already gone or never created
        }
      }
    }
  }

  return result
}
