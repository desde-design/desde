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

  it('replays server tool blocks inside the assistant message, never as a user tool_result', async () => {
    const fetched = { type: 'web_fetch_result', url: 'https://example.com/', content: { title: 'Example Domain' } }
    const messages = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([
        turn({
          userMessage: 'fetch it',
          assistantContent: [
            { type: 'text', text: 'Fetching.' },
            {
              type: 'server_tool_use',
              provider: 'anthropic',
              toolUseId: 'srv_1',
              name: 'web_fetch',
              input: { url: 'https://example.com/' },
              providerMetadata: { anthropic: { caller: { type: 'direct' } } },
            },
            { type: 'server_tool_result', provider: 'anthropic', toolUseId: 'srv_1', name: 'web_fetch', output: fetched },
            { type: 'text', text: 'It is Example Domain.' },
          ],
        }),
      ]),
    })
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'fetch it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Fetching.' },
          {
            type: 'server_tool_use',
            id: 'srv_1',
            name: 'web_fetch',
            input: { url: 'https://example.com/' },
            providerMetadata: { anthropic: { caller: { type: 'direct' } } },
          },
          { type: 'server_tool_result', toolUseId: 'srv_1', name: 'web_fetch', output: fetched },
          { type: 'text', text: 'It is Example Domain.' },
        ],
      },
    ])
  })

  it('keeps an errored server result marked as an error on replay', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([
        turn({
          assistantContent: [
            { type: 'server_tool_use', provider: 'anthropic', toolUseId: 'srv_1', name: 'web_fetch', input: {} },
            {
              type: 'server_tool_result',
              provider: 'anthropic',
              toolUseId: 'srv_1',
              name: 'web_fetch',
              output: { errorCode: 'url_not_accessible' },
              isError: true,
            },
            { type: 'text', text: 'Could not.' },
          ],
        }),
      ]),
    })
    expect(messages[1].content[1]).toEqual({
      type: 'server_tool_result',
      toolUseId: 'srv_1',
      name: 'web_fetch',
      output: { errorCode: 'url_not_accessible' },
      isError: true,
    })
  })

  it('opens a new assistant message for a server call made in a later step than a function call', async () => {
    // Step 1: Read. Step 2: a web search. Collapsing them would put the
    // search BEFORE the Read result that the model had already seen.
    const messages = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([
        turn({
          assistantContent: [
            { type: 'tool_use', toolUseId: 'tu_1', name: 'Read', input: {} },
            { type: 'server_tool_use', provider: 'anthropic', toolUseId: 'srv_1', name: 'web_search', input: { query: 'q' } },
            { type: 'server_tool_result', provider: 'anthropic', toolUseId: 'srv_1', name: 'web_search', output: [] },
            { type: 'text', text: 'done' },
          ],
          toolResults: { tu_1: { ok: true, output: 'x' } },
        }),
      ]),
    })
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect((messages[3].content as ReadonlyArray<{ type: string }>).map((b) => b.type)).toEqual([
      'server_tool_use',
      'server_tool_result',
      'text',
    ])
  })

  it('drops a server call whose result never arrived, because the vendor rejects an unpaired one', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([
        turn({
          assistantContent: [
            { type: 'text', text: 'Searching.' },
            { type: 'server_tool_use', provider: 'anthropic', toolUseId: 'srv_1', name: 'web_search', input: { query: 'q' } },
          ],
          error: 'turn aborted',
        }),
      ]),
    })
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Searching.' }] })
  })

  it('drops a server pair written by another provider, both halves, and keeps the text', async () => {
    // Measured: an OpenAI search result replayed into the Anthropic transport
    // throws a type validation error before any request is sent.
    const persisted = turn({
      userMessage: 'look it up',
      assistantContent: [
        { type: 'text', text: 'Searching.' },
        { type: 'server_tool_use', provider: 'openai', toolUseId: 'ws_1', name: 'web_search', input: {} },
        {
          type: 'server_tool_result',
          provider: 'openai',
          toolUseId: 'ws_1',
          name: 'web_search',
          output: { action: { type: 'search' }, sources: [] },
        },
        { type: 'text', text: 'Found it.' },
      ],
    })
    const intoAnthropic = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([persisted]),
    })
    expect(intoAnthropic[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Searching.' },
        { type: 'text', text: 'Found it.' },
      ],
    })
    const intoOpenAi = await replayHistory({
      repoRoot: root,
      providerId: 'openai',
      session: sessionWith([persisted]),
    })
    expect((intoOpenAi[1].content as ReadonlyArray<{ type: string }>).map((b) => b.type)).toEqual([
      'text',
      'server_tool_use',
      'server_tool_result',
      'text',
    ])
  })

  it('treats a server block with no provider recorded as foreign', async () => {
    const messages = await replayHistory({
      repoRoot: root,
      providerId: 'anthropic',
      session: sessionWith([
        turn({
          assistantContent: [
            { type: 'server_tool_use', toolUseId: 'srv_1', name: 'web_search', input: {} },
            { type: 'server_tool_result', toolUseId: 'srv_1', name: 'web_search', output: [] },
            { type: 'text', text: 'done' },
          ],
        }),
      ]),
    })
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
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

  describe('puts each steer where it landed in the turn', () => {
    const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
    const say = (text: string) => ({ type: 'text' as const, text })
    const read = (id: string) => ({
      type: 'tool_use' as const,
      toolUseId: id,
      name: 'Read',
      input: { file_path: 'a.vue' },
    })
    const replayOne = (over: Partial<ChatTurn>) =>
      replayHistory({ repoRoot: root, session: sessionWith([turn({ userMessage: 'first', ...over })]) })

    it('a steer in the middle of the answer splits it at that point', async () => {
      const messages = await replayOne({
        assistantContent: [say('Working on the header.'), read('tu_1'), say('Sidebar done.')],
        toolResults: { tu_1: { ok: true, output: 'ok' } },
        steers: [{ text: 'no, the sidebar', afterAssistantBlocks: 1 }],
      })
      expect(messages).toEqual([
        user('first'),
        { role: 'assistant', content: [{ type: 'text', text: 'Working on the header.' }] },
        user('no, the sidebar'),
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.vue' } }],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Sidebar done.' }] },
      ])
    })

    it('two steers keep their own positions and their order', async () => {
      const messages = await replayOne({
        assistantContent: [say('one'), say('two'), say('three')],
        steers: [
          { text: 'steer A', afterAssistantBlocks: 1 },
          { text: 'steer B', afterAssistantBlocks: 1 },
          { text: 'steer C', afterAssistantBlocks: 2 },
        ],
      })
      expect(messages).toEqual([
        user('first'),
        { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
        user('steer A'),
        user('steer B'),
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
        user('steer C'),
        { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
      ])
    })

    it('a steer at the end replays exactly as it did before positions were read', async () => {
      const assistantContent = [say('reading'), read('tu_1'), say('done')]
      const messages = await replayOne({
        assistantContent,
        toolResults: { tu_1: { ok: true, output: 'ok' } },
        steers: [{ text: 'thanks', afterAssistantBlocks: assistantContent.length }],
      })
      const unsteered = await replayOne({
        assistantContent,
        toolResults: { tu_1: { ok: true, output: 'ok' } },
      })
      expect(messages).toEqual([...unsteered, user('thanks')])
    })

    it('a steer after a tool call goes after that call\'s result, not between them', async () => {
      const messages = await replayOne({
        assistantContent: [say('reading'), read('tu_1'), say('found it')],
        toolResults: { tu_1: { ok: true, output: 'ok' } },
        steers: [{ text: 'look at b.vue too', afterAssistantBlocks: 2 }],
      })
      expect(messages).toEqual([
        user('first'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.vue' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'ok' }] },
        user('look at b.vue too'),
        { role: 'assistant', content: [{ type: 'text', text: 'found it' }] },
      ])
    })

    it('a steer before the first block goes straight after the opening message', async () => {
      const messages = await replayOne({
        assistantContent: [say('X done.')],
        steers: [{ text: 'do X instead', afterAssistantBlocks: 0 }],
      })
      expect(messages).toEqual([
        user('first'),
        user('do X instead'),
        { role: 'assistant', content: [{ type: 'text', text: 'X done.' }] },
      ])
    })

    it('a turn with no assistant blocks keeps its steers after the opening message', async () => {
      // The recovery turn `chat-handler.ts` writes when the runtime threw:
      // every steer is recorded at 0 and there is nothing to split.
      const messages = await replayOne({
        assistantContent: [],
        steers: [
          { text: 'steer A', afterAssistantBlocks: 0 },
          { text: 'steer B', afterAssistantBlocks: 0 },
        ],
      })
      expect(messages).toEqual([user('first'), user('steer A'), user('steer B')])
    })

    it('reads a position past the end, or one that goes backwards, the way the client does', async () => {
      const messages = await replayOne({
        assistantContent: [say('one'), say('two')],
        steers: [
          { text: 'late', afterAssistantBlocks: 2 },
          { text: 'backwards', afterAssistantBlocks: 1 },
          { text: 'beyond', afterAssistantBlocks: 99 },
        ],
      })
      expect(messages).toEqual([
        user('first'),
        { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
        user('late'),
        user('backwards'),
        user('beyond'),
      ])
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
