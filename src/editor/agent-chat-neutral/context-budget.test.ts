import { describe, expect, it } from 'vitest'

import type { Message } from '../llm-providers/types'
import { applyContextBudget, ELIDED_TOOL_OUTPUT } from './context-budget'

const toolResult = (id: string, size: number): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'x'.repeat(size) }],
})

describe('applyContextBudget', () => {
  it('leaves a small history untouched and says so', () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    expect(applyContextBudget(messages, { maxChars: 1000 })).toEqual({
      messages,
      trimmed: false,
    })
  })

  it('elides the OLDEST tool output first, keeping every assistant text turn', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
      toolResult('tu_old', 900),
      { role: 'assistant', content: [{ type: 'text', text: 'an answer worth keeping' }] },
      toolResult('tu_new', 900),
    ]
    const out = applyContextBudget(messages, { maxChars: 1200 })
    expect(out.trimmed).toBe(true)
    expect((out.messages[1].content as unknown as Array<{ content: string }>)[0].content).toBe(
      ELIDED_TOOL_OUTPUT,
    )
    expect((out.messages[3].content as unknown as Array<{ content: string }>)[0].content).toHaveLength(900)
    expect(out.messages[2]).toEqual(messages[2])
  })

  it('drops whole leading turns only after every tool output is already elided', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(800) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(800) }] },
      { role: 'user', content: [{ type: 'text', text: 'c'.repeat(200) }] },
    ]
    const out = applyContextBudget(messages, { maxChars: 400 })
    expect(out.trimmed).toBe(true)
    expect(out.messages).toHaveLength(1)
    expect((out.messages[0].content as unknown as Array<{ text: string }>)[0].text).toBe('c'.repeat(200))
  })

  it('never drops the final message, which is the turn the user just sent', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(5000) }] },
    ]
    const out = applyContextBudget(messages, { maxChars: 10 })
    expect(out.messages).toHaveLength(1)
  })

  it('returns a notice naming what was dropped, for the model to read', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(800) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(800) }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ]
    const out = applyContextBudget(messages, { maxChars: 200 })
    expect(out.notice).toMatch(/earlier part of this conversation/)
  })
})
