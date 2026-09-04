/**
 * Audit Task 15 — turns-retention for chat session files.
 *
 * `session-store.ts`'s `saveSession` round-trips the ENTIRE `turns` array
 * on every save (tempfile + rename, whole file). Left unbounded, a
 * long-lived detached session (tasks/editor-detached-sessions.md) grows
 * that array — and the JSON payload rewritten on every turn — forever.
 *
 * Policy: cap the persisted head file at `maxTurns` (default 500, see
 * `DEFAULT_MAX_CHAT_TURNS`; configurable via `.desde/config.json`'s
 * `retention.chatSessionTurns.maxTurns`). On overflow, the oldest turns
 * move to an append-only sidecar — `<sessionId>.archive.jsonl`, one JSON
 * turn per line — NEVER deleted. `saveSession` wires this in
 * automatically; this module holds the pure split logic + the
 * append/read I/O so both are independently testable.
 *
 * Data-loss guard: `saveSession` only trims the head file AFTER the
 * archive append succeeds. If the append fails, the turns stay in the
 * head file (uncapped for that save) rather than being silently dropped
 * — the next successful save retries the trim. Losing chat history is
 * worse than a temporarily-oversized head file.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChatTurn } from './types'
import { costOfTurn } from '../llm-providers/rate-cards'
import { desdeDir } from '../worktree/desde-dir'

/** Default cap on turns kept in a session's head JSON file. */
export const DEFAULT_MAX_CHAT_TURNS = 500

/**
 * Path to the append-only archive sidecar for a session. Builds off
 * {@link desdeDir}, which refuses (throws `DesdeDirSymlinkError`) when
 * `.desde` is a symbolic link — both the writer (`appendArchivedTurns`)
 * and the reader (`readArchivedTurns`) go through this one function, so
 * neither can join onto `repoRoot` directly and skip the check.
 */
export function archiveFilePath(repoRoot: string, sessionId: string): string {
  return join(desdeDir(repoRoot), 'chat-sessions', `${sessionId}.archive.jsonl`)
}

export interface SplitTurnsResult {
  /** Turns that stay in the head file, oldest first (unchanged order). */
  head: ChatTurn[]
  /** Turns to archive, oldest first — empty when under the cap. */
  archived: ChatTurn[]
}

/**
 * Pure split: given the full ordered (oldest-first) turns array and a
 * cap, return the newest `maxTurns` as `head` and everything older as
 * `archived`. A non-positive `maxTurns` is treated as "no cap" (returns
 * everything as `head`) — a misconfigured 0/negative value should never
 * archive every turn out from under a session.
 */
export function splitTurnsForArchive(
  turns: readonly ChatTurn[],
  maxTurns: number,
): SplitTurnsResult {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || turns.length <= maxTurns) {
    return { head: [...turns], archived: [] }
  }
  const overflow = turns.length - maxTurns
  return { head: turns.slice(overflow), archived: turns.slice(0, overflow) }
}

/**
 * Sum of each turn's dollar cost, via the SHARED `costOfTurn`
 * (`rate-cards.ts` — audit Task 15, codex round 4 P2). Previously
 * summed `turn.costUsd` only, silently treating a usage-only turn (no
 * vendor-reported cost — legacy turns, or an SDK response that never
 * captured `total_cost_usd`) as zero; once that turn archived out of
 * the head file, its real (rate-card-estimated) cost vanished from
 * `archivedCostUsd` — and from `computeSessionCost`'s ceiling check —
 * for good. `costOfTurn` falls back to a rate-card estimate from
 * `turn.usage` before giving up and returning 0, matching
 * `computeSessionCost` (`run-chat-turn-sdk.ts`) exactly.
 */
export function sumTurnCostUsd(turns: readonly ChatTurn[]): number {
  let total = 0
  for (const turn of turns) {
    total += costOfTurn(turn)
  }
  return total
}

/**
 * Append `turns` (oldest first) to the session's archive sidecar, one
 * JSON object per line. Creates the file (and the `chat-sessions/` dir)
 * if it doesn't exist yet. No-op for an empty `turns` array — never
 * creates an empty archive file for a session that hasn't overflowed.
 */
export async function appendArchivedTurns(
  repoRoot: string,
  sessionId: string,
  turns: readonly ChatTurn[],
): Promise<void> {
  if (turns.length === 0) return
  const path = archiveFilePath(repoRoot, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const lines = turns.map((turn) => JSON.stringify(turn)).join('\n') + '\n'
  await appendFile(path, lines, 'utf8')
}

/**
 * Read every turn ever archived for a session, oldest first. Missing
 * file → empty array (never archived, or nothing overflowed yet). A
 * trailing torn line (crash mid-`appendFile`) is skipped rather than
 * failing the whole read — the JSONL format guarantees every line
 * BEFORE the torn one is a complete, valid turn.
 */
export async function readArchivedTurns(
  repoRoot: string,
  sessionId: string,
): Promise<ChatTurn[]> {
  const path = archiveFilePath(repoRoot, sessionId)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const turns: ChatTurn[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      turns.push(JSON.parse(trimmed) as ChatTurn)
    } catch {
      // Tolerate a torn trailing line — see doc comment above.
      continue
    }
  }
  return turns
}
