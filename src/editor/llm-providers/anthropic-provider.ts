/**
 * Anthropic implementation of `LLMProvider`. Wraps `@anthropic-ai/sdk`'s
 * Messages API. Translates the vendor-neutral request/response shapes
 * into Anthropic's native form:
 *
 *   - `TextBlock.cacheHint: 'ephemeral'` → `cache_control: { type: 'ephemeral' }`
 *     on the block. (Anthropic-specific; the SDK accepts it on `system`
 *     blocks and on user-message content blocks.)
 *   - `ResponseFormat.kind === 'json_schema'` →
 *     `output_config.format.json_schema` per the existing call-site
 *     pattern.
 *
 * The Anthropic client is constructor-injected so tests can pass a
 * fake; production callers get a default `new Anthropic()` (which reads
 * `ANTHROPIC_API_KEY` from env).
 */

import Anthropic from '@anthropic-ai/sdk'

import type {
  AssistantContent,
  CompleteOpts,
  CompleteResult,
  ContentBlock,
  LLMProvider,
  Message,
  ProviderEvent,
  StopReason,
  StreamOpts,
  SystemContent,
  UserContent,
} from './types'

/** Anthropic SDK content-block shape (text + optional cache_control). */
type AnthropicTextBlock = {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

export interface AnthropicProviderOptions {
  /** SDK client injection for tests. Production uses `new Anthropic()`. */
  client?: Anthropic
  /** Default model when callers don't pin one. */
  defaultModel?: string
  /**
   * Optional explicit API key. When provided, the underlying SDK is
   * constructed with `apiKey` set — bypassing the SDK's default of
   * reading `process.env.ANTHROPIC_API_KEY`. The registry passes this
   * when `LLMConfig.apiKeyEnv` is configured so each provider instance
   * binds to ITS key rather than reading whatever happens to be in the
   * shared process env at first-call time.
   */
  apiKey?: string
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6'

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly defaultModel: string
  // Lazy-constructed: instantiating `Anthropic()` eagerly fails in
  // browser-like test environments without an API key (the SDK
  // refuses to construct as a defense against accidental client-side
  // key exposure). The registry happily builds providers at module
  // load time for tests that never actually call complete(); defer
  // construction until the first request so those code paths don't
  // need an env var.
  private clientCache: Anthropic | null
  private readonly clientInjected: Anthropic | null
  private readonly apiKey: string | undefined

  constructor(opts: AnthropicProviderOptions = {}) {
    this.clientInjected = opts.client ?? null
    this.clientCache = opts.client ?? null
    this.apiKey = opts.apiKey
    this.defaultModel = opts.defaultModel ?? ANTHROPIC_DEFAULT_MODEL
  }

  private get client(): Anthropic {
    if (this.clientCache) return this.clientCache
    if (this.clientInjected) {
      this.clientCache = this.clientInjected
      return this.clientCache
    }
    // Bind the SDK to THIS provider's API key (if one was passed) so
    // a shared `process.env.ANTHROPIC_API_KEY` mutation between two
    // provider instances doesn't cross-wire them. When `apiKey` is
    // omitted, the SDK falls back to its own env-var read — matches
    // historical behavior.
    this.clientCache = this.apiKey
      ? new Anthropic({ apiKey: this.apiKey })
      : new Anthropic()
    return this.clientCache
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const model = opts.model ?? this.defaultModel
    const maxTokens = opts.maxTokens ?? 8000

    const systemParam = toAnthropicSystem(opts.system)
    const userContentParam = toAnthropicUserContent(opts.user)

    const messages: Anthropic.Messages.MessageCreateParams['messages'] = [
      // SDK types model `messages[].content` as a string OR a discriminated
      // union of content blocks; the union does not include our cache_control
      // field at the type level even though the runtime accepts it. Cast at
      // the boundary so callers see the neutral shape.
      {
        role: 'user',
        content: userContentParam as unknown as Anthropic.Messages.MessageParam['content'],
      },
    ]

    const request: Anthropic.Messages.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      // Same boundary cast: SDK types `system` as string | TextBlockParam[]
      // without exposing cache_control; runtime accepts it on system blocks.
      system: systemParam as unknown as Anthropic.Messages.MessageCreateParams['system'],
      messages,
    }

    if (opts.responseFormat && opts.responseFormat.kind === 'json_schema') {
      // The SDK's typed surface for `output_config` doesn't expose the
      // `json_schema` format in every version; cast at the boundary
      // (matches the pattern in apply-llm-patch.ts and repair-edit.ts).
      ;(request as unknown as { output_config: unknown }).output_config = {
        format: {
          type: 'json_schema',
          schema: { ...opts.responseFormat.schema },
        },
      }
    }

    const response = await this.client.messages.create(request, {
      signal: opts.signal,
    })

    let text = ''
    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text
      }
    }

    let parsed: unknown
    if (opts.responseFormat?.kind === 'json_schema' && text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Leave `parsed` undefined; callers surface the raw text in
        // their own error path so they can include it in diagnostics.
      }
    }

    return {
      text,
      parsed,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : undefined,
      stopReason: mapStopReason(response.stop_reason),
    }
  }

  /**
   * Streaming peer of `complete()`. Same request params (including
   * `output_config.json_schema`), but uses the SDK's streaming
   * endpoint so we can surface incremental text to UI callers
   * (apply-llm-patch → save dialog). The final return is the same
   * `CompleteResult` shape the non-streaming path produces.
   */
  async streamComplete(
    opts: CompleteOpts,
    onTextDelta?: (delta: string) => void,
  ): Promise<CompleteResult> {
    const model = opts.model ?? this.defaultModel
    const maxTokens = opts.maxTokens ?? 8000

    const systemParam = toAnthropicSystem(opts.system)
    const userContentParam = toAnthropicUserContent(opts.user)

    const messages: Anthropic.Messages.MessageCreateParams['messages'] = [
      {
        role: 'user',
        content: userContentParam as unknown as Anthropic.Messages.MessageParam['content'],
      },
    ]

    const request: Anthropic.Messages.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemParam as unknown as Anthropic.Messages.MessageCreateParams['system'],
      messages,
    }

    if (opts.responseFormat && opts.responseFormat.kind === 'json_schema') {
      ;(request as unknown as { output_config: unknown }).output_config = {
        format: {
          type: 'json_schema',
          schema: { ...opts.responseFormat.schema },
        },
      }
    }

    const stream = await this.client.messages.create(request, {
      signal: opts.signal,
    })

    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: StopReason = 'end_turn'

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          if (event.message.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0
            outputTokens = event.message.usage.output_tokens ?? 0
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            text += delta.text
            if (onTextDelta) {
              try {
                onTextDelta(delta.text)
              } catch {
                // Caller callback errors are non-fatal — they shouldn't
                // tear down an in-flight LLM stream we're already paying
                // tokens for. Swallow and continue.
              }
            }
          }
          break
        }
        case 'message_delta': {
          if (event.delta.stop_reason) {
            stopReason = mapStopReason(event.delta.stop_reason)
          }
          if (event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens
          }
          break
        }
        default:
          break
      }
    }

    let parsed: unknown
    if (opts.responseFormat?.kind === 'json_schema' && text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Same diagnostic semantics as `complete()`: leave `parsed`
        // undefined so callers see the raw text in their own error path.
      }
    }

    return {
      text,
      parsed,
      usage: { inputTokens, outputTokens },
      stopReason,
    }
  }

  async *streamConversation(opts: StreamOpts): AsyncIterable<ProviderEvent> {
    const model = opts.model ?? this.defaultModel
    const maxTokens = opts.maxTokens ?? 8000

    const request: Anthropic.Messages.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      stream: true,
      system: toAnthropicSystem(opts.system) as unknown as
        Anthropic.Messages.MessageCreateParams['system'],
      messages: opts.messages.map(toAnthropicMessage),
      tools: opts.tools.map(toAnthropicTool),
    }

    // The SDK exposes both `.stream()` (returns MessageStream helper)
    // and `.create({ stream: true })` (returns a raw async iterable).
    // The raw iterable is the lower-level surface that maps cleanly to
    // our `ProviderEvent`s without depending on the SDK's helper APIs
    // we might later want to swap.
    const stream = await this.client.messages.create(request, {
      signal: opts.signal,
    })

    // Accumulators for reassembling the final assistant message.
    // Anthropic exposes a per-block `index` in every stream event;
    // we key by that and emit blocks SORTED by index at the end so
    // the assistant message preserves source-order even when `stop`
    // events arrive out of order (parallel tool use).
    const blocksByIndex: Map<number, AssistantContent> = new Map()
    const inputJsonByIndex: Record<number, string> = {}
    const toolUseMetaByIndex: Record<number, { id: string; name: string }> = {}
    const textByIndex: Record<number, string> = {}
    let finalStopReason: StopReason = 'end_turn'
    let vendorStopReason: string | undefined
    let inputTokens = 0
    let outputTokens = 0

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start': {
          if (event.message.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0
            outputTokens = event.message.usage.output_tokens ?? 0
          }
          break
        }
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'text') {
            textByIndex[event.index] = ''
          } else if (block.type === 'tool_use') {
            toolUseMetaByIndex[event.index] = {
              id: block.id,
              name: block.name,
            }
            inputJsonByIndex[event.index] = ''
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            textByIndex[event.index] =
              (textByIndex[event.index] ?? '') + delta.text
            yield { kind: 'text_delta', delta: delta.text }
          } else if (delta.type === 'input_json_delta') {
            inputJsonByIndex[event.index] =
              (inputJsonByIndex[event.index] ?? '') + delta.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const meta = toolUseMetaByIndex[event.index]
          if (meta) {
            // Tool use complete — parse accumulated JSON and emit.
            const raw = inputJsonByIndex[event.index] ?? ''
            let parsed: unknown = {}
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw)
              } catch {
                // Leave parsed as a sentinel so the orchestrator can
                // detect the parse failure and surface it as an error
                // tool_result without invoking the actual tool.
                parsed = { __parseError: raw }
              }
            }
            blocksByIndex.set(event.index, {
              type: 'tool_use',
              id: meta.id,
              name: meta.name,
              input: parsed,
            })
            yield {
              kind: 'tool_use',
              id: meta.id,
              name: meta.name,
              input: parsed,
            }
          } else if (event.index in textByIndex) {
            const text = textByIndex[event.index]
            if (text.length > 0) {
              blocksByIndex.set(event.index, { type: 'text', text })
            }
          }
          break
        }
        case 'message_delta': {
          if (event.delta.stop_reason) {
            finalStopReason = mapStopReason(event.delta.stop_reason)
            vendorStopReason = event.delta.stop_reason
          }
          if (event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens
          }
          break
        }
        case 'message_stop': {
          // End of stream.
          break
        }
      }
    }

    // P1: re-check abort AFTER stream iteration. If the SDK ended its
    // stream because the client disconnected, we don't want to report
    // a partial assistant message as a clean `end_turn` (the
    // orchestrator would persist it as if the turn completed).
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

    // Emit blocks in source order (by index), not in stop-arrival order.
    const sortedIndices = Array.from(blocksByIndex.keys()).sort((a, b) => a - b)
    const finalContent: AssistantContent[] = sortedIndices.map(
      (i) => blocksByIndex.get(i)!,
    )

    yield { kind: 'usage', inputTokens, outputTokens }
    yield {
      kind: 'message_complete',
      stopReason: finalStopReason,
      message: { role: 'assistant', content: finalContent },
      usage: { inputTokens, outputTokens },
      vendorStopReason,
    }
  }
}

