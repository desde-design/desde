/**
 * SSE event types emitted by `agent-chat-sdk/run-chat-turn-sdk.runChatTurnSdk`
 * and consumed by the shell's `useEditorChat` hook.
 *
 * Append-only — each event is independently meaningful so the UI can
 * incrementally render without reconciliation. Order matters: the
 * shell renders text deltas inline with tool-call disclosures in
 * the order they arrive.
 *
 * `bridge_request` is the round-trip path: orchestrator asks the
 * shell for an iframe read (e.g. current selection). The shell
 * answers via `POST /api/editor/chat/bridge-reply` keyed by
 * `bridgeReqId`. The orchestrator surfaces the reply back to the LLM
 * as a tool_result.
 */

import type { ModelImageContent } from '../agent-chat-sdk/media-content'
import type { StopReason } from '../llm-providers/types'

/**
 * Edit-proposal payloads emitted by `edit_proposed` events. Vendor-
 * neutral by design — the shell rebuilds the canonical edit object
 * (`PropEdit`, `OverwriteEdit`, etc.) from this carrier shape. Keeping
 * the wire format small avoids dragging the full `StructuralEdit`
 * union into the SSE protocol.
 */
export type EditProposal =
  | {
      type: 'prop_edit'
      /** CSS selector for the target element. Matches `Selection.selector`. */
      selector: string
      /** Stable bridge target id; preferred for selection-drift detection. */
      targetId?: string
      propName: string
      /** Primitive: string|number|boolean|null. */
      value: unknown
    }
  | {
      type: 'overwrite'
      /** Repo-relative file path. */
      file: string
      newSource: string
      /** SHA-256 hex of the on-disk source at the time the tool ran. */
      baseHash?: string
      /** Optional explanation surfaced in the diff panel. */
      explanation?: string
      /**
       * Phase 4 — true when this is a new-file creation. Maps to
       * `OverwriteEdit.allowCreate` so the save endpoint creates
       * rather than rejecting.
       */
      allowCreate?: boolean
      /**
       * True when the agent runtime has already written this file to
       * disk (SDK Write/Edit — branch mode writes the working tree in
       * place). The shell must NOT re-apply via `adapter.applyEdit`
       * when this is set; the file is already on disk and a second
       * write would race the first. Update the UI's pending-edit state
       * for diff display only. Defaults to undefined (false).
       */
      appliedByAgent?: boolean
    }
  | {
      /**
       * File-delete carrier (Phase 3 of the LLM capability-gap plan).
       * The agent has already unlinked the file by the time the SSE
       * fires (the SDK MCP tool does it inline); `appliedByAgent: true`
       * is the load-bearing contract for the shell ("display only").
       * `baseHash` is the pre-delete content hash for proposal-blob /
       * "Use mine" recovery in future conflict resolution.
       */
      type: 'file_delete'
      file: string
      baseHash: string
      appliedByAgent?: boolean
    }
  | {
      /**
       * File-rename / move carrier. Same `appliedByAgent: true`
       * discipline as `file_delete`. `baseHash` is the source-file
       * content hash at the time of rename.
       */
      type: 'file_rename'
      fromFile: string
      toFile: string
      baseHash: string
      appliedByAgent?: boolean
    }

