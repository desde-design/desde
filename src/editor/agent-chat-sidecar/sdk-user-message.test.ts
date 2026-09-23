/**
 * Unit coverage for the SDK-typed mapping the turn input channel handed off
 * to this sidecar: `buildUserMessage` (channel message → `SDKUserMessage`)
 * and `readAssistantMessageBoundaryId` (raw SDK message → new-request id).
 *
 * These used to be colocated with `TurnInputChannel` in
 * `agent-chat/turn-input-channel.test.ts`; they moved here along with the
 * functions themselves so `agent-chat/` stays SDK-free — see
 * `sdk-user-message.ts`'s module doc.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'

import { buildUserMessage, readAssistantMessageBoundaryId, toSdkPrompt } from './sdk-user-message'

/**
 * Narrow an SDK-message-shaped literal to `SDKMessage`.
 *
 * A real `BetaMessage` carries a dozen fields (usage, model, container, …) that
 * `readAssistantMessageBoundaryId` never reads, and spelling them out would
 * make each case unreadable without testing anything more. The cast is scoped
 * to this helper so no test body carries one.
 */
function asSdkMessage(shape: Record<string, unknown>): SDKMessage {
  return shape as unknown as SDKMessage
}

describe('buildUserMessage', () => {
  it('builds a text-only message', () => {
    const msg = buildUserMessage('hi', undefined)

    expect(msg).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    })
  })

  it('omits the empty text block for an image-only message', () => {
    // The Messages API rejects `{type:'text', text:''}`. An image-only turn
    // (the user attached a screenshot with no prompt) is a real turn we have
    // to be able to send, so the text block is dropped rather than sent empty.
    const msg = buildUserMessage('', [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])

    expect(msg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('keeps the text block ahead of the images when both are present', () => {
    const msg = buildUserMessage('match this', [
      { type: 'image', data: 'CCCC', mimeType: 'image/webp' },
    ])

    expect(msg.message.content).toEqual([
      { type: 'text', text: 'match this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'CCCC' } },
    ])
  })

  it('maps multiple images in order', () => {
    const msg = buildUserMessage('', [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
    ])

    expect(msg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ])
  })
})

describe('toSdkPrompt', () => {
  it('maps each channel message to an SDKUserMessage, in order', async () => {
    async function* stream() {
      yield { text: 'first' }
      yield { text: 'look', images: [{ type: 'image' as const, data: 'DDDD', mimeType: 'image/png' as const }] }
    }

    const out: unknown[] = []
    for await (const msg of toSdkPrompt(stream())) out.push(msg)

    expect(out).toEqual([
      buildUserMessage('first', undefined),
      buildUserMessage('look', [{ type: 'image', data: 'DDDD', mimeType: 'image/png' }]),
    ])
  })
})

describe('readAssistantMessageBoundaryId', () => {
  it('reads the id off a message_start stream event', () => {
    expect(
      readAssistantMessageBoundaryId(
        asSdkMessage({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'msg_01' } },
        }),
      ),
    ).toBe('msg_01')
  })

  it('reads the id off a completed assistant message', () => {
    // The backstop for a message the SDK surfaces without partials. Same id
    // as its own `message_start`, so the channel counts the pair once.
    expect(
      readAssistantMessageBoundaryId(
        asSdkMessage({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'msg_01' },
        }),
      ),
    ).toBe('msg_01')
  })

  it('returns null for every other stream event — this IS the defect', () => {
    // A token delta is a partial of a message already counted. Treating it
    // as a boundary is exactly what made the evidential half inert.
    for (const type of [
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]) {
      expect(
        readAssistantMessageBoundaryId(
          asSdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type } }),
        ),
      ).toBeNull()
    }
  })

  it('returns null for subagent output, on both shapes', () => {
    // A subagent's request is built from the SUBAGENT's context, which never
    // holds a steer sent to the main loop. Excluding it can only cause a
    // resubmit — the direction to be wrong in.
    expect(
      readAssistantMessageBoundaryId(
        asSdkMessage({
          type: 'assistant',
          parent_tool_use_id: 'toolu_task_01',
          message: { id: 'msg_sub' },
        }),
      ),
    ).toBeNull()
    expect(
      readAssistantMessageBoundaryId(
        asSdkMessage({
          type: 'stream_event',
          parent_tool_use_id: 'toolu_task_01',
          event: { type: 'message_start', message: { id: 'msg_sub' } },
        }),
      ),
    ).toBeNull()
  })

  it('returns null for non-assistant messages', () => {
    for (const type of ['user', 'result', 'system']) {
      expect(
        readAssistantMessageBoundaryId(asSdkMessage({ type, parent_tool_use_id: null })),
      ).toBeNull()
    }
  })
})
