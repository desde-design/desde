import { describe, expect, it } from 'vitest'

import { flattenSdkMessage } from './sdk-message-flatten'

describe('flattenSdkMessage', () => {
  it('returns empty output for non-object / unrelated message shapes', () => {
    expect(flattenSdkMessage(null)).toEqual({ textBlocks: [], toolUseBlocks: [], toolResults: [] })
    expect(flattenSdkMessage(undefined)).toEqual({ textBlocks: [], toolUseBlocks: [], toolResults: [] })
    expect(flattenSdkMessage('nope')).toEqual({ textBlocks: [], toolUseBlocks: [], toolResults: [] })
    expect(flattenSdkMessage({ type: 'result', subtype: 'success' })).toEqual({
      textBlocks: [],
      toolUseBlocks: [],
      toolResults: [],
    })
  })

  describe('assistant messages', () => {
    it('extracts text and tool_use blocks, tagged with original position', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: "I'll read this." },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'X.vue' } },
          ],
        },
      }
      expect(flattenSdkMessage(msg)).toEqual({
        textBlocks: [{ text: "I'll read this.", index: 0 }],
        toolUseBlocks: [{ id: 'tu_1', name: 'Read', input: { file_path: 'X.vue' }, index: 1 }],
        toolResults: [],
      })
    })

    it('preserves relative index across interleaved text/tool_use blocks', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
            { type: 'text', text: 'second' },
            { type: 'tool_use', id: 'tu_2', name: 'Write', input: {} },
          ],
        },
      }
      const flattened = flattenSdkMessage(msg)
      expect(flattened.textBlocks.map((t) => t.index)).toEqual([0, 2])
      expect(flattened.toolUseBlocks.map((t) => t.index)).toEqual([1, 3])
    })

    it('ignores tool_use blocks missing id or name', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1' }, // missing name
            { type: 'tool_use', name: 'Read' }, // missing id
          ],
        },
      }
      expect(flattenSdkMessage(msg).toolUseBlocks).toEqual([])
    })

    it('does not surface thinking blocks (adapter-only concern)', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'reasoning...', signature: 'sig' }],
        },
      }
      expect(flattenSdkMessage(msg)).toEqual({ textBlocks: [], toolUseBlocks: [], toolResults: [] })
    })

    it('handles a missing/malformed message.content gracefully', () => {
      expect(flattenSdkMessage({ type: 'assistant', message: {} })).toEqual({
        textBlocks: [],
        toolUseBlocks: [],
        toolResults: [],
      })
    })
  })

  describe('user messages — tool_result content blocks', () => {
    it('extracts an ok tool_result', () => {
      const msg = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents', is_error: false }],
        },
      }
      expect(flattenSdkMessage(msg).toolResults).toEqual([
        { toolUseId: 'tu_1', ok: true, output: 'file contents' },
      ])
    })

    it('extracts an errored tool_result and stringifies non-string content', () => {
      const msg = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: { reason: 'denied' }, is_error: true },
          ],
        },
      }
      expect(flattenSdkMessage(msg).toolResults).toEqual([
        { toolUseId: 'tu_1', ok: false, error: JSON.stringify({ reason: 'denied' }) },
      ])
    })

    it('preserves order across multiple tool_result blocks', () => {
      const msg = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'a', is_error: false },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'b', is_error: false },
          ],
        },
      }
      expect(flattenSdkMessage(msg).toolResults.map((r) => r.toolUseId)).toEqual(['tu_1', 'tu_2'])
    })
  })

  describe('user messages — tool_use_result / parent_tool_use_id fallback', () => {
    it('emits a result from the top-level fallback when no content tool_result exists', () => {
      const msg = {
        type: 'user',
        message: { content: [] },
        tool_use_result: { stdout: 'hi', code: 0 },
        parent_tool_use_id: 'tu_2',
      }
      expect(flattenSdkMessage(msg).toolResults).toEqual([
        { toolUseId: 'tu_2', ok: true, output: { stdout: 'hi', code: 0 } },
      ])
    })

    it('marks the fallback result as an error when is_error/isError is set', () => {
      const msg = {
        type: 'user',
        message: { content: [] },
        tool_use_result: { is_error: true, detail: 'boom' },
        parent_tool_use_id: 'tu_9',
      }
      expect(flattenSdkMessage(msg).toolResults).toEqual([
        { toolUseId: 'tu_9', ok: false, error: JSON.stringify({ is_error: true, detail: 'boom' }) },
      ])
    })

    it('does NOT double-count when the same id is present in both content blocks and the fallback', () => {
      const msg = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: 'ok', is_error: false }],
        },
        tool_use_result: 'fallback-should-be-ignored',
        parent_tool_use_id: 'tu_3',
      }
      const flattened = flattenSdkMessage(msg)
      expect(flattened.toolResults).toHaveLength(1)
      expect(flattened.toolResults[0]).toEqual({ toolUseId: 'tu_3', ok: true, output: 'ok' })
    })

    it('counts the fallback once when the content block refers to a DIFFERENT id', () => {
      const msg = {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a', is_error: false }],
        },
        tool_use_result: { stdout: 'b' },
        parent_tool_use_id: 'tu_2',
      }
      const flattened = flattenSdkMessage(msg)
      expect(flattened.toolResults).toHaveLength(2)
      expect(flattened.toolResults.map((r) => r.toolUseId)).toEqual(['tu_1', 'tu_2'])
    })

    it('ignores the fallback when tool_use_result is undefined or parent_tool_use_id is not a string', () => {
      expect(
        flattenSdkMessage({
          type: 'user',
          message: { content: [] },
          tool_use_result: undefined,
          parent_tool_use_id: 'tu_1',
        }).toolResults,
      ).toEqual([])
      expect(
        flattenSdkMessage({
          type: 'user',
          message: { content: [] },
          tool_use_result: { ok: true },
          parent_tool_use_id: null,
        }).toolResults,
      ).toEqual([])
    })
  })
})
