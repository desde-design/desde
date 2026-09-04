import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeEmptySession, type ChatSession, type ChatTurn } from '../agent-chat/types'
import { replayHistory } from './history-replay'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-replay-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function turn(over: Partial<ChatTurn>): ChatTurn {
  return {
    id: over.id ?? 't',
    startedAt: '2026-09-03T00:00:00.000Z',
    userMessage: 'ask',
    assistantContent: [],
    toolResults: {},
    editProposals: [],
    ...over,
  }
}

function sessionWith(turns: ChatTurn[]): ChatSession {
  return { ...makeEmptySession('p1'), turns }
}

describe('replayHistory', () => {
  it('turns one exchange into a user message and an assistant message', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([
        turn({ userMessage: 'make it blue', assistantContent: [{ type: 'text', text: 'done' }] }),
      ]),
    })
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'make it blue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])
  })

  it('pairs every tool_use with its result, in call order', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([
        turn({
          assistantContent: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: { file_path: 'a.vue' } },
          ],
          toolResults: { tu_1: { ok: true, output: '1\t<div/>' } },
        }),
      ]),
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '1\t<div/>' }],
    })
  })

  it('marks a failed tool result as an error, so the model knows it failed', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([
        turn({
          assistantContent: [{ type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: {} }],
          toolResults: { tu_1: { ok: false, error: 'denied' } },
        }),
      ]),
    })
    expect(messages[2].content[0]).toMatchObject({ isError: true, content: 'denied' })
  })

  it('synthesizes a result for a tool_use that never got one, because the API rejects an orphan', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([
        turn({
          assistantContent: [{ type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: {} }],
          toolResults: {},
        }),
      ]),
    })
    expect(messages[2].content[0]).toMatchObject({
      toolUseId: 'tu_1',
      isError: true,
    })
  })

  it('replays steers as their own user messages, in recorded order', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([
        turn({
          userMessage: 'first',
          assistantContent: [{ type: 'text', text: 'working' }],
          steers: [{ text: 'actually the sidebar', afterAssistantBlocks: 1 }],
        }),
      ]),
    })
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'actually the sidebar' }],
    })
  })

  it('drops an empty assistant message rather than sending one the API rejects', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([turn({ userMessage: 'hi', assistantContent: [] })]),
    })
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('keeps the last N turns plus the session s first user message', async () => {
    const turns = Array.from({ length: 25 }, (_, i) =>
      turn({ id: `t${i}`, userMessage: `msg ${i}`, assistantContent: [{ type: 'text', text: `a ${i}` }] }),
    )
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith(turns),
      maxTurns: 5,
    })
    const texts = messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.content as unknown as Array<{ text?: string }>)[0].text)
    expect(texts[0]).toBe('msg 0')
    expect(texts).toContain('msg 24')
    expect(texts).not.toContain('msg 10')
  })

  it('reads the archive sidecar when the head file has fewer turns than the window', async () => {
    mkdirSync(join(root, '.desde/chat-sessions'), { recursive: true })
    writeFileSync(
      join(root, '.desde/chat-sessions/p1.archive.jsonl'),
      `${JSON.stringify(turn({ id: 'old', userMessage: 'ancient', assistantContent: [{ type: 'text', text: 'ok' }] }))}\n`,
      'utf8',
    )
    const messages = await replayHistory({
      repoRoot: root,
      session: sessionWith([turn({ id: 'new', userMessage: 'recent' })]),
      maxTurns: 5,
    })
    const texts = messages.map((m) => JSON.stringify(m.content))
    expect(texts.join()).toContain('ancient')
  })
})