export type ChatStreamEvent =
  | {
      /**
       * Detached chat sessions (Phase 1 of tasks/editor-detached-sessions.md).
       * Emitted as the very first event of every chat response so the client
       * can correlate the response stream with the in-memory session record
       * it minted — or, for legacy clients that sent no `sessionId`, learn
       * the server-derived default (`sessionId === projectId`).
       */
      kind: 'session'
      sessionId: string
      projectId: string
    }
  | {
      /**
       * A curated capability the user's message needs, but which is OFF.
       *
       * Emitted BEFORE the turn runs, from a deterministic scan of the USER's
       * own message text — never from assistant prose or tool output, because
       * this drives an affordance that writes the file deciding which
       * subprocesses run. There is no runtime signal to use instead: an
       * unregistered MCP server is invisible to the agent, not denied.
       *
       * Informational. It never blocks the turn; the agent proceeds and
       * explains the gap, while the banner offers the fix.
       */
      kind: 'capability_gap'
      capabilityId: string
      label: string
      /** What in the message triggered it — the matched URL. */
      detail: string
      /** Named so the UI can show the export line. The VALUE is never sent. */
      requiresEnv: string | null
      envReady: boolean
      activation: 'next-message' | 'cli-restart'
    }
  | {
      /**
       * Phase 5 of tasks/editor-detached-sessions.md — emitted once,
       * immediately after `session`, when the submission landed in the
       * concurrency-cap queue because the project was at its in-flight
       * cap. The stream stays open; the next event after `queued` is
       * `turn_start` (when the slot opens) or `error` (if the request
       * is aborted while waiting). Clients can render "Waiting for an
       * open slot…" between the two.
       */
      kind: 'queued'
      sessionId: string
      /** 1-indexed position at enqueue time. Doesn't update as others drain. */
      queuePosition: number
    }
  | {
      /**
       * A message the user typed WHILE this turn was running, accepted by
       * `POST /api/editor/chat/steer` and pushed into the turn's input
       * channel. The model receives it at the next model boundary INSIDE this
       * same turn — measured 2026-08-14: pushed at 4.0s, the in-flight tool
       * result returned at 8.5s, the model consumed it at 10.2s, all before
       * the turn's `result`. See `agent-chat-sdk/turn-input-channel.ts`.
       *
       * Emitted on the OWNING turn's stream rather than only returned to the
       * steering request, because those can be two different clients. The
       * steer is an ordinary POST from whichever tab the user typed in, while
       * the transcript that will answer it belongs to whoever is reading this
       * stream. Without this event that reader renders an answer to a question
       * it never saw.
       *
       * Deliberately NOT called `queued`. That word is taken by the
       * project-wide concurrency cap above, and it means the OPPOSITE thing:
       * "this submission has not started yet". A steer has already been
       * accepted into a turn that is running.
       *
       * Accepted, not yet consumed — the distinction the steer route's
       * `SteerResult` is named for. Whether the model actually read it is
       * settled later, by the absence or presence of `resubmit_required` below.
       */
      kind: 'steered'
      sessionId: string
      /** Exactly the text pushed into the channel. */
      userMessage: string
      /** How many images rode along. The bytes are never echoed onto the stream. */
      imageCount: number
    }
  | {
      /**
       * A steer this turn accepted but could NOT be shown to have reached the
       * model. The client must send it again as an ordinary next turn.
       *
       * Named for what the client has to do, not for what went wrong inside
       * the turn. It is neither `queued` (that is the project-wide concurrency
       * cap, and means "not started yet") nor a retraction of `steered` (that
       * event was true when it was sent: the message WAS pushed into a live
       * channel).
       *
       * How the turn decides, and why the answer is a heuristic: model
       * consumption is not observable. `POST /steer` hands the message to the
       * SDK's stdin and nothing acknowledges that the model folded it into a
       * request. So the turn watches for model output after the hand-over —
       * see `takeUndeliveredSteers` in `agent-chat-sdk/turn-input-channel.ts`.
       * A turn that ends without producing anything since the hand-over is
       * reported here.
       *
       * **The heuristic is biased towards over-reporting on purpose.** A steer
       * the model actually read can still land here, and then the user's
       * message is delivered twice. Delivering twice is a visible annoyance;
       * losing once destroys the user's work with nothing on screen to show
       * for it. Repeat over drop, always.
       *
       * Carries the full payload rather than an id because the client that
       * typed the message may not be the client reading this stream (a steer
       * is an ordinary POST from whichever tab the user was in). An id would
       * be resubmittable only by the tab that already holds the text.
       */
      kind: 'resubmit_required'
      sessionId: string
      /** Exactly the text that was pushed. Resubmit verbatim. */
      userMessage: string
      /**
       * The images that rode along, verbatim — base64 payload and mime type,
       * the same shape the steer was accepted in.
       *
       * `steered` deliberately sends only a COUNT, because there it is a
       * notification. Here the bytes are the point: without them a resubmit
       * silently drops the user's screenshot, which is the same loss this
       * event exists to prevent, one level down. The cost is a large SSE frame
       * on an image steer, and that is the right thing to spend.
       */
      images?: ModelImageContent[]
    }
  | { kind: 'turn_start'; turnId: string }
  | { kind: 'text_delta'; turnId: string; delta: string }
  /**
   * A chunk of the model's extended-thinking / reasoning. Streams BEFORE the
   * answer text (and may interleave on models that think between tool calls).
   * The chat UI accumulates these into a collapsible "thinking" block; they
   * are NOT persisted on the turn (ephemeral chain-of-thought).
   */
  | { kind: 'reasoning_delta'; turnId: string; delta: string }
  | {
      kind: 'tool_use_start'
      turnId: string
      toolUseId: string
      name: string
      input: unknown
    }
  | {
      kind: 'tool_result'
      turnId: string
      toolUseId: string
      ok: boolean
      output?: unknown
      error?: string
    }
  | {
      kind: 'bridge_request'
      turnId: string
      bridgeReqId: string
      messageType: string
      payload: unknown
    }
  | {
      kind: 'edit_proposed'
      turnId: string
      editId: string
      edit: EditProposal
    }
  | {
      /**
       * Phase 4a of tasks/editor-detached-sessions.md — stale-base
       * overwrite detected. The agent is about to write a file whose
       * on-disk hash no longer matches what it read earlier in the
       * session (typically because another detached session wrote
       * between this session's Read and this session's Write). The
       * write still proceeds — auto-apply is preserved — but the
       * chat panel renders an inline warning and the save dialog
       * shows per-file Use mine / Use theirs controls.
       *
       * Emitted immediately before the corresponding `edit_proposed`
       * for the same file, so the UI can attach the warning to the
       * edit row if it wants to (4a UI shows it as a standalone
       * banner; richer attribution is Phase 4b).
       */
      kind: 'edit_overwrite_warning'
      turnId: string
      /** Repo-relative file path. */
      file: string
      /** sha256 of the file as the session saw it via Read. */
      hashAtRead: string
      /** sha256 of the file on disk at write time. */
      hashAtWrite: string
      /** The session whose write changed the base, if known. */
      conflictingSessionId?: string
      /** First ~60 chars of the conflicting session's first user message. */
      conflictingSessionPrompt?: string
    }
  | {
      kind: 'usage'
      turnId: string
      inputTokens: number
      outputTokens: number
      /**
       * Phase 4: cache-creation tokens — tokens written to the
       * prompt cache during this turn. Additive against
       * `inputTokens`. Undefined on legacy turns and on SDK turns
       * before the SDK exposed the field.
       */
      cacheCreationInputTokens?: number
      /**
       * Phase 4: cache-read tokens — tokens served from the
       * prompt cache. Disjoint from `inputTokens` (a cached token
       * is NOT counted as an input token). Undefined on legacy
       * turns.
       */
      cacheReadInputTokens?: number
    }
  | {
      kind: 'turn_complete'
      turnId: string
      stopReason: StopReason
      vendorStopReason?: string
    }
  | {
      /**
       * Phase 5 follow-up — SDK structured rate-limit event surfacing.
       * Codex round-1 finding #2 (deferred) on the rate-limit chunk:
       * the Claude Agent SDK emits structured `rate_limit_event`
       * messages with `status: 'allowed' | 'allowed_warning' |
       * 'rejected'` and optional `resetsAt` (epoch ms). The post-
       * failure classifier path (statusFailureKind) only catches
       * 429s AFTER a turn fails; this event lets the shell render a
       * live banner BEFORE failure, when the API is signaling
       * pressure or has already rejected the request.
       *
       * Emitted whenever the SDK pushes a `rate_limit_event`
       * message with EITHER the base `status` OR the `overageStatus`
       * in `'allowed_warning' | 'rejected'`. `status: 'allowed'`
       * with no overage signal is the steady state and drops.
       *
       * **SDK round-1 codex finding #1 fix:** previously we dropped
       * `status === 'rejected'` on the assumption that the SDK
       * would throw + the classifier path would catch the 429.
       * Codex correctly pointed out that's not guaranteed: the SDK
       * type explicitly carries `resetsAt` on rejected, and there's
       * no contract that the subsequent thrown error preserves
       * equivalent timing. Surface `rejected` here so the shell
       * sees the structured timing BEFORE any classifier fallback.
       *
       * **SDK round-1 codex finding #2 fix:** also surface overage
       * pressure. claude.ai subscriptions track base rate limit AND
       * overage credit pool independently — a user may be in
       * overage warning while the base status is `allowed`.
       *
       * Sub-second resolution timing for `resetsAt` comes through
       * verbatim; the UI does its own formatting.
       */
      kind: 'rate_limit_warning'
      /**
       * Discriminator carrying the more-severe of the two signals
       * (base `status` or `overageStatus`). `'rejected'` if either
       * is rejected; otherwise `'allowed_warning'`. The UI uses this
       * to pick render copy ("approaching limit" vs "rate-limit
       * rejected — waiting for reset").
       */
      status: 'allowed_warning' | 'rejected'
      /** SDK-reported rate-limit tier (e.g. 'five_hour'). Optional in the SDK. */
      rateLimitType?: string
      /** Epoch ms when the window resets. Undefined when SDK didn't supply. */
      resetsAt?: number
      /** Fractional utilization [0, 1]. Clamped on input; undefined when SDK omits. */
      utilization?: number
      /**
       * Overage credit-pool status. Present when the SDK supplied it
       * AND the base status alone doesn't already capture the
       * picture (e.g. base `allowed` + overage `allowed_warning`).
       */
      overageStatus?: 'allowed_warning' | 'rejected'
      /** Epoch ms when the overage window resets. */
      overageResetsAt?: number
    }
  | {
      /**
       * Phase 5 follow-up — SDK API-retry surfacing. Codex round-1
       * finding #2 on the rate-limit chunk: the SDK emits
       * `system / api_retry` messages whenever it retries a
       * transient HTTP error (rate-limit, network, 5xx). Useful as
       * a transparency signal so the user knows WHY a turn is
       * slow — they're not stuck, the SDK is waiting out a backoff.
       *
       * Fires multiple times per turn when retries chain (e.g.
       * three 429s in a row). The shell may de-duplicate (latest-
       * attempt-wins) when rendering; the wire shape exposes
       * `attempt` so consumers can decide.
       */
      kind: 'api_retry'
      /** ms delay before the SDK retries. Always present per SDK contract. */
      retryDelayMs: number
      /** 1-indexed attempt number. */
      attempt: number
      /** Total retry budget (e.g. 5). */
      maxRetries: number
      /**
       * HTTP status that triggered the retry, when known. `null`
       * for non-HTTP errors (e.g. network timeouts). Important: a
       * 429-flavored retry is the most common case; the UI can
       * tighten its messaging when `errorStatus === 429`.
       */
      errorStatus: number | null
    }
  | { kind: 'error'; turnId?: string; reason: string }

