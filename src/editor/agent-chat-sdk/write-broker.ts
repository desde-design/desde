/**
 * The single backup → write → invalidate → emit path for Editor's
 * source mutations (audit Task 12).
 *
 * Before this module the sequence (journal originals → take the per-file
 * write lock → mutate → invalidate Vite → emit the audit proposal) was
 * hand-rolled eight times: once per structural SDK tool in
 * `fs-structural-tools.ts` and twice inside `handleLLMPatch`
 * (editor-cli/src/server/edit-handler.ts). The copies had drifted — the
 * LLM-result lane's backup directory was timestamp-only, so two patches
 * landing in the same millisecond could clobber each other's originals,
 * and no structural tool took a write lock at all. `brokeredWrite` is the
 * one implementation those call sites now share.
 *
 * ## Contract
 *
 * 1. **Journal first.** `journal` (originals, repo-relative) is written to
 *    `.desde/backups/<timestamp>-<uuid>/` via {@link writeBackupJournal}
 *    — the single source of backup-dir naming, so the uuid suffix is now
 *    ALWAYS applied. A journal failure refuses the whole operation with
 *    `stage: 'backup'` and nothing on disk is touched.
 * 2. **Hold the whole batch's locks.** Every path the batch touches
 *    (including rename destinations) is locked UPFRONT, deduped and in
 *    globally sorted order, and held until the batch finishes — writes
 *    and any rollback both happen inside that window. Sorted acquisition
 *    is the anti-ABBA discipline that makes holding the set safe: two
 *    batches over {A,B} and {B,A} still acquire in the same order.
 *
 *    Releasing each lock as its own op completed (the original shape)
 *    left a gap: op A lands, its lock drops, a concurrent writer
 *    legitimately modifies A, then op B fails and the rollback rewrites
 *    A — clobbering that writer. Batches reaching the broker without the
 *    CLI's outer edit locks (SDK structural tools from concurrent chat
 *    sessions) had nothing else protecting them.
 * 3. **Restore on failure.** If an op fails, every path touched so far —
 *    the failing op's own included, since its write may have landed
 *    partially — is put back to the state captured when the locks were
 *    taken. That in-memory snapshot, not the journal, is the rollback
 *    source: the journal holds what the CALLER read (possibly long
 *    before it called us), while the snapshot is the bytes this batch
 *    actually clobbered, so restoring it undoes exactly this batch and
 *    nothing else. EEXIST is the one exception — `wx` is all-or-nothing,
 *    so nothing was written and "restoring" would rewrite a concurrent
 *    winner's file. This is stricter than the pre-broker
 *    `handleLLMPatch`, which left earlier files patched and returned a 500
 *    describing only the file that failed.
 * 4. **Invalidate, then emit.** `invalidate` fires with the repo-relative
 *    paths the ops touched, in CALLER order (not sorted). `emit` runs last
 *    and its value is handed back untouched — every caller has its own
 *    audit-ack error wording, so the broker deliberately doesn't
 *    interpret it. An `emit` that throws propagates: the writes are
 *    already durable and must not be rolled back for an audit-log failure.
 *
 * ## Layering
 *
 * The broker is deliberately free of HTTP/CLI dependencies (no session
 * lock, no request context) so both the CLI edit handler and the SDK
 * chat lane can call it. The SDK's BUILT-IN Write/Edit can't route through
 * here — the SDK owns that write syscall — so they are bracketed instead by
 * `sdk-write-guard.ts`, which journals + locks around the tool call using the
 * same `writeBackupJournal` this broker uses. The CLI's coarse
 * reader-writer gate (`editor-cli/src/server/session-lock.ts`) is a
 * SEPARATE, outer namespace; the `FileLockManager` locks taken here are
 * the inner write-serialization layer and must keep working for callers
 * that hold no outer lock at all (the chat lane).
 */

import { randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename as fsRename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, sep as pathSep } from 'node:path'

import { isProtectedAgentPath, protectedPathDenial } from './protected-paths'
import { desdeRemovalPath, DesdeDirSymlinkError } from '../worktree/desde-dir'

import {
  getSharedFileLockManager,
  type FileLockManager,
} from '../edit-service/file-lock-manager'
import {
  writeBackupJournal,
  BackupJournalPathEscapeError,
  type BackupEntry,
} from './backup-journal'
import {
  appendLedgerEntry,
  hashContent,
  resolveBranchCached,
} from '../ledger/edit-ledger'
import type { EditDescription } from '../ledger/entry'
import { headSha } from '../worktree/git-branches'

/** A single filesystem mutation the broker knows how to apply + undo. */
export type BrokerOp =
  | {
      kind: 'write'
      /** Repo-relative path (journal key, invalidate key, error label). */
      repoRel: string
      /** Absolute path actually written. */
      absPath: string
      content: string | Buffer
      /** `mkdir -p` the parent first (new-file creation). */
      ensureDir?: boolean
      /**
       * The op CREATES this file — there is no prior content, so it has
       * no journal entry. Declared, never inferred: "no journal entry ⇒
       * it must be new" would silently DELETE an existing file whose
       * caller merely forgot to journal it. {@link brokeredWrite} rejects
       * a `write` op that is neither journaled nor `isNew` before
       * touching disk. (Rollback itself no longer consults this flag —
       * the pre-batch snapshot already knows whether the path existed —
       * but the declaration is what makes that forgotten-journal bug
       * loud instead of destructive.)
       */
      isNew?: true
      /**
       * Fail atomically with EEXIST (`{ flag: 'wx' }`) instead of
       * overwriting if the file is already there. Exists for the
       * `isNew` case: the caller's own non-existence check (before
       * `brokeredWrite` is even called) can't itself be locked, so two
       * concurrent creates for the same path can both pass it. The
       * per-path write lock this op takes only serializes the two
       * calls against EACH OTHER — it doesn't retroactively make the
       * path "still clear" for whichever one runs second. `exclusive`
       * closes that: the loser's write throws EEXIST inside the lock and
       * surfaces through `stage: 'write'` with `reason` starting
       * `"EEXIST:"`. The winner's file is left untouched, because `wx`
       * is all-or-nothing and the rollback skips the failing op's own
       * paths on EEXIST specifically (nothing was written, so there is
       * nothing to undo — and "undoing" would rewrite the winner's file
       * with bytes we only read).
       */
      exclusive?: true
    }
  | { kind: 'delete'; repoRel: string; absPath: string }
  | {
      kind: 'rename'
      repoRel: string
      absPath: string
      toRepoRel: string
      toAbsPath: string
      /**
       * Refuse (rather than clobber) when the destination already
       * exists. The `rename` counterpart of `exclusive`, and it exists
       * for the same reason: a caller's own destination check runs
       * before `brokeredWrite` and can't be held under the lock, so two
       * concurrent renames onto the same path can both pass it — and
       * POSIX `rename(2)` then atomically REPLACES the destination, so
       * the loser silently destroys the winner's file. (Windows differs;
       * relying on that divergence would be a platform-specific bug.)
       * There is no `wx` flag for rename, so the check runs inside the
       * op's locks, where it is no longer a TOCTOU against other
       * brokered writers. Surfaces as `stage: 'write'` with `reason`
       * starting `"EEXIST:"`, exactly like `exclusive`.
       */
      failIfDestExists?: true
    }

/**
 * Snapshot of one file's content at a point in time (or its absence).
 * Structurally identical to `HistoryFileState` in
 * `src/editor/edit-service/edit-history.ts` — kept in sync by shared
 * test coverage across both files, not by import (see {@link HistoryRecorder}).
 */
export interface HistoryFileState {
  exists: boolean
  content: Buffer | null
}

/**
 * One file's before/after states within a recorded step. Structurally
 * identical to `RecordedFile` in `edit-history.ts`.
 */
export interface RecordedFile {
  /** Repo-relative path — journal key, invalidate key, error label. */
  repoRel: string
  /** Absolute path on disk. */
  absPath: string
  before: HistoryFileState
  after: HistoryFileState
}

/**
 * Structural interface satisfied by `EditorEditHistory.record`
 * (`src/editor/edit-service/edit-history.ts`, Task 1 of the toolbar
 * undo/redo plan) WITHOUT importing that module here — the dependency
 * between the two stays one-way (edit-history depends on write-broker for
 * `brokeredWrite`, never the reverse). Any object with a matching `record`
 * method — real or test double — satisfies this by structural typing.
 */
export interface HistoryRecorder {
  record(step: { label: string; files: RecordedFile[] }): void | Promise<void>
}

/**
 * Acquire the repo's shared tree gate, returning its release function.
 * Named + exported so `BrokeredWriteOptions.acquireTreeGate` and every
 * structural-tool handler opts type that threads it through
 * (`fs-structural-tools.ts`) reference the SAME shape rather than
 * repeating an inline function type seven times. The concrete impl
 * (`acquireTreeGateShared` in `editor-cli/src/server/session-lock.ts`) is
 * injected, never imported here — see `BrokeredWriteOptions.acquireTreeGate`'s
 * doc comment for why.
 */
