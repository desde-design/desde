/**
 * Write safety for the SDK's **built-in** `Write` / `Edit` tools — the closer
 * for what the codebase called "the documented Phase 4b gap" (audit Task 13).
 *
 * Every other Editor mutation lane journals its originals and serializes
 * against concurrent writers:
 *   - the CLI edit route runs `applyEdit` under `withFileEditLocks`
 *     (editor-cli/src/server/session-lock.ts) and backs originals up to
 *     `.desde/backups/`;
 *   - the SDK's *structural* tools (`insert_component`, `delete_file`, …) go
 *     through {@link brokeredWrite} (write-broker.ts), which does the same.
 *
 * The SDK's built-in `Write`/`Edit` do neither: the Agent SDK executes them
 * inside its own runtime, so no Editor code sits on the write path. A chat
 * turn could therefore (a) overwrite a file with no recoverable original, and
 * (b) interleave with a `/api/editor/edit` write to the same file and lose
 * one of the two updates.
 *
 * ## What this module does
 *
 * We cannot route the SDK's writes through the broker — the SDK owns the
 * `writeFile` call. What we CAN do is bracket it with hooks:
 *
 *   - **`PreToolUse` (`Write|Edit`)** — the last point that is *guaranteed* to
 *     run before execution for every such tool call. It:
 *       1. acquires the CLI's per-file edit lock for the target (via the
 *          injected {@link SdkWriteGuardOptions.acquireWriteLock}) and HOLDS
 *          it across the SDK's execution, and
 *       2. journals the file's current bytes to `.desde/backups/` under
 *          the lock, so the original is captured from the same serialized
 *          state the SDK is about to overwrite.
 *     A journal failure **denies the write** (`permissionDecision: 'deny'`) —
 *     same contract as `brokeredWrite`'s `stage: 'backup'` refusal and the
 *     edit handler's "Patch aborted; no source files modified."
 *
 *   - **`PostToolUse` / `PostToolUseFailure` / `PermissionDenied`
 *     (`Write|Edit`)** — release the hold, correlated by `tool_use_id`. The
 *     SUCCESS `PostToolUse` delivery additionally records an undo/redo step
 *     (Task 5 of the toolbar undo/redo plan) when a `history` recorder is
 *     injected: `preToolUse` already stashed the pre-write bytes (reusing
 *     the journal's own read, no second `fs.readFile`) keyed by
 *     `tool_use_id`, independent of whether a lock hold exists — so the
 *     edit-fix mini-turn's journal-only mode (no `acquireWriteLock`, hence
 *     no `ToolUseHold`) still gets undo coverage. `hook_event_name`
 *     discriminates the three deliveries; a failed or denied write records
 *     nothing, and `history.record()` is fire-and-forget with `.catch(warn)`
 *     so a recorder failure can't fail the hook.
 *
 *     **Edit-ledger entry (P1-1, whole-branch review finding, 2026-08-18).**
 *     The same success branch also appends an edit-ledger entry
 *     (`lane: 'chat'`, `kind: 'write'` or `'edit'`), for the same reason
 *     it records history: this is the ONLY place in the codebase that
 *     observes a built-in Write/Edit landing. Every other lane —
 *     deterministic applicators, the SDK's structural tools, undo/redo —
 *     funnels through `brokeredWrite`, which is where the ledger append
 *     otherwise lives; the built-in tools are precisely the write path
 *     that can't route through there (see the module doc above), so
 *     without this they produced no ledger entry at all and
 *     `GET /api/editor/ledger` silently omitted every chat-authored
 *     source edit. Gated on the SAME condition as the undo/redo step
 *     (`opts.history` truthy) — the edit-fix mini-turn's OWN guard
 *     instance passes no `history` (its writes are PROVISIONAL until its
 *     own post-turn validation passes; see `edit-handler.ts`'s
 *     `tryPropEditLLMFallback`, which records ONE consolidated ledger
 *     entry itself once a fix is verified durable, mirroring how it
 *     already records ONE consolidated undo/redo step there). Best-effort
 *     and outside the lock window, same discipline as `brokeredWrite`'s
 *     own ledger append: never fails the write, never holds a lock across
 *     it — and, unlike the undo/redo step just above, AWAITED rather than
 *     fire-and-forget, again matching `brokeredWrite` exactly. See
 *     `recordLedgerEntry`'s own doc comment for why that one distinction
 *     matters here.
 *
 *   - **turn end** — {@link SdkWriteGuard.releaseAll} sweeps anything still
 *     held (turn crash, abort, an SDK path that fires none of the three
 *     release events). A lock must never outlive the turn that took it. Any
 *     pending history snapshot is dropped here too, unrecorded — a step is
 *     only ever written by the success `PostToolUse` branch above.
 *
 * ## Hook-ordering facts this relies on (verified against the installed SDK)
 *
 *   - `PreToolUseHookInput` carries `permissionDecision` in its
 *     `hookSpecificOutput` — i.e. PreToolUse runs BEFORE the permission
 *     system, so it fires even for calls `canUseTool` (edit-ack.ts) later
 *     denies, and it fires regardless of what the prototype's
 *     `.claude/settings.json` pre-approves. That's why journaling lives here
 *     and not in `canUseTool`.
 *   - `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `PermissionDenied`
 *     all carry `tool_use_id` (sdk.d.ts), which is the correlation key.
 *   - `PostToolUse` "fires per-tool and may run concurrently for parallel tool
 *     calls" (sdk.d.ts on `PostToolBatch`), so per-tool-use correlation is the
 *     right granularity.
 *
 * ## Residual risks (stated, not hidden)
 *
 *   - **Denied writes.** A `canUseTool` deny is a normal outcome here (no-op
 *     write, `old_string` not found, …). We release on `PermissionDenied`; if
 *     a given SDK build doesn't emit that event, the hold falls through to the
 *     watchdog below rather than to the end of the turn.
 *   - **Watchdog.** A hold with no matching release is force-released after
 *     {@link SdkWriteGuardOptions.lockHoldTimeoutMs} (default 15s) with a
 *     warning. When it fires, the guarantee for that one write degrades from
 *     "held across execution" to the brief's barrier semantics (blocked until
 *     concurrent edits finished, journalled, then unserialized) — the same
 *     window the fallback design accepts.
 *   - **Parallel batch + a concurrent tree op.** The acquirer the CLI injects
 *     takes the repo's tree gate SHARED, and a *pending* exclusive (Commit /
 *     Publish / branch switch) blocks new shared acquisitions — that's the
 *     anti-starvation rule in session-lock.ts. So if an SDK build ever
 *     resolves ALL PreToolUse hooks of a multi-write batch before executing
 *     any of them, AND a tree op arrives between two of those hooks, the
 *     second hook parks behind the tree op, which in turn waits on the first
 *     hook's hold, which waits on an execution that hasn't started. The
 *     watchdog is what breaks it. Claude Code executes Write/Edit
 *     sequentially, so this is a defensive bound, not an observed shape.
 *   - **Re-entrancy.** Holds are refcounted per repo-relative path so a second
 *     `Edit` to a file this turn already holds cannot deadlock against itself
 *     (which is possible if an SDK build resolves all PreToolUse hooks of a
 *     batch before executing any of them). The cost is that the hold spans
 *     both writes.
 *   - **Journal dedupe.** `(path, content-hash)` pairs already journalled in
 *     this turn are not re-journalled. Recovery is unaffected — the earlier
 *     directory holds exactly those bytes — and it keeps a chain of denied
 *     writes from filling `.desde/backups/` with identical copies.
 *   - **New files.** A `Write` that creates a file has no original; nothing is
 *     journalled (the lock is still taken). Rollback of a created file is
 *     "delete it", which the working tree already tells you (untracked path).
 *   - **Bounded acquisition ⇒ journal-only degradation.** The pre-hook waits at
 *     most {@link DEFAULT_ACQUIRE_BUDGET_MS} (or until the hook's AbortSignal
 *     fires) to be granted the lock, then proceeds JOURNAL-ONLY with a warning
 *     naming the file. Why bounded at all: a chat write can park behind the
 *     mini-turn's up-to-90s EXCLUSIVE tree gate, and the SDK enforces its own
 *     timeout on hook callbacks — an SDK timeout firing first would run the
 *     tool unserialized AND leave our late acquisition orphaned. Giving up on
 *     our own terms keeps both halves defined here (the registration site also
 *     sets an explicit matcher `timeout` well above this budget). When it
 *     fires, that write is journalled but not serialized.
 *   - **Cross-turn ABBA.** Two turns issuing parallel {A,B} and {B,A} write
 *     batches can park each other (turn 1 holds A wanting B; turn 2 holds B
 *     wanting A). The per-op acquisition order that makes `withFileEditLocks`
 *     deadlock-free doesn't apply here: the SDK hands us one file per hook, so
 *     there is no batch to sort. The acquisition budget above breaks it in
 *     seconds (and the watchdog behind that), degrading to journal-only rather
 *     than hanging. Same reason as the parallel-batch case, this needs the SDK
 *     to run Write/Edit concurrently, which Claude Code does not.
 *   - **Key namespace.** The lock key is derived from the repo-relative path,
 *     matching what the edit route feeds `withFileEditLocks`. Two spellings
 *     that survive `normalizeLockPath` differently (symlink vs target) don't
 *     serialize at THIS layer — `FileLockManager` remains authoritative for
 *     the write syscall. Same caveat, verbatim, as session-lock.ts.
 *
 * ## Layering
 *
 * This module must not import from `editor-cli/` — the CLI owns the lock
 * namespace and INJECTS an acquire function (`acquireFileEditLock` in
 * `editor-cli/src/server/session-lock.ts`). Callers that pass no acquirer
 * get journaling only; see {@link SdkWriteGuardOptions.acquireWriteLock} for
 * the one caller that deliberately does that (the edit-fix mini-turn, which
 * already runs under the EXCLUSIVE tree gate and would self-deadlock). That
 * mode is ANNOUNCED, not silent — the guard emits a one-time warning naming
 * it, so a future caller that simply forgets to inject the acquirer gets a
 * signal instead of quietly losing serialization.
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, relative as relativePath, resolve as resolvePath } from 'node:path'

import type {
  HookCallback,
  HookJSONOutput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'

import {
  writeBackupJournal,
  BackupJournalPathEscapeError,
  type BackupJournalResult,
  type BackupEntry,
} from './backup-journal'
import { isRootEscape } from './root-escape'
import { DesdeDirSymlinkError } from './desde-dir'
import type { HistoryRecorder, HistoryFileState } from './write-broker'
import { appendLedgerEntry, hashContent, resolveBranchCached } from '../ledger/edit-ledger'

/**
 * Acquire the per-file edit lock for `repoRelPath` and resolve with its
 * release function. Injected by the CLI so this module stays free of
 * `editor-cli/` imports; the CLI's impl derives the key with the same
 * `normalizeLockPath` / `fileEditLockKey` semantics the edit route uses, so
 * chat writes and route edits share one namespace.
 */
