"use client"

/**
 * Shell-side consumer of the editor chat SSE stream.
 *
 * Submits a user message to `/api/editor/chat`, parses the SSE
 * response, and surfaces three things to the UI:
 *
 *   1. `messages`: an append-only timeline of user prompts, streaming
 *      assistant text, and tool-call disclosures.
 *   2. `submitting`: true while a turn is in flight.
 *   3. `error`: the most recent error event (cleared on next submit).
 *
 * The hook also handles `bridge_request` events: each one is
 * dispatched to the caller-provided `bridgeHandlers` map (keyed by
 * `messageType`), and the result is POSTed back to
 * `/api/editor/chat/bridge-reply` keyed by `bridgeReqId`.
 *
 * State is bucketed by sessionId so multiple sessions can stream
 * concurrently. The visible slice exposed via `messages` / `submitting`
 * is read from `byId.get(getVisibleSessionId())`; SSE events always
 * write into the *turn's* sessionId bucket, not the visible one, so
 * switching tabs mid-stream is safe.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { editorFetch } from "@/lib/editor-fetch"
import { parseSseStream } from "@/lib/sse"
import type {
  ChatStreamEvent,
  EditProposal,
} from "@/editor/agent-chat/chat-stream-events"
import type { ChatSteeredMessage, ChatTurn } from "@/editor/agent-chat/types"
import type { SessionModelConfig } from "@/editor/core/model-catalog"
import {
  appendPendingSteer,
  beginSweep,
  carryBucketState,
  collectResendingSteers,
  createBucketKeyedState,
  dataUrlFromModelImage,
  endSweep,
  findPendingSteer,
  isSweeping,
  removePendingSteer,
  sameResendingSteers,
  type BucketKeyedState,
  type PendingSteer,
  type ResendingSteer,
  type ResendingSteerRecord,
  type SweepHandle,
  type TurnCloseMode,
} from "./editor-chat-bucket-state"

export type { ResendingSteer } from "./editor-chat-bucket-state"

export type ChatBridgeHandler = (
  payload: unknown,
  signal?: AbortSignal,
) => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>

export type ChatBridgeHandlers = Record<string, ChatBridgeHandler>

/**
 * One displayable message in the chat. Mapped 1:1 with the visual
 * surface; the orchestrator events feed into here.
 */
export type ChatMessage =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant"
      id: string
      /** Stream of content blocks in arrival order. */
      blocks: AssistantBlockUi[]
      stopReason?: import("@/editor/llm-providers/types").StopReason
    }
  | { kind: "error"; id: string; reason: string }
  | {
      /**
       * Phase 4a of tasks/editor-detached-sessions.md — inline
       * banner surfaced when the agent's Write/Edit landed on a file
       * whose on-disk content drifted from what the agent saw at Read
       * time (typically because a parallel detached session wrote in
       * between). The write still landed (auto-apply contract); the
       * banner is informational + provides the entry point to the
       * save-dialog conflict UI.
       */
      kind: "overwrite_warning"
      id: string
      /** Repo-relative file path that was overwritten. */
      file: string
      hashAtRead: string
      hashAtWrite: string
      conflictingSessionId?: string
      conflictingSessionPrompt?: string
    }
  | {
      /**
       * Phase 5 of tasks/editor-detached-sessions.md — surfaced when
       * the submission landed behind the project's in-flight cap. The
       * stream stays open; this message renders "Waiting for an open
       * slot…" until the next `turn_start` event resumes normal flow.
       */
      /**
       * A curated capability the user's message needs, but which is OFF.
       * Carries an offer to enable it. Informational — the turn ran anyway.
       */
      kind: "capability_gap"
      id: string
      capabilityId: string
      label: string
      detail: string
      requiresEnv: string | null
      envReady: boolean
      activation: "next-message" | "cli-restart"
    }
  | {
      kind: "queued"
      id: string
      queuePosition: number
    }
  | {
      /**
       * Phase 5 follow-up — SDK structured rate-limit warning. Fires
       * when the Anthropic API signals `status: 'allowed_warning'`
       * (approaching the ceiling) OR `status: 'rejected'` (hard
       * limit). Distinct from the post-failure
       * `statusFailureKind: 'rate-limited'` — this is a LIVE banner
       * so the user knows pressure is mounting OR the request was
       * rejected before/in addition to any classifier fallback.
       *
       * Latest-wins: a new warning during the same turn overwrites
       * the prior banner so the user always sees the most recent
       * state.
       */
      kind: "rate_limit_warning"
      id: string
      status: "allowed_warning" | "rejected"
      rateLimitType?: string
      resetsAt?: number
      utilization?: number
      overageStatus?: "allowed_warning" | "rejected"
      overageResetsAt?: number
    }
  | {
      /**
       * Phase 5 follow-up — SDK api_retry transparency signal. The
       * SDK is waiting out a backoff before retrying a transient
       * error. Most-common case is a 429 retry; the
       * `errorStatus === 429` discriminator lets the UI tighten its
       * messaging. Latest-wins per the rate_limit_warning rationale.
       */
      kind: "api_retry"
      id: string
      retryDelayMs: number
      attempt: number
      maxRetries: number
      errorStatus: number | null
    }

export type AssistantBlockUi =
  | { type: "text"; text: string }
  | {
      /**
       * Accumulated extended-thinking / reasoning, streamed before (and
       * possibly between) the answer text. Rendered as a collapsible block;
       * ephemeral — not persisted on the turn.
       */
      type: "reasoning"
      text: string
    }
  | {
      type: "tool_use"
      toolUseId: string
      name: string
      input: unknown
      result?: { ok: true; output: unknown } | { ok: false; error: string }
    }

export interface UseEditorChatOptions {
  bridgeHandlers: ChatBridgeHandlers
  /**
   * Called when the orchestrator emits an `edit_proposed` event.
   * Caller wires this to the editor's pending-edits buffer
   * (typically `useEditorEditing.applyAgentProposal`). Return
   * `{ ok: false, reason }` to surface a rejection back to the UI
   * (e.g. selection drift); return `{ ok: true }` for accepted
   * proposals. Phase 1 callers can omit this — without a handler,
   * proposals are silently ignored (no edits land in the buffer).
   */
  onEditProposed?: (
    editId: string,
    proposal: EditProposal,
  ) =>
    | { ok: true }
    | { ok: false; reason: string }
    | Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Snapshots the current page + selection at submit time. Returned
   * values are pinned to the turn so the agent sees a consistent view
   * of "what's on screen" even if the user navigates mid-turn. Phase 3
   * uses these to pre-inject context into the model's user message;
   * the chat header also reads them via `currentSnapshot` below.
   */
  getCurrentSnapshot?: () => ChatSnapshot
  /**
   * Phase 3 of tasks/editor-detached-sessions.md — chat sessionId
   * tracking for the detached-sessions UI. When set, `submit` posts
   * `{ sessionId }` so the server resumes the matching ChatSession
   * instead of minting a fresh one each turn. When null/undefined,
   * the legacy behavior — server mints a sessionId — is preserved.
   * Read on every submit so the drawer can switch sessions without
   * re-mounting the hook.
   */
  getChatSessionId?: () => string | null
  /**
   * Returns the sessionId currently visible in the chat pane (typically
   * the same as `getChatSessionId()`, but exposed separately because
   * the visible session is a UI concern while the target session is a
   * submit concern). When omitted, state is single-bucket — useful for
   * legacy callers without a tab strip. Read on every render so tab
   * switches reflect immediately.
   */
  getVisibleSessionId?: () => string | null
  /**
   * Phase 3 — fires when a `session` SSE event arrives. The drawer
   * uses this to learn the server-minted sessionId for "new chat"
   * submits (the client may not know it ahead of time) and to refresh
   * the listing afterward. Called with the sessionId reported by the
   * server, which may equal the caller's `getChatSessionId()` (resume)
   * or differ (fresh mint).
   */
  onSessionEvent?: (sessionId: string, projectId: string) => void
  /**
   * Whether the caller tracks sessions such that the `session` SSE event's
   * server-minted id should re-key the active bucket. Returns `true` in
   * multi-session mode (a tab strip whose `getVisibleSessionId` follows the
   * new id via `onSessionEvent`), `false` in solo/branch mode where session
   * tracking is disabled.
   *
   * Load-bearing: when session tracking is OFF, `getChatSessionId()` /
   * `getVisibleSessionId()` return `null` (→ `SOLO_BUCKET`) and
   * `onSessionEvent()` is a no-op, so re-keying `SOLO_BUCKET` to the server
   * id would strand every message under a key the visible slice can't reach
   * — the whole conversation would silently vanish on the first `session`
   * event. Gating the re-key keeps solo/branch-mode chat in `SOLO_BUCKET`.
   * Omitted → treated as `true` (preserves multi-session callers + tests).
   */
  getSessionReKeyEnabled?: () => boolean
  /**
   * Phase 3 codex round-1 finding #4 fix — fires once the SSE stream
   * has fully closed (i.e. the submit's finally block runs). Different
   * from `onTurnComplete`, which fires when the SDK's
   * `turn_complete` SSE event arrives — that's BEFORE the route
   * handler calls `saveSession`. The session-listing refresh in
   * `useChatSessions` hooks here so it observes the persisted turn
   * count + conflicts. Fires for both success and error paths.
   */
  onStreamComplete?: () => void
  /**
   * Fired once when the orchestrator emits `turn_complete`. The caller
   * uses this to flush per-turn side effects — notably a single iframe
   * hard-reload covering every chat-applied edit (see
   * `useEditorEditing.handleChatTurnComplete`). Kept separate from
   * `onEditProposed` so we coalesce N edits per turn into one reload
   * instead of churning iframe state on every Write/Edit.
   */
  onTurnComplete?: () => void
}

/**
 * What the agent sees as "currently on screen" at the moment a turn
 * starts. Both fields are optional — a no-selection / no-page-info
 * caller passes undefined.
 */
