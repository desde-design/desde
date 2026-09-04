/**
 * Disk persistence for chat sessions. Files live under the repo root at
 * `.desde/chat-sessions/<sessionId>.json`.
 *
 * Phase 1 of detached chat sessions (tasks/editor-detached-sessions.md)
 * changed the keying from projectId to sessionId so multiple sessions can
 * coexist per project. The on-disk filename is now the sessionId. For the
 * default-per-project session (legacy clients that don't supply a
 * sessionId), `sessionId === projectId`, so `<projectId>.json` keeps mapping
 * to "the project's default session" — pre-Phase-1 files do not need a
 * migration script.
 *
 * Loading rules:
 *   - File missing → start a fresh empty session (not an error).
 *   - File present but malformed JSON → start a fresh empty session,
 *     log a warning. Never break editor boot.
 *   - File present and parses but fails schema validation → same as
 *     malformed. Schema mismatches happen during dev as types evolve;
 *     we don't want to wedge the user.
 *   - File present, parses, validates → resume.
 *
 * Saving uses tempfile + rename so a crash mid-write leaves either
 * the prior file intact or the new file fully written — never a
 * partial. We don't fsync the file or directory before rename, so a
 * power loss could still lose the most recent write; durable
 * persistence is out of scope for chat session state (the next turn
 * just rebuilds context from the previous turn the user remembers).
 *
 * Pure-ish: takes the repo root explicitly so the route handler owns
 * the filesystem boundary. No global state.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { desdeDir } from '../worktree/desde-dir'
import { makeEmptySession, type ChatSession } from './types'
import {
  DEFAULT_MAX_CHAT_TURNS,
  appendArchivedTurns,
  readArchivedTurns,
  splitTurnsForArchive,
  sumTurnCostUsd,
} from './session-turns-archive'

/**
 * The session directory, guarded. Built through `desdeDir` rather than
 * joined onto `repoRoot` directly, so a `.desde` the prototype ships as a
 * symlink cannot make `saveSession` write the session record (and every
 * message in it) outside the working tree. See `desde-dir.ts`.
 */
function sessionsDir(repoRoot: string): string {
  return join(desdeDir(repoRoot), 'chat-sessions')
}

/**
 * Stable per-project session id. Derived from the absolute repo root
 * path so two checkouts of the same repo (e.g. worktrees) get distinct
 * sessions — confirmed in the plan's open-questions answer (no sharing
 * across worktrees).
 */
export function projectIdForRepoRoot(repoRoot: string): string {
  return createHash('sha256').update(repoRoot, 'utf8').digest('hex').slice(0, 16)
}

/**
 * Defense-in-depth validation for `sessionId` at the storage boundary.
 * HTTP routes also validate this against the same pattern before calling
 * into the store, but having the check here means a misbehaving caller
 * (test double, future entry point) can't punch through `<sessionId>.json`
 * to a path-traversal write. Accepts ASCII alphanumerics + `-` and `_`,
 * length 1-64 — matches UUIDs and projectId hex hashes.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isValidChatSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

function assertValidSessionId(sessionId: string, context: string): void {
  if (!isValidChatSessionId(sessionId)) {
    throw new Error(
      `Invalid sessionId in ${context}: must match /^[A-Za-z0-9_-]{1,64}$/`,
    )
  }
}

/**
 * Path on disk for the given sessionId. Always keyed by sessionId — the
 * default-per-project session has `sessionId === projectId` so its path
 * is identical to the pre-Phase-1 layout.
 */
export function sessionFilePath(repoRoot: string, sessionId: string): string {
  assertValidSessionId(sessionId, 'sessionFilePath')
  return join(sessionsDir(repoRoot), `${sessionId}.json`)
}

export interface LoadResult {
  session: ChatSession
  /**
   * True iff the session was newly created (because no file existed or
   * the existing file was unusable). Callers may want to log a warning
   * when this is true after a malformed read.
   */
  fresh: boolean
  /** Diagnostic detail when fresh=true; useful for log lines. */
  freshReason?: 'no-file' | 'unreadable' | 'malformed-json' | 'schema-mismatch'
}

