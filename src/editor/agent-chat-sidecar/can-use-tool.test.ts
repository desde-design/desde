import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildToolPermissionGate } from '../agent-chat/edit-ack'
import { buildCanUseTool } from './can-use-tool'

/**
 * `CanUseTool` may resolve `null` since SDK 0.3.259 (the host declining to
 * decide). `buildCanUseTool` always decides, so a `null` here is a failure
 * the assertions below should see as one, not silently narrow around.
 */
async function call(
  cut: CanUseTool,
  ...args: Parameters<CanUseTool>
): Promise<PermissionResult> {
  const r = await cut(...args)
  if (r === null) throw new Error('canUseTool resolved null')
  return r
}

function fakeOpts(): Parameters<CanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    // Required since SDK 0.3.259: the control_request envelope id a host
    // echoes when answering out-of-band. Unused by `buildCanUseTool`.
    requestId: 'req-1',
  }
}

describe('buildCanUseTool', () => {
  let root: string
  const noEmit = async () => ({ ok: true as const, editId: 'e1' })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'can-use-tool-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is the same closure buildToolPermissionGate wraps: a protected path is denied on both', async () => {
    const opts = { worktreeRoot: root, emitEditProposal: noEmit }
    const gate = buildToolPermissionGate(opts)
    const canUseTool = buildCanUseTool(opts)
    const input = { file_path: '.mcp.json', content: '{}' }
    const viaGate = await gate('Write', input, {})
    const viaSdk = await canUseTool('Write', input, {} as never)
    expect(viaGate.behavior).toBe('deny')
    expect(viaSdk).not.toBeNull()
    expect(viaSdk!.behavior).toBe('deny')
    expect((viaSdk as { message: string }).message).toBe((viaGate as { message: string }).message)
  })

  it('translates the SDK options.blockedPath into the gate\'s ctx.blockedPath (B2)', async () => {
    const cut = buildCanUseTool({ worktreeRoot: root, emitEditProposal: noEmit })
    const r = await call(
      cut,
      'Read',
      { file_path: '/some/path' },
      { ...fakeOpts(), blockedPath: '/some/path' },
    )
    expect(r.behavior).toBe('deny')
    expect((r as { message: string }).message).toMatch(/out of bounds/)
  })

  it('ignores an empty-string blockedPath the same as an absent one', async () => {
    const cut = buildCanUseTool({ worktreeRoot: root, emitEditProposal: noEmit })
    const r = await call(cut, 'mcp__editor__get_selection', {}, { ...fakeOpts(), blockedPath: '' })
    expect(r).toEqual({ behavior: 'allow', updatedInput: {} })
  })

  it('never resolves null: the SDK may, this wrapper always decides', async () => {
    const cut = buildCanUseTool({ worktreeRoot: root, emitEditProposal: noEmit })
    const r = await cut('mcp__editor__get_selection', {}, fakeOpts())
    expect(r).not.toBeNull()
  })
})
