import { describe, expect, it } from 'vitest'

import {
  createNeutralEventAdapter,
  toolResultContent,
  toolResultEvent,
  toolResultMessageContent,
} from './neutral-event-adapter'

const TURN = 't1'
const take = (ev: Parameters<ReturnType<typeof createNeutralEventAdapter>['adapt']>[0]) => [
  ...createNeutralEventAdapter(TURN).adapt(ev),
]

describe('createNeutralEventAdapter', () => {
  it('maps a text delta', () => {
    expect(take({ kind: 'text_delta', delta: 'hi' })).toEqual([
      { kind: 'text_delta', turnId: TURN, delta: 'hi' },
    ])
  })

  it('maps a reasoning delta', () => {
    expect(take({ kind: 'reasoning_delta', delta: 'thinking' })).toEqual([
      { kind: 'reasoning_delta', turnId: TURN, delta: 'thinking' },
    ])
  })

  it('drops an empty delta rather than emitting a frame that renders nothing', () => {
    expect(take({ kind: 'text_delta', delta: '' })).toEqual([])
  })

  it('maps a tool_use to tool_use_start with the resolved input', () => {
    expect(take({ kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } })).toEqual([
      { kind: 'tool_use_start', turnId: TURN, toolUseId: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ])
  })

  it('maps usage', () => {
    expect(take({ kind: 'usage', inputTokens: 10, outputTokens: 3 })).toEqual([
      { kind: 'usage', turnId: TURN, inputTokens: 10, outputTokens: 3 },
    ])
  })

  it('emits nothing for message_complete, because the LOOP decides whether the turn ended', () => {
    expect(
      take({
        kind: 'message_complete',
        stopReason: 'tool_use',
        message: { role: 'assistant', content: [] },
      }),
    ).toEqual([])
  })

  it('fires tool_use_start once per id even if the provider repeats it', () => {
    const adapter = createNeutralEventAdapter(TURN)
    const ev = { kind: 'tool_use' as const, id: 'tu_1', name: 'Read', input: {} }
    expect([...adapter.adapt(ev)]).toHaveLength(1)
    expect([...adapter.adapt(ev)]).toHaveLength(0)
  })
})

describe('toolResultEvent', () => {
  it('carries the text of a successful result', () => {
    expect(
      toolResultEvent(TURN, 'tu_1', { content: [{ type: 'text', text: 'ok' }] }),
    ).toEqual({ kind: 'tool_result', turnId: TURN, toolUseId: 'tu_1', ok: true, output: 'ok' })
  })

  it('carries the message of a failed result as `error`', () => {
    expect(
      toolResultEvent(TURN, 'tu_1', { content: [{ type: 'text', text: 'denied' }], isError: true }),
    ).toEqual({ kind: 'tool_result', turnId: TURN, toolUseId: 'tu_1', ok: false, error: 'denied' })
  })
})

describe('toolResultContent', () => {
  it('names an image part rather than inlining base64 into the transcript', () => {
    expect(
      toolResultContent({
        content: [
          { type: 'text', text: 'here it is' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    ).toBe('here it is\n[image/png image returned]')
  })
})

describe('toolResultMessageContent', () => {
  it('keeps an image part as an image block, so the model sees the pixels', () => {
    expect(
      toolResultMessageContent({
        content: [
          { type: 'text', text: 'here it is' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'here it is' },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ])
  })

  it('collapses a text-only result to a plain string, as before', () => {
    expect(
      toolResultMessageContent({ content: [{ type: 'text', text: 'done' }] }),
    ).toBe('done')
  })
})
