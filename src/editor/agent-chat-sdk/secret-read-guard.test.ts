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

/**
 * FX17 item 3b. On this lane a `PreToolUse` hook cannot filter results, so
 * an AIMED-scope refusal is not the whole policy: `Grep` in `output_mode:
 * "content"` with no scope at all returned matching LINES from the whole
 * tree, `.env` included, and every branch of both guards passed it. No
 * clever spelling was needed — the aimed-scope check was decorative on this
 * path.
 */
describe('SDK lane — a content-mode Grep (FX17 item 3b)', () => {
  function gate(allowSecretReads?: boolean) {
    return buildToolPermissionGate({
      worktreeRoot: root,
      emitEditProposal: async () => ({ ok: true, editId: '' }),
      ...(allowSecretReads === true ? { allowSecretReads: true } : {}),
    })
  }

  it('is refused with no scope at all — the shape that needed no bypass', async () => {
    const { decision, reason } = await guardDecision('Grep', {
      pattern: 'KEY',
      output_mode: 'content',
    })
    expect(decision).toBe('deny')
    expect(reason).toContain('output_mode')
    expect(reason).not.toContain(FAKE_KEY)
  })

  it('is refused for a directory scope, which cannot be proven secret-free', async () => {
    for (const input of [
      { pattern: 'KEY', output_mode: 'content', path: 'src' },
      { pattern: 'KEY', output_mode: 'content', path: '.' },
      { pattern: 'KEY', output_mode: 'content', glob: '**/*.ts' },
    ]) {
      expect((await guardDecision('Grep', input)).decision, JSON.stringify(input)).toBe('deny')
    }
  })

  it('runs as written when the scope is one non-credential file', async () => {
    const { decision } = await guardDecision('Grep', {
      pattern: 'App',
      output_mode: 'content',
      path: 'src/App.tsx',
    })
    expect(decision).toBeUndefined()
  })

  it('refuses even a single-file scope when that file is the credential', async () => {
    expect(
      (await guardDecision('Grep', { pattern: 'KEY', output_mode: 'content', path: '.env' }))
        .decision,
    ).toBe('deny')
  })

  it('leaves the other output modes alone — a name is not a content', async () => {
    for (const mode of [undefined, 'files_with_matches', 'count']) {
      const input = { pattern: 'KEY', ...(mode ? { output_mode: mode } : {}) }
      expect((await guardDecision('Grep', input)).decision, String(mode)).toBeUndefined()
    }
  })

  it('is allowed with the project override on', async () => {
    expect(
      (await guardDecision('Grep', { pattern: 'KEY', output_mode: 'content' }, true)).decision,
    ).toBeUndefined()
  })

  it('is refused at the shared gate too, which is the other end', async () => {
    const out = await gate()('Grep', { pattern: 'KEY', output_mode: 'content' }, {})
    expect(out.behavior).toBe('deny')
    expect((await gate(true)('Grep', { pattern: 'KEY', output_mode: 'content' }, {})).behavior).toBe(
      'allow',
    )
  })

  it("does not touch the neutral lane's Grep, which declares no output_mode", async () => {
    // The neutral lane owns its own Grep and filters secret hits out of the
    // RESULTS. Its tool schema has `pattern`, `glob` and `case_insensitive`
    // and nothing else, so this branch is false for every call it makes.
    const out = await gate()('Grep', { pattern: 'KButton', glob: 'src/**/*.vue' }, {})
    expect(out.behavior).toBe('allow')
  })
})

/**
 * FX17 item 4. Editor's own tools are namespaced `mcp__editor__*` and
 * existed on BOTH lanes. The SDK hook was registered for `Read|Glob|Grep`,
 * and the shared gate routed only NON-editor MCP tools to a policy, so
 * `read_file_at_commit(path: '.env', sha: 'HEAD')` returned committed
 * contents and `diff_file` returned the same bytes as hunks.
 */
describe("the editor's own tools reach the policy (FX17 item 4)", () => {
  function gate(allowSecretReads?: boolean) {
    return buildToolPermissionGate({
      worktreeRoot: root,
      emitEditProposal: async () => ({ ok: true, editId: '' }),
      ...(allowSecretReads === true ? { allowSecretReads: true } : {}),
    })
  }

  const SECRET_CALLS: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['mcp__editor__read_file_at_commit', { root: 'worktree', path: '.env', sha: 'HEAD' }],
    ['mcp__editor__diff_file', { root: 'worktree', path: '.env' }],
    ['mcp__editor__session_diff', { path: '.env.local' }],
    ['mcp__editor__delete_file', { path: 'packages/api/.env' }],
    ['mcp__editor__read_file_at_commit', { root: 'prod', path: '.envrc', sha: 'HEAD' }],
    ['mcp__editor__rename_file', { from: '.env', to: 'notes.txt' }],
    ['mcp__editor__search_external_files', { root: 'prod', query: 'KEY', paths: ['**/.en?'] }],
  ]

  it.each(SECRET_CALLS)('the PreToolUse hook denies %s', async (tool, input) => {
    const { decision, reason } = await guardDecision(tool, input)
    expect(decision).toBe('deny')
    expect(reason).not.toContain(FAKE_KEY)
  })

  it.each(SECRET_CALLS)('the shared gate denies %s', async (tool, input) => {
    expect((await gate()(tool, input, {})).behavior).toBe('deny')
  })

  it.each(SECRET_CALLS)('the project override allows %s', async (tool, input) => {
    expect((await guardDecision(tool, input, true)).decision).toBeUndefined()
    expect((await gate(true)(tool, input, {})).behavior).toBe('allow')
  })

  it('leaves ordinary editor-tool calls alone', async () => {
    for (const [tool, input] of [
      ['mcp__editor__read_file_at_commit', { path: 'src/App.tsx', sha: 'HEAD' }],
      ['mcp__editor__diff_file', { path: 'src/App.tsx' }],
      ['mcp__editor__session_diff', {}],
      ['mcp__editor__rename_file', { from: 'src/App.tsx', to: 'src/Main.tsx' }],
      ['mcp__editor__get_selection', {}],
    ] as ReadonlyArray<[string, Record<string, unknown>]>) {
      expect((await guardDecision(tool, input)).decision, tool).toBeUndefined()
      expect((await gate()(tool, input, {})).behavior, tool).toBe('allow')
    }
  })

  it('catches an in-repo symlink pointing at the credential', async () => {
    symlinkSync(join(root, '.env'), join(root, 'src/notes.md'))
    const { decision } = await guardDecision('mcp__editor__diff_file', { path: 'src/notes.md' })
    expect(decision).toBe('deny')
  })
})
