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
 *  - `TextBlock.cacheHint` is dropped unless the descriptor sets `cacheControl:
 *    'anthropic'`, as it was on the fetch provider. OpenAI has automatic prefix
 *    caching and no breakpoint API, so the caller still benefits without a
 *    marker on the wire and `cacheControl` is left unset for it. Anthropic's
 *    caching is breakpoint-based, so a marked system block is sent as a
 *    `SystemModelMessage` carrying `providerOptions.anthropic.cacheControl`
 *    instead of being flattened to a plain string.
 *  - Reasoning deltas are emitted as events but are NOT appended to the
 *    assistant message. They are display-only; replaying a reasoning summary
 *    as assistant text on the next step would corrupt the transcript.
 *  - A stream `error` part is rethrown rather than swallowed, so
 *    `classify-turn-error.ts` sees the vendor's own wording. `onError` is
 *    silenced for the same reason: the SDK's default writes the raw vendor
 *    error to stderr before the classifier can sanitise it.
 *  - An errored tool result keeps its marker in the TEXT (`markAsError`),
 *    because the Responses mapping flattens `error-text` and `text` to the
 *    same `function_call_output` and the flag itself does not reach the
 *    model. Anthropic's `is_error` does survive, so without the marker the
 *    two lanes disagreed.
 *  - Server tools (the vendor-run web tools, `ToolDef` of kind `server`) are
 *    the one exception to "no `execute`, the loop runs it": the VENDOR runs
 *    them inside the same response. Their call and result arrive as
 *    `providerExecuted` stream parts and become `server_tool_use` /
 *    `server_tool_result` blocks, never a pending call. This file stays
 *    vendor-free about them: the descriptor's own `serverTool` factory
 *    (`ai-sdk-anthropic.ts`, `ai-sdk-openai.ts`) builds each one.
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
  RetryError,
  streamText,
  tool,
  type AssistantModelMessage,
  type FinishReason,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type Tool,
  type ToolSet,
} from 'ai'

/**
 * Re-exported so a test outside this file can construct a REAL error the
 * SDK throws (`run-chat-turn-neutral.test.ts`, final review I4) without
 * itself importing `ai` and stepping outside the fence this file's header
 * describes.
 *
 * `RetryError` is the envelope the SDK's own retry loop puts around the
 * vendor's `APICallError` once its attempts are exhausted, and it carries
 * neither a status nor headers. A hand-shaped stand-in for it is what let a
 * first attempt at the retry-classification fix pass while being wrong, so
 * the test builds the real class.
 */
export { APICallError, RetryError }

import type {
  AssistantContent,
  CompleteOpts,
  CompleteResult,
  LLMProvider,
  Message,
  ProviderEvent,
  StopReason,
  ServerToolDef,
  ServerToolId,
  StreamOpts,
  SystemContent,
  ToolDef,
  Usage,
  UserContent,
} from './types'
import { SERVER_TOOL_IDS } from './types'

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
  /**
   * Which vendor's breakpoint caching `TextBlock.cacheHint` maps to. Absent
   * means the hint is dropped (OpenAI caches prefixes automatically and has no
   * breakpoint API). 'anthropic' emits `providerOptions.anthropic.cacheControl`
   * on the marked system block.
   */
  cacheControl?: 'anthropic'
  /**
   * Builds the vendor's own tool for a server def (`web_search`,
   * `web_fetch`). Supplied by the vendor file, so this adapter never names a
   * vendor tool factory. Returns `undefined` for an id the vendor does not
   * have (OpenAI has no fetch tool), and the def is then left out of the
   * request. Absent entirely means the provider serves no server tools.
   */
  serverTool?: (def: ServerToolDef) => Tool | undefined
}

export class AiSdkProvider implements LLMProvider {
  readonly name: string
  readonly defaultModel: string
  private readonly languageModel: (modelId: string) => LanguageModel
  private readonly providerOptionsKey: string
  private readonly defaultProviderOptions: Record<string, JSONValue> | undefined
  private readonly cacheControl: 'anthropic' | undefined
  private readonly serverTool: ((def: ServerToolDef) => Tool | undefined) | undefined

