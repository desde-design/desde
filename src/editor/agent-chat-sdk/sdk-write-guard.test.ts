/**
 * Tests for `createSdkWriteGuard` — the PreToolUse/PostToolUse bracket that
 * gives the SDK's built-in `Write`/`Edit` the journal + per-file-lock coverage
 * every other Editor mutation lane has (audit Task 13).
 *
 * Drives the hook callbacks directly with synthetic hook inputs (no SDK
 * runtime), mirroring `write-invalidate-hook.test.ts`.
 */

import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { createSdkWriteGuard } from './sdk-write-guard'
import type { HistoryRecorder } from './write-broker'
import { hashContent, readLedger } from '../ledger/edit-ledger'
import type { LedgerEditEntry } from '../ledger/entry'
import { planLedgerUndo, type UndoDeps } from '../ledger/undo-entry'

const HOOK_OPTS = { signal: new AbortController().signal }

function preToolUse(toolName: string, toolInput: unknown, toolUseId = 'tu-1'): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'test-session',
    transcript_path: '/dev/null',
    cwd: '/',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  } as HookInput
}

function terminal(
  event: 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied',
  toolUseId = 'tu-1',
): HookInput {
  return {
    hook_event_name: event,
    session_id: 'test-session',
    transcript_path: '/dev/null',
    cwd: '/',
    tool_name: 'Write',
    tool_input: {},
    tool_use_id: toolUseId,
    ...(event === 'PostToolUse' ? { tool_response: {} } : {}),
    ...(event === 'PostToolUseFailure' ? { error: 'boom' } : {}),
    ...(event === 'PermissionDenied' ? { reason: 'denied' } : {}),
  } as HookInput
}

/** Every file journalled under `.desde/backups/`, as repoRel → content. */
async function journalledFiles(root: string): Promise<Record<string, string>> {
  const backupsRoot = join(root, '.desde', 'backups')
  let dirs: string[]
  try {
    dirs = await readdir(backupsRoot)
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const dir of dirs) {
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(backupsRoot, dir, rel), { withFileTypes: true })
      for (const entry of entries) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(next)
        else out[next] = await readFile(join(backupsRoot, dir, next), 'utf8')
      }
    }
    await walk('')
  }
  return out
}

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pt-write-guard-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createSdkWriteGuard — journaling', () => {
  it('journals the original BEFORE the tool executes, leaving the file untouched', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const guard = createSdkWriteGuard({ worktreeRoot: root })

    const out = await guard.preToolUse(
      preToolUse('Write', { file_path: join(root, 'App.vue'), content: 'NEXT\n' }),
      'tu-1',
      HOOK_OPTS,
    )

    // The hook is awaited by the SDK before execution, so by the time it
    // returns the original must already be recoverable.
    expect(out).toEqual({ continue: true })
    expect(await journalledFiles(root)).toEqual({ 'App.vue': 'ORIGINAL\n' })
    expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe('ORIGINAL\n')
  })

  it('journals for Edit as well as Write, and accepts a relative file_path', async () => {
    await writeFile(join(root, 'main.ts'), 'export {}\n', 'utf8')
    const guard = createSdkWriteGuard({ worktreeRoot: root })
    await guard.preToolUse(preToolUse('Edit', { file_path: 'main.ts' }), 'tu-1', HOOK_OPTS)
    expect(await journalledFiles(root)).toEqual({ 'main.ts': 'export {}\n' })
  })

  it('journals nothing for a Write that creates a new file', async () => {
    const guard = createSdkWriteGuard({ worktreeRoot: root })
    const out = await guard.preToolUse(
      preToolUse('Write', { file_path: 'src/New.vue', content: 'x' }),
      'tu-1',
      HOOK_OPTS,
    )
    expect(out).toEqual({ continue: true })
    expect(await journalledFiles(root)).toEqual({})
  })

  it('dedupes an identical (path, content) journal within the turn but re-journals after a change', async () => {
    await writeFile(join(root, 'App.vue'), 'V1\n', 'utf8')
    const writeJournal = vi.fn(
      async (
        _canonicalRoot: string,
        _entries: ReadonlyArray<{ file: string; content: string | Buffer }>,
      ) => ({ ok: true as const, backupDir: '.desde/backups/x' }),
    )
    const guard = createSdkWriteGuard({ worktreeRoot: root, writeJournal })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-2', HOOK_OPTS)
    expect(writeJournal).toHaveBeenCalledTimes(1)

    // The SDK's write landed — the next edit has a different original.
    await writeFile(join(root, 'App.vue'), 'V2\n', 'utf8')
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-3', HOOK_OPTS)
    expect(writeJournal).toHaveBeenCalledTimes(2)
    expect(writeJournal.mock.calls[1][1]).toEqual([{ file: 'App.vue', content: Buffer.from('V2\n') }])
  })

  it('DENIES the write and releases the lock when the original cannot be journalled', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: async () => release,
      writeJournal: async () => ({ ok: false as const, reason: 'EACCES' }),
    })

    const out = (await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue', content: 'NEXT' }),
      'tu-1',
      HOOK_OPTS,
    )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('App.vue')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('EACCES')
    // A denied write never executes, so the hold must not survive it.
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it('DENIES the write when .desde is a symlink out of the worktree (real writeJournal, no mock)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const outside = await mkdtemp(join(tmpdir(), 'sdk-write-guard-outside-'))
    await symlink(outside, join(root, '.desde'))
    // No `writeJournal` override — this exercises the real
    // `writeBackupJournal`, which is what actually contains the guard.
    const guard = createSdkWriteGuard({ worktreeRoot: root })

    const out = (await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue', content: 'NEXT' }),
      'tu-1',
      HOOK_OPTS,
    )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }

    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/\.desde/)
    expect(existsSync(join(outside, 'backups'))).toBe(false)
    await rm(outside, { recursive: true, force: true })
  })

  it('ignores non-Write/Edit tools, malformed input and paths outside the repo', async () => {
    const acquireWriteLock = vi.fn(async () => vi.fn())
    const writeJournal = vi.fn(async () => ({ ok: true as const, backupDir: 'x' }))
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock, writeJournal })

    await guard.preToolUse(preToolUse('Read', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Write', { file_path: '' }), 'tu-2', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Write', {}), 'tu-3', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Write', undefined), 'tu-4', HOOK_OPTS)
    await guard.preToolUse(
      preToolUse('Write', { file_path: join(tmpdir(), 'elsewhere.ts') }),
      'tu-5',
      HOOK_OPTS,
    )

    expect(acquireWriteLock).not.toHaveBeenCalled()
    expect(writeJournal).not.toHaveBeenCalled()
  })
})

