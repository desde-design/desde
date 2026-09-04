/**
 * `LLMProvider` over the Vercel AI SDK's provider packages.
 *
 * The DIVISION OF LABOUR, which is the whole design: the SDK owns the wire
 * format (request shaping, SSE parsing, tool-call delta reassembly, usage
 * accounting) and nothing else. Desde owns the loop, the tools, the permission
 * gate, the prompt, the history and the cost. So this file calls
 * `generateText` / `streamText` exactly ONCE PER MODEL STEP: tools are passed
 * as definitions with no `execute`, which makes the library hand a tool call
 * back instead of running it, and the library's default `stopWhen` is one step,
 * so its own multi-step loop never engages. `toolApproval` and `prepareStep`
 * are never used. `toolApproval` is a binary human-in-the-loop pause and
 * cannot express what edit-ack does, which is deny with a written reason the
 * model can read and correct.
 *
 * This is the ONLY file in the repo allowed to import `ai` or `@ai-sdk/*`.
 * ESLint enforces it and `ai-sdk-import-boundary.test.ts` enforces it again,
 * because the SDK shipped two breaking majors inside a year and the mitigation
 * is that a bump stays a one-file migration.
 *
 * Deliberate behaviour notes:
 *  - `TextBlock.cacheHint` is dropped, as it was on the fetch provider. OpenAI
 *    has automatic prefix caching and no breakpoint API, so the caller still
 *    benefits without a marker on the wire.
 *  - Reasoning deltas are emitted as events but are NOT appended to the
 *    assistant message. They are display-only; replaying a reasoning summary
 *    as assistant text on the next step would corrupt the transcript.
 *  - A stream `error` part is rethrown rather than swallowed, so
 *    `classify-turn-error.ts` sees the vendor's own wording.
 *  - `result.stream` is used, not `result.fullStream`, and `result.usage`, not
 *    `result.totalUsage`: both of the latter are deprecated in ai@7. The one
 *    surviving `totalUsage` is the field name on the `finish` stream part,
 *    where it is not deprecated.
 */

import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  streamText,
  tool,
  type FinishReason,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai'

/**
 * Re-exported so a test outside this file can construct a REAL error the
 * SDK throws (`run-chat-turn-neutral.test.ts`, final review I4) without
 * itself importing `ai` and stepping outside the fence this file's header
 * describes.
 */
export { APICallError }

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
  Usage,
  UserContent,
} from './types'

export interface AiSdkProviderOptions {
  /** Stable provider id, e.g. 'openai'. Becomes `LLMProvider.name`. */
  name: string
  /** Model used when a caller omits one. */
  defaultModel: string
  /** Builds the SDK model for a model id. Bound to credentials by the descriptor. */
  languageModel: (modelId: string) => LanguageModel
  /**
   * The key `StreamOpts.providerOptions` is nested under before it reaches the
   * SDK. It is the provider NAME the SDK package was constructed with, which is
   * how `@ai-sdk/openai` and `@ai-sdk/openai-compatible` both look their own
   * options up.
   */
  providerOptionsKey: string
}

export class AiSdkProvider implements LLMProvider {
  readonly name: string
  readonly defaultModel: string
  private readonly languageModel: (modelId: string) => LanguageModel
  private readonly providerOptionsKey: string

  constructor(opts: AiSdkProviderOptions) {
    this.name = opts.name
    this.defaultModel = opts.defaultModel
    this.languageModel = opts.languageModel
    this.providerOptionsKey = opts.providerOptionsKey
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const model = this.languageModel(opts.model ?? this.defaultModel)
    const base = {
      model,
      system: flattenToString(opts.system),
      prompt: flattenToString(opts.user),
      maxOutputTokens: opts.maxTokens ?? 8000,
      abortSignal: opts.signal,
    }
    try {
      if (opts.responseFormat?.kind === 'json_schema') {
        const result = await generateText({
          ...base,
          output: Output.object({
            schema: jsonSchema(opts.responseFormat.schema),
            name: opts.responseFormat.name ?? 'response',
          }),
        })
        return {
          text: result.text,
          parsed: result.output,
          usage: toUsage(result.usage),
          stopReason: mapFinishReason(result.finishReason),
        }
      }
      const result = await generateText(base)
      return {
        text: result.text,
        usage: toUsage(result.usage),
        stopReason: mapFinishReason(result.finishReason),
      }
    } catch (err) {
      // A schema-shaped response the model got wrong is NOT an exception to
      // this caller: `types.ts` documents that `complete` does not throw on a
      // parse failure, because apply-llm-patch puts the raw text in its own
      // diagnostics. Everything else propagates.
      if (NoObjectGeneratedError.isInstance(err)) {
        return {
          text: err.text ?? '',
          usage: err.usage ? toUsage(err.usage) : undefined,
          stopReason: err.finishReason ? mapFinishReason(err.finishReason) : 'error',
        }
      }
      throw err
    }
  }

  async streamComplete(
    opts: CompleteOpts,
    onTextDelta?: (delta: string) => void,
  ): Promise<CompleteResult> {
    const model = this.languageModel(opts.model ?? this.defaultModel)
    const wantsJson = opts.responseFormat?.kind === 'json_schema'
    const result = streamText({
      model,
      system: flattenToString(opts.system),
      prompt: flattenToString(opts.user),
      maxOutputTokens: opts.maxTokens ?? 8000,
      abortSignal: opts.signal,
      ...(opts.responseFormat?.kind === 'json_schema'
        ? {
            output: Output.object({
              schema: jsonSchema(opts.responseFormat.schema),
              name: opts.responseFormat.name ?? 'response',
            }),
          }
        : {}),
    })
    for await (const part of result.stream) {
      if (part.type === 'text-delta' && part.text.length > 0) onTextDelta?.(part.text)
      else if (part.type === 'error') {
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
      }
    }
    const text = await result.text
    return {
      text,
      // Parsed here rather than by awaiting `result.output`, which THROWS
      // `NoObjectGeneratedError` on a bad response. `types.ts` says a parse
      // failure returns the raw text instead, so the streaming path never asks
      // the SDK a question whose only answer is an exception.
      parsed: wantsJson ? safeJsonParse(text) : undefined,
      usage: toUsage(await result.usage),
      stopReason: mapFinishReason(await result.finishReason),
    }
  }

