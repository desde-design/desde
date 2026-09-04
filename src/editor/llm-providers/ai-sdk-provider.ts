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
  /**
   * Provider options sent on EVERY request, before a caller's per-turn ones
   * are merged over them. This is where a vendor posture that must not depend
   * on a call site remembering it belongs — OpenAI's `store: false`, which
   * keeps the user's prompts and source excerpts out of the vendor's
   * retention, is set here for exactly that reason.
   */
  defaultProviderOptions?: Record<string, JSONValue>
}

export class AiSdkProvider implements LLMProvider {
  readonly name: string
  readonly defaultModel: string
  private readonly languageModel: (modelId: string) => LanguageModel
  private readonly providerOptionsKey: string
  private readonly defaultProviderOptions: Record<string, JSONValue> | undefined

  constructor(opts: AiSdkProviderOptions) {
    this.name = opts.name
    this.defaultModel = opts.defaultModel
    this.languageModel = opts.languageModel
    this.providerOptionsKey = opts.providerOptionsKey
    this.defaultProviderOptions = opts.defaultProviderOptions
  }

  /**
   * The `providerOptions` argument for one request: the build-time defaults
   * with the caller's per-turn options merged over them, nested under the
   * key the SDK package looks its own options up by. Omitted entirely when
   * there is nothing to send, so a request that needs none carries none.
   */
  private providerOptionsFor(
    perRequest?: Record<string, unknown>,
  ): { providerOptions?: Record<string, Record<string, JSONValue>> } {
    const merged = {
      ...(this.defaultProviderOptions ?? {}),
      ...((perRequest ?? {}) as Record<string, JSONValue>),
    }
    if (Object.keys(merged).length === 0) return {}
    return { providerOptions: { [this.providerOptionsKey]: merged } }
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const model = this.languageModel(opts.model ?? this.defaultModel)
    const base = {
      model,
      system: flattenToString(opts.system),
      prompt: flattenToString(opts.user),
      maxOutputTokens: opts.maxTokens ?? 8000,
      abortSignal: opts.signal,
      ...this.providerOptionsFor(),
    }
    try {
      if (opts.responseFormat?.kind === 'json_schema') {
        const callerSchema = opts.responseFormat.schema
        const result = await generateText({
          ...base,
          output: Output.object({
            schema: jsonSchema(toStrictJsonSchema(callerSchema)),
            name: opts.responseFormat.name ?? 'response',
          }),
        })
        return {
          text: result.text,
          parsed: dropSyntheticNulls(result.output, callerSchema),
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
    const jsonSchemaAsked =
      opts.responseFormat?.kind === 'json_schema' ? opts.responseFormat.schema : undefined
    const result = streamText({
      model,
      system: flattenToString(opts.system),
      prompt: flattenToString(opts.user),
      maxOutputTokens: opts.maxTokens ?? 8000,
      abortSignal: opts.signal,
      ...this.providerOptionsFor(),
      ...(opts.responseFormat?.kind === 'json_schema'
        ? {
            output: Output.object({
              schema: jsonSchema(toStrictJsonSchema(opts.responseFormat.schema)),
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
      parsed: jsonSchemaAsked ? dropSyntheticNulls(safeJsonParse(text), jsonSchemaAsked) : undefined,
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
      ...this.providerOptionsFor(opts.providerOptions),
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rewrite a JSON Schema into the shape OpenAI's STRICT Structured Outputs
 * mode accepts, without any call site having to know that mode exists.
 *
 * `Output.object` makes `@ai-sdk/openai` send `strict: true` next to the
 * schema, and strict mode requires every key of `properties` to appear in
 * `required` and every object to set `additionalProperties: false`. Each of
 * this repo's five `json_schema` call sites declares at least one optional
 * property, so before this function the vendor answered 400 and the whole
 * LLM-fallback half of the edit pipeline was dead on OpenAI.
 *
 * Optionality is not dropped, it is re-expressed: a property the caller left
 * out of `required` becomes nullable (`type: ['string', 'null']`), which is
 * OpenAI's own documented way to say "may be absent" under strict mode. The
 * nulls that come back are removed again by {@link dropSyntheticNulls}, so a
 * caller still reads an absent optional as `undefined`.
 *
 * Pure: the caller's schema object is never mutated.
 */
export function toStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeSchemaNode(schema, false) as Record<string, unknown>
}

function normalizeSchemaNode(node: unknown, makeNullable: boolean): unknown {
  if (Array.isArray(node)) return node.map((child) => normalizeSchemaNode(child, false))
  if (!isJsonRecord(node)) return node

  const out: Record<string, unknown> = { ...node }

  if (isJsonRecord(node.properties)) {
    const wasRequired = new Set(
      Array.isArray(node.required)
        ? node.required.filter((k): k is string => typeof k === 'string')
        : [],
    )
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = normalizeSchemaNode(value, !wasRequired.has(key))
    }
    out.properties = properties
    out.required = Object.keys(properties)
    out.additionalProperties = false
  } else if (node.type === 'object') {
    out.additionalProperties = false
  }

  if (node.items !== undefined) out.items = normalizeSchemaNode(node.items, false)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branch = node[key]
    if (Array.isArray(branch)) {
      out[key] = branch.map((child) => normalizeSchemaNode(child, false))
    }
  }
  for (const key of ['$defs', 'definitions'] as const) {
    const defs = node[key]
    if (isJsonRecord(defs)) {
      out[key] = Object.fromEntries(
        Object.entries(defs).map(([name, value]) => [name, normalizeSchemaNode(value, false)]),
      )
    }
  }

  return makeNullable ? withNullAllowed(out) : out
}

/** Widen one schema node so `null` is a legal value for it. */
function withNullAllowed(node: Record<string, unknown>): Record<string, unknown> {
  const out = { ...node }
  const type = out.type
  if (typeof type === 'string') {
    if (type !== 'null') out.type = [type, 'null']
  } else if (Array.isArray(type)) {
    if (!type.includes('null')) out.type = [...type, 'null']
  } else if (Array.isArray(out.anyOf)) {
    if (!out.anyOf.some((b) => isJsonRecord(b) && b.type === 'null')) {
      out.anyOf = [...out.anyOf, { type: 'null' }]
    }
  } else if (Array.isArray(out.oneOf)) {
    if (!out.oneOf.some((b) => isJsonRecord(b) && b.type === 'null')) {
      out.oneOf = [...out.oneOf, { type: 'null' }]
    }
  } else {
    // No `type` and no branch list: the node already admits anything, so
    // there is nothing to widen. Leave it exactly as the caller wrote it.
    return out
  }
  // An enum constrains the VALUES as well as the type, so a nullable enum
  // has to list null among them or the vendor rejects the pair.
  if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
  return out
}

/**
 * Undo, on the way back, exactly what {@link toStrictJsonSchema} asked for on
 * the way out: drop a `null` sitting where the CALLER's schema declared an
 * optional property. Without this a call site that wrote `explanation?:
 * string` would start receiving `null`, which is a behaviour change this
 * transport introduced and should therefore also absorb.
 *
 * Only properties the caller left out of `required` are touched. A `null` on
 * a required property is the model's answer and is passed through untouched.
 */
function dropSyntheticNulls(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) {
    const items = isJsonRecord(schema) ? schema.items : undefined
    return value.map((entry) => dropSyntheticNulls(entry, items))
  }
  if (!isJsonRecord(value) || !isJsonRecord(schema) || !isJsonRecord(schema.properties)) {
    return value
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [],
  )
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = schema.properties[key]
    if (entry === null && !required.has(key) && propertySchema !== undefined) continue
    out[key] = dropSyntheticNulls(entry, propertySchema)
  }
  return out
}

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
