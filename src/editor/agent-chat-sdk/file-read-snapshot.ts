/**
 * Phase 4 of tasks/editor-detached-sessions.md — base-content capture
 * for git-flavored conflict resolution.
 *
 * Provides a `PreToolUse` SDK hook that snapshots file content whenever
 * the SDK is about to call its built-in `Read` tool. The snapshot is
 * the "base" against which we later detect stale-base overwrites
 * (Phase 4 §1) and run 3-way merges (§5).
 *
 * Why PreToolUse (not canUseTool):
 *   - The SDK's `canUseTool` permission callback only fires for
 *     "dangerous operations" (Write/Edit/etc.) under `permissionMode:
 *     'default'`. Read is auto-allowed without invoking canUseTool — so
 *     decorating canUseTool would never see Read calls. Verified
 *     end-to-end by `scripts/editor-detached-sessions-phase-4-spike.ts`.
 *   - `hooks.PreToolUse` fires for every tool, including Read. That's
 *     the right primitive for non-permission-related instrumentation.
 *
 * Why not a custom Read tool:
 *   - The SDK's built-in Read emits the line-numbered format the model
 *     was trained on. Replacing it with a custom tool would degrade
 *     model performance for no semantic gain — we'd reimplement the
 *     same formatter, plus our snapshot side-channel.
 *
 * Best-effort by design: any failure to read the file, write the
 * sidecar, or resolve the path is silently swallowed. The conflict
 * detection downstream treats "no snapshot recorded" the same as "file
 * not read by this session" — falls back to the per-session edit
 * timeline for source-of-truth, not a hard fail.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'

import { resolveRepoPath } from '../agent-tools/read-tools'

export interface FileReadRecord {
  /** Absolute path of the file the SDK read (worktree-relative resolved). */
  absolutePath: string
  /** sha256 of the file content at read time. Hex. */
  hashAtRead: string
  /** Absolute path to the sidecar file that holds the base content. */
  baseContentPath: string
  /** ISO 8601 timestamp. */
  readAt: string
}

export interface ReadSnapshotOptions {
  /** Absolute path to the worktree the SDK is running against. */
  worktreeRoot: string
  /**
   * Per-session sidecar root, typically
   * `<repoRoot>/.desde/chat-sessions/<sessionId>`. Base content is
   * written under `<snapshotRoot>/bases/<sha256>.txt`.
   */
  snapshotRoot: string
  /**
   * Optional in-process observer. Fires every time a Read snapshot is
   * successfully captured. Phase 4's `ChatSession.fileReads` map is the
   * intended consumer — the orchestrator can subscribe and persist the
   * record onto the session record.
   */
  onReadObserved?: (record: FileReadRecord) => void
}

/**
 * Build a `PreToolUse` hook callback that snapshots file content when
 * the SDK is about to run its built-in `Read` tool. Pass through
 * `hooks: { PreToolUse: [{ matcher: 'Read', hooks: [callback] }] }` to
 * the SDK's `query()` options.
 *
 * The hook is a pure observer — always returns `{ continue: true }` so
 * the SDK proceeds with the Read. Snapshot side-effects are awaited
 * (Phase 4 §1's conflict detection requires the snapshot to be on
 * disk before the next write).
 */
export function createReadSnapshotHook(opts: ReadSnapshotOptions): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true }
    }
    const preInput = input as PreToolUseHookInput
    if (preInput.tool_name !== 'Read') {
      return { continue: true }
    }
    const toolInput = preInput.tool_input as { file_path?: unknown } | undefined
    const filePath = toolInput?.file_path
    if (typeof filePath === 'string' && filePath.length > 0) {
      await captureSnapshot(filePath, opts)
    }
    return { continue: true }
  }
}

async function captureSnapshot(
  filePath: string,
  opts: ReadSnapshotOptions,
): Promise<void> {
  try {
    const safe = await resolveRepoPath(opts.worktreeRoot, filePath)
    if (!safe.ok) return
    let content: Buffer
    try {
      content = await readFile(safe.absolute)
    } catch {
      return
    }
    const hash = createHash('sha256').update(content).digest('hex')
    const baseContentPath = join(opts.snapshotRoot, 'bases', `${hash}.txt`)
    try {
      await mkdir(dirname(baseContentPath), { recursive: true })
      // Content-addressed within the session — two reads of the same
      // unchanged file dedupe to one sidecar. Overwriting is safe
      // because the content is identical; we don't check first to keep
      // the hot path branch-free.
      await writeFile(baseContentPath, content)
    } catch {
      return
    }
    opts.onReadObserved?.({
      absolutePath: safe.absolute,
      hashAtRead: hash,
      baseContentPath,
      readAt: new Date().toISOString(),
    })
  } catch {
    // Defense in depth — never propagate any failure from the
    // snapshot side-channel. Conflict detection downstream falls
    // back to "no snapshot" gracefully.
  }
}
