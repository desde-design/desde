/**
 * Vendor-neutral LLM provider interface. Every LLM call in the
 * editor (Tier 2 repair, Tier 3 free-form agent, the LLM-mediated
 * patch service, and the upcoming chat orchestrator) goes through an
 * `LLMProvider` so the active vendor (Anthropic, OpenAI/Codex, others)
 * is swappable via config without changing call sites.
 *
 * Phase 0 only defines `complete()` — the three existing single-shot
 * services migrate to it without behavior change. `streamConversation()`
 * lands in Phase 1 when the chat orchestrator needs it, and the
 * interface gets extended at that point.
 *
 * Provider-agnostic tool/schema shapes (JSON Schema only). Vendor-
 * specific knobs (Anthropic prompt-cache hints, OpenAI reasoning
 * effort, etc.) hide behind the per-provider impl with sensible
 * defaults; callers express their intent in the neutral shape below.
 */

/**
 * Provider-specific hint that this block is stable across calls and a
 * good cache breakpoint. Honored by Anthropic via `cache_control:
 * ephemeral`; silently ignored by providers without first-class prompt
 * caching. Setting it on a volatile block is harmless — it just won't
 * cache.
 */
export type CacheHint = 'ephemeral'

export interface TextBlock {
  type: 'text'
  text: string
  cacheHint?: CacheHint
}

export type ContentBlock = TextBlock

/**
 * System and user content accept either a plain string (the common
 * case) or an array of blocks (when callers need per-block cache
 * hints — e.g. `apply-llm-patch` keys project-style context as a stable
 * prefix and the per-save mutations payload as volatile).
 */
export type SystemContent = string | readonly ContentBlock[]
export type UserContent = string | readonly ContentBlock[]

/**
 * Vendor-neutral response-format directive. `json_schema` means the
 * provider MUST constrain output to valid JSON matching the schema; the
 * provider impl translates to native (Anthropic `output_config.format`,
 * OpenAI `response_format.json_schema`, etc.).
 *
 * Schema is plain JSON Schema (Draft 2020-12 compatible subset). Don't
 * embed vendor-specific keywords here.
 */
export type ResponseFormat =
  | { kind: 'text' }
  | {
      kind: 'json_schema'
      schema: Record<string, unknown>
      /** Optional name surfaced to providers that require one (OpenAI). */
      name?: string
    }

export interface CompleteOpts {
  system: SystemContent
  user: UserContent
  /**
   * Model id. If omitted, the provider falls back to its `defaultModel`.
   * Call sites that pin a specific model (e.g. `apply-llm-patch` uses
   * Opus while Tier 2/3 use Sonnet) should pass this explicitly.
   */
  model?: string
  /** Max output tokens. Provider applies a sensible default if omitted. */
  maxTokens?: number
  /** Defaults to `{ kind: 'text' }` if omitted. */
  responseFormat?: ResponseFormat
  /** Aborts the underlying request when fired. */
  signal?: AbortSignal
}

/**
 * Neutral stop reasons. Each value carries semantics that map to at
 * least one mainstream provider; vendor-specific reasons should be
 * mapped to the closest neutral value rather than added here.
 *
 * - `end_turn` — model finished naturally.
 * - `max_tokens` — output capped by `maxTokens`.
 * - `stop_sequence` — hit a configured stop sequence.
 * - `tool_use` — model wants to call a tool (Phase 1 loop continues).
 * - `refusal` — model declined on safety/policy grounds. NOT retriable
 *   — surfacing this distinctly lets the chat UI show a "model declined"
 *   message instead of an opaque error.
 * - `pause_turn` — model paused mid-turn and expects to be resumed
 *   (Anthropic's pause-turn mechanism for very long generations).
 *   Phase 1 streaming will need to handle this; Phase 0 callers treat
 *   it as "no result, retry."
 * - `error` — provider returned a stop reason we don't recognize.
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'pause_turn'
  | 'error'

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface CompleteResult {
  /**
   * Concatenated text from the response. For `json_schema` responses
   * this is the JSON string the model produced.
   */
  text: string
  /**
   * Parsed JSON when `responseFormat.kind === 'json_schema'` AND the
   * model produced valid JSON. Undefined for text responses or on
   * parse failure (caller decides how to surface bad JSON; the
   * provider does not throw on parse error so callers can include the
   * raw text in their diagnostics).
   */
  parsed?: unknown
  usage?: Usage
  stopReason: StopReason
}

// ─── Streaming + tool-use surface (Phase 1) ─────────────────────────

/**
 * Vendor-neutral tool definition. Schemas are plain JSON Schema —
 * the provider impl translates to native (Anthropic `tools[].input_schema`,
 * OpenAI `functions[].parameters`, etc.).
 */
