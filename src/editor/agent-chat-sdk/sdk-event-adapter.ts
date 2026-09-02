/**
 * Translate SDK message stream into Editor's `ChatStreamEvent` SSE
 * shape. Phase 1 shipped the minimum mapping; Phase 4 polishes
 * cache-token telemetry and permission-denial events:
 *
 *   - `tool_use_start` fires on the assistant message with the fully
 *     resolved `input`. The partial `content_block_start` for a
 *     tool_use carries `input: {}` (the args stream in later as
 *     `input_json_delta` partials and are only assembled by the time
 *     the assistant message arrives), so emitting early was forcing
 *     the UI to render `input: {}` forever. The disclosure-before-
 *     execution invariant still holds: the assistant message lands
 *     before `canUseTool` fires, which lands before the tool runs.
 *   - `usage` carries `cacheCreationInputTokens` and
 *     `cacheReadInputTokens` from `SDKResultMessage.usage` so the
 *     cost-ceiling math and UI telemetry both see cache effects.
 *   - `SDKPermissionDeniedMessage` (SDK auto-deny short-circuit)
 *     surfaces as a synthesized failed `tool_result` so the UI's
 *     existing tool-result renderer can display it.
 *
 * The `edit_proposed` event is NOT emitted from this adapter — it
 * comes out of `canUseTool` (see `edit-ack.ts`) and from the
 * `propose_prop_edit` MCP tool. Those run synchronously inside the
 * SDK iteration, so the orchestrator wires both directly into its
 * `emit()` callback rather than translating from SDK messages.
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import { flattenSdkMessage } from './sdk-message-flatten'

export interface SdkEventAdapter {
  adapt(msg: SDKMessage): Iterable<ChatStreamEvent>
}

/**
 * Per-turn mutable state. Tracks whether any reasoning was already streamed
 * via `thinking_delta` partials so the final assistant `thinking` block isn't
 * double-emitted (the streaming path covers the live UX; the final-block path
 * is the fallback for non-streaming / summarized thinking).
 */
interface AdapterState {
  reasoningStreamed: boolean
}

/**
 * Per-turn adapter that translates SDK messages into chat stream events.
 * Holds per-turn reasoning-dedup state (see {@link AdapterState}).
 */
export function createSdkEventAdapter(turnId: string): SdkEventAdapter {
  const state: AdapterState = { reasoningStreamed: false }
  return {
    *adapt(msg: SDKMessage): Generator<ChatStreamEvent> {
      yield* adaptMessage(msg, turnId, state)
    },
  }
}

/**
 * Stateless convenience for unit tests and one-shot translations.
 */
export function adaptSdkMessageToChatEvents(
  msg: SDKMessage,
  turnId: string,
): Generator<ChatStreamEvent> {
  return adaptMessage(msg, turnId, { reasoningStreamed: false })
}

function* adaptMessage(
  msg: SDKMessage,
  turnId: string,
  state: AdapterState,
): Generator<ChatStreamEvent> {
  if (msg.type === 'stream_event') {
    yield* fromPartial(msg, turnId, state)
    return
  }
  if (msg.type === 'assistant') {
    yield* fromAssistant(msg, turnId, state)
    return
  }
  if (msg.type === 'user') {
    yield* fromUser(msg, turnId)
    return
  }
  if (msg.type === 'result') {
    yield* fromResult(msg, turnId)
    return
  }
  // SDKPermissionDeniedMessage surfaces as a system message with
  // subtype `permission_denied`. We synthesize a failed tool_result
  // so the UI's existing renderer can display the denial.
  // SDKAPIRetryMessage is also `type: 'system'` (subtype 'api_retry')
  // — handled by the same fromSystem fan-out.
  if (msg.type === 'system') {
    yield* fromSystem(msg, turnId)
    return
  }
  // Phase 5 follow-up: SDKRateLimitEvent is a top-level message type
  // (not a system subtype). When the API signals rate-limit pressure
  // mid-stream — `status: 'allowed_warning'` — we surface a
  // `rate_limit_warning` SSE event so the shell can render a live
  // banner. `allowed` is normal traffic (no surfacing); `rejected`
  // means the SDK is about to throw and our existing catch arm
  // handles the post-failure classifier path.
  if (msg.type === 'rate_limit_event') {
    yield* fromRateLimitEvent(msg as { type: 'rate_limit_event' } & Record<string, unknown>)
    return
  }
  // Status, hook events, init, etc. — Phase 4 ignores them.
}