export interface ChatSnapshot {
  selection?: {
    selector: string
    componentName?: string
    componentFile?: string
    editTarget?: { file: string; line: number; column: number }
    packageName?: string
    classes?: string[]
  }
  page?: {
    url: string
    route: string
    framework?: string
    title?: string
  }
}

export interface UseEditorChatReturn {
  messages: ChatMessage[]
  submitting: boolean
  error: string | null
  /**
   * Submit a turn. `images` are base64 data URLs (paste / drag-drop /
   * attach) forwarded to the server, which validates + caps them and rides
   * them into the agent turn as vision. An image-only turn (empty text + ≥1
   * image) is allowed.
   */
  submit: (userMessage: string, images?: string[]) => Promise<void>
  /**
   * Deliver a message INTO the turn that is currently running, instead of
   * aborting that turn and starting a new one (which is what `submit` does to
   * an in-flight turn on the same bucket). The agent receives it at the turn's
   * next model boundary and decides what to do with it — we never hold a
   * message back and never decide on the user's behalf whether it interrupts.
   *
   * Never throws and never rejects: every failure path funnels into the
   * pending-steer ledger, which resubmits the message as an ordinary turn. See
   * {@link PendingSteer} for where the no-loss guarantee actually lives.
   *
   * Resolves once the message has been handed off — either accepted by the
   * running turn, or (when there is nothing to steer) resubmitted as a fresh
   * turn.
   */
  steer: (userMessage: string, images?: string[]) => Promise<void>
  /**
   * Steers the ledger is resending RIGHT NOW, for the VISIBLE session only.
   *
   * A steer whose turn was stopped is recovered by resubmitting it as a fresh
   * turn, and the first attempt usually 409s because the server still holds
   * that session's turn lock. The retry then backs off
   * (`RESUBMIT_409_RETRY_DELAYS_MS`). Measured live, the whole recovery took
   * about 25 seconds, and every second of it was silent — so the message
   * looked lost while the mechanism designed to save it was working. This is
   * what the chat panel puts a spinner on.
   *
   * Scoped to the visible bucket deliberately: a background session recovering
   * its own steer must not paint a row into the session the user is reading.
   */
  resendingSteers: ResendingSteer[]
  /** Cancel the in-flight turn for the currently-visible session. */
  abort: () => void
  /** Clear the in-memory message timeline for the visible session (does NOT wipe the persisted session). */
  clearLocal: () => void
  /**
   * Drop a single status banner from the VISIBLE session's timeline — the
   * handler behind the banners' dismiss control.
   *
   * Local and non-persistent by design: banners are transient UI, not
   * transcript entries, so nothing is written to the session file. A dismissed
   * banner that was DERIVED from a persisted turn (e.g. a turn's `error`) will
   * therefore reappear if that session is later re-hydrated from disk, which
   * is the correct trade — the turn really did fail, and we don't want a
   * dismissal to rewrite history.
   */
  dismissMessage: (id: string) => void
  /**
   * Replace the in-memory message timeline for a session with the
   * persisted turns. Used by the tab strip on session switch so the
   * pane shows the prior conversation instead of going empty until the
   * next submit. When `sessionId` is omitted, hydrates the visible
   * bucket. Aborts any in-flight turn for that bucket (defensive — the
   * caller is expected to gate hydration on `!hasSessionBucket(id)`,
   * but the abort here prevents a late stream event from clobbering
   * hydrated state if the caller forgot). Does NOT issue a network
   * call; the caller fetches the session and passes the turns in.
   */
  hydrateFromTranscript: (turns: ChatTurn[], sessionId?: string) => void
  /**
   * True when the hook has buffered messages for `sessionId`. Used by
   * the tab strip to decide whether to fetch + hydrate on switch: a
   * bucket that already has live state (e.g. mid-stream from a prior
   * submit) shouldn't be clobbered by a hydration round-trip.
   */
  hasSessionBucket: (sessionId: string) => boolean
  /** The visible session's model + effort choice. `null` = runtime default. */
  modelConfig: SessionModelConfig | null
  /** Set the model + effort choice on the visible session's bucket. */
  setModelConfig: (config: SessionModelConfig | null) => void
  /**
   * Seed the visible-or-given session's `modelConfig` from a persisted
   * value (e.g. on tab-switch hydration). A no-op if that bucket
   * already holds a non-null value — hydration must never clobber a
   * choice the user already made locally.
   */
  seedModelConfig: (sessionId: string, config: SessionModelConfig | null) => void
}

/**
 * Fallback bucket key used when the caller doesn't opt into
 * per-session state via `getVisibleSessionId`/`getChatSessionId`.
 * Legacy single-track callers (project route, tests) all share this
 * one bucket. Outside the hook nothing references the key — the
 * `messages`/`submitting` getters resolve it for the consumer.
 */
const SOLO_BUCKET = "__solo__"

interface SessionBucket {
  messages: ChatMessage[]
  submitting: boolean
  /**
   * Last error for THIS session — bucketed so a background stream's
   * failure on session A doesn't surface in the visible UI of session
   * B. Cleared on the next submit into this bucket. The hook's
   * `error` getter resolves the visible bucket's error.
   */
  error: string | null
  /**
   * Per-session model + effort choice for the model picker chip.
   * null = runtime default. Seeded from the persisted session record
   * on hydration; overwritten locally when the user picks.
   */
  modelConfig: SessionModelConfig | null
}

const EMPTY_BUCKET: SessionBucket = {
  messages: [],
  submitting: false,
  error: null,
  modelConfig: null,
}

/**
 * Backoff schedule for a resubmit the chat route refused with 409.
 *
 * A 409 right after Stop is EXPECTED, not exceptional: Stop kills the fetch on
 * this side, while the server only releases the per-session turn lock when its
 * own handler unwinds — asynchronously, after this client's `finally` has
 * already swept. "Wait for the in-flight turn to settle before sweeping" was
 * considered instead of retrying, and rejected: the settling that matters is
 * the SERVER's, and there is no client-observable signal for it — the SSE
 * stream (the only channel the server had) is exactly what Stop closed. Any
 * wait therefore has to poll, and a retried POST is that poll. Bounded so a
 * lock that never clears produces a visible error carrying the user's text
 * instead of an invisible forever-loop.
 */
const RESUBMIT_409_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]

/** Options threaded through `runSubmit` by internal callers. */
interface RunSubmitOptions {
  /**
   * Skip the optimistic user bubble. Set when resubmitting a steer whose
   * bubble `steer()` already put on screen — a single thing the user typed
   * must not render as two messages.
   */
  skipOptimisticUserMessage?: boolean
  /**
   * The bucket this submit must land in, bypassing the visible-session
   * resolution. A RESUBMIT already has an owner: the steer was typed into a
   * specific session, and by the time the end-of-turn sweep fires the user
   * may be looking at a different tab — resolving from `getChatSessionId()`
   * here posted the user's message into that other session (D1). Ordinary
   * submits omit it: a fresh submit genuinely belongs to the visible session.
   */
  targetBucketId?: string
  /**
   * Suppress the error banner for a submission the server REFUSED (non-2xx,
   * or a network failure before acceptance). The steer sweep owns surfacing
   * those: it retries the predictable 409 silently and reports a terminal
   * failure with the user's text attached. Failures AFTER the server accepted
   * the turn surface normally — from that point it is an ordinary turn.
   */
  suppressRejectionBanner?: boolean
  /**
   * Fired the instant the server answers 2xx with a stream, i.e. the moment
   * acceptance becomes KNOWN.
   *
   * It exists because `runSubmit`'s RETURN is a much later event: it resolves
   * when the whole turn's SSE stream ends, which on a real turn is tens of
   * seconds after acceptance. Anything that must react to "the server took
   * it" — the resend indicator does — cannot use the return value without
   * making a claim that has already stopped being true. Measured before this
   * hook existed: the "resending" row stayed on screen for the entire
   * recovered turn, asserting the message had not reached the agent while the
   * agent was visibly answering that exact message.
   *
   * Called at most once per `runSubmit`, and never for a refused submit.
   */
  onAccepted?: () => void
}

/**
 * What the server did with a submitted turn. Read by the steer sweep, which
 * removes a ledger entry on ACCEPTANCE — never on attempt.
 */
interface SubmitTurnOutcome {
  /**
   * True once the server answered 2xx with a stream. From that moment the
   * message is a persisted turn on the server, whatever later happens to the
   * stream.
   */
  serverAccepted: boolean
  /** HTTP status of a refusal, when one was observed (null on a thrown fetch). */
  rejectionStatus: number | null
}

/**
 * Minimum wall-clock gap between two streamed-text state commits.
 *
 * Token deltas arrive far faster than the UI can usefully repaint, and every
 * commit re-renders the editor surface (this hook lives there) and with it
 * the whole right rail. Buffering deltas between flushes turns "one render per
 * token" into "one render per frame-ish", which is the same ref-then-flush
 * shape `saveStreamingTextRef` uses in `useEditorEditing`.
 *
 * 50ms ≈ 20 commits/sec — below the perceptual threshold for streaming text,
 * comfortably above the ~1-2 commits/sec a sentence-level cadence would give.
 * The first delta of a turn always flushes immediately (see `lastFlushAt`),
 * so time-to-first-token is unchanged.
 */
const DELTA_FLUSH_INTERVAL_MS = 50

