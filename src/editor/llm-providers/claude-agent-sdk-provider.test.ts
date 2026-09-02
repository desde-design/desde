/**
 * Regression coverage for the Claude Agent SDK provider's CompleteResult
 * contract. The load-bearing case: when the SDK answers a `json_schema`
 * request via `structured_output`, the assistant `result` text is empty.
 * The provider must still satisfy the documented contract — `text` is
 * "the JSON string the model produced" for json_schema responses — by
 * synthesizing `text` from `parsed`. Without it, every consumer that
 * gates on `!result.text` before consulting `parsed` (apply-llm-patch,
 * repair-edit, agent-request, apply-iteration-data-edit) spuriously
 * rejects a good structured response with "produced no text block" —
 * the "edit didn't save" error on the no-API-key Claude-subscription
 * path, which is the CLI default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { queryMock, scriptedMessages } = vi.hoisted(() => {
  const scriptedMessages: unknown[] = []
  const queryMock = vi.fn(() => {
    return (async function* () {
      for (const m of scriptedMessages) yield m
    })()
  })
  return { queryMock, scriptedMessages }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}))

import { ClaudeAgentSdkProvider } from './claude-agent-sdk-provider'

const JSON_SCHEMA_OPTS = {
  system: 'You output JSON only.',
  user: 'Return an object with field greeting set to hello.',
  maxTokens: 200,
  responseFormat: {
    kind: 'json_schema' as const,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['greeting'],
      properties: { greeting: { type: 'string' } },
    },
  },
}

describe('ClaudeAgentSdkProvider — json_schema CompleteResult contract', () => {
  beforeEach(() => {
    scriptedMessages.length = 0
    queryMock.mockClear()
  })

  it('synthesizes text from structured_output when the result text is empty', async () => {
    // The SDK routed the answer to structured_output and left result text empty.
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      result: '',
      structured_output: { greeting: 'hello' },
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const provider = new ClaudeAgentSdkProvider({})
    const res = await provider.complete(JSON_SCHEMA_OPTS)

    expect(res.parsed).toEqual({ greeting: 'hello' })
    // Contract: text is the JSON string for json_schema responses.
    expect(res.text).toBe('{"greeting":"hello"}')
    // The consumer guard that broke things keys on truthiness of text.
    expect(res.text).toBeTruthy()
  })

  it('still parses JSON from assistant text when structured_output is absent', async () => {
    // Older SDK / model path: text carries the JSON, no structured_output.
    scriptedMessages.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '{"greeting":"hi"}' }] },
    })
    scriptedMessages.push({
      type: 'result',
      subtype: 'success',
      result: '{"greeting":"hi"}',
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 3 },
    })

    const provider = new ClaudeAgentSdkProvider({})
    const res = await provider.complete(JSON_SCHEMA_OPTS)

    expect(res.text).toBe('{"greeting":"hi"}')
    expect(res.parsed).toEqual({ greeting: 'hi' })
  })
})