export type AcquireTreeGate = () => Promise<() => void>

export interface BrokeredWriteOptions<E = void> {
  /** Realpath'd repo root — where `.desde/backups/` lives. */
  canonicalRoot: string
  /**
   * Originals to journal BEFORE any mutation. May legitimately cover
   * more files than `ops` writes (the LLM lane journals every file it
   * read; `manage_package` journals lockfiles the install step will
   * mutate behind our back) — the broker never infers this set.
   */
  journal: ReadonlyArray<BackupEntry>
  ops: ReadonlyArray<BrokerOp>
  /**
   * Expected pre-batch state for paths the caller read BEFORE calling
   * `brokeredWrite` (undo/redo follow-ups Task 1). Checked under the
   * batch's own locks, right after snapshots are captured and before any
   * mutation — atomic with the snapshot capture, so it closes the TOCTOU
   * window between the caller's own read and this batch's lock
   * acquisition. A mismatch refuses the WHOLE batch with `stage:
   * 'precondition'`; nothing is written. May name paths outside `ops`
   * (they're unioned into the lock/snapshot set — plain mutex, since
   * nothing mutates them).
   */
  preconditions?: ReadonlyArray<{
    repoRel: string
    absPath: string
    expect: { exists: boolean; content: Buffer | null }
  }>
  /** Defaults to the process-wide shared manager. Injected by tests. */
  lockManager?: FileLockManager
  /** Lock owner id; anonymous per-call owner when omitted. */
  sessionId?: string
  invalidate?: (repoRelPaths: string[]) => void
  /**
   * Override the invalidate payload. Defaults to every path the ops
   * touched, in caller order (`rename` contributes from + to).
   */
  invalidatePaths?: ReadonlyArray<string>
  /** Audit emit, run after invalidate. Its result is returned verbatim. */
  emit?: () => Promise<E>
  /**
   * Record this batch as an undo/redo step once it durably succeeds.
   * Runs AFTER `invalidate`, in the same post-lock region — never while
   * this batch's file locks are held. Awaiting `record` inside the lock
   * window would ABBA-deadlock against an undo/redo that holds the
   * history's own serialization mutex and then requests these same file
   * locks: undo takes history-lock → wants file-locks, while a write
   * taking file-locks → wants history-lock would complete the cycle.
   */
  record?: { history: HistoryRecorder; label: string }
  /**
   * Semantic description of what this batch MEANT, for the edit ledger
   * (`src/editor/ledger/`). Written post-lock and best-effort, exactly
   * like `record` above and for the same ABBA-deadlock reason.
   *
   * Optional, and its absence is not a skip: an undescribed batch still
   * gets a ledger entry, with `kind: 'unknown'`. An unexplained write is
   * a fact the Activity panel must show, not one to drop. The ledger
   * lives HERE rather than in each lane because every write lane funnels
   * through this function — the same argument the protected-path check
   * above already won, and audit finding B7 is what a per-lane version
   * looks like when it goes wrong.
   */
  describe?: EditDescription
  /**
   * Hold the repo's SHARED tree gate across this ENTIRE call — mutation,
   * invalidate, `record`, and the ledger append — so a concurrent
   * `withTreeLock` (Commit/Publish/branch switch-create-rename) cannot run
   * to completion, and append ITS OWN ledger line, while this batch's
   * ledger append is still in flight (A2, round-2 whole-branch review
   * finding, 2026-08-19; same ordering principle as the fix for
   * `sdk-write-guard.ts`'s built-in Write/Edit lane).
   *
   * Optional and deliberately NOT wired for every caller. This keeps
   * `brokeredWrite` free of CLI/HTTP dependencies (see the "Layering"
   * note above) — it takes an already-acquire-shaped function, never
   * reaches into `editor-cli/` itself, so the one-way dependency stays
   * exactly as documented. The CLI edit route already wraps its OWN
   * `brokeredWrite` call in the outer tree gate at the route layer
   * (`withEditLocks` in `editor-cli/src/server/http-server.ts`) — it must
   * NOT also inject this, or the batch would acquire the shared gate
   * twice for no benefit. This exists for the SDK's *structural* write
   * tools (`insert_component`, `delete_file`, `rename_file`,
   * `scaffold_route`, `insert_element`, `manage_package`,
   * `download_asset`), which call `brokeredWrite` directly with no outer
   * wrapping at all today — `editor-cli/src/server/session-lock.ts`'s
   * `acquireTreeGateShared` is the concrete impl the CLI supplies.
   */
  acquireTreeGate?: AcquireTreeGate
}

export type BrokeredWriteResult<E = void> =
  | {
      ok: true
      /**
       * Repo-relative backup directory (`.desde/backups/…`). Absent when
       * the batch's `journal` was empty (an allowCreate write of a brand-
       * new file has no prior content to back up), because
       * `writeBackupJournal` never creates the directory on disk in that
       * case — reporting the never-created path here would send an ack-
       * failure message, and Undo, looking for a backup that isn't there.
       */
      backupDir?: string
      emitted: E
    }
  | { ok: false; stage: 'backup'; reason: string }
  | {
      ok: false
      /**
       * A target is on the protected-path list (`protected-paths.ts`) — build
       * config, git hooks, MCP/extension config, or a rules file. Refused
       * before the journal, so nothing on disk was touched. Callers should
       * surface `reason` verbatim: it is written to be read by the model and
       * deliberately tells it not to route around the block.
       */
      stage: 'refused'
      /** Repo-relative path of the protected target. */
      repoRel: string
      reason: string
    }
  | {
      ok: false
      stage: 'precondition'
      /** Repo-relative path of the precondition that no longer matches. */
      repoRel: string
      reason: string
    }
  | {
      ok: false
      stage: 'write'
      /** Bare error message from the failing mutation (no prefix). */
      reason: string
      /** Repo-relative path of the failing op — for the caller's message. */
      repoRel: string
      op: BrokerOp
      /**
       * Absent under the same condition as the `ok: true` case above: an
       * empty `journal` (every op in the batch was `allowCreate`, so
       * `writeBackupJournal` never created the directory on disk). A failed
       * rollback of an all-new-file batch has nothing to point the user at
       * — see `rollbackWarning`, which drops the "Recover from" clause when
       * this is absent.
       */
      backupDir?: string
      /** Repo-relative paths successfully rolled back. */
      rolledBack: string[]
      /** Non-fatal rollback failures, formatted for logging. */
      restoreErrors: string[]
    }

/**
 * The suffix every caller appends to its write-failure message. A failed
 * rollback is the one broker outcome the user MUST see: the batch reports
 * failure while some other file still holds the new content, so a save
 * that "failed" silently changed a file — and the next save on it 409s
 * with `external-edit-conflict` for no visible reason. Returns `''` for
 * every other outcome, so call sites can append it unconditionally.
 */
export function rollbackWarning(result: BrokeredWriteResult<unknown>): string {
  if (result.ok || result.stage !== 'write') return ''
  if (result.restoreErrors.length === 0) return ''
  // `backupDir` is absent for an all-new-file batch (empty journal — see
  // its own doc comment above): there is no directory to point at, so the
  // "Recover from" clause is dropped rather than naming a path that was
  // never created on disk.
  const recover = result.backupDir ? ` Recover from '${result.backupDir}'.` : ''
  return ` WARNING: could not restore ${result.restoreErrors.join('; ')}.${recover}`
}

function defaultInvalidatePaths(ops: ReadonlyArray<BrokerOp>): string[] {
  const paths: string[] = []
  for (const op of ops) {
    paths.push(op.repoRel)
    if (op.kind === 'rename') paths.push(op.toRepoRel)
  }
  return paths
}

/**
 * Every path an op must hold a lock on, in acquisition order. Only
 * `rename` needs two (source + destination): a concurrent batch writing
 * the destination would otherwise race the move. Sorted, so a batch
 * renaming A→B and one renaming B→A acquire in the same global order and
 * can't cycle. A same-path rename degenerates to one lock — acquiring the
 * same key twice would trip reentrancy detection (explicit sessionId) or
 * deadlock against itself (anonymous owner).
 */
function lockPathsFor(op: BrokerOp): string[] {
  if (op.kind !== 'rename' || op.absPath === op.toAbsPath) return [op.absPath]
  return op.absPath < op.toAbsPath
    ? [op.absPath, op.toAbsPath]
    : [op.toAbsPath, op.absPath]
}

/**
 * Acquire `paths` (already deduped and in sorted order) and run `fn`
 * holding ALL of them — nested, so every lock stays held until `fn`
 * returns. Paths in `snapshotPaths` take `withWriteLock` (snapshot +
 * restore-if-`fn`-throws, and the lock-event telemetry the CLI's lock
 * tests assert); the rest take the plain mutex.
 */