  async *streamConversation(opts: StreamOpts): AsyncIterable<ProviderEvent> {
    const model = this.languageModel(opts.model ?? this.defaultModel)
    const result = streamText({
      model,
      system: flattenToString(opts.system),
      messages: toModelMessages(opts.messages),
      tools: toToolSet(opts.tools),
      ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
      // `StreamOpts.providerOptions` is deliberately `Record<string, unknown>`:
      // only the descriptor that produced it knows what its own vendor accepts.
      // The SDK wants JSON, and a wrong value is a 400 with the vendor's own
      // message, which is the error we want the user to read.
      ...(opts.providerOptions
        ? {
            providerOptions: {
              [this.providerOptionsKey]: opts.providerOptions as Record<string, JSONValue>,
            },
          }
        : {}),
      abortSignal: opts.signal,
    })

    const blocks: AssistantContent[] = []
    let pendingText = ''
    let finishReason: FinishReason | undefined
    let aborted = false
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }

    const flushText = (): void => {
      if (pendingText.length === 0) return
      blocks.push({ type: 'text', text: pendingText })
      pendingText = ''
    }

    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          if (part.text.length === 0) break
          pendingText += part.text
          yield { kind: 'text_delta', delta: part.text }
          break
        case 'reasoning-delta':
          if (part.text.length === 0) break
          yield { kind: 'reasoning_delta', delta: part.text }
          break
        case 'tool-call':
          flushText()
          blocks.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input })
          yield { kind: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input }
          break
        case 'abort':
          aborted = true
          break
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        case 'finish':
          finishReason = part.finishReason
          usage = toUsage(part.totalUsage)
          break
        default:
          break
      }
    }
    flushText()

    if (opts.signal?.aborted) aborted = true

    yield { kind: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
    yield {
      kind: 'message_complete',
      stopReason: aborted ? 'error' : mapFinishReason(finishReason),
      // The blocks generated before the abort are kept rather than discarded:
      // the neutral loop persists them so the transcript shows what the model
      // had said when the user pressed Stop.
      message: { role: 'assistant', content: blocks },
      usage,
      vendorStopReason: aborted ? 'aborted' : finishReason,
    }
  }
}

// ─── translation helpers ─────────────────────────────────────────────────

function flattenToString(content: SystemContent | UserContent): string {
  if (typeof content === 'string') return content
  // Cache hints are dropped here. See the file header.
  return content.map((b) => b.text).join('\n\n')
}

function safeJsonParse(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function toUsage(usage: LanguageModelUsage | undefined): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  }
}

function mapFinishReason(finish: FinishReason | undefined): StopReason {
  switch (finish) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool-calls':
      return 'tool_use'
    case 'content-filter':
      return 'refusal'
    case undefined:
      return 'end_turn'
    // 'other' is the SDK's bucket for a finish reason it did not recognise, so
    // it means the same thing the fetch provider's `default:` arm meant.
    default:
      return 'error'
  }
}

function toToolSet(tools: readonly ToolDef[]): ToolSet {
  const set: ToolSet = {}
  for (const def of tools) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.inputSchema),
      // No `execute`, deliberately. The neutral runtime gates and runs the
      // tool; the library must hand the call back untouched.
    })
  }
  return set
}

/**
 * Neutral `Message[]` to the SDK's `ModelMessage[]`.
 *
 * The one non-mechanical part: `ToolResultContent` carries no tool NAME, but
 * `ToolResultPart` requires one. It is recovered from the assistant turn that
 * made the call, which is always earlier in the same array. A result whose call
 * cannot be found keeps the tool-use id as the name rather than dropping the
 * message, because a dropped result desynchronises the transcript and the model
 * then answers a question it never saw the answer to.
 */
function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  const toolNameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolNameById.set(block.id, block.name)
    }
  }

  const out: ModelMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content.map((block) =>
        block.type === 'text'
          ? ({ type: 'text', text: block.text } as const)
          : ({
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ?? {},
            } as const),
      )
      out.push({ role: 'assistant', content })
      continue
    }
    if (typeof msg.content === 'string') {
      out.push({ role: 'user', content: msg.content })
      continue
    }
    // A `file` part, not the older `image` part: `image` is deprecated in ai@7
    // and the SDK normalises it into a file part anyway, so sending one warns
    // on every vision turn for no difference on the wire.
    const userParts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; data: string; mediaType: string }
    > = []
    const toolParts: Array<{
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: { type: 'text'; value: string } | { type: 'error-text'; value: string }
    }> = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        userParts.push({ type: 'file', data: block.data, mediaType: block.mediaType })
      } else {
        const value =
          typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => c.text).join('\n')
        toolParts.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: toolNameById.get(block.toolUseId) ?? block.toolUseId,
          output: block.isError ? { type: 'error-text', value } : { type: 'text', value },
        })
      }
    }
    if (userParts.length > 0) out.push({ role: 'user', content: userParts })
    if (toolParts.length > 0) out.push({ role: 'tool', content: toolParts })
  }
  return out
}
