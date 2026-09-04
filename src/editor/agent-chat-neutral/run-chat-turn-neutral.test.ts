import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import { makeEmptySession } from '../agent-chat/types'
import type { LLMProvider, ProviderEvent, StreamOpts } from '../llm-providers/types'
import {
  API_RETRY_MAX_ATTEMPTS,
  MAX_NEUTRAL_STEPS,
  runChatTurnNeutral,
} from './run-chat-turn-neutral'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-loop-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/App.vue'), '<template><div/></template>\n', 'utf8')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const bridge: BridgeClient = { send: async () => null }

/** A provider driven by a script: one array of ProviderEvents per model step. */
function scriptedProvider(steps: ProviderEvent[][]): {
  provider: LLMProvider
  calls: StreamOpts[]
} {
  const calls: StreamOpts[] = []
  let i = 0
  const provider: LLMProvider = {
    name: 'scripted',
    defaultModel: 'scripted-1',
    complete: async () => ({ text: '', stopReason: 'end_turn' }),
    streamConversation: (opts) => {
      calls.push(opts)
      const events = steps[i++] ?? []
      return (async function* () {
        for (const ev of events) yield ev
      })()
    },
  }
  return { provider, calls }
}

const textStep = (text: string): ProviderEvent[] => [
  { kind: 'text_delta', delta: text },
  { kind: 'usage', inputTokens: 10, outputTokens: 2 },
  {
    kind: 'message_complete',
    stopReason: 'end_turn',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 10, outputTokens: 2 },
  },
]

const toolStep = (id: string, name: string, input: unknown): ProviderEvent[] => [
  { kind: 'tool_use', id, name, input },
  {
    kind: 'message_complete',
    stopReason: 'tool_use',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    usage: { inputTokens: 5, outputTokens: 5 },
  },
]

async function run(
  steps: ProviderEvent[][],
  overrides: Record<string, unknown> = {},
): Promise<{ events: ChatStreamEvent[]; result: Awaited<ReturnType<typeof runChatTurnNeutral>>; calls: StreamOpts[] }> {
  const { provider, calls } = scriptedProvider(steps)
  const events: ChatStreamEvent[] = []
  const result = await runChatTurnNeutral(
    {
      bridge,
      worktreeRoot: root,
      session: makeEmptySession('p1'),
      userMessage: 'hello',
      providerId: 'anthropic',
      emit: (e: ChatStreamEvent) => events.push(e),
      ...overrides,
    } as never,
    { buildProvider: () => provider },
  )
  return { events, result, calls }
}