  constructor(opts: AiSdkProviderOptions) {
    this.name = opts.name
    this.defaultModel = opts.defaultModel
    this.languageModel = opts.languageModel
    this.providerOptionsKey = opts.providerOptionsKey
    this.defaultProviderOptions = opts.defaultProviderOptions
    this.cacheControl = opts.cacheControl
    this.serverTool = opts.serverTool
  }

  private cachedServerToolIds: ReadonlyArray<ServerToolId> | undefined

  /**
   * The ids the `serverTool` factory accepts, found by asking it. Derived
   * rather than declared beside the factory, so the two cannot drift: the
   * factory IS what decides whether a def reaches the request. The vendor
   * factories are pure option mappings, so asking has no side effect.
   * Computed on first read, not in the constructor.
   */
  get serverToolIds(): ReadonlyArray<ServerToolId> {
    if (this.cachedServerToolIds === undefined) {
      const factory = this.serverTool
      this.cachedServerToolIds = factory
        ? SERVER_TOOL_IDS.filter((id) => factory({ kind: 'server', id }) !== undefined)
        : []
    }
    return this.cachedServerToolIds
  }

  /**
   * The `system` argument for one request. A plain string unless the
   * descriptor was built with `cacheControl: 'anthropic'` AND at least one
   * block is marked `cacheHint: 'ephemeral'` — otherwise this is exactly
   * `flattenToString`, so OpenAI (and Anthropic without a marked block) keeps
   * today's behaviour byte-for-byte. When it does apply, EVERY block becomes
   * its own `SystemModelMessage` (not just the marked one) because the SDK's
   * `system` argument is either a single string or a full array of system
   * messages — there is no way to send "some of the system prompt as a
   * string, the rest as messages" in one request.
   */
  private toSystem(system: SystemContent): string | SystemModelMessage[] {
    if (typeof system === 'string') return system
    if (this.cacheControl !== 'anthropic' || !system.some((b) => b.cacheHint === 'ephemeral')) {
      return flattenToString(system)
    }
    return system.map((b) => ({
      role: 'system' as const,
      content: b.text,
      ...(b.cacheHint === 'ephemeral'
        ? { providerOptions: { [this.providerOptionsKey]: { cacheControl: { type: 'ephemeral' } } } }
        : {}),
    }))
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
      system: this.toSystem(opts.system),
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
      system: this.toSystem(opts.system),
      prompt: flattenToString(opts.user),
      maxOutputTokens: opts.maxTokens ?? 8000,
      abortSignal: opts.signal,
      onError: silenceSdkDefaultLogging,
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
      system: this.toSystem(opts.system),
      messages: toModelMessages(opts.messages),
      tools: toToolSet(opts.tools, this.serverTool),
      ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
      // `StreamOpts.providerOptions` is deliberately `Record<string, unknown>`:
      // only the descriptor that produced it knows what its own vendor accepts.
      // The SDK wants JSON, and a wrong value is a 400 with the vendor's own
      // message, which is the error we want the user to read.
      ...this.providerOptionsFor(opts.providerOptions),
      // The whole retry budget for a chat step belongs to
      // `streamStepWithRetry` in the neutral runtime, which emits `api_retry`
      // with real numbers and honours the vendor's `retry-after` header.
      // Leaving the SDK's own default of 2 in place nested 3 attempts inside
      // each of ours, and — worse — replaced the vendor's `APICallError` with
      // a `RetryError` carrying neither a status nor headers, which is what
      // made retry classification unreachable. `complete` and
      // `streamComplete` keep the SDK's retries: no loop of ours wraps them.
      maxRetries: 0,
      onError: silenceSdkDefaultLogging,
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
          if (part.providerExecuted === true) {
            // The vendor already ran it, inside this response. Recorded for
            // the transcript and for replay; the loop must not run it again.
            blocks.push({
              type: 'server_tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
              ...metadataOf(part.providerMetadata),
            })
            yield {
              kind: 'server_tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            }
            break
          }
          blocks.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input })
          yield { kind: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input }
          break
        case 'tool-result':
        case 'tool-error': {
          // Only a provider-executed result can reach here: our function
          // tools carry no `execute`, so the library never produces a result
          // for one. The guard keeps that an assertion rather than a guess.
          if (part.providerExecuted !== true) break
          flushText()
          const isError = part.type === 'tool-error'
          const output = isError ? part.error : part.output
          blocks.push({
            type: 'server_tool_result',
            toolUseId: part.toolCallId,
            name: part.toolName,
            output,
            ...(isError ? { isError: true } : {}),
            ...metadataOf(part.providerMetadata),
          })
          yield {
            kind: 'server_tool_result',
            toolUseId: part.toolCallId,
            name: part.toolName,
            output,
            ...(isError ? { isError: true } : {}),
          }
          break
        }
        case 'source':
          // Search citations. The result block already carries every URL the
          // vendor returned, so these add nothing the transcript needs.
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