/**
 * Every declared kind, as data.
 *
 * Hand-maintained, and `event-kind-coverage.test.ts` is what stops it going
 * stale: a kind added to the union above but not to this list is a kind the
 * coverage test cannot account for, and it fails.
 */
export const CHAT_STREAM_EVENT_KINDS: readonly ChatStreamEvent['kind'][] = [
  'session',
  'capability_gap',
  'queued',
  'steered',
  'resubmit_required',
  'turn_start',
  'text_delta',
  'reasoning_delta',
  'tool_use_start',
  'tool_result',
  'bridge_request',
  'edit_proposed',
  'edit_overwrite_warning',
  'usage',
  'turn_complete',
  'rate_limit_warning',
  'api_retry',
  'error',
]

/**
 * Kinds the CHAT HANDLER emits, not a runtime
 * (`editor-cli/src/server/chat-handler.ts`). They are outside the parity
 * comparison because both lanes reach the same handler, so neither runtime
 * can be missing them: there is no per-lane code here to drift.
 *
 * Grepping `chat-handler.ts` for each of these four is what keeps this list
 * honest. A kind that is not actually emitted there does not belong in it,
 * even if it is also exempt from the script-driven check for its own reason
 * — see `SCRIPT_EXEMPT_EVENT_KINDS` for those.
 */