export type AcquireWriteLock = (repoRelPath: string) => Promise<() => void>

/**
 * Force-release a hold that never saw a matching release event. A built-in
 * Write/Edit executes in milliseconds, so this is ~5 orders of magnitude of
 * headroom; it exists to bound a missed release (or the parallel-batch shape
 * in the module header) to seconds rather than to the rest of the turn.
 */
const DEFAULT_LOCK_HOLD_TIMEOUT_MS = 15_000

/**
 * How long the pre-hook will WAIT to be granted the lock before giving up and
 * proceeding journal-only. Bounded on purpose: a chat `Write` can park behind
 * the mini-turn's up-to-90s EXCLUSIVE tree gate, and the SDK enforces its own
 * timeout on hook callbacks — if the SDK's timeout fired first it would run
 * the tool UNSERIALIZED *and* our late acquisition would orphan a hold. By
 * bounding the wait ourselves (and setting an explicit, larger matcher
 * `timeout` at the registration site in `run-chat-turn-sdk.ts`) the
 * degradation is defined by OUR code, not by an SDK default we don't control.
 */
const DEFAULT_ACQUIRE_BUDGET_MS = 10_000

export interface SdkWriteGuardOptions {
  /** Repo root the SDK edits (branch mode: the user's working tree). */
  worktreeRoot: string
  /**
   * Per-file lock acquirer. **Omit for any caller that already holds the
   * repo's tree gate EXCLUSIVELY** — `withFileEditLocks` takes the gate
   * SHARED, so acquiring from inside an exclusive holder is a guaranteed
   * self-deadlock. The edit-fix mini-turn is exactly that case (the CLI edit
   * route re-enters under `withTreeLock` before running it), so it passes no
   * acquirer and relies on the exclusive gate for serialization. Omitting it
   * keeps journaling.
   */
  acquireWriteLock?: AcquireWriteLock
  /** Watchdog for an un-released hold. Default {@link DEFAULT_LOCK_HOLD_TIMEOUT_MS} (15s). */
  lockHoldTimeoutMs?: number
  /**
   * How long to wait for the lock before degrading to journal-only. Default
   * {@link DEFAULT_ACQUIRE_BUDGET_MS} (10s). Must stay comfortably BELOW the
   * `timeout` set on the PreToolUse matcher in `run-chat-turn-sdk.ts`.
   */
  acquireBudgetMs?: number
  /** Journal writer seam (tests inject a failing one). */
  writeJournal?: (
    canonicalRoot: string,
    entries: ReadonlyArray<BackupEntry>,
  ) => Promise<BackupJournalResult>
  /** Warning sink. Defaults to `console.warn`. */
  onWarn?: (message: string) => void
  /**
   * Undo/redo history sink (Task 5 of the toolbar undo/redo plan). When
   * present, a successful `PostToolUse` for `Write`/`Edit` records a step
   * capturing the file's bytes from immediately before the SDK's own write
   * (captured in `preToolUse`, under the same lock the journal read comes
   * from) through its bytes immediately after. Omitted entirely by the
   * edit-fix mini-turn's headless test doubles and any caller that doesn't
   * want chat writes to participate in undo/redo.
   */
  history?: HistoryRecorder
}

