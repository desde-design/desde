import { describe, expect, it } from 'vitest'

import type { Message } from '../llm-providers/types'
import { applyContextBudget, ELIDED_TOOL_OUTPUT } from './context-budget'

const toolResult = (id: string, size: number): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'x'.repeat(size) }],
})

const toolUse = (id: string, size: number): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'Read', input: { pad: 'a'.repeat(size) } }],
})

/** Every `tool_result` block in `messages` whose `toolUseId` names a `tool_use`
 * that no retained assistant message produces. Empty means the pairing
 * invariant `history-replay.ts` documents (every `tool_use` needs its
 * `tool_result` in the very next user message) holds for this history. */
function orphanedToolResultIds(messages: readonly Message[]): string[] {
  const produced = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const b of m.content) if (b.type === 'tool_use') produced.add(b.id)
  }
  const orphans: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'tool_result' && !produced.has(b.toolUseId)) orphans.push(b.toolUseId)
    }
  }
  return orphans
}

/**
 * A POSITIONAL check, independent of `orphanedToolResultIds` above: a
 * `tool_result` only counts as paired when it claims an id an EARLIER
 * `tool_use` produced, and each id can be claimed once. `orphanedToolResultIds`
 * cannot tell this apart from a same-valued id produced by a LATER assistant
 * message, which is exactly the gap this file's positional-pairing test
 * exercises. Returns the id of the first `tool_result` with nothing earlier
 * to pair against, or `undefined` when every one pairs.
 */
function firstUnpairedToolResult(messages: readonly Message[]): string | undefined {
  const available = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') available.add(b.id)
      continue
    }
    if (typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      if (!available.delete(b.toolUseId)) return b.toolUseId
    }
  }
  return undefined
}

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

  it('never orphans a tool_result whose tool_use was dropped, at every stopping point (I6)', () => {
    // The drop loop slices one whole message at a time with no regard for
    // tool_use / tool_result pairing. Sweeping maxChars checks the
    // invariant at every stopping point the loop can land on, not just the
    // one hand-picked value that happens to split a pair.
    const messages: Message[] = [
      toolUse('tu_0', 300),
      toolResult('tu_0', 300),
      toolUse('tu_1', 300),
      toolResult('tu_1', 300),
      toolUse('tu_2', 300),
      toolResult('tu_2', 300),
      { role: 'user', content: [{ type: 'text', text: 'the turn the user just sent' }] },
    ]
    const total = messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
    for (let max = 50; max < total; max += 37) {
      const out = applyContextBudget(messages, { maxChars: max })
      expect(orphanedToolResultIds(out.messages)).toEqual([])
      expect(out.messages[0]!.role, `maxChars=${max}`).toBe('user')
      for (const m of out.messages) {
        expect(typeof m.content === 'string' || m.content.length > 0).toBe(true)
      }
    }
  })

  it('drops a user message that empties out once its only tool_result is orphaned', () => {
    const messages: Message[] = [
      toolUse('tu_0', 10),
      toolResult('tu_0', 800),
      { role: 'user', content: [{ type: 'text', text: 'final ask' }] },
    ]
    const out = applyContextBudget(messages, { maxChars: 100 })
    expect(orphanedToolResultIds(out.messages)).toEqual([])
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'final ask' }] }])
  })

  it('does not let a tool_result survive on an id a LATER tool_use reuses, once its own tool_use was dropped', () => {
    // call_1 is produced twice: once by the message the drop loop removes,
    // once by a message that survives. A global "was this id ever produced"
    // set cannot tell the two apart, so it would let the FIRST tool_result
    // (the orphan) survive on the strength of the SECOND, later tool_use.
    // Pairing has to be positional: a tool_result only pairs with the
    // tool_use immediately before it.
    const messages: Message[] = [
      toolUse('call_1', 700),
      toolResult('call_1', 20),
      toolUse('call_1', 20),
      toolResult('call_1', 20),
      { role: 'user', content: [{ type: 'text', text: 'final ask' }] },
    ]
    const out = applyContextBudget(messages, { maxChars: 300 })
    expect(firstUnpairedToolResult(out.messages)).toBeUndefined()
    // The surviving `tool_use` / `tool_result` pair went too, because the pair
    // would have put an ASSISTANT message at the head of the request and
    // Anthropic refuses that (see the leading-user case below). Before that
    // rule existed this case ended at
    // `[toolUse('call_1', 20), <elided tool_result>, 'final ask']`, which is
    // correctly paired and still a 400.
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'final ask' }] },
    ])
  })

  it('never leaves an ASSISTANT message at the head, which Anthropic rejects', () => {
    // 2026-09-04 adversarial review, P2-3. The drop loop slices on size alone,
    // so roughly half its stopping points left the request starting with an
    // assistant message. Anthropic's Messages API answers that with
    // `messages: first message must use the "user" role`; OpenAI accepts it,
    // so the rule is Anthropic's and both lanes now satisfy it. Anthropic
    // reaches this runtime through `EDITOR_CHAT_RUNTIME_OVERRIDE=neutral`, and
    // the 400 would be permanent for the session, because every later turn
    // replays the same over-budget history.
    const messages: Message[] = []
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `ask ${i} ${'u'.repeat(400)}` }] })
      messages.push(toolUse(`tu_${i}`, 400))
      messages.push(toolResult(`tu_${i}`, 400))
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `said ${i}` }] })
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'the turn the user just sent' }] })

    const total = messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
    let sawTrim = false
    for (let max = 200; max < total; max += 311) {
      const out = applyContextBudget(messages, { maxChars: max })
      if (out.trimmed) sawTrim = true
      expect(out.messages[0]!.role, `maxChars=${max}`).toBe('user')
      // The other two invariants must survive the new slicing.
      expect(orphanedToolResultIds(out.messages), `maxChars=${max}`).toEqual([])
      expect(firstUnpairedToolResult(out.messages), `maxChars=${max}`).toBeUndefined()
      for (const m of out.messages) {
        expect(typeof m.content === 'string' || m.content.length > 0).toBe(true)
      }
    }
    expect(sawTrim).toBe(true)
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
