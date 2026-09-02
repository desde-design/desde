/**
 * Type definitions for the chat session — the multi-turn conversation
 * between the designer and the editor's agent loop.
 *
 * Persisted on disk (`.desde/chat-sessions/<projectId>.json`) so a
 * conversation survives editor-cli restarts. The schema below is the
 * on-disk shape and the in-memory shape — keep them identical so
 * round-tripping is trivial.
 *
 * Phase 0 defines the shapes only. The orchestrator that reads/writes
 * them lands in Phase 1.
 */

/**
 * Stable identifier for a chat session.
 *
 * `projectId` scopes the session to a specific repo-root checkout. `sessionId`
 * scopes it within that project so multiple chat sessions can coexist per
 * project (detached chat sessions, Phase 1 of
 * tasks/editor-detached-sessions.md).
 *
 * Backward-compatible default: when a client doesn't pass `sessionId`, the
 * route derives `sessionId = projectId`. Old persisted sessions
 * (`schemaVersion: 1` from before this change) had no `sessionId` field on
 * disk; the store reads them as `sessionId = projectId` so the on-disk file
 * (`<projectId>.json`) keeps mapping to "the project's default session"
 * without a migration script.
 */
export interface ChatSessionId {
  /** Stable hash of the repo root path (sha256 hex, first 16 chars). */
  projectId: string
  /**
   * Session identity within the project. UUID-shaped for detached sessions,
   * equal to `projectId` for the default per-project session. The persisted
   * file lives at `.desde/chat-sessions/<sessionId>.json`, so when
   * `sessionId === projectId` the file path is identical to the pre-Phase-1
   * layout — no migration needed.
   */
  sessionId: string
}

/**
 * One user/assistant exchange. A turn starts with a user message and
 * may include any number of tool uses interleaved with assistant text.
 */
export interface ChatTurn {
  /** Stable id for correlating SSE events back to a persisted turn. */
  id: string
  /** ISO 8601 timestamp when the user submitted the prompt. */
  startedAt: string
  /** ISO 8601 timestamp when the turn finished. */
  completedAt?: string
  /** The user's prompt verbatim. */
  userMessage: string
  /**
   * Optional selection snapshot at submit time. Captured from the
   * shell-side `editorSelection` store. Pinned to the turn so the
   * agent's reasoning is anchored to what the user was looking at,
   * even if they navigated mid-turn.
   */
  selection?: ChatSelectionSnapshot
  /**
   * Optional page snapshot at submit time (route + framework + title).
   * Same rationale as `selection`.
   */
  page?: ChatPageSnapshot
  /**
   * Ordered list of content blocks the LLM emitted across this turn.
   * Text and tool-use blocks interleave in the order they appeared in
   * the stream. Tool results live separately (see `toolResults`) so the
   * UI can render them inline by id without polluting the assistant
   * content order.
   */
  assistantContent: ChatAssistantBlock[]
  /** Tool results, keyed by `toolUseId` from the corresponding tool_use. */
  toolResults: Record<string, ChatToolResult>
  /**
   * Edit proposals emitted during this turn. The orchestrator forwards
   * each to the shell as a `edit_proposed` SSE event; the shell merges
   * them into the pending-edits buffer. We persist them here for replay
   * (e.g. session resume after editor restart).
   */
  editProposals: ChatEditProposalRef[]
  /** Token usage aggregated across all model calls in this turn. */
  usage?: { inputTokens: number; outputTokens: number }
  /**
   * Model id used for this turn. Persisted so the session's
   * cost-ceiling computation can look up the right rate card — older
   * turns with no recorded model fall back to a conservative
   * Opus-tier estimate.
   */
  model?: string
  /**
   * Reasoning effort requested for this turn ('low'…'max'). Absent on
   * turns that ran at the provider default and on pre-picker records.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * Vendor-reported dollar cost for the turn. SDK turns capture this
   * from `SDKResultMessage.total_cost_usd` (which accounts for cache
   * reads correctly); legacy turns leave it undefined and the cost-
   * ceiling math falls back to a rate-card estimate from `usage`.
   */
  costUsd?: number
  /** Stop reason if the turn ended in failure. */
  error?: string
  /**
   * Messages the user typed WHILE this turn was running and that the turn's
   * input channel accepted (chat input steering — see
   * `tasks/chat-input-steering.md`). In accept order.
   *
   * It exists because `userMessage` is the turn's OPENING prompt and nothing
   * else. A steer reaches the model and the model answers it, so without this
   * field a re-hydrated session shows the assistant answering a question that
   * appears nowhere in the transcript — the user's own words, gone from their
   * own history. That is the same non-negotiable as delivery loss, one
   * dimension over: the user typed it, so it must survive.
   *
   * ABSENT (not `[]`) on a turn that received no steers, so a turn from before
   * this field existed and a turn that simply had no steers serialize
   * identically. Nothing downstream may treat absent and empty differently.
   */
  steers?: ChatSteeredMessage[]
}

