/**
 * Serialization primitives for edit/save/discard/tree writes in the CLI.
 *
 * Branch mode (the only edit substrate — see `tasks/branches-vs-worktree.md`)
 * has no per-session worktree, so every chat session and every direct edit
 * writes the SAME working tree. Overlapping writes to the same file (rapid
 * text/style timers, or a chat edit racing a direct edit) would reintroduce
 * last-writer-wins file corruption (codex review, branch mode), and a git
 * tree operation (commit / publish / branch switch) interleaved with an
 * in-flight edit would capture or clobber a half-written tree.
 *
 * The module therefore owns two tiny, CLI-local locks:
 *
 * 1. `withCliSessionLock(key, op)` — a single promise chain per key. The
 *    original primitive; still the building block for per-file mutexes.
 *
 * 2. A per-repo **reader-writer gate** on top of it (Task 11):
 *      - FILE-scoped ops (`withFileEditLocks`) take the gate SHARED and then
 *        the per-file mutex(es) for the files they touch. Two edits to
 *        DIFFERENT files run concurrently — so one slow LLM-lane edit (up to
 *        a 90s mini-turn) no longer blocks an instant deterministic edit on
 *        an unrelated file. Two edits to the SAME file still serialize.
 *      - TREE-scoped ops (`withTreeLock`) — commit, publish, push, branch
 *        switch/create/rename — take the gate EXCLUSIVE: they wait for every
 *        in-flight file edit to finish and block new ones until they're done.
 *
 * Fairness: a pending exclusive blocks NEW shared acquisitions, so a steady
 * stream of edits can't starve a commit. The mirror case is NOT guarded and
 * that's deliberate: a back-to-back stream of tree ops would keep parked
 * edits waiting, because each release hands the gate to the next queued
 * writer before draining readers. Accepted — tree ops are user-button-driven
 * (Commit / Publish / Push / Branch switch), one at a time, seconds apart, so
 * "sustained writer pressure" isn't a shape this server sees. If they ever
 * become automatic (e.g. autocommit-on-idle), revisit with a batch/ticket
 * scheme rather than widening the reader fast path.
 *
 * Shared holders never wait on an
 * exclusive holder (they only ever wait to *enter*), so the two classes
 * can't deadlock. Multi-file ops acquire their per-file mutexes in a sorted
 * total order, so two overlapping batches over {A,B} and {B,A} can't
 * deadlock either — that's why `withFileEditLocks` takes the whole path list
 * rather than leaving callers to nest acquisitions by hand.
 *
 * Scope note: this is a per-PROCESS lock. It orders the CLI's own lanes; it
 * is not an OS-level advisory lock against a second CLI or the user's own
 * `git` in a terminal. The deeper `FileLockManager`
 * (`src/editor/edit-service/file-lock-manager.ts`) still guards the actual
 * write syscalls and remains authoritative for path identity (it realpaths);
 * the keys here are a coarser routing namespace — see `normalizeLockPath`.
 *
 * (Historical note: an earlier worktree-session-mode version of this lock
 * coordinated with a since-deleted `session-registry.ts` in the web app,
 * which no longer exists — worktree-session mode was fully removed
 * 2026-07-21, see `tasks/worktree-mode-decommission.md`.)
 */

import * as path from "node:path"

interface QueueEntry {
  tail: Promise<unknown>
}

const queues = new Map<string, QueueEntry>()

/**
 * Run `op` serialized against any in-flight op for the same key. The
 * queue tail tolerates rejection so a failed Save doesn't permanently
 * block Discard (and vice versa).
 */
export async function withCliSessionLock<T>(
  sessionId: string,
  op: () => Promise<T>,
): Promise<T> {
  const existing = queues.get(sessionId)
  const previous = existing?.tail ?? Promise.resolve()
  const next = previous.then(
    () => op(),
    () => op(),
  )
  const entry: QueueEntry = {
    tail: next.then(
      () => undefined,
      () => undefined,
    ),
  }
  queues.set(sessionId, entry)
  try {
    return await next
  } finally {
    // GC the queue entry if no further ops have chained off it. A
    // newer op would have replaced `queues.get(sessionId)` already, so
    // identity-compare before deleting.
    if (queues.get(sessionId) === entry) {
      queues.delete(sessionId)
    }
  }
}

// ---------------------------------------------------------------------------
// Lock-key derivation
// ---------------------------------------------------------------------------

