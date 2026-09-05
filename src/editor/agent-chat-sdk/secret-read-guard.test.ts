/**
 * The SDK lane's half of the FX15 proof.
 *
 * The subject is `createSecretReadGuard`, not the permission gate, and that is
 * the point of this file. On this lane the SDK auto-allows Read without ever
 * firing `canUseTool` (see `file-read-snapshot.ts`), so a test that only
 * exercised the gate would prove a policy the SDK's Read never passes through.
 * The `PreToolUse` hook is where the refusal actually happens here.
 *
 * The gate is covered too, at the bottom, because it is still the SDK lane's
 * second end and a future SDK build that does route Read through `canUseTool`
 * must find a policy there.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookInput } from '@anthropic-ai/claude-agent-sdk'

import { buildToolPermissionGate } from './edit-ack'
import { createSecretReadGuard } from './secret-read-guard'

const FAKE_KEY = 'sk-NOT-A-REAL-KEY-0000'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-secret-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/App.tsx'), 'export const App = () => null\n', 'utf8')
  writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${FAKE_KEY}\n`, 'utf8')
  writeFileSync(join(root, '.env.example'), 'OPENAI_API_KEY=\n', 'utf8')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** One `PreToolUse` payload, shaped the way the SDK delivers it. */
function preToolUse(tool_name: string, tool_input: unknown): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input,
    tool_use_id: 'toolu_test',
    session_id: 's',
    transcript_path: '/dev/null',
    cwd: root,
    permission_mode: 'default',
  } as unknown as HookInput
}

async function guardDecision(
  tool: string,
  input: unknown,
  allowSecretReads?: boolean,
): Promise<{ decision: string | undefined; reason: string | undefined }> {
  const guard = createSecretReadGuard({
    worktreeRoot: root,
    ...(allowSecretReads === true ? { allowSecretReads: true } : {}),
  })
  const out = await guard(preToolUse(tool, input), undefined, { signal: new AbortController().signal })
  const specific = (out as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput
  return {
    decision: specific?.permissionDecision as string | undefined,
    reason: specific?.permissionDecisionReason as string | undefined,
  }
}

describe('SDK lane — the PreToolUse guard', () => {
  it('denies a Read of .env', async () => {
    const { decision, reason } = await guardDecision('Read', { file_path: '.env' })
    expect(decision).toBe('deny')
    expect(reason).toContain('credentials')
    expect(reason).not.toContain(FAKE_KEY)
  })

  it('denies a Read of every .env variant', async () => {
    for (const p of ['.env.local', '.env.production', 'packages/api/.env']) {
      expect((await guardDecision('Read', { file_path: p })).decision, p).toBe('deny')
    }
  })

  it('denies a Read reached through an in-repo symlink', async () => {
    symlinkSync(join(root, '.env'), join(root, 'src/notes.md'))
    expect((await guardDecision('Read', { file_path: 'src/notes.md' })).decision).toBe('deny')
  })

  it('allows a Read of .env.example', async () => {
    expect((await guardDecision('Read', { file_path: '.env.example' })).decision).toBeUndefined()
  })

  it('allows a Read of ordinary source', async () => {
    expect((await guardDecision('Read', { file_path: 'src/App.tsx' })).decision).toBeUndefined()
  })

  it('denies a Glob whose pattern names the file', async () => {
    expect((await guardDecision('Glob', { pattern: '**/.env*' })).decision).toBe('deny')
    expect((await guardDecision('Glob', { pattern: '**/*.pem' })).decision).toBe('deny')
  })

  it('denies a Grep scoped at the file, by glob or by path', async () => {
    expect((await guardDecision('Grep', { pattern: 'KEY', glob: '.env*' })).decision).toBe('deny')
    expect((await guardDecision('Grep', { pattern: 'KEY', path: '.env' })).decision).toBe('deny')
  })

  it("does not read Grep's regular expression as a path", async () => {
    const { decision } = await guardDecision('Grep', { pattern: '\\.env', glob: 'src/**/*' })
    expect(decision).toBeUndefined()
  })

  it('allows a broad enumeration', async () => {
    expect((await guardDecision('Glob', { pattern: '**/*' })).decision).toBeUndefined()
    expect((await guardDecision('Grep', { pattern: 'KEY' })).decision).toBeUndefined()
  })

  it('leaves tools other than Read, Glob and Grep alone', async () => {
    expect((await guardDecision('Write', { file_path: '.env' })).decision).toBeUndefined()
  })

  it('allows all of it when the override is on', async () => {
    expect((await guardDecision('Read', { file_path: '.env' }, true)).decision).toBeUndefined()
    expect((await guardDecision('Glob', { pattern: '**/.env*' }, true)).decision).toBeUndefined()
    expect(
      (await guardDecision('Grep', { pattern: 'KEY', glob: '.env*' }, true)).decision,
    ).toBeUndefined()
  })

  it('ignores a hook event that is not PreToolUse', async () => {
    const guard = createSecretReadGuard({ worktreeRoot: root })
    const out = await guard(
      { hook_event_name: 'PostToolUse', tool_name: 'Read' } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    )
    expect((out as { hookSpecificOutput?: unknown }).hookSpecificOutput).toBeUndefined()
  })
})

describe('SDK lane — the shared gate, its second end', () => {
  function gate(allowSecretReads?: boolean) {
    return buildToolPermissionGate({
      worktreeRoot: root,
      emitEditProposal: async () => ({ ok: true, editId: '' }),
      ...(allowSecretReads === true ? { allowSecretReads: true } : {}),
    })
  }

  it('denies Read, Glob and Grep for a secret path', async () => {
    expect((await gate()('Read', { file_path: '.env' }, {})).behavior).toBe('deny')
    expect((await gate()('Glob', { pattern: '.env*' }, {})).behavior).toBe('deny')
    expect((await gate()('Grep', { pattern: 'K', glob: '**/.env' }, {})).behavior).toBe('deny')
  })

  it('allows them with the override on', async () => {
    expect((await gate(true)('Read', { file_path: '.env' }, {})).behavior).toBe('allow')
    expect((await gate(true)('Glob', { pattern: '.env*' }, {})).behavior).toBe('allow')
  })
})