/**
 * One steered message, in the form the transcript needs to render it.
 *
 * Deliberately NOT the full delivery record. Whether the model provably read
 * it is a live-turn concern (`takeUndeliveredSteers` in
 * `agent-chat-sdk/turn-input-channel.ts` decides that, and the client resubmits
 * what could not be accounted for). What is persisted here is what the user
 * typed and where it sat in the conversation.
 *
 * Every accepted steer is recorded, including one later reported as
 * `resubmit_required`. A resubmit re-sends it as a fresh turn, so the message
 * can appear twice in the transcript — and that is the direction to be wrong
 * in. Repeat over drop, always.
 */
export interface ChatSteeredMessage {
  /** The user's text verbatim, exactly as it was pushed into the channel. */
  text: string
  /**
   * Whether images rode along. The BYTES are deliberately not here, matching
   * the turn's own opening images (`RunChatTurnSdkOpts.images`): base64 in the
   * session JSON would bloat every file, and the SDK's own JSONL transcript
   * retains them for resume. Absent means no images.
   */
  hadImages?: boolean
  /**
   * Insertion point in `assistantContent`: the number of assistant blocks that
   * had arrived when this message was accepted. Everything before that index
   * was said before the user typed; everything from it onwards came after.
   *
   * Stored rather than derived because there is nothing to derive it from
   * later — the ordering only exists while the turn is streaming. A renderer
   * splits `assistantContent` here so the steer appears where it happened
   * instead of after the whole reply.
   */
  afterAssistantBlocks: number
}

export type ChatAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }

export interface ChatToolResult {
  ok: boolean
  /** Free-form tool output. Shape is per-tool; the orchestrator owns it. */
  output?: unknown
  error?: string
}

/**
 * Snapshot of the shell-side `editorSelection` at the moment a turn
 * was submitted. Intentionally a STRUCTURAL subset of `Selection`
 * (`src/editor/core/selection.ts`) — only the fields the LLM uses.
 * Keeping it narrow avoids dragging the full selection shape into the
 * persisted session.
 */
export interface ChatSelectionSnapshot {
  selector: string
  componentName?: string
  componentFile?: string
  editTarget?: { file: string; line: number; column: number }
  packageName?: string
  classes?: string[]
}

export interface ChatPageSnapshot {
  /** Iframe URL. Includes pathname + hash; the agent uses these as the page id. */
  url: string
  /** Pathname only, for readable display in the chat header. */
  route: string
  /** Detected framework (e.g. "vue3", "react"). */
  framework?: string
  /** Page title from `<title>` if available. */
  title?: string
  /**
   * Source file backing the current route (e.g. `src/views/Home.vue`).
   * Populated from the bridge's `ROUTE_CHANGED { sourceFile }` payload,
   * which reads the `data-page-source` attribute the framework adapter
   * stamps on `<html>`. Lets the agent reason about the page's source
   * without an extra tool call when nothing is selected.
   */
  sourceFile?: string
}