export interface LoadSessionOptions {
  /**
   * Session identity within the project. Defaults to projectId (the
   * project's default session) — backward-compat with pre-Phase-1 callers
   * that didn't know about sessionId.
   */
  sessionId?: string
}

/**
 * Load the session for a project, or return a fresh one if none exists
 * or the existing file can't be parsed/validated. Never throws.
 *
 * Pass `opts.sessionId` for detached sessions; omit for the default
 * per-project session.
 */
export async function loadSession(
  repoRoot: string,
  opts: LoadSessionOptions = {},
): Promise<LoadResult> {
  const projectId = projectIdForRepoRoot(repoRoot)
  const sessionId = opts.sessionId ?? projectId
  assertValidSessionId(sessionId, 'loadSession')
  const path = sessionFilePath(repoRoot, sessionId)

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const reason =
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'no-file'
        : 'unreadable'
    return {
      session: makeEmptySession(projectId, sessionId),
      fresh: true,
      freshReason: reason,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      session: makeEmptySession(projectId, sessionId),
      fresh: true,
      freshReason: 'malformed-json',
    }
  }

  const normalized = normalizeLoadedSession(parsed, projectId, sessionId)
  if (!normalized) {
    return {
      session: makeEmptySession(projectId, sessionId),
      fresh: true,
      freshReason: 'schema-mismatch',
    }
  }

  return { session: normalized, fresh: false }
}

export interface SaveSessionOptions {
  /**
   * Audit Task 15 — cap on turns kept in the head file. Turns beyond the
   * cap move to `<sessionId>.archive.jsonl` (see `session-turns-archive.ts`).
   * Defaults to `DEFAULT_MAX_CHAT_TURNS` (500). Callers with a project-config
   * `retention.chatSessionTurns.maxTurns` override thread it through here.
   */
  maxTurns?: number
}

/**
 * Persist the session to disk atomically (write tempfile, rename).
 * Creates the sessions directory if needed.
 *
 * Tempfile names use a uuid so two concurrent saves can't collide on a
 * shared `pid+ms` suffix. Rename is "last write wins" by design — the
 * orchestrator serializes turns *within a session*, so true concurrency
 * on the same session's file is a bug at the layer above. Different
 * sessions write to different files and don't conflict.
 *
 * Audit Task 15 — before writing, trims `session.turns` down to
 * `opts.maxTurns` (default 500): the oldest turns append to the
 * session's `.archive.jsonl` sidecar and only the newest `maxTurns`
 * land in the head file. Their `costUsd` is folded into
 * `archivedCostUsd` so cost-ceiling accounting (`computeSessionCost` in
 * `run-chat-turn-sdk.ts`) doesn't lose track of spend once a turn rolls
 * off the head. If the archive append fails, the trim is skipped for
 * THIS save (every turn stays in the head file) rather than losing
 * data — the next successful save retries.
 *
 * **The archive append and the head tempfile+rename are TWO separate
 * writes, not one atomic operation** (codex round 3, Task 15 Batch 5
 * gate, P2). If the process dies — or the head's `writeFile`/`rename`
 * throws — AFTER the archive append succeeds but BEFORE the head is
 * updated, the stale on-disk head still has the untrimmed `turns`
 * array. A retry recomputes the SAME overflow batch and would
 * naively re-append it — duplicate `.archive.jsonl` lines, and an
 * `archivedTurnCount`/`archivedCostUsd` that overcounts (feeding
 * `computeSessionCost` a number bigger than reality, risking a
 * premature ceiling refusal on a session that hasn't actually spent
 * that much). Fixed by making the append IDEMPOTENT: before
 * appending, `readArchivedTurns` to see what's already there, keyed
 * by each `ChatTurn`'s own stable `id` (unique per turn already, no
 * new identity scheme needed); skip re-appending anything already
 * present; and derive `archivedTurnCount`/`archivedCostUsd` from the
 * archive file's ACTUAL (deduped) content plus whatever this call
 * newly appended — never incrementally added to `session`'s
 * possibly-stale counters. This is provably correct across both
 * failure points: archive-append-ok-then-head-fail → a retry finds
 * everything already archived, appends nothing new, and reports the
 * correct (not overcounted) total; archive-append-fail → caught below,
 * head untouched, same as before (retry is clean because nothing
 * changed on disk at all).
 *
 * Cost: an archiving save now reads the WHOLE archive sidecar (not
 * just appends) to build the dedup set — O(archive size) instead of
 * O(1). Accepted for correctness on a local CLI's chat-history file
 * (not a hot server path); if a pathologically long session ever
 * makes this measurably slow, a future optimization could track a
 * byte-offset/line-count watermark to allow a tail-only read instead
 * of the full file.
 *
 * **Returns the ACTUALLY-PERSISTED session** (trimmed `turns`, updated
 * `archivedTurnCount`/`archivedCostUsd`, bumped `updatedAt`) — codex
 * round 2 (Task 15 Batch 5 gate, P2): the caller's in-memory `session`
 * argument is a snapshot from before this call; if a caller keeps using
 * that stale reference after a save that trimmed, a SECOND save later
 * in the same request re-derives the split against the untrimmed
 * array and re-appends the SAME turns to the archive sidecar —
 * duplicate JSONL lines, and (worse) `computeSessionCost` reading the
 * stale, still-oversized `turns` array can inflate the ceiling check
 * mid-turn. Callers MUST reassign their local variable to this return
 * value and use THAT going forward (see `chat-handler.ts`'s pre-turn
 * save for the canonical example) rather than re-loading (a re-read
 * would race a concurrent write to the same file).
 */