describe('createSdkWriteGuard — lock hold window', () => {
  it('holds the lock across the tool call and releases on PostToolUse', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    const acquireWriteLock = vi.fn(async () => release)
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    expect(acquireWriteLock).toHaveBeenCalledExactlyOnceWith('App.vue')
    expect(release).not.toHaveBeenCalled()
    expect(guard.heldPathsForTests()).toEqual(['App.vue'])

    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it.each(['PostToolUseFailure', 'PermissionDenied'] as const)(
    'releases on %s (a write that never landed)',
    async (event) => {
      await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
      const release = vi.fn()
      const guard = createSdkWriteGuard({
        worktreeRoot: root,
        acquireWriteLock: async () => release,
      })
      await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
      await guard.release(terminal(event), 'tu-1', HOOK_OPTS)
      expect(release).toHaveBeenCalledOnce()
      expect(guard.heldPathsForTests()).toEqual([])
    },
  )

  it('is idempotent for a repeated terminal event and a no-op for an unknown tool_use_id', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: async () => release,
    })
    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PostToolUse', 'tu-unknown'), 'tu-unknown', HOOK_OPTS)
    expect(release).toHaveBeenCalledOnce()
  })

  it('refcounts a second write to the same file instead of deadlocking against itself', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    const acquireWriteLock = vi.fn(async () => release)
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock })

    // Both pre-hooks resolve even though the first hold is still open — the
    // shape an SDK build that resolves a whole batch's PreToolUse hooks
    // before executing any of them would produce.
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-2'), 'tu-2', HOOK_OPTS)
    expect(acquireWriteLock).toHaveBeenCalledOnce()

    await guard.release(terminal('PostToolUse', 'tu-1'), 'tu-1', HOOK_OPTS)
    expect(release).not.toHaveBeenCalled()
    await guard.release(terminal('PostToolUse', 'tu-2'), 'tu-2', HOOK_OPTS)
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it('does not double-count a duplicate PreToolUse delivery for the same tool_use_id', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    const acquireWriteLock = vi.fn(async () => release)
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    expect(acquireWriteLock).toHaveBeenCalledOnce()

    // One terminal event for one tool_use must fully drain it — a surplus
    // refcount would keep the file locked until the turn-end sweep.
    await guard.release(terminal('PostToolUse', 'tu-1'), 'tu-1', HOOK_OPTS)
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it('does not double-acquire when two duplicate deliveries race the SAME acquisition', async () => {
    // The leak the reviewer caught with a live probe: two PreToolUse
    // deliveries for one tool_use_id, BOTH entering before the acquisition
    // resolves. The registered-id check can't see an in-flight acquisition,
    // so without `acquireInFlight` both take a ref (refcount 2), the single
    // PostToolUse drops one, and the watchdog's finishToolUse finds nothing —
    // leaving the per-file mutex AND the tree-shared gate held until turn end.
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    let grant!: () => void
    const granted = new Promise<void>((r) => {
      grant = r
    })
    const acquireWriteLock = vi.fn(async () => {
      await granted
      return release
    })
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock })

    const first = guard.preToolUse(
      preToolUse('Edit', { file_path: 'App.vue' }, 'tu-dup'),
      'tu-dup',
      HOOK_OPTS,
    )
    // Wait until delivery 1 is genuinely PARKED on the acquisition — the hook
    // does async path resolution first, so a bare microtask tick would let
    // delivery 2 arrive after registration and miss the window entirely.
    await vi.waitFor(() => expect(acquireWriteLock).toHaveBeenCalled())
    const second = guard.preToolUse(
      preToolUse('Edit', { file_path: 'App.vue' }, 'tu-dup'),
      'tu-dup',
      HOOK_OPTS,
    )
    // …and until delivery 2 has reached the duplicate check (past realpath).
    await new Promise((r) => setTimeout(r, 20))
    grant()
    expect(await first).toEqual({ continue: true })
    expect(await second).toEqual({ continue: true })
    expect(acquireWriteLock).toHaveBeenCalledOnce()

    // ONE terminal event must fully drain it.
    await guard.release(terminal('PostToolUse', 'tu-dup'), 'tu-dup', HOOK_OPTS)
    await Promise.resolve()
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it('degrades to journal-only (and orphans nothing) when the lock does not arrive in budget', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const release = vi.fn()
    let grant!: () => void
    const granted = new Promise<void>((r) => {
      grant = r
    })
    const onWarn = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: async () => {
        await granted
        return release
      },
      acquireBudgetMs: 20,
      onWarn,
    })

    const out = await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue' }, 'tu-slow'),
      'tu-slow',
      HOOK_OPTS,
    )
    // The write is not blocked — it proceeds journalled but unserialized.
    expect(out).toEqual({ continue: true })
    expect(await journalledFiles(root)).toEqual({ 'App.vue': 'ORIGINAL\n' })
    expect(onWarn.mock.calls[0][0]).toContain('JOURNAL-ONLY')
    expect(onWarn.mock.calls[0][0]).toContain('App.vue')
    expect(guard.heldPathsForTests()).toEqual([])

    // The abandoned acquisition must release itself the moment it lands,
    // not orphan a hold nobody will ever match to a tool_use.
    grant()
    await new Promise((r) => setTimeout(r, 0))
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it("gives up when the hook's AbortSignal fires before the lock is granted", async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const controller = new AbortController()
    const onWarn = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: () => new Promise<() => void>(() => {}),
      // Long budget — the signal, not the timer, must be what ends the wait.
      acquireBudgetMs: 60_000,
      onWarn,
    })
    const pending = guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue' }, 'tu-abort'),
      'tu-abort',
      { signal: controller.signal },
    )
    controller.abort()
    expect(await pending).toEqual({ continue: true })
    expect(onWarn.mock.calls[0][0]).toContain('JOURNAL-ONLY')
    expect(guard.heldPathsForTests()).toEqual([])
  })

  it('announces journal-only mode once when no acquirer is injected', async () => {
    await writeFile(join(root, 'App.vue'), 'A\n', 'utf8')
    await writeFile(join(root, 'Other.vue'), 'B\n', 'utf8')
    const onWarn = vi.fn()
    const guard = createSdkWriteGuard({ worktreeRoot: root, onWarn })
    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(
      preToolUse('Write', { file_path: 'Other.vue' }, 'tu-2'),
      'tu-2',
      HOOK_OPTS,
    )
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0][0]).toContain('JOURNAL-ONLY')
  })

  it('force-releases a hold that never sees a terminal event (watchdog)', async () => {
    vi.useFakeTimers()
    try {
      await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
      const release = vi.fn()
      const onWarn = vi.fn()
      const guard = createSdkWriteGuard({
        worktreeRoot: root,
        acquireWriteLock: async () => release,
        lockHoldTimeoutMs: 5_000,
        onWarn,
      })
      await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
      expect(release).not.toHaveBeenCalled()

      vi.advanceTimersByTime(5_001)
      await Promise.resolve()
      await Promise.resolve()

      expect(release).toHaveBeenCalledOnce()
      expect(guard.heldPathsForTests()).toEqual([])
      expect(onWarn).toHaveBeenCalledOnce()
      expect(onWarn.mock.calls[0][0]).toContain('force-releasing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('releaseAll() drains leaked holds (turn crash / abort)', async () => {
    await writeFile(join(root, 'App.vue'), 'A\n', 'utf8')
    await writeFile(join(root, 'Other.vue'), 'B\n', 'utf8')
    const releases = [vi.fn(), vi.fn()]
    let i = 0
    const onWarn = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: async () => releases[i++],
      onWarn,
    })
    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    await guard.preToolUse(
      preToolUse('Write', { file_path: 'Other.vue' }, 'tu-2'),
      'tu-2',
      HOOK_OPTS,
    )
    expect(guard.heldPathsForTests()).toHaveLength(2)

    guard.releaseAll('turn end')
    await Promise.resolve()

    expect(releases[0]).toHaveBeenCalledOnce()
    expect(releases[1]).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
    expect(onWarn).toHaveBeenCalledOnce()
    // Safe to call twice (the finally can run after a partial release).
    guard.releaseAll('turn end')
    expect(releases[0]).toHaveBeenCalledOnce()
  })

  it('still journals — and never blocks the write — when acquiring the lock throws', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const onWarn = vi.fn()
    const guard = createSdkWriteGuard({
      worktreeRoot: root,
      acquireWriteLock: async () => {
        throw new Error('lock manager down')
      },
      onWarn,
    })
    const out = await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue' }),
      'tu-1',
      HOOK_OPTS,
    )
    expect(out).toEqual({ continue: true })
    expect(await journalledFiles(root)).toEqual({ 'App.vue': 'ORIGINAL\n' })
    expect(guard.heldPathsForTests()).toEqual([])
    expect(onWarn.mock.calls[0][0]).toContain('lock manager down')
  })
})

