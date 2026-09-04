/**
 * Per-edit backup journal for the SDK structural write tools
 * (`delete_file`, `rename_file`, `insert_component`, `insert_element`,
 * `scaffold_route`, `manage_package`).
 *
 * Branch mode edits the user's working tree in place with no per-op
 * commit — undo comes from the backup journal, not git history
 * (tasks/branches-vs-worktree.md). This mirrors the convention the CLI
 * edit handler established (editor-cli/src/server/edit-handler.ts):
 * originals land at `.desde/backups/<timestamp>-<uuid>/<repoRel>`
 * before any mutation touches disk. The timestamp+uuid directory is
 * unique per operation, so concurrent ops can't clobber each other's
 * backups and the writes need no locking.
 *
 * Callers write the backup BEFORE mutating and treat a failure as a
 * refusal (no source files modified) — same contract as the edit
 * handler's "Patch aborted; no source files modified."
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { desdeDir } from '../worktree/desde-dir'

export interface BackupEntry {
  /** Repo-relative path the original content lived at. */
  file: string
  /**
   * The pre-mutation file content. Pass a Buffer for files that may
   * not be UTF-8 text (delete/rename take arbitrary paths — a backup
   * round-tripped through a string would corrupt binary bytes).
   */
  content: string | Buffer
}

export type BackupJournalResult =
  | {
      ok: true
      /** Repo-relative backup directory (e.g. `.desde/backups/…`). */
      backupDir: string
    }
  | { ok: false; reason: string }

/**
 * Thrown by {@link writeBackupJournal} when an entry's `file` key would
 * resolve OUTSIDE the fresh `.desde/backups/<ts>-<uuid>/` directory
 * once joined against it.
 *
 * This is a caller bug, not a runtime condition a well-formed request
 * can trigger. Every caller is expected to journal under a key already
 * proven to resolve inside the repo root — e.g. `path.relative(rootReal,
 * targetPath)` derived from an already-realpath'd, root-contained
 * absolute path — never a raw request/sourceLoc-supplied string. The
 * concrete exploit this closes: a `file` carrying enough leading `../`
 * segments to re-descend back to a path INSIDE the repo root (so it
 * passes a root-containment guard built around `path.resolve(rootReal,
 * file)`) can still, when joined against the DIFFERENTLY-nested
 * `backupDir` (`rootReal/.desde/backups/<ts>-<uuid>/`, three
 * segments deeper), pop past `backupDir` — and potentially the repo
 * root itself — before re-descending, landing the backup write
 * somewhere else entirely, with intermediate directories auto-created
 * by `mkdir(..., { recursive: true })`. Thrown (not returned as
 * `{ ok: false }`) so it fails loud rather than reading as an ordinary
 * "backup write failed" refusal, and every entry is validated BEFORE
 * any of them touch disk — mirrors `brokeredWrite`'s pre-journal
 * validation pattern in `write-broker.ts`.
 */
export class BackupJournalPathEscapeError extends Error {
  constructor(public readonly file: string) {
    super(
      `writeBackupJournal: entry '${file}' resolves outside the backup directory. Refusing to write it.`,
    )
    this.name = 'BackupJournalPathEscapeError'
  }
}

/**
 * Write `entries` into a fresh journal directory under
 * `<canonicalRoot>/.desde/backups/`. All-or-nothing from the
 * caller's perspective: any write failure returns `ok: false` and the
 * caller must not proceed with its mutation. Throws
 * {@link BackupJournalPathEscapeError} (before touching disk) if any
 * entry's key would escape the backup directory.
 */
export async function writeBackupJournal(
  canonicalRoot: string,
  entries: ReadonlyArray<BackupEntry>,
): Promise<BackupJournalResult> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
  const backupDir = join(
    desdeDir(canonicalRoot),
    'backups',
    `${timestamp}-${randomUUID()}`,
  )
  const backupDirWithSep = backupDir.endsWith(sep) ? backupDir : backupDir + sep

  // Validate every entry BEFORE any of them touch disk — a batch with
  // one escaping key refuses the WHOLE batch, not just the offending
  // entry, so a legitimate entry can never land while a malicious
  // sibling is silently dropped.
  for (const entry of entries) {
    const resolvedBackupPath = resolve(backupDir, entry.file)
    if (resolvedBackupPath !== backupDir && !resolvedBackupPath.startsWith(backupDirWithSep)) {
      throw new BackupJournalPathEscapeError(entry.file)
    }
  }

  for (const entry of entries) {
    const backupPath = join(backupDir, entry.file)
    try {
      await mkdir(dirname(backupPath), { recursive: true })
      // Strings default to utf8; Buffers are written byte-for-byte.
      await writeFile(backupPath, entry.content)
    } catch (err) {
      return {
        ok: false,
        reason: `Backup write failed for '${entry.file}': ${(err as Error).message}`,
      }
    }
  }
  return { ok: true, backupDir: relative(canonicalRoot, backupDir) }
}
