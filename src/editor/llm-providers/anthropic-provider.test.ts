/**
 * Contract tests for the Anthropic LLMProvider impl. Validates the
 * vendor-neutral → Anthropic SDK translation at the boundary so future
 * provider impls (OpenAI/Codex) can rely on the same neutral contract.
 *
 * Covers:
 *   - string system + string user → straight pass-through
 *   - TextBlock[] system + TextBlock[] user → `cache_control: ephemeral`
 *     re-attached on blocks carrying `cacheHint: 'ephemeral'`
 *   - responseFormat: 'json_schema' → `output_config.format.json_schema`
 *   - JSON parsing of the response into `parsed`
 *   - Parse failure leaves `parsed` undefined (caller decides how to
 *     surface the raw text)
 *   - Stop-reason mapping
 *   - Abort-signal propagation
 */

import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from './anthropic-provider'
import type { ProviderEvent } from './types'

interface CapturedCall {
  params: Parameters<Anthropic['messages']['create']>[0]
  options: Parameters<Anthropic['messages']['create']>[1]
}

function makeStubClient(
  responseOverrides: Partial<Anthropic.Messages.Message> = {},
): { client: Anthropic; calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const create = vi.fn(
    async (
      params: Parameters<Anthropic['messages']['create']>[0],
      options?: Parameters<Anthropic['messages']['create']>[1],
    ) => {
      calls.push({ params, options })
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 34 },
        ...responseOverrides,
      } as unknown as Anthropic.Messages.Message
    },
  )
  return {
    client: { messages: { create } } as unknown as Anthropic,
    calls,
  }
}

async function* makeStreamFromEvents(
  events: unknown[],
): AsyncIterable<unknown> {
  for (const ev of events) yield ev
}

function makeStreamingClient(events: unknown[]): {
  client: Anthropic
  calls: Array<{
    params: Parameters<Anthropic['messages']['create']>[0]
    options: Parameters<Anthropic['messages']['create']>[1]
  }>
} {
  const calls: Array<{
    params: Parameters<Anthropic['messages']['create']>[0]
    options: Parameters<Anthropic['messages']['create']>[1]
  }> = []
  const create = vi.fn(
    async (
      params: Parameters<Anthropic['messages']['create']>[0],
      options?: Parameters<Anthropic['messages']['create']>[1],
    ) => {
      calls.push({ params, options })
      return makeStreamFromEvents(events) as unknown as ReturnType<
        Anthropic['messages']['create']
      >
    },
  )
  return {
    client: { messages: { create } } as unknown as Anthropic,
    calls,
  }
}

