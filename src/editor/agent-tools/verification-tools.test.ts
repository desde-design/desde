/**
 * Tests for the `run_verification` ToolEntry. Uses a stub
 * VerificationAdapter so we exercise the tool's plumbing (input
 * validation, missing adapter handling, output shape) without
 * spinning up a real child process per test.
 */

import { describe, expect, it } from 'vitest'

import type { BridgeClient, ToolContext } from './types'
import { runVerificationTool } from './verification-tools'
import type {
  VerificationAdapter,
  VerificationCheck,
  VerificationRunResult,
} from '../core/verification-adapter'

const fakeBridge: BridgeClient = {
  async send() {
    return null
  },
}

function makeAdapter(
  fixedResult: VerificationRunResult,
  observedCheck: { value?: VerificationCheck } = {},
): VerificationAdapter {
  return {
    substrateLabel: 'npm',
    async run(check) {
      observedCheck.value = check
      return fixedResult
    },
  }
}

const baseResult: VerificationRunResult = {
  ok: true,
  exitCode: 0,
  stdout: 'all good',
  stderr: '',
  durationMs: 12,
  command: 'npm run typecheck',
}

const baseCtx: ToolContext = {
  bridge: fakeBridge,
  repoRoot: '/tmp/repo',
}

describe('runVerificationTool', () => {
  it('returns a "not configured" error when no adapter is wired', async () => {
    const r = await runVerificationTool.run({ check: 'typecheck' }, baseCtx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not configured/)
  })

  it('rejects an unknown check string', async () => {
    const observed = {}
    const ctx: ToolContext = {
      ...baseCtx,
      verificationAdapter: makeAdapter(baseResult, observed),
    }
    const r = await runVerificationTool.run(
      { check: 'bogus' as unknown as VerificationCheck },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unknown check/)
  })

  it('passes the check through to the adapter and returns its result + substrate label', async () => {
    const observed: { value?: VerificationCheck } = {}
    const ctx: ToolContext = {
      ...baseCtx,
      verificationAdapter: makeAdapter(baseResult, observed),
    }
    const r = await runVerificationTool.run({ check: 'typecheck' }, ctx)
    expect(observed.value).toBe('typecheck')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as {
      substrate: string
      check: VerificationCheck
      ok: boolean
      command: string
    }
    expect(out.substrate).toBe('npm')
    expect(out.check).toBe('typecheck')
    expect(out.ok).toBe(true)
    expect(out.command).toBe('npm run typecheck')
  })

  it('relays noScript=true plus availableScripts through unchanged', async () => {
    const adapter = makeAdapter({
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: 'No script defined',
      durationMs: 0,
      command: '<no-script:lint>',
      noScript: true,
      availableScripts: ['build', 'test'],
    })
    const ctx: ToolContext = { ...baseCtx, verificationAdapter: adapter }
    const r = await runVerificationTool.run({ check: 'lint' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { noScript?: boolean; availableScripts?: string[] }
    expect(out.noScript).toBe(true)
    expect(out.availableScripts).toEqual(['build', 'test'])
  })
})