export async function saveSession(
  repoRoot: string,
  session: ChatSession,
  opts: SaveSessionOptions = {},
): Promise<ChatSession> {
  assertValidSessionId(session.id.sessionId, 'saveSession')
  const path = sessionFilePath(repoRoot, session.id.sessionId)
  await mkdir(dirname(path), { recursive: true })

  let toPersist = session
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_CHAT_TURNS
  const { head, archived } = splitTurnsForArchive(session.turns, maxTurns)
  if (archived.length > 0) {
    try {
      // Idempotency check FIRST — see the doc comment above. Reading
      // (rather than trusting `session.archivedTurnCount`) is what
      // makes a retry after a partial prior save self-correcting.
      const existingArchived = await readArchivedTurns(repoRoot, session.id.sessionId)
      const existingIds = new Set(existingArchived.map((t) => t.id))
      const newlyArchived = archived.filter((t) => !existingIds.has(t.id))
      if (newlyArchived.length > 0) {
        await appendArchivedTurns(repoRoot, session.id.sessionId, newlyArchived)
      }
      toPersist = {
        ...session,
        turns: head,
        archivedTurnCount: existingArchived.length + newlyArchived.length,
        archivedCostUsd: sumTurnCostUsd(existingArchived) + sumTurnCostUsd(newlyArchived),
      }
    } catch (err) {
      console.warn(
        `[session-store] failed to archive turns for session ${session.id.sessionId}, keeping full turns array for this save: ${(err as Error).message}`,
      )
    }
  }

  const tmp = `${path}.tmp-${randomUUID()}`
  // Bump updatedAt at write time so callers don't have to remember.
  const toWrite: ChatSession = { ...toPersist, updatedAt: new Date().toISOString() }
  await writeFile(tmp, JSON.stringify(toWrite, null, 2), 'utf8')
  await rename(tmp, path)
  return toWrite
}

/**
 * Summary for the listing endpoint. Keeps the per-session payload small
 * so the drawer UI (Phase 3) doesn't have to load every turn just to
 * render a row.
 */
