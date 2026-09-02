/**
 * Unit tests for the WS4 edit-fix mini-turn wrapper. runChatTurnSdk is
 * injected (deps.runTurn), so these verify the wrapper's own contract:
 * prompt content, constrained options, sentinel parsing, timeout/error
 * degradation to a refusal, and throwaway-session hygiene.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runEditFixMiniTurn } from './edit-fix-mini-turn'
import type { EditFixMiniTurnInput } from './edit-fix-mini-turn'
import type { RunChatTurnSdkOpts, RunChatTurnSdkResult } from './run-chat-turn-sdk'

function makeInput(repoRoot: string, overrides: Partial<EditFixMiniTurnInput> = {}): EditFixMiniTurnInput {
  return {
    repoRoot,
    file: 'src/App.vue',
    line: 5,
    column: 3,
    propName: 'title',
    newValue: 'Hello',
    fallback: { kind: 'bound-binding', expression: 'pageTitle' },
    deterministicReason: 'Cannot overwrite bound prop "title".',
    ...overrides,
  }
}

function turnResultWithText(text: string): RunChatTurnSdkResult {
  return {
    session: {} as RunChatTurnSdkResult['session'],
    turn: {
      assistantContent: [{ kind: 'text', text }],
    } as unknown as RunChatTurnSdkResult['turn'],
  }
}

describe('runEditFixMiniTurn', () => {
  it('constrains the turn: budget, built-ins, disallowed interactive tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-turn-'))
    let captured: RunChatTurnSdkOpts | null = null
    const result = await runEditFixMiniTurn(makeInput(dir), {
      runTurn: async (opts) => {
        captured = opts
        return turnResultWithText('EDIT_APPLIED: changed pageTitle ref in src/App.vue')
      },
    })
    rmSync(dir, { recursive: true, force: true })

    expect(result).toEqual({
      outcome: 'applied',
      notes: 'changed pageTitle ref in src/App.vue',
    })
    const opts = captured!
    expect(opts.maxTurns).toBe(12)
    expect(opts.costCeilingUsd).toBe(1.0)
    expect(opts.builtinTools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep'])
    expect(opts.disallowedTools).toContain('mcp__editor__ask_user_question')
    expect(opts.disallowedTools).toContain('mcp__editor__propose_prop_edit')
    // The mini-turn's own write guard must NOT record undo/redo history —
    // its writes are provisional until the CLI handler's post-turn
    // validation passes (a refused/unparseable outcome rolls them back,
    // which would jam a guard-recorded step forever). Pinned here so a
    // refactor can't silently drop this opt-out.
    expect(opts.recordHistory).toBe(false)
    // The prompt carries the refusal context the agent needs.
    expect(opts.userMessage).toContain('src/App.vue:5:3')
    expect(opts.userMessage).toContain('"Hello"')
    expect(opts.userMessage).toContain('pageTitle')
    expect(opts.userMessage).toContain('EDIT_APPLIED')
    // Headless: throwaway session id, no-op emit, stub bridge.
    expect(opts.session.id.sessionId).toMatch(/^mini-edit-fix-/)
    expect(await opts.bridge.send('chat:get_selection', {})).toBeNull()
  })

  it('parses EDIT_REFUSED into a refusal with the agent reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-turn-'))
    const result = await runEditFixMiniTurn(makeInput(dir), {
      runTurn: async () =>
        turnResultWithText('I traced the binding.\nEDIT_REFUSED: value is shared by 4 pages'),
    })
    rmSync(dir, { recursive: true, force: true })
    expect(result.outcome).toBe('refused')
    expect(result.notes).toBe('value is shared by 4 pages')
  })

  it('treats a missing sentinel as no-verdict (caller diff decides)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-turn-'))
    const result = await runEditFixMiniTurn(makeInput(dir), {
      runTurn: async () => turnResultWithText('I looked around but am not sure.'),
    })
    rmSync(dir, { recursive: true, force: true })
    expect(result.outcome).toBe('no-verdict')
    expect(result.notes).toMatch(/without an EDIT_APPLIED/)
  })

  it('degrades a thrown turn (abort/timeout/API error) to a refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-turn-'))
    const result = await runEditFixMiniTurn(makeInput(dir), {
      runTurn: async () => {
        throw new Error('rate limited')
      },
    })
    rmSync(dir, { recursive: true, force: true })
    expect(result.outcome).toBe('refused')
    expect(result.notes).toContain('rate limited')
  })

  it('cleans up the throwaway session sidecar dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mini-turn-'))
    let sessionId = ''
    await runEditFixMiniTurn(makeInput(dir), {
      runTurn: async (opts) => {
        sessionId = opts.session.id.sessionId
        // Simulate the Read-snapshot hook's sidecar pollution.
        const bases = join(dir, '.desde', 'chat-sessions', sessionId, 'bases')
        mkdirSync(bases, { recursive: true })
        writeFileSync(join(bases, 'abc.txt'), 'snapshot')
        return turnResultWithText('EDIT_REFUSED: nope')
      },
    })
    // Cleanup is fire-and-forget — give the microtask a beat.
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(dir, '.desde', 'chat-sessions', sessionId))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