function* fromPartial(
  msg: SDKPartialAssistantMessage,
  turnId: string,
  state: AdapterState,
): Generator<ChatStreamEvent> {
  const event = msg.event as
    | {
        type?: string
        delta?: { type?: string; text?: string; thinking?: string }
      }
    | undefined
  if (!event || typeof event !== 'object') return
  if (event.type === 'content_block_delta') {
    if (
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string' &&
      event.delta.text.length > 0
    ) {
      yield { kind: 'text_delta', turnId, delta: event.delta.text }
    } else if (
      // Extended-thinking stream: the delta carries `thinking`, not `text`.
      event.delta?.type === 'thinking_delta' &&
      typeof event.delta.thinking === 'string' &&
      event.delta.thinking.length > 0
    ) {
      state.reasoningStreamed = true
      yield { kind: 'reasoning_delta', turnId, delta: event.delta.thinking }
    }
  }
  // tool_use_start is emitted from the assistant message (where the
  // input is fully resolved), not from `content_block_start` (which
  // ships `input: {}`). The disclosure still precedes execution:
  // the assistant message lands before canUseTool / tool invocation.
}

function* fromAssistant(
  msg: SDKAssistantMessage,
  turnId: string,
  state: AdapterState,
): Generator<ChatStreamEvent> {
  const flattened = flattenSdkMessage(msg)

  // tool_use_start events come from the shared flattener (already tagged
  // with their position in `message.content`); the `thinking` fallback is
  // an adapter-only concern (see sdk-message-flatten.ts) so it's still
  // walked locally here. Both are merged back into original block order —
  // extended-thinking messages typically emit `thinking` before `tool_use`,
  // but nothing should rely on that; reconstruct it explicitly.
  type Ordered = { index: number; event: ChatStreamEvent }
  const ordered: Ordered[] = flattened.toolUseBlocks.map(
    (tu): Ordered => ({
      index: tu.index,
      event: { kind: 'tool_use_start', turnId, toolUseId: tu.id, name: tu.name, input: tu.input },
    }),
  )

  if (!state.reasoningStreamed) {
    const blocks = (msg.message?.content ?? []) as Array<{ type?: string; thinking?: string }>
    blocks.forEach((block, index) => {
      // Fallback for non-streaming / summarized thinking: if the assistant
      // message carries a `thinking` block but no `thinking_delta` partials
      // streamed it, emit the whole thing once so the reasoning still shows.
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        ordered.push({ index, event: { kind: 'reasoning_delta', turnId, delta: block.thinking } })
      }
    })
  }

  ordered.sort((a, b) => a.index - b.index)
  for (const { event } of ordered) {
    yield event
  }
}

function* fromUser(
  msg: SDKUserMessage,
  turnId: string,
): Generator<ChatStreamEvent> {
  const flattened = flattenSdkMessage(msg)
  for (const result of flattened.toolResults) {
    yield {
      kind: 'tool_result',
      turnId,
      toolUseId: result.toolUseId,
      ok: result.ok,
      output: result.output,
      error: result.error,
    }
  }
}