export function useEditorChat(opts: UseEditorChatOptions): UseEditorChatReturn {
  const [byId, setById] = useState<Map<string, SessionBucket>>(() => new Map())
  // Mirror of `byId` so `submit` (a `useCallback`, whose closure would
  // otherwise stale-capture the map from the render it was created in)
  // can read the turn's pinned bucket's `modelConfig` at submit time.
  const byIdRef = useRef<Map<string, SessionBucket>>(new Map())
  byIdRef.current = byId
  // Refs so closures inside the in-flight turn always see the latest
  // callbacks even if the caller re-renders with new identities.
  const handlersRef = useRef(opts.bridgeHandlers)
  handlersRef.current = opts.bridgeHandlers
  const onEditProposedRef = useRef(opts.onEditProposed)
  onEditProposedRef.current = opts.onEditProposed
  const getCurrentSnapshotRef = useRef(opts.getCurrentSnapshot)
  getCurrentSnapshotRef.current = opts.getCurrentSnapshot
  const onTurnCompleteRef = useRef(opts.onTurnComplete)
  onTurnCompleteRef.current = opts.onTurnComplete
  const getChatSessionIdRef = useRef(opts.getChatSessionId)
  getChatSessionIdRef.current = opts.getChatSessionId
  const getVisibleSessionIdRef = useRef(opts.getVisibleSessionId)
  getVisibleSessionIdRef.current = opts.getVisibleSessionId
  const onSessionEventRef = useRef(opts.onSessionEvent)
  onSessionEventRef.current = opts.onSessionEvent
  const getSessionReKeyEnabledRef = useRef(opts.getSessionReKeyEnabled)
  getSessionReKeyEnabledRef.current = opts.getSessionReKeyEnabled
  const onStreamCompleteRef = useRef(opts.onStreamComplete)
  onStreamCompleteRef.current = opts.onStreamComplete

  // EVERY piece of bucket-keyed state, in one object, because a `session`
  // event re-keys a bucket and all of it has to move together. See
  // `editor-chat-bucket-state.ts` — the carry has been forgotten twice, and
  // both times the bug was a user's typed message lost or delivered twice, so
  // the field list and the carry rules now type-check against each other.
  // Deliberately refs, not state: nothing renders from any of it, and a
  // steer's survival must not depend on a React commit landing.
  const bucketStateRef = useRef<BucketKeyedState>(createBucketKeyedState())
  // The ONE piece of ledger information that is also React state, because it
  // is the only piece anything renders. The ledger itself stays a ref: it is
  // written on every streamed event, and re-rendering the whole editor surface
  // per token to keep a mirror in sync would be the wrong trade. This mirror
  // is written only by `publishResendingSteers`, only when a resend starts,
  // retries or ends — a handful of commits per recovery, not per token.
  const [resendingSteers, setResendingSteers] = useState<ResendingSteerRecord[]>(
    [],
  )
  const publishResendingSteers = useCallback((): void => {
    const next = collectResendingSteers(bucketStateRef.current.pendingSteers)
    // Identity is preserved when nothing changed, so the memoized return
    // object below does not churn and the chat panel does not repaint.
    setResendingSteers((prev) => (sameResendingSteers(prev, next) ? prev : next))
  }, [])
  // Set below, once both callbacks exist; they are mutually recursive (a turn
  // ending sweeps the ledger, and a sweep runs turns).
  const sweepPendingSteersRef = useRef<
    ((bucketId: string, mode: TurnCloseMode) => Promise<void>) | null
  >(null)
  // Unmount tracking for the resubmit backoff: a retry timer must not outlive
  // the hook, or it would submit into a component that no longer exists.
  const disposedRef = useRef(false)
  const retryWaitsRef = useRef<
    Set<{ timer: ReturnType<typeof setTimeout>; release: () => void }>
  >(new Set())
  useEffect(() => {
    // Reset on every (re-)mount: StrictMode runs mount → unmount → mount on
    // the same instance, and the cleanup below latched `true`.
    disposedRef.current = false
    const waits = retryWaitsRef.current
    return () => {
      disposedRef.current = true
      for (const wait of waits) {
        clearTimeout(wait.timer)
        // Release rather than strand: the awaiting retry loop wakes, reads
        // `disposedRef`, and stops without submitting anything.
        wait.release()
      }
      waits.clear()
    }
  }, [])
  /** A cancellable sleep — resolved early (not rejected) by unmount. */
  const waitForRetry = useCallback(
    (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const wait = {
          timer: setTimeout(() => {
            retryWaitsRef.current.delete(wait)
            resolve()
          }, ms),
          release: resolve,
        }
        retryWaitsRef.current.add(wait)
      }),
    [],
  )

  // Resolve the visible bucket key. Reads through the ref so a parent
  // re-render with a new `currentSessionId` immediately swaps the
  // visible slice without re-creating the hook's callbacks.
  const visibleId = getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
  const visibleBucket = byId.get(visibleId) ?? EMPTY_BUCKET

  const updateBucket = useCallback(
    (sessionId: string, updater: (b: SessionBucket) => SessionBucket): void => {
      setById((prev) => {
        const next = new Map(prev)
        const current = next.get(sessionId) ?? EMPTY_BUCKET
        next.set(sessionId, updater(current))
        return next
      })
    },
    [],
  )

  const runSubmit = useCallback(async (
    userMessage: string,
    images?: string[],
    options?: RunSubmitOptions,
  ): Promise<SubmitTurnOutcome> => {
    const trimmed = userMessage.trim()
    const hasImages = Array.isArray(images) && images.length > 0
    // Allow an image-only turn (empty text + ≥1 image); otherwise an empty
    // submit is a no-op.
    if (trimmed.length === 0 && !hasImages) {
      return { serverAccepted: false, rejectionStatus: null }
    }
    // Pin the turn's bucket at submit time. A resubmit carries its owner in
    // `targetBucketId` and must NEVER fall back to the visible-state
    // resolution below (D1). Otherwise: if the caller doesn't know
    // a sessionId yet (no detached-sessions wiring, or fresh load with
    // currentSessionId still null), use the SOLO_BUCKET — the bucket
    // will be re-keyed when the `session` SSE event arrives. The visible
    // session is read separately so a tab switch mid-stream doesn't
    // change where this turn's events land.
    const initialTargetId =
      options?.targetBucketId ?? getChatSessionIdRef.current?.() ?? SOLO_BUCKET
    // A new turn is a new ordering baseline: a split flag left over from a
    // turn that died before consuming it would cut this turn's first reply in
    // a place no persisted steer records.
    bucketStateRef.current.steerSplit.delete(initialTargetId)
    // Pin the model/effort choice to the turn's bucket at submit time —
    // read via the ref (not `byId` state, which this callback would
    // otherwise stale-capture) so a visible-session switch mid-flight
    // can't swap in a different bucket's choice.
    const turnModelConfig =
      byIdRef.current.get(initialTargetId)?.modelConfig ?? null
    // turnId tracks the CURRENT bucket key for this submit. It may be
    // re-keyed on `session` if the server minted a fresh id and we
    // started with SOLO_BUCKET.
    let turnId = initialTargetId
    // If a prior submit on the same bucket is still in flight, abort it
    // first — concurrent submits on the same session aren't supported.
    // (Concurrent submits on DIFFERENT sessions are the whole point.)
    const prior = bucketStateRef.current.aborts.get(turnId)
    if (prior) prior.abort()
    const abort = new AbortController()
    bucketStateRef.current.aborts.set(turnId, abort)
    // Display label for the user bubble. An image-only turn would otherwise
    // render blank, so fall back to an attachment marker. (Display-only —
    // the server receives the real text + images, not this label.)
    const bubbleText =
      trimmed.length > 0
        ? trimmed
        : hasImages
          ? `📎 ${images!.length} image${images!.length > 1 ? "s" : ""}`
          : trimmed
    updateBucket(turnId, (b) => ({
      ...b,
      messages: options?.skipOptimisticUserMessage
        ? b.messages
        : [
            ...b.messages,
            { kind: "user", id: makeLocalId(), text: bubbleText },
          ],
      submitting: true,
      // Clear any prior error on this bucket — the user is retrying.
      error: null,
    }))

    // Only a stream that ends normally proves the server's end-of-turn
    // reconciliation ran (it emits `resubmit_required`, THEN closes). Every
    // other exit — Stop, abort, throw, non-OK response — leaves every steer
    // unconfirmed. Starts false so a path nobody thought of is treated as
    // unconfirmed rather than confirmed: repeat over drop, always.
    let streamClosedCleanly = false
    // The outcome reported to the caller (the steer sweep). Acceptance is
    // latched the moment the server answers 2xx with a stream — from then on
    // the message is a persisted turn server-side, whatever the stream does.
    let serverAccepted = false
    let rejectionStatus: number | null = null
    let assistantId: string | null = null
    // Counts steer splits, mirroring `assistantSegmentId` so the live segment
    // ids (bare turn id, then `:cont-N`) are exactly the ones hydration mints
    // for the persisted turn.
    let assistantSegment = 0
    // Whether the CURRENT assistant segment has received a block yet, tracked
    // here rather than read back out of state: a functional `setState` updater
    // does not run synchronously, so deciding control flow from inside one
    // reads a value from the wrong moment (the bucket re-key bug, correction 6
    // in tasks/chat-input-steering.md). Every place that adds a block sets it;
    // opening a segment clears it.
    let segmentHasBlocks = false

    // --- Streamed-delta coalescing -----------------------------------
    // text/reasoning deltas accumulate here and land in ONE state commit
    // per flush instead of one per token. Arrival order is preserved
    // exactly: the buffer holds deltas in order, `flushDeltas()` replays
    // them through the same append helpers, and `handleEvent` flushes
    // before processing ANY non-delta event — so a tool_use block, a
    // bucket re-key or a turn_complete can never overtake buffered text.
    //
    // Leading + TRAILING throttle. The gap gate alone is leading-edge only:
    // a burst of deltas followed by a stall (model thinking, network pause)
    // would leave the tail of the burst buffered and invisible for the whole
    // pause, since nothing else runs to trigger a flush. The trailing timer
    // guarantees buffered text becomes visible within
    // DELTA_FLUSH_INTERVAL_MS of the last delta, with no further event.
    type PendingDelta = { type: "text" | "reasoning"; delta: string }
    let pendingDeltas: PendingDelta[] = []
    // 0 → the first delta of the turn always flushes immediately.
    let lastFlushAt = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const clearFlushTimer = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }
    const flushDeltas = (): void => {
      // Always drop a pending trailing flush — either we're flushing now, or
      // the buffer is empty and the timer has nothing left to do.
      clearFlushTimer()
      if (pendingDeltas.length === 0) return
      const id = assistantId
      // Deltas are only ever buffered after `ensureAssistant`, so `id` is
      // set. Bail without dropping the buffer if that ever stops holding.
      if (!id) return
      const batch = pendingDeltas
      pendingDeltas = []
      lastFlushAt = Date.now()
      segmentHasBlocks = true
      updateBucket(turnId, (b) => ({
        ...b,
        messages: b.messages.map((m) =>
          m.kind === "assistant" && m.id === id
            ? {
                ...m,
                blocks: batch.reduce(
                  (blocks, d) =>
                    d.type === "text"
                      ? appendTextBlock(blocks, d.delta)
                      : appendReasoningBlock(blocks, d.delta),
                  m.blocks,
                ),
              }
            : m,
        ),
      }))
    }
    /**
     * Called after every buffered delta. Flushes immediately when the last
     * commit is at least a full interval old (leading edge — keeps
     * time-to-first-token and steady-stream latency unchanged); otherwise
     * arms a trailing flush so a stall can't strand the buffer.
     */
    const scheduleDeltaFlush = (): void => {
      if (Date.now() - lastFlushAt >= DELTA_FLUSH_INTERVAL_MS) {
        flushDeltas()
        return
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(flushDeltas, DELTA_FLUSH_INTERVAL_MS)
      }
    }

    const ensureAssistant = (id: string): void => {
      // Consume any pending steer split for this bucket. `delete` doubles as
      // the read (it returns whether the flag was set), and consuming it
      // unconditionally keeps a steer that arrived BEFORE the first assistant
      // message — whose bubble already sits above segment 0 — from cutting a
      // later position instead.
      const steerSplit = bucketStateRef.current.steerSplit.delete(turnId)
      if (assistantId === null) {
        assistantId = id
        segmentHasBlocks = false
        updateBucket(turnId, (b) => ({
          ...b,
          messages: [...b.messages, { kind: "assistant", id, blocks: [] }],
        }))
        return
      }
      if (!steerSplit) return
      // A steer bubble now sits BELOW the current assistant message. Close
      // that message and open a new segment so everything that arrives after
      // the steer renders after it — the same cut the persisted
      // `afterAssistantBlocks` encodes for `turnsToChatMessages`, reused
      // rather than inventing a second ordering rule (D3). Flush first:
      // buffered deltas arrived before the steer and belong to the message
      // above the bubble.
      flushDeltas()
      assistantSegment += 1
      const segmentId = assistantSegmentId(id, assistantSegment)
      assistantId = segmentId
      segmentHasBlocks = false
      updateBucket(turnId, (b) => ({
        ...b,
        messages: [
          ...b.messages,
          { kind: "assistant", id: segmentId, blocks: [] },
        ],
      }))
    }

    /**
     * A steer landed HERE in the stream: everything the server had already
     * emitted belongs above the bubble, everything after it belongs below.
     *
     * Called from the `steered` SSE event — for this client's own steer as
     * well as another tab's — and NOT from `steer()`. The server stamps the
     * steer's persisted position at the instant it pushes this frame, so
     * cutting anywhere else means the live cut and the recorded position are
     * two different moments that agree only when nothing streamed in between.
     * Reading the cut off the same stream frame makes them the same moment.
     *
     * Two shapes, because hydration never emits an assistant message with no
     * blocks:
     *
     *  - The current segment has blocks → close it and let the next block open
     *    a continuation below the bubble (the `steerSplit` flag).
     *  - It has none → it is the placeholder `turn_start` opened, sitting ABOVE
     *    the bubble. Opening a continuation would strand it in the MIDDLE of
     *    the transcript, where the trailing-only cleanup cannot reach it and
     *    hydration shows nothing at all. Move it below the bubble instead,
     *    keeping its id and segment number, so it fills in the right place.
     */
    const cutForSteer = (): void => {
      // Buffered deltas arrived before the frame and belong above the bubble.
      flushDeltas()
      // Nothing open yet: whatever comes next is created below the bubble
      // anyway, as segment 0 — which is exactly what hydration mints for a
      // steer recorded at position 0.
      if (assistantId === null) return
      if (segmentHasBlocks) {
        bucketStateRef.current.steerSplit.add(turnId)
        return
      }
      const id = assistantId
      updateBucket(turnId, (b) => {
        const empty = b.messages.find(
          (m) => m.kind === "assistant" && m.id === id && m.blocks.length === 0,
        )
        // Already last (or already filled by a racing commit) — nothing to do.
        if (!empty || b.messages[b.messages.length - 1] === empty) return b
        return {
          ...b,
          messages: [...b.messages.filter((m) => m !== empty), empty],
        }
      })
    }

    try {
      const snapshot = getCurrentSnapshotRef.current?.() ?? {}
      // The server receives the owning session for a resubmit, and the
      // caller's current sessionId (or null) for an ordinary submit.
      // SOLO_BUCKET is a client-internal key, never a server id.
      //
      // The resubmit branch reads NOTHING from visible state (D1): bucket keys
      // ARE server session ids whenever one exists (buckets re-key to the
      // server-minted id on the `session` event), and SOLO_BUCKET means
      // session tracking is off, where null resumes the same default session
      // an ordinary submit would.
      const sessionId =
        options?.targetBucketId !== undefined
          ? options.targetBucketId === SOLO_BUCKET
            ? null
            : options.targetBucketId
          : (getChatSessionIdRef.current?.() ?? null)
      const response = await editorFetch("/api/editor/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userMessage: trimmed,
          selection: snapshot.selection,
          page: snapshot.page,
          ...(sessionId ? { sessionId } : {}),
          ...(hasImages ? { images } : {}),
          ...(turnModelConfig ? { modelConfig: turnModelConfig } : {}),
        }),
        signal: abort.signal,
      })
      if (!response.ok || !response.body) {
        rejectionStatus = response.status
        // A refused RESUBMIT is surfaced by the sweep that owns it (which
        // retries a 409 and reports a terminal failure with the user's text),
        // not by a banner per attempt.
        if (!options?.suppressRejectionBanner) {
          const text = await response.text().catch(() => "")
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages,
              {
                kind: "error",
                id: makeLocalId(),
                // The full reason, not just the status. This used to say
                // `HTTP 429` while the body text went to `bucket.error` and a
                // second banner; with one banner it has to carry both.
                reason: text
                  ? `Chat request failed (${response.status}): ${text}`
                  : `Chat request failed: HTTP ${response.status}`,
              },
            ],
            error: `Chat request failed: ${response.status} ${text}`,
          }))
        }
        return { serverAccepted, rejectionStatus }
      }
      serverAccepted = true
      try {
        options?.onAccepted?.()
      } catch {
        // A subscriber's throw must not become "Chat stream failed" — this
        // callback is a notification about the turn, not part of running it.
      }
      for await (const event of parseSseStream<ChatStreamEvent>(response.body, abort.signal)) {
        await handleEvent(event)
      }
      // Reached only when the stream ran to completion without throwing. An
      // aborted read rejects, so Stop never gets here.
      streamClosedCleanly = !abort.signal.aborted
    } catch (err) {
      // Land whatever text streamed before the failure BEFORE appending the
      // error, so the timeline reads in arrival order.
      flushDeltas()
      if ((err as Error).name === "AbortError") {
        // User cancelled — don't surface as an error.
      } else if (serverAccepted || !options?.suppressRejectionBanner) {
        // Once the server accepted the turn this is an ordinary mid-stream
        // failure and surfaces normally even on a resubmit; a PRE-acceptance
        // throw on a resubmit is the sweep's to report (with the text).
        const reason = `Chat stream failed: ${(err as Error).message}`
        // Also as a message: the panel's bare `error` div is gone, and this
        // path used to be the only writer that never appended one, so it
        // would otherwise fail silently.
        updateBucket(turnId, (b) => ({
          ...b,
          messages: [...b.messages, { kind: "error", id: makeLocalId(), reason }],
          error: reason,
        }))
      }
    } finally {
      // Backstop flush: covers the happy path (stream ended without a
      // terminal event flushing) and the user-abort path. No-op when the
      // buffer is already empty. Also clears any armed trailing timer (via
      // flushDeltas → clearFlushTimer) so it can never fire after the turn
      // has ended.
      flushDeltas()
      // Only clear the bucket's submitting flag if this submit still
      // owns its abort controller. If a newer submit raced and replaced
      // the controller, the newer turn is still running.
      if (bucketStateRef.current.aborts.get(turnId) === abort) {
        bucketStateRef.current.aborts.delete(turnId)
        updateBucket(turnId, (b) => ({
          ...b,
          // SDK round-1 codex finding #3 fix (backstop): strip
          // transient rate_limit_warning / api_retry banners on
          // submit cleanup. The turn_complete + error case handlers
          // already do this for the happy / explicit-error paths;
          // this catches the user-abort path (where neither event
          // fires) and any future code path that closes the stream
          // without emitting one of those terminal events.
          // …and drop any assistant segment that never received a block, which
          // is what a steer sent after the model's last block leaves behind
          // (`turn_complete` opens the segment, nothing fills it). Hydration
          // emits no empty segment at all, so the live and re-hydrated
          // transcripts stay identical.
          messages: withoutEmptyAssistantMessages(
            b.messages.filter(
              (m) => m.kind !== "rate_limit_warning" && m.kind !== "api_retry",
            ),
          ),
          submitting: false,
        }))
      }
      // Phase 3 codex round-1 #4: fire onStreamComplete here so
      // `useChatSessions.onStreamComplete` runs AFTER the server's
      // `saveSession` (which lives in the route handler's finally,
      // executed before the stream closes). Refetching the listing
      // from this point sees the persisted turn.
      try {
        onStreamCompleteRef.current?.()
      } catch {
        // Subscriber throws must not break the submit lifecycle.
      }
      // THE NO-LOSS SWEEP. Every steer sent into this turn whose fate is still
      // unknown goes back out as an ordinary next turn. It runs on EVERY exit
      // path — result, error, Stop, abort, stream death, fetch rejection —
      // because the paths where the server's `resubmit_required` cannot reach
      // us are exactly the paths a steer is most likely to die on. Placed
      // after the abort-controller cleanup above so the sweep sees the bucket
      // as idle and is allowed to submit into it.
      const closeMode: TurnCloseMode = streamClosedCleanly
        ? "reconciled"
        : "unknown"
      bucketStateRef.current.lastCloseMode.set(turnId, closeMode)
      // When this submit IS a resubmit, the sweep that started it re-drains the
      // ledger after its batch; sweeping from here would be re-entrant and the
      // guard inside would drop straight back out anyway.
      if (!isSweeping(bucketStateRef.current, turnId)) {
        await sweepPendingSteersRef.current?.(turnId, closeMode)
      }
    }
    return { serverAccepted, rejectionStatus }

    async function handleEvent(event: ChatStreamEvent): Promise<void> {
      // Any non-delta event drains the buffer first, so buffered text can
      // never be reordered behind a tool block, a re-key, or turn_complete.
      if (event.kind !== "text_delta" && event.kind !== "reasoning_delta") {
        flushDeltas()
      }
      switch (event.kind) {
        case "session": {
          // Re-key the bucket from the initial client-side guess
          // (SOLO_BUCKET when no sessionId was known) to the server-
          // resolved sessionId. The bucket carries any messages
          // already appended (user message, queued banner, etc.), so
          // the visible pane keeps showing them once the tab strip
          // switches its visibleSessionId to the new id.
          //
          // Solo/branch mode: session tracking is off, so
          // `getVisibleSessionId()` stays `null` (→ SOLO_BUCKET) and
          // `onSessionEvent()` never moves it — re-keying here would
          // orphan the bucket and blank the conversation. Skip it and
          // keep everything in SOLO_BUCKET.
          const reKeyEnabled = getSessionReKeyEnabledRef.current?.() ?? true
          if (reKeyEnabled && turnId !== event.sessionId) {
            // Pinned BEFORE the updater is written, because `turnId` is a
            // mutable `let` that this same branch reassigns below, and React
            // does not run a functional updater synchronously — it runs it at
            // the next render, by which point `turnId` is already the NEW id.
            // Reading it from inside the updater therefore carried the
            // destination bucket onto itself (measured: `carry` was the empty
            // bucket, and the source bucket survived untouched), so every
            // message appended before the `session` event — the user's own
            // prompt on a brand-new chat — was left behind under a key nothing
            // reads again.
            const fromId = turnId
            setById((prev) => {
              const next = new Map(prev)
              const carry = next.get(fromId) ?? EMPTY_BUCKET
              const existing = next.get(event.sessionId)
              next.delete(fromId)
              // Defensive merge: if the destination key already has a
              // bucket (e.g. the tab strip hydrated that session's
              // persisted turns while this submit was racing toward
              // the `session` event), preserve those messages and
              // append the active turn's messages after them. UUID
              // collisions are vanishingly rare; this is mostly about
              // the hydration race. Submitting OR-merges: if any
              // stream is in flight on either bucket, the merged
              // bucket is in flight.
              if (existing) {
                next.set(event.sessionId, {
                  messages: [...existing.messages, ...carry.messages],
                  submitting: existing.submitting || carry.submitting,
                  // Prefer the active turn's error (or null) — the
                  // destination's error is stale state from before
                  // this stream started writing into it.
                  error: carry.error,
                  // Prefer the carry bucket's choice (the turn actually
                  // in flight) and fall back to whatever the
                  // destination already had (e.g. seeded from the
                  // persisted session).
                  modelConfig: carry.modelConfig ?? existing.modelConfig,
                })
              } else {
                next.set(event.sessionId, carry)
              }
              return next
            })
            // Carry EVERY piece of bucket-keyed state across in one call —
            // the abort controller, the steer ledger, the in-progress sweep,
            // the close mode, the server sessionId, the steer-split flag.
            // This used to be one hand-written block per ref, and the list was
            // incomplete twice running: the ledger was left behind (typed
            // messages under a key no sweep reads), then the sweep marker was
            // left behind (a nested second sweep that resubmitted a steer
            // TWICE). `carryBucketState` type-checks its rules against the
            // state's field list, so the next ref cannot be forgotten.
            carryBucketState(bucketStateRef.current, turnId, event.sessionId)
            // The resend snapshot records the bucket each entry sits in, and
            // the carry just moved them. Re-derive rather than leave rows
            // filed under a key the surface no longer resolves.
            publishResendingSteers()
            turnId = event.sessionId
          }
          // Recorded whether or not the bucket was re-keyed: in solo/branch
          // mode the bucket stays SOLO_BUCKET, and this is the only place the
          // client ever learns the sessionId `/steer` requires.
          bucketStateRef.current.serverSessionId.set(turnId, event.sessionId)
          try {
            onSessionEventRef.current?.(event.sessionId, event.projectId)
          } catch {
            // Same defense-in-depth as bridge-reply / edit-ack: a UI
            // throw must not break mid-stream event consumption.
          }
          break
        }
        case "capability_gap":
          updateBucket(turnId, (b) => ({
            ...b,
            // Deduped per bucket: re-pasting the same link in a long thread
            // should not stack identical offers.
            messages: b.messages.some(
              (m) => m.kind === "capability_gap" && m.capabilityId === event.capabilityId,
            )
              ? b.messages
              : [
                  ...b.messages,
                  {
                    kind: "capability_gap",
                    id: makeLocalId(),
                    capabilityId: event.capabilityId,
                    label: event.label,
                    detail: event.detail,
                    requiresEnv: event.requiresEnv,
                    envReady: event.envReady,
                    activation: event.activation,
                  },
                ],
          }))
          break
        case "steered": {
          // Draw a bubble for a steer this client did NOT send. That is what
          // the event is for: a steer is an ordinary POST from whichever tab
          // the user typed in, while the transcript that answers it belongs to
          // whoever reads this stream. Without this, that reader renders an
          // answer to a question it never saw.
          //
          // The SENDER must not get a second bubble — `steer()` already
          // appended one optimistically. The discriminator is the steer
          // ledger, not the rendered messages: `steer()` files its entry
          // BEFORE the POST leaves and the entry only clears once the turn has
          // ended, so during this turn "an unclaimed ledger entry with this
          // text" is exactly "I am the sender". Scanning rendered messages
          // instead would swallow a legitimate bubble any time the user had
          // typed the same words earlier in the thread.
          //
          // The match is CONSUMED (`steeredEventSeen`), because the event
          // carries no steer id — only text. Two clients steering identical
          // text into one turn therefore produce two bubbles here rather than
          // one: the first event claims the entry, the second finds no
          // unclaimed match and draws. Repeat over drop, always.
          const ownEntry = bucketStateRef.current.pendingSteers
            .get(turnId)
            ?.find((e) => !e.steeredEventSeen && e.text === event.userMessage)
          if (ownEntry) {
            ownEntry.steeredEventSeen = true
          } else {
            updateBucket(turnId, (b) => ({
              ...b,
              messages: [
                ...b.messages,
                {
                  kind: "user",
                  id: makeLocalId(),
                  text: steeredEventBubbleText(event.userMessage, event.imageCount),
                },
              ],
            }))
          }
          // The BUBBLE is optimistic (the sender drew it the moment they hit
          // Enter); the CUT is authoritative and happens here, for sender and
          // reader alike. The server stamps the steer's persisted position at
          // the instant it writes this frame, so this is the only point at
          // which the live split and the recorded one are the same moment.
          cutForSteer()
          break
        }
        case "resubmit_required": {
          // The turn could not show that this steer reached the model. Move its
          // ledger entry to `must-resubmit`; the end-of-turn sweep sends it
          // again. Deliberately NOT resubmitted here: the turn is still
          // streaming, and `submit()` aborts an in-flight turn on the same
          // bucket — resubmitting now would kill the turn we are still reading.
          const ledger = bucketStateRef.current.pendingSteers.get(turnId)
          const match = ledger?.find(
            (e) => e.state !== "must-resubmit" && e.text === event.userMessage,
          )
          if (match) {
            match.state = "must-resubmit"
          } else {
            // No entry: another client typed this steer (a steer is an ordinary
            // POST from whichever tab the user was in, while the transcript
            // belongs to whoever reads this stream). The event carries the full
            // payload for exactly this case, so adopt it rather than let it die
            // with a tab that may already be closed. `rendered: false` — this
            // client never drew a bubble for it, so the resubmit must.
            appendPendingSteer(bucketStateRef.current.pendingSteers, turnId, {
              id: makeLocalId(),
              text: event.userMessage,
              ...(event.images && event.images.length > 0
                ? { images: event.images.map(dataUrlFromModelImage) }
                : {}),
              rendered: false,
              state: "must-resubmit",
            })
          }
          break
        }
        case "queued":
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages,
              {
                kind: "queued",
                id: makeLocalId(),
                queuePosition: event.queuePosition,
              },
            ],
          }))
          break
        case "rate_limit_warning":
          // Latest-wins per turn: replace any prior rate_limit_warning
          // OR api_retry in the bucket. See the legacy comment for the
          // full rationale.
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages.filter(
                (m) =>
                  m.kind !== "rate_limit_warning" && m.kind !== "api_retry",
              ),
              {
                kind: "rate_limit_warning",
                id: makeLocalId(),
                status: event.status,
                ...(event.rateLimitType
                  ? { rateLimitType: event.rateLimitType }
                  : {}),
                ...(event.resetsAt !== undefined
                  ? { resetsAt: event.resetsAt }
                  : {}),
                ...(event.utilization !== undefined
                  ? { utilization: event.utilization }
                  : {}),
                ...(event.overageStatus !== undefined
                  ? { overageStatus: event.overageStatus }
                  : {}),
                ...(event.overageResetsAt !== undefined
                  ? { overageResetsAt: event.overageResetsAt }
                  : {}),
              },
            ],
          }))
          break
        case "api_retry":
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages.filter(
                (m) =>
                  m.kind !== "rate_limit_warning" && m.kind !== "api_retry",
              ),
              {
                kind: "api_retry",
                id: makeLocalId(),
                retryDelayMs: event.retryDelayMs,
                attempt: event.attempt,
                maxRetries: event.maxRetries,
                errorStatus: event.errorStatus,
              },
            ],
          }))
          break
        case "turn_start":
          ensureAssistant(event.turnId)
          break
        case "text_delta": {
          ensureAssistant(event.turnId)
          pendingDeltas.push({ type: "text", delta: event.delta })
          scheduleDeltaFlush()
          break
        }
        case "reasoning_delta": {
          ensureAssistant(event.turnId)
          pendingDeltas.push({ type: "reasoning", delta: event.delta })
          scheduleDeltaFlush()
          break
        }
        case "tool_use_start": {
          ensureAssistant(event.turnId)
          const id = assistantId!
          segmentHasBlocks = true
          updateBucket(turnId, (b) => ({
            ...b,
            messages: b.messages.map((m) =>
              m.kind === "assistant" && m.id === id
                ? {
                    ...m,
                    blocks: [
                      ...m.blocks,
                      {
                        type: "tool_use",
                        toolUseId: event.toolUseId,
                        name: event.name,
                        input: event.input,
                      },
                    ],
                  }
                : m,
            ),
          }))
          break
        }
        case "tool_result": {
          ensureAssistant(event.turnId)
          // Matched by toolUseId across EVERY assistant message, not pinned to
          // the current `assistantId`: a steer split can rotate the current
          // message between tool_use_start and tool_result, and the block this
          // result belongs to then lives in an earlier segment. (Hydration has
          // always been id-agnostic here — `toolResults` is keyed per turn.)
          updateBucket(turnId, (b) => ({
            ...b,
            messages: b.messages.map((m) => {
              if (m.kind !== "assistant") return m
              let hit = false
              const blocks = m.blocks.map((blk) => {
                if (
                  blk.type === "tool_use" &&
                  blk.toolUseId === event.toolUseId
                ) {
                  hit = true
                  return {
                    ...blk,
                    result: event.ok
                      ? ({ ok: true, output: event.output } as const)
                      : ({ ok: false, error: event.error ?? "" } as const),
                  }
                }
                return blk
              })
              // Referential identity preserved when nothing matched, so a
              // result for one segment doesn't churn every other message.
              return hit ? { ...m, blocks } : m
            }),
          }))
          break
        }
        case "bridge_request": {
          const handler = handlersRef.current[event.messageType]
          let result: { ok: true; output: unknown } | { ok: false; error: string }
          if (!handler) {
            result = { ok: false, error: `No shell handler for '${event.messageType}'` }
          } else {
            try {
              result = await handler(event.payload, abort.signal)
            } catch (err) {
              result = { ok: false, error: (err as Error).message }
            }
          }
          void editorFetch("/api/editor/chat/bridge-reply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bridgeReqId: event.bridgeReqId,
              ok: result.ok,
              output: result.ok ? result.output : undefined,
              error: result.ok ? undefined : result.error,
            }),
            signal: abort.signal,
          }).catch(() => {
            // Suppressed — orchestrator already timed out.
          })
          break
        }
        case "edit_overwrite_warning": {
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages,
              {
                kind: "overwrite_warning",
                id: makeLocalId(),
                file: event.file,
                hashAtRead: event.hashAtRead,
                hashAtWrite: event.hashAtWrite,
                ...(event.conflictingSessionId
                  ? { conflictingSessionId: event.conflictingSessionId }
                  : {}),
                ...(event.conflictingSessionPrompt
                  ? { conflictingSessionPrompt: event.conflictingSessionPrompt }
                  : {}),
              },
            ],
          }))
          break
        }
        case "edit_proposed": {
          const handler = onEditProposedRef.current
          const result = handler
            ? await handler(event.editId, event.edit)
            : { ok: false as const, reason: "No edit handler wired" }
          if (!result.ok) {
            updateBucket(turnId, (b) => ({
              ...b,
              messages: [
                ...b.messages,
                {
                  kind: "error",
                  id: makeLocalId(),
                  reason: `Agent proposal rejected: ${result.reason}`,
                },
              ],
            }))
          }
          void editorFetch("/api/editor/chat/edit-ack", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              editId: event.editId,
              ok: result.ok,
              reason: result.ok ? undefined : result.reason,
            }),
            signal: abort.signal,
          }).catch(() => {
            // Suppressed — see bridge-reply rationale.
          })
          break
        }
        case "usage":
          // Tracked at the assistant level but not yet rendered.
          break
        case "turn_complete": {
          ensureAssistant(event.turnId)
          const id = assistantId!
          updateBucket(turnId, (b) => ({
            ...b,
            messages: b.messages
              .filter(
                (m) =>
                  m.kind !== "rate_limit_warning" && m.kind !== "api_retry",
              )
              .map((m) =>
                m.kind === "assistant" && m.id === id
                  ? { ...m, stopReason: event.stopReason }
                  : m,
              ),
          }))
          try {
            onTurnCompleteRef.current?.()
          } catch {
            // Caller-supplied hook; swallow so a UI-side throw can't
            // tear down the SSE consumer mid-stream.
          }
          break
        }
        case "error":
          updateBucket(turnId, (b) => ({
            ...b,
            messages: [
              ...b.messages.filter(
                (m) =>
                  m.kind !== "rate_limit_warning" && m.kind !== "api_retry",
              ),
              { kind: "error", id: makeLocalId(), reason: event.reason },
            ],
            error: event.reason,
          }))
          break
        default: {
          // Exhaustiveness guard. `steered` and `resubmit_required` were added
          // to the SSE union and fell through this switch unhandled for a whole
          // implementation round — with no default arm, typecheck stayed green
          // while two events the feature depends on were silently ignored. A
          // future event kind now fails to COMPILE here instead.
          const unhandled: never = event
          // Runtime-tolerant on purpose: a newer server sending an event this
          // client does not know must not break the stream. The `never` above
          // is the real guard; this line only keeps it referenced.
          void unhandled
          break
        }
      }
    }
  }, [publishResendingSteers, updateBucket])

  const submit = useCallback(
    async (userMessage: string, images?: string[]): Promise<void> => {
      // The outcome is internal (the steer sweep reads it); public submit
      // keeps its void contract.
      await runSubmit(userMessage, images)
    },
    [runSubmit],
  )

  /**
   * Resubmit one ledgered steer as an ordinary turn.
   *
   * **The entry leaves the ledger only when its fate is decided**: the server
   * ACCEPTED the resubmit (2xx + stream — a persisted turn from that moment),
   * or its failure was surfaced in the transcript carrying the user's text.
   * Removing on attempt is what used to make one failed POST terminal; a
   * ledger that only empties on acceptance is what makes it a guarantee (D2).
   *
   * A 409 is retried on the bounded backoff schedule (see
   * `RESUBMIT_409_RETRY_DELAYS_MS` for why retrying beats waiting). Any other
   * refusal is not predictably transient, so it goes straight to the visible
   * error — still carrying the text, so it is recoverable by hand.
   *
   * Returns false when the whole sweep must stop: the hook unmounted
   * mid-backoff, or a fresh user submit took the bucket (submitting under it
   * would abort the user's own turn; the entry STAYS ledgered and that turn's
   * end-of-turn sweep re-runs us).
   *
   * The whole loop is also what `resendingSteers` reports, so the user can see
   * a recovery that used to be entirely silent.
   *
   * **The mark comes down when acceptance becomes KNOWN, not when the resent
   * turn ends.** Those are very different moments: `runSubmit` resolves only
   * once the whole SSE stream closes, so clearing on its return left the row
   * up for the entire recovered turn — telling the user the message had not
   * reached the agent while the agent streamed its answer to that exact
   * message, directly above the row. That is worse than the silence the row
   * was added to fix, because silence is merely ambiguous. So `onAccepted`
   * clears it at the 2xx, and the `finally` stays as the backstop for the
   * three exits that never reach acceptance: terminal failure, unmount
   * mid-backoff, and a fresh user submit taking the bucket. Clearing twice is
   * a no-op.
   */
  const resubmitSteer = useCallback(
    async (entry: PendingSteer, sweep: SweepHandle): Promise<boolean> => {
      /** Idempotent: both the acceptance hook and the `finally` call it. */
      const clearResendingMark = (): void => {
        if (entry.resending === undefined) return
        entry.resending = undefined
        publishResendingSteers()
      }
      try {
        for (let attempt = 0; ; attempt++) {
          // Re-read the bucket on every attempt: a `session` event mid-resubmit
          // re-keys the bucket, and the handle follows it. A captured id would
          // check the abort map, and land the failure banner, under a key
          // nothing reads any more.
          const bucketId = sweep.bucketId
          if (disposedRef.current) return false
          if (bucketStateRef.current.aborts.has(bucketId)) return false
          // 1-based: the indicator reads "attempt 2" for the first retry, not
          // "attempt 1". Set BEFORE the POST, so the row is on screen for the
          // request itself and not only for the backoff that follows it.
          entry.resending = { attempt: attempt + 1 }
          publishResendingSteers()
          const outcome = await runSubmit(entry.text, entry.images, {
            skipOptimisticUserMessage: entry.rendered,
            targetBucketId: bucketId,
            suppressRejectionBanner: true,
            // The resend is over the moment the server takes the turn. Waiting
            // for `runSubmit` to resolve would hold the row up for the whole
            // recovered turn — see this callback's own doc comment.
            onAccepted: clearResendingMark,
          })
          // Whatever happens next, the first attempt has drawn the bubble for
          // an entry that had none (`runSubmit` appends it before the fetch) —
          // a retry must not draw a second one for the same typed message.
          entry.rendered = true
          if (outcome.serverAccepted) {
            removePendingSteer(bucketStateRef.current.pendingSteers, entry.id)
            return true
          }
          if (
            outcome.rejectionStatus === 409 &&
            attempt < RESUBMIT_409_RETRY_DELAYS_MS.length
          ) {
            // The mark deliberately STAYS up across this wait. The wait is
            // most of the elapsed recovery time, and a spinner that blinked
            // off between attempts would restore the silence it exists to end.
            await waitForRetry(RESUBMIT_409_RETRY_DELAYS_MS[attempt])
            continue
          }
          // Terminal. Surface it CARRYING THE TEXT — the transcript bubble
          // alone is not enough to make the failure findable — and only then
          // let the entry go: its fate is now decided loudly, never silently.
          removePendingSteer(bucketStateRef.current.pendingSteers, entry.id)
          const label =
            entry.text.trim().length > 0
              ? `"${entry.text}"`
              : "your attached image(s)"
          const reason =
            outcome.rejectionStatus === 409
              ? `Could not deliver your message ${label} . The previous turn never released its lock. Please send it again.`
              : `Could not deliver your message ${label}${
                  outcome.rejectionStatus !== null
                    ? ` (HTTP ${outcome.rejectionStatus})`
                    : ""
                }. Please send it again.`
          // `sweep.bucketId` again, not the captured `bucketId`: the resubmit we
          // just awaited may itself have re-keyed the bucket, and a banner in
          // the old bucket is a banner nobody sees.
          updateBucket(sweep.bucketId, (b) => ({
            ...b,
            messages: [
              ...b.messages,
              { kind: "error", id: makeLocalId(), reason },
            ],
            error: reason,
          }))
          return true
        }
      } finally {
        // Backstop only — acceptance already cleared it via `onAccepted`. This
        // covers the three exits that never reach a 2xx: terminal failure,
        // unmount mid-backoff, and a fresh submit taking the bucket. The last
        // two KEEP the entry ledgered to be swept again later, and a stale
        // mark would make that next sweep's first attempt look like a
        // continuation of this one.
        clearResendingMark()
      }
    },
    [publishResendingSteers, runSubmit, updateBucket, waitForRetry],
  )

  /**
   * Resubmit every steer in `bucketId`'s ledger whose fate is not settled.
   *
   * Sequential, never concurrent: `submit()` aborts a prior in-flight turn on
   * the same bucket, so two parallel resubmits would destroy each other.
   */
  const sweepPendingSteers = useCallback(
    async (bucketId: string, mode: TurnCloseMode): Promise<void> => {
      // A turn still owns this bucket. Resubmitting now would abort it, and
      // nothing is lost by waiting: that turn's own finally runs this sweep.
      if (bucketStateRef.current.aborts.has(bucketId)) return
      if (isSweeping(bucketStateRef.current, bucketId)) return
      // The handle FOLLOWS the bucket through a re-key (see `SweepHandle`), so
      // every read below goes through `sweep.bucketId` rather than the id this
      // sweep started on. A sweep pinned to the old id would drain an empty
      // ledger while the steers sat under the new one.
      const sweep = beginSweep(bucketStateRef.current, bucketId)
      try {
        let closeMode = mode
        for (;;) {
          const entries = bucketStateRef.current.pendingSteers.get(sweep.bucketId)
          if (!entries || entries.length === 0) return
          // Snapshot: resubmits await whole turns, and new steers appended
          // during them are picked up by the next pass with THAT turn's close
          // mode.
          const batch = [...entries]
          for (const entry of batch) {
            // Already settled by someone else (e.g. a re-key moved the ledger
            // mid-sweep and the carried bucket's own sweep got there first).
            if (!findPendingSteer(bucketStateRef.current.pendingSteers, entry.id)) continue
            // On a reconciled close an `accepted` steer that was NOT flagged
            // is confirmed consumed — the server's reconciliation ran and
            // said nothing about it — so resending it would duplicate a
            // message the model already answered. Everything else goes back
            // out, INCLUDING a steer whose POST is still outstanding: an
            // unanswered POST is not a confirmation, and its settle path
            // finds the entry gone and stands down. That can deliver a
            // message twice. Repeat over drop, always.
            if (closeMode === "reconciled" && entry.state === "accepted") {
              removePendingSteer(bucketStateRef.current.pendingSteers, entry.id)
              continue
            }
            // Awaited one at a time — `submit()` aborts a prior in-flight
            // turn on the same bucket, so parallel resubmits would destroy
            // each other.
            if (!(await resubmitSteer(entry, sweep))) return
          }
          // A steer accepted DURING one of those resubmitted turns lands back
          // in the ledger, and that turn suppressed its own sweep because this
          // one was running. Go again rather than strand it; the turn that
          // just ended recorded how it closed.
          closeMode =
            bucketStateRef.current.lastCloseMode.get(sweep.bucketId) ?? "unknown"
        }
      } finally {
        // By identity, so a re-keyed sweep releases the bucket it now holds
        // and never latches the new key.
        endSweep(bucketStateRef.current, sweep)
      }
    },
    [resubmitSteer],
  )
  sweepPendingSteersRef.current = sweepPendingSteers

  /**
   * Record what the steer route answered, then decide whether the entry can
   * still wait for a verdict from the owning turn's stream.
   */
  const settleSteer = useCallback(
    async (id: string, state: "accepted" | "must-resubmit"): Promise<void> => {
      const found = findPendingSteer(bucketStateRef.current.pendingSteers, id)
      // Gone means its fate is already decided — the sweep resubmitted it and
      // the server accepted, or the failure was surfaced with the text.
      // Re-filing it here would send it again on top of that.
      if (!found) return
      found.entry.state = state
      // The turn this was steered into has already ended, so no verdict is
      // coming: the sweep ran before this response landed. Sweep again. When
      // the answer was `accepted` this may deliver the message twice, which is
      // the direction to be wrong in.
      if (!bucketStateRef.current.aborts.has(found.bucketId)) {
        await sweepPendingSteers(found.bucketId, "unknown")
      }
    },
    [sweepPendingSteers],
  )

  const steer = useCallback(
    async (userMessage: string, images?: string[]): Promise<void> => {
      const trimmed = userMessage.trim()
      const hasImages = Array.isArray(images) && images.length > 0
      if (trimmed.length === 0 && !hasImages) return
      // Resolve the bucket exactly the way `submit` pins its own: a steer
      // belongs to the session that OWNS the running turn, not to whatever tab
      // happens to be visible when the user hits Enter.
      const bucketId = getChatSessionIdRef.current?.() ?? SOLO_BUCKET
      const entry: PendingSteer = {
        id: makeLocalId(),
        text: trimmed,
        ...(hasImages ? { images } : {}),
        rendered: true,
        state: "in-flight",
      }
      // Ledgered BEFORE the network call, deliberately. An entry created only
      // after a successful POST is an entry that a rejected POST loses.
      appendPendingSteer(bucketStateRef.current.pendingSteers, bucketId, entry)
      // The assistant-message CUT is deliberately not made here. It happens when
      // the running turn's stream echoes this steer back as a `steered` frame,
      // because that frame is written at the exact instant the server stamps the
      // steer's persisted position. Cutting at this line instead would put the
      // live split and the recorded position at two different moments, and any
      // text that streamed in between would land above the bubble on a reload
      // and below it live — the same disagreement in a narrower window.
      // Optimistic: the turn has taken the message on and there is nothing to
      // hold back. Same image-only fallback label as `submit`, so an
      // attachment-only steer can never render as an empty bubble.
      const bubbleText =
        trimmed.length > 0
          ? trimmed
          : `📎 ${images!.length} image${images!.length > 1 ? "s" : ""}`
      updateBucket(bucketId, (b) => ({
        ...b,
        messages: [
          ...b.messages,
          { kind: "user", id: makeLocalId(), text: bubbleText },
        ],
      }))

      // `/steer` requires a real sessionId and refuses to default one (a
      // defaulted id would deliver into the wrong thread). Prefer the id the
      // server itself reported for this bucket.
      const sessionId =
        bucketStateRef.current.serverSessionId.get(bucketId) ??
        getChatSessionIdRef.current?.() ??
        null
      if (!sessionId) {
        await settleSteer(entry.id, "must-resubmit")
        return
      }

      try {
        const response = await editorFetch("/api/editor/chat/steer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            userMessage: trimmed,
            ...(hasImages ? { images } : {}),
          }),
        })
        // `accepted: true` is the ONLY thing that lets this entry wait. A 409
        // (the turn ended under us) is a normal race, not an error, and gets no
        // banner — the resubmit is the answer to it.
        const body: unknown = response.ok
          ? await response.json().catch(() => null)
          : null
        const accepted =
          typeof body === "object" &&
          body !== null &&
          (body as { accepted?: unknown }).accepted === true
        await settleSteer(entry.id, accepted ? "accepted" : "must-resubmit")
      } catch {
        // Network failure, aborted request, malformed response — all the same
        // thing from here: nothing confirmed the message, so it goes back out.
        await settleSteer(entry.id, "must-resubmit")
      }
    },
    [settleSteer, updateBucket],
  )

  const abort = useCallback(() => {
    // Aborts the visible bucket's stream. Background streams keep
    // running — to cancel one of those, switch to its tab first.
    const id = getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
    bucketStateRef.current.aborts.get(id)?.abort()
  }, [])

  const clearLocal = useCallback(() => {
    const id = getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
    setById((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const dismissMessage = useCallback((id: string) => {
    // Resolve the visible bucket the same way clearLocal/abort do — through
    // the ref, so a dismissal always lands on the session the user is looking
    // at rather than whichever one a background stream last wrote to.
    const bucketId = getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
    updateBucket(bucketId, (b) => {
      const messages = b.messages.filter((m) => m.id !== id)
      // Preserve referential identity when nothing matched, so an unknown id
      // can't churn the memoized return and re-render the chat surface.
      return messages.length === b.messages.length ? b : { ...b, messages }
    })
  }, [updateBucket])

  const hydrateFromTranscript = useCallback(
    (turns: ChatTurn[], sessionId?: string) => {
      const id =
        sessionId ?? getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
      // Abort any in-flight turn for this bucket — defensive against a
      // late stream clobbering the just-hydrated state. Background
      // streams on OTHER buckets are untouched.
      const inflight = bucketStateRef.current.aborts.get(id)
      if (inflight) {
        inflight.abort()
        bucketStateRef.current.aborts.delete(id)
      }
      setById((prev) => {
        const next = new Map(prev)
        next.set(id, {
          messages: turnsToChatMessages(turns),
          submitting: false,
          error: null,
          modelConfig: null,
        })
        return next
      })
    },
    [],
  )

  // Reads the mirror ref rather than closing over `byId` so its identity is
  // stable across state commits (a `[byId]` dep would re-key the memoized
  // return object on every streamed flush, defeating the point) — and so a
  // handler invoked later in the same tick sees the latest map, not the one
  // captured at render time. Only ever called from event handlers.
  const hasSessionBucket = useCallback(
    (sessionId: string): boolean => byIdRef.current.has(sessionId),
    [],
  )

  const setModelConfig = useCallback(
    (config: SessionModelConfig | null): void => {
      const target = getVisibleSessionIdRef.current?.() ?? SOLO_BUCKET
      updateBucket(target, (b) => ({ ...b, modelConfig: config }))
    },
    [updateBucket],
  )

  const seedModelConfig = useCallback(
    (sessionId: string, config: SessionModelConfig | null): void => {
      updateBucket(sessionId, (b) =>
        b.modelConfig !== null ? b : { ...b, modelConfig: config },
      )
    },
    [updateBucket],
  )

  // Sliced to the visible bucket here rather than stored per-bucket, so the
  // slice follows a tab switch (which changes `visibleId` without touching the
  // ledger) and a bucket re-key alike. Memoized separately from the return
  // object because it must not rebuild on every streamed flush.
  const visibleResendingSteers = useMemo(
    (): ResendingSteer[] =>
      resendingSteers
        .filter((r) => r.bucketId === visibleId)
        .map((r) => ({ id: r.id, text: r.text, attempt: r.attempt })),
    [resendingSteers, visibleId],
  )

  // Memoized so the object's identity only changes when the VISIBLE bucket's
  // content changes. Every consumer takes this whole object as a prop
  // (`EditorChatPanel`), so a fresh literal per render would make
  // `React.memo` on those consumers useless — and would re-render them on
  // surface renders that have nothing to do with chat (selection changes,
  // layer refreshes, a background session's stream).
  return useMemo(
    () => ({
      messages: visibleBucket.messages,
      submitting: visibleBucket.submitting,
      error: visibleBucket.error,
      submit,
      steer,
      resendingSteers: visibleResendingSteers,
      abort,
      clearLocal,
      dismissMessage,
      hydrateFromTranscript,
      hasSessionBucket,
      modelConfig: visibleBucket.modelConfig,
      setModelConfig,
      seedModelConfig,
    }),
    [
      visibleBucket.messages,
      visibleBucket.submitting,
      visibleBucket.error,
      visibleBucket.modelConfig,
      visibleResendingSteers,
      submit,
      steer,
      abort,
      clearLocal,
      dismissMessage,
      hydrateFromTranscript,
      hasSessionBucket,
      setModelConfig,
      seedModelConfig,
    ],
  )
}

/**
 * Drop every assistant message that never received a block, at turn end.
 *
 * `turn_complete`, `tool_result` and friends call `ensureAssistant`, which
 * consumes a pending steer split by opening a fresh segment. When nothing
 * follows, that segment stays empty and renders as a blank assistant bubble.
 * `turnsToChatMessages` emits no empty segment at all, so anything empty left
 * here is a message the two paths cannot agree on.
 *
 * This used to be TRAILING-only, on the reasoning that an empty message in the
 * middle could not occur. It could, and did: `turn_start` opens a placeholder
 * segment, and a steer arriving before the first block left that placeholder
 * sitting above the new bubble with the whole reply below it. `cutForSteer`
 * now moves the placeholder instead of stranding it, so that particular case is
 * gone at the source — this stays generalized as the backstop, because an empty
 * segment followed by an `error` message is the same shape by a different
 * route, and an empty bubble is never something to render.
 */
function withoutEmptyAssistantMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.kind === "assistant" && m.blocks.length === 0)) {
    // Identity preserved when there is nothing to drop, so the common case
    // does not churn every rendered message.
    return messages
  }
  return messages.filter((m) => m.kind !== "assistant" || m.blocks.length > 0)
}