describe('createSdkWriteGuard — undo/redo history recording (Task 5)', () => {
  function fakeHistory(): { history: HistoryRecorder; record: ReturnType<typeof vi.fn> } {
    const record = vi.fn(async () => {})
    return { history: { record }, record }
  }

  it('records a step for a successful Write: before=pre-tool bytes, after=post-tool bytes, label "AI edit: <repoRel>"', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue', content: 'NEXT\n' }),
      'tu-1',
      HOOK_OPTS,
    )
    // Simulate the SDK's own write, which runs between preToolUse and the
    // terminal event — the guard never performs the write itself.
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith({
      label: 'AI edit: App.vue',
      files: [
        {
          repoRel: 'App.vue',
          absPath: join(root, 'App.vue'),
          before: { exists: true, content: Buffer.from('ORIGINAL\n') },
          after: { exists: true, content: Buffer.from('NEXT\n') },
        },
      ],
    })
  })

  it('records nothing for a failed tool call (PostToolUseFailure)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    // The tool execution failed — the file is untouched.
    await guard.release(terminal('PostToolUseFailure'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing when canUseTool denies the write (PermissionDenied)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PermissionDenied'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing for a no-op write (bytes unchanged)', async () => {
    await writeFile(join(root, 'App.vue'), 'SAME\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    // The SDK's Edit executed but produced identical bytes (e.g. old_string
    // === new_string, or a refused in-place no-op the tool still reports as
    // PostToolUse success).
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing on releaseAll (turn-end sweep) — a crashed/aborted turn leaves no step', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    guard.releaseAll('turn end')

    await new Promise((r) => setTimeout(r, 10))
    expect(record).not.toHaveBeenCalled()
  })

  it('records nothing when no history recorder is injected (existing callers are unaffected)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const guard = createSdkWriteGuard({ worktreeRoot: root })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    const out = await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)
    expect(out).toEqual({ continue: true })
  })

  it('records a step for a successful Edit even in journal-only mode (no acquireWriteLock injected)', async () => {
    // The edit-fix mini-turn passes no `acquireWriteLock` — it already runs
    // under the tree gate EXCLUSIVE — so it never gets a `ToolUseHold`. The
    // history capture must not depend on one existing.
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    expect(guard.heldPathsForTests()).toEqual([])
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record.mock.calls[0][0].label).toBe('AI edit: App.vue')
  })

  it('records nothing for a Write that creates a new file when the file is later deleted before release (defensive)', async () => {
    // Not a documented case in the brief, but exercises `after.exists: false`
    // through the same path — the file created by the Write is removed
    // before PostToolUse fires.
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'New.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'New.vue'), 'X\n', 'utf8')
    await rm(join(root, 'New.vue'))
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    // before={exists:false} and after={exists:false} — still a no-op.
    await new Promise((r) => setTimeout(r, 10))
    expect(record).not.toHaveBeenCalled()
  })

  it('a history.record rejection is caught and warned, never thrown from release', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const onWarn = vi.fn()
    const record = vi.fn(async () => {
      throw new Error('disk full')
    })
    const guard = createSdkWriteGuard({ worktreeRoot: root, history: { record }, onWarn })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    const out = await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)
    expect(out).toEqual({ continue: true })

    await vi.waitFor(() =>
      expect(onWarn.mock.calls.some((c) => String(c[0]).includes('disk full'))).toBe(true),
    )
  })

  it('records correctly in the PRODUCTION shape (acquireWriteLock provided) — the after-read happens before the lock is released, not after', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    // Simulates a concurrent writer racing in the INSTANT the lock frees —
    // the injected release callback itself mutates the file. If the
    // guard's "after" read happened AFTER releasing the lock (the pre-fix
    // ordering Important-2 fixed), it would capture THESE bytes instead of
    // the tool's own write, and a later undo would silently revert this
    // racing writer's edit too.
    const release = vi.fn(() => {
      writeFileSync(join(root, 'App.vue'), 'RACING-WRITER\n', 'utf8')
    })
    const acquireWriteLock = vi.fn(async () => release)
    const guard = createSdkWriteGuard({ worktreeRoot: root, acquireWriteLock, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    expect(guard.heldPathsForTests()).toEqual(['App.vue'])
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    // The lock released — and its release callback (the racing writer) DID
    // fire, proving this is a genuine race, not a no-op stand-in.
    expect(release).toHaveBeenCalledOnce()
    expect(guard.heldPathsForTests()).toEqual([])
    expect(await readFile(join(root, 'App.vue'), 'utf8')).toBe('RACING-WRITER\n')
    // … yet the recorded step still captured the TOOL's bytes ('NEXT'),
    // not the racing writer's ('RACING-WRITER') — the after-read ran
    // strictly BEFORE the lock (and its release callback) fired.
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record).toHaveBeenCalledWith({
      label: 'AI edit: App.vue',
      files: [
        {
          repoRel: 'App.vue',
          absPath: join(root, 'App.vue'),
          before: { exists: true, content: Buffer.from('ORIGINAL\n') },
          after: { exists: true, content: Buffer.from('NEXT\n') },
        },
      ],
    })
  })

  it('a duplicate PreToolUse delivery for the same tool_use_id preserves the FIRST before-state', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    // First delivery captures 'ORIGINAL'.
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-dup'), 'tu-dup', HOOK_OPTS)
    // The SDK mutates the file between the two hook deliveries (the shape
    // an SDK build that re-delivers PreToolUse for one tool_use would
    // produce) — the SECOND delivery must NOT overwrite the captured
    // before-state with these intermediate bytes.
    await writeFile(join(root, 'App.vue'), 'INTERMEDIATE\n', 'utf8')
    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-dup'), 'tu-dup', HOOK_OPTS)

    await writeFile(join(root, 'App.vue'), 'FINAL\n', 'utf8')
    await guard.release(terminal('PostToolUse', 'tu-dup'), 'tu-dup', HOOK_OPTS)

    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce())
    expect(record.mock.calls[0][0].files[0].before).toEqual({
      exists: true,
      content: Buffer.from('ORIGINAL\n'),
    })
    expect(record.mock.calls[0][0].files[0].after).toEqual({
      exists: true,
      content: Buffer.from('FINAL\n'),
    })
  })

  it('two sequential edits to the same file produce two steps that chain (step2.before == step1.after)', async () => {
    await writeFile(join(root, 'App.vue'), 'V1\n', 'utf8')
    const { history, record } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-1'), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'V2\n', 'utf8')
    await guard.release(terminal('PostToolUse', 'tu-1'), 'tu-1', HOOK_OPTS)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }, 'tu-2'), 'tu-2', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'V3\n', 'utf8')
    await guard.release(terminal('PostToolUse', 'tu-2'), 'tu-2', HOOK_OPTS)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2))

    const step1 = record.mock.calls[0][0]
    const step2 = record.mock.calls[1][0]
    expect(step1.files[0].before).toEqual({ exists: true, content: Buffer.from('V1\n') })
    expect(step1.files[0].after).toEqual({ exists: true, content: Buffer.from('V2\n') })
    expect(step2.files[0].before).toEqual(step1.files[0].after)
    expect(step2.files[0].after).toEqual({ exists: true, content: Buffer.from('V3\n') })
  })
})