export interface ChatSessionSummary {
  sessionId: string
  projectId: string
  createdAt: string
  updatedAt: string
  turnCount: number
  /** Last user message preview (first 200 chars). Useful for drawer rows. */
  lastUserMessagePreview?: string
  /**
   * Phase 5 — session lifecycle status. Absent on pre-Phase-5
   * records; the picker treats absent as `idle`. `cancelled`
   * sessions are filtered out of `listSessionsForProject` so they
   * don't appear in the drawer.
   */
  status?: 'in-flight' | 'idle' | 'failed' | 'cancelled'
  /** Reason text for `failed` / `cancelled`. Used as a row tooltip. */
  statusReason?: string
  /**
   * Phase 5 — classification of `failed` outcomes. `rate-limited`
   * is rendered as a distinct "Rate limited" badge in the picker
   * (recoverable); `other` falls back to the generic "Failed"
   * badge. Absent on non-failed sessions + pre-Phase-5 records.
   */
  statusFailureKind?: 'rate-limited' | 'other'
  /**
   * Phase 5 — best-effort retry-after window for `rate-limited`
   * failures. Used by the toast surface for the "Try again in Ns"
   * affordance and as a hint for future automatic-retry logic.
   */
  statusRetryAfterSeconds?: number
  /**
   * Phase 3 of tasks/editor-detached-sessions.md — drawer row data.
   * Optional so legacy clients see the same shape; Phase 3 UI degrades
   * gracefully when the fields are absent.
   */
  /** First user message (first ~60 chars) — drawer row title. */
  firstUserMessagePreview?: string
  /** Number of files in `session.conflicts`. Zero means clean. */
  conflictCount?: number
  /** Most recent turn's error message, if the turn ended with `error`. */
  lastTurnError?: string
  /**
   * Snapshot of the pinned page from the most recent turn (`turns[last].page`).
   * Enables "click row → re-anchor iframe" in the Phase 3 drawer.
   */
  pinnedPage?: {
    url: string
    route: string
    sourceFile?: string
  }
  /**
   * Snapshot of the pinned selection from the most recent turn
   * (`turns[last].selection`). Enables breadcrumb display + selection
   * restoration on row click.
   */
  pinnedSelection?: {
    selector: string
    componentName?: string
    componentFile?: string
  }
  /**
   * Audit Task 15 — total turns ever moved to the `.archive.jsonl`
   * sidecar for this session. Absent/0 means the session has never
   * overflowed the turns cap. Lets the drawer/detail UI hint that older
   * history exists beyond what `turnCount` (head-file-only) reports.
   */
  archivedTurnCount?: number
  /**
   * The model this session last ran a turn on, as persisted on the
   * session record. Absent means the session has never carried a
   * choice, so its turns run on the runtime default.
   *
   * On the summary because "what did the user last choose?" is a
   * question about the newest session that HAS a choice, and answering
   * it from the listing costs one directory read instead of a second
   * pass over every session file. `model-catalog-handler.ts` is the
   * caller. NOT validated here — the value is whatever is on disk, and
   * the catalog endpoint reconciles it against the live catalog before
   * any client sees it.
   */
  modelConfig?: {
    provider: string
    model: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  }
}

/**
 * List all chat sessions persisted under the repo's `.desde/chat-sessions/`
 * directory whose `projectId` matches the current repo root. Sessions for
 * other projects sharing the directory (shouldn't happen in practice, but
 * defensively filtered) are excluded.
 */
export async function listSessionsForProject(
  repoRoot: string,
): Promise<ChatSessionSummary[]> {
  // Throws on a symlinked `.desde`, the same way this function already
  // rethrows an EACCES from the readdir below: a directory we refuse to
  // touch is not the same answer as "this repo has no sessions".
  const dir = sessionsDir(repoRoot)
  const projectId = projectIdForRepoRoot(repoRoot)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const summaries: ChatSessionSummary[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.includes('.tmp-')) continue
    const sessionId = entry.slice(0, -'.json'.length)
    const path = join(dir, entry)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const normalized = normalizeLoadedSession(parsed, projectId, sessionId)
    if (!normalized) continue
    if (normalized.id.projectId !== projectId) continue
    // Phase 5 — hide cancelled sessions from the drawer. The on-disk
    // file is kept (forensic value), but the picker shouldn't render
    // a row for them. Pre-Phase-5 records have no status — they fall
    // through unchanged.
    if (normalized.status === 'cancelled') continue
    summaries.push(summarizeSession(normalized))
  }
  // Most-recently-touched first — natural drawer ordering.
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

