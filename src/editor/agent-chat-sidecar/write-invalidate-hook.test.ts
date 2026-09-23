/**
 * Tests for `createWriteInvalidateHook` — the PostToolUse hook that
 * replays successful SDK `Write` / `Edit` calls into the Vite dev
 * pipeline via the CLI's `invalidateFiles` callback. Drives the hook
 * callback directly (no SDK runtime) with synthetic PostToolUse inputs.
 */

import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createWriteInvalidateHook } from './write-invalidate-hook'

const HOOK_OPTS = { signal: new AbortController().signal }

function postToolUse(toolName: string, toolInput: unknown): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'test-session',
    transcript_path: '/dev/null',
    cwd: '/',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: {},
    tool_use_id: 'tu-1',
  } as HookInput
}

describe('createWriteInvalidateHook', () => {
  let root: string

  beforeEach(async () => {
    // realpath so macOS /var → /private/var doesn't make repo-relative
    // resolution look like an escape.
    root = await realpath(await mkdtemp(join(tmpdir(), 'pt-inv-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('invalidates the repo-relative path for a Write (absolute file_path)', async () => {
    await writeFile(join(root, 'App.vue'), '<template>x</template>\n', 'utf8')
    const invalidateFiles = vi.fn()
    const hook = createWriteInvalidateHook({ worktreeRoot: root, invalidateFiles })
    const out = await hook(
      postToolUse('Write', { file_path: join(root, 'App.vue') }),
      'tu-1',
      HOOK_OPTS,
    )
    expect(out).toEqual({ continue: true })
    expect(invalidateFiles).toHaveBeenCalledExactlyOnceWith(['App.vue'])
  })

  it('invalidates for an Edit with a relative file_path', async () => {
    await writeFile(join(root, 'main.ts'), 'export {}\n', 'utf8')
    const invalidateFiles = vi.fn()
    const hook = createWriteInvalidateHook({ worktreeRoot: root, invalidateFiles })
    await hook(postToolUse('Edit', { file_path: 'main.ts' }), 'tu-1', HOOK_OPTS)
    expect(invalidateFiles).toHaveBeenCalledExactlyOnceWith(['main.ts'])
  })

  it('follows symlinks to the real target inside the repo', async () => {
    await writeFile(join(root, 'real.ts'), 'export {}\n', 'utf8')
    await symlink(join(root, 'real.ts'), join(root, 'link.ts'))
    const invalidateFiles = vi.fn()
    const hook = createWriteInvalidateHook({ worktreeRoot: root, invalidateFiles })
    await hook(postToolUse('Write', { file_path: 'link.ts' }), 'tu-1', HOOK_OPTS)
    expect(invalidateFiles).toHaveBeenCalledExactlyOnceWith(['real.ts'])
  })

  it('invalidates when the configured repo root is itself a symlink', async () => {
    // Codex: a symlinked repo root (or macOS /var → /private/var) must
    // be canonicalized before the containment check, or every valid
    // in-repo edit looks like an escape and is silently skipped.
    await writeFile(join(root, 'App.vue'), '<template>x</template>\n', 'utf8')
    const alias = join(await mkdtemp(join(tmpdir(), 'pt-inv-alias-')), 'repo')
    await symlink(root, alias)
    try {
      const invalidateFiles = vi.fn()
      const hook = createWriteInvalidateHook({ worktreeRoot: alias, invalidateFiles })
      await hook(
        postToolUse('Write', { file_path: join(alias, 'App.vue') }),
        'tu-1',
        HOOK_OPTS,
      )
      expect(invalidateFiles).toHaveBeenCalledExactlyOnceWith(['App.vue'])
    } finally {
      await rm(dirname(alias), { recursive: true, force: true })
    }
  })

  it('skips paths that resolve outside the repo', async () => {
    const invalidateFiles = vi.fn()
    const hook = createWriteInvalidateHook({ worktreeRoot: root, invalidateFiles })
    const out = await hook(
      postToolUse('Write', { file_path: join(tmpdir(), 'elsewhere.ts') }),
      'tu-1',
      HOOK_OPTS,
    )
    expect(out).toEqual({ continue: true })
    expect(invalidateFiles).not.toHaveBeenCalled()
  })

  it('ignores non-Write/Edit tools and malformed input', async () => {
    const invalidateFiles = vi.fn()
    const hook = createWriteInvalidateHook({ worktreeRoot: root, invalidateFiles })
    await hook(postToolUse('Read', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await hook(postToolUse('Write', { file_path: '' }), 'tu-1', HOOK_OPTS)
    await hook(postToolUse('Write', {}), 'tu-1', HOOK_OPTS)
    await hook(postToolUse('Write', undefined), 'tu-1', HOOK_OPTS)
    expect(invalidateFiles).not.toHaveBeenCalled()
  })

  it('always continues even when invalidateFiles throws', async () => {
    await writeFile(join(root, 'App.vue'), '<template>x</template>\n', 'utf8')
    const hook = createWriteInvalidateHook({
      worktreeRoot: root,
      invalidateFiles: () => {
        throw new Error('watcher torn down')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await hook(
        postToolUse('Write', { file_path: 'App.vue' }),
        'tu-1',
        HOOK_OPTS,
      )
      expect(out).toEqual({ continue: true })
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
