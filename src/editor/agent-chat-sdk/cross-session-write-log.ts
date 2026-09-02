/**
 * Process-global in-memory write log for cross-session attribution on
 * `edit_overwrite_warning`.
 *
 * The persisted scan in [`findRecentWriterForFile`](../agent-chat/session-store.ts)
 * only finds chat sessions whose turns have already been `saveSession`'d.
 * That misses the case the warning was designed for: an OTHER chat
 * session that wrote the file mid-stream and hasn't finished its turn
 * yet (so its `editProposals` aren't on disk). The conflict detector
 * fires correctly but attribution comes back null — the chat banner
 * surfaces an unattributed warning.
 *
 * This log fills the gap by recording each allowed Write/Edit at the
 * moment the SDK's `canUseTool` allows it. `onConflictDetected` checks
 * the log first; if no hit, it falls back to the persisted scan (which
 * still covers the cold-start-after-process-restart case).
 *
 * Scope is per-Node-process. In worktree-session mode, one edit
 * session = one Editor process, and all chat sessions in that edit
 * session run in that process — so a module-level Map is correct.
 * After a process restart the log is empty; that's fine because any
 * sessions that were in-flight before the restart now have their turns
 * persisted (or marked failed) and the persisted scan picks them up.
 *
 * Bounded: each file holds at most `MAX_ENTRIES_PER_FILE` entries. A
 * runaway loop that touches the same file repeatedly across many
 * sessions can't leak memory — older entries fall off in FIFO order.
 */

interface WriteLogEntry {
  sessionId: string
  /** First user-message preview for the writing session (drives `conflictingSessionPrompt`). */
  firstUserMessagePreview?: string
  /** ISO 8601 timestamp of the write — currently unused by the lookup but useful for diagnostics. */
  at: string
}

const writeLog = new Map<string, WriteLogEntry[]>()

const MAX_ENTRIES_PER_FILE = 10

export function recordCrossSessionWrite(
  absPath: string,
  entry: WriteLogEntry,
): void {
  const list = writeLog.get(absPath) ?? []
  list.push(entry)
  if (list.length > MAX_ENTRIES_PER_FILE) {
    // Drop the oldest entries (FIFO). splice is fine here — typical
    // overflow is one entry, so the cost is O(MAX_ENTRIES_PER_FILE).
    list.splice(0, list.length - MAX_ENTRIES_PER_FILE)
  }
  writeLog.set(absPath, list)
}

/**
 * Return the most recent entry for `absPath` whose `sessionId` is NOT
 * `excludeSessionId`. The caller (typically `onConflictDetected`)
 * passes the current session as `excludeSessionId` so the lookup
 * doesn't return the writer's own prior writes.
 *
 * Returns `null` when no entry exists or every entry was made by the
 * excluded session — at which point the caller falls back to the
 * persisted scan in `findRecentWriterForFile`.
 */
export function lookupRecentCrossSessionWriter(
  absPath: string,
  excludeSessionId: string,
): WriteLogEntry | null {
  const list = writeLog.get(absPath)
  if (!list) return null
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].sessionId !== excludeSessionId) return list[i]
  }
  return null
}

/**
 * Test-only: clear the entire log between cases. Production code must
 * not call this — the log's whole point is to survive across SSE
 * streams within a process.
 */
export function __resetCrossSessionWriteLog(): void {
  writeLog.clear()
}