/**
 * Look up the most recent chat session OTHER than `excludeSessionId`
 * that has a persisted edit proposal touching `file` (repo-relative
 * POSIX path). Used to populate `conflictingSessionId` /
 * `conflictingSessionPrompt` on the `edit_overwrite_warning` SSE event
 * so the chat panel can name the session that clobbered the file.
 *
 * Returns the matching session's id + a short prompt preview, or
 * `null` if no match. Best-effort: malformed session files are
 * skipped silently — the overwrite warning fires regardless, just
 * without attribution.
 *
 * Bounded by the number of session files in the worktree
 * (`.desde/chat-sessions/*.json`). The conflict path is rare; a
 * full scan is acceptable. The scan stops at the first match (sessions
 * are sorted updatedAt-desc), so the typical cost is O(1) reads.
 *
 * Caveat: only catches sessions whose turns have been PERSISTED. An
 * in-flight turn from another session that wrote the file but hasn't
 * called `saveSession` yet won't be found — that case is left for a
 * future shared in-memory write log (cross-session-process state).
 */
export async function findRecentWriterForFile(
  repoRoot: string,
  excludeSessionId: string,
  file: string,
): Promise<{ sessionId: string; firstUserMessagePreview?: string } | null> {
  // Every failure in this scan is already "no recent writer found"; a
  // refused `.desde` is one more of them.
  let dir: string
  try {
    dir = sessionsDir(repoRoot)
  } catch {
    return null
  }
  const projectId = projectIdForRepoRoot(repoRoot)

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }

  // Pre-filter + sort by mtime descending so we hit the most recent
  // candidate first. Skipping mtime in tests is fine — the scan still
  // works, just without ordering — but production benefits from
  // bailing out on the first hit.
  const candidates: { sessionId: string; path: string }[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    if (entry.includes('.tmp-')) continue
    const sessionId = entry.slice(0, -'.json'.length)
    if (sessionId === excludeSessionId) continue
    candidates.push({ sessionId, path: join(dir, entry) })
  }
  // Codex P2: rank by the matching edit's `proposedAt`, not session
  // `updatedAt`. A session that wrote the file earlier but kept
  // chatting about unrelated things afterward would otherwise
  // outscore the actual recent writer.
  let best: {
    sessionId: string
    proposedAt: string
    firstUserMessagePreview?: string
  } | null = null
  for (const { sessionId, path } of candidates) {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const normalized = normalizeLoadedSession(parsed, projectId, sessionId)
    if (!normalized) continue
    if (normalized.id.projectId !== projectId) continue
    // Scan turns' editProposals for ones that touched `file`. Track
    // the LATEST `proposedAt` across all in-session matches so the
    // cross-session rank is by per-file write time.
    let latestMatchAt: string | null = null
    for (const turn of normalized.turns) {
      if (!Array.isArray(turn.editProposals)) continue
      for (const proposal of turn.editProposals) {
        if (!Array.isArray(proposal.files)) continue
        if (!proposal.files.includes(file)) continue
        const at =
          typeof proposal.proposedAt === 'string' ? proposal.proposedAt : null
        if (!at) continue
        if (latestMatchAt === null || at.localeCompare(latestMatchAt) > 0) {
          latestMatchAt = at
        }
      }
    }
    if (latestMatchAt === null) continue
    if (!best || latestMatchAt.localeCompare(best.proposedAt) > 0) {
      const firstUserMessage =
        typeof normalized.turns[0]?.userMessage === 'string'
          ? normalized.turns[0].userMessage.slice(0, 60)
          : undefined
      best = {
        sessionId,
        proposedAt: latestMatchAt,
        ...(firstUserMessage ? { firstUserMessagePreview: firstUserMessage } : {}),
      }
    }
  }
  if (!best) return null
  return {
    sessionId: best.sessionId,
    ...(best.firstUserMessagePreview
      ? { firstUserMessagePreview: best.firstUserMessagePreview }
      : {}),
  }
}

