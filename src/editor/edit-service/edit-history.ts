/**
 * In-memory undo/redo stack over `brokeredWrite` restores (Task 1 of the
 * toolbar undo/redo plan — see
 * `.superpowers/sdd/2026-08-05-toolbar-undo-redo/`).
 *
 * `EditorEditHistory` does not own any filesystem state itself: each
 * `RecordedStep` captures the before/after bytes of every file an edit
 * touched, and `undo`/`redo` restore one side or the other through
 * `brokeredWrite` — the same journal → locked-write → invalidate path
 * every other Editor mutation goes through. That gives undo/redo the
 * same safety properties as a live edit: a backup journal entry for every
 * restored byte, per-file write locks, and atomic all-or-nothing rollback
 * if a multi-file step partially fails.
 *
 * Refusal is checked BEFORE any op is built: `applyTop` reads the current
 * on-disk state of every file in the step and compares it against the
 * expected pre-restore state first. If any file has drifted since the
 * step was recorded, the whole step refuses without touching a single
 * file — never a partial undo.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { brokeredWrite, type BrokerOp } from '../agent-chat-sdk/write-broker'
import type { BackupEntry } from '../agent-chat-sdk/backup-journal'
import type { FileLockManager } from './file-lock-manager'

export const MAX_HISTORY_STEPS = 50

/**
 * Memory budget across BOTH stacks combined, in bytes (undo/redo
 * follow-ups Task 2). Each step's cost is the sum of its files'
 * `before.content`/`after.content` byte lengths, computed once at
 * `record()` time and cached on the step — `enforceBudget()` sums the
 * cached numbers on every pass instead of re-measuring buffers.
 */
export const MAX_HISTORY_BYTES = 20 * 1024 * 1024

/** Snapshot of one file's content at a point in time (or its absence). */
export interface HistoryFileState {
  exists: boolean
  content: Buffer | null
}

/** One file's before/after states within a recorded step. */
export interface RecordedFile {
  /** Repo-relative path — journal key, invalidate key, error label. */
  repoRel: string
  /** Absolute path on disk. */
  absPath: string
  before: HistoryFileState
  after: HistoryFileState
}

/** A single undoable unit of work — one or more file mutations. */
export interface RecordedStep {
  label: string
  files: RecordedFile[]
}

/** Public undo/redo affordance state for the toolbar. */
export interface EditHistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export type HistoryActionResult =
  | { ok: true; files: string[]; state: EditHistoryState }
  | {
      ok: false
      reason: string
      state: EditHistoryState
      /**
       * True when the refusal means this step can never be applied again
       * from the current on-disk state (byte-mismatch, an unreadable
       * target, or the broker's atomic precondition losing the same race) —
       * the step is stuck at the top of its stack, blocking every future
       * undo/redo until it's cleared. NOT set for the transient/no-op
       * refusals (empty stack, `expectedTopId` race): those resolve on
       * their own with no action needed. Callers use this to offer a
       * "Discard step" affordance (`discardTop`) instead of leaving the
       * user stuck retrying an action that will refuse forever.
       */
      stranded?: boolean
      /**
       * The id of the step that refused, set alongside `stranded: true`.
       * Callers pass this back as `discardTop`'s `expectedTopId` so the
       * discard targets the SAME step the refusal was about — without it,
       * a second stale "Discard step" click (e.g. a background tab that
       * observed the same stranded step before it was discarded elsewhere)
       * would blindly pop whatever is on top now, which could be a
       * different, perfectly valid step it never saw.
       */
      stepId?: string
    }

/**
 * Internal: a recorded step plus the id used for optimistic-concurrency
 * checks and the byte cost computed once at record time (Task 2).
 */
type HistoryStep = RecordedStep & { id: string; bytes: number }