export interface SdkWriteGuard {
  /** Register under `PreToolUse` with matcher `'Write|Edit'`. */
  preToolUse: HookCallback
  /**
   * Register under `PostToolUse`, `PostToolUseFailure` (matcher
   * `'Write|Edit'`) and `PermissionDenied`. Idempotent per `tool_use_id`.
   */
  release: HookCallback
  /** Turn-end sweep. Safe to call more than once. */
  releaseAll: (reason: string) => void
  /** Test hook — repo-relative paths currently held. */
  heldPathsForTests: () => string[]
}

const CONTINUE: HookJSONOutput = { continue: true }

interface PathHold {
  refs: number
  /** Resolves with the release fn. Pending until the lock is granted. */
  release: Promise<() => void>
}

interface ToolUseHold {
  repoRel: string
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Before-write snapshot for one in-flight tool_use, kept ONLY when a
 * `history` recorder is injected. Deliberately a separate map from
 * `heldByToolUse` rather than a field bolted onto `ToolUseHold`: a tool
 * call that runs with no `acquireWriteLock` injected (the edit-fix
 * mini-turn's journal-only mode — see the module doc's "Layering" section)
 * never gets a `ToolUseHold` at all, since there is no lock to track. But
 * its writes are still editor writes that should participate in
 * undo/redo, so the before-state capture must not depend on whether a
 * `ToolUseHold` exists. Per-tool-call, unlike `journalledKeys`' once-per-
 * turn dedupe — per-step undo needs a before-snapshot for THIS write, not
 * the turn's first one.
 */
interface HistorySnapshot {
  repoRel: string
  absPath: string
  before: HistoryFileState
  /**
   * The literal `tool_name` PreToolUse saw ('Write' or 'Edit') — captured
   * here rather than re-read off the terminal event in `release`, so the
   * ledger's `kind` never depends on a terminal delivery echoing the same
   * `tool_name` PreToolUse already gated on (verified equal by the SDK's
   * own hook contract, but this is the source of truth we actually
   * checked).
   */
  toolName: string
  /**
   * The repo-relative backup directory `journalOriginal` actually wrote
   * the original to, when it wrote one at all. `undefined` for a brand-new
   * file (nothing existed to back up — same "no journal, no backupDir"
   * rule `brokeredWrite` follows for its own allowCreate lane, C1 in the
   * round-2 whole-branch review). C2 (same review): this field did not
   * exist before the fix — `journalOriginal` computed a real `backupDir`
   * and then threw it away, so a primary chat Write/Edit's ledger entry
   * always landed with no recovery path even when a real backup existed
   * on disk for it.
   */
  backupDir: string | undefined
}

export function createSdkWriteGuard(opts: SdkWriteGuardOptions): SdkWriteGuard {
  const holdTimeoutMs = opts.lockHoldTimeoutMs ?? DEFAULT_LOCK_HOLD_TIMEOUT_MS
  const acquireBudgetMs = opts.acquireBudgetMs ?? DEFAULT_ACQUIRE_BUDGET_MS
  const journal = opts.writeJournal ?? writeBackupJournal
  const warn = opts.onWarn ?? ((message: string) => console.warn(message))

  // Canonicalize the root once, lazily — the containment check compares
  // realpath'd file paths against it, so a symlinked repo root (or macOS's
  // /var → /private/var alias) must be canonicalized too. Same reasoning as
  // write-invalidate-hook.ts.
  let rootRealPromise: Promise<string> | undefined
  const rootReal = (): Promise<string> => {
    rootRealPromise ??= fs.realpath(opts.worktreeRoot).catch(() => opts.worktreeRoot)
    return rootRealPromise
  }

  const heldByPath = new Map<string, PathHold>()
  const heldByToolUse = new Map<string, ToolUseHold>()
  /** See {@link HistorySnapshot}. Empty (and never consulted) when `opts.history` is unset. */
  const historyByToolUse = new Map<string, HistorySnapshot>()
  /**
   * Acquisitions that have STARTED but not yet registered in
   * `heldByToolUse`, keyed by tool_use_id. Without this, two concurrent
   * PreToolUse deliveries for the SAME tool_use_id both see "not held", both
   * acquire (refcount 2), and the single terminal event that follows only
   * drops one — leaking the per-file mutex AND the tree-shared gate for the
   * rest of the turn. The second delivery awaits this instead.
   */
  const acquireInFlight = new Map<string, Promise<unknown>>()
  // Maps a journaled `repoRel:contentHash` key to the repo-relative backup
  // directory that content actually landed in — not just a `Set`, because
  // C2 (round-2 whole-branch review finding, 2026-08-19) needs that
  // directory to build the ledger entry. On a dedupe hit (identical bytes
  // already backed up earlier in this turn) the backup genuinely still
  // exists on disk under the EARLIER call's directory; reporting `undefined`
  // instead would make Undo read as unavailable for a write that has a
  // perfectly good recovery path.
  const journalledKeys = new Map<string, string>()
  let journalOnlyNoted = false

  function settleRelease(hold: PathHold): void {
    hold.release.then(
      (release) => {
        try {
          release()
        } catch {
          // A release that throws would otherwise take down the hook.
        }
      },
      () => {
        // Acquisition failed — nothing was ever held.
      },
    )
  }

  async function acquirePath(repoRel: string): Promise<void> {
    const existing = heldByPath.get(repoRel)
    if (existing) {
      // Re-entrant: this turn already holds the file. Refcount instead of
      // re-acquiring, which would deadlock against ourselves.
      existing.refs++
      await existing.release
      return
    }
    // Register the entry BEFORE awaiting so a concurrent pre-hook for the
    // same path refcounts onto this acquisition rather than starting a
    // second one.
    const release = opts.acquireWriteLock!(repoRel)
    const hold: PathHold = { refs: 1, release }
    heldByPath.set(repoRel, hold)
    try {
      await release
    } catch (err) {
      if (heldByPath.get(repoRel) === hold) heldByPath.delete(repoRel)
      throw err
    }
  }

  function releasePath(repoRel: string): void {
    const hold = heldByPath.get(repoRel)
    if (!hold) return
    hold.refs--
    if (hold.refs > 0) return
    heldByPath.delete(repoRel)
    settleRelease(hold)
  }

  /**
   * Wait up to {@link acquireBudgetMs} (or until the hook's AbortSignal
   * fires) for the lock. On give-up we DROP our refcount, so the grant that
   * eventually lands releases immediately rather than orphaning a hold nobody
   * will ever release — and the write proceeds journal-only.
   */
  async function acquirePathBounded(
    repoRel: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const attempt = acquirePath(repoRel)
    // An abandoned attempt must never surface as an unhandled rejection.
    const errRef: { err: Error | null } = { err: null }
    const settled = attempt.then(
      () => 'acquired' as const,
      (err: unknown) => {
        errRef.err = err as Error
        return 'failed' as const
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const bail = new Promise<'bail'>((resolve) => {
      timer = setTimeout(() => resolve('bail'), acquireBudgetMs)
      timer.unref?.()
      if (!signal) return
      if (signal.aborted) {
        resolve('bail')
        return
      }
      onAbort = () => resolve('bail')
      signal.addEventListener('abort', onAbort, { once: true })
    })
    let outcome: 'acquired' | 'failed' | 'bail'
    try {
      outcome = await Promise.race([settled, bail])
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
    if (outcome === 'acquired') return true
    if (outcome === 'bail') {
      releasePath(repoRel)
      // I1 (audit-fixes wave, documented not fixed): the "long-running tree
      // operation" that most often holds this is the edit-fix mini-turn
      // (`tryPropEditLLMFallback` in editor-cli/src/server/edit-handler.ts),
      // which runs under the tree gate EXCLUSIVE for up to 90s — well beyond
      // this 10s budget. When we give up here, the write still executes (the
      // SDK owns the call; we only journal it), so it lands DURING that
      // mini-turn's exclusive window. The mini-turn's whole-repo
      // `snapshotWorkingState` before/after diff has no way to distinguish
      // this now-unserialized write from a side effect ITS OWN agent turn
      // produced — its rollback (`cleanupAllWrites`) can revert this write,
      // or its "the agent also modified …" note can misattribute it. See the
      // CALLER CONTRACT comment on `tryPropEditLLMFallback` for the full
      // writeup; scoping that rollback to guard-journaled paths (not a
      // whole-repo diff) is the real fix and is follow-up, not done here.
      warn(
        `[editor-sdk] gave up waiting ${acquireBudgetMs}ms for the edit lock on '${repoRel}' ` +
          `(aborted or a long-running tree operation holds it) — the write proceeds JOURNAL-ONLY, ` +
          `unserialized against concurrent /api/editor/edit writes to this file.`,
      )
    } else {
      warn(
        `[editor-sdk] could not acquire the edit lock for '${repoRel}': ` +
          `${errRef.err?.message ?? 'unknown error'} — the write proceeds JOURNAL-ONLY, ` +
          `unserialized against concurrent /api/editor/edit writes to this file.`,
      )
    }
    return false
  }

  function noteJournalOnlyMode(): void {
    if (journalOnlyNoted) return
    journalOnlyNoted = true
    warn(
      `[editor-sdk] SDK write guard is running JOURNAL-ONLY — no acquireWriteLock was injected, ` +
        `so built-in Write/Edit are backed up to .desde/backups/ but NOT serialized against ` +
        `concurrent /api/editor/edit writes. Expected for the edit-fix mini-turn (already under ` +
        `the EXCLUSIVE tree gate) and headless harnesses; any other caller should inject it.`,
    )
  }

  function registerToolUse(toolUseId: string, repoRel: string): void {
    const previous = heldByToolUse.get(toolUseId)
    if (previous) {
      // A duplicate delivery that slipped past `acquireInFlight`. Drop the
      // surplus ref and its watchdog instead of overwriting (and orphaning)
      // them — an overwritten entry is exactly the "held until turn end" leak.
      if (previous.timer) clearTimeout(previous.timer)
      heldByToolUse.delete(toolUseId)
      releasePath(previous.repoRel)
    }
    const timer = setTimeout(() => {
      warn(
        `[editor-sdk] write lock on '${repoRel}' was held for >${holdTimeoutMs}ms with no ` +
          `PostToolUse/PostToolUseFailure/PermissionDenied for tool_use ${toolUseId} — force-releasing.`,
      )
      // Deliberately does NOT touch `historyByToolUse` — only the lock hold
      // is bounded to `holdTimeoutMs`. If the real terminal event shows up
      // late (after this fires), `release` still finds the pending
      // snapshot and, if it's the success `PostToolUse`, still records a
      // step — that's intended: a slow-but-genuine write shouldn't lose
      // undo coverage just because the lock's watchdog gave up first. Any
      // snapshot that never sees a terminal event at all is cleared, still
      // unrecorded, by `releaseAll` at turn end. Accepted risk: that late
      // PostToolUse reads the file's after-state without holding the lock
      // (already force-released), so a concurrent writer racing in during
      // the gap could get its bytes captured as this step's `after` —
      // making a later undo of this step silently revert the other
      // writer's change. Requires a >15s stalled Write plus a same-file
      // writer landing in that exact window; not yet guarded.
      finishToolUse(toolUseId)
    }, holdTimeoutMs)
    // Never keep the process alive for a watchdog.
    timer.unref?.()
    heldByToolUse.set(toolUseId, { repoRel, timer })
  }

  function finishToolUse(toolUseId: string): void {
    const entry = heldByToolUse.get(toolUseId)
    if (!entry) return
    heldByToolUse.delete(toolUseId)
    if (entry.timer) clearTimeout(entry.timer)
    releasePath(entry.repoRel)
  }

  /**
   * Journal the file's current bytes. Returns ok for a path that doesn't
   * exist yet (a `Write` creating a file has no original to preserve).
   * The ok result also carries the exact bytes read (`before`) — the
   * before-state for history capture reuses this read instead of a second
   * `fs.readFile`, so there's no extra I/O and no second race window
   * between "read for the journal" and "read for the history snapshot".
   *
   * Also carries `backupDir` — the repo-relative directory the original
   * actually landed in, or `undefined` when nothing was written there
   * (the ENOENT/new-file case below never calls `journal` at all — same
   * "no journal write, no backupDir" rule `brokeredWrite` follows, C1 in
   * the round-2 whole-branch review). C2 (same review): this used to be
   * computed and then discarded before reaching the caller, so a primary
   * chat Write/Edit's ledger entry always landed with no recovery path
   * even when a real backup existed on disk for it.
   */
  async function journalOriginal(
    canonicalRoot: string,
    repoRel: string,
  ): Promise<
    | { ok: true; before: HistoryFileState; backupDir: string | undefined }
    | { ok: false; reason: string }
  > {
    let content: Buffer
    try {
      content = await fs.readFile(resolvePath(canonicalRoot, repoRel))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { ok: true, before: { exists: false, content: null }, backupDir: undefined }
      }
      return { ok: false, reason: (err as Error).message }
    }
    const before: HistoryFileState = { exists: true, content }
    const key = `${repoRel}:${createHash('sha256').update(content).digest('hex')}`
    // A dedupe hit means these exact bytes were already backed up earlier
    // in this turn — the backup still exists on disk under that EARLIER
    // call's directory, so report that directory rather than `undefined`
    // (which would read as "nothing was backed up," which is false).
    const cachedBackupDir = journalledKeys.get(key)
    if (cachedBackupDir !== undefined) return { ok: true, before, backupDir: cachedBackupDir }
    // `journal` (usually `writeBackupJournal`) throws
    // `BackupJournalPathEscapeError` for a key that would escape the
    // backup directory, rather than returning `{ ok: false }` — see its
    // doc comment. `repoRel` here already comes from the correctly-
    // implemented `toRepoRelative` above (handles a `..`-prefixed
    // FILENAME like `..fixture.vue` correctly, unlike the sibling bug
    // Task 14 review round-2 found and fixed in `toRel`/edit-ack.ts), so
    // this should be unreachable in practice — caught anyway as
    // defense-in-depth, matching `brokeredWrite`'s equivalent catch: a
    // journal failure denies the write like any other, it must not kill
    // the hook / chat turn with an uncaught exception.
    let result: BackupJournalResult
    try {
      result = await journal(canonicalRoot, [{ file: repoRel, content }])
    } catch (err) {
      if (err instanceof BackupJournalPathEscapeError || err instanceof DesdeDirSymlinkError) {
        return { ok: false, reason: err.message }
      }
      throw err
    }
    if (!result.ok) return { ok: false, reason: result.reason }
    journalledKeys.set(key, result.backupDir)
    return { ok: true, before, backupDir: result.backupDir }
  }

  /** Current on-disk bytes for `absPath`, or `{exists:false}` if absent. */
  async function readFileState(absPath: string): Promise<HistoryFileState> {
    try {
      return { exists: true, content: await fs.readFile(absPath) }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { exists: false, content: null }
      }
      throw err
    }
  }

  function sameFileState(a: HistoryFileState, b: HistoryFileState): boolean {
    if (a.exists !== b.exists) return false
    if (a.content === b.content) return true
    if (a.content === null || b.content === null) return false
    return a.content.equals(b.content)
  }

  const preToolUse: HookCallback = async (input, toolUseID, hookOptions) => {
    if (input.hook_event_name !== 'PreToolUse') return CONTINUE
    const pre = input as PreToolUseHookInput
    if (pre.tool_name !== 'Write' && pre.tool_name !== 'Edit') return CONTINUE
    const filePath = (pre.tool_input as { file_path?: unknown } | undefined)?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return CONTINUE

    const canonicalRoot = await rootReal()
    const repoRel = await toRepoRelative(canonicalRoot, filePath)
    if (repoRel === null) {
      // Escapes the repo — `canUseTool` refuses it; nothing of ours to guard.
      return CONTINUE
    }

    const toolUseId =
      typeof pre.tool_use_id === 'string' && pre.tool_use_id.length > 0
        ? pre.tool_use_id
        : toolUseID

    const hasId = typeof toolUseId === 'string' && toolUseId.length > 0
    const idKey = hasId ? (toolUseId as string) : null

    // 1. Take the lock FIRST so the bytes we journal are the bytes the SDK is
    //    about to overwrite, read from inside the serialized section.
    //
    //    A duplicate PreToolUse delivery for the SAME tool_use must not take a
    //    SECOND refcount — the single terminal event that follows would drop
    //    only one, leaking the rest. Duplicates are caught in BOTH windows:
    //    already-registered (`heldByToolUse`) and still-acquiring
    //    (`acquireInFlight`). Registration happens INSIDE the acquisition
    //    promise, before journaling, so the two windows are contiguous.
    let heldForThisDelivery: 'registered' | 'barrier' | 'none' = 'none'
    if (!opts.acquireWriteLock) {
      noteJournalOnlyMode()
    } else if (idKey && heldByToolUse.has(idKey)) {
      // Already registered by a sibling delivery — it owns the hold.
    } else if (idKey && acquireInFlight.has(idKey)) {
      // Acquisition started by a sibling delivery; wait for it so we still
      // journal under the lock, but don't take a ref of our own.
      await acquireInFlight.get(idKey)!.catch(() => {})
    } else {
      const attempt = (async (): Promise<'registered' | 'barrier' | 'none'> => {
        const acquired = await acquirePathBounded(repoRel, hookOptions?.signal)
        if (!acquired) return 'none'
        if (idKey) {
          registerToolUse(idKey, repoRel)
          return 'registered'
        }
        return 'barrier'
      })()
      if (idKey) acquireInFlight.set(idKey, attempt.catch(() => undefined))
      try {
        heldForThisDelivery = await attempt
      } catch {
        heldForThisDelivery = 'none'
      } finally {
        if (idKey) acquireInFlight.delete(idKey)
      }
    }

    // 2. Journal under the lock.
    let journalOutcome:
      | { ok: true; before: HistoryFileState; backupDir: string | undefined }
      | { ok: false; reason: string }
    try {
      journalOutcome = await journalOriginal(canonicalRoot, repoRel)
    } catch (err) {
      journalOutcome = { ok: false, reason: (err as Error).message }
    }

    if (!journalOutcome.ok) {
      // The write is refused, so nothing of ours may keep holding the file.
      if (heldForThisDelivery === 'registered' && idKey) finishToolUse(idKey)
      else if (heldForThisDelivery === 'barrier') releasePath(repoRel)
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `Editor refused this write: the original of '${repoRel}' could not be backed up to ` +
            `.desde/backups (${journalOutcome.reason}), so the edit would be unrecoverable. ` +
            `Nothing was modified.`,
        },
      }
    }

    // 3. Stash the pre-write snapshot for history, keyed by tool_use_id —
    //    independent of whether a lock hold exists (journal-only callers,
    //    like the edit-fix mini-turn, never register a `ToolUseHold` at
    //    all, but their writes still belong in undo/redo). No `idKey` means
    //    no way to correlate this capture with the terminal event that
    //    will follow, so there is nothing safe to stash. A duplicate
    //    delivery for the same tool_use_id (already captured) is a no-op —
    //    the first delivery's read is the correct "before" for this call.
    if (opts.history && idKey && !historyByToolUse.has(idKey)) {
      historyByToolUse.set(idKey, {
        repoRel,
        absPath: resolvePath(canonicalRoot, repoRel),
        before: journalOutcome.before,
        toolName: pre.tool_name,
        backupDir: journalOutcome.backupDir,
      })
    }

    if (heldForThisDelivery === 'barrier') {
      // No correlation id — degrade to the brief's barrier semantics
      // (blocked until concurrent edits to this file finished, journalled,
      // then released) rather than holding something we can never match.
      warn(
        `[editor-sdk] PreToolUse for '${repoRel}' carried no tool_use_id — ` +
          `releasing the edit lock immediately (barrier semantics).`,
      )
      releasePath(repoRel)
    }
    return CONTINUE
  }