export interface ToolDef {
  /** Tool name. Must be unique within a call. */
  name: string
  /** One-line description surfaced to the model in the tool registry. */
  description: string
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultContent {
  type: 'tool_result'
  toolUseId: string
  /**
   * Either a plain string OR a list of text blocks. The Anthropic
   * provider passes either through; other providers may stringify
   * non-strings.
   */
  content: string | readonly TextContent[]
  /** Set to true if the tool failed (so the model knows). */
  isError?: boolean
}

export type AssistantContent = TextContent | ToolUseContent
export type ChatUserContent = TextContent | ToolResultContent

/**
 * A turn in the conversation. Roles alternate user → assistant → user
 * → ... The orchestrator builds this array, appending tool_result
 * content as a user message after each tool execution.
 *
 * Distinct from `UserContent` / `SystemContent` used by `complete()` —
 * those are single-shot text payloads; this one carries tool results.
 */
export type Message =
  | { role: 'user'; content: readonly ChatUserContent[] | string }
  | { role: 'assistant'; content: readonly AssistantContent[] }

export interface StreamOpts {
  system: SystemContent
  messages: readonly Message[]
  tools: readonly ToolDef[]
  model?: string
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Provider events emitted by `streamConversation`. Designed for an
 * append-only consumer: each event is independently meaningful, no
 * back-references. Text and tool-use blocks can interleave; the
 * orchestrator preserves their order.
 *
 * - `text_delta` — incremental text from the assistant. May be empty.
 * - `tool_use` — a complete tool call (id, name, parsed input). Emitted
 *   only after the model finishes generating the call's JSON. Earlier
 *   delta events are buffered internally; UIs that want a "tool is
 *   forming…" indicator can use `tool_use_started` / `tool_use_partial`
 *   (added in a later phase if needed).
 * - `usage` — token usage so far (may fire mid-stream and at end).
 * - `message_complete` — terminal event; carries the stop reason and
 *   the final assistant message (the full sequence of content blocks
 *   the orchestrator should append to `messages` for the next turn).
 */
export type ProviderEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | {
      kind: 'message_complete'
      stopReason: StopReason
      /** Full assistant message reassembled from the stream — append to messages for the next turn. */
      message: { role: 'assistant'; content: readonly AssistantContent[] }
      /** Final usage. */
      usage?: Usage
      /** Vendor-specific reason text when stopReason is 'error' or 'refusal'. */
      vendorStopReason?: string
    }

/**
 * Subset of `LLMProvider` that only exposes single-shot completion.
 * The three Phase 0 migrated services (Tier 2 repair, Tier 3 agent,
 * apply-llm-patch) accept this narrower shape so test fakes don't
 * need to stub `streamConversation` and so a future "complete-only"
 * provider can satisfy them.
 *
 * `streamComplete` is optional — callers that need token-level streaming
 * pass an `onTextDelta` callback and check for the method's presence
 * (apply-llm-patch falls back to `complete()` when unavailable, so tests
 * with bare CompletionProvider fakes still pass).
 */
export type CompletionProvider = Pick<
  LLMProvider,
  'name' | 'defaultModel' | 'complete'
> & { streamComplete?: LLMProvider['streamComplete'] }

/**
 * The interface every LLM provider implements. Phase 1 surface adds
 * `streamConversation` for the chat orchestrator's tool-use loop.
 */
export interface LLMProvider {
  /** Stable id for logs and config. e.g. "anthropic", "openai". */
  readonly name: string
  /**
   * Used when `CompleteOpts.model` is omitted. Each call site that
   * pins its own model passes it explicitly, so this is mainly the
   * chat orchestrator's default (Phase 1).
   */
  readonly defaultModel: string
  complete(opts: CompleteOpts): Promise<CompleteResult>
  /**
   * Streaming peer of `complete()` — same input/output shape, but fires
   * `onTextDelta` for each token as it arrives. Used by `apply-llm-patch`
   * so the save dialog can render the model's response live instead of
   * blanking for 5–95s. The returned `CompleteResult` is the final
   * reassembled value (same shape `complete()` returns); callers that
   * only care about the final value can ignore the delta callback.
   *
   * OPTIONAL: providers without real streaming support omit this and
   * callers fall back to `complete()`. Don't ship a no-op stub —
   * `apply-llm-patch` uses the method's presence as the signal to
   * request SSE on the route, which would otherwise show a misleading
   * "streaming" UX with text arriving in one chunk at the end.
   */
  streamComplete?(
    opts: CompleteOpts,
    onTextDelta?: (delta: string) => void,
  ): Promise<CompleteResult>
  /**
   * Streams one model turn. Emits events as they arrive. Terminates
   * with a single `message_complete` event carrying the stop reason
   * and the reassembled assistant message. If the stop reason is
   * `tool_use`, the orchestrator should execute the tools and start a
   * new stream with the results appended as user content.
   */
  streamConversation(opts: StreamOpts): AsyncIterable<ProviderEvent>
}