describe('runChatTurnNeutral: one text turn', () => {
  it('emits turn_start, the deltas, usage and turn_complete, in that order', async () => {
    const { events } = await run([textStep('done')])
    expect(events.map((e) => e.kind)).toEqual([
      'turn_start',
      'text_delta',
      'usage',
      'turn_complete',
    ])
    expect(events.at(-1)).toEqual({ kind: 'turn_complete', turnId: expect.any(String), stopReason: 'end_turn' })
  })

  it('persists the assistant text on the returned turn', async () => {
    const { result } = await run([textStep('done')])
    expect(result.turn.assistantContent).toEqual([{ type: 'text', text: 'done' }])
    expect(result.turn.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  })

  it('appends the turn to the session and NEVER sets sdkSessionId', async () => {
    const { result } = await run([textStep('done')])
    expect(result.session.turns).toHaveLength(1)
    expect(result.session.sdkSessionId).toBeUndefined()
  })

  it('wraps selection and page metadata in a per-turn context envelope', async () => {
    const { calls } = await run([textStep('ok')], {
      page: { route: '/settings', framework: 'vue' },
      selection: { selector: '.btn' },
    })
    const first = calls[0].messages[0] as unknown as { content: Array<{ type: string; text: string }> }
    expect(first.content[0].text).toMatch(/^<context-[0-9a-f]{8}>\n/)
    expect(first.content[0].text).toContain('route="/settings"')
    expect(first.content[0].text).toContain('</context-')
    expect(first.content[0].text.endsWith('hello')).toBe(true)
  })

  it('sends user images as provider image blocks', async () => {
    const { calls } = await run([textStep('red')], {
      images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })
    const first = calls[0].messages[0] as unknown as { content: Array<Record<string, unknown>> }
    expect(first.content[1]).toEqual({ type: 'image', mediaType: 'image/png', data: 'AAAA' })
  })
})

describe('runChatTurnNeutral: the tool loop', () => {
  it('runs the tool, feeds the result back and continues', async () => {
    const { events, calls, result } = await run([
      toolStep('tu_1', 'Read', { file_path: 'src/App.vue' }),
      textStep('it is a div'),
    ])
    expect(events.map((e) => e.kind)).toEqual([
      'turn_start',
      'tool_use_start',
      'tool_result',
      'usage',
      'text_delta',
      'usage',
      'turn_complete',
    ])
    expect(calls).toHaveLength(2)
    const followUp = calls[1].messages.at(-1) as unknown as { role: string; content: Array<Record<string, unknown>> }
    expect(followUp.role).toBe('user')
    expect(followUp.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu_1', isError: undefined })
    expect(result.turn.toolResults.tu_1).toMatchObject({ ok: true })
  })

  it('sends a denial back as an isError tool_result rather than throwing', async () => {
    const { events, calls } = await run([
      toolStep('tu_1', 'Read', { file_path: '/etc/passwd' }),
      textStep('understood'),
    ])
    const denial = events.find((e) => e.kind === 'tool_result')
    expect(denial).toMatchObject({ ok: false })
    expect(String((denial as { error: string }).error)).toMatch(/Read denied/)
    const followUp = calls[1].messages.at(-1) as unknown as { content: Array<{ isError?: boolean }> }
    expect(followUp.content[0].isError).toBe(true)
  })

  it('validates the model s input against the tool s own shape before running it', async () => {
    const { events } = await run([
      toolStep('tu_1', 'Read', { file_path: 42 }),
      textStep('ok'),
    ])
    const res = events.find((e) => e.kind === 'tool_result') as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/invalid arguments/i)
  })

  it('reports an unknown tool by name instead of hanging the turn', async () => {
    const { events } = await run([toolStep('tu_1', 'Bash', { cmd: 'ls' }), textStep('ok')])
    const res = events.find((e) => e.kind === 'tool_result') as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no tool named 'Bash'/)
  })

  it('stops at the step cap rather than looping forever', async () => {
    const forever = Array.from({ length: 60 }, (_, i) => toolStep(`tu_${i}`, 'Read', { file_path: 'src/App.vue' }))
    const { events, result } = await run(forever)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', stopReason: 'error' })
    expect(result.turn.error).toMatch(/step limit/)
    // The message names the cap the loop actually enforced, not a number
    // written out by hand next to it.
    expect(result.turn.error).toContain(String(MAX_NEUTRAL_STEPS))
  })
})

describe('runChatTurnNeutral: failures', () => {
  it('retries a transient failure that produced no output, and reports the wait', async () => {
    let attempts = 0
    const provider: LLMProvider = {
      name: 'flaky',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () => {
        const firstAttempt = ++attempts === 1
        return (async function* () {
          if (firstAttempt) {
            const err = Object.assign(new Error('429 too many requests'), {
              headers: { 'retry-after': '1' },
            })
            throw err
          }
          for (const ev of textStep('recovered')) yield ev
        })()
      },
    }
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    expect(attempts).toBe(2)
    expect(events.find((e) => e.kind === 'api_retry')).toMatchObject({
      attempt: 1,
      maxRetries: API_RETRY_MAX_ATTEMPTS,
      errorStatus: 429,
      retryDelayMs: 1000,
    })
    expect(result.turn.error).toBeUndefined()
    expect(result.turn.assistantContent).toEqual([{ type: 'text', text: 'recovered' }])
  })

  it('turns a provider throw into an error event and an errored turn', async () => {
    const provider: LLMProvider = {
      name: 'boom',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          throw new Error('network down')
        })(),
    }
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    expect(events.map((e) => e.kind)).toContain('error')
    expect(result.turn.error).toMatch(/network down/)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', stopReason: 'error' })
  })

  it('swaps in the re-auth guidance for a 401', async () => {
    const provider: LLMProvider = {
      name: 'boom',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          throw new Error('authentication_error: invalid x-api-key')
        })(),
    }
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        emit: () => {},
      } as never,
      { buildProvider: () => provider },
    )
    expect(result.turn.error).not.toMatch(/invalid x-api-key/)
  })

  it('reports an aborted turn as aborted', async () => {
    const controller = new AbortController()
    const provider: LLMProvider = {
      name: 'slow',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          controller.abort()
          throw new Error('aborted')
        })(),
    }
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        signal: controller.signal,
        emit: () => {},
      } as never,
      { buildProvider: () => provider },
    )
    expect(result.turn.error).toBe('turn aborted')
  })
})
