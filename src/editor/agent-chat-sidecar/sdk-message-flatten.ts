/**
 * Shared flattener for the SDK's raw `SDKMessage` shape — the single walk
 * two independent call sites used to hand-roll:
 *
 *   - `capturePersistenceState` (`run-chat-turn-sdk.ts`) — builds the
 *     persisted `ChatTurn.assistantContent` / `ChatTurn.toolResults`.
 *   - `fromAssistant` / `fromUser` (`sdk-event-adapter.ts`) — builds the
 *     live `ChatStreamEvent` SSE sequence.
 *
 * Both walk the same two message shapes: an `assistant` message's
 * `message.content` blocks (text + tool_use), and a `user` message's
 * `tool_result` content blocks PLUS the `tool_use_result`/
 * `parent_tool_use_id` fallback (built-in-tool results that arrive outside
 * content blocks — Codex round-2 SF3) with a dedupe guard so a result
 * present in both places isn't double-counted.
 *
 * `flattenSdkMessage` is a pure, stateless function — the dedupe guard is
 * scoped to a single message (a `Set` local to one `user`-message walk),
 * not the turn/stream, so no per-turn instance is needed. Each caller calls
 * it once per SDKMessage, exactly matching today's per-message call sites,
 * and maps the neutral output into its own shape.
 *
 * Deliberately OUT of scope (adapter-only concerns, not shared): `thinking`
 * blocks / `reasoning_delta` streaming state. Persistence never reads
 * assistant text via streaming deltas (it only sees the final message), so
 * it doesn't need the adapter's stream-vs-fallback thinking dedup; the
 * adapter's `AdapterState.reasoningStreamed` stays local to
 * `sdk-event-adapter.ts`.
 */

/** A flattened assistant text block, tagged with its position in the
 * original `message.content` array so callers that need cross-type
 * ordering (text interleaved with tool_use) can reconstruct it. */
export interface FlattenedTextBlock {
  text: string
  index: number
}

/** A flattened assistant tool_use block, tagged like {@link FlattenedTextBlock}. */
export interface FlattenedToolUseBlock {
  id: string
  name: string
  input: unknown
  index: number
}

/** A flattened tool result — either from a `tool_result` content block on
 * a `user` message, or the top-level `tool_use_result`/`parent_tool_use_id`
 * fallback. `error` is already stringified (matches both callers' existing
 * `stringifyContent`/`stringifyToolErr`, which are identical). */
export interface FlattenedToolResult {
  toolUseId: string
  ok: boolean
  output?: unknown
  error?: string
}

export interface FlattenedSdkMessage {
  textBlocks: FlattenedTextBlock[]
  toolUseBlocks: FlattenedToolUseBlock[]
  toolResults: FlattenedToolResult[]
}

const EMPTY_FLATTENED: FlattenedSdkMessage = {
  textBlocks: [],
  toolUseBlocks: [],
  toolResults: [],
}

/**
 * Flatten a single raw SDK message into text/tool_use/tool_result pieces.
 * Accepts `unknown` (both callers receive loosely-typed SDK message unions
 * and narrow defensively rather than trusting the SDK's declared types).
 */
export function flattenSdkMessage(msg: unknown): FlattenedSdkMessage {
  if (!msg || typeof msg !== 'object') {
    return EMPTY_FLATTENED
  }
  const m = msg as {
    type?: string
    message?: unknown
    tool_use_result?: unknown
    parent_tool_use_id?: unknown
  }

  if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
    return flattenAssistantMessage(m.message)
  }

  if (m.type === 'user' && m.message && typeof m.message === 'object') {
    return flattenUserMessage(m.message, m.tool_use_result, m.parent_tool_use_id)
  }

  return EMPTY_FLATTENED
}

function flattenAssistantMessage(message: unknown): FlattenedSdkMessage {
  const textBlocks: FlattenedTextBlock[] = []
  const toolUseBlocks: FlattenedToolUseBlock[] = []
  const blocks = ((message as { content?: unknown[] }).content ?? []) as Array<{
    type?: string
    text?: string
    id?: string
    name?: string
    input?: unknown
  }>
  blocks.forEach((block, index) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push({ text: block.text, index })
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      toolUseBlocks.push({ id: block.id, name: block.name, input: block.input, index })
    }
  })
  return { textBlocks, toolUseBlocks, toolResults: [] }
}

function flattenUserMessage(
  message: unknown,
  topLevelToolUseResult: unknown,
  parentToolUseId: unknown,
): FlattenedSdkMessage {
  const toolResults: FlattenedToolResult[] = []
  const recorded = new Set<string>()
  const content = (message as { content?: unknown }).content
  if (Array.isArray(content)) {
    for (const raw of content) {
      const block = raw as {
        type?: string
        tool_use_id?: string
        content?: unknown
        is_error?: boolean
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const isError = block.is_error === true
        toolResults.push(
          isError
            ? { toolUseId: block.tool_use_id, ok: false, error: stringifyToolResultContent(block.content) }
            : { toolUseId: block.tool_use_id, ok: true, output: block.content },
        )
        recorded.add(block.tool_use_id)
      }
    }
  }

  // Fallback: top-level `tool_use_result` correlated by
  // `parent_tool_use_id`. Without this, built-in tool results can
  // disappear when the user echo lacks tool_result content blocks
  // (Codex round-2 SF3).
  if (
    topLevelToolUseResult !== undefined &&
    typeof parentToolUseId === 'string' &&
    !recorded.has(parentToolUseId)
  ) {
    const isError = isToolResultError(topLevelToolUseResult)
    toolResults.push(
      isError
        ? { toolUseId: parentToolUseId, ok: false, error: stringifyToolResultContent(topLevelToolUseResult) }
        : { toolUseId: parentToolUseId, ok: true, output: topLevelToolUseResult },
    )
  }

  return { textBlocks: [], toolUseBlocks: [], toolResults }
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const r = result as { is_error?: unknown; isError?: unknown }
  return r.is_error === true || r.isError === true
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}