export const HANDLER_OWNED_EVENT_KINDS: readonly ChatStreamEvent['kind'][] = [
  'session',
  'capability_gap',
  'queued',
  'bridge_request',
]

/**
 * Kinds `event-kind-coverage.test.ts`'s script-driven parity check cannot
 * see, because the happy-path script it drives both lanes over deliberately
 * never produces them.
 *
 * These six DO come from the runtimes — `steered`, `resubmit_required`,
 * `edit_proposed`, `edit_overwrite_warning`, `api_retry`, `error` — but only
 * under a scenario the script does not build: a steer mid-turn, an aborted
 * turn, a file-writing tool call, or a failure. Confirmed by reading both
 * `run-chat-turn-sdk.ts` and `run-chat-turn-neutral.ts`: each carries the
 * emit call for every one of these six kinds, so their absence from the
 * coverage script is a gap in the script, not a gap in either runtime.
 * Each already has its own dedicated test: steering in
 * `useEditorChat-turn-ordering.test.ts` and the live harnesses under
 * `tasks/scripts/`, edits in the `edit-service` applicator suites, retries
 * and errors in `classify-turn-error.test.ts` and the neutral loop's own
 * tests.
 *
 * Unlike `HANDLER_OWNED_EVENT_KINDS`, membership here is not a claim that
 * neither lane could ever drift on these kinds — it is a claim that THIS
 * script does not exercise them, so their absence from `runtimeKinds()`
 * proves nothing about parity either way. A future change to a kind on this
 * list is only checked by its own dedicated test, not by this file's parity
 * invariant.
 */
export const SCRIPT_EXEMPT_EVENT_KINDS: readonly ChatStreamEvent['kind'][] = [
  'steered',
  'resubmit_required',
  'edit_proposed',
  'edit_overwrite_warning',
  'api_retry',
  'error',
]

/**
 * Kinds only the Claude Agent SDK lane can emit. Exactly one, and that is the
 * decision this constant exists to hold still.
 *
 * `rate_limit_warning`'s fields model Anthropic's rate-limit API and its
 * subscription overage credit pool (`status`, `overageStatus`, `utilization`),
 * and `RateLimitWarningBanner` renders copy about "this Claude account" off
 * them. There is nothing to translate a different vendor's 429 into: on the
 * neutral lane a 429 goes through `classify-turn-error.ts` to the generic
 * error banner, and the loop's own backoff surfaces as `api_retry`.
 *
 * Adding an entry here is not a shortcut past a parity gap. It is a claim that
 * the kind is MEANINGLESS off the Anthropic lane, and it needs the same
 * argument this one carries.
 */
export const ANTHROPIC_ONLY_EVENT_KINDS: readonly ChatStreamEvent['kind'][] = [
  'rate_limit_warning',
]