  /**
   * Hand `snapshot` + its already-read `after` state off to the history
   * recorder, fire-and-forget. The FILE READ that produces `after` must
   * happen before the per-file lock is released (see the call site in
   * `release`) — only the write to the history STORE is safe to leave
   * unawaited here, and a recorder failure must never propagate: undo/redo
   * coverage is an affordance layered on top of an already-durable write,
   * exactly the non-fatal contract `brokeredWrite` uses for the same
   * `history.record` call (write-broker.ts).
   */
  function recordHistoryStep(snapshot: HistorySnapshot, after: HistoryFileState): void {
    // `HistoryRecorder.record` is typed `void | Promise<void>` (a test
    // double may not return a promise) — wrap in `Promise.resolve` so
    // `.catch` is always valid regardless of which shape this call returns.
    void Promise.resolve(
      opts.history!.record({
        label: `AI edit: ${snapshot.repoRel}`,
        files: [
          {
            repoRel: snapshot.repoRel,
            absPath: snapshot.absPath,
            before: snapshot.before,
            after,
          },
        ],
      }),
    ).catch((err: unknown) => {
      warn(
        `[editor-sdk] history.record failed for '${snapshot.repoRel}' (undo/redo step lost): ` +
          `${(err as Error).message}`,
      )
    })
  }

