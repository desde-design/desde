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
import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { AiSdkProvider, APICallError, RetryError } from './ai-sdk-provider'
import { anthropicServerTool } from './ai-sdk-anthropic'
import { openAiServerTool } from './ai-sdk-openai'
import { SERVER_TOOL_MAX_USES, type Message, type ProviderEvent } from './types'

/**
 * `streamText` itself, mocked so ONE test (the mid-stream abort case below)
 * can hand `ai-sdk-provider.ts` a `result.stream` built by hand, carrying an
 * explicit `{ type: 'abort' }` part. Every other test never touches this —
 * `streamTextMock`'s default implementation just delegates to the real
 * `streamText`, so `MockLanguageModelV4` keeps driving them exactly as
 * before.
 *
 * Why this is necessary at all: `{ type: 'abort' }` is not something a
 * provider's raw stream (what `MockLanguageModelV4`'s `doStream` returns)
 * can ever contain — it is SYNTHESIZED by `streamText`'s own internal
 * step/timeout orchestration when its `abortSignal` fires mid-generation.
 * Reproducing that faithfully through `MockLanguageModelV4` alone means
 * fighting undocumented internal timing (measured: a plain `pull()`-timed
 * `controller.abort()`, and even a thrown `AbortError` from the raw stream,
 * both got swallowed by that orchestration before `ai-sdk-provider.ts` ever
 * saw the partial text — the whole step gets discarded, not just the
 * chunk after the abort). `ai-sdk-provider.ts`'s OWN `case 'abort':` branch
 * is what this test exists to cover, not `streamText`'s abort machinery
 * (which is the SDK's own concern, not ours) — so this mocks exactly at
 * that boundary instead.
 */
const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  streamTextMock.mockImplementation(actual.streamText)
  return { ...actual, streamText: streamTextMock }
})

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

/**
 * Same v4 raw usage shape as `usageOf`, but with the cache-read/cache-write
 * nested fields populated. This is what `@ai-sdk/anthropic`'s
 * `convertAnthropicUsage` produces from the vendor's own
 * `cache_read_input_tokens` / `cache_creation_input_tokens` fields
 * (checked against the installed `@ai-sdk/anthropic` source): the `ai`
 * package's `streamText` then normalizes it via `asLanguageModelUsage`
 * into the `finish` stream part's `totalUsage.inputTokenDetails`
 * (`cacheReadTokens` / `cacheWriteTokens`), which is what `toUsage` reads.
 */
function usageWithCacheOf(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
) {
  return {
    inputTokens: {
      total: inputTokens + cacheRead + cacheWrite,
      noCache: inputTokens,
      cacheRead,
      cacheWrite,
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

/**
 * A stream that ANSWERS: one text delta, then a `stop` finish.
 *
 * Request-shape tests read `model.doStreamCalls` and do not care what came
 * back — but a `stop` finish carrying no content at all is now a failed step
 * (see "fails the step when the model finishes on `stop` having produced
 * nothing"), which would throw before the assertion is reached. One token of
 * text is what makes these fixtures a response rather than a silent refusal,
 * and it is what a real `stop` finish always carries.
 */
function answeredStream() {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: 'ok' },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
  ])
}