function appendTextBlock(blocks: AssistantBlockUi[], delta: string): AssistantBlockUi[] {
  // An empty delta (the SDK opens a text block before it has any text) must
  // not mint an empty part: rendered, it is an empty div between two tool
  // rows, which breaks their fusing and adds two margins where there should
  // be none.
  if (delta.length === 0) return blocks
  const out = [...blocks]
  const last = out[out.length - 1]
  if (last && last.type === "text") {
    out[out.length - 1] = { ...last, text: last.text + delta }
  } else {
    out.push({ type: "text", text: delta })
  }
  return out
}

function appendReasoningBlock(
  blocks: AssistantBlockUi[],
  delta: string,
): AssistantBlockUi[] {
  const out = [...blocks]
  const last = out[out.length - 1]
  // Extend the trailing reasoning block, or start a new one. A reasoning
  // block interrupted by text/tool_use (interleaved thinking) starts a fresh
  // block, preserving arrival order.
  if (last && last.type === "reasoning") {
    out[out.length - 1] = { ...last, text: last.text + delta }
  } else {
    out.push({ type: "reasoning", text: delta })
  }
  return out
}

/**
 * Convert persisted `ChatTurn[]` into the UI's `ChatMessage[]` shape.
 * One turn → one user message + one assistant message. Tool results
 * are merged into their matching `tool_use` block by `toolUseId`.
 * Errored turns get a trailing `error` message so the user sees why
 * the turn stopped.
 *
 * A turn that received steers (messages typed while it was running) renders as
 * more than one assistant message: the reply is cut at each steer's recorded
 * position so the steered text appears as a user bubble WHERE IT WAS SENT.
 * Appending them at the end would be a different conversation from the one
 * that happened — the model answered mid-reply, and the transcript has to show
 * the question before the answer to it.
 */