  /**
   * P1-1 — the edit-ledger entry for a successful built-in Write/Edit.
   *
   * AWAITED by its call site — this is the one place this file
   * deliberately does NOT mirror {@link recordHistoryStep}'s
   * fire-and-forget shape immediately above. It mirrors `brokeredWrite`'s
   * own ledger append instead (write-broker.ts), which the ledger design
   * doc calls out as the discipline to match exactly: awaited by its
   * caller, but internally non-throwing — never fatal, never blocking the
   * write itself (the write already landed; this only delays how soon
   * `release` returns). `history.record` is a genuinely separate
   * affordance layered ON TOP of a write that's already durable either
   * way, which is why fire-and-forget is right for it; the ledger append
   * doesn't have anything left to be "on top of" once it stops being
   * awaited — a detached ledger write can still be in flight after its
   * caller believes the turn is done (measured: this raced a test's
   * `afterEach` tmpdir cleanup — a real ENOTEMPTY, not a hypothetical).
   *
   * `afterHashes`: `brokeredWrite` hashes the bytes it is ABOUT to write;
   * here the SDK already wrote the file, so this hashes `after` — the
   * exact post-write bytes `release` already read to decide whether to
   * record an undo/redo step (no second `fs.readFile`). If `after.content`
   * is absent (a delete, or the earlier read failed) this degrades to NO
   * hash for that file rather than a wrong one — Plan B's Undo already
   * refuses an entry with a missing hash, which is the safe direction; a
   * wrong hash is not.
   */
  async function recordLedgerEntry(
    snapshot: HistorySnapshot,
    after: HistoryFileState,
    toolName: string,
  ): Promise<void> {
    try {
      const canonicalRoot = await rootReal()
      const afterHashes: Record<string, string> =
        after.exists && after.content
          ? { [snapshot.repoRel]: hashContent(after.content) }
          : {}
      await appendLedgerEntry(canonicalRoot, {
        type: 'edit',
        id: randomUUID(),
        at: new Date().toISOString(),
        branch: await resolveBranchCached(canonicalRoot),
        kind: toolName === 'Edit' ? 'edit' : 'write',
        lane: 'chat',
        files: [snapshot.repoRel],
        // C2 (round-2 whole-branch review finding, 2026-08-19): carried
        // through from `journalOriginal` via the snapshot rather than
        // discarded — see `HistorySnapshot.backupDir`'s doc comment.
        // `undefined` for a brand-new file, matching C1's rule that an
        // empty journal must not advertise a backup directory that was
        // never created.
        ...(snapshot.backupDir !== undefined ? { backupDir: snapshot.backupDir } : {}),
        // P2-1 (codex review round 6, 2026-08-20): `snapshot.before.exists
        // === false` is this function's own proof that the SDK's
        // Write/Edit tool created `snapshot.repoRel` — `journalOriginal`
        // (above) only reaches that state via an ENOENT read, and never
        // wrote a backup for it (see `HistorySnapshot.backupDir`'s doc
        // comment). Before this fix that fact was known here and thrown
        // away: the entry carried neither `backupDir` nor `createdFiles`,
        // so Plan B's Undo planner (`undo-entry.ts`) — correctly, given
        // no other signal — classified it `unbacked` and refused Undo for
        // a case that is actually provably safe (delete an unchanged
        // created file). Recording it costs no extra I/O; the fact is
        // already sitting in `snapshot.before`.
        ...(!snapshot.before.exists ? { createdFiles: [snapshot.repoRel] } : {}),
        afterHashes,
      })
    } catch (err) {
      warn(
        `[editor-sdk] edit-ledger append failed for '${snapshot.repoRel}' (entry lost): ` +
          `${(err as Error).message}`,
      )
    }
  }

