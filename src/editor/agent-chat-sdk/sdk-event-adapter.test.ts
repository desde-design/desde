import { describe, expect, it } from 'vitest'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import {
  adaptSdkMessageToChatEvents,
  createSdkEventAdapter,
} from './sdk-event-adapter'

function collect(msg: SDKMessage): ChatStreamEvent[] {
  return [...adaptSdkMessageToChatEvents(msg, 'turn-1')]
}

describe('adaptSdkMessageToChatEvents', () => {
  it('emits text_delta for partial-message text deltas', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      { kind: 'text_delta', turnId: 'turn-1', delta: 'hello' },
    ])
  })

  it('skips empty text deltas', () => {
    const msg = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([])
  })

  it('ignores non-text content_block_delta events', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"foo' },
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([])
  })

  it('emits reasoning_delta for partial-message thinking deltas', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'let me think' },
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      { kind: 'reasoning_delta', turnId: 'turn-1', delta: 'let me think' },
    ])
  })

  it('skips empty thinking deltas', () => {
    const msg = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([])
  })

  it('emits reasoning_delta from a final assistant thinking block (non-streaming fallback)', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'summarized reasoning', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
    } as unknown as SDKMessage
    // Fresh state (no prior streamed deltas) → the block is emitted as reasoning.
    expect(collect(msg)).toEqual([
      { kind: 'reasoning_delta', turnId: 'turn-1', delta: 'summarized reasoning' },
    ])
  })

  it('emits tool_use_start for assistant tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: "I'll read this." },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'X.vue' } },
        ],
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      {
        kind: 'tool_use_start',
        turnId: 'turn-1',
        toolUseId: 'tu_1',
        name: 'Read',
        input: { file_path: 'X.vue' },
      },
    ])
  })

  it('emits tool_result for user tool_result content blocks', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file contents',
            is_error: false,
          },
        ],
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      {
        kind: 'tool_result',
        turnId: 'turn-1',
        toolUseId: 'tu_1',
        ok: true,
        output: 'file contents',
        error: undefined,
      },
    ])
  })

  it('marks tool_result with is_error as failure', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'denied',
            is_error: true,
          },
        ],
      },
    } as unknown as SDKMessage
    const events = collect(msg)
    expect(events).toEqual([
      {
        kind: 'tool_result',
        turnId: 'turn-1',
        toolUseId: 'tu_1',
        ok: false,
        output: undefined,
        error: 'denied',
      },
    ])
  })

  it('emits tool_result from top-level tool_use_result + parent_tool_use_id (SF3)', () => {
    const msg = {
      type: 'user',
      message: { content: [] },
      tool_use_result: { stdout: 'hi', code: 0 },
      parent_tool_use_id: 'tu_2',
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      {
        kind: 'tool_result',
        turnId: 'turn-1',
        toolUseId: 'tu_2',
        ok: true,
        output: { stdout: 'hi', code: 0 },
        error: undefined,
      },
    ])
  })

  it('does not double-emit when content tool_result and top-level both refer to same id', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_3', content: 'ok', is_error: false },
        ],
      },
      tool_use_result: 'fallback',
      parent_tool_use_id: 'tu_3',
    } as unknown as SDKMessage
    const events = collect(msg)
    expect(events).toHaveLength(1)
    expect((events[0] as { toolUseId: string }).toolUseId).toBe('tu_3')
  })

  it('emits usage + turn_complete on success result', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1000, output_tokens: 200 },
      stop_reason: 'end_turn',
      total_cost_usd: 0.05,
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      { kind: 'usage', turnId: 'turn-1', inputTokens: 1000, outputTokens: 200 },
      { kind: 'turn_complete', turnId: 'turn-1', stopReason: 'end_turn', vendorStopReason: 'end_turn' },
    ])
  })

  it('emits error + turn_complete on error result', () => {
    const msg = {
      type: 'result',
      subtype: 'error_max_budget_usd',
      usage: { input_tokens: 10, output_tokens: 0 },
      stop_reason: null,
      errors: ['budget exceeded'],
      total_cost_usd: 1.5,
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      { kind: 'usage', turnId: 'turn-1', inputTokens: 10, outputTokens: 0 },
      { kind: 'error', turnId: 'turn-1', reason: 'budget exceeded' },
      { kind: 'turn_complete', turnId: 'turn-1', stopReason: 'error' },
    ])
  })

  it('falls back to a generic error reason when errors array is empty', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: null,
    } as unknown as SDKMessage
    const events = collect(msg)
    const err = events.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    expect((err as { reason: string }).reason).toMatch(/error_during_execution/)
  })

  it('ignores other message types', () => {
    expect(
      collect({ type: 'system', subtype: 'init' } as unknown as SDKMessage),
    ).toEqual([])
  })

  // ── Phase 4 ─────────────────────────────────────────────────────

  it('ignores content_block_start partials for tool_use (input lands on assistant message)', () => {
    const msg = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_X', name: 'Edit', input: {} },
      },
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([])
  })

  it('emits usage with cache fields when SDK reports them (Phase 4)', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 8000,
      },
      stop_reason: 'end_turn',
    } as unknown as SDKMessage
    const events = collect(msg)
    const usage = events.find((e) => e.kind === 'usage') as Extract<
      ChatStreamEvent,
      { kind: 'usage' }
    >
    expect(usage.cacheCreationInputTokens).toBe(500)
    expect(usage.cacheReadInputTokens).toBe(8000)
  })

  it('synthesizes a failed tool_result for permission_denied (Phase 4)', () => {
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Write',
      tool_use_id: 'tu_denied',
      decision_reason: 'classifier auto-deny',
    } as unknown as SDKMessage
    expect(collect(msg)).toEqual([
      {
        kind: 'tool_result',
        turnId: 'turn-1',
        toolUseId: 'tu_denied',
        ok: false,
        error: 'classifier auto-deny',
      },
    ])
  })

  it('falls back on a generic permission_denied reason when SDK omits decision_reason', () => {
    const msg = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'tu_b',
    } as unknown as SDKMessage
    const events = collect(msg)
    expect(events).toHaveLength(1)
    expect((events[0] as { error: string }).error).toMatch(/Permission denied/)
  })

  // ── Phase 5 follow-up: SDK structured rate-limit surfacing ──────

  it('emits api_retry for SDKAPIRetryMessage with retry_delay_ms', () => {
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 1500,
      error_status: 429,
      error: { type: 'error', message: 'rate_limit_error' },
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage
    const events = collect(msg)
    expect(events).toEqual([
      {
        kind: 'api_retry',
        retryDelayMs: 1500,
        attempt: 2,
        maxRetries: 5,
        errorStatus: 429,
      },
    ])
  })

  it('emits api_retry with errorStatus: null for non-HTTP retries (network timeout)', () => {
    const msg = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 500,
      error_status: null,
      error: { type: 'error', message: 'ETIMEDOUT' },
    } as unknown as SDKMessage
    const events = collect(msg)
    expect(events).toHaveLength(1)
    expect((events[0] as { errorStatus: number | null }).errorStatus).toBeNull()
  })

  it('drops api_retry messages with missing/malformed retry_delay_ms (defensive)', () => {
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 5,
      } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: -1,
      } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 'soon',
      } as unknown as SDKMessage),
    ).toEqual([])
  })

  it('drops api_retry when attempt/max_retries are 0 or missing (codex round-1 #4)', () => {
    // Codex round-1 #4: previously these fell back to 0, letting
    // the UI render "(0/0)" — meaningless and misleading. Now we
    // require positive integers; drop the message otherwise.
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 1500,
        attempt: 0,
        max_retries: 5,
      } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 1500,
        attempt: 2,
        max_retries: 0,
      } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 1500,
      } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 1500,
        attempt: 1.5,
        max_retries: 5,
      } as unknown as SDKMessage),
    ).toEqual([])
  })

  it('emits rate_limit_warning on rate_limit_event with status="allowed_warning"', () => {
    const allowedWarning = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        resetsAt: 1748100000000,
        rateLimitType: 'five_hour',
        utilization: 0.85,
      },
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage
    expect(collect(allowedWarning)).toEqual([
      {
        kind: 'rate_limit_warning',
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        resetsAt: 1748100000000,
        utilization: 0.85,
      },
    ])
  })

  it('emits rate_limit_warning with status="rejected" on rate_limit_event with status="rejected" (codex round-1 #1)', () => {
    // Previously we dropped rejected on the assumption the SDK
    // throw + classifier path would cover it. Codex correctly
    // pointed out the SDK type explicitly carries resetsAt on
    // rejected; the thrown error may not preserve that timing.
    // Surface the rejected status with its structured timing here
    // so the shell sees it BEFORE any classifier fallback.
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1748100000000 },
      } as unknown as SDKMessage),
    ).toEqual([
      {
        kind: 'rate_limit_warning',
        status: 'rejected',
        resetsAt: 1748100000000,
      },
    ])
  })

  it('drops rate_limit_event with status="allowed" AND no overage signal (steady-state)', () => {
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed' },
      } as unknown as SDKMessage),
    ).toEqual([])
  })

  it('emits when base is allowed but overage is allowed_warning (codex round-1 #2)', () => {
    // claude.ai tracks base rate limit + overage credit pool
    // independently. A user can be allowed on base but in overage
    // warning — we should surface that.
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          overageStatus: 'allowed_warning',
          overageResetsAt: 1748200000000,
        },
      } as unknown as SDKMessage),
    ).toEqual([
      {
        kind: 'rate_limit_warning',
        status: 'allowed_warning',
        overageStatus: 'allowed_warning',
        overageResetsAt: 1748200000000,
      },
    ])
  })

  it('escalates status to "rejected" when overage is rejected even if base is allowed', () => {
    // The event's primary status reflects the more-severe of the
    // two so the UI's banner copy matches user-facing reality.
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          overageStatus: 'rejected',
          overageResetsAt: 1748200000000,
        },
      } as unknown as SDKMessage),
    ).toEqual([
      {
        kind: 'rate_limit_warning',
        status: 'rejected',
        overageStatus: 'rejected',
        overageResetsAt: 1748200000000,
      },
    ])
  })

  it('clamps utilization > 1 to 1 (SDK drift defense)', () => {
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', utilization: 1.5 },
      } as unknown as SDKMessage),
    ).toEqual([
      { kind: 'rate_limit_warning', status: 'allowed_warning', utilization: 1 },
    ])
  })

  it('clamps utilization < 0 to 0 (SDK drift defense)', () => {
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning', utilization: -0.2 },
      } as unknown as SDKMessage),
    ).toEqual([
      { kind: 'rate_limit_warning', status: 'allowed_warning', utilization: 0 },
    ])
  })

  it('drops rate_limit_event when rate_limit_info is malformed', () => {
    expect(
      collect({ type: 'rate_limit_event' } as unknown as SDKMessage),
    ).toEqual([])
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: 'not-an-object',
      } as unknown as SDKMessage),
    ).toEqual([])
  })

  it('rate_limit_warning omits optional fields when SDK does not supply them', () => {
    expect(
      collect({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed_warning' },
      } as unknown as SDKMessage),
    ).toEqual([{ kind: 'rate_limit_warning', status: 'allowed_warning' }])
  })
})