function* fromResult(
  msg: SDKResultMessage,
  turnId: string,
): Generator<ChatStreamEvent> {
  const inputTokens = msg.usage?.input_tokens ?? 0
  const outputTokens = msg.usage?.output_tokens ?? 0
  // Phase 4: cache-token telemetry. The SDK reports both numbers
  // separately on usage. cache_read_input_tokens is disjoint from
  // input_tokens (a cached token is not counted as an input one),
  // so the UI should display them as additive context.
  const cacheCreationInputTokens =
    typeof msg.usage?.cache_creation_input_tokens === 'number'
      ? msg.usage.cache_creation_input_tokens
      : undefined
  const cacheReadInputTokens =
    typeof msg.usage?.cache_read_input_tokens === 'number'
      ? msg.usage.cache_read_input_tokens
      : undefined
  if (
    inputTokens > 0 ||
    outputTokens > 0 ||
    (cacheCreationInputTokens ?? 0) > 0 ||
    (cacheReadInputTokens ?? 0) > 0
  ) {
    yield {
      kind: 'usage',
      turnId,
      inputTokens,
      outputTokens,
      ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    }
  }
  if (msg.subtype === 'success') {
    yield {
      kind: 'turn_complete',
      turnId,
      stopReason: 'end_turn',
      vendorStopReason: msg.stop_reason ?? undefined,
    }
    return
  }
  const reason =
    (msg.errors && msg.errors.length > 0 ? msg.errors.join('; ') : null) ??
    `SDK turn ended with subtype '${msg.subtype}'`
  yield { kind: 'error', turnId, reason }
  yield {
    kind: 'turn_complete',
    turnId,
    stopReason: 'error',
    vendorStopReason: msg.stop_reason ?? undefined,
  }
}

function* fromSystem(
  msg: { type: 'system' } & Record<string, unknown>,
  turnId: string,
): Generator<ChatStreamEvent> {
  // Phase 5 follow-up — surface SDK api_retry events as transparency
  // signal. The SDK emits these whenever it retries a transient
  // error (HTTP 429, network timeout, 5xx). Most-common case is a
  // rate-limit retry; the `errorStatus === 429` discriminator lets
  // the UI tighten its messaging in that branch.
  if (msg.subtype === 'api_retry') {
    yield* fromApiRetry(msg)
    return
  }
  if (msg.subtype !== 'permission_denied') return
  // SDKPermissionDeniedMessage carries `tool_name`, `tool_use_id`,
  // and an optional decision_reason. Synthesize a failed
  // tool_result so the UI renders the denial alongside the
  // tool_use disclosure it already emitted on the partial-stream
  // path.
  const toolUseId = msg.tool_use_id
  if (typeof toolUseId !== 'string') return
  const reason =
    (typeof msg.decision_reason === 'string' && msg.decision_reason.length > 0
      ? msg.decision_reason
      : null) ?? `Permission denied for tool '${msg.tool_name ?? 'unknown'}'`
  yield {
    kind: 'tool_result',
    turnId,
    toolUseId,
    ok: false,
    error: reason,
  }
}

/**
 * Phase 5 follow-up — parse the SDKAPIRetryMessage shape into an
 * `api_retry` SSE event. Defensive: validate each field at runtime
 * (don't blindly trust the SDK's compile-time types) because a
 * future SDK version could drop or rename fields, and dropping a
 * malformed message into the stream is safer than crashing the
 * adapter mid-turn.
 *
 * **SDK round-1 codex finding #4 fix:** previously `attempt` and
 * `max_retries` fell back to `0` when malformed/missing, which let
 * the UI render "(0/0)" — meaningless to the user. Now require
 * both to be positive integers; drop the message otherwise. The
 * `(0/0)` shape was the only signal the SDK type drift could
 * produce that wouldn't be visibly broken to a reader.
 */