function turnsToChatMessages(turns: ChatTurn[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const turn of turns) {
    out.push({
      kind: "user",
      id: `${turn.id}:user`,
      text: turn.userMessage,
    })
    const blocks: AssistantBlockUi[] = turn.assistantContent.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text }
      const result = turn.toolResults[b.toolUseId]
      return {
        type: "tool_use",
        toolUseId: b.toolUseId,
        name: b.name,
        input: b.input,
        result: result
          ? result.ok
            ? { ok: true, output: result.output }
            : { ok: false, error: result.error ?? "tool failed" }
          : undefined,
      }
    })
    // `cursor` only ever moves forward, and the trailing segment is emitted
    // unconditionally. Together that means every block is rendered exactly
    // once and every steer is rendered, whatever the recorded positions say —
    // a session file with nonsense indices degrades to bad ordering, never to
    // a dropped message. Absent `steers` (older turns, or a turn nobody
    // steered) takes the loop zero times and the output is byte-for-byte what
    // it was before steering existed.
    let cursor = 0
    let segment = 0
    turn.steers?.forEach((steer, i) => {
      const at = Math.min(Math.max(steer.afterAssistantBlocks, cursor), blocks.length)
      if (at > cursor) {
        out.push({
          kind: "assistant",
          id: assistantSegmentId(turn.id, segment),
          blocks: blocks.slice(cursor, at),
        })
        segment += 1
        cursor = at
      }
      out.push({
        kind: "user",
        id: `${turn.id}:steer:${i}`,
        text: steerBubbleText(steer),
      })
    })
    // The trailing segment is emitted only if it actually holds blocks. A
    // steer recorded at `afterAssistantBlocks === blocks.length` — the user
    // typed while the turn was finishing — leaves nothing after the cut, and
    // an assistant message with zero blocks renders as a blank bubble under
    // the user's text. The live path suppresses the same thing at turn end
    // (see `withoutEmptyTrailingAssistant`); the two must agree, or the same
    // conversation reads differently before and after a reload.
    //
    // Intermediate segments were already conditional (`if (at > cursor)`), so
    // this makes the rule uniform rather than adding a new one. Nothing is
    // lost: every block still renders exactly once, because `cursor` only ever
    // moves forward and a non-empty tail is still always pushed.
    const tail = blocks.slice(cursor)
    if (tail.length > 0) {
      out.push({
        kind: "assistant",
        id: assistantSegmentId(turn.id, segment),
        blocks: tail,
      })
    }
    if (turn.error) {
      out.push({
        kind: "error",
        id: `${turn.id}:error`,
        reason: turn.error,
      })
    }
  }
  return out
}