  const release: HookCallback = async (input, toolUseID) => {
    const raw = (input as { tool_use_id?: unknown }).tool_use_id
    const toolUseId = typeof raw === 'string' && raw.length > 0 ? raw : toolUseID
    if (typeof toolUseId === 'string' && toolUseId.length > 0) {
      // `release` is registered for THREE terminal events — PostToolUse
      // (success), PostToolUseFailure and PermissionDenied (both "the
      // write never landed") — via three separate hook-array entries in
      // run-chat-turn-sdk.ts that all point at this same callback.
      // `hook_event_name` is the SDK's own tag for which one delivered
      // this call, so it's the reliable discriminator (not, say, presence
      // of a `tool_response` field, which `PostToolUse` always carries —
      // see `PostToolUseHookInput` in sdk.d.ts — even when the tool's own
      // result payload signals an application-level failure). ONLY the
      // success event may record a step; a failed or denied call must
      // record nothing, and `releaseAll`/the watchdog never call this
      // hook at all (they call `finishToolUse` directly), so they can't
      // record by construction either.
      const snapshot = historyByToolUse.get(toolUseId)
      if (snapshot) historyByToolUse.delete(toolUseId)

      // Read the post-write bytes — WHILE STILL HOLDING THE LOCK, i.e.
      // BEFORE `finishToolUse` below releases it. `finishToolUse` is what
      // actually drops the per-file mutex (via `releasePath`); reading
      // "after" first closes a window where a concurrent writer to the
      // SAME path could land the instant the lock frees and get captured
      // as THIS step's "after" — a later `undo` would then silently revert
      // the other lane's edit too. Only the write to the history STORE
      // (`recordHistoryStep`, below) is fire-and-forget; the read that
      // decides whether there's anything to record must be awaited here.
      let after: HistoryFileState | undefined
      if (snapshot && opts.history && input.hook_event_name === 'PostToolUse') {
        try {
          after = await readFileState(snapshot.absPath)
        } catch (err) {
          warn(
            `[editor-sdk] could not read post-write state for '${snapshot.repoRel}' — history ` +
              `step lost: ${(err as Error).message}`,
          )
        }
      }

      // A1 (round-2 whole-branch review finding, 2026-08-19): the ledger
      // append must happen BEFORE `finishToolUse` below releases the
      // per-file mutex and — via `settleRelease`'s chained release of the
      // injected `acquireWriteLock` — the repo's SHARED tree gate
      // (`withFileEditLocks` in session-lock.ts). `withTreeLock` (Commit,
      // Publish, branch switch/create/rename) is what serializes ledger
      // order against `git add -A`'s view of the working tree; releasing
      // the gate before this append lets a Commit that was WAITING on it
      // run to completion — including appending ITS OWN commit marker —
      // while this write's bytes are already on disk (the SDK's own tool
      // call wrote them before this hook ever ran) but its `edit` line
      // hasn't landed yet. The commit line then precedes the edit line in
      // the append-only log, and `resolveCommitState` reads the log in
      // order: an edit line arriving after the commit that actually
      // covered it reads as uncommitted forever. Recording first, and
      // only THEN releasing the gate, is what keeps ledger order matching
      // git reality.
      if (snapshot && after && !sameFileState(snapshot.before, after)) {
        recordHistoryStep(snapshot, after)
        await recordLedgerEntry(snapshot, after, snapshot.toolName)
      }

      finishToolUse(toolUseId)
    }
    return CONTINUE
  }