async function withPathLocks<T>(
  lockManager: FileLockManager,
  paths: ReadonlyArray<string>,
  snapshotPaths: ReadonlySet<string>,
  lockOpts: { sessionId?: string } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (paths.length === 0) return fn()
  const [head, ...rest] = paths
  const inner = () => withPathLocks(lockManager, rest, snapshotPaths, lockOpts, fn)
  return snapshotPaths.has(head)
    ? lockManager.withWriteLock(head, inner, lockOpts)
    : lockManager.withLock(head, inner, lockOpts)
}

/** Pre-batch state of one path, captured under the batch's locks. */
interface PathSnapshot {
  existed: boolean
  content: Buffer | null
}

/**
 * Thrown by `captureSnapshot` when a path a caller declared a
 * `precondition` on turns out to be a symlink, or resolves outside the
 * repo root — see that function's doc comment for the exploit this
 * closes (P1-2, codex review finding, 2026-08-20).
 *
 * Kept as a distinct error type, rather than a bare `Error`, purely so
 * the snapshot loop in `brokeredWriteImpl` can tell it apart from an
 * ordinary I/O failure (a permission error, a directory where a file
 * was expected, …) and attribute it to the PRECONDITION it violates
 * even when the same path is also an op's own write target.
 * `attributeFailure`'s default — op wins over precondition when both
 * name the same path — is right for an ordinary failure on a write
 * target (that really is a write-stage problem), but wrong here: this
 * failure means "the bytes I read before no longer describe reality,"
 * which is exactly what a precondition mismatch already means, and the
 * caller-facing route (`handleLedgerUndoRequest`) gives that stage a
 * clean 409 refusal instead of the write lane's 500.
 */
class PreconditionIntegrityError extends Error {}

/**
 * Read a path's pre-batch state. A missing file is a normal snapshot
 * (`existed: false` — rollback for it is `unlink`); any other read error
 * is fatal to the batch, because a path we can't snapshot is a path we
 * can't roll back.
 *
 * **P1-2 (codex review finding, 2026-08-20, ledger undo route).**
 * `preconditionRootReal`, when given, means this path is one a caller
 * declared a `precondition` on — content it read BEFORE calling
 * `brokeredWrite` and is now trusting a byte comparison to still
 * describe. A byte comparison alone can't tell "the file still holds
 * these bytes" apart from "the file was REPLACED BY A SYMLINK whose
 * current target happens to hold these bytes": `readFile` below follows
 * symlinks, so both cases read identically, and the later mutation
 * (`applyOp`'s `writeFile`, which ALSO follows symlinks) then lands on
 * whatever the symlink points at — potentially outside the repo
 * entirely. Given the precondition's realpath'd repo root, this proves
 * the path is a real, non-symlink file whose RESOLVED location still
 * sits under it, in two steps: `lstat` first (the leaf itself must not
 * be a symlink, regardless of where it points — the concrete exploit
 * this closes), then `realpath` (an ANCESTOR directory could have been
 * replaced with a symlink instead of the leaf, which `lstat` alone
 * would miss). A failure here throws a {@link PreconditionIntegrityError}
 * — a distinct type from an ordinary I/O failure, so the caller loop
 * below can attribute it to the PRECONDITION it violates even on a path
 * that is ALSO an op's own write target; see that class's doc comment
 * for why the default op-wins attribution is wrong for this specific
 * failure.
 *
 * Deliberately opt-in, not a blanket change for every path
 * `brokeredWrite` snapshots: an ordinary op target with no precondition
 * (a fresh `insert_component` write, a `delete_file`, …) has no prior
 * caller read to protect — there is nothing for a symlink swap to
 * falsify — so paying the extra `lstat`/`realpath` round trip there
 * would be pure overhead for a check that can't fire.
 */
