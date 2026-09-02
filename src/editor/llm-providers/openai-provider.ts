/**
 * OpenAI implementation of `LLMProvider`. Validates the vendor-neutral
 * abstraction by satisfying the same interface as the Anthropic
 * provider without changing any call sites.
 *
 * Implemented against the Chat Completions API (`/v1/chat/completions`)
 * via direct `fetch` — no `openai` SDK dependency. Keeps the bundle
 * tight and means the provider works against any OpenAI-compatible
 * endpoint (Azure OpenAI, Codex's chat-completions interface, the
 * various local-LLM gateways that mimic this API).
 *
 * Translation notes:
 *   - `TextBlock.cacheHint` is silently DROPPED. OpenAI doesn't have a
 *     first-class prompt-caching breakpoint API; the caller still gets
 *     OpenAI's automatic prefix caching for the system prompt and
 *     prior turns, which is fine.
 *   - `ToolDef.inputSchema` maps to `tools[].function.parameters`.
 *   - `Message.role: 'user' | 'assistant'` maps directly. Tool results
 *     translate from `ToolResultContent` to `{ role: 'tool', ... }`.
 *   - `ResponseFormat: 'json_schema'` maps to OpenAI's structured
 *     outputs (`response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`).
 *   - `StopReason` mapping:
 *       end_turn       → `finish_reason: 'stop'`
 *       max_tokens     → `'length'`
 *       tool_use       → `'tool_calls'`
 *       refusal        → `'content_filter'` (heuristic; closest match)
 *       stop_sequence  → unused (OpenAI returns 'stop' for both)
 *       pause_turn     → unused (OpenAI has no equivalent)
 *       error          → unknown finish_reason
 */

import type {
  AssistantContent,
  CompleteOpts,
  CompleteResult,
  LLMProvider,
  Message,
  ProviderEvent,
  StopReason,
  StreamOpts,
  SystemContent,
  ToolDef,
  UserContent,
} from './types'

export interface OpenAIProviderOptions {
  /** Optional API key. Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string
  /** Base URL. Defaults to OpenAI public API. */
  baseUrl?: string
  /** Default model when callers don't pin one. */
  defaultModel?: string
  /** Custom fetch (for tests). */
  fetchImpl?: typeof fetch
}