function* fromApiRetry(
  msg: Record<string, unknown>,
): Generator<ChatStreamEvent> {
  const retryDelayMs = msg.retry_delay_ms
  if (typeof retryDelayMs !== 'number' || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    return
  }
  const attempt = msg.attempt
  const maxRetries = msg.max_retries
  if (
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt <= 0 ||
    typeof maxRetries !== 'number' ||
    !Number.isInteger(maxRetries) ||
    maxRetries <= 0
  ) {
    return
  }
  // `error_status` is documented as `number | null` (null for
  // non-HTTP errors). Treat anything non-number as null defensively.
  const errorStatus =
    typeof msg.error_status === 'number' && Number.isFinite(msg.error_status)
      ? msg.error_status
      : null
  yield {
    kind: 'api_retry',
    retryDelayMs,
    attempt,
    maxRetries,
    errorStatus,
  }
}

/**
 * Phase 5 follow-up — parse the SDKRateLimitEvent shape into a
 * `rate_limit_warning` SSE event.
 *
 * **SDK round-1 codex finding #1 fix:** previously this dropped
 * `status === 'rejected'` on the assumption that the SDK throw +
 * classifier path covered it. Codex pointed out that's not
 * guaranteed — the SDK type explicitly carries `resetsAt` on
 * rejected, and there's no contract preserving equivalent timing
 * through the thrown-error path. We now emit the event for both
 * `allowed_warning` AND `rejected`, with a `status` discriminator
 * the UI uses to pick render copy.
 *
 * **SDK round-1 codex finding #2 fix:** also handle the overage
 * credit-pool fields. claude.ai subscriptions track base rate
 * limit + overage independently — a user can be `allowed` on base
 * but in overage `allowed_warning`. The event carries both
 * signals; `status` reflects the more-severe of the two so the
 * UI's primary copy reflects user-facing reality.
 *
 * `resetsAt` preserved as epoch ms; `utilization` clamped to
 * [0, 1] (SDK drift defense).
 */
function* fromRateLimitEvent(
  msg: Record<string, unknown>,
): Generator<ChatStreamEvent> {
  const info = msg.rate_limit_info
  if (!info || typeof info !== 'object') return
  const i = info as Record<string, unknown>
  // Validate the discriminator fields once so the per-branch logic
  // is easier to read.
  const baseStatus =
    i.status === 'allowed_warning' || i.status === 'rejected' ? i.status : null
  const overageStatus =
    i.overageStatus === 'allowed_warning' || i.overageStatus === 'rejected'
      ? i.overageStatus
      : null
  // Emit when EITHER signal is non-allowed. `status === 'allowed'`
  // + no overage signal is the steady-state — nothing to say.
  if (baseStatus === null && overageStatus === null) return
  // The event's primary `status` reflects the more-severe of the
  // two so the UI's primary banner copy matches user-facing
  // reality. If both are present, `rejected` outranks
  // `allowed_warning`; otherwise the non-null one wins.
  const effectiveStatus: 'allowed_warning' | 'rejected' =
    baseStatus === 'rejected' || overageStatus === 'rejected'
      ? 'rejected'
      : 'allowed_warning'
  // Codex finding #4 — clamp utilization to [0, 1]. SDK drift could
  // produce 1.5 or -0.2 and the UI would render "150%" / "-20%".
  let utilization: number | undefined
  if (typeof i.utilization === 'number' && Number.isFinite(i.utilization)) {
    utilization = Math.max(0, Math.min(1, i.utilization))
  }
  const event: ChatStreamEvent = {
    kind: 'rate_limit_warning',
    status: effectiveStatus,
    ...(typeof i.rateLimitType === 'string' ? { rateLimitType: i.rateLimitType } : {}),
    ...(typeof i.resetsAt === 'number' && Number.isFinite(i.resetsAt)
      ? { resetsAt: i.resetsAt }
      : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    // Only carry the overage fields when overage itself is the
    // signal (or contributes to the picture independent of base).
    ...(overageStatus !== null ? { overageStatus } : {}),
    ...(overageStatus !== null &&
    typeof i.overageResetsAt === 'number' &&
    Number.isFinite(i.overageResetsAt)
      ? { overageResetsAt: i.overageResetsAt }
      : {}),
  }
  yield event
}