/**
 * Reference to an edit proposed during a turn. Stored as a thin
 * pointer rather than the full edit blob so the session file doesn't
 * accumulate megabytes of `OverwriteEdit.newSource` per turn.
 *
 * The full edit lives in the shell's pending-edits buffer (in memory)
 * and is GC'd on Save or Discard. If the user wants to recover an
 * edit after restart, that's the buffer's responsibility, not the
 * session's.
 */
export interface ChatEditProposalRef {
  editId: string
  /** Discriminator matching the buffer destination. */
  kind:
    | 'prop_edit'
    | 'structural_edit'
    | 'overwrite'
    | 'overwrite_multi'
    | 'new_file'
    | 'file_delete'
    | 'file_rename'
  /** Files touched by this edit (for the audit/UI). */
  files: string[]
  /** ISO 8601 timestamp. */
  proposedAt: string
}

/**
 * Per-file read record captured by the SDK's PreToolUse hook on the
 * built-in Read tool. Phase 4a of tasks/editor-detached-sessions.md.
 *
 * Key is the absolute path of the file (canonical, post-realpath).
 * `hashAtRead` is the sha256 of the file content at the moment the
 * agent read it. `baseContentPath` points at the content-addressed
 * sidecar so the save-dialog merge UI can fetch the base for 3-way
 * resolution.
 */
export interface ChatFileReadRecord {
  hashAtRead: string
  baseContentPath: string
  readAt: string
}

/**
 * Per-file conflict detected at write time. Phase 4a §1.
 *
 * Recorded when `canUseTool` is about to allow a Write/Edit but the
 * file's current on-disk hash differs from the hash the session
 * captured at Read time. The write still proceeds (auto-apply
 * contract); the conflict is surfaced via the inline banner SSE
 * event and the save-dialog conflict UI.
 */
export interface ChatConflictRecord {
  detectedAt: string
  hashAtRead: string
  hashAtWrite: string
  conflictingSessionId?: string
  conflictingSessionPrompt?: string
}

/**
 * Lifecycle status of a chat session. Phase 5 of
 * tasks/editor-detached-sessions.md — bedrock for restart cleanup,
 * rate-limit handling, and the "session failed" drawer badge.
 *
 *   - `in-flight` — a turn is currently streaming. Written when a turn
 *     starts; cleared (to `idle` or `failed`) at stream close. A
 *     restart-clear pass on editor-cli startup rewrites any
 *     `in-flight` it finds to `cancelled` — those are leftover from a
 *     previous CLI process that crashed mid-turn.
 *   - `idle` — between turns. The session is resumable; the next
 *     submit picks up where it left off. This is the normal resting
 *     state.
 *   - `failed` — the last turn ended with an error. The session is
 *     still resumable (a new turn can succeed and flip the status
 *     back to `idle`); `failed` is a presentation hint, not a
 *     terminal state.
 *   - `cancelled` — terminal. Set by the restart-clear pass for
 *     stale `in-flight` records. `cancelled` sessions are hidden
 *     from the drawer listing. The on-disk file is kept for forensic
 *     value (deleting it would lose the agent transcript).
 *
 * Missing on pre-Phase-5 records — `listSessionsForProject` and the
 * picker treat absent status as `idle` so old sessions render
 * unchanged.
 */
export type ChatSessionStatus = 'in-flight' | 'idle' | 'failed' | 'cancelled'

/**
 * The complete persisted session. One JSON file per project.
 */