// P1-1 (whole-branch review finding, 2026-08-18): the SDK's built-in
// Write/Edit bypass `brokeredWrite` entirely — the SDK owns that write
// syscall — so without a hook of its own here, a primary chat write lane
// produced NO edit-ledger entry and `GET /api/editor/ledger` silently
// omitted it. Reuses the same `readLedger`-drives-through-the-real-thing
// discipline the other ledger tests use, per the design doc's own
// "the failure mode to design against" note: a producer and consumer
// individually testing green but disagreeing when wired together.
describe('createSdkWriteGuard — edit-ledger recording (P1-1)', () => {
  function fakeHistory(): { history: HistoryRecorder; record: ReturnType<typeof vi.fn> } {
    const record = vi.fn(async () => {})
    return { history: { record }, record }
  }

  async function ledgerEditEntries(): Promise<LedgerEditEntry[]> {
    const entries = await readLedger(root)
    return entries.filter((e): e is LedgerEditEntry => e.type === 'edit')
  }

  it('appends a ledger entry for a successful Write, kind "write", lane "chat"', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(
      preToolUse('Write', { file_path: 'App.vue', content: 'NEXT\n' }),
      'tu-1',
      HOOK_OPTS,
    )
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry).toMatchObject({ kind: 'write', lane: 'chat', files: ['App.vue'] })
    expect(entry.afterHashes).toHaveProperty('App.vue')
  })

  it('appends a ledger entry for a successful Edit, kind "edit"', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.kind).toBe('edit')
  })

  it('appends nothing for a failed tool call (PostToolUseFailure)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PostToolUseFailure'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(await ledgerEditEntries()).toEqual([])
  })

  it('appends nothing for a no-op write (bytes unchanged)', async () => {
    await writeFile(join(root, 'App.vue'), 'SAME\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Edit', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(await ledgerEditEntries()).toEqual([])
  })

  // The load-bearing exclusion: the edit-fix mini-turn's OWN guard
  // instance is created with no `history` (`recordHistory: false` on its
  // `runChatTurnSdk` call — see edit-handler.ts), because its writes are
  // PROVISIONAL until the handler's own post-turn validation passes. If
  // this hook recorded a ledger entry per intermediate write regardless,
  // a fix later rolled back by `cleanupAllWrites` would still have a
  // permanent (append-only) ledger row for a change that never survived.
  // The mini-turn instead records ONE consolidated entry itself, once a
  // fix is verified durable — this is what makes that safe.
  it('appends nothing when no history recorder is injected (the mini-turn shape)', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const guard = createSdkWriteGuard({ worktreeRoot: root })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await new Promise((r) => setTimeout(r, 10))
    expect(await ledgerEditEntries()).toEqual([])
  })

  it('appends a normal write with a real content hash', async () => {
    await writeFile(join(root, 'New.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'New.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'New.vue'), 'X\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.afterHashes).toEqual({ 'New.vue': expect.any(String) })
  })

  it('degrades to NO afterHashes entry (never a wrong one) when the file is gone by the time release reads it', async () => {
    // The file existed pre-tool and is gone by the time `release` reads
    // the post-write state — a genuine change (not a no-op skip), but one
    // with no bytes to hash. `afterHashes` must omit the file entirely
    // rather than record a stale or empty hash — Plan B's Undo already
    // refuses an entry with a MISSING hash for a file, which is the safe
    // direction; a wrong hash is not.
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await rm(join(root, 'App.vue'))
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.afterHashes).toEqual({})
  })

  // C2 (round-2 whole-branch review finding, 2026-08-19): `journalOriginal`
  // computed a real `backupDir` and then threw it away before the ledger
  // entry was built, so a primary chat Write/Edit's ledger row always
  // landed with NO recovery path even though `journalOriginal` had already
  // written a real backup to disk for it. Plan B's Undo is gated on
  // `backupDir` naming a directory that actually exists — this used to
  // make Undo read as unavailable for every ordinary chat edit.
  it('carries the real backupDir through to the ledger entry for an edit of an existing file', async () => {
    await writeFile(join(root, 'App.vue'), 'ORIGINAL\n', 'utf8')
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'App.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'App.vue'), 'NEXT\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.backupDir).toBeTruthy()
    // Not just present — pointing at a directory `journalOriginal` really
    // wrote the original into.
    const original = await readFile(join(root, entry.backupDir!, 'App.vue'), 'utf8')
    expect(original).toBe('ORIGINAL\n')
  })

  // Parity with C1's rule for `brokeredWrite`: a brand-new file has no
  // prior content, so `journalOriginal` never calls the journal at all —
  // the ledger entry must not advertise a backup directory that was never
  // created.
  it('records no backupDir for a Write that creates a brand-new file', async () => {
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'New.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'New.vue'), 'BRAND NEW\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.backupDir).toBeUndefined()
  })

  // P2-1 (codex review round 6, 2026-08-20): `snapshot.before.exists ===
  // false` is exactly the fact the test above already relies on (no
  // `backupDir`, because there was nothing to back up) — but before this
  // fix that fact was known here and never carried onto the entry as
  // `createdFiles`. Plan B's Undo planner (`undo-entry.ts`) then had NO
  // signal that this write created the file, and its round-3 fix
  // correctly refuses (`unbacked`) rather than guess — so a provably
  // safe "delete this unchanged created file" Undo was unavailable for
  // every SDK-created file.
  it('records createdFiles for a Write that creates a brand-new file (P2-1)', async () => {
    const { history } = fakeHistory()
    const guard = createSdkWriteGuard({ worktreeRoot: root, history })

    await guard.preToolUse(preToolUse('Write', { file_path: 'New.vue' }), 'tu-1', HOOK_OPTS)
    await writeFile(join(root, 'New.vue'), 'BRAND NEW\n', 'utf8')
    await guard.release(terminal('PostToolUse'), 'tu-1', HOOK_OPTS)

    await vi.waitFor(async () => expect(await ledgerEditEntries()).toHaveLength(1))
    const [entry] = await ledgerEditEntries()
    expect(entry.createdFiles).toEqual(['New.vue'])

    // Not just present — the planner it exists for now treats the entry
    // as undoable, where before it would have refused as `unbacked`.
    const deps: UndoDeps = {
      hashFile: async (repoRel) => {
        try {
          return hashContent(await readFile(join(root, repoRel)))
        } catch {
          return null
        }
      },
      backupDirExists: async () => false,
      backupHasFile: async () => false,
      readBackup: async () => {
        throw new Error('should not be called — nothing was backed up')
      },
    }
    const plan = await planLedgerUndo(entry, deps)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.ops).toEqual([{ kind: 'delete', repoRel: 'New.vue' }])
    }
  })
})