/**
 * Build a `ChatSessionSummary` from a fully-loaded session. Exported
 * so the per-session detail endpoint (Phase 3) can reuse the same
 * extraction logic the listing endpoint does — no chance of drift
 * between the two views.
 *
 * Defensive: deep-validates each `turns[i]` field before touching it
 * because `normalizeLoadedSession` only checks the top-level shape.
 * A malformed turn (non-string userMessage, missing snapshot fields)
 * gracefully omits the affected field from the summary instead of
 * throwing — the listing endpoint must never break the drawer.
 */
export function summarizeSession(session: ChatSession): ChatSessionSummary {
  const lastTurn = session.turns[session.turns.length - 1]
  const firstTurn = session.turns[0]
  const lastUserMessage =
    typeof lastTurn?.userMessage === 'string' ? lastTurn.userMessage : null
  const firstUserMessage =
    typeof firstTurn?.userMessage === 'string' ? firstTurn.userMessage : null
  const conflictCount = session.conflicts ? Object.keys(session.conflicts).length : 0
  const lastError =
    typeof lastTurn?.error === 'string' && lastTurn.error.length > 0
      ? lastTurn.error
      : undefined
  const pinnedPage =
    lastTurn?.page && typeof lastTurn.page === 'object'
      ? sanitizePinnedPage(lastTurn.page)
      : undefined
  const pinnedSelection =
    lastTurn?.selection && typeof lastTurn.selection === 'object'
      ? sanitizePinnedSelection(lastTurn.selection)
      : undefined
  return {
    sessionId: session.id.sessionId,
    projectId: session.id.projectId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    ...(lastUserMessage !== null
      ? { lastUserMessagePreview: lastUserMessage.slice(0, 200) }
      : {}),
    ...(firstUserMessage !== null
      ? { firstUserMessagePreview: firstUserMessage.slice(0, 60) }
      : {}),
    ...(conflictCount > 0 ? { conflictCount } : {}),
    ...(lastError ? { lastTurnError: lastError } : {}),
    ...(pinnedPage ? { pinnedPage } : {}),
    ...(pinnedSelection ? { pinnedSelection } : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.statusReason ? { statusReason: session.statusReason } : {}),
    ...(session.statusFailureKind
      ? { statusFailureKind: session.statusFailureKind }
      : {}),
    ...(session.statusRetryAfterSeconds !== undefined
      ? { statusRetryAfterSeconds: session.statusRetryAfterSeconds }
      : {}),
    ...(session.archivedTurnCount ? { archivedTurnCount: session.archivedTurnCount } : {}),
    ...(session.modelConfig ? { modelConfig: session.modelConfig } : {}),
  }
}

function sanitizePinnedPage(
  page: unknown,
): ChatSessionSummary['pinnedPage'] | undefined {
  if (!page || typeof page !== 'object') return undefined
  const p = page as { url?: unknown; route?: unknown; sourceFile?: unknown }
  if (typeof p.url !== 'string' || typeof p.route !== 'string') return undefined
  return {
    url: p.url,
    route: p.route,
    ...(typeof p.sourceFile === 'string' ? { sourceFile: p.sourceFile } : {}),
  }
}

/**
 * Phase 5 — apply a status transition on `session`. Pure: returns a
 * fresh session with `status`, `statusUpdatedAt`, and (optionally)
 * `statusReason` set. Both chat routes call this immediately before
 * `saveSession` so the persisted record always carries the current
 * lifecycle status.
 *
 *   - `in-flight` is written at turn start (BEFORE the orchestrator
 *     runs). If the CLI crashes mid-turn, the on-disk record reflects
 *     "this session has a stuck turn" and the next restart-clear pass
 *     rewrites it to `cancelled`.
 *   - `idle` is written after the orchestrator returns successfully.
 *   - `failed` is written when the turn errored. `reason` carries
 *     the turn's error message for drawer-tooltip display.
 *   - `cancelled` is reserved for the restart-clear primitive; chat
 *     routes never set it directly.
 */