/**
 * Bubble text for a `steered` event this client did not send.
 *
 * `steered` carries a COUNT of images, never their bytes, so an image-only
 * steer has to fall back to the same attachment label `submit`/`steer` use for
 * a locally-typed one — otherwise it renders as a blank bubble. The count is
 * known here (unlike the persisted case in `steerBubbleText`), so it is shown.
 */
function steeredEventBubbleText(userMessage: string, imageCount: number): string {
  const trimmed = userMessage.trim()
  if (trimmed.length > 0) return trimmed
  if (imageCount > 0) {
    return `📎 ${imageCount} image${imageCount > 1 ? "s" : ""}`
  }
  return trimmed
}

/**
 * Bubble text for a persisted steer.
 *
 * An image-only steer persists with empty `text` — the image BYTES are
 * deliberately not written to the session file, only `hadImages` — so
 * rendering `text` alone re-hydrated it as a blank bubble. `hadImages` exists
 * for exactly this and nothing read it. Mirrors the attachment fallback the
 * streaming path already uses for ordinary messages, minus the count: how many
 * images rode along is not recoverable from the session file, so the label
 * does not claim a number it cannot know.
 */
function steerBubbleText(steer: ChatSteeredMessage): string {
  if (steer.text.trim().length > 0) return steer.text
  return steer.hadImages ? "📎 image attachment" : steer.text
}

/**
 * Id for one assistant segment of a turn. The FIRST segment keeps the bare
 * turn id, which is what an unsteered turn has always used and what the
 * streaming path assigns — so hydrating a turn with no steers produces the
 * exact same ids as before. Later segments only exist on a steered turn.
 */
function assistantSegmentId(turnId: string, segment: number): string {
  return segment === 0 ? turnId : `${turnId}:cont-${segment}`
}

function makeLocalId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
