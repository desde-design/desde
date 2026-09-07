import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Re-exported from the one file allowed to import the AI SDK, rather than
// importing `ai` here directly — see the fence in `ai-sdk-provider.ts`.
import { APICallError, RetryError } from '../llm-providers/ai-sdk-provider'

import type { BridgeClient } from '../agent-tools/types'
import type { ChatStreamEvent } from '../agent-chat/chat-stream-events'
import { resolveSessionConflict } from '../agent-chat/resolve-conflict'
import { ELIDED_TOOL_IMAGE } from './context-budget'
import { makeEmptySession } from '../agent-chat/types'
import { readProposalBlob } from '../agent-chat-sdk/proposal-blob-store'
import { createTurnInputChannel } from '../agent-chat-sdk/turn-input-channel'
import { OPENAI_DESCRIPTOR } from '../llm-providers/descriptors/openai'
import type { LLMProvider, ProviderEvent, StreamOpts } from '../llm-providers/types'
import {
  API_RETRY_MAX_ATTEMPTS,
  MAX_NEUTRAL_STEPS,
  MAX_RETRY_SLEEP_MS,
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
    minimalOpts({ emit: (e: ChatStreamEvent) => events.push(e), ...overrides }) as never,
    { buildProvider: () => provider },
  )
  return { events, result, calls }
}

function minimalOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bridge,
    worktreeRoot: root,
    session: makeEmptySession('p1'),
    userMessage: 'hello',
    providerId: 'anthropic',
    emit: () => {},
    ...overrides,
  }
}

function fakeProviderThatEndsTheTurn(): LLMProvider {
  return scriptedProvider([textStep('done')]).provider
}