describe('AnthropicProvider.streamConversation', () => {
  it('emits text_delta events as text deltas arrive and reassembles into the final message', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const collected: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })) {
      collected.push(ev)
    }

    const textDeltas = collected.filter((e) => e.kind === 'text_delta')
    expect(textDeltas).toEqual([
      { kind: 'text_delta', delta: 'Hel' },
      { kind: 'text_delta', delta: 'lo' },
    ])
    const complete = collected.find((e) => e.kind === 'message_complete')
    expect(complete).toBeDefined()
    if (complete?.kind !== 'message_complete') return
    expect(complete.stopReason).toBe('end_turn')
    expect(complete.message.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(complete.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('reassembles a tool_use block from input_json_delta and emits a single tool_use event with parsed input', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'get_selection', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"sel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ector":"#btn"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const collected: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'find me the button' }],
      tools: [
        {
          name: 'get_selection',
          description: 'Get current selection',
          inputSchema: { type: 'object', properties: { selector: { type: 'string' } } },
        },
      ],
    })) {
      collected.push(ev)
    }

    // Tool input is parsed only at content_block_stop — there should
    // be exactly one tool_use event for this block.
    const toolUses = collected.filter((e) => e.kind === 'tool_use')
    expect(toolUses).toHaveLength(1)
    if (toolUses[0]?.kind !== 'tool_use') return
    expect(toolUses[0].id).toBe('tu_1')
    expect(toolUses[0].name).toBe('get_selection')
    expect(toolUses[0].input).toEqual({ selector: '#btn' })

    const complete = collected.find((e) => e.kind === 'message_complete')
    if (complete?.kind !== 'message_complete') return
    expect(complete.stopReason).toBe('tool_use')
    expect(complete.message.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'get_selection', input: { selector: '#btn' } },
    ])
  })

  it('preserves interleaved text and tool_use blocks in stream order', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_a', name: 'get_selection', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const collected: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'get_selection',
          description: '',
          inputSchema: { type: 'object' },
        },
      ],
    })) {
      collected.push(ev)
    }

    const complete = collected.find((e) => e.kind === 'message_complete')
    if (complete?.kind !== 'message_complete') return
    expect(complete.message.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'tu_a', name: 'get_selection', input: {} },
    ])
  })

  it('translates tools[] inputSchema as JSON Schema directly into Anthropic input_schema', async () => {
    const events = [
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    const { client, calls } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    const stream = provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: schema }],
    })
    // Drain the stream.
    for await (const _ of stream) void _

    const params = calls[0].params as unknown as {
      tools: Array<{ name: string; description: string; input_schema: unknown }>
      stream: boolean
    }
    expect(params.stream).toBe(true)
    expect(params.tools).toEqual([
      { name: 'read_file', description: 'Read a file', input_schema: schema },
    ])
  })

  it('maps tool_result content blocks back into the Anthropic shape', async () => {
    const events = [
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    const { client, calls } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const stream = provider.streamConversation({
      system: 's',
      messages: [
        { role: 'user', content: 'find me the button' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_selection', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tu_1',
              content: 'selector=#btn',
              isError: false,
            },
          ],
        },
      ],
      tools: [{ name: 'get_selection', description: '', inputSchema: {} }],
    })
    for await (const _ of stream) void _

    const params = calls[0].params as unknown as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(params.messages).toHaveLength(3)
    const toolResultMsg = params.messages[2]
    expect(toolResultMsg.role).toBe('user')
    expect(toolResultMsg.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'selector=#btn',
        is_error: false,
      },
    ])
  })

  it('reassembles content blocks in source-order (by index), not stop-arrival order', async () => {
    // Two blocks: index 0 (text) and index 1 (tool_use). Anthropic
    // may emit content_block_stop for index 1 BEFORE index 0 when
    // the SDK is processing in parallel. Verify we still produce the
    // assistant message in [text, tool_use] order.
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_b', name: 'get_selection', input: {} } },
      // Tool_use deltas + stop FIRST.
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 1 },
      // Text deltas + stop AFTER.
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })
    let final: ProviderEvent | undefined
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'get_selection', description: '', inputSchema: {} }],
    })) {
      if (ev.kind === 'message_complete') final = ev
    }
    if (final?.kind !== 'message_complete') throw new Error('expected message_complete')
    // Sorted by index: text (0) first, then tool_use (1).
    expect(final.message.content.map((c) => c.type)).toEqual([
      'text',
      'tool_use',
    ])
  })

  it('emits message_complete with stopReason error and empty content when aborted post-stream', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })
    const controller = new AbortController()
    controller.abort()
    let final: ProviderEvent | undefined
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      signal: controller.signal,
    })) {
      if (ev.kind === 'message_complete') final = ev
    }
    if (final?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(final.stopReason).toBe('error')
    expect(final.vendorStopReason).toBe('aborted')
    expect(final.message.content).toEqual([])
  })

  it('marks malformed tool input JSON with __parseError instead of crashing', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_x', name: 'get_selection', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"opening' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]
    const { client } = makeStreamingClient(events)
    const provider = new AnthropicProvider({ client })

    const collected: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get_selection', description: '', inputSchema: {} }],
    })) {
      collected.push(ev)
    }
    const tu = collected.find((e) => e.kind === 'tool_use')
    if (tu?.kind !== 'tool_use') throw new Error('expected tool_use')
    expect((tu.input as Record<string, unknown>).__parseError).toBe('{"opening')
  })
})