export const OPENAI_DEFAULT_MODEL = 'gpt-5.2'

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai'
  readonly defaultModel: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? ''
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com'
    this.defaultModel = opts.defaultModel ?? OPENAI_DEFAULT_MODEL
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    if (!this.apiKey) {
      throw new Error('OpenAIProvider: missing API key (set OPENAI_API_KEY or pass apiKey)')
    }
    const body: Record<string, unknown> = {
      model: opts.model ?? this.defaultModel,
      max_completion_tokens: opts.maxTokens ?? 8000,
      messages: [
        { role: 'system', content: flattenToString(opts.system) },
        { role: 'user', content: flattenToString(opts.user) },
      ],
    }
    if (opts.responseFormat?.kind === 'json_schema') {
      // OpenAI's `strict: true` requires every object in the schema
      // to set `additionalProperties: false` and list every property
      // as required. We can't enforce that here without recursively
      // rewriting the caller's schema, so we DON'T set strict by
      // default. Callers who want strict structured outputs can pre-
      // shape their schema accordingly and pass it through — the API
      // accepts both modes.
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: opts.responseFormat.name ?? 'response',
          schema: opts.responseFormat.schema,
        },
      }
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenAI complete failed: ${response.status} ${text.slice(0, 200)}`)
    }
    const json = (await response.json()) as OpenAIChatResponse
    const choice = json.choices?.[0]
    const refusal = choice?.message?.refusal
    const text = refusal ?? choice?.message?.content ?? ''
    let parsed: unknown
    if (
      !refusal &&
      opts.responseFormat?.kind === 'json_schema' &&
      text.length > 0
    ) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Leave parsed undefined.
      }
    }
    return {
      text,
      parsed,
      usage: json.usage
        ? {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          }
        : undefined,
      // Refusal takes precedence over the finish_reason. OpenAI may
      // return `finish_reason: 'stop'` on a structured-output refusal;
      // the `refusal` field is the authoritative signal that the
      // model declined.
      stopReason: refusal ? 'refusal' : mapStopReason(choice?.finish_reason),
    }
  }

  /**
   * Streaming peer of `complete()`. Not implemented for OpenAI yet —
   * real chunk-by-chunk streaming requires migrating to the OpenAI
   * streaming chat-completions API with json_schema support. A "fake"
   * stub that fires the callback once at end gives a misleading UX
   * (dialog shows "streaming" then text appears in one chunk); better
   * to omit `streamComplete` so apply-llm-patch falls back to the
   * non-streaming path and the dialog correctly shows "Asking AI…"
   * without the streaming block (Codex review P2). When real
   * streaming lands, just implement this method.
   */
  // streamComplete is intentionally unimplemented; see comment above.

  async *streamConversation(opts: StreamOpts): AsyncIterable<ProviderEvent> {
    if (!this.apiKey) {
      throw new Error('OpenAIProvider: missing API key (set OPENAI_API_KEY or pass apiKey)')
    }
    const body = {
      model: opts.model ?? this.defaultModel,
      max_completion_tokens: opts.maxTokens ?? 8000,
      stream: true,
      stream_options: { include_usage: true },
      // System prompt prepended as a `role: 'system'` message — OpenAI
      // doesn't have a top-level system param in chat-completions.
      messages: [
        { role: 'system' as const, content: flattenToString(opts.system) },
        ...opts.messages.map(toOpenAIMessage).flat(),
      ],
      tools: opts.tools.map(toOpenAITool),
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`OpenAI stream failed: ${response.status} ${text.slice(0, 200)}`)
    }

    // Accumulators for assistant message reassembly.
    const textParts: string[] = []
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >()
    let finishReason: string | null = null
    let refusalText = ''
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of parseOpenAISseStream(response.body)) {
      // The `[DONE]` sentinel.
      if (event === 'DONE') break
      const choice = event.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      const delta = choice?.delta
      if (delta?.content) {
        textParts.push(delta.content)
        yield { kind: 'text_delta', delta: delta.content }
      }
      if (delta?.refusal) {
        // Structured-output refusal — stream as text deltas so the
        // UI can render the model's stated reason. Track separately
        // so we can stamp the stopReason as 'refusal' at the end.
        refusalText += delta.refusal
        yield { kind: 'text_delta', delta: delta.refusal }
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          let entry = toolCalls.get(idx)
          if (!entry) {
            entry = { id: '', name: '', arguments: '' }
            toolCalls.set(idx, entry)
          }
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name = tc.function.name
          if (tc.function?.arguments) entry.arguments += tc.function.arguments
        }
      }
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens ?? inputTokens
        outputTokens = event.usage.completion_tokens ?? outputTokens
      }
    }

    if (opts.signal?.aborted) {
      yield {
        kind: 'message_complete',
        stopReason: 'error',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens, outputTokens },
        vendorStopReason: 'aborted',
      }
      return
    }

    // Emit tool_use events for completed tool calls + reassemble the
    // assistant message in source order: text first (concatenated),
    // then tool_uses in delta index order.
    const blocks: AssistantContent[] = []
    const concatenatedText = textParts.join('')
    if (concatenatedText.length > 0) {
      blocks.push({ type: 'text', text: concatenatedText })
    }
    const sortedToolCalls = Array.from(toolCalls.entries()).sort(
      ([a], [b]) => a - b,
    )
    for (const [, entry] of sortedToolCalls) {
      let input: unknown = {}
      if (entry.arguments.length > 0) {
        try {
          input = JSON.parse(entry.arguments)
        } catch {
          input = { __parseError: entry.arguments }
        }
      }
      blocks.push({
        type: 'tool_use',
        id: entry.id,
        name: entry.name,
        input,
      })
      yield {
        kind: 'tool_use',
        id: entry.id,
        name: entry.name,
        input,
      }
    }

    yield { kind: 'usage', inputTokens, outputTokens }
    // Refusal takes precedence — see `complete()` for rationale.
    const stopReason: StopReason = refusalText.length > 0
      ? 'refusal'
      : mapStopReason(finishReason)
    yield {
      kind: 'message_complete',
      stopReason,
      message: { role: 'assistant', content: blocks },
      usage: { inputTokens, outputTokens },
      vendorStopReason: finishReason ?? undefined,
    }
  }
}

// ─── Translation helpers ─────────────────────────────────────────────

function flattenToString(content: SystemContent | UserContent): string {
  if (typeof content === 'string') return content
  // OpenAI accepts string messages or content-block arrays; we flatten
  // to a single string for simplicity. Cache hints are dropped here —
  // see the file header.
  return content.map((b) => b.text).join('\n\n')
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

function toOpenAIMessage(msg: Message): OpenAIChatMessage[] {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return [{ role: 'user', content: msg.content }]
    }
    // Mixed content: text blocks become a regular user message; tool
    // results become role: 'tool' messages keyed by toolUseId.
    const userTextParts: string[] = []
    const toolMessages: OpenAIChatMessage[] = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        // cacheHint dropped — OpenAI doesn't have a first-class
        // cache-breakpoint API; cf. file header.
        userTextParts.push(block.text)
      } else if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => c.text).join('\n')
        toolMessages.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: block.isError ? `[error] ${content}` : content,
        })
      }
    }
    const out: OpenAIChatMessage[] = []
    if (userTextParts.length > 0) {
      out.push({ role: 'user', content: userTextParts.join('\n\n') })
    }
    out.push(...toolMessages)
    return out
  }
  // assistant — may contain text + tool_use
  const textParts: string[] = []
  const toolCalls: NonNullable<OpenAIChatMessage['tool_calls']> = []
  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }
  const out: OpenAIChatMessage = { role: 'assistant' }
  if (textParts.length > 0) out.content = textParts.join('')
  else out.content = null
  if (toolCalls.length > 0) out.tool_calls = toolCalls
  return [out]
}

function toOpenAITool(tool: ToolDef): {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function mapStopReason(finish: string | null | undefined): StopReason {
  switch (finish) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'function_call': // legacy
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    case null:
    case undefined:
      return 'end_turn'
    default:
      return 'error'
  }
}

// ─── SSE parser ──────────────────────────────────────────────────────

interface OpenAIStreamEvent {
  choices?: Array<{
    delta?: {
      content?: string
      refusal?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { content?: string; refusal?: string }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Parses OpenAI's SSE stream. Each event is a `data: <json>` line; the
 * stream ends with `data: [DONE]`. Yields parsed event objects or the
 * literal string `'DONE'` for the sentinel.
 *
 * NOT the shared `parseSseStream` (`src/lib/sse.ts`, audit Task 20/16). Two
 * reasons this one has to stay standalone: (1) it's parsing a THIRD-PARTY
 * wire format (OpenAI's own SSE producer), not one of editor-cli's own
 * routes (`editor-cli/src/server/sse.ts`) the shared parser was built
 * against — no `event:` field to drop, but also no guarantee it stays
 * byte-identical to ours over time. (2) OpenAI's terminal sentinel is the
 * literal non-JSON payload `data: [DONE]`; the shared parser's frame
 * handler treats a `JSON.parse` failure as "malformed, drop it" (matching
 * its own producers, which never send one), which would silently swallow
 * the only signal this stream is complete. Yielding the `'DONE'` string
 * alongside parsed events is exactly what that parser's `AsyncIterable<T>`
 * contract can't express without leaking a provider-specific sentinel into
 * a "shared" type.
 */
async function* parseOpenAISseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<OpenAIStreamEvent | 'DONE'> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sepIndex = buffer.indexOf('\n\n')
      while (sepIndex !== -1) {
        const frame = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice('data:'.length).trim()
          if (payload === '[DONE]') {
            yield 'DONE'
            return
          }
          if (payload.length === 0) continue
          try {
            yield JSON.parse(payload) as OpenAIStreamEvent
          } catch {
            // Skip malformed frames defensively.
          }
        }
        sepIndex = buffer.indexOf('\n\n')
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released.
    }
  }
}
