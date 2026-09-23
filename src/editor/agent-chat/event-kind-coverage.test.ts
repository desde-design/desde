import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: 'editor', instance: {} })),
  tool: vi.fn((name: string) => ({ name })),
}))

import {
  ANTHROPIC_ONLY_EVENT_KINDS,
  CHAT_STREAM_EVENT_KINDS,
  HANDLER_OWNED_EVENT_KINDS,
  SCRIPT_EXEMPT_EVENT_KINDS,
  type ChatStreamEvent,
} from './chat-stream-events'
import { makeEmptySession } from './types'
import { runChatTurnSdk } from '../agent-chat-sidecar/run-chat-turn-sidecar'
import { runChatTurnNeutral } from '../agent-chat-neutral/run-chat-turn-neutral'
// Re-exported from the one file allowed to import the AI SDK — see the fence
// in `ai-sdk-provider.ts`. Building a REAL `APICallError` for the neutral
// script's 429, rather than a hand-shaped object, is what proves the neutral
// lane's `rate_limit_warning` comes from the actual retry path and not from
// a test double that happens to look 429-shaped.
import { APICallError } from '../llm-providers/ai-sdk-provider'
import type { LLMProvider } from '../llm-providers/types'

/**
 * The parity invariant, as a test rather than as a paragraph in a spec.
 *
 * Both runtimes are driven over the SAME script: text, reasoning, a tool call,
 * its result, usage, completion. The SDK script additionally carries a
 * structured rate-limit event, and the neutral script additionally carries a
 * retried 429 — each lane's own way of producing `rate_limit_warning` — so
 * this test actually OBSERVES both lanes emitting it, rather than declaring
 * one of them exempt.
 *
 * A kind that only one lane emits and that is NOT on the Anthropic-only list
 * is a parity gap. A kind the NEUTRAL lane emits that the SDK lane does not is
 * always a defect: this lane may lose capability, never invent wire format.
 */

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kind-coverage-')))
  queryMock.mockReset()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ChatStreamEvent kind coverage', () => {
  it('lists nothing as Anthropic-only, now that both lanes raise rate_limit_warning', () => {
    expect([...ANTHROPIC_ONLY_EVENT_KINDS]).toEqual([])
  })

  it('emits `steered` exactly once per steer, from the side that knows the position', () => {
    // One frame per steer must reach the client: it draws the user bubble on
    // that frame AND cuts the transcript there, so two frames mean a duplicate
    // bubble and a double cut (final review I1), while zero means the live
    // transcript never cuts at all and stops matching the re-hydrated one
    // (`useEditorChat-turn-ordering.test.ts`, the "steer at a tool boundary"
    // row, which is how deleting the neutral emitter was caught).
    //
    // Which side emits is decided by which side knows WHERE the steer landed.
    // The SDK runtime cannot observe delivery, so the route emits at accept
    // time for that lane. The neutral runtime appends the message itself at a
    // step boundary and stamps `afterAssistantBlocks` there, so it emits, and
    // the route stands down for that lane via `LiveTurn.runtimeEmitsSteered`.
    //
    // Each runtime's own script drives one lane in isolation and never sees
    // the other side's frame, so neither can catch a regression here; this
    // greps the three sources the way the finding's evidence was gathered.
    const neutralSrc = readFileSync(
      join(__dirname, '../agent-chat-neutral/run-chat-turn-neutral.ts'),
      'utf8',
    )
    const sdkSrc = readFileSync(join(__dirname, '../agent-chat-sidecar/run-chat-turn-sidecar.ts'), 'utf8')
    const routeSrc = readFileSync(
      join(__dirname, '../../../editor-cli/src/server/chat-handler.ts'),
      'utf8',
    )
    const emitters = (src: string): number => (src.match(/kind:\s*['"]steered['"]/g) ?? []).length

    // The neutral lane's emitter, and the route's, and no third one.
    expect(emitters(neutralSrc)).toBe(1)
    expect(emitters(sdkSrc)).toBe(0)
    expect(emitters(routeSrc)).toBe(1)

    // The route's single emitter is guarded, so a neutral turn gets the
    // runtime's frame and only that one. A guard that stopped matching this
    // would put two frames back on the OpenAI lane.
    expect(routeSrc).toMatch(/if\s*\(!live\.runtimeEmitsSteered\)\s*\{/)
  })

  it('accounts for every declared kind', async () => {
    const { sdk, neutral } = await runtimeKinds()
    const accounted = new Set<string>([
      ...HANDLER_OWNED_EVENT_KINDS,
      ...SCRIPT_EXEMPT_EVENT_KINDS,
      ...ANTHROPIC_ONLY_EVENT_KINDS,
      ...sdk,
      ...neutral,
    ])
    expect([...CHAT_STREAM_EVENT_KINDS].filter((k) => !accounted.has(k))).toEqual([])
  })

  it('emits no kind on the neutral lane that the SDK lane does not also emit', async () => {
    const { sdk, neutral } = await runtimeKinds()
    expect([...neutral].filter((k) => !sdk.has(k))).toEqual([])
  })

  it('emits nothing on the SDK lane that the neutral lane misses, except the Anthropic-only list', async () => {
    const { sdk, neutral } = await runtimeKinds()
    const sdkOnly = [...sdk].filter((k) => !neutral.has(k))
    expect(sdkOnly.sort()).toEqual([...ANTHROPIC_ONLY_EVENT_KINDS].sort())
  })
})

/** Drive both runtimes over the same script and collect the kinds each emitted. */
async function runtimeKinds(): Promise<{ sdk: Set<string>; neutral: Set<string> }> {
  const sdkEvents: ChatStreamEvent[] = []
  queryMock.mockImplementationOnce(() =>
    (async function* () {
      yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } }
      yield {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } },
      }
      yield {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'reading' } },
      }
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
      }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } }
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }
      // Matches the neutral script's own 429 retry below (`thisCall === 0`),
      // so `api_retry` is observed on BOTH lanes here. Without this, adding
      // a real retry to the neutral script alone would make `api_retry`
      // neutral-only in this run and fail "emits no kind on the neutral
      // lane that the SDK lane does not also emit" — a parity gap this
      // script did not actually have, only a script that did not exercise
      // the SDK's own retry message.
      yield {
        type: 'system',
        subtype: 'api_retry',
        retry_delay_ms: 1000,
        attempt: 1,
        max_retries: 3,
        error_status: 429,
      }
      yield {
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }
    })(),
  )
  await runChatTurnSdk({
    bridge: { send: async () => null },
    worktreeRoot: root,
    session: makeEmptySession('p1'),
    userMessage: 'read it',
    emit: (e: ChatStreamEvent) => sdkEvents.push(e),
  } as never)

  const neutralEvents: ChatStreamEvent[] = []
  const provider: LLMProvider = {
    name: 'scripted',
    defaultModel: 'x',
    complete: async () => ({ text: '', stopReason: 'end_turn' }),
    streamConversation: (() => {
      // A plain call counter, not a step counter: `streamStepWithRetry`
      // calls `streamConversation` again for a RETRY, so call 0 is step 0's
      // first (failing) attempt, call 1 is step 0's successful retry, and
      // call 2 is step 1. This is what makes `rate_limit_warning` come out
      // of a real run of the retry path, the same way every other kind here
      // comes out of a real run of its own path.
      let call = 0
      return () =>
        (async function* () {
          const thisCall = call++
          if (thisCall === 0) {
            throw new APICallError({
              message: 'Rate limit reached. Please try again later.',
              url: 'https://api.anthropic.com/v1/messages',
              requestBodyValues: {},
              statusCode: 429,
              responseHeaders: { 'retry-after': '1' },
              isRetryable: true,
            })
          }
          if (thisCall === 1) {
            yield { kind: 'reasoning_delta', delta: 'hm' }
            yield { kind: 'text_delta', delta: 'reading' }
            yield { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } }
            yield {
              kind: 'message_complete',
              stopReason: 'tool_use',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'reading' },
                  { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
                ],
              },
            }
            return
          }
          yield { kind: 'text_delta', delta: 'done' }
          yield { kind: 'usage', inputTokens: 5, outputTokens: 2 }
          yield {
            kind: 'message_complete',
            stopReason: 'end_turn',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          }
        })()
    })(),
  }
  await runChatTurnNeutral(
    {
      bridge: { send: async () => null },
      worktreeRoot: root,
      session: makeEmptySession('p1'),
      userMessage: 'read it',
      providerId: 'anthropic',
      emit: (e: ChatStreamEvent) => neutralEvents.push(e),
    } as never,
    { buildProvider: () => provider },
  )

  return {
    sdk: new Set(sdkEvents.map((e) => e.kind)),
    neutral: new Set(neutralEvents.map((e) => e.kind)),
  }
}