export interface ChatSession {
  /** Schema version. Bump when on-disk shape changes incompatibly. */
  schemaVersion: 1
  id: ChatSessionId
  /** ISO 8601 timestamp the session was first opened. */
  createdAt: string
  /** ISO 8601 timestamp of the most recent turn (or session open). */
  updatedAt: string
  /** Ordered turns, oldest first. */
  turns: ChatTurn[]
  /**
   * Phase 5 — lifecycle status. See `ChatSessionStatus` for the
   * meanings. Absent on pre-Phase-5 records — treated as `idle`.
   */
  status?: ChatSessionStatus
  /**
   * ISO 8601 timestamp of the most recent status transition. Tracks
   * when restart-clear marked a session cancelled, or when a turn
   * landed failed. Optional + only meaningful for `failed` /
   * `cancelled` rows in the drawer.
   */
  statusUpdatedAt?: string
  /**
   * Human-readable reason for the current status. Populated for
   * `failed` (the turn's error message) and `cancelled` (the
   * cancel cause, e.g. `restart-clear`).
   */
  statusReason?: string
  /**
   * Phase 5 — structured classification of `failed` outcomes.
   * `rate-limited` means an Anthropic 429 (or similar provider
   * rate-limit) was detected in the error message; `other` covers
   * every non-rate-limit failure (timeouts, tool errors, bridge
   * errors, unknown SDK throws). Absent on non-failed sessions and
   * on pre-Phase-5 failures. The picker uses this to render a
   * distinct "Rate limited" badge; the toast surface uses it to
   * show a "Try again in Ns" affordance.
   */
  statusFailureKind?: 'rate-limited' | 'other'
  /**
   * Phase 5 — best-effort retry-after window in seconds. Populated
   * when `statusFailureKind === 'rate-limited'` AND the provider's
   * error message included a parseable retry hint. UI renders a
   * countdown when present; falls back to a generic "wait a bit"
   * description when absent.
   */
  statusRetryAfterSeconds?: number
  /**
   * Claude Agent SDK's session id (from `SDKSystemMessage`'s init).
   * Persisted so subsequent turns can pass `options.resume = sdkSessionId`
   * and the SDK rebuilds the conversation state from its own JSONL store
   * (`.claude/projects/<encoded-cwd>/<sdk-session-id>.jsonl`). Set once the
   * SDK runtime's first turn on this session completes.
   */
  sdkSessionId?: string
  /**
   * Per-session model + effort choice from the chat model picker.
   * Absent → runtime default (DEFAULT_SDK_MODEL, provider-default
   * effort) — same absent-means-default convention as `status`.
   * Overwritten whenever a chat request carries a `modelConfig`.
   */
  modelConfig?: {
    provider: string
    model: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  }
  /**
   * Files read by the agent during this session, keyed by absolute
   * path. Captured via the SDK's PreToolUse hook on Read. Used by Phase
   * 4a conflict detection to know what the agent saw before writing.
   */
  fileReads?: Record<string, ChatFileReadRecord>
  /**
   * Stale-base conflicts detected at write time, keyed by absolute
   * path. Most-recent-write-wins on the key — only the most recently
   * detected conflict per file is kept (the save dialog renders the
   * file once, not per-write).
   */
  conflicts?: Record<string, ChatConflictRecord>
  /**
   * Audit Task 15 — turns-retention cap. `saveSession` moves the oldest
   * turns to `<sessionId>.archive.jsonl` once `turns.length` exceeds the
   * configured cap (default 500; `retention.chatSessionTurns.maxTurns`).
   * `archivedTurnCount` is the running total of turns ever archived off
   * this session (NOT the archive file's line count on its own — same
   * number, just avoids a file read to display it). `archivedCostUsd` is
   * the summed `costUsd` of every archived turn, folded into
   * `computeSessionCost` (`run-chat-turn-sdk.ts`) so the cost-ceiling
   * check keeps counting spend from turns that rolled off the head file.
   * Both absent on sessions that have never overflowed the cap.
   */
  archivedTurnCount?: number
  archivedCostUsd?: number
}

/**
 * Empty-session factory. Use when starting a new conversation.
 *
 * `sessionId` is optional for backward-compat: callers that don't supply one
 * get the project's default session (`sessionId = projectId`). Detached
 * callers pass a distinct UUID per session.
 */
export function makeEmptySession(projectId: string, sessionId?: string): ChatSession {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: { projectId, sessionId: sessionId ?? projectId },
    createdAt: now,
    updatedAt: now,
    turns: [],
    status: 'idle',
    statusUpdatedAt: now,
  }
}
