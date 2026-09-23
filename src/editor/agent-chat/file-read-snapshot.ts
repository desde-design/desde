/**
 * Phase 4 of tasks/editor-detached-sessions.md — base-content capture
 * for git-flavored conflict resolution.
 *
 * `captureReadSnapshot` snapshots one file's content as the "base"
 * against which we later detect stale-base overwrites (Phase 4 §1) and
 * run 3-way merges (§5). Both chat lanes call it directly from their own
 * read observer (the neutral lane's own `Read` tool; the SDK lane's
 * `onFileRead` in `run-chat-turn-sidecar.ts`) — there is no SDK hook
 * here any more. The built-in-Read `PreToolUse` hook this module used to
 * export (`createReadSnapshotHook`) was deleted once the SDK lane
 * stopped running the SDK's built-in Read at all; see
 * `run-chat-turn-sidecar.ts` for that cutover.
 *
 * Best-effort by design: any failure to read the file, write the
 * sidecar, or resolve the path is silently swallowed. The conflict
 * detection downstream treats "no snapshot recorded" the same as "file
 * not read by this session" — falls back to the per-session edit
 * timeline for source-of-truth, not a hard fail.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveRepoPath } from '../agent-tools/read-tools'
import { desdePath } from '../worktree/desde-dir'

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
   * The chat session the snapshot belongs to. Base content is written
   * under `<repoRoot>/.desde/chat-sessions/<sessionId>/bases/<sha256>.txt`
   * — the path `resolve-conflict.ts` reads the merge base back from.
   *
   * The session id rather than a pre-built root, so the `.desde` symlink
   * guard runs where a refusal is already tolerated: this whole lane is
   * best-effort, and `desdeDir` throwing at the caller's option-assembly
   * line would take the turn down instead of skipping one snapshot.
   */
  sessionId: string
}

/**
 * Snapshot one file's current bytes as the read-time base, and return the
 * record describing it — or `null` when nothing could be captured.
 *
 * Exported because the neutral lane owns its own `Read` tool and so has no
 * SDK hook to hang this on: it calls this directly from the tool's read
 * observer. Both lanes therefore write the SAME layout, which is what makes
 * "Merge" work on either of them — `resolve-conflict.ts` looks the base up by
 * `<sessionId>/bases/<hashAtRead>.txt` and does not know which runtime wrote
 * it.
 *
 * Best-effort by construction: every failure returns `null` rather than
 * throwing, including a `.desde` that is a symlink out of the worktree.
 */
export async function captureReadSnapshot(
  filePath: string,
  opts: ReadSnapshotOptions,
): Promise<FileReadRecord | null> {
  try {
    const safe = await resolveRepoPath(opts.worktreeRoot, filePath)
    if (!safe.ok) return null
    let content: Buffer
    try {
      content = await readFile(safe.absolute)
    } catch {
      return null
    }
    const hash = createHash('sha256').update(content).digest('hex')
    const baseContentPath = desdePath(
      opts.worktreeRoot,
      'chat-sessions',
      opts.sessionId,
      'bases',
      `${hash}.txt`,
    )
    try {
      await mkdir(dirname(baseContentPath), { recursive: true })
      // Content-addressed within the session — two reads of the same
      // unchanged file dedupe to one sidecar. Overwriting is safe
      // because the content is identical; we don't check first to keep
      // the hot path branch-free.
      await writeFile(baseContentPath, content)
    } catch {
      return null
    }
    return {
      absolutePath: safe.absolute,
      hashAtRead: hash,
      baseContentPath,
      readAt: new Date().toISOString(),
    }
  } catch {
    // Defense in depth — never propagate any failure from the
    // snapshot side-channel. Conflict detection downstream falls
    // back to "no snapshot" gracefully.
    return null
  }
}