interface ApplyTopOptions {
  canonicalRoot: string
  expectedTopId?: string
  /**
   * Defaults to the process-wide shared manager (via `brokeredWrite`).
   * Injected by tests — mirrors `BrokeredWriteOptions.lockManager`, the
   * same test seam `write-broker.test.ts` uses to observe/hook lock
   * acquisition.
   */
  lockManager?: FileLockManager
}

export class EditorEditHistory {
  private undoStack: HistoryStep[] = []
  private redoStack: HistoryStep[] = []
  // Serializes record/undo/redo. Safe against the broker because the
  // broker only awaits record() AFTER its file-lock window unwinds.
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * `maxBytes` defaults to `MAX_HISTORY_BYTES`; the constructor param
   * exists so tests can exercise eviction without allocating real
   * megabyte-scale buffers.
   */
  constructor(private readonly maxBytes: number = MAX_HISTORY_BYTES) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  record(step: RecordedStep): Promise<void> {
    return this.run(async () => {
      // Skip pure no-ops (before === after for every file).
      if (step.files.every((f) => sameState(f.before, f.after))) return
      this.undoStack.push({ ...step, id: randomUUID(), bytes: stepBytes(step) })
      // Clear the redo stack BEFORE enforcing the budget: any step parked
      // there is invalidated by this very record() call (its bytes are
      // freed on the next line no matter what), so it can never justify
      // evicting real, still-reachable undo history to make room for it.
      // The budget only protects memory that stays live after this call.
      this.redoStack = []
      this.enforceBudget()
      if (this.undoStack.length > MAX_HISTORY_STEPS) this.undoStack.shift()
    })
  }

  /**
   * While the combined byte cost of both stacks exceeds `maxBytes` and
   * more than one step exists overall, evict the oldest step — undo-stack
   * bottom first (all but its own newest entry), then redo-stack bottom.
   * The just-pushed newest step is never evicted, even alone over budget.
   */
  private enforceBudget(): void {
    while (
      this.undoStack.length + this.redoStack.length > 1 &&
      this.totalBytes() > this.maxBytes
    ) {
      if (this.undoStack.length > 1) this.undoStack.shift()
      // Unreachable from the sole call site today: record() clears
      // redoStack immediately before calling enforceBudget(), so it's
      // always empty here. Kept per the spec's stated eviction order
      // (undo-bottom, then redo-bottom) in case enforceBudget() ever
      // gains another caller where redo genuinely still holds live steps.
      else if (this.redoStack.length > 0) this.redoStack.shift()
      else break // only the single newest step remains; nothing left to evict
    }
  }

  private totalBytes(): number {
    let total = 0
    for (const s of this.undoStack) total += s.bytes
    for (const s of this.redoStack) total += s.bytes
    return total
  }

  /**
   * Empties both stacks. Routed through the same `run` queue as
   * record/undo/redo so it serializes with any in-flight call instead of
   * racing it.
   *
   * Call this after any operation that changes what's checked out (branch
   * switch/create, publish, merge-push) — the history's before/after bytes
   * are recorded against ONE branch's tree. A step recorded on branch A
   * whose after-state happens to byte-match branch B's checked-out tree
   * (e.g. right after A was committed and B was just created from that
   * same commit) would otherwise pass `applyTop`'s byte-verify check and
   * silently apply A's before-bytes onto B — the byte guard verifies file
   * contents, not branch identity, so a checkout change is the one thing
   * it can't catch on its own.
   */
  clear(): Promise<void> {
    return this.run(async () => {
      this.undoStack = []
      this.redoStack = []
    })
  }

  undo(opts: ApplyTopOptions): Promise<HistoryActionResult> {
    return this.applyTop('undo', opts)
  }
  redo(opts: ApplyTopOptions): Promise<HistoryActionResult> {
    return this.applyTop('redo', opts)
  }

