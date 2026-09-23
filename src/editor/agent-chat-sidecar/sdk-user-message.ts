/**
 * The SDK-typed half of the turn input channel: mapping the channel's neutral
 * `TurnInputMessage` to the `SDKUserMessage` shape `query()` needs, and
 * reading an assistant-message boundary off a raw SDK message.
 *
 * Lives here, not in `agent-chat/turn-input-channel.ts`, because the channel
 * itself is SDK-free — it yields `TurnInputMessage`, a plain `{text, images}`
 * shape, so `agent-chat/` never imports `@anthropic-ai/claude-agent-sdk`. Only
 * the SDK lane (this sidecar) needs the SDK's own message envelope, so the
 * mapping lives with its one caller, `run-chat-turn-sidecar.ts`.
 */

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'

import type { TurnInputMessage } from '../agent-chat/turn-input-channel'
import type { ModelImageContent } from '../agent-chat/media-content'

/**
 * The id of the assistant message an SDK message belongs to, when that message
 * can mark a NEW inference request — otherwise null.
 *
 * Lives here because it IS the evidence rule that
 * `TurnInputChannel.takeUndeliveredSteers` depends on, and splitting the rule
 * from the accounting it feeds is how the previous version went wrong.
 *
 * Two SDK shapes are read, and reading both is deliberate:
 *
 *  - `stream_event` with `event.type === 'message_start'` — the earliest
 *    signal, and the only one that arrives before a long message finishes.
 *    Present only because the turn runtime sets `includePartialMessages: true`.
 *  - a completed `assistant` message — the backstop for any message the SDK
 *    surfaces without partials (an error message, a replayed one, a future
 *    non-streaming path). Without it such a turn would look request-free and
 *    every steer on it would be resubmitted.
 *
 * Reading both costs nothing because the caller de-duplicates by id: the
 * `message_start` and the completed `assistant` for one message share an id and
 * count once. Every OTHER `stream_event` (`content_block_delta` and friends) is
 * a partial of a message already counted and returns null here — that is the
 * defect this function exists to close.
 *
 * Subagent output is excluded by `parent_tool_use_id !== null` (the SDK's
 * `forwardSubagentText` option describes exactly this tagging). A subagent's
 * request is assembled from the SUBAGENT's context, which never contains a
 * steer sent to the main loop, so counting it would call a steer delivered on
 * evidence about a different conversation. Excluding it can only cause a
 * resubmit, which is the direction to be wrong in.
 */
export function readAssistantMessageBoundaryId(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    return msg.parent_tool_use_id === null ? msg.message.id : null
  }
  if (msg.type === 'stream_event' && msg.event.type === 'message_start') {
    return msg.parent_tool_use_id === null ? msg.event.message.id : null
  }
  return null
}

/**
 * Reshape a validated media-content image into the Anthropic
 * `ImageBlockParam` a user message carries. `media-content.ts` already
 * produced the MCP image-block shape (`{type:'image', data, mimeType}`)
 * with the base64 payload stripped of its `data:` prefix; here we map it
 * to the base64-source form the Messages API expects on a USER message.
 * Same bytes, different envelope — there is no second image path.
 */
function toImageBlockParam(
  image: ModelImageContent,
): Extract<MessageParam['content'], unknown[]>[number] {
  return {
    type: 'image',
    source: {
      type: 'base64',
      // media-content only ever emits SUPPORTED_IMAGE_MIME_TYPES, which is
      // exactly the set Base64ImageSource['media_type'] accepts.
      media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: image.data,
    },
  }
}

/**
 * Build one `SDKUserMessage`: the text followed by one vision block per image.
 *
 * The empty-text omission is load-bearing, not tidiness — the Messages API
 * rejects `{type:'text', text:''}`, and an image-only message (the user
 * attached a screenshot with no prompt) is a real turn we have to be able to
 * send.
 */
export function buildUserMessage(
  text: string,
  images: ModelImageContent[] | undefined,
): SDKUserMessage {
  const content: Extract<MessageParam['content'], unknown[]> = [
    ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
    ...(images ?? []).map(toImageBlockParam),
  ]
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
}

/**
 * Wrap the channel's neutral stream as the `query({ prompt })` the SDK
 * expects: one `SDKUserMessage` per `TurnInputMessage`, built the same way the
 * turn's opening message and every steer always have been.
 */
export async function* toSdkPrompt(
  stream: AsyncGenerator<TurnInputMessage>,
): AsyncGenerator<SDKUserMessage> {
  for await (const m of stream) {
    yield buildUserMessage(m.text, m.images)
  }
}