function toAnthropicSystem(system: SystemContent): string | AnthropicTextBlock[] {
  if (typeof system === 'string') return system
  return system.map(blockToAnthropic)
}

function toAnthropicUserContent(
  user: UserContent,
): string | AnthropicTextBlock[] {
  if (typeof user === 'string') return user
  return user.map(blockToAnthropic)
}

function blockToAnthropic(block: ContentBlock): AnthropicTextBlock {
  const out: AnthropicTextBlock = { type: 'text', text: block.text }
  if (block.cacheHint === 'ephemeral') {
    out.cache_control = { type: 'ephemeral' }
  }
  return out
}

function toAnthropicMessage(msg: Message): Anthropic.Messages.MessageParam {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }
    const content = msg.content.map((b) => {
      if (b.type === 'text') {
        return { type: 'text' as const, text: b.text }
      }
      // tool_result
      return {
        type: 'tool_result' as const,
        tool_use_id: b.toolUseId,
        content:
          typeof b.content === 'string'
            ? b.content
            : b.content.map((c) => ({ type: 'text' as const, text: c.text })),
        is_error: b.isError,
      }
    })
    return { role: 'user', content }
  }
  // assistant
  const content = msg.content.map((b) => {
    if (b.type === 'text') {
      return { type: 'text' as const, text: b.text }
    }
    // tool_use
    return {
      type: 'tool_use' as const,
      id: b.id,
      name: b.name,
      input: (b.input ?? {}) as Record<string, unknown>,
    }
  })
  return { role: 'assistant', content }
}

function toAnthropicTool(tool: {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // SDK types `input_schema` as `Tool.InputSchema` with strict `type:
    // 'object'`. Our neutral schema is `Record<string, unknown>`; cast
    // at the boundary — the orchestrator only ever passes object-shaped
    // schemas.
    input_schema: tool.inputSchema as unknown as Anthropic.Messages.Tool['input_schema'],
  }
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'refusal'
    case 'pause_turn':
      return 'pause_turn'
    case null:
    case undefined:
      return 'end_turn'
    default:
      return 'error'
  }
}