  private applyTop(
    direction: 'undo' | 'redo',
    opts: ApplyTopOptions,
  ): Promise<HistoryActionResult> {
    return this.run(async () => {
      const [from, to] =
        direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack]
      const step = from[from.length - 1]
      if (!step) return { ok: false, reason: `Nothing to ${direction}.`, state: this.stateUnsafe() }
      if (opts.expectedTopId && step.id !== opts.expectedTopId)
        return { ok: false, reason: 'History changed. Try again.', state: this.stateUnsafe() }

      // undo: expect after on disk, restore before. redo: the inverse.
      const journal: BackupEntry[] = []
      const ops: BrokerOp[] = []
      // Same expected states the pre-read loop below verifies, carried
      // forward as `brokeredWrite` preconditions so the byte-verify is
      // ATOMIC with the restore (undo/redo follow-ups Task 1). Without
      // this, a concurrent writer with no outer lock on this step (an SDK
      // structural tool from another chat session — it doesn't hold the
      // CLI's outer file-edit locks) can land in the gap between this
      // pre-read and the broker's own lock acquisition: the read below
      // sees the expected bytes, the writer lands right after, and the
      // broker would otherwise restore over it none the wiser. The
      // pre-read stays (it gives a fast, lock-free refusal for the common
      // "nothing changed" and "already stale" cases); this closes what it
      // can't: the TOCTOU window between the read and the lock.
      const preconditions: { repoRel: string; absPath: string; expect: HistoryFileState }[] = []
      for (const f of step.files) {
        const expect = direction === 'undo' ? f.after : f.before
        const restore = direction === 'undo' ? f.before : f.after
        let current: HistoryFileState
        try {
          current = await readState(f.absPath)
        } catch (err) {
          // A non-ENOENT read failure (EISDIR, EACCES, …) is an honest
          // refusal, not a 500 — and critically, it must still return
          // through the normal refusal path so the step stays on `from`
          // instead of being lost to an uncaught throw (which would jam
          // the stack: the step never pops, but it's also no longer safely
          // undoable/redoable via the UI).
          const message = err instanceof Error ? err.message : String(err)
          return {
            ok: false,
            reason: `'${f.repoRel}' could not be read (${message}): ${direction} unavailable.`,
            state: this.stateUnsafe(),
            stranded: true,
            stepId: step.id,
          }
        }
        if (!sameState(current, expect))
          return {
            ok: false,
            reason: `'${f.repoRel}' changed on disk since this edit: ${direction} unavailable. Use the Activity panel to discard the file instead.`,
            state: this.stateUnsafe(),
            stranded: true,
            stepId: step.id,
          }
        preconditions.push({ repoRel: f.repoRel, absPath: f.absPath, expect })
        if (sameState(current, restore)) continue
        if (restore.exists && current.exists) {
          journal.push({ file: f.repoRel, content: current.content! })
          ops.push({ kind: 'write', repoRel: f.repoRel, absPath: f.absPath, content: restore.content! })
        } else if (restore.exists) {
          ops.push({
            kind: 'write',
            repoRel: f.repoRel,
            absPath: f.absPath,
            content: restore.content!,
            isNew: true,
            ensureDir: true,
          })
        } else {
          journal.push({ file: f.repoRel, content: current.content! })
          ops.push({ kind: 'delete', repoRel: f.repoRel, absPath: f.absPath })
        }
      }
      if (ops.length > 0) {
        const res = await brokeredWrite({
          canonicalRoot: opts.canonicalRoot,
          journal,
          ops,
          preconditions,
          lockManager: opts.lockManager,
          describe: {
            // `direction` is 'undo' | 'redo' — both are real ledger kinds.
            kind: direction,
            lane: 'undo',
            fields: { step: step.label },
          },
        })
        if (!res.ok) {
          // A precondition loss is the TOCTOU this task closes: the
          // pre-read above saw the expected bytes, but a concurrent
          // writer won the race before the broker's lock acquisition.
          // Same refusal wording as the pre-read's own drift check above
          // — from the user's perspective it's the identical situation
          // ("the file changed since this edit was recorded"), just
          // caught at the later, atomic checkpoint instead of the earlier
          // racy one.
          if (res.stage === 'precondition')
            return {
              ok: false,
              reason: `'${res.repoRel}' changed on disk since this edit: ${direction} unavailable. Use the Activity panel to discard the file instead.`,
              state: this.stateUnsafe(),
              stranded: true,
              stepId: step.id,
            }
          return {
            ok: false,
            reason:
              res.stage === 'backup' || res.stage === 'refused'
                ? res.reason
                : `Could not ${direction} '${res.repoRel}': ${res.reason}`,
            state: this.stateUnsafe(),
          }
        }
      }
      from.pop()
      to.push(step)
      return { ok: true, files: step.files.map((f) => f.repoRel), state: this.stateUnsafe() }
    })
  }

  /**
   * Pops the top step off `direction`'s stack WITHOUT applying it — the
   * discard-stranded-step affordance (undo/redo follow-ups Task 3). Unlike
   * `undo`/`redo`, this never touches disk and never moves the step to the
   * opposite stack: discarding from `undo` does not push to redo, because
   * the whole point is that the step is unusable and should simply be
   * gone. Routed through the same `run` queue as every other mutation so
   * it serializes with an in-flight undo/redo/record.
   *
   * Refuses (like `applyTop`) on an empty stack or an `expectedTopId`
   * mismatch — neither refusal sets `stranded`, since both are transient:
   * an empty stack has nothing to discard, and an id mismatch means
   * another request already changed the stack out from under this one.
   */
  discardTop(direction: 'undo' | 'redo', expectedTopId?: string): Promise<HistoryActionResult> {
    return this.run(async () => {
      const stack = direction === 'undo' ? this.undoStack : this.redoStack
      const step = stack[stack.length - 1]
      if (!step) return { ok: false, reason: `Nothing to ${direction}.`, state: this.stateUnsafe() }
      if (expectedTopId && step.id !== expectedTopId)
        return { ok: false, reason: 'History changed. Try again.', state: this.stateUnsafe() }
      stack.pop()
      return { ok: true, files: step.files.map((f) => f.repoRel), state: this.stateUnsafe() }
    })
  }

  /** Synchronous read of the current undo/redo affordance state. */
  state(): EditHistoryState {
    return this.stateUnsafe()
  }

  // Same body as `state()` — named separately so call sites inside `run`
  // (already serialized behind `this.chain`) read as internal, not a
  // second public entry point.
  private stateUnsafe(): EditHistoryState {
    const top = (stack: HistoryStep[]) => stack[stack.length - 1] ?? null
    const undoTop = top(this.undoStack)
    const redoTop = top(this.redoStack)
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: undoTop ? undoTop.label : null,
      redoLabel: redoTop ? redoTop.label : null,
    }
  }

  /** Peek at the top of a stack without mutating it. */
  peek(direction: 'undo' | 'redo'): { id: string; files: string[] } | null {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack
    const top = stack[stack.length - 1]
    if (!top) return null
    return { id: top.id, files: top.files.map((f) => f.repoRel) }
  }
}

/** Sum of before/after content byte lengths across every file in a step. */
function stepBytes(step: RecordedStep): number {
  let total = 0
  for (const f of step.files) {
    if (f.before.content) total += f.before.content.byteLength
    if (f.after.content) total += f.after.content.byteLength
  }
  return total
}

function sameState(a: HistoryFileState, b: HistoryFileState): boolean {
  if (a.exists !== b.exists) return false
  return !a.exists || a.content!.equals(b.content!)
}

async function readState(absPath: string): Promise<HistoryFileState> {
  try {
    return { exists: true, content: await readFile(absPath) }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { exists: false, content: null }
    throw err
  }
}

let shared: EditorEditHistory | undefined
export function getSharedEditHistory(): EditorEditHistory {
  return (shared ??= new EditorEditHistory())
}
export function resetSharedEditHistoryForTests(): void {
  shared = undefined
}