describe('the default provider path', () => {
  it('hands the descriptor the key and base URL from the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-from-env')
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.internal/v1')
    const spy = vi
      .spyOn(OPENAI_DESCRIPTOR, 'buildProvider')
      .mockReturnValue(fakeProviderThatEndsTheTurn())
    try {
      await runChatTurnNeutral(
        minimalOpts({ providerId: 'openai', model: 'gpt-5.6' }) as never,
      ) // NO deps
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'sk-from-env',
          baseUrl: 'https://gateway.internal/v1',
          model: 'gpt-5.6',
        }),
      )
    } finally {
      spy.mockRestore()
      vi.unstubAllEnvs()
    }
  })

  it("fails fast with the provider's own message when no key is present, and builds nothing", async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const spy = vi.spyOn(OPENAI_DESCRIPTOR, 'buildProvider')
    const events: ChatStreamEvent[] = []
    try {
      const result = await runChatTurnNeutral(
        minimalOpts({ providerId: 'openai', emit: (e: ChatStreamEvent) => events.push(e) }) as never,
      )
      expect(spy).not.toHaveBeenCalled()
      expect(result.turn.error).toMatch(/OpenAI API key/i)
      expect(
        events.some(
          (e) => e.kind === 'turn_complete' && e.stopReason === 'error',
        ),
      ).toBe(true)
      expect(
        events.some((e) => e.kind === 'error' && /OpenAI API key/i.test(e.reason)),
      ).toBe(true)
    } finally {
      spy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

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

  it('survives a Write aimed at a directory, and hands the model the reason', async () => {
    // 2026-09-04 adversarial review, P2-1. The permission gate sat OUTSIDE
    // `runOneTool`'s try, and the gate reconstructs the write to decide, so a
    // `file_path` naming a directory threw EISDIR out of the gate, out of the
    // loop, and ended the turn with the raw errno string in the error banner.
    // `Write src/components` instead of `Write src/components/Foo.vue` is an
    // ordinary model slip, so a user hits this with no adversary at all.
    const { events, calls, result } = await run([
      toolStep('tu_1', 'Write', { file_path: 'src', content: 'oops' }),
      textStep('sorry, that is a directory'),
    ])
    const res = events.find((e) => e.kind === 'tool_result') as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    // The reason is now named rather than relayed as an errno: FX16 item 2
    // decides the SHAPE of the path with `stat` before anything is opened, so
    // a directory is refused by name and a FIFO cannot block the open at all.
    expect(res.error).toMatch(/is a directory/i)
    // The turn kept going: the model got the result and answered.
    expect(calls).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', stopReason: 'end_turn' })
    expect(result.turn.error).toBeUndefined()
    expect(events.some((e) => e.kind === 'error')).toBe(false)
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

/** A provider that always fails with a 429 carrying the given `retry-after`. */
function alwaysRateLimited(retryAfter: string): {
  provider: LLMProvider
  attempts: () => number
} {
  let attempts = 0
  const provider: LLMProvider = {
    name: 'limited',
    defaultModel: 'x',
    complete: async () => ({ text: '', stopReason: 'end_turn' }),
    streamConversation: () => {
      attempts++
      return (async function* () {
        throw Object.assign(new Error('429 too many requests'), {
          headers: { 'retry-after': retryAfter },
        })
      })()
    },
  }
  return { provider, attempts: () => attempts }
}

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

  it('caps the retry wait, so a large retry-after cannot park the turn', async () => {
    const controller = new AbortController()
    const provider = alwaysRateLimited('3600')
    const events: ChatStreamEvent[] = []
    await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => {
          events.push(e)
          // End the wait the moment it starts, so the test does not sit out the
          // capped delay to observe what the cap was.
          if (e.kind === 'api_retry') controller.abort()
        },
      } as never,
      { buildProvider: () => provider.provider },
    )
    expect(events.find((e) => e.kind === 'api_retry')).toMatchObject({
      retryDelayMs: MAX_RETRY_SLEEP_MS,
    })
  })

  it('abandons the retry wait when the turn is aborted', async () => {
    const controller = new AbortController()
    const provider = alwaysRateLimited('3600')
    let startedWaitingAt = 0
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'anthropic',
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => {
          if (e.kind !== 'api_retry') return
          startedWaitingAt = Date.now()
          controller.abort()
        },
      } as never,
      { buildProvider: () => provider.provider },
    )
    expect(result.turn.error).toBe('turn aborted')
    expect(provider.attempts()).toBe(1)
    expect(Date.now() - startedWaitingAt).toBeLessThan(2000)
  })

  it('retries a real APICallError whose message a status-number regex would miss', async () => {
    // The AI SDK throws `APICallError`, which carries the status on
    // `statusCode`, not `status`, and a body that a 429-shaped message regex
    // does not match ("Limit 30000, Used 29000 ... try again in 2s" has no
    // standalone 3-digit run). Reading `err.status` (final review I4) left
    // this case unretried; this constructs the real error class rather than
    // a hand-shaped object, so a rename of `statusCode` upstream would break
    // the test rather than pass silently.
    let attempts = 0
    const provider: LLMProvider = {
      name: 'flaky',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () => {
        const firstAttempt = ++attempts === 1
        return (async function* () {
          if (firstAttempt) {
            throw new APICallError({
              message: 'Limit 30000, Used 29000, Requested 5000. Please try again in 2s.',
              url: 'https://api.openai.com/v1/responses',
              requestBodyValues: {},
              statusCode: 429,
              isRetryable: true,
            })
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
      errorStatus: 429,
    })
    expect(result.turn.error).toBeUndefined()
  })

  it('retries on `isRetryable` alone, when the status is not one this code recognizes', async () => {
    // A gateway can mark an error retriable at a status (or with no status
    // at all) this code's own 429/5xx check would not catch. `isRetryable`
    // is more authoritative than the derived status.
    let attempts = 0
    const provider: LLMProvider = {
      name: 'flaky',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () => {
        const firstAttempt = ++attempts === 1
        return (async function* () {
          if (firstAttempt) {
            throw new APICallError({
              message: 'temporarily unavailable',
              url: 'https://gw.example.com/v1/responses',
              requestBodyValues: {},
              isRetryable: true,
            })
          }
          for (const ev of textStep('recovered')) yield ev
        })()
      },
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
    expect(attempts).toBe(2)
    expect(result.turn.error).toBeUndefined()
  })

  it('retries a 429 that arrives wrapped in the SDK\'s own RetryError', async () => {
    // The SECOND attempt at this defect. An earlier wave fixed `status` vs
    // `statusCode` and retries still never fired, because a 429 that survives
    // the SDK's own retry loop does not reach this code as an `APICallError`
    // at all: it arrives wrapped in `RetryError`, which carries neither
    // `statusCode`, nor `status`, nor `headers`, nor `isRetryable`. Its
    // message ("Failed after 3 attempts. Last error: ...") also defeats the
    // status-number regex fallback, because the OpenAI 429 body has no
    // standalone three-digit run.
    //
    // Both errors here are REAL instances of the installed package's classes.
    // A hand-shaped object with a `lastError` property would pass this test
    // against a wrong fix, which is exactly how the first attempt shipped.
    let attempts = 0
    const inner = new APICallError({
      message:
        'Rate limit reached for gpt-5.6 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 5000.',
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after': '3' },
      isRetryable: true,
    })
    const wrapped = new RetryError({
      message: `Failed after 3 attempts. Last error: ${inner.message}`,
      reason: 'maxRetriesExceeded',
      errors: [inner],
    })
    // Guard the premise: if the SDK ever starts carrying a status on the
    // envelope, this test stops proving what it was written to prove.
    expect((wrapped as unknown as { statusCode?: unknown }).statusCode).toBeUndefined()
    expect((wrapped as unknown as { status?: unknown }).status).toBeUndefined()
    expect((wrapped as unknown as { headers?: unknown }).headers).toBeUndefined()

    const provider: LLMProvider = {
      name: 'flaky',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () => {
        const firstAttempt = ++attempts === 1
        return (async function* () {
          if (firstAttempt) throw wrapped
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
      errorStatus: 429,
      // The vendor's own `retry-after`, read off the wrapped error, not the
      // exponential-backoff guess.
      retryDelayMs: 3000,
    })
    expect(result.turn.error).toBeUndefined()
  })

  it('reports the vendor\'s own wording, not the RetryError envelope, when a wrapped error is fatal', async () => {
    const inner = new APICallError({
      message: 'The model `gpt-5.6` does not exist or you do not have access to it.',
      url: 'https://api.openai.com/v1/responses',
      requestBodyValues: {},
      statusCode: 404,
      isRetryable: false,
    })
    const provider: LLMProvider = {
      name: 'boom',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          throw new RetryError({
            message: `Failed after 3 attempts. Last error: ${inner.message}`,
            reason: 'errorNotRetryable',
            errors: [inner],
          })
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
    expect(result.turn.error).toBe(inner.message)
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

  it('never persists a credential the vendor echoed back in its error text', async () => {
    // Defence in depth. Against both shipped vendors the one key-bearing
    // message ("Incorrect API key provided: …") is already intercepted by the
    // auth arm below and replaced with the remediation copy, so this is not a
    // leak being closed. What it closes is the guarantee: this 403 is the
    // shape a custom OPENAI_BASE_URL gateway can return, it carries the key,
    // it matches no auth pattern, and `turn.error` is written to
    // `.desde/chat-sessions/<id>.json`.
    const key = 'sk-test-not-a-real-key-000000'
    const provider: LLMProvider = {
      name: 'boom',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          throw new Error(`Forbidden: token ${key} is not permitted on this route.`)
        })(),
    }
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'openai',
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    expect(result.turn.error).not.toContain(key)
    expect(result.turn.error).toContain('sk-***')
    // Still diagnosable: the vendor's own sentence survives the masking.
    expect(result.turn.error).toMatch(/not permitted on this route/)
    const errorEvent = events.find((e) => e.kind === 'error')
    expect(JSON.stringify(errorEvent)).not.toContain(key)
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

  it('swaps in the OpenAI re-auth guidance for an OpenAI quota failure', async () => {
    // insufficient_quota is OpenAI's own vocabulary, not one of the generic
    // patterns, so this only classifies as auth when the descriptor's own
    // errorPatterns reach isAuthError.
    const provider: LLMProvider = {
      name: 'boom',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          throw new Error('OpenAI answered 429: insufficient_quota')
        })(),
    }
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'hi',
        providerId: 'openai',
        emit: () => {},
      } as never,
      { buildProvider: () => provider },
    )
    expect(result.turn.error).not.toMatch(/insufficient_quota/)
    expect(result.turn.error).toBe(OPENAI_DESCRIPTOR.errorPatterns!.reauthMessage)
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

describe('runChatTurnNeutral: history replay', () => {
  it('replays a prior turn so a follow-up question has context', async () => {
    const prior = {
      ...makeEmptySession('p1'),
      turns: [
        {
          id: 't0',
          startedAt: '2026-09-03T00:00:00.000Z',
          userMessage: 'make it blue',
          assistantContent: [{ type: 'text' as const, text: 'done' }],
          toolResults: {},
          editProposals: [],
        },
      ],
    }
    const { calls } = await run([textStep('sure')], { session: prior })
    expect(calls[0].messages).toHaveLength(3)
    expect(calls[0].messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'make it blue' }],
    })
  })
})

describe('runChatTurnNeutral: cost ceiling', () => {
  it('refuses before calling the model when the session is already over the ceiling', async () => {
    const spent = {
      ...makeEmptySession('p1'),
      turns: [
        {
          id: 't0',
          startedAt: '2026-09-03T00:00:00.000Z',
          userMessage: 'x',
          assistantContent: [],
          toolResults: {},
          editProposals: [],
          costUsd: 5,
        },
      ],
    }
    const { events, calls, result } = await run([textStep('never runs')], {
      session: spent,
      costCeilingUsd: 1,
    })
    expect(calls).toHaveLength(0)
    expect(result.turn.error).toMatch(/cost ceiling reached/)
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn_complete'])
  })

  it('stops at the next step boundary once the ceiling is crossed mid-turn', async () => {
    const expensive: ProviderEvent[] = [
      { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.vue' } },
      { kind: 'usage', inputTokens: 5_000_000, outputTokens: 5_000_000 },
      {
        kind: 'message_complete',
        stopReason: 'tool_use',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
      },
    ]
    const { calls, result } = await run([expensive, textStep('second step')], {
      costCeilingUsd: 1,
      model: 'claude-opus-4-8',
    })
    expect(calls).toHaveLength(1)
    expect(result.turn.error).toMatch(/cost ceiling/)
    expect(result.turn.costUsd).toBeGreaterThan(1)
  })
})

describe('runChatTurnNeutral: steering', () => {
  it('delivers a steer as a user message at the next step boundary', async () => {
    const channel = createTurnInputChannel()
    const { provider, calls } = scriptedProvider([
      toolStep('tu_1', 'Read', { file_path: 'src/App.vue' }),
      textStep('changed the sidebar instead'),
    ])
    const events: ChatStreamEvent[] = []
    // Pushed before the turn runs, which is the CLI's real shape: the channel
    // is registered as steerable at lock time, many awaits before the runtime.
    channel.push('actually the sidebar')
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'change the header',
        providerId: 'anthropic',
        inputChannel: channel,
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    const second = calls[1].messages
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'actually the sidebar' }],
    })
    // This lane emits `steered` itself, at the boundary where it delivers the
    // steer, and the steer route suppresses its own frame for a neutral turn
    // (`LiveTurn.runtimeEmitsSteered`) so the client still sees exactly one.
    // The emitter must be the side that knows the position: the client cuts
    // its transcript on this frame, and `result.turn.steers` records the same
    // moment. Emitting from the route instead cut the live transcript at
    // accept time while hydration replayed the delivery position, which
    // `useEditorChat-turn-ordering.test.ts` caught as a live/hydrated
    // mismatch at a tool boundary.
    expect(events.filter((e) => e.kind === 'steered')).toEqual([
      { kind: 'steered', sessionId: 'p1', userMessage: 'actually the sidebar', imageCount: 0 },
    ])
    expect(result.turn.steers).toEqual([
      { text: 'actually the sidebar', afterAssistantBlocks: 1 },
    ])
  })

  it('does not ask the user to resend a steer it already delivered into a step that then failed', async () => {
    // 2026-09-04 adversarial review, P3-4. The steer is appended to the
    // request AND recorded on the turn, and the turn is persisted even when
    // the step fails, so `history-replay.ts` replays it as a user message on
    // the next turn. Reporting it for resubmission on top of that puts the
    // same message in the transcript twice.
    const channel = createTurnInputChannel()
    const { provider } = scriptedProvider([toolStep('tu_1', 'Read', { file_path: 'src/App.vue' })])
    const original = provider.streamConversation.bind(provider)
    let step = 0
    provider.streamConversation = (o) => {
      if (step++ === 1) {
        return (async function* (): AsyncGenerator<ProviderEvent> {
          throw new Error('the provider fell over')
        })()
      }
      return original(o)
    }
    const events: ChatStreamEvent[] = []
    channel.push('actually the sidebar')
    const result = await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'change the header',
        providerId: 'anthropic',
        inputChannel: channel,
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    // Delivered and announced once.
    expect(events.filter((e) => e.kind === 'steered')).toHaveLength(1)
    // Persisted on the failed turn, which is what makes it replayable.
    expect(result.turn.steers).toEqual([
      { text: 'actually the sidebar', afterAssistantBlocks: 1 },
    ])
    // And therefore NOT handed back for the user to send again.
    expect(events.filter((e) => e.kind === 'resubmit_required')).toEqual([])
  })

  it('reports a steer that arrived after the last step for resubmission', async () => {
    const channel = createTurnInputChannel()
    const { provider } = scriptedProvider([textStep('all done')])
    const events: ChatStreamEvent[] = []
    const original = provider.streamConversation.bind(provider)
    provider.streamConversation = (o) => {
      channel.push('one more thing')
      return original(o)
    }
    await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'first',
        providerId: 'anthropic',
        inputChannel: channel,
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    expect(events.filter((e) => e.kind === 'resubmit_required')).toEqual([
      { kind: 'resubmit_required', sessionId: 'p1', userMessage: 'one more thing' },
    ])
  })

  it('closes the channel on abort and reports what it was holding', async () => {
    const channel = createTurnInputChannel()
    const controller = new AbortController()
    const provider: LLMProvider = {
      name: 'slow',
      defaultModel: 'x',
      complete: async () => ({ text: '', stopReason: 'end_turn' }),
      streamConversation: () =>
        (async function* () {
          channel.push('never delivered')
          controller.abort()
          throw new Error('aborted')
        })(),
    }
    const events: ChatStreamEvent[] = []
    await runChatTurnNeutral(
      {
        bridge,
        worktreeRoot: root,
        session: makeEmptySession('p1'),
        userMessage: 'first',
        providerId: 'anthropic',
        inputChannel: channel,
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => events.push(e),
      } as never,
      { buildProvider: () => provider },
    )
    expect(channel.closed).toBe(true)
    expect(events.filter((e) => e.kind === 'resubmit_required')).toHaveLength(1)
  })
})

/**
 * FX11 item 2 (2026-09-05). The read baseline that `detectOverwriteConflict`
 * compares against used to advance in the permission gate, the moment the gate
 * ALLOWED a write. On this lane the gate's ack is a no-op stub and the write
 * happens afterwards, in the tool handler, where the broker can still refuse
 * it. So a refused write left a baseline recording bytes nobody wrote, and the
 * next edit raised a conflict banner over a file nothing had touched.
 *
 * The baseline now advances from the tool handler, on the broker's success
 * path. This pins the property that move must not break: the agent's own
 * consecutive writes, with no Read in between, still raise no warning.
 */
describe('the read baseline on the neutral lane', () => {
  it('does not warn about the agent overwriting its own write', async () => {
    const { events } = await run([
      toolStep('tu_1', 'Read', { file_path: 'src/App.vue' }),
      toolStep('tu_2', 'Write', { file_path: 'src/App.vue', content: 'ONE\n' }),
      toolStep('tu_3', 'Write', { file_path: 'src/App.vue', content: 'TWO\n' }),
      textStep('done'),
    ])
    expect(events.filter((e) => e.kind === 'edit_overwrite_warning')).toHaveLength(0)
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe('TWO\n')
  })
})

/**
 * Conflict recovery, end to end on this lane.
 *
 * The lane already DETECTED conflicts and emitted `edit_overwrite_warning`,
 * which is the half the user sees. The half they act on is
 * `resolve-conflict.ts`, and it needs two artefacts on disk: the proposal blob
 * holding what this session meant to write, and the read-time base snapshot.
 * Without them "Use mine" and "Merge" both 409 and only "Discard mine" works,
 * so the assertions below run the REAL resolution rather than checking that
 * the two files exist.
 */
describe('conflict recovery on the neutral lane', () => {
  const BASE = 'a\nb\nc\n'
  const MINE = 'A\nb\nc\n'
  const THEIRS = 'a\nb\nC\n'

  /**
   * Read the file, let someone else write it, then write it ourselves — the
   * exact interleaving `detectOverwriteConflict` fires on.
   */
  async function runConflictingTurn(): Promise<{
    session: Awaited<ReturnType<typeof runChatTurnNeutral>>['session']
    events: ChatStreamEvent[]
  }> {
    writeFileSync(join(root, 'src/App.vue'), BASE, 'utf8')
    const { provider } = scriptedProvider([
      toolStep('tu_1', 'Read', { file_path: 'src/App.vue' }),
      toolStep('tu_2', 'Write', { file_path: 'src/App.vue', content: MINE }),
      textStep('written'),
    ])
    const original = provider.streamConversation.bind(provider)
    let step = 0
    provider.streamConversation = (o) => {
      // Between our Read and our Write, the other writer lands.
      if (step++ === 1) writeFileSync(join(root, 'src/App.vue'), THEIRS, 'utf8')
      return original(o)
    }
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      minimalOpts({ emit: (e: ChatStreamEvent) => events.push(e) }) as never,
      { buildProvider: () => provider },
    )
    return { session: result.session, events }
  }

  it('writes the proposal blob and the base snapshot the resolver reads', async () => {
    const { session, events } = await runConflictingTurn()
    expect(events.some((e) => e.kind === 'edit_overwrite_warning')).toBe(true)

    const abs = join(root, 'src/App.vue')
    const conflict = (session.conflicts ?? {})[abs]
    expect(conflict).toBeDefined()

    const proposal = session.turns.at(-1)?.editProposals?.find((p) => p.kind === 'overwrite')
    expect(proposal).toBeDefined()
    expect(await readProposalBlob(root, session.id.sessionId, proposal!.editId)).toBe(MINE)

    const basePath = join(
      root,
      '.desde',
      'chat-sessions',
      session.id.sessionId,
      'bases',
      `${conflict.hashAtRead}.txt`,
    )
    expect(existsSync(basePath)).toBe(true)
    expect(readFileSync(basePath, 'utf8')).toBe(BASE)
    // The record on the session points at the same file, rather than the
    // empty string that made the resolver report a GC'd snapshot.
    expect(session.fileReads?.[abs]?.baseContentPath).toBe(basePath)
  })

  it('recovers this session s content with "Use mine"', async () => {
    const { session } = await runConflictingTurn()
    // Someone writes again after the conflict, so a passing assertion cannot
    // be the agent's own write still sitting on disk.
    writeFileSync(join(root, 'src/App.vue'), 'CLOBBERED\n', 'utf8')
    const outcome = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/App.vue',
      resolution: 'mine',
    })
    expect(outcome).toMatchObject({ ok: true })
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe(MINE)
  })

  it('merges both sides cleanly with "Merge"', async () => {
    const { session } = await runConflictingTurn()
    // The other writer's line has to be back on disk for a 3-way merge to
    // have anything to keep: our own Write overwrote it.
    writeFileSync(join(root, 'src/App.vue'), THEIRS, 'utf8')
    const outcome = await resolveSessionConflict({
      worktreeRoot: root,
      session,
      file: 'src/App.vue',
      resolution: 'merge',
    })
    expect(outcome).toMatchObject({ ok: true, mergeClean: true })
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe('A\nb\nC\n')
  })
})