describe('AnthropicProvider.complete', () => {
  it('passes string system + string user straight through', async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({ client })

    await provider.complete({
      system: 'sys',
      user: 'hello',
      maxTokens: 100,
    })

    expect(calls.length).toBe(1)
    const params = calls[0].params as unknown as {
      system: unknown
      messages: Array<{ role: string; content: unknown }>
      max_tokens: number
    }
    expect(params.system).toBe('sys')
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0].role).toBe('user')
    expect(params.messages[0].content).toBe('hello')
    expect(params.max_tokens).toBe(100)
  })

  it('translates TextBlock[] with cacheHint into cache_control: ephemeral', async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({ client })

    await provider.complete({
      system: [
        { type: 'text', text: 'stable', cacheHint: 'ephemeral' },
        { type: 'text', text: 'volatile' },
      ],
      user: [
        { type: 'text', text: 'context', cacheHint: 'ephemeral' },
        { type: 'text', text: 'question' },
      ],
    })

    const params = calls[0].params as unknown as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>
      messages: Array<{
        role: string
        content: Array<{ type: string; text: string; cache_control?: { type: string } }>
      }>
    }
    expect(params.system).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile' },
    ])
    expect(params.messages[0].content).toEqual([
      { type: 'text', text: 'context', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'question' },
    ])
  })

  it("sets output_config.format = 'json_schema' when responseFormat is json_schema", async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({ client })
    const schema = {
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    }

    await provider.complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema },
    })

    const params = calls[0].params as unknown as {
      output_config?: { format: { type: string; schema: unknown } }
    }
    expect(params.output_config).toBeDefined()
    expect(params.output_config!.format.type).toBe('json_schema')
    expect(params.output_config!.format.schema).toEqual(schema)
  })

  it('parses JSON when responseFormat is json_schema and response is valid', async () => {
    const { client } = makeStubClient({
      content: [
        { type: 'text', text: '{"answer":42}' },
      ] as Anthropic.Messages.Message['content'],
    })
    const provider = new AnthropicProvider({ client })

    const result = await provider.complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: {} },
    })

    expect(result.text).toBe('{"answer":42}')
    expect(result.parsed).toEqual({ answer: 42 })
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('leaves parsed undefined on malformed JSON without throwing', async () => {
    const { client } = makeStubClient({
      content: [
        { type: 'text', text: '{"oops":' },
      ] as Anthropic.Messages.Message['content'],
    })
    const provider = new AnthropicProvider({ client })

    const result = await provider.complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: {} },
    })

    expect(result.text).toBe('{"oops":')
    expect(result.parsed).toBeUndefined()
  })

  it('returns text without parsed for plain (no responseFormat) requests', async () => {
    const { client } = makeStubClient({
      content: [
        { type: 'text', text: 'plain response' },
      ] as Anthropic.Messages.Message['content'],
    })
    const provider = new AnthropicProvider({ client })

    const result = await provider.complete({ system: 's', user: 'u' })

    expect(result.text).toBe('plain response')
    expect(result.parsed).toBeUndefined()
  })

  it('maps known Anthropic stop_reasons to neutral StopReason', async () => {
    const cases: Array<[string, string]> = [
      ['end_turn', 'end_turn'],
      ['max_tokens', 'max_tokens'],
      ['stop_sequence', 'stop_sequence'],
      ['tool_use', 'tool_use'],
      ['refusal', 'refusal'],
      ['pause_turn', 'pause_turn'],
      ['unknown_reason', 'error'],
    ]
    for (const [input, expected] of cases) {
      const { client } = makeStubClient({
        stop_reason: input as Anthropic.Messages.Message['stop_reason'],
      })
      const provider = new AnthropicProvider({ client })
      const result = await provider.complete({ system: 's', user: 'u' })
      expect(result.stopReason).toBe(expected)
    }
  })

  it('forwards AbortSignal to the SDK call', async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({ client })
    const controller = new AbortController()

    await provider.complete({ system: 's', user: 'u', signal: controller.signal })

    expect(calls[0].options?.signal).toBe(controller.signal)
  })

  it('falls back to defaultModel when caller omits model', async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({
      client,
      defaultModel: 'pinned-default',
    })
    await provider.complete({ system: 's', user: 'u' })
    const params = calls[0].params as unknown as { model: string }
    expect(params.model).toBe('pinned-default')
  })

  it('uses the explicit model when caller provides one', async () => {
    const { client, calls } = makeStubClient()
    const provider = new AnthropicProvider({
      client,
      defaultModel: 'pinned-default',
    })
    await provider.complete({
      system: 's',
      user: 'u',
      model: 'claude-opus-4-7',
    })
    const params = calls[0].params as unknown as { model: string }
    expect(params.model).toBe('claude-opus-4-7')
  })
})