async function captureSnapshot(
  absPath: string,
  preconditionRootReal?: string,
): Promise<PathSnapshot> {
  if (preconditionRootReal !== undefined) {
    let leafInfo
    try {
      leafInfo = await lstat(absPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { existed: false, content: null }
      throw err
    }
    if (leafInfo.isSymbolicLink()) {
      throw new PreconditionIntegrityError(
        `'${absPath}' is a symlink, not the plain file this operation expects. Refusing.`,
      )
    }
    const real = await realpath(absPath)
    if (!realPathIsUnder(real, preconditionRootReal)) {
      throw new PreconditionIntegrityError(`'${absPath}' resolves outside the repo root. Refusing.`)
    }
  }
  try {
    return { existed: true, content: await readFile(absPath) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { existed: false, content: null }
    }
    throw err
  }
}

/**
 * Whether a pre-batch snapshot satisfies a caller's expected state.
 * Structurally the same comparison as `sameState` in `edit-history.ts`
 * (kept in sync by shared test coverage, not by import — see
 * {@link HistoryFileState}).
 */
function preconditionMatches(
  snapshot: PathSnapshot,
  expect: { exists: boolean; content: Buffer | null },
): boolean {
  if (snapshot.existed !== expect.exists) return false
  if (!snapshot.existed) return true
  return (snapshot.content as Buffer).equals(expect.content as Buffer)
}

/**
 * Put one path back to its pre-batch state. Best-effort: returns the
 * error instead of throwing, so one un-restorable file can't hide the
 * others (or the original failure).
 *
 * `usePreconditionGuard` (P1-1, codex review round 7, SECURITY) — see
 * `applyPreconditionedOverwrite`'s doc comment below for the exploit and
 * the mechanism. This flag exists because restoring a precondition-backed
 * path needs the SAME handle-based, symlink-refusing write that function
 * uses, and it is not a rare corner of the batch: it is the GUARANTEED
 * immediate consequence whenever `applyPreconditionedOverwrite`'s own
 * `O_NOFOLLOW` open refuses a hostile swap. The mutation loop's failure
 * handler restores the FAILING op's own path — this one — as the very
 * next step, before it even reports the refusal. A plain `writeFile` here
 * would follow the exact symlink the primary write just refused to,
 * writing the pre-batch bytes into whatever the attacker swapped in —
 * confirmed by driving this exact sequence (see the round-7 fix report).
 */
async function restorePath(
  absPath: string,
  snapshot: PathSnapshot,
  usePreconditionGuard: boolean,
): Promise<string | null> {
  try {
    if (!snapshot.existed) {
      try {
        await unlink(absPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
      return null
    }
    await mkdir(dirname(absPath), { recursive: true })
    if (usePreconditionGuard) {
      await openAndWriteNoFollow(absPath, snapshot.content as Buffer)
    } else {
      await writeFile(absPath, snapshot.content as Buffer)
    }
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/**
 * **P1-1 (codex review round 7, 2026-08-20, SECURITY).** `captureSnapshot`
 * (above) `lstat`s + `realpath`s a precondition path to prove it is a
 * real, contained file BEFORE trusting its bytes for the precondition
 * comparison — but that validation and the write below used to be two
 * completely separate path-string operations (a `captureSnapshot` call
 * here, a `writeFile(op.absPath, …)` call much later, after lock
 * acquisition, the precondition-match check, and — for every op before
 * this one in the batch — their own writes). A process with no stake in
 * this batch's locks (an SDK structural tool from another chat session,
 * a build script, anything running in the working tree) can replace
 * `op.absPath`, or an ancestor directory, with a symlink in that gap;
 * `writeFile` follows symlinks, so the write would land wherever the
 * symlink points — potentially outside the repo.
 *
 * Closed the same way `readBackup` in `http-server.ts` closes the
 * read-side version of this (round 6): open with `O_NOFOLLOW` (refuses
 * atomically, `ELOOP`, if the FINAL path component is a symlink at the
 * moment of the open) and do every subsequent operation — `fstat`, then
 * the write itself — on that SAME handle, never a second path lookup.
 * `O_TRUNC` is part of the open flags rather than a separate
 * `handle.truncate(0)` call, so the truncate is atomic with the open
 * too. Because everything after `open` runs against the handle (bound to
 * a specific inode, not a path string), the bytes actually written are
 * provably written to the file `open` validated — a directory-entry
 * replacement after `open` succeeds cannot retarget an already-open fd.
 *
 * Applies to an OVERWRITE of an existing file. A create (`isNew`) has its
 * own guarded path, {@link createNoFollow} — see that function for why
 * the reasoning that used to sit here, which said a create needed no
 * guard at all, was wrong.
 *
 * The one op shape neither function guards is an ordinary overwrite with
 * NO precondition (a deterministic applicator edit, an
 * `insert_component` write). It gets the same treatment
 * `captureSnapshot`'s doc comment gives it: deliberately unguarded,
 * because paying `lstat`/`realpath`/`open` overhead for a check that
 * protects a claim nobody made would be pure cost. Closing that gap is a
 * SEPARATE, broader finding — P1-1 is specifically about the guard this
 * file already has (`captureSnapshot`'s precondition check) not reaching
 * all the way to the write it exists to protect.
 *
 * `restorePath` (below) uses the SAME mechanism (via `openAndWriteNoFollow`)
 * when restoring a precondition-backed path — not just the primary write
 * here. That is not optional hardening: it is the DIRECT, GUARANTEED
 * consequence of this function's own refusal. When `open` below throws
 * (the attack this function exists to refuse), the mutation loop's
 * failure handler immediately tries to restore THIS SAME op's own path
 * back to its pre-batch bytes — before it even reports the refusal to the
 * caller. A plain `writeFile` there would follow the exact symlink this
 * function just refused to open, writing the pre-batch bytes into
 * whatever the attacker swapped in. Verified by driving this exact
 * sequence: a version of this fix that guarded only the write here (and
 * left `restorePath` on plain `writeFile`) still let the attack land, one
 * function later — see the round-7 fix report.
 */
async function openAndWriteNoFollow(absPath: string, content: string | Buffer): Promise<void> {
  const handle = await open(absPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_TRUNC)
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error(`'${absPath}' is not a regular file. Refusing to write it.`)
    }
    // Strings default to utf8; Buffers are written byte-for-byte — same
    // contract as the plain `writeFile` call this replaces.
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}

/**
 * Whether a path that has ALREADY been through `realpath` sits inside a
 * repo root that has also already been through `realpath`. Both arguments
 * must be resolved: this is a string containment test, and it is only a
 * containment PROOF because neither side can still hold a symlink.
 */
function realPathIsUnder(real: string, rootReal: string): boolean {
  const rootWithSep = rootReal.endsWith(pathSep) ? rootReal : rootReal + pathSep
  return real === rootReal || real.startsWith(rootWithSep)
}

/**
 * **FX11 (codex review + adversarial verification, 2026-09-05, SECURITY),
 * corrected by FX17 the same day.**
 * Create a file that provably lands inside the repo.
 *
 * The create used to be a plain `writeFile`, on the reasoning quoted above
 * {@link openAndWriteNoFollow}: an `isNew` op has no prior caller read, so
 * there is no "the bytes I read are still there" claim for a symlink swap
 * to falsify. That reasoning was about the wrong claim. A create makes a
 * DIFFERENT one — "this file lands inside the repository" — and a plain
 * `writeFile` cannot keep it. `resolveSafeCreatePath` lstat-walks every
 * ancestor at reconstruction time, but nothing re-anchored that walk at
 * write time, and `captureSnapshot`'s lstat/realpath proof returns early
 * on ENOENT, which a not-yet-created leaf always is. So an ancestor
 * directory replaced with a symlink in between sent the new file wherever
 * the symlink pointed, and the model was told the write succeeded. The
 * user's prototype repository is untrusted, so anything running in it can
 * do that: a build script, an `npm postinstall`, a second agent session.
 *
 * ## The FX17 correction, and the claim it retracts
 *
 * FX11's first fix added a three-step guard and closed its own doc comment
 * with a measured-sounding claim: that a lost race could only ever leave a
 * ZERO-BYTE file outside the repository, and that no escape was ever
 * reported as a success. **Both halves were false.** The adversarial
 * verifier disproved them with two ordinary user processes. Its swapper
 * renamed the destination directory out of the repository, let the create
 * land in the replacement, renamed the replacement BACK into the
 * repository so the guard's `realpath` and `lstat` both agreed, and then
 * carried it out again. Sixteen complete, non-empty payloads left the
 * repository in twenty-five seconds; every one of them was reported to the
 * model as a success. Reproduced here before this change was written.
 *
 * The mistake was believing an inode comparison anchored the write.
 * `handle.stat()` is anchored to the created inode, but `realpath` and
 * `lstat` are PATH lookups, so the pair answered "does this path name my
 * inode right now" — not "is my inode in the directory I checked". A
 * DIFFERENT directory moved into the same name answers yes to the first
 * question and no to the second.
 *
 * ## What the code does now
 *
 *  1. `realpath` the parent directory and require it under `rootReal`.
 *     `realpath` resolves EVERY component, so this catches an ancestor
 *     swap that an `lstat` of the leaf alone cannot see. It runs before
 *     anything is created, so the ordinary attack — a symlink already in
 *     place when we get here — creates nothing at all. Record that
 *     directory's own `dev`/`ino`.
 *  2. Create at `<resolved parent>/<basename>` with
 *     `O_CREAT | O_EXCL | O_NOFOLLOW`. `O_EXCL` refuses atomically if
 *     ANYTHING is already at that name, a symlink included, so the create
 *     can never follow one.
 *  3. Prove three things before writing a single byte: the parent path
 *     still resolves to itself, the parent is still the SAME DIRECTORY
 *     INODE recorded in step 1, and the target path names the inode the
 *     open handle holds. The middle one is the FX17 addition and it is
 *     what refuses the verifier's swap-in.
 *  4. Write the caller's bytes through the open handle, which is anchored
 *     to the inode step 3 proved.
 *  5. Re-run step 3's proof AFTER the write. If it now disagrees,
 *     `ftruncate(0)` the handle — the fd still names our inode wherever it
 *     has been moved to, so this empties it — unlink the path when it still
 *     names that inode, and fail the op, so the model is told the write did
 *     not happen.
 *
 * ## Why the bytes are not staged elsewhere first
 *
 * The obvious alternative, and the one the FX17 brief proposed, is to write
 * the content into a staging file under the repository root and then
 * publish it with `link`. It was implemented and then rejected, because it
 * is strictly WEAKER here. `link` is itself a path lookup: a swap landing
 * in its window publishes a directory entry that ALREADY HOLDS the caller's
 * bytes, outside the repository, with no check between. The order above
 * never puts a byte anywhere until a proof has passed, so the residue of a
 * lost race is an empty file.
 *
 * ## The residual, measured rather than assumed
 *
 * Node exposes no `openat` against a directory handle, so step 2 is a path
 * lookup and a swap landing between steps 1 and 2 can still CREATE an empty
 * file outside the repository. Step 3 refuses that and unlinks it whenever
 * the path still names it.
 *
 * What no version of this function can prevent is a directory that is
 * genuinely inside the repository when the write happens and is moved out
 * of it afterwards. That is not specific to a create: any file written
 * anywhere in a repository can be renamed out of it a moment later by a
 * process that can rename its parent. Such a write is reported as a
 * success, correctly — at the moment it completed, the file was in the
 * repository.
 *
 * Measured on macOS, 25 seconds each, against the verifier's own swapper
 * process. Before this change: 345,679 create attempts, 58 successes, 16
 * complete non-empty payloads captured outside the repository, 16 of those
 * 16 reported as a success. After: 329,552 attempts, 3 successes, 2
 * payloads captured outside — and both of those two are the unpreventable
 * shape above, a write into a directory that was inside the repository at
 * write time and was renamed out of it afterwards.
 *
 * The other half of the measurement isolates what IS preventable. A second
 * swapper empties its outside directory before every flip, so anything it
 * finds there was put there by the create it is racing, and it looks while
 * the repository path is still a symlink — the moment when no path inside
 * the repository names the file. 25 seconds: 440,919 attempts, 14,643
 * flips, 17 creates that did land outside the repository, 0 of them
 * non-empty. That is the ZERO-BYTE-residue claim FX11 made without
 * measuring it; it is stated here only because it has now been measured,
 * and `write-broker-create-containment.test.ts` re-runs a shortened form of
 * the same loop on every suite run. Note honestly that the pre-FX17 code
 * scores 0 on that metric too — the loop pins the invariant, and the
 * deterministic test beside it is what pins THIS defect.
 *
 * Exported for that test only. It has to drive this primitive tens of
 * thousands of times against a real second OS process; going through
 * `brokeredWrite` would add locking, journalling and ledger work per
 * attempt and cut the attempt count by three orders of magnitude, which is
 * the difference between a test that can lose the race and one that cannot
 * reach it.
 */
export async function createNoFollow(
  absPath: string,
  content: string | Buffer,
  rootReal: string,
): Promise<void> {
  const parentReal = await realpath(dirname(absPath))
  if (!realPathIsUnder(parentReal, rootReal)) {
    throw new Error(
      `'${absPath}' would be created outside the repository (its parent resolves to '${parentReal}'). Refusing.`,
    )
  }
  const parentAtStart = await stat(parentReal)
  const target = join(parentReal, basename(absPath))

  const handle = await open(
    target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o666,
  )
  try {
    const onHandle = await handle.stat()
    const stillProven = async (): Promise<boolean> => {
      const [resolvedNow, parentNow, onPath] = await Promise.all([
        realpath(parentReal).catch(() => null),
        stat(parentReal).catch(() => null),
        lstat(target).catch(() => null),
      ])
      if (resolvedNow !== parentReal || parentNow === null) return false
      if (parentNow.dev !== parentAtStart.dev || parentNow.ino !== parentAtStart.ino) return false
      return onPath !== null && onPath.dev === onHandle.dev && onPath.ino === onHandle.ino
    }

    if (!(await stillProven())) {
      await discardCreated(target, onHandle)
      throw new Error(
        `'${absPath}' moved out of the repository while it was being created. Refusing to write it.`,
      )
    }
    // Strings default to utf8; Buffers are written byte-for-byte.
    await handle.writeFile(content)
    if (!(await stillProven())) {
      // The fd is anchored to the inode we wrote, so truncating it empties
      // the bytes wherever that inode has been moved to.
      await handle.truncate(0).catch(() => {})
      await discardCreated(target, onHandle)
      throw new Error(
        `'${absPath}' moved out of the repository while it was being created. Refusing to write it.`,
      )
    }
  } finally {
    await handle.close()
  }
}

/**
 * Remove the file {@link createNoFollow} created, but only while the path
 * still names that exact inode. A path that names something else now is a
 * path this call has no business unlinking.
 */
async function discardCreated(
  target: string,
  onHandle: { dev: number; ino: number },
): Promise<void> {
  const onPath = await lstat(target).catch(() => null)
  if (onPath !== null && onPath.dev === onHandle.dev && onPath.ino === onHandle.ino) {
    await unlink(target).catch(() => {})
  }
}

async function applyOp(
  op: BrokerOp,
  preconditionAbsPaths: ReadonlySet<string>,
  resolveRootReal: () => Promise<string>,
): Promise<void> {
  switch (op.kind) {
    case 'write':
      if (op.ensureDir) await mkdir(dirname(op.absPath), { recursive: true })
      if (op.isNew) {
        // Every create goes through the guarded path, whether or not the
        // caller also declared `exclusive`: `exclusive` only ever meant
        // `O_CREAT | O_EXCL`, which `createNoFollow` always uses. A create
        // that was not marked `exclusive` therefore becomes create-only
        // too — strictly a refusal where it used to clobber, and every
        // `isNew` caller already asserts non-existence before calling.
        await createNoFollow(op.absPath, op.content, await resolveRootReal())
        return
      }
      if (!op.exclusive && preconditionAbsPaths.has(op.absPath)) {
        await openAndWriteNoFollow(op.absPath, op.content)
        return
      }
      // Strings default to utf8; Buffers are written byte-for-byte.
      // `exclusive` without `isNew` is rejected as a caller bug before we
      // get here, so the flag below is belt-and-braces, not a live path.
      await writeFile(op.absPath, op.content, op.exclusive ? { flag: 'wx' } : undefined)
      return
    case 'delete':
      await unlink(op.absPath)
      return
    case 'rename':
      if (op.failIfDestExists && existsSync(op.toAbsPath)) {
        // Shaped like the `wx` write failure so callers can pattern-match
        // one prefix for "lost the create race" across both op kinds.
        const err: NodeJS.ErrnoException = new Error(
          `EEXIST: file already exists, rename '${op.repoRel}' -> '${op.toRepoRel}'`,
        )
        err.code = 'EEXIST'
        throw err
      }
      await fsRename(op.absPath, op.toAbsPath)
      return
  }
}

/**
 * Journal → locked writes → invalidate → emit, with rollback of the
 * already-applied ops when a later one fails. Never throws for a
 * filesystem failure (those come back as a typed result); only a
 * caller-supplied `emit` may propagate.
 */
/**
 * Thin wrapper around {@link brokeredWriteImpl} that adds the OPTIONAL
 * outer tree-gate hold (A2, round-2 whole-branch review finding,
 * 2026-08-19 — see `acquireTreeGate`'s doc comment on
 * {@link BrokeredWriteOptions} for why this is a separate function rather
 * than acquiring inline partway through the body below).
 *
 * A thin wrapper, not an inline `try/finally` at the top of the existing
 * function body, so the gate acquisition/release lives in exactly ONE
 * place, obviously matched, instead of threading a `finally` through
 * `brokeredWriteImpl`'s many early `return`s and caller-bug `throw`s.
 * When `opts.acquireTreeGate` is absent (every caller as of this writing
 * except the SDK structural tools) this is a bare passthrough — no new
 * await, no behavior change.
 */
export async function brokeredWrite<E = void>(
  opts: BrokeredWriteOptions<E>,
): Promise<BrokeredWriteResult<E>> {
  if (!opts.acquireTreeGate) return brokeredWriteImpl(opts)
  const releaseTreeGate = await opts.acquireTreeGate()
  try {
    return await brokeredWriteImpl(opts)
  } finally {
    // Runs only once `brokeredWriteImpl` has fully settled (success,
    // typed refusal, or thrown caller-bug error) — including its ledger
    // append, which is the whole point.
    releaseTreeGate()
  }
}

/**
 * Remove the backup directory this batch wrote, best effort.
 *
 * A refusal that never touched a file must leave no journal behind. The
 * journal is written BEFORE the locks (so a caller bug cannot leave a
 * half-written file with no recoverable original), which means a precondition
 * refusal — decided inside the locks, before any mutation — has already
 * created a directory holding bytes that were never the pre-write state of
 * anything (2026-09-04 adversarial review, P3-1). `containment.test.ts`
 * asserted the no-orphan rule only for a containment refusal, which is
 * refused before the journal is written and so never got this far.
 *
 * Never fatal. The write did not happen either way, and `backups-gc` sweeps a
 * directory this fails to remove.
 */
async function discardBackupDir(canonicalRoot: string, backupDirRel: string): Promise<void> {
  try {
    // Re-resolved immediately before the `rm`, the same discipline
    // `backups-gc` follows: this is a RECURSIVE delete and
    // `desdeRemovalPath` refuses a target that resolves outside the repo.
    await rm(desdeRemovalPath(canonicalRoot, 'backups', basename(backupDirRel)), {
      recursive: true,
      force: true,
    })
  } catch (err) {
    console.warn(
      `brokeredWrite: could not remove the backup directory left by a refused write: ${
        (err as Error).message
      }`,
    )
  }
}

async function brokeredWriteImpl<E = void>(
  opts: BrokeredWriteOptions<E>,
): Promise<BrokeredWriteResult<E>> {
  const originals = new Map<string, string | Buffer>()
  for (const entry of opts.journal) originals.set(entry.file, entry.content)

  // Protected-path enforcement, BEFORE anything touches disk.
  //
  // This is the only place it happens, and that is the entire point. The
  // 2026-08-09 audit's B7 was precisely that the check lived in `edit-ack.ts`'s
  // `handleWrite`/`handleEdit` and nowhere else, so the six SDK structural
  // tools bypassed it — `rename_file` onto `.mcp.json` walked straight
  // through in two calls. Every write lane funnels through `brokeredWrite`,
  // so enforcing here cannot be bypassed by adding a new tool.
  //
  // A rename is checked on BOTH ends: the destination is the dangerous one
  // (that is the bypass), and the source matters too because renaming a
  // protected file AWAY is how you would disable a rules file.
  //
  // Applied to every lane, not just the agent's: no lane — not undo/redo, not
  // the deterministic inspector applicators — has a legitimate reason to write
  // `.git/hooks/pre-commit` or `.claude/settings.json`, and a per-lane opt-in
  // is how B7 happened in the first place. A legitimate caller that trips this
  // gets a loud, typed refusal rather than a silent hole.
  for (const op of opts.ops) {
    const targets = op.kind === 'rename' ? [op.repoRel, op.toRepoRel] : [op.repoRel]
    for (const target of targets) {
      if (isProtectedAgentPath(target)) {
        return { ok: false, stage: 'refused', repoRel: target, reason: protectedPathDenial(target) }
      }
    }
  }

  // Validate BEFORE the journal, so a caller bug can't even leave a
  // backup directory behind. An op that mutates existing content with
  // nothing journaled has no recoverable original — that's a programming
  // error (a forgotten journal entry), so it throws rather than
  // returning a result the caller might surface to the user as a
  // filesystem problem.
  for (const op of opts.ops) {
    const journaled = originals.has(op.repoRel)
    if (op.kind === 'write' && !op.isNew && !journaled) {
      throw new Error(
        `brokeredWrite: write op for '${op.repoRel}' has no journal entry and is not marked isNew: ` +
          `it would be unrecoverable on rollback. Journal the original, or declare isNew: true if the op creates the file.`,
      )
    }
    if (op.kind === 'write' && op.isNew && journaled) {
      throw new Error(
        `brokeredWrite: write op for '${op.repoRel}' is marked isNew but a journal entry exists: ` +
          `rollback would DELETE a file that already had content.`,
      )
    }
    if (op.kind === 'write' && op.exclusive && !op.isNew) {
      // `exclusive` (`{ flag: 'wx' }`) can only ever EEXIST at runtime —
      // it exists specifically to protect an `isNew` create against a
      // concurrent writer, so pairing it with a non-`isNew` (expected-
      // to-already-exist, journaled-original) write is always a caller
      // bug: either the write is meant to overwrite existing content
      // (drop `exclusive`) or it's meant to create a new file (add
      // `isNew: true`).
      throw new Error(
        `brokeredWrite: write op for '${op.repoRel}' has 'exclusive' without 'isNew': ` +
          `exclusive writes only make sense for a declared create (they always EEXIST otherwise).`,
      )
    }
    if (op.kind === 'delete' && !journaled) {
      throw new Error(
        `brokeredWrite: delete op for '${op.repoRel}' has no journal entry: the content would be unrecoverable.`,
      )
    }
  }
  // A precondition declaring the file exists but not what its content
  // should be can't be checked (`preconditionMatches` would call `.equals`
  // on `null`) — that surfaces deep inside the locked window as an
  // opaque, misleadingly-`stage: 'write'` crash instead of a caller-bug
  // error at the door. Same "fail loud before the journal" treatment as
  // the op validations above (review round-1 P3).
  for (const pre of opts.preconditions ?? []) {
    if (pre.expect.exists && pre.expect.content === null) {
      throw new Error(
        `brokeredWrite: precondition for '${pre.repoRel}' declares exists:true but content:null. ` +
          `A precondition expecting the file to exist must specify its expected content.`,
      )
    }
  }

  // `writeBackupJournal` throws `BackupJournalPathEscapeError` (rather
  // than returning `{ ok: false }`) for a journal key that would escape
  // the backup directory — see its doc comment. That's the right shape
  // for the GENUINE-escape case (a caller bug, fails loud). But
  // `brokeredWrite`'s callers (the SDK structural tools, the CLI edit
  // handler) already treat every OTHER failure mode here as a typed
  // `{ stage: 'backup' }` refusal, not a crash — an uncaught throw from
  // this one specific failure mode would kill a structural tool call or
  // a chat turn instead of surfacing as an ordinary "couldn't save"
  // (Task 14 review round-2 P2: a legally `..`-prefixed filename fed
  // through a since-fixed upstream helper hit exactly this). The journal
  // guard itself stays a hard stop — this only changes how the FAILURE
  // is reported to the caller, not whether the write proceeds.
  let backup: Awaited<ReturnType<typeof writeBackupJournal>>
  try {
    backup = await writeBackupJournal(opts.canonicalRoot, opts.journal)
  } catch (err) {
    if (err instanceof BackupJournalPathEscapeError || err instanceof DesdeDirSymlinkError) {
      return { ok: false, stage: 'backup', reason: err.message }
    }
    throw err
  }
  if (!backup.ok) return { ok: false, stage: 'backup', reason: backup.reason }

  const lockManager = opts.lockManager ?? getSharedFileLockManager()
  const lockOpts = opts.sessionId ? { sessionId: opts.sessionId } : undefined
  // Every path the batch touches — an op's own target, a rename
  // destination, OR a precondition-only path the caller wants verified but
  // no op writes (edit-history's `applyTop` pushes one per step file
  // BEFORE its sameState-skip `continue`, so a multi-file step with one
  // already-matching file is a live example) — deduped (a path may appear
  // in more than one of those roles) and globally sorted — the anti-ABBA
  // discipline, now applied to the whole batch rather than one op at a
  // time. Acquiring the full set upfront and holding it through the write
  // AND rollback window is what closes the gap where a batch released
  // file A's lock, a concurrent writer legitimately modified A, and then
  // a later op's failure rolled A back — clobbering that writer.
  //
  // Default `.sort()` compares UTF-16 code units, which is what this
  // needs: `localeCompare` is locale-sensitive and not a strict total
  // order (NFC/NFD variants compare equal), so two batches could disagree
  // on the order of the same pair of paths — exactly the ABBA shape the
  // sort exists to prevent. This orders LOCKS only; mutations run in
  // caller order (see the op loop).
  const allPaths = [
    ...new Set([
      ...opts.ops.flatMap(lockPathsFor),
      ...(opts.preconditions ?? []).map((p) => p.absPath),
    ]),
  ].sort()
  // Paths that are some op's own target take `withWriteLock`; rename
  // destinations and precondition-only paths — nothing mutates either, so
  // there's nothing to snapshot-and-restore-on-throw for, just ordinary
  // exclusion — take the plain mutex, matching what each path got before
  // the batch-wide acquisition.
  const snapshotPaths = new Set(opts.ops.map((op) => op.absPath))

  // P1-2: the realpath'd repo root, resolved ONCE per batch (the root
  // directory itself is not what a concurrent writer would swap — only a
  // target FILE is, and that is what `captureSnapshot` re-checks per path,
  // under the lock, below). Only computed when a precondition exists —
  // see `captureSnapshot`'s doc comment for why an ordinary op target with
  // no precondition never gets this check. `opts.canonicalRoot` is
  // documented as already realpath'd, but resolving it again here — rather
  // than trusting that — matters: the ledger undo route passes
  // `ctx.repoRoot` (the path the user typed, NOT necessarily realpath'd)
  // as `canonicalRoot`, so trusting the caller's claim would silently
  // widen or shrink the containment check depending on whether THIS
  // particular caller happened to honor the contract.
  let preconditionRootReal: string | undefined
  if (opts.preconditions?.length) {
    try {
      preconditionRootReal = await realpath(opts.canonicalRoot)
    } catch (err) {
      return {
        ok: false,
        stage: 'precondition',
        repoRel: opts.preconditions[0].repoRel,
        reason: `could not resolve the repo root: ${(err as Error).message}`,
      }
    }
  }
  const preconditionAbsPaths = new Set((opts.preconditions ?? []).map((p) => p.absPath))

  // FX11: `createNoFollow` needs the realpath'd root too, and a batch can
  // carry a create without carrying a precondition (`scaffold_route`, the
  // CLI's `allowCreate` route, `fetch_media`). Resolved on first use rather
  // than unconditionally, so a batch with neither a precondition nor a
  // create still makes no extra syscall, and cached so a multi-create batch
  // makes one. A failure here propagates out of `applyOp` as an ordinary
  // write-stage failure, which is the right outcome: a root we cannot
  // resolve is a containment check we cannot make, and an unprovable create
  // is refused rather than completed.
  let cachedRootReal: string | undefined = preconditionRootReal
  const resolveRootReal = async (): Promise<string> => {
    if (cachedRootReal === undefined) cachedRootReal = await realpath(opts.canonicalRoot)
    return cachedRootReal
  }

  type BatchOutcome =
    | { ok: true }
    | { failure: BrokerOp; reason: string; rolledBack: string[]; restoreErrors: string[] }
    | { preconditionFailure: { repoRel: string; reason: string } }

  /**
   * Attribute a path-carrying fs error to whichever op or precondition
   * owns it. Every path this is called with comes from `allPaths`, which
   * is built ONLY from op paths and precondition paths — so with a
   * concrete `absPath`, one of the two branches below always matches; the
   * `ops[0]`/`preconditions[0]` fallbacks only cover the rarer case where
   * the failing error carries no `.path` at all (a non-fs error surfacing
   * through the lock acquisition). The final throw is provably
   * unreachable — this function is only ever invoked once at least one op
   * or precondition exists (empty `ops` AND empty `preconditions` means
   * `allPaths` is empty too, so neither call site below ever runs) — kept
   * as a loud guard rather than a silent `undefined.repoRel` crash
   * (review round-1 P1/P2: that crash is exactly what `opForPath`'s old
   * `|| opts.ops[0]` fallback produced for a precondition-only path when
   * `ops` was empty).
   */
  function attributeFailure(
    absPath: string | undefined,
  ): { kind: 'op'; op: BrokerOp } | { kind: 'precondition'; repoRel: string } {
    const owningOp = absPath && opts.ops.find((op) => lockPathsFor(op).includes(absPath))
    if (owningOp) return { kind: 'op', op: owningOp }
    const owningPrecondition = absPath && opts.preconditions?.find((p) => p.absPath === absPath)
    if (owningPrecondition) return { kind: 'precondition', repoRel: owningPrecondition.repoRel }
    if (opts.ops[0]) return { kind: 'op', op: opts.ops[0] }
    if (opts.preconditions?.[0]) return { kind: 'precondition', repoRel: opts.preconditions[0].repoRel }
    throw new Error(
      'brokeredWrite: internal error: a filesystem failure with no op or precondition to attribute it to (empty batch).',
    )
  }

  // Pre-batch state of every path, read under the locks (populated inside
  // the `withPathLocks` callback below). This — not the journal — is the
  // rollback source: the journal holds what the CALLER read (possibly
  // before it even called us), while these are the bytes we are actually
  // about to clobber, so restoring them undoes exactly this batch's effect
  // and nothing else. Hoisted out of the callback (rather than declared
  // inside it) so the post-lock success region below can also read it to
  // build a `record` step's before/after state.
  const snapshots = new Map<string, PathSnapshot>()

  let outcome: BatchOutcome
  try {
    outcome = await withPathLocks(
      lockManager,
      allPaths,
      snapshotPaths,
      lockOpts,
      async (): Promise<BatchOutcome> => {
      for (const p of allPaths) {
        try {
          snapshots.set(
            p,
            await captureSnapshot(p, preconditionAbsPaths.has(p) ? preconditionRootReal : undefined),
          )
        } catch (err) {
          // P1-2: a `PreconditionIntegrityError` is ALWAYS a precondition
          // failure by meaning (see its doc comment), even on a path that
          // is also an op's own write target — checked before the
          // op-wins default below, not instead of it, so every other
          // failure shape keeps its existing attribution.
          if (err instanceof PreconditionIntegrityError) {
            const precondition = opts.preconditions?.find((pre) => pre.absPath === p)
            if (precondition) {
              return {
                preconditionFailure: { repoRel: precondition.repoRel, reason: err.message },
              }
            }
          }
          // Can't snapshot ⇒ can't roll back ⇒ don't mutate. Attribute to
          // whichever op or precondition owns the path, so the caller's
          // message names a file the user recognizes. A path that's
          // ONLY a precondition (no op writes it) surfaces as a
          // precondition-stage refusal rather than being force-fit into
          // a write-stage one — there's no `BrokerOp` to blame it on.
          const attribution = attributeFailure(p)
          if (attribution.kind === 'precondition') {
            return {
              preconditionFailure: { repoRel: attribution.repoRel, reason: (err as Error).message },
            }
          }
          return {
            failure: attribution.op,
            reason: (err as Error).message,
            rolledBack: [],
            restoreErrors: [],
          }
        }
      }

      // Precondition check — atomic with the snapshot capture above (both
      // run inside the same locked window), so it closes the TOCTOU gap
      // between a caller's own pre-read (e.g. `applyTop`'s byte-verify in
      // `edit-history.ts`) and this batch's lock acquisition: a concurrent
      // writer with no outer lock on this batch (an SDK structural tool
      // from another chat session) can land in exactly that gap. Runs
      // BEFORE any mutation, so a mismatch leaves the batch untouched —
      // same "refuse before touching disk" contract as the op-loop
      // failures below.
      for (const pre of opts.preconditions ?? []) {
        const snapshot = snapshots.get(pre.absPath)!
        if (!preconditionMatches(snapshot, pre.expect)) {
          return {
            preconditionFailure: {
              repoRel: pre.repoRel,
              reason: `'${pre.repoRel}' changed on disk since it was last read.`,
            },
          }
        }
      }

      // Mutations run in CALLER order, not lock order. The two are
      // independent and only one of them is the caller's business:
      // `scaffold_route` declares page-then-router so the route never
      // references a file that doesn't exist yet — a window Vite/HMR can
      // trip on, and one a crash mid-batch would leave on disk. Lock
      // acquisition stays path-sorted above (anti-ABBA); snapshots are
      // keyed by path, so neither depends on this order.
      const applied: BrokerOp[] = []
      for (const op of opts.ops) {
        try {
          await applyOp(op, preconditionAbsPaths, resolveRootReal)
          applied.push(op)
        } catch (err) {
          const rolledBack: string[] = []
          const restoreErrors: string[] = []
          const restoreOp = async (target: BrokerOp): Promise<boolean> => {
            let clean = true
            for (const p of lockPathsFor(target)) {
              const snapshot = snapshots.get(p)
              if (!snapshot) continue
              const failedWith = await restorePath(p, snapshot, preconditionAbsPaths.has(p))
              if (failedWith) {
                clean = false
                const label = p === target.absPath ? target.repoRel : pathLabel(target, p)
                restoreErrors.push(`${label}: ${failedWith}`)
              }
            }
            return clean
          }
          // The failing op may have written PARTIAL content, so its own
          // paths are restored too — except after EEXIST, which `wx`
          // (and the rename dest check) guarantee is all-or-nothing:
          // nothing was written, and "restoring" would rewrite the
          // CONCURRENT WINNER's file with bytes we only read.
          if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
            await restoreOp(op)
          }
          // Then undo the applied ops, newest first. Only fully-restored
          // ops are reported as rolled back; the rest surface through
          // `restoreErrors` (see `rollbackWarning`).
          for (let i = applied.length - 1; i >= 0; i--) {
            if (await restoreOp(applied[i])) rolledBack.push(applied[i].repoRel)
          }
          return { failure: op, reason: (err as Error).message, rolledBack, restoreErrors }
        }
      }
      return { ok: true }
    },
    )
  } catch (err) {
    // `withWriteLock` reads its snapshot AT ACQUISITION, so an unreadable
    // path (a directory, a dangling parent) throws before the batch body
    // runs — i.e. before anything was mutated. `withLock`'s own
    // acquisition (precondition-only paths, and every path when `ops` is
    // empty) can also throw here (e.g. a bad path resolving under
    // `canonicalKeySync`). Report it as a typed refusal instead of
    // letting it escape as an exception: the broker's contract is that
    // filesystem problems come back as a typed result, and only `emit`
    // may propagate.
    const attribution = attributeFailure((err as NodeJS.ErrnoException)?.path)
    if (attribution.kind === 'precondition') {
      // Lock acquisition threw, so nothing was mutated. Same no-orphan rule as
      // the precondition refusal below.
      if (opts.journal.length > 0) await discardBackupDir(opts.canonicalRoot, backup.backupDir)
      return {
        ok: false,
        stage: 'precondition',
        repoRel: attribution.repoRel,
        reason: (err as Error).message,
      }
    }
    return {
      ok: false,
      stage: 'write',
      reason: (err as Error).message,
      repoRel: attribution.op.repoRel,
      op: attribution.op,
      // Same `journal.length > 0` condition the success path uses (see
      // `writeBackupJournal`'s own note): an empty journal means the
      // directory was never created on disk, so it must not be reported
      // here either.
      ...(opts.journal.length > 0 ? { backupDir: backup.backupDir } : {}),
      rolledBack: [],
      restoreErrors: [],
    }
  }

  if ('preconditionFailure' in outcome) {
    // No backup/rollback bookkeeping to report: nothing was written, and
    // — critically — the `record` block below is never reached from this
    // return, so a failed precondition can never record a bogus undo/redo
    // step for a batch that didn't happen. The journal directory the batch
    // wrote before taking its locks goes with it — see `discardBackupDir`.
    if (opts.journal.length > 0) await discardBackupDir(opts.canonicalRoot, backup.backupDir)
    return {
      ok: false,
      stage: 'precondition',
      repoRel: outcome.preconditionFailure.repoRel,
      reason: outcome.preconditionFailure.reason,
    }
  }

  if ('failure' in outcome) {
    return {
      ok: false,
      stage: 'write',
      reason: outcome.reason,
      repoRel: outcome.failure.repoRel,
      op: outcome.failure,
      // Same `journal.length > 0` condition as above and as the success
      // path — an empty journal never created the directory on disk.
      ...(opts.journal.length > 0 ? { backupDir: backup.backupDir } : {}),
      rolledBack: outcome.rolledBack,
      restoreErrors: outcome.restoreErrors,
    }
  }

  // Invalidate + emit run AFTER the locks unwind: neither touches the
  // files, and `emit` can be slow (audit I/O), so holding the batch's
  // locks across them would widen the window other writers wait on for
  // no safety gain.
  if (opts.invalidate) {
    opts.invalidate([...(opts.invalidatePaths ?? defaultInvalidatePaths(opts.ops))])
  }

  // History recording and the edit ledger both land here: same post-lock
  // region as `invalidate`, for the same reason — see the ABBA-deadlock
  // note on `BrokeredWriteOptions['record']`. By this point every lock
  // this batch took has been released.
  // Computed unconditionally: the ledger below always runs, and it is
  // derived from the ops and the existing snapshots, so it costs no I/O.
  const { after, repoRelByAbs } = computeAfterStates(opts.ops, allPaths, snapshots)

  if (opts.record) {
    // Non-fatal: history is an undo/redo AFFORDANCE, not a durability
    // guarantee. Only a caller-supplied `emit` may propagate past
    // `brokeredWrite`; the writes are already durable on disk.
    try {
      // `allPaths` also carries precondition-only paths (verified but
      // never mutated), which `repoRelByAbs` has no entry for. Filtering
      // to paths it DOES know about keeps a recorded step from carrying a
      // `RecordedFile` with an undefined `repoRel` (review round-1 P1:
      // that undefined repoRel used to reach `fileEditLockKey` on a later
      // undo/redo of this step). Built once and reused below for the
      // shape check, so this list is never mapped twice.
      const files = allPaths.filter((p) => repoRelByAbs.has(p)).map((p) => {
        const s = snapshots.get(p)!
        return {
          repoRel: repoRelByAbs.get(p)!,
          absPath: p,
          before: { exists: s.existed, content: s.content },
          after: after.get(p)!,
        }
      })
      // `computeAfterStates`'s `toBuf` can hand back `{ exists: true,
      // content: null }` as a last resort for content it couldn't turn
      // into bytes (see its comment) — a shape this codebase treats
      // everywhere else as a caller bug. `EditorEditHistory.record`'s own
      // no-op check only catches it for an OVERWRITE (before.exists is
      // also true there, so the byte-compare runs and throws — caught
      // below, step lost, the same graceful degradation a `record`
      // failure already gets). For a CREATE, before.exists is false, so
      // that same check short-circuits on the exists mismatch without
      // ever touching content, and the poisoned step would be pushed onto
      // the undo stack — only to crash a LATER undo with a raw TypeError
      // instead of a graceful refusal, jamming the stack. Refusing it
      // here makes the create case degrade exactly like the overwrite
      // case: this record is lost with a warning; the write itself
      // already durably succeeded, and the ledger entry below is
      // unaffected.
      if (files.some((f) => f.after.exists && !f.after.content)) {
        throw new Error(
          'brokeredWrite: unrepresentable after-state (exists with no content). Refusing to record an undo/redo step for it.',
        )
      }
      await opts.record.history.record({ label: opts.record.label, files })
    } catch (err) {
      console.warn('brokeredWrite: history.record failed (undo/redo step lost):', err)
    }
  }

  // The edit ledger. Unconditional — an undescribed write still gets an
  // entry, because an unexplained change is a fact the Activity panel has
  // to show. `appendLedgerEntry` swallows its own failures.
  {
    const touched = allPaths.filter((p) => repoRelByAbs.has(p))
    const afterHashes: Record<string, string> = {}
    for (const p of touched) {
      const state = after.get(p)
      if (state?.exists && state.content) {
        afterHashes[repoRelByAbs.get(p)!] = hashContent(state.content)
      }
    }
    // P1-3 (codex review finding, 2026-08-20): which of `touched` did NOT
    // exist before this batch — i.e. this write created them. Read
    // straight off `snapshots`, which every path here already has an
    // entry in (populated in the locked callback above, before any
    // mutation ran), so this is a map lookup, not new I/O. See
    // `LedgerEditEntry.createdFiles`'s doc comment for why Plan B's Undo
    // needs this recorded rather than inferred.
    const createdFiles = touched
      .filter((p) => !snapshots.get(p)!.existed)
      .map((p) => repoRelByAbs.get(p)!)
    // F1 (codex review round 4, 2026-08-20): only an `undo`-lane write
    // needs its own HEAD fingerprint — see `LedgerEditEntry.headAtWrite`'s
    // doc comment for what `reconcileLedger` does with it and why this is
    // `headSha` (the resolved tip COMMIT) rather than `.git/HEAD`'s raw
    // bytes. Skipped for every other write so an ordinary edit pays no
    // extra `git` spawn.
    const headAtWrite =
      opts.describe?.reverts !== undefined
        ? ((await headSha(opts.canonicalRoot)) ?? undefined)
        : undefined
    await appendLedgerEntry(opts.canonicalRoot, {
      type: 'edit',
      id: randomUUID(),
      at: new Date().toISOString(),
      branch: await resolveBranchCached(opts.canonicalRoot),
      kind: opts.describe?.kind ?? 'unknown',
      lane: opts.describe?.lane ?? 'direct',
      files: touched.map((p) => repoRelByAbs.get(p)!),
      createdFiles,
      // C1 (round-2 whole-branch review finding, 2026-08-19): `writeBackupJournal`
      // ALWAYS computes a `backupDir` path, even for an empty `journal`
      // (the allowCreate lane — a brand-new file has no prior content to
      // back up) — its own write loop just never runs, so the directory
      // is never created on disk. `edit-handler.ts` already knows to omit
      // `backupDir` from its allowCreate HTTP response for this exact
      // reason (see its comment there); this is the same fact applied to
      // the ledger entry, which was still advertising the never-created
      // path unconditionally. Plan B's Undo is gated on the backup still
      // existing on disk, so a phantom path here would make Undo fail at
      // click time instead of correctly reading as unavailable.
      ...(opts.journal.length > 0 ? { backupDir: backup.backupDir } : {}),
      afterHashes,
      fields: opts.describe?.fields,
      correlationId: opts.describe?.correlationId,
      // P1-2 (codex review round 3, 2026-08-20): see
      // `LedgerEditEntry.reverts`'s doc comment — `reconcileLedger`
      // reads this to recognise an undo/original pair and exclude both
      // from its "clean tree implies committed" heuristic.
      reverts: opts.describe?.reverts,
      // F1 (codex review round 4, 2026-08-20): see
      // `LedgerEditEntry.headAtWrite`'s doc comment — lets
      // `reconcileLedger` tell this write's OWN immediate cleanliness
      // apart from a real commit that lands later.
      headAtWrite,
    })
  }

  const emitted = (opts.emit ? await opts.emit() : undefined) as E
  return {
    ok: true,
    ...(opts.journal.length > 0 ? { backupDir: backup.backupDir } : {}),
    emitted,
  }
}

/** Repo-relative label for one of an op's paths (renames own two). */
function pathLabel(op: BrokerOp, absPath: string): string {
  if (op.kind === 'rename' && absPath === op.toAbsPath) return op.toRepoRel
  return op.repoRel
}

/**
 * Post-batch state of every path this batch touched, keyed by absolute
 * path, plus each path's repo-relative label.
 *
 * Hoisted out of the `record` block so the ledger can hash the same
 * states rather than re-reading files off disk. Computed from the ops and
 * the pre-batch snapshots — never a disk read, so it costs nothing.
 */
function computeAfterStates(
  ops: ReadonlyArray<BrokerOp>,
  allPaths: readonly string[],
  snapshots: Map<string, PathSnapshot>,
): { after: Map<string, HistoryFileState>; repoRelByAbs: Map<string, string> } {
  const repoRelByAbs = new Map<string, string>()
  for (const op of ops) {
    repoRelByAbs.set(op.absPath, op.repoRel)
    if (op.kind === 'rename') repoRelByAbs.set(op.toAbsPath, op.toRepoRel)
  }
  // `BrokerOp['content']` is declared `string | Buffer`, and every real
  // caller honors that (grep confirms it — deterministic applicator
  // output, planner-built template strings, or a real `Buffer` from
  // `readFile`/asset download). But this function now runs on EVERY
  // write, not just ones opting into `record`, so a caller that smuggles
  // something else past the type system (one test does, to observe
  // `writeFile`'s consumption order via an async generator) must not
  // crash the whole batch — that would violate `brokeredWrite`'s "never
  // throws for a filesystem failure" contract for a write that would
  // otherwise have succeeded. Falling back to `content: null` here is
  // NOT a recognized state — this file's own invariant is `exists: false
  // ⟺ content: null` (the precondition validation above, ~line 537,
  // rejects `exists: true` paired with `content: null` as a caller bug
  // for exactly this reason). `{ exists: true, content: null }` is
  // produced only as a last resort, to keep this function from crashing
  // a batch that would otherwise have succeeded. The `record` block below
  // refuses to hand this shape to `history.record` — see its comment.
  const toBuf = (c: string | Buffer): Buffer | null => {
    if (Buffer.isBuffer(c)) return c
    if (typeof c === 'string') return Buffer.from(c)
    return null
  }
  const after = new Map<string, HistoryFileState>()
  for (const p of allPaths) {
    const s = snapshots.get(p)!
    after.set(p, { exists: s.existed, content: s.content })
  }
  for (const op of ops) {
    if (op.kind === 'write') after.set(op.absPath, { exists: true, content: toBuf(op.content) })
    else if (op.kind === 'delete') after.set(op.absPath, { exists: false, content: null })
    else {
      after.set(op.toAbsPath, after.get(op.absPath)!)
      // A same-path rename (`lockPathsFor` explicitly tolerates it — see
      // its doc comment) is a no-op on disk: the file never moved, so it
      // must not be recorded as deleted. Without this guard the line
      // above and the one below would both target the same map key
      // (`absPath === toAbsPath`) and the unconditional absent-set would
      // win, recording a phantom delete — a later redo of that step
      // would then delete a file that was never touched.
      if (op.absPath !== op.toAbsPath) after.set(op.absPath, { exists: false, content: null })
    }
  }
  return { after, repoRelByAbs }
}
