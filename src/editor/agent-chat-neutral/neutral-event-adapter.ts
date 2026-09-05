/**
 * `ProviderEvent` to `ChatStreamEvent`. The mirror of `sdk-event-adapter.ts`,
 * with a different input shape and the SAME output contract.
 *
 * What it deliberately does NOT emit:
 *
 *  - `turn_start`, `turn_complete`, `error`: the LOOP owns the turn's
 *    lifecycle, and a `message_complete` with `stopReason: 'tool_use'` is the
 *    middle of a turn, not the end of one. An adapter that guessed would end
 *    the turn on the first tool call.
 *  - `edit_proposed` and `edit_overwrite_warning`: those come out of the
 *    permission gate and `brokeredWrite`, exactly as they do on the SDK lane.
 *  - `rate_limit_warning`: Anthropic-only by decision. Its fields model
 *    Anthropic's subscription overage pool and its banner says "this Claude
 *    account". See `ANTHROPIC_ONLY_EVENT_KINDS` in `chat-stream-events.ts`.
 */

import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import type { ToolHandlerResult } from '../agent-chat/tool-spec'
import type {
  ImageContent,
  ProviderEvent,
  TextContent,
} from '../llm-providers/types'

export interface NeutralEventAdapter {
  adapt(ev: ProviderEvent): Iterable<ChatStreamEvent>
}

/**
 * Per-turn adapter. The only state is the set of tool-use ids already
 * announced, so a provider that re-emits a completed call cannot make the UI
 * render the same disclosure twice.
 */
export function createNeutralEventAdapter(turnId: string): NeutralEventAdapter {
  const announced = new Set<string>()
  return {
    *adapt(ev: ProviderEvent): Generator<ChatStreamEvent> {
      switch (ev.kind) {
        case 'text_delta':
          if (ev.delta.length > 0) yield { kind: 'text_delta', turnId, delta: ev.delta }
          return
        case 'reasoning_delta':
          if (ev.delta.length > 0) yield { kind: 'reasoning_delta', turnId, delta: ev.delta }
          return
        case 'tool_use':
          if (announced.has(ev.id)) return
          announced.add(ev.id)
          yield {
            kind: 'tool_use_start',
            turnId,
            toolUseId: ev.id,
            name: ev.name,
            input: ev.input,
          }
          return
        case 'usage':
          yield {
            kind: 'usage',
            turnId,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
          }
          return
        case 'message_complete':
          // The loop decides. See the module doc.
          return
      }
    },
  }
}

/**
 * Flatten a handler result into the text the CLIENT sees — the `tool_result`
 * stream frame and the persisted transcript.
 *
 * An image part is NAMED rather than inlined, because putting base64 in the
 * SSE frame would push megabytes through the chat UI for no gain. The pixels
 * reach the MODEL by the other function below.
 */
export function toolResultContent(result: ToolHandlerResult): string {
  return result.content
    .map((part) =>
      part.type === 'text' ? part.text : `[${part.mimeType} image returned]`,
    )
    .join('\n')
}

/**
 * The same result, shaped for the `tool_result` message sent to the MODEL.
 *
 * Text-only results collapse to a plain string, which is what every provider
 * handled before this existed and what keeps the wire byte-identical for the
 * overwhelmingly common case. A result carrying an image keeps its parts, so
 * the model receives the picture.
 *
 * This used to be the same function as {@link toolResultContent}, and that was
 * the whole defect: `capture_screenshot` is the agent's only sight of the
 * running prototype, and on this lane the model was handed the sentence
 * "[image/png image returned]" and asked to judge what it showed. The failure
 * mode was confabulation, not an error.
 */
export function toolResultMessageContent(
  result: ToolHandlerResult,
): string | readonly (TextContent | ImageContent)[] {
  if (!result.content.some((part) => part.type === 'image')) {
    return toolResultContent(result)
  }
  return result.content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image' as const, mediaType: part.mimeType, data: part.data },
  )
}

export function toolResultEvent(
  turnId: string,
  toolUseId: string,
  result: ToolHandlerResult,
): ChatStreamEvent {
  const text = toolResultContent(result)
  return result.isError === true
    ? { kind: 'tool_result', turnId, toolUseId, ok: false, error: text }
    : { kind: 'tool_result', turnId, toolUseId, ok: true, output: text }
}