describe('a tool result carrying an image', () => {
  const PNG = 'data:image/png;base64,AAAA'
  const screenshotBridge: BridgeClient = {
    send: async (channel: string) =>
      channel === 'chat:capture_screenshot'
        ? ({ dataUrl: PNG, width: 1280, height: 800 } as never)
        : null,
  }

  it('sends the image to the model as an image block, not as a description of one', async () => {
    const { provider, calls } = scriptedProvider([
      toolStep('tu_1', 'mcp__editor__capture_screenshot', { scope: 'viewport' }),
      textStep('looks right'),
    ])
    await runChatTurnNeutral(
      minimalOpts({ bridge: screenshotBridge }) as never,
      { buildProvider: () => provider },
    )
    const second = calls[1]
    const toolResultMessage = second.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content !== 'string' &&
        m.content.some((b) => b.type === 'tool_result'),
    )!
    const block = (toolResultMessage.content as readonly unknown[]).find(
      (b) => (b as { type: string }).type === 'tool_result',
    ) as { content: string | readonly { type: string; data?: string }[] }
    expect(typeof block.content).not.toBe('string')
    const parts = block.content as readonly { type: string; data?: string }[]
    expect(parts.some((p) => p.type === 'image' && p.data === 'AAAA')).toBe(true)
    expect(parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('stops re-sending older screenshots once the turn is over its image budget', async () => {
    // FX16 item 3 (2026-09-05). `applyContextBudget` runs ONCE, on replayed
    // history, before the loop — and images only arrive after that, one tool
    // result at a time. Nothing else removed them, so a turn re-sent every
    // screenshot it had ever taken on every subsequent step: MEASURED by the
    // adversarial verifier at up to 180 MB in one request and about 4.9 GB
    // uploaded across a turn, re-billed as image input each time.
    //
    // The newest image survives. That is the whole reason images reach the
    // model at all, and a cap that could drop the picture the model just took
    // would put it back to describing a screenshot it never saw.
    let shot = 0
    const varyingBridge: BridgeClient = {
      send: async (channel: string) =>
        channel === 'chat:capture_screenshot'
          ? ({
              dataUrl: `data:image/png;base64,${'ABCD'[shot++ % 4].repeat(4)}`,
              width: 10,
              height: 10,
            } as never)
          : null,
    }
    const { provider, calls } = scriptedProvider([
      toolStep('tu_1', 'mcp__editor__capture_screenshot', { scope: 'viewport' }),
      toolStep('tu_2', 'mcp__editor__capture_screenshot', { scope: 'viewport' }),
      toolStep('tu_3', 'mcp__editor__capture_screenshot', { scope: 'viewport' }),
      textStep('the third one looks right'),
    ])
    await runChatTurnNeutral(minimalOpts({ bridge: varyingBridge }) as never, {
      buildProvider: () => provider,
      // Four bytes of base64 is one fixture image, so this is "keep one".
      maxTurnImageBytes: 4,
    })
    const finalRequest = calls.at(-1)!
    const images: string[] = []
    const placeholders: string[] = []
    for (const message of finalRequest.messages) {
      if (typeof message.content === 'string') continue
      for (const block of message.content) {
        if (block.type !== 'tool_result' || typeof block.content === 'string') continue
        for (const part of block.content) {
          if (part.type === 'image') images.push(part.data)
          else if (part.text === ELIDED_TOOL_IMAGE) placeholders.push(part.text)
        }
      }
    }
    expect(images).toEqual(['CCCC'])
    expect(placeholders).toHaveLength(2)
  })

  it('still gives the client a renderable string on the tool_result stream event', async () => {
    const { events } = await (async () => {
      const { provider } = scriptedProvider([
        toolStep('tu_1', 'mcp__editor__capture_screenshot', { scope: 'viewport' }),
        textStep('ok'),
      ])
      const seen: ChatStreamEvent[] = []
      await runChatTurnNeutral(
        minimalOpts({
          bridge: screenshotBridge,
          emit: (e: ChatStreamEvent) => seen.push(e),
        }) as never,
        { buildProvider: () => provider },
      )
      return { events: seen }
    })()
    const frame = events.find((e) => e.kind === 'tool_result')!
    expect(typeof (frame as { output?: unknown }).output).toBe('string')
    expect((frame as { output: string }).output).toMatch(/image\/png image returned/)
  })
})

describe('stopping a turn', () => {
  it("reports an aborted turn as aborted, not as the model giving up", async () => {
    const controller = new AbortController()
    const abortedStep: ProviderEvent[] = [
      {
        kind: 'message_complete',
        stopReason: 'error',
        vendorStopReason: 'aborted',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]
    const { provider } = scriptedProvider([abortedStep])
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      minimalOpts({
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => events.push(e),
      }) as never,
      { buildProvider: () => provider },
    )
    expect(result.turn.error).toBe('turn aborted')
    expect(result.turn.error).not.toMatch(/stopped before finishing/)
  })

  it('does not run tool calls queued behind the one the user stopped, and says so', async () => {
    const controller = new AbortController()
    const twoCalls: ProviderEvent[] = [
      { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.vue' } },
      { kind: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: 'src/Late.vue', content: 'nope\n' } },
      {
        kind: 'message_complete',
        stopReason: 'tool_use',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/App.vue' } },
            { type: 'tool_use', id: 'tu_2', name: 'Write', input: { file_path: 'src/Late.vue', content: 'nope\n' } },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]
    const { provider } = scriptedProvider([twoCalls, textStep('unused')])
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      minimalOpts({
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => {
          events.push(e)
          // Stop the moment the first tool answers: the second call is queued
          // behind it and must not run.
          if (e.kind === 'tool_result' && e.toolUseId === 'tu_1') controller.abort()
        },
      }) as never,
      { buildProvider: () => provider },
    )
    expect(existsSync(join(root, 'src/Late.vue'))).toBe(false)
    const second = result.turn.toolResults?.tu_2
    expect(second?.ok).toBe(false)
    expect(second?.error).toMatch(/not run/i)
    const frame = events.find((e) => e.kind === 'tool_result' && e.toolUseId === 'tu_2')
    expect(frame).toBeDefined()
  })

  it('does not write when Stop lands while the permission gate is still deciding', async () => {
    // FX16 item 1 (2026-09-05). The queued-call refusal above reads the signal
    // ONCE, before `runOneTool`. The adversarial verifier fired Stop AFTER
    // that read and MEASURED the write landing on disk with
    // `signal.aborted === true`. The window is not a few instructions: the
    // gate reconstructs the write (`resolveRepoPath`, `existsSync`, a
    // whole-file read) before it can decide, and `brokeredWrite` then waits
    // for the repo's tree gate.
    //
    // The wrapper fires Stop while the REAL gate's promise is still pending,
    // which is the interleaving the verifier measured. A timer cannot do this
    // reliably: it lands wherever the event loop puts it, which across runs
    // was sometimes inside the gate and sometimes inside the broker.
    const controller = new AbortController()
    const target = join(root, 'src/App.vue')
    const before = readFileSync(target, 'utf8')
    const { provider } = scriptedProvider([
      toolStep('tu_1', 'Write', {
        file_path: 'src/App.vue',
        content: '<div>NEW FROM AGENT</div>\n',
      }),
      textStep('unused'),
    ])
    const events: ChatStreamEvent[] = []
    const result = await runChatTurnNeutral(
      minimalOpts({
        signal: controller.signal,
        emit: (e: ChatStreamEvent) => events.push(e),
      }) as never,
      {
        buildProvider: () => provider,
        wrapGate: (gate) => (name, input, ctx) => {
          const decision = gate(name, input, ctx)
          controller.abort()
          return decision
        },
      },
    )
    expect(readFileSync(target, 'utf8')).toBe(before)
    const res = result.turn.toolResults?.tu_1
    expect(res?.ok).toBe(false)
    expect(res?.error).toMatch(/stopped while this call was being checked/i)
    expect(events.some((e) => e.kind === 'edit_proposed')).toBe(false)
  })

  it('does not write when Stop lands while the broker is waiting for the tree gate', async () => {
    // The same defect at its widest point, which is the one the verifier
    // called out by name: "A tree gate contended by a Commit, a Publish or
    // another chat session holds there for as long as that operation takes —
    // seconds, not microseconds." Stop arrives while the write is queued
    // behind that operation, which is AFTER every check the loop can make.
    const controller = new AbortController()
    const target = join(root, 'src/App.vue')
    const before = readFileSync(target, 'utf8')
    const { provider } = scriptedProvider([
      toolStep('tu_1', 'Write', {
        file_path: 'src/App.vue',
        content: '<div>NEW FROM AGENT</div>\n',
      }),
      textStep('unused'),
    ])
    const result = await runChatTurnNeutral(
      minimalOpts({
        signal: controller.signal,
        // Stands in for the Commit that was already holding it.
        acquireTreeGate: async () => {
          controller.abort()
          return () => {}
        },
      }) as never,
      { buildProvider: () => provider },
    )
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(result.turn.toolResults?.tu_1?.ok).toBe(false)
  })
})