  function releaseAll(reason: string): void {
    if (heldByToolUse.size > 0) {
      warn(
        `[editor-sdk] releasing ${heldByToolUse.size} un-matched SDK write lock(s) at ${reason}: ` +
          `${[...heldByToolUse.values()].map((h) => h.repoRel).join(', ')}`,
      )
    }
    for (const toolUseId of [...heldByToolUse.keys()]) finishToolUse(toolUseId)
    // Defense in depth: a hold whose tool_use registration never happened
    // (acquire resolved after a releaseAll, an unexpected refcount) must not
    // survive the turn either.
    for (const [repoRel, hold] of [...heldByPath.entries()]) {
      heldByPath.delete(repoRel)
      settleRelease(hold)
    }
    // Any pending history snapshot is for a tool_use that never reached a
    // release event of its own (turn crash/abort — the one case the brief
    // calls out explicitly: "releaseAll (turn-end sweep) records
    // nothing"). Drop it rather than leak it — nothing ever calls
    // `recordHistoryStep` for it, since only `release`'s PostToolUse branch
    // does that.
    historyByToolUse.clear()
  }

  return {
    preToolUse,
    release,
    releaseAll,
    heldPathsForTests: () => [...heldByPath.keys()],
  }
}

/**
 * Repo-relative POSIX path for `filePath`, or null when it escapes
 * `canonicalRoot`. Follows symlinks on the file first because the SDK's Write
 * follows them transparently — locking/journaling the link path alone would
 * miss the real target. Mirrors `write-invalidate-hook.ts`'s resolver.
 */
async function toRepoRelative(
  canonicalRoot: string,
  filePath: string,
): Promise<string | null> {
  const abs = isAbsolute(filePath) ? filePath : resolvePath(canonicalRoot, filePath)
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    real = abs
  }
  const rel = relativePath(canonicalRoot, real)
  // `isRootEscape` (shared with `edit-ack.ts`'s `toRel`) checks BOTH
  // separator forms explicitly — this used to be a hardcoded POSIX
  // `'../'` literal only, which on Windows never matches
  // `path.relative`'s native `\`-separated output, so an actual escape
  // (`..\\outside.txt`) slipped through as "in-root" (Task 14 review
  // round-3 P2: `journalOriginal` would then READ the out-of-root file —
  // an info-leak — before some LATER containment check denied it, the
  // wrong layer catching it too late).
  if (rel === '' || isRootEscape(rel) || isAbsolute(rel)) {
    return null
  }
  return rel.split('\\').join('/')
}