describe('createSdkEventAdapter', () => {
  it('emits tool_use_start once from the assistant message with resolved input', () => {
    const adapter = createSdkEventAdapter('turn-1')
    const partial = {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'Edit', input: {} },
      },
    } as unknown as SDKMessage
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Edit', input: { file_path: 'X.vue' } },
        ],
      },
    } as unknown as SDKMessage

    const partialEvents = [...adapter.adapt(partial)]
    const assistantEvents = [...adapter.adapt(assistant)]

    // The content_block_start partial carries input: {} — we ignore
    // it and wait for the resolved input on the assistant message.
    expect(partialEvents).toEqual([])
    expect(assistantEvents).toHaveLength(1)
    expect(assistantEvents[0]).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'tu_1',
      input: { file_path: 'X.vue' },
    })
  })

  it('does NOT re-emit the final thinking block when reasoning already streamed (dedup)', () => {
    const adapter = createSdkEventAdapter('turn-1')
    const partial = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'streamed thought' },
      },
    } as unknown as SDKMessage
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'streamed thought', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
    } as unknown as SDKMessage

    const partialEvents = [...adapter.adapt(partial)]
    const assistantEvents = [...adapter.adapt(assistant)]

    expect(partialEvents).toEqual([
      { kind: 'reasoning_delta', turnId: 'turn-1', delta: 'streamed thought' },
    ])
    // The streaming path already covered it — the block must NOT re-emit.
    expect(assistantEvents.some((e) => e.kind === 'reasoning_delta')).toBe(false)
  })

  it('emits tool_use_start from assistant message when no partial arrived', () => {
    const adapter = createSdkEventAdapter('turn-1')
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'X.vue' } },
        ],
      },
    } as unknown as SDKMessage
    const events = [...adapter.adapt(assistant)]
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'tool_use_start',
      toolUseId: 'tu_2',
      input: { file_path: 'X.vue' },
    })
  })
})