const toPosix = (s: string): string => s.replace(/\\/g, "/")

/**
 * Absolute after separator conversion: a POSIX root (`/…`), a UNC share
 * (`\\server\share\…` → `//server/share/…`, which is `/`-leading), or a
 * win32 drive-letter root (`C:\…` / `C:/…`).
 *
 * `path.posix.isAbsolute` alone says FALSE for `C:/repo` — that was the
 * codex round-3 P2: a drive-letter absolute got joined UNDER the root and
 * keyed differently from the relative spelling of the same file, so on
 * Windows the two didn't serialize.
 */
function isAbsoluteLockPath(posixPath: string): boolean {
  return posixPath.startsWith("/") || /^[A-Za-z]:\//.test(posixPath)
}

/**
 * Casing policy for drive letters: UPPER-CASE them, on both the root and the
 * candidate, so `c:/repo/App.vue` and `C:/repo/App.vue` share a key. Only the
 * drive letter is folded — the rest of the path keeps its case. Windows
 * filesystems are case-insensitive throughout, so two case variants of the
 * REST of a path still take different keys; that's the same documented
 * residual (see the class of "spellings that survive normalization" below),
 * and folding whole paths would over-collapse genuinely distinct files on
 * case-sensitive filesystems.
 */
function canonicalizeDrive(posixPath: string): string {
  return posixPath.replace(/^([A-Za-z]):\//, (_m, d: string) => `${d.toUpperCase()}:/`)
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p
}

/**
 * Canonical form of the repo root, shared by every key derived below so the
 * file keys, the tree-gate key and the git-index key all agree.
 *
 * Pure string math for an already-absolute root — which is what production
 * always passes (`ctx.repoRoot`) and what keeps this testable cross-platform
 * (a `C:/…` root can be exercised from macOS). Only a RELATIVE root falls
 * back to the platform's `path.resolve`, which is the one place where
 * behavior is legitimately host-dependent.
 */
function normalizeRootPath(repoRoot: string): string {
  const raw = toPosix(repoRoot)
  const abs = isAbsoluteLockPath(raw) ? raw : toPosix(path.resolve(repoRoot))
  return stripTrailingSlash(canonicalizeDrive(path.posix.normalize(abs)))
}

/**
 * Normalize a request-supplied file path into a stable lock-key segment.
 *
 * DELIBERATELY LIGHTWEIGHT — string math only, no `fs.realpath`, no `stat`.
 * The route layer derives lock keys BEFORE `applyEdit` runs (that's the whole
 * point: the lock has to be held across the applicator), and doing filesystem
 * I/O per request just to name a mutex would put an `await` on the hot path
 * for every edit and could itself throw on a missing file.
 *
 * Consequence — and this is the residual risk, recorded rather than hidden:
 * the key namespace is COARSER than the final resolved path. Two spellings of
 * the same physical file that survive this normalization (e.g. a symlink and
 * its target, or two case variants on a case-insensitive filesystem) map to
 * different keys and would NOT serialize against each other at this layer.
 * Mitigations:
 *   - We collapse every cheap divergence here by resolving the input the SAME
 *     way `applyEdit` does — `path.resolve(root, file)` — and then converting
 *     back to a repo-relative key. So `src/App.vue`, `./src/App.vue`,
 *     `src\App.vue`, `src/x/../App.vue`, `<root>/src/App.vue`, a crafted
 *     `../<rootBasename>/src/App.vue` that *re-enters* the root, and (on
 *     win32) `C:\repo\src\App.vue` / `c:/repo/src/App.vue` all collapse to
 *     one key. (codex P2, batch 4: the `..`-re-entering spelling — which
 *     `applyEdit` accepts — previously kept its literal form and took a
 *     DIFFERENT key from the plain spelling, so two concurrent edits to one
 *     file both read stale contents and only serialized at the final
 *     `FileLockManager` write: a lost update. codex round 3: same defect for
 *     drive-letter absolutes, which `path.posix.isAbsolute` calls relative.)
 *   - A path that resolves OUTSIDE the root keeps its resolved absolute form.
 *     Key coarseness there is moot — `applyEdit` refuses it.
 *   - UNC paths (`\\server\share\…`) become `//server/share/…`, which is
 *     `/`-leading and so takes the absolute branch. `path.posix.normalize`
 *     folds the doubled leading slash to one, but it does so for the ROOT and
 *     the CANDIDATE alike, so containment and key equality are unaffected.
 *     (A `//server/share/x` vs `/server/share/x` collision is theoretical
 *     only — the latter isn't a reachable spelling of a UNC file.)
 *   - `applyEdit`'s own guards stay authoritative for correctness: it
 *     realpaths the candidate, re-checks containment and extension after
 *     symlink resolution, and the write itself goes through
 *     `FileLockManager.withWriteLock`, which keys on the REAL path. So the
 *     worst case for a divergent spelling is losing the outer (coarse)
 *     serialization while the inner write lock still prevents interleaved
 *     writes to the same bytes.
 */
export function normalizeLockPath(repoRoot: string, filePath: string): string {
  const root = normalizeRootPath(repoRoot)
  const raw = canonicalizeDrive(toPosix(filePath))
  // Resolve relative inputs against the ROOT, not the process cwd — that's
  // what `applyEdit` (`path.resolve(rootReal, file)`) and
  // `resolveAndReadEditableFile` do, so the key namespace tracks the paths
  // they will actually open. This is what collapses `..`-re-entering
  // spellings onto the plain one.
  const absolute = isAbsoluteLockPath(raw)
    ? path.posix.normalize(raw)
    : path.posix.normalize(path.posix.join(root, raw))
  const rel = path.posix.relative(root, absolute)
  // Inside the root → the canonical repo-relative key. Escaping (or the root
  // itself, `rel === ''`) → the resolved absolute form.
  //
  // `rel !== ".."` is its own check, separate from `!rel.startsWith("../")`:
  // a bare `".."` (candidate resolves to the root's PARENT exactly) has no
  // trailing `/`, so `startsWith("../")` alone misses it — that's the exact
  // boundary the "escaping" branch below exists for. This is NOT the same
  // bug as a blunt `rel.startsWith("..")` (which would also misclassify a
  // legally-named child like `..fixture.vue`, a real file at the repo
  // root) — `startsWith("../")` already requires the separator, so a
  // `..`-prefixed filename correctly stays in this branch (Task 14 review
  // round-2 P2 audited this function for that class of bug and found this
  // adjacent one instead: the exact `..` case, not a filename prefix).
  if (rel.length > 0 && rel !== ".." && !rel.startsWith("../")) {
    return stripTrailingSlash(rel)
  }
  return stripTrailingSlash(absolute)
}

/** Per-file mutex key. Shared by the edit lane and the discard lane. */
export function fileEditLockKey(repoRoot: string, filePath: string): string {
  return `edit:${normalizeRootPath(repoRoot)}:${normalizeLockPath(repoRoot, filePath)}`
}

/** Per-repo reader-writer gate key. */
function treeGateKey(repoRoot: string): string {
  return `tree:${normalizeRootPath(repoRoot)}`
}

// ---------------------------------------------------------------------------
// Reader-writer gate
// ---------------------------------------------------------------------------

interface TreeGateState {
  /** Shared holders currently inside their critical section. */
  sharedCount: number
  /** True while an exclusive holder is inside its critical section. */
  exclusiveActive: boolean
  /** Resolvers for shared acquisitions parked behind a pending exclusive. */
  sharedWaiters: Array<() => void>
  /** Resolvers for exclusive acquisitions, FIFO. */
  exclusiveWaiters: Array<() => void>
}

const treeGates = new Map<string, TreeGateState>()

function getGate(key: string): TreeGateState {
  let gate = treeGates.get(key)
  if (!gate) {
    gate = {
      sharedCount: 0,
      exclusiveActive: false,
      sharedWaiters: [],
      exclusiveWaiters: [],
    }
    treeGates.set(key, gate)
  }
  return gate
}

function gcGate(key: string, gate: TreeGateState): void {
  if (
    gate.sharedCount === 0 &&
    !gate.exclusiveActive &&
    gate.sharedWaiters.length === 0 &&
    gate.exclusiveWaiters.length === 0 &&
    treeGates.get(key) === gate
  ) {
    treeGates.delete(key)
  }
}

/**
 * Hand the gate to whoever is next, if it's free. Writers first (that's the
 * anti-starvation rule); otherwise release the whole parked reader batch.
 *
 * Ownership is transferred INSIDE this function (`sharedCount++` /
 * `exclusiveActive = true` before resolving) so a waiter can never observe
 * the gate as free and be raced by a newcomer between resolution and the
 * waiter's continuation.
 */
function drainGate(key: string, gate: TreeGateState): void {
  if (gate.exclusiveActive || gate.sharedCount > 0) return
  const nextExclusive = gate.exclusiveWaiters.shift()
  if (nextExclusive) {
    gate.exclusiveActive = true
    nextExclusive()
    return
  }
  while (gate.sharedWaiters.length > 0) {
    gate.sharedCount++
    gate.sharedWaiters.shift()!()
  }
  gcGate(key, gate)
}

async function acquireShared(key: string): Promise<() => void> {
  const gate = getGate(key)
  // A pending OR active exclusive blocks new readers — without the
  // "pending" half, a continuous stream of edits starves a commit forever.
  if (
    !gate.exclusiveActive &&
    gate.exclusiveWaiters.length === 0 &&
    gate.sharedWaiters.length === 0
  ) {
    gate.sharedCount++
  } else {
    await new Promise<void>((resolve) => gate.sharedWaiters.push(resolve))
  }
  let released = false
  return () => {
    if (released) return
    released = true
    gate.sharedCount--
    drainGate(key, gate)
  }
}

async function acquireExclusive(key: string): Promise<() => void> {
  const gate = getGate(key)
  if (
    !gate.exclusiveActive &&
    gate.sharedCount === 0 &&
    gate.exclusiveWaiters.length === 0
  ) {
    gate.exclusiveActive = true
  } else {
    await new Promise<void>((resolve) => gate.exclusiveWaiters.push(resolve))
  }
  let released = false
  return () => {
    if (released) return
    released = true
    gate.exclusiveActive = false
    drainGate(key, gate)
  }
}

/**
 * Run a FILE-scoped op (an edit, a per-file discard) holding:
 *   - the repo's tree gate in SHARED mode, so a commit/publish/branch-switch
 *     can't interleave with it, and
 *   - the per-file mutex for every path it may touch, acquired in a sorted
 *     total order so overlapping multi-file batches (`llm-patch`, `detach`'s
 *     consumer + component pair) can't deadlock against each other.
 *
 * `paths` are request-level spellings; they're normalized + de-duplicated
 * here. An empty list is legal (gate only) but callers that can't derive a
 * target should prefer `withTreeLock` — see `editLockTargets`.
 *
 * Every acquisition is released on throw (try/finally at each level).
 */
export async function withFileEditLocks<T>(
  repoRoot: string,
  paths: readonly string[],
  op: () => Promise<T>,
): Promise<T> {
  const releaseGate = await acquireShared(treeGateKey(repoRoot))
  try {
    const keys = Array.from(
      new Set(paths.map((p) => fileEditLockKey(repoRoot, p))),
    ).sort(compareCodeUnit)
    const run = (i: number): Promise<T> =>
      i >= keys.length ? op() : withCliSessionLock(keys[i], () => run(i + 1))
    return await run(0)
  } finally {
    releaseGate()
  }
}

/**
 * Acquire/release form of {@link withFileEditLocks} for ONE file (Task 13).
 *
 * The scoped form can't serve the SDK chat lane: the Agent SDK executes its
 * built-in `Write`/`Edit` inside its own runtime, so Editor's only
 * bracketing points are two separate hook callbacks (`PreToolUse` →
 * `PostToolUse`). This returns the release function instead of running a
 * callback, so the acquisition can span them. It is otherwise the SAME
 * acquisition — tree gate SHARED plus the per-file mutex, in the same key
 * namespace — so a chat write and a `/api/editor/edit` write to the same
 * file serialize against each other.
 *
 * The caller MUST release. `createSdkWriteGuard`
 * (src/editor/agent-chat-sdk/sdk-write-guard.ts) releases on
 * PostToolUse/PostToolUseFailure/PermissionDenied, on a watchdog timeout, and
 * on a turn-end sweep. A leaked hold blocks every later edit to that file for
 * the life of the process — which is why the guard has three independent
 * release paths rather than one.
 *
 * Do NOT call this from a context that already holds the tree gate
 * EXCLUSIVELY (`withTreeLock`): the shared acquisition inside would wait on
 * the exclusive holder that is itself.
 */
export async function acquireFileEditLock(
  repoRoot: string,
  filePath: string,
): Promise<() => void> {
  return new Promise<() => void>((resolveAcquired, rejectAcquired) => {
    let signalRelease!: () => void
    const heldUntilReleased = new Promise<void>((r) => {
      signalRelease = r
    })
    let released = false
    withFileEditLocks(repoRoot, [filePath], async () => {
      resolveAcquired(() => {
        if (released) return
        released = true
        signalRelease()
      })
      await heldUntilReleased
    }).catch(rejectAcquired)
  })
}

/**
 * Acquire/release form of the repo's tree gate in SHARED mode ALONE — no
 * per-file mutex (A2, round-2 whole-branch review finding, 2026-08-19).
 *
 * Built for `brokeredWrite` (`src/editor/agent-chat-sdk/write-broker.ts`)
 * to inject as its optional `acquireTreeGate` dependency: the SDK's
 * *structural* write tools (`insert_component`, `delete_file`,
 * `rename_file`, `scaffold_route`, `insert_element`, `manage_package`,
 * `download_asset`) call `brokeredWrite` directly with no outer wrapping
 * at all — unlike the CLI edit route, which already wraps its own
 * `brokeredWrite`/`applyEdit` call in {@link withFileEditLocks} (tree gate
 * SHARED + per-file mutex) — so their edit-ledger append was not ordered
 * against `withTreeLock` (Commit/Publish/branch switch-create-rename) at
 * all: a commit could run `git add -A` and append its own marker while a
 * structural tool's write was mid-flight, or between the write landing and
 * its ledger line landing, with nothing serializing the two.
 *
 * Deliberately SHARED-gate-only, not the `acquireFileEditLock` pairing
 * used for the SDK's built-in Write/Edit: `brokeredWrite` already takes
 * its own `FileLockManager` per-path locks internally (that's what
 * `write-broker.ts`'s "Layering" note calls the inner write-serialization
 * layer). Also acquiring `fileEditLockKey` here would double-lock the same
 * path under two different mutexes for no benefit — the tree gate is the
 * only piece `brokeredWrite` doesn't already have.
 *
 * The caller MUST release, exactly once, after `brokeredWrite` (including
 * its ledger append) has fully returned — releasing early is exactly the
 * bug this closes.
 */
export async function acquireTreeGateShared(repoRoot: string): Promise<() => void> {
  return acquireShared(treeGateKey(repoRoot))
}

/**
 * Serialize ops that mutate the git INDEX in a path-limited way (today: the
 * per-file discard route's `git reset` / `git checkout` / `git clean`).
 *
 * Why this is separate from the per-file mutex: `.git/index.lock` is a
 * repo-global resource, so two discards of DIFFERENT files — which the
 * per-file scheme now lets run concurrently — would race on it and one would
 * fail with "Unable to create '.git/index.lock': File exists". Under the old
 * repo-wide edit key that couldn't happen; this keeps that guarantee without
 * dragging plain file edits (which never touch the index) back into it.
 *
 * Ordering rule: acquire this INSIDE `withFileEditLocks` (innermost). Only
 * index-mutating ops take it, and they take it last, so it can't participate
 * in a cycle. Tree ops don't need it — they're already exclusive.
 */
export async function withGitIndexLock<T>(
  repoRoot: string,
  op: () => Promise<T>,
): Promise<T> {
  return withCliSessionLock(`git-index:${normalizeRootPath(repoRoot)}`, op)
}

/**
 * Run a TREE-scoped op (commit / publish / push / branch switch-create-rename)
 * holding the repo's tree gate EXCLUSIVELY: it waits for every in-flight
 * file edit to finish and blocks new ones until it returns.
 */
export async function withTreeLock<T>(
  repoRoot: string,
  op: () => Promise<T>,
): Promise<T> {
  const releaseGate = await acquireExclusive(treeGateKey(repoRoot))
  try {
    return await op()
  } finally {
    releaseGate()
  }
}

/**
 * Code-unit comparator, NOT `localeCompare`. `localeCompare` is
 * locale-sensitive and not a strict total order (NFC/NFD variants compare
 * equal), which would let a tied sort fall back to insertion order —
 * different across concurrent batches, i.e. the deadlock shape sorted
 * acquisition exists to prevent. Same rationale as `edit-handler.ts`'s
 * per-file write loops.
 */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Test hook — drop all queues and gates. */
export function _resetCliSessionLockForTests(): void {
  queues.clear()
  treeGates.clear()
}

/** Test hook — assert no lock state leaked after a run. */
export function _inspectCliLocksForTests(): {
  queueKeys: string[]
  gateKeys: string[]
} {
  return { queueKeys: [...queues.keys()], gateKeys: [...treeGates.keys()] }
}
