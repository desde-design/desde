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
import { runChatTurnSdk } from '../agent-chat-sdk/run-chat-turn-sdk'
import { runChatTurnNeutral } from '../agent-chat-neutral/run-chat-turn-neutral'
import type { LLMProvider } from '../llm-providers/types'

/**
 * The parity invariant, as a test rather than as a paragraph in a spec.
 *
 * Both runtimes are driven over the SAME script: text, reasoning, a tool call,
 * its result, usage, completion. The SDK script additionally carries a
 * rate-limit event, because that is the one kind this design deliberately
 * keeps on one lane, and a test that never produced it could not tell
 * "Anthropic-only" from "nobody emits this".
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
  it('lists exactly rate_limit_warning as Anthropic-only', () => {
    expect([...ANTHROPIC_ONLY_EVENT_KINDS]).toEqual(['rate_limit_warning'])
  })

  it('emits `steered` from the steer route only, never from a runtime', () => {
    // The steer route (`chat-handler.ts`, at accept time) emits `steered`
    // for both lanes already. The neutral runtime used to emit a second one
    // at boundary delivery, which drew a duplicate user bubble on the
    // OpenAI lane (final review I1) — the SDK runtime never emitted one at
    // all. `run-chat-turn-neutral.test.ts` drives the runtime alone and
    // never sees the route's frame, so it cannot catch a regression here;
    // this greps the actual sources the way the finding's evidence was
    // gathered, so a re-added emitter in either runtime fails this test
    // regardless of what any single runtime's own script asserts.
    const neutralSrc = readFileSync(
      join(__dirname, '../agent-chat-neutral/run-chat-turn-neutral.ts'),
      'utf8',
    )
    const sdkSrc = readFileSync(join(__dirname, '../agent-chat-sdk/run-chat-turn-sdk.ts'), 'utf8')
    expect(neutralSrc).not.toMatch(/kind:\s*['"]steered['"]/)
    expect(sdkSrc).not.toMatch(/kind:\s*['"]steered['"]/)

    const routeSrc = readFileSync(
      join(__dirname, '../../../editor-cli/src/server/chat-handler.ts'),
      'utf8',
    )
    const routeEmitters = routeSrc.match(/kind:\s*['"]steered['"]/g) ?? []
    expect(routeEmitters).toHaveLength(1)
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
      let step = 0
      return () =>
        (async function* () {
          if (step++ === 0) {
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