/** A response that finishes on `stop` having said nothing. The refusal shape. */
function emptyStopStream() {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
  ])
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

  it('reads cache-read and cache-creation tokens off the finish part and includes them on both usage events', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'ok' },
        { type: 'text-end', id: '1' },
        {
          type: 'finish',
          finishReason: finishOf('stop'),
          usage: usageWithCacheOf(10, 2, 1000, 500),
        },
      ]),
    })
    const events = await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
      }),
    )
    // `inputTokens` stays the NON-cached count (10), disjoint from the two
    // cache counters below — the raw v4 usage's `total` field (1510) folds
    // fresh + cache-read + cache-write together, and `toUsage` un-folds it
    // via `inputTokenDetails.noCacheTokens` so pricing never double-bills
    // a cache token once as a full-rate input token and again at the
    // cache rate.
    const usageEvent = events.find((e) => e.kind === 'usage')
    if (usageEvent?.kind !== 'usage') throw new Error('expected usage')
    expect(usageEvent).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 500,
    })
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 500,
    })
  })

  it('passes tools as definitions with no execute, so the library returns the call instead of running it', async () => {
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
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
      doStream: answeredStream(),
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
      doStream: answeredStream(),
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
    // The value is MARKED, not just typed: the Responses mapping flattens
    // `error-text` and `text` to the same `function_call_output`, so the type
    // alone does not reach the model (P3-2). Anthropic's `is_error` does
    // survive, so without this the two lanes disagreed about whether a denied
    // edit was distinguishable from an applied one.
    expect(toolMessage.content[0]!.output).toEqual({
      type: 'error-text',
      value: 'Error: no such file',
    })
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
      doStream: answeredStream(),
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

  it('sends a DocumentContent block as a file part with its filename', async () => {
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
    })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', mediaType: 'application/pdf', data: 'QUJD', name: 'a.pdf' },
            ],
          },
        ],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const user = prompt[1] as unknown as { content: Array<Record<string, unknown>> }
    expect(user.content[0]).toMatchObject({
      type: 'file',
      mediaType: 'application/pdf',
      filename: 'a.pdf',
    })
  })

  it('nests StreamOpts.providerOptions under the descriptor key', async () => {
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
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

  it('maps an ephemeral cache hint on a system block to anthropic cacheControl', async () => {
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
    })
    const provider = new AiSdkProvider({
      name: 'anthropic',
      defaultModel: 'm',
      languageModel: () => model,
      providerOptionsKey: 'anthropic',
      cacheControl: 'anthropic',
    })
    await collect(
      provider.streamConversation({
        system: [{ type: 'text', text: 'SYS', cacheHint: 'ephemeral' }],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const sys = prompt.filter((m) => m.role === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]).toMatchObject({
      role: 'system',
      content: 'SYS',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
  })

  it('drops the hint when cacheControl is not configured (OpenAI)', async () => {
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
    })
    await collect(
      providerFor(model).streamConversation({
        system: [{ type: 'text', text: 'SYS', cacheHint: 'ephemeral' }],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const sys = prompt.filter((m) => m.role === 'system')
    expect(sys).toHaveLength(1)
    expect(sys[0]).toMatchObject({ role: 'system', content: 'SYS' })
    expect((sys[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined()
  })

  it('marks only the hinted block when the system prompt has several, in order', async () => {
    // The production caller (`run-chat-turn-neutral.ts`) sends a two-block
    // system: a cache-hinted prompt block followed by an unhinted notice
    // block. `toSystem` maps EVERY block to its own `SystemModelMessage`
    // once any block is hinted, so this proves the unhinted sibling does not
    // pick up `providerOptions` by accident and that order survives the map.
    const model = new MockLanguageModelV4({
      doStream: answeredStream(),
    })
    const provider = new AiSdkProvider({
      name: 'anthropic',
      defaultModel: 'm',
      languageModel: () => model,
      providerOptionsKey: 'anthropic',
      cacheControl: 'anthropic',
    })
    await collect(
      provider.streamConversation({
        system: [
          { type: 'text', text: 'SYS', cacheHint: 'ephemeral' },
          { type: 'text', text: 'NOTICE' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    const sys = prompt.filter((m) => m.role === 'system')
    expect(sys).toHaveLength(2)
    expect(sys[0]).toMatchObject({
      role: 'system',
      content: 'SYS',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
    expect(sys[1]).toMatchObject({ role: 'system', content: 'NOTICE' })
    expect((sys[1] as { providerOptions?: unknown }).providerOptions).toBeUndefined()
  })

  it('reports an aborted stream as an error stop with the work so far preserved', async () => {
    // `controller.abort()` used to run BEFORE `streamConversation` was even
    // called, which only ever exercised the `opts.signal?.aborted` fallback
    // check AFTER the loop (kept as its own case below). The `case 'abort':`
    // branch INSIDE the loop — for a `{ type: 'abort' }` part arriving
    // mid-stream — never fired, and `done.message.content` was never
    // inspected, so the accumulated "partial" text was never actually
    // proven to survive.
    //
    // `streamTextMock` (see the top of this file) hands `ai-sdk-provider.ts`
    // a hand-built `result.stream` here: a text delta, THEN an explicit
    // `{ type: 'abort' }` part instead of `finish` — the exact shape
    // `streamText`'s own internal orchestration produces on a real
    // mid-generation abort, one layer up from anything `MockLanguageModelV4`
    // can express.
    streamTextMock.mockImplementationOnce(() => ({
      stream: (async function* () {
        yield { type: 'text-delta', id: '1', text: 'partial' }
        yield { type: 'abort' }
      })(),
    }))
    const events = await collect(
      new AiSdkProvider({
        name: 'openai',
        defaultModel: 'gpt-5.6',
        languageModel: () => new MockLanguageModelV4(),
        providerOptionsKey: 'openai',
      }).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
      }),
    )
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.stopReason).toBe('error')
    expect(done.vendorStopReason).toBe('aborted')
    // The point of the test's own name: the text generated before the abort
    // is kept, not discarded, so the transcript shows what the model had
    // said when the user pressed Stop.
    expect(done.message.content).toEqual([{ type: 'text', text: 'partial' }])
    // No `finish` part arrived, so the vendor never reported usage and the
    // provider has only zeros to give. The neutral loop reads that zero as
    // "not reported" and records an estimate (`estimate-cut-off-usage.ts`).
    expect(events.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(done.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('falls back to the post-loop signal check when the stream ends with no abort part', async () => {
    // The OTHER path `aborted` can take: the caller's signal was already
    // aborted (e.g. Stop was pressed just as the turn was being built) and
    // the stream never emits an explicit `{ type: 'abort' }` part at all —
    // it just ends normally. `opts.signal?.aborted` after the loop is what
    // still reports this as aborted rather than a clean finish.
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

  it('fails the step when the model finishes on `stop` having produced nothing', async () => {
    // A Responses `refusal` content part is not modelled by @ai-sdk/openai at
    // all: `response.refusal.delta` / `.done` are not in its chunk table, so
    // they are discarded as unknown chunks, `incomplete_details` stays null,
    // and the finish maps to `stop`. The step therefore used to complete as an
    // `end_turn` carrying an EMPTY assistant message — no text, no error, no
    // failure badge, and the request still billed. The user saw a chat turn
    // that did nothing and was told nothing.
    const model = new MockLanguageModelV4({
      doStream: emptyStopStream(),
    })
    await expect(
      collect(
        providerFor(model).streamConversation({
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
          tools: [],
        }),
      ),
    ).rejects.toThrow(/without producing an answer/i)
  })

  it('says what was observed, not why, when a step finishes with nothing to show', async () => {
    // FX16 item 5 (2026-09-05). The failure itself is right and stays: a
    // reasoning-only step persists nothing (`reasoning-delta` never enters
    // `blocks`, and `history-replay.ts` has no reasoning branch), so a
    // "successful" one would be a blank bubble with a silent charge. What was
    // wrong was the message asserting the model "declined to answer" — which a
    // user who just watched it reason on screen can see is false.
    const model = new MockLanguageModelV4({ doStream: emptyStopStream() })
    const failure = await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
      }),
    ).then(
      () => null,
      (e: unknown) => (e as Error).message,
    )
    expect(failure).not.toMatch(/declin/i)
    expect(failure).toMatch(/reasoning/i)
  })

  it('still reports the tokens the empty step spent before it fails', async () => {
    // The failure must not lose the accounting. The request was made and is
    // billed by the vendor whether or not the model answered, so the `usage`
    // event is emitted BEFORE the throw and the turn's cost stays honest.
    const model = new MockLanguageModelV4({
      doStream: emptyStopStream(),
    })
    const seen: ProviderEvent[] = []
    await expect(
      (async () => {
        for await (const ev of providerFor(model).streamConversation({
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
          tools: [],
        })) {
          seen.push(ev)
        }
      })(),
    ).rejects.toThrow()
    expect(seen).toEqual([{ kind: 'usage', inputTokens: 9, outputTokens: 7 }])
  })

  it('leaves the content-filter path alone: it is already reported as a refusal', async () => {
    // The control for the case above, and the boundary it must not cross.
    // `content_filter` DOES reach the adapter as a finish reason, maps to
    // `refusal`, and is already surfaced with the vendor's own wording. That
    // path is correct and stays exactly as it is.
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: finishOf('content-filter'), usage: USAGE },
      ]),
    })
    const events = await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [],
      }),
    )
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.stopReason).toBe('refusal')
    expect(done.vendorStopReason).toBe('content-filter')
  })

  it('leaves an aborted empty step alone: stopping a turn is the user\'s doing, not a refusal', async () => {
    // The other boundary. Pressing Stop before the model has said anything
    // also finishes with zero blocks, and it must keep reporting as an abort
    // rather than accusing the model of declining.
    const model = new MockLanguageModelV4({
      doStream: emptyStopStream(),
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

/**
 * The retry budget for a chat step belongs to `streamStepWithRetry` in the
 * neutral runtime, NOT to the SDK. `streamConversation` therefore sends
 * `maxRetries: 0`, and that single line is what keeps the vendor's own
 * `APICallError` — the one carrying the status and the `retry-after` header
 * our classifier reads — from being swallowed and re-thrown as a `RetryError`
 * envelope that carries neither.
 *
 * These cases exist because that line was load-bearing and unasserted:
 * MEASURED on 2026-09-04, deleting it left all 4481 tests in `src/editor`
 * green, which is how the first attempt at this defect shipped wrong. The
 * neutral-runtime retry tests cannot catch it — they inject a hand-written
 * `LLMProvider` stub, so `AiSdkProvider.streamConversation` never runs.
 */
describe('AiSdkProvider retry ownership', () => {
  /** A 429 shaped exactly like the one the SDK's retry loop acts on. */
  function retryable429(): Error {
    return new APICallError({
      message: 'Rate limit reached for gpt-5.6',
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': '3' },
      isRetryable: true,
    })
  }

  it('hands a retryable error to our loop once, un-enveloped, without retrying itself', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw retryable429()
      },
    })
    let thrown: unknown
    try {
      await collect(
        providerFor(model).streamConversation({
          system: 's',
          messages: [{ role: 'user', content: 'u' }],
          tools: [],
        }),
      )
    } catch (err) {
      thrown = err
    }

    // The SDK did NOT retry internally: one request, not three nested inside
    // each of our own three.
    expect(model.doStreamCalls).toHaveLength(1)
    // What reaches our classifier is the vendor's error, not the envelope.
    // Without `maxRetries: 0` this is a `RetryError` whose `statusCode`,
    // `responseHeaders` and `isRetryable` are all undefined, so the turn is
    // classified un-retryable and the `retry-after` header is lost.
    expect(RetryError.isInstance(thrown)).toBe(false)
    expect(APICallError.isInstance(thrown)).toBe(true)
    const api = thrown as InstanceType<typeof APICallError>
    expect(api.statusCode).toBe(429)
    expect(api.isRetryable).toBe(true)
    expect(api.responseHeaders?.['retry-after']).toBe('3')
  })

  it('keeps the SDK\'s own retries on streamComplete, which no loop of ours wraps', async () => {
    // The asymmetry is deliberate, so pin it at the boundary rather than by
    // waiting out two real exponential-backoff sleeps: `streamConversation`
    // sends `maxRetries: 0`, `streamComplete` sends no `maxRetries` at all
    // and inherits the SDK's default of 2.
    streamTextMock.mockClear()
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'ok' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const provider = providerFor(model)

    await collect(
      provider.streamConversation({ system: 's', messages: [{ role: 'user', content: 'u' }], tools: [] }),
    )
    const conversationOpts = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(conversationOpts.maxRetries).toBe(0)

    streamTextMock.mockClear()
    await provider.streamComplete({ system: 's', user: 'u' })
    const completeOpts = streamTextMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(completeOpts).not.toHaveProperty('maxRetries')
  })
})

/**
 * Provider server tools: the web tools the VENDOR runs inside one response.
 *
 * The vendor factories are the real ones from the installed packages, built
 * on a real `createAnthropic` / `createOpenAI` instance with a dummy key. No
 * request leaves the process: the model is `MockLanguageModelV4`, which only
 * records what the adapter asked for. That keeps the assertions on the exact
 * `LanguageModelV4ProviderTool` shape (`type: 'provider'`, the vendor's own
 * dotted id) instead of on a hand-written stand-in for it.
 */
describe('AiSdkProvider server tools', () => {
  const anthropicTools = createAnthropic({ apiKey: 'sk-ant-test' }).tools
  const openaiTools = createOpenAI({ apiKey: 'sk-test' }).tools

  function anthropicProviderFor(model: MockLanguageModelV4): AiSdkProvider {
    return new AiSdkProvider({
      name: 'anthropic',
      defaultModel: 'claude-opus-4-8',
      languageModel: () => model,
      providerOptionsKey: 'anthropic',
      serverTool: (def) => anthropicServerTool(def, anthropicTools),
    })
  }

  it('reports the server tool ids its factory accepts, and none without a factory', () => {
    const noModel = new MockLanguageModelV4({ doStream: answeredStream() })
    expect(anthropicProviderFor(noModel).serverToolIds).toEqual(['web_search', 'web_fetch'])
    const openai = new AiSdkProvider({
      name: 'openai',
      defaultModel: 'gpt-5.6',
      languageModel: () => noModel,
      providerOptionsKey: 'openai',
      serverTool: (def) => openAiServerTool(def, openaiTools),
    })
    expect(openai.serverToolIds).toEqual(['web_search'])
    expect(providerFor(noModel).serverToolIds).toEqual([])
  })

  it('bounds web_search at SERVER_TOOL_MAX_USES when the def names no cap', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [{ kind: 'server', id: 'web_search' }],
      }),
    )
    expect(model.doStreamCalls[0]!.tools).toEqual([
      {
        type: 'provider',
        id: 'anthropic.web_search_20260318',
        name: 'web_search',
        args: { maxUses: SERVER_TOOL_MAX_USES },
      },
    ])
    expect(SERVER_TOOL_MAX_USES).toBe(8)
  })

  it('declares a web_search server def as the vendor provider tool, with its options', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [
          { name: 'Read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
          { kind: 'server', id: 'web_search', allowedDomains: ['example.com'], maxUses: 3 },
        ],
      }),
    )
    const tools = model.doStreamCalls[0]!.tools!
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ type: 'function', name: 'Read' })
    expect(tools[1]).toEqual({
      type: 'provider',
      id: 'anthropic.web_search_20260318',
      name: 'web_search',
      args: { allowedDomains: ['example.com'], maxUses: 3 },
    })
  })

  it('declares web_fetch with the allowlist as allowedDomains', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [{ kind: 'server', id: 'web_fetch', allowedDomains: ['example.com'] }],
      }),
    )
    expect(model.doStreamCalls[0]!.tools).toEqual([
      {
        type: 'provider',
        id: 'anthropic.web_fetch_20260318',
        name: 'web_fetch',
        args: { allowedDomains: ['example.com'], maxUses: SERVER_TOOL_MAX_USES },
      },
    ])
  })

  it('declares OpenAI web_search with the domains as its filter, and skips web_fetch it does not have', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    const provider = new AiSdkProvider({
      name: 'openai',
      defaultModel: 'gpt-5.6',
      languageModel: () => model,
      providerOptionsKey: 'openai',
      serverTool: (def) => openAiServerTool(def, openaiTools),
    })
    await collect(
      provider.streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [
          { kind: 'server', id: 'web_search', allowedDomains: ['example.com'] },
          { kind: 'server', id: 'web_fetch', allowedDomains: ['example.com'] },
        ],
      }),
    )
    expect(model.doStreamCalls[0]!.tools).toEqual([
      {
        type: 'provider',
        id: 'openai.web_search',
        name: 'web_search',
        args: { filters: { allowedDomains: ['example.com'] } },
      },
    ])
  })

  it('leaves a server def out when the provider has no server-tool factory', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    await collect(
      providerFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [{ kind: 'server', id: 'web_search' }],
      }),
    )
    expect(model.doStreamCalls[0]!.tools ?? []).toEqual([])
  })

  const FETCH_RESULT = {
    type: 'web_fetch_result',
    url: 'https://example.com/',
    retrievedAt: '2026-09-22T00:00:00Z',
    content: {
      type: 'document',
      title: 'Example Domain',
      source: { type: 'text', mediaType: 'text/plain', data: 'Example Domain body' },
    },
  }

  it('turns a provider-executed call and result into server events and blocks, in order, and never a pending tool_use', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Fetching.' },
        { type: 'text-end', id: 't1' },
        {
          type: 'tool-call',
          toolCallId: 'srvtoolu_1',
          toolName: 'web_fetch',
          input: '{"url":"https://example.com/"}',
          providerExecuted: true,
          providerMetadata: { anthropic: { caller: { type: 'direct' } } },
        },
        {
          type: 'tool-result',
          toolCallId: 'srvtoolu_1',
          toolName: 'web_fetch',
          result: FETCH_RESULT,
        },
        // A search result also streams `source` parts. They carry nothing
        // the transcript needs, and must not crash the adapter.
        { type: 'source', sourceType: 'url', id: 'src_1', url: 'https://example.com/', title: 'Example Domain' },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'It is Example Domain.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const events = await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'Fetch https://example.com/' }],
        tools: [{ kind: 'server', id: 'web_fetch', allowedDomains: ['example.com'] }],
      }),
    )
    expect(events.some((e) => e.kind === 'tool_use')).toBe(false)
    const serverEvents = events.filter(
      (e) => e.kind === 'server_tool_use' || e.kind === 'server_tool_result',
    )
    expect(serverEvents).toEqual([
      {
        kind: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_fetch',
        input: { url: 'https://example.com/' },
      },
      { kind: 'server_tool_result', toolUseId: 'srvtoolu_1', name: 'web_fetch', output: FETCH_RESULT },
    ])
    const done = events.find((e) => e.kind === 'message_complete')
    if (done?.kind !== 'message_complete') throw new Error('expected message_complete')
    expect(done.stopReason).toBe('end_turn')
    expect(done.message.content).toEqual([
      { type: 'text', text: 'Fetching.' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_fetch',
        input: { url: 'https://example.com/' },
        providerMetadata: { anthropic: { caller: { type: 'direct' } } },
      },
      { type: 'server_tool_result', toolUseId: 'srvtoolu_1', name: 'web_fetch', output: FETCH_RESULT },
      { type: 'text', text: 'It is Example Domain.' },
    ])
  })

  it('marks a vendor-reported server tool failure as an errored result', async () => {
    const model = new MockLanguageModelV4({
      doStream: streamOf([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'srvtoolu_2',
          toolName: 'web_fetch',
          input: '{"url":"https://example.com/"}',
          providerExecuted: true,
        },
        {
          type: 'tool-result',
          toolCallId: 'srvtoolu_2',
          toolName: 'web_fetch',
          isError: true,
          result: { type: 'web_fetch_tool_result_error', errorCode: 'url_not_accessible' },
        },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Could not fetch it.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: finishOf('stop'), usage: USAGE },
      ]),
    })
    const events = await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [{ kind: 'server', id: 'web_fetch', allowedDomains: ['example.com'] }],
      }),
    )
    const result = events.find((e) => e.kind === 'server_tool_result')
    expect(result).toEqual({
      kind: 'server_tool_result',
      toolUseId: 'srvtoolu_2',
      name: 'web_fetch',
      output: { type: 'web_fetch_tool_result_error', errorCode: 'url_not_accessible' },
      isError: true,
    })
  })

  it('replays server blocks INSIDE the assistant message as provider-executed parts, never as a tool message', async () => {
    const model = new MockLanguageModelV4({ doStream: answeredStream() })
    const messages: Message[] = [
      { role: 'user', content: 'Fetch it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Fetching.' },
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_fetch',
            input: { url: 'https://example.com/' },
            providerMetadata: { anthropic: { caller: { type: 'direct' } } },
          },
          { type: 'server_tool_result', toolUseId: 'srvtoolu_1', name: 'web_fetch', output: FETCH_RESULT },
          {
            type: 'server_tool_use',
            id: 'srvtoolu_2',
            name: 'web_fetch',
            input: { url: 'https://example.com/missing' },
          },
          {
            type: 'server_tool_result',
            toolUseId: 'srvtoolu_2',
            name: 'web_fetch',
            output: { type: 'web_fetch_tool_result_error', errorCode: 'url_not_accessible' },
            isError: true,
          },
          { type: 'text', text: 'It is Example Domain.' },
        ],
      },
      { role: 'user', content: 'thanks' },
    ]
    await collect(
      anthropicProviderFor(model).streamConversation({
        system: 's',
        messages,
        tools: [{ kind: 'server', id: 'web_fetch', allowedDomains: ['example.com'] }],
      }),
    )
    const prompt = model.doStreamCalls[0]!.prompt
    expect(prompt.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const assistant = prompt[2] as { content: unknown[] }
    expect(assistant.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Fetching.' }),
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'srvtoolu_1',
        toolName: 'web_fetch',
        input: { url: 'https://example.com/' },
        providerExecuted: true,
        providerOptions: { anthropic: { caller: { type: 'direct' } } },
      }),
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'srvtoolu_1',
        toolName: 'web_fetch',
        output: { type: 'json', value: FETCH_RESULT },
      }),
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'srvtoolu_2',
        providerExecuted: true,
      }),
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'srvtoolu_2',
        output: {
          type: 'error-json',
          value: { type: 'web_fetch_tool_result_error', errorCode: 'url_not_accessible' },
        },
      }),
      expect.objectContaining({ type: 'text', text: 'It is Example Domain.' }),
    ])
  })
})
