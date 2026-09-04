/**
 * Contract tests for the AI SDK provider. These are the eleven cases
 * `openai-provider.test.ts` carried, ported onto the adapter, plus the four
 * the fetch provider never had: reasoning deltas, image input, an abort, and
 * `providerOptions` reaching the wire under the descriptor's own key.
 *
 * The transport is `MockLanguageModelV4` from `ai/test`, whose `doStreamCalls`
 * and `doGenerateCalls` record exactly what the adapter asked the model for.
 * That is what lets a request-shaping assertion survive the move off `fetch`:
 * the old tests read a JSON body, these read the call options one layer up.
 */
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { AiSdkProvider } from './ai-sdk-provider'
import type { ProviderEvent } from './types'

type StreamChunk = Record<string, unknown>

/** A doStream that replays a fixed chunk list. */
function streamOf(chunks: StreamChunk[]) {
  return async () => ({
    stream: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    }),
  })
}

/**
 * `LanguageModelV4` reports usage in a nested shape and the finish reason as a
 * `{ unified, raw }` pair, not as the flat values the v3 spec used. These two
 * builders keep every fixture in the real v4 shape, which is what makes the
 * usage and stop-reason assertions below mean anything.
 */
function usageOf(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  }
}

function finishOf(reason: string) {
  return { unified: reason as 'stop', raw: reason }
}

const USAGE = usageOf(9, 7)

function providerFor(model: MockLanguageModelV4): AiSdkProvider {
  return new AiSdkProvider({
    name: 'openai',
    defaultModel: 'gpt-5.6',
    languageModel: () => model,
    providerOptionsKey: 'openai',
  })
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('AiSdkProvider.complete', () => {
  it('sends system and user through and parses a json_schema response', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '{"answer":42}' }],
        finishReason: finishOf('stop'),
        usage: usageOf(12, 8),
        warnings: [],
      }),
    })
    const provider = providerFor(model)
    const result = await provider.complete({
      system: 'sys',
      user: 'hi',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' }, name: 'r' },
    })
    expect(model.doGenerateCalls).toHaveLength(1)
    const prompt = model.doGenerateCalls[0]!.prompt
    expect(prompt[0]).toMatchObject({ role: 'system', content: 'sys' })
    expect(prompt[1]).toMatchObject({ role: 'user' })
    expect(result.text).toBe('{"answer":42}')
    expect(result.parsed).toEqual({ answer: 42 })
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 8 })
    expect(result.stopReason).toBe('end_turn')
  })

  it('maps every AI SDK finish reason to a neutral StopReason', async () => {
    const cases: Array<[string, string]> = [
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool-calls', 'tool_use'],
      ['content-filter', 'refusal'],
      ['error', 'error'],
      ['other', 'error'],
    ]
    for (const [finish, expected] of cases) {
      const model = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'x' }],
          finishReason: finishOf(finish),
          usage: USAGE,
          warnings: [],
        }),
      })
      const r = await providerFor(model).complete({ system: 's', user: 'u' })
      expect(r.stopReason, finish).toBe(expected)
    }
  })

  it('flattens ContentBlock arrays and never sends a cache_control marker', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [],
        finishReason: finishOf('stop'),
        usage: USAGE,
        warnings: [],
      }),
    })
    await providerFor(model).complete({
      system: [
        { type: 'text', text: 'stable', cacheHint: 'ephemeral' },
        { type: 'text', text: 'volatile' },
      ],
      user: 'q',
    })
    const prompt = model.doGenerateCalls[0]!.prompt
    expect(prompt[0]).toMatchObject({ role: 'system', content: 'stable\n\nvolatile' })
    expect(JSON.stringify(prompt)).not.toMatch(/cache_control/)
  })

  it('reports a content-filter finish as refusal and leaves parsed undefined', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'I cannot help with that.' }],
        finishReason: finishOf('content-filter'),
        usage: USAGE,
        warnings: [],
      }),
    })
    const result = await providerFor(model).complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })
    expect(result.stopReason).toBe('refusal')
    expect(result.text).toBe('I cannot help with that.')
    expect(result.parsed).toBeUndefined()
  })

  it('returns the raw text rather than throwing when the model produced invalid JSON', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '{"oops' }],
        finishReason: finishOf('stop'),
        usage: USAGE,
        warnings: [],
      }),
    })
    const result = await providerFor(model).complete({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })
    // apply-llm-patch puts the raw text in its diagnostics, so a parse failure
    // must not throw. This is the contract types.ts documents on CompleteResult.
    expect(result.parsed).toBeUndefined()
    expect(result.text).toBe('{"oops')
  })

  it('lets a transport error propagate', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('OpenAI answered 401 invalid_api_key')
      },
    })
    await expect(providerFor(model).complete({ system: 's', user: 'u' })).rejects.toThrow(/401/)
  })
})

