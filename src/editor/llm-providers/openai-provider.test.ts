/**
 * Contract tests for the OpenAI provider. Validates that the same
 * vendor-neutral `LLMProvider` contract the Anthropic provider
 * satisfies also works against OpenAI's wire format — without
 * changing call sites. Uses a stub `fetch` so no network access.
 */

import { describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './openai-provider'
import type { LLMProvider, ProviderEvent } from './types'

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeSseResponse(frames: string[]): Response {
  // Each frame is `data: <json>\n\n`; the function joins them and
  // exposes the bytes as a ReadableStream so the provider's parser
  // can chunk-read them.
  const text = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Chunk in two pieces to simulate streamed delivery.
      controller.enqueue(encoder.encode(text.slice(0, Math.floor(text.length / 2))))
      controller.enqueue(encoder.encode(text.slice(Math.floor(text.length / 2))))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('OpenAIProvider.complete', () => {
  it('translates messages to OpenAI chat-completions and parses the JSON response', async () => {
    const fetchImpl = vi.fn(async () =>
      makeJsonResponse({
        choices: [
          {
            message: { content: '{"answer":42}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await provider.complete({
      system: 'sys',
      user: 'hi',
      responseFormat: { kind: 'json_schema', schema: {}, name: 'r' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/v1\/chat\/completions$/)
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'r', schema: {} },
    })
    // strict is NOT forced — callers opt in by shaping their schema.
    const rf = body.response_format as { json_schema: Record<string, unknown> }
    expect(rf.json_schema.strict).toBeUndefined()
    expect(result.text).toBe('{"answer":42}')
    expect(result.parsed).toEqual({ answer: 42 })
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(result.stopReason).toBe('end_turn')
  })

  it('maps finish_reason to neutral StopReason', async () => {
    const cases: Array<[string | null, string]> = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['content_filter', 'refusal'],
      [null, 'end_turn'],
      ['weird_reason', 'error'],
    ]
    for (const [finish, expected] of cases) {
      const fetchImpl = vi.fn(async () =>
        makeJsonResponse({
          choices: [{ message: { content: 'x' }, finish_reason: finish }],
        }),
      )
      const provider = new OpenAIProvider({
        apiKey: 'sk-test',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      const r = await provider.complete({ system: 's', user: 'u' })
      expect(r.stopReason).toBe(expected)
    }
  })

  it('flattens ContentBlock arrays to a single string (no cache_control sent)', async () => {
    const fetchImpl = vi.fn(async () =>
      makeJsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      }),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await provider.complete({
      system: [
        { type: 'text', text: 'stable', cacheHint: 'ephemeral' },
        { type: 'text', text: 'volatile' },
      ],
      user: 'q',
    })
    const body = JSON.parse(
      ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string,
    ) as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages[0].content).toBe('stable\n\nvolatile')
    // No cache_control sent — OpenAI doesn't support it; we dropped it.
    expect(JSON.stringify(body)).not.toMatch(/cache_control/)
  })

  it("maps a structured-output refusal (message.refusal) to stopReason='refusal'", async () => {
    // OpenAI may return finish_reason='stop' alongside a non-null
    // refusal field — that's the structured-output decline shape.
    const fetchImpl = vi.fn(async () =>
      makeJsonResponse({
        choices: [
          {
            message: { content: null, refusal: 'I cannot help with that.' },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await provider.complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: {} },
    })
    expect(result.stopReason).toBe('refusal')
    expect(result.text).toBe('I cannot help with that.')
    expect(result.parsed).toBeUndefined()
  })

  it('throws a clear error when API key is missing', async () => {
    const provider = new OpenAIProvider({ apiKey: '' })
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toThrow(
      /missing API key/i,
    )
  })

  it('throws with status + body when the API returns a non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-bad',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.complete({ system: 's', user: 'u' })).rejects.toThrow(
      /401/,
    )
  })
})

describe('OpenAIProvider.streamConversation', () => {
  it('translates streamed text deltas + tool_calls into ProviderEvents', async () => {
    const fetchImpl = vi.fn(async () =>
      makeSseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_selection', arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 9, completion_tokens: 7 },
        }),
      ]),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const events: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'find the button' }],
      tools: [
        {
          name: 'get_selection',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })) {
      events.push(ev)
    }
    const text = events
      .filter((e): e is Extract<ProviderEvent, { kind: 'text_delta' }> => e.kind === 'text_delta')
      .map((e) => e.delta)
      .join('')
    expect(text).toBe('Hello')
    const tu = events.find((e) => e.kind === 'tool_use')
    if (tu?.kind !== 'tool_use') throw new Error('expected tool_use')
    expect(tu.id).toBe('call_1')
    expect(tu.name).toBe('get_selection')
    expect(tu.input).toEqual({})
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected complete')
    expect(done.stopReason).toBe('tool_use')
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call_1', name: 'get_selection', input: {} },
    ])
    expect(done.usage).toEqual({ inputTokens: 9, outputTokens: 7 })
  })

  it('serializes tools[] into OpenAI function-call shape', async () => {
    const fetchImpl = vi.fn(async () =>
      makeSseResponse([
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      ]),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    for await (const _ of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      tools: [{ name: 'read_file', description: 'Read', inputSchema: schema }],
    }))
      void _
    const body = JSON.parse(
      ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string,
    ) as { tools: Array<{ type: string; function: Record<string, unknown> }> }
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read', parameters: schema },
      },
    ])
  })

  it('translates tool_result content blocks back to role:"tool" messages', async () => {
    const fetchImpl = vi.fn(async () =>
      makeSseResponse([
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      ]),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    for await (const _ of provider.streamConversation({
      system: 's',
      messages: [
        { role: 'user', content: 'find' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'get_selection', input: {} }],
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
    }))
      void _
    const body = JSON.parse(
      ((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string,
    ) as { messages: Array<{ role: string; content?: string; tool_call_id?: string }> }
    // messages = [system, user-find, assistant-toolcalls, tool-result]
    expect(body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    const toolMsg = body.messages[3]
    expect(toolMsg.tool_call_id).toBe('tu_1')
    expect(toolMsg.content).toBe('selector=#btn')
  })

  it('streams delta.refusal as text and stamps stopReason=refusal at end', async () => {
    const fetchImpl = vi.fn(async () =>
      makeSseResponse([
        JSON.stringify({ choices: [{ delta: { refusal: "I can't " } }] }),
        JSON.stringify({ choices: [{ delta: { refusal: 'help with that.' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      ]),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const events: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'do bad thing' }],
      tools: [],
    })) {
      events.push(ev)
    }
    const text = events
      .filter((e): e is Extract<ProviderEvent, { kind: 'text_delta' }> => e.kind === 'text_delta')
      .map((e) => e.delta)
      .join('')
    expect(text).toBe("I can't help with that.")
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected complete')
    expect(done.stopReason).toBe('refusal')
  })

  it('marks malformed tool argument JSON with __parseError', async () => {
    const fetchImpl = vi.fn(async () =>
      makeSseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_x',
                    function: { name: 'get_selection', arguments: '{"oops' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
      ]),
    )
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const events: ProviderEvent[] = []
    for await (const ev of provider.streamConversation({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'get_selection', description: '', inputSchema: {} }],
    })) {
      events.push(ev)
    }
    const tu = events.find((e) => e.kind === 'tool_use')
    if (tu?.kind !== 'tool_use') throw new Error('expected tool_use')
    expect((tu.input as { __parseError: string }).__parseError).toBe('{"oops')
  })
})

/**
 * MEASURED contract, pinned because it is load-bearing and unguarded until
 * now: `apply-llm-patch.ts` decides SSE-vs-blocking on this method's PRESENCE,
 * and `types.ts` warns against shipping a no-op stub. An OpenAI-backed save
 * therefore shows no live tokens today, which is correct behaviour rather than
 * a bug. Phase 4 replaces this with a real Chat Completions stream and this
 * test with its inverse.
 */
describe('streamComplete is deliberately absent', () => {
  it('has no streamComplete method at all', () => {
    const provider: LLMProvider = new OpenAIProvider({})
    expect(provider.streamComplete).toBeUndefined()
  })
})