    // On an abort this is 0/0. The vendor reports usage only on its `finish`
    // part, and an abort ends the stream before that part arrives, so there
    // is no figure to read here. The vendor still billed the request: the
    // neutral loop sees the zero and records an estimate in its place
    // (`estimate-cut-off-usage.ts`).
    yield { kind: 'usage', ...usage }

    // A finished response that said nothing is a failed step, not an empty
    // successful one.
    //
    // The case this exists for: OpenAI's Responses API can answer with a
    // structured `refusal` content part, and `@ai-sdk/openai` does not model
    // refusals at all — `response.refusal.delta` / `.done` are absent from its
    // chunk table, so they are dropped as unknown chunks and the refusal text
    // never reaches this loop. Such a response is COMPLETE, its
    // `incomplete_details` is null, and the finish reason is therefore `stop`.
    // Mapped naively that is `end_turn`, and the neutral runtime raises an
    // error only for a stop reason that is NOT `end_turn` and only for a
    // missing message, never for a present-but-empty one. The user got an
    // assistant turn with no text, no error, no failure badge — and a charge.
    //
    // Deliberately narrow. `content-filter` already arrives as its own finish
    // reason and is already reported as a refusal with the vendor's wording;
    // that path is untouched. An abort is the user's doing and keeps reporting
    // as an abort. Only `stop` with nothing to show for it lands here.
    //
    // The `usage` event above is emitted first on purpose: the request was
    // made and the vendor bills it whether or not the model answered, so the
    // turn's accounting stays honest even though the step fails.
    if (!aborted && finishReason === 'stop' && blocks.length === 0) {
      // The wording states what was OBSERVED and stops there.
      //
      // FX16 item 5 (2026-09-05). It used to assert a cause — "which usually
      // means it declined to answer" — and that is wrong for the case a user
      // is most likely to hit: a reasoning model that thought out loud on
      // screen and then stopped. `reasoning-delta` reaches the client for live
      // display but never pushes into `blocks`, so such a step arrives here
      // with nothing to persist. The user just watched it think, and was told
      // it had declined. The remedy the message points at changed with it:
      // rephrasing does not help a model that reasoned itself out of an
      // answer; a different model or a different effort setting does.
      throw new Error(
        'The model ended the turn without producing an answer. It may have spent the step ' +
          'reasoning and stopped. Try again, or use a different model or effort setting.',
      )
    }

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

/**
 * `streamText`'s `onError` default is `({ error }) => console.error(error)`,
 * which writes the vendor's whole error object — url, status, response
 * headers and response body — to the process log before this adapter has
 * rethrown it and `classify-turn-error.ts` has had the chance to replace it
 * with the sanitised remediation copy. The stream's `error` part is already
 * handled (it is rethrown), so the default logger has nothing to add and one
 * unsanitised copy to leak.
 */
function silenceSdkDefaultLogging(): void {
  /* intentionally empty — see the doc comment */
}

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

/**
 * Prefix a tool result the caller marked as an error, so the marker survives
 * a wire format that drops the flag. Already-marked text is left alone: an
 * `edit-ack` denial that opens with "Error:" or "Refused:" reads worse with a
 * second one stapled on.
 */
function markAsError(value: string): string {
  return /^\s*(error|failed|refused|denied)\b/i.test(value) ? value : `Error: ${value}`
}

function flattenToString(content: SystemContent | UserContent): string {
  if (typeof content === 'string') return content
  // Cache hints are dropped here unless `cacheControl` is set. See the file
  // header and `toSystem`, which is what routes a marked system block away
  // from this function.
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
  // `LanguageModelUsage.inputTokenDetails` is the normalized shape every
  // provider's usage lands in (confirmed against the installed `ai`
  // package's d.ts, and against both `@ai-sdk/anthropic` and
  // `@ai-sdk/openai`'s usage converters): `cacheReadTokens` and
  // `cacheWriteTokens` are populated straight off the vendor's own
  // cache-read / cache-creation counters, so no provider-specific
  // `providerMetadata` read is needed here.
  //
  // `usage.inputTokens` itself (the top-level field) is the GRAND TOTAL —
  // fresh input tokens PLUS cache-read PLUS cache-write, confirmed in both
  // converters above. `Usage.inputTokens` here must stay disjoint from the
  // two cache counters, or `estimateUsageCost` double-bills cache tokens
  // (once inside `inputTokens` at the full input rate, again at the cache
  // rate). So this reads `noCacheTokens` — the split-out fresh count.
  //
  // `noCacheTokens` is optional independently of the cache counters, so the
  // fallback subtracts whatever cache figures WERE reported from the total.
  // Falling back to the bare total double-billed a vendor that reported a
  // cache read without the fresh count. For a provider that reported no
  // cache details at all, the subtraction takes nothing and the total IS the
  // fresh count, as before.
  const details = usage?.inputTokenDetails
  const cacheRead = details?.cacheReadTokens
  const cacheWrite = details?.cacheWriteTokens
  return {
    inputTokens:
      details?.noCacheTokens ??
      Math.max(0, (usage?.inputTokens ?? 0) - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    outputTokens: usage?.outputTokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheCreationInputTokens: cacheWrite } : {}),
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

/**
 * `providerMetadata` off a stream part, as the optional field the neutral
 * block carries. Omitted when the vendor sent none, so a block without it
 * compares equal to one built by hand.
 */
function metadataOf(
  metadata: Record<string, unknown> | undefined,
): { providerMetadata?: Record<string, unknown> } {
  return metadata !== undefined && Object.keys(metadata).length > 0
    ? { providerMetadata: metadata }
    : {}
}

function toToolSet(
  tools: readonly ToolDef[],
  serverTool: ((def: ServerToolDef) => Tool | undefined) | undefined,
): ToolSet {
  const set: ToolSet = {}
  for (const def of tools) {
    if (def.kind === 'server') {
      // Keyed by the id, which is also the name both vendors give the tool
      // on the wire. That matters on REPLAY: `@ai-sdk/anthropic` maps a
      // replayed call's name back to its own tool name through the CURRENT
      // request's tool set, and falls back to the name itself when the tool
      // is not declared this time (the user switched web search off between
      // turns). Keying by the id makes both paths land on `web_search`.
      const built = serverTool?.(def)
      if (built !== undefined) set[def.id] = built
      continue
    }
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
/** One part of an assistant `ModelMessage`'s content array. */
type AssistantModelPart = Exclude<AssistantModelMessage['content'], string>[number]

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
      const content = msg.content.map((block): AssistantModelPart => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text }
          case 'tool_use':
            return {
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ?? {},
            }
          // Server-tool blocks stay INSIDE the assistant message. The vendor
          // produced the call and the result in one response, and both
          // vendor mappings read them back from there: a `tool` role message
          // is for results Desde produced, and the vendor would read this one
          // as an answer to a function call it never made.
          case 'server_tool_use':
            return {
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input ?? {},
              providerExecuted: true,
              ...(block.providerMetadata
                ? { providerOptions: block.providerMetadata as Record<string, Record<string, JSONValue>> }
                : {}),
            }
          case 'server_tool_result':
            return {
              type: 'tool-result',
              toolCallId: block.toolUseId,
              toolName: block.name,
              // `error-json` for a vendor-reported failure, because the vendor
              // validates a `json` output against its SUCCESS schema on the
              // way back in, and an error payload fails that validation and
              // takes the whole request down with it.
              output: block.isError
                ? { type: 'error-json', value: block.output as JSONValue }
                : { type: 'json', value: block.output as JSONValue },
              ...(block.providerMetadata
                ? { providerOptions: block.providerMetadata as Record<string, Record<string, JSONValue>> }
                : {}),
            }
        }
      })
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
      | { type: 'file'; data: string; mediaType: string; filename?: string }
    > = []
    const toolParts: Array<{
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output:
        | { type: 'text'; value: string }
        | { type: 'error-text'; value: string }
        // The `content` variant is what carries an IMAGE back from a tool.
        // The OpenAI Responses mapping turns each `file` part whose media type
        // is an image into an `input_image` on the `function_call_output`, so
        // `capture_screenshot` reaches the model as pixels rather than as a
        // sentence saying pixels exist.
        | {
            type: 'content'
            value: Array<
              | { type: 'text'; text: string }
              // The tagged `data` shape, not the bare base64 string the USER
              // message's file part still takes. A tool result's file part is
              // the newer of the two declarations, and only this form reaches
              // the Responses mapping's `input_image` branch.
              | { type: 'file'; data: { type: 'data'; data: string }; mediaType: string }
            >
          }
    }> = []
    for (const block of msg.content) {
      if (block.type === 'text') {
        userParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        userParts.push({ type: 'file', data: block.data, mediaType: block.mediaType })
      } else if (block.type === 'document') {
        userParts.push({
          type: 'file',
          data: block.data,
          mediaType: block.mediaType,
          ...(block.name ? { filename: block.name } : {}),
        })
      } else {
        const parts = typeof block.content === 'string' ? [] : block.content
        const images = parts.filter((c) => c.type === 'image')
        const value =
          typeof block.content === 'string'
            ? block.content
            : parts
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
        toolParts.push({
          type: 'tool-result',
          toolCallId: block.toolUseId,
          toolName: toolNameById.get(block.toolUseId) ?? block.toolUseId,
          // `error-text` is the right neutral shape, but the Responses
          // mapping flattens BOTH variants to a plain
          // `{ type: 'function_call_output', call_id, output }` — the flag
          // does not survive the wire, so on this lane the model could only
          // tell a denied edit from an applied one by reading the prose.
          // Anthropic's `is_error` does survive, so the two lanes disagreed.
          // Marking the text is what closes that gap without inventing a
          // field the vendor does not have.
          //
          // An image forces the `content` variant, which has no error member
          // at all — so the marker stays in the text there too, which is the
          // same trade this comment already describes.
          output:
            images.length > 0
              ? {
                  type: 'content',
                  value: [
                    {
                      type: 'text' as const,
                      text: block.isError ? markAsError(value) : value,
                    },
                    ...images.map((c) => ({
                      type: 'file' as const,
                      data: { type: 'data' as const, data: c.data },
                      mediaType: c.mediaType,
                    })),
                  ],
                }
              : block.isError
                ? { type: 'error-text', value: markAsError(value) }
                : { type: 'text', value },
        })
      }
    }
    if (userParts.length > 0) out.push({ role: 'user', content: userParts })
    if (toolParts.length > 0) out.push({ role: 'tool', content: toolParts })
  }
  return out
}