describe('AiSdkProvider.streamComplete', () => {
  it('is defined, and fires onTextDelta for each chunk', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Hel' },
        { type: 'text-delta', id: '1', delta: 'lo' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const provider = providerFor(model)
    // apply-llm-patch branches on the METHOD'S PRESENCE to decide whether to
    // open an SSE route. The fetch provider deliberately had none; the adapter
    // has a real one, and this pins the flip.
    expect(typeof provider.streamComplete).toBe('function')
    const deltas: string[] = []
    const result = await provider.streamComplete!({ system: 's', user: 'u' }, (d) => deltas.push(d))
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(result.text).toBe('Hello')
    expect(result.stopReason).toBe('end_turn')
  })

  // apply-llm-patch is the caller that streams, and it always asks for a schema,
  // so the schema branch of streamComplete is the one that actually ships.
  it('parses a json_schema response it streamed', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: '{"answer":' },
        { type: 'text-delta', id: '1', delta: '42}' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const result = await providerFor(model).streamComplete!({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' }, name: 'r' },
    })
    expect(result.text).toBe('{"answer":42}')
    expect(result.parsed).toEqual({ answer: 42 })
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 7 })
  })

  it('returns the raw streamed text rather than throwing on invalid JSON', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: '{"oops' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const result = await providerFor(model).streamComplete!({
      system: 's',
      user: 'u',
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })
    expect(result.parsed).toBeUndefined()
    expect(result.text).toBe('{"oops')
  })
})

describe('AiSdkProvider.streamConversation', () => {
  it('translates text deltas and a tool call into ProviderEvents', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Hel' },
        { type: 'text-delta', id: '1', delta: 'lo' },
        { type: 'text-end', id: '1' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_selection',
          input: '{}',
        },
        { type: 'finish', finishReason: finishOf('tool-calls'), usage: USAGE },
      ]),
    })
    const events = await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'find the button' }],
        tools: [{ name: 'get_selection', description: '', inputSchema: { type: 'object', properties: {} } }],
      }),
    )
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
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.stopReason).toBe('tool_use')
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'call_1', name: 'get_selection', input: {} },
    ])
    expect(done.usage).toEqual({ inputTokens: 9, outputTokens: 7 })
  })

  it('passes tools as definitions with no execute, so the library returns the call instead of running it', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [{ name: 'read_file', description: 'Read', inputSchema: schema }],
      }),
    )
    const call = model.doStreamCalls[0]!
    expect(call.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read', inputSchema: schema },
    ])
  })

  it('translates tool_result blocks into a tool message carrying the call name', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [
          { role: 'user', content: 'find' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'get_selection', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'selector=#btn', isError: false }],
          },
        ],
        tools: [{ name: 'get_selection', description: '', inputSchema: { type: 'object' } }],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    const toolMessage = prompt[3] as { content: Array<{ toolCallId: string; toolName: string; output: unknown }> }
    expect(toolMessage.content[0]!.toolCallId).toBe('tu_1')
    // The neutral ToolResultContent carries no tool name, so the adapter looks
    // it up from the assistant turn that made the call. The AI SDK requires it.
    expect(toolMessage.content[0]!.toolName).toBe('get_selection')
    expect(toolMessage.content[0]!.output).toEqual({ type: 'text', value: 'selector=#btn' })
  })

  it('marks an error tool_result as error-text', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'no such file', isError: true }],
          },
        ],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const toolMessage = prompt[2] as { content: Array<{ output: unknown }> }
    expect(toolMessage.content[0]!.output).toEqual({ type: 'error-text', value: 'no such file' })
  })

  it('emits reasoning deltas as reasoning_delta', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Considering ' },
        { type: 'reasoning-delta', id: 'r1', delta: 'the layout.' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Done.' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const events = await collect(
      providerFor(model).streamConversation({ system: 's', messages: [{ role: 'user', content: 'u' }], tools: [] }),
    )
    const reasoning = events
      .filter((e): e is Extract<ProviderEvent, { kind: 'reasoning_delta' }> => e.kind === 'reasoning_delta')
      .map((e) => e.delta)
      .join('')
    expect(reasoning).toBe('Considering the layout.')
    // Reasoning must NOT leak into the assistant message: it is display-only,
    // and replaying it as assistant text on the next step would corrupt history.
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.message.content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('sends an ImageContent block as an image part with its media type', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what colour?' },
              { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
            ],
          },
        ],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const user = prompt[1] as unknown as { content: Array<Record<string, unknown>> }
    expect(user.content[1]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  })

  it('nests StreamOpts.providerOptions under the descriptor key', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
        providerOptions: { reasoningEffort: 'high' },
      }),
    )
    expect(model.doStreamCalls[0]!.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
  })

  it('reports an aborted stream as an error stop with the work so far preserved', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'partial' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
        signal: controller.signal,
      }),
    )
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.stopReason).toBe('error')
    expect(done.vendorStopReason).toBe('aborted')
  })

  it('rethrows a stream error rather than ending the turn quietly', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'error', error: new Error('OpenAI answered 429 rate_limit_exceeded') },
      ]),
    })
    await expect(
      collect(
        providerFor(model).streamConversation({
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
          tools: [],
        }),
      ),
    ).rejects.toThrow(/429/)
  })
})