export function withSessionStatus<T extends ChatSession>(
  session: T,
  status: Exclude<NonNullable<T['status']>, 'cancelled'>,
  reason?: string,
  meta?: {
    failureKind?: 'rate-limited' | 'other'
    retryAfterSeconds?: number
  },
): T {
  const now = new Date().toISOString()
  const next: T = {
    ...session,
    status,
    statusUpdatedAt: now,
  }
  if (reason !== undefined) {
    next.statusReason = reason
  } else if (status !== 'failed') {
    // Codex round-1 #7 fix: clear stale reason whenever the target
    // status isn't `failed`. A `failed` → `in-flight` retry would
    // otherwise carry the prior failure tooltip into the new turn's
    // Running badge. `idle` after a successful turn was already
    // handled; this extends the same semantic to `in-flight`.
    delete (next as { statusReason?: string }).statusReason
  }
  // Failure metadata. Only meaningful for `status === 'failed'`;
  // clear on every other transition so a successful retry of a
  // rate-limited session doesn't leave the `rate-limited` badge
  // sticky.
  //
  // Codex round-1 #3 (rate-limit chunk): when `meta` is supplied
  // for a `failed` write, treat the provided fields as the NEW
  // ground truth — including their absence. A failed→failed
  // transition where the new write doesn't include
  // retryAfterSeconds should DROP the prior value (the new
  // failure has no retry window to surface), not preserve it.
  // Routes always pass `meta`; legacy callers passing only `reason`
  // keep the pre-Phase-5 behaviour (no failure-kind data on disk).
  if (status === 'failed' && meta) {
    if (meta.failureKind !== undefined) {
      next.statusFailureKind = meta.failureKind
    } else {
      delete (next as { statusFailureKind?: 'rate-limited' | 'other' })
        .statusFailureKind
    }
    if (meta.retryAfterSeconds !== undefined) {
      next.statusRetryAfterSeconds = meta.retryAfterSeconds
    } else {
      delete (next as { statusRetryAfterSeconds?: number })
        .statusRetryAfterSeconds
    }
  } else if (status !== 'failed') {
    delete (next as { statusFailureKind?: 'rate-limited' | 'other' })
      .statusFailureKind
    delete (next as { statusRetryAfterSeconds?: number })
      .statusRetryAfterSeconds
  }
  return next
}

function sanitizePinnedSelection(
  selection: unknown,
): ChatSessionSummary['pinnedSelection'] | undefined {
  if (!selection || typeof selection !== 'object') return undefined
  const s = selection as {
    selector?: unknown
    componentName?: unknown
    componentFile?: unknown
  }
  if (typeof s.selector !== 'string') return undefined
  return {
    selector: s.selector,
    ...(typeof s.componentName === 'string' ? { componentName: s.componentName } : {}),
    ...(typeof s.componentFile === 'string' ? { componentFile: s.componentFile } : {}),
  }
}

/**
 * Validate the shape of a parsed session and normalize backward-compat
 * fields. Returns the normalized session, or `null` if the shape is wrong.
 *
 * Backward-compat: pre-Phase-1 files don't have `id.sessionId` — fill it in
 * as `id.projectId` so they map to the project's default session.
 */
export function normalizeLoadedSession(
  value: unknown,
  expectedProjectId: string,
  expectedSessionId: string,
): ChatSession | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== 1) return null
  if (!v.id || typeof v.id !== 'object') return null
  const id = v.id as Record<string, unknown>
  if (id.projectId !== expectedProjectId) return null
  // sessionId may be missing on pre-Phase-1 files — default to projectId.
  let normalizedSessionId: string
  if (typeof id.sessionId === 'string' && id.sessionId.length > 0) {
    normalizedSessionId = id.sessionId
  } else {
    normalizedSessionId = expectedProjectId
  }
  if (normalizedSessionId !== expectedSessionId) return null
  if (typeof v.createdAt !== 'string') return null
  if (typeof v.updatedAt !== 'string') return null
  if (!Array.isArray(v.turns)) return null
  // Construct a fresh object so the normalized sessionId is reflected on the
  // returned session even when the on-disk file lacked it.
  return {
    ...(v as unknown as ChatSession),
    id: { projectId: expectedProjectId, sessionId: normalizedSessionId },
  }
}
