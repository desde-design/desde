/**
 * Unit tests for the `verify_goal` handler in `editor-tool-handlers.ts`.
 *
 * `verify_goal` is the L3a rung: it composes the LLM translate step
 * (`translateGoal`) with the pure predicate judge (`verifyGoal`) over live
 * measurements read off the bridge. The predicate/verifier internals are
 * covered by `verification/{predicates,verify-goal}.test.ts`; these tests cover
 * the SDK adapter:
 *   - input validation (goal / selector)
 *   - the bridge round-trip + capability gate (`chat:read_measurements`)
 *   - pass / fail / skipped mapping
 *
 * The LLM translate step is mocked so the test is deterministic — the handler
 * only PICKS predicates via translateGoal; code judges them.
 */

import { describe, expect, it, vi } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import type { Measurements } from '../verification'

// Mock the (server-only) LLM translate step. The handler imports it directly
// from './translate-goal'; stub it so no real model call happens.
vi.mock('../verification/translate-goal', () => ({
  translateGoal: vi.fn(),
}))
import { translateGoal } from '../verification/translate-goal'
import { verifyGoalTool } from './editor-tool-handlers'

const mockTranslate = vi.mocked(translateGoal)

/** Measurements fixture; override the leaves a predicate reads. */
function meas(over: Partial<{ scrollWidth: number; clientWidth: number }> = {}): Measurements {
  return {
    bbox: { x: 0, y: 0, width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40 },
    scrollWidth: over.scrollWidth ?? 100,
    clientWidth: over.clientWidth ?? 100,
    scrollHeight: 40,
    clientHeight: 40,
    parentBbox: null,
    viewport: { width: 1280, height: 800 },
    computedStyle: {
      color: 'rgb(0,0,0)',
      backgroundColor: 'rgb(255,255,255)',
      fontSize: '16px',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      textTransform: 'none',
    },
    textContent: '',
  }
}

/** Bridge whose `chat:read_measurements` replies with the given payload. */
function bridgeWith(payload: { measurements?: Measurements | null; supported?: boolean }): {
  bridge: BridgeClient
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn(async (messageType: string) => {
    if (messageType === 'chat:read_measurements') return payload
    return null
  })
  return { bridge: { send }, send }
}

function parse(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    pass?: boolean
    status?: string
    skipped?: boolean
    reason?: string
    detail?: string
    goal?: string
  }
}

describe('verify_goal — input validation', () => {
  it('rejects an empty goal', async () => {
    const { bridge, send } = bridgeWith({ measurements: meas(), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: '  ', selector: '.x' })
    expect(r.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
  it('rejects an empty selector', async () => {
    const { bridge, send } = bridgeWith({ measurements: meas(), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit content', selector: '' })
    expect(r.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('verify_goal — capability gate', () => {
  it('reports skipped when the bridge is too old (supported:false)', async () => {
    const { bridge } = bridgeWith({ measurements: null, supported: false })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit content width', selector: '.x' })
    const out = parse(r)
    expect(out.skipped).toBe(true)
    expect(out.reason).toMatch(/too old/i)
    // Must not have called the LLM translate step on an unmeasurable bridge.
    expect(mockTranslate).not.toHaveBeenCalled()
  })
})

describe('verify_goal — verdict mapping', () => {
  it('returns pass:true when the predicate passes', async () => {
    mockTranslate.mockResolvedValue({ ok: true, predicates: [{ predicate: 'noOverflow', args: {} }] })
    const { bridge } = bridgeWith({ measurements: meas({ scrollWidth: 100, clientWidth: 100 }), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit the content width', selector: '.x' })
    const out = parse(r)
    expect(out.pass).toBe(true)
    expect(out.status).toBe('pass')
  })

  it('returns pass:false with detail when the predicate fails', async () => {
    mockTranslate.mockResolvedValue({ ok: true, predicates: [{ predicate: 'noOverflow', args: {} }] })
    const { bridge } = bridgeWith({ measurements: meas({ scrollWidth: 220, clientWidth: 100 }), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit the content width', selector: '.x' })
    const out = parse(r)
    expect(out.pass).toBe(false)
    expect(out.status).toBe('fail')
    expect(out.detail).toMatch(/overflow/i)
  })

  it('reports skipped (with a screenshot hint) for an aesthetic goal', async () => {
    mockTranslate.mockResolvedValue({ ok: false, reason: 'purely aesthetic', kind: 'unmeasurable' })
    const { bridge } = bridgeWith({ measurements: meas(), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'make it look nicer', selector: '.x' })
    const out = parse(r)
    expect(out.skipped).toBe(true)
    expect(JSON.stringify(out)).toMatch(/capture_screenshot/)
  })

  it('surfaces a translate infra-error as isError, NOT a benign skip', async () => {
    // e.g. LLM auth failure — must not be hidden behind "use a screenshot".
    mockTranslate.mockResolvedValue({ ok: false, reason: 'LLM call failed: 401 unauthorized', kind: 'error' })
    const { bridge } = bridgeWith({ measurements: meas(), supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit content width', selector: '.x' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/could not run/i)
    expect(r.content[0].text).not.toMatch(/skipped/)
  })

  it('reports skipped when the element cannot be measured (supported but null)', async () => {
    mockTranslate.mockResolvedValue({ ok: true, predicates: [{ predicate: 'noOverflow', args: {} }] })
    const { bridge } = bridgeWith({ measurements: null, supported: true })
    const r = await verifyGoalTool({ bridge }, { goal: 'fit content width', selector: '.gone' })
    const out = parse(r)
    expect(out.skipped).toBe(true)
  })
})

describe("verify_goal hands the translate step the session's resolved provider", () => {
  it('passes ctx.resolveLlmProvider through to translateGoal', async () => {
    mockTranslate.mockResolvedValue({ ok: true, predicates: [{ predicate: 'noOverflow', args: {} }] })
    const { bridge } = bridgeWith({ measurements: meas(), supported: true })
    const resolveLlmProvider = vi.fn(() => ({
      name: 'fake',
      defaultModel: 'fake-model',
      complete: vi.fn(),
    }))
    await verifyGoalTool(
      { bridge, resolveLlmProvider },
      { goal: 'make this fit the content width', selector: '.card' },
    )
    // The tool's only LLM touch. Without this thread it would fall back to the
    // process-wide registry and ignore the project's `llm` block.
    expect(resolveLlmProvider).not.toHaveBeenCalled()
    expect(mockTranslate).toHaveBeenCalledWith(
      expect.objectContaining({ resolveProvider: resolveLlmProvider }),
    )
  })
})
