/**
 * Guards writers AND deleters of `.desde/*` against a `.desde` — or ANY
 * directory beneath it — that is a symbolic link pointing outside the
 * working tree.
 *
 * A prototype repo is untrusted input (2026-08-09 security audit doctrine):
 * nothing stops it from shipping `.desde` as a symlink to, say, `/`. Every
 * writer under `.desde/` joins a repo-relative path onto `canonicalRoot`
 * and writes there with `mkdir(..., { recursive: true })` /
 * `writeFile`/`appendFile` — none of which refuse to follow a symlink at
 * the join point, so the join silently lands outside the worktree. A
 * DELETER under `.desde/` is worse: several of the sites below `rm` a
 * whole subtree recursively, so a hostile symlink turns a GC sweep into a
 * recursive delete of whatever the symlink points at.
 *
 * **The check walks every segment, not just `.desde`.** Until 2026-09-04
 * it `lstat`ed exactly one path, `<repoRoot>/.desde`, which left the
 * subdirectories the Editor owns (`backups/`, `chat-sessions/`,
 * `manifests/`, `ingested/`, `stamp/`) completely unguarded: a real
 * `.desde` directory containing `backups -> /somewhere/else` was measured
 * turning `gcBackups()` into a recursive delete of two directories outside
 * the repository. {@link desdePath} is the resolver that closes that — it
 * `lstat`s `.desde` and then each segment the caller asks for, and refuses
 * on the first symbolic link.
 *
 * This is the one place that check lives. Every writer and deleter under
 * `.desde/` builds its whole path here — including the subpath, not just
 * the `.desde` prefix — so a caller cannot accidentally join onto
 * `canonicalRoot` (or onto a guarded `.desde`) and skip the check. There is
 * no exception list any more: the four writers that carried one until
 * 2026-09-04 (the manifest cache, the design-system registry, the
 * attach-mode stampers and the lock-event audit log) are in the inventory
 * below like everything else. Each was deferred because the only guard on
 * offer threw, and a throw on a boot or serving path is an outage;
 * {@link desdePathOrNull} is what let them in.
 *
 *  - `backup-journal.ts` (`writeBackupJournal`) — the per-edit backup
 *    journal under `.desde/backups/`.
 *  - `edit-ledger.ts` (`ledgerPath`, read by `readLedger`, written by
 *    `appendLedgerEntry`) — `.desde/edit-log.jsonl`.
 *  - `write-broker.ts` and `sdk-write-guard.ts` — both catch
 *    {@link DesdeDirSymlinkError} specifically, to report it as a typed
 *    `backup`-stage failure rather than an uncaught throw.
 *  - `editor-cli/src/server/edit-handler.ts`'s mini-turn backup writer —
 *    the CLI edit route's own best-effort backup, outside `brokeredWrite`.
 *  - `proposal-blob-store.ts` — `.desde/chat-sessions/<id>/proposals/`,
 *    both the per-edit blob writer and the per-session recursive deleter.
 *  - `file-read-snapshot.ts` (`captureReadSnapshot`) — the read-time base
 *    snapshots under `.desde/chat-sessions/<id>/bases/`, written by the
 *    SDK lane's PreToolUse hook and by the neutral lane's own Read tool.
 *    The whole lane is best-effort, so a refusal there means no snapshot
 *    for that read rather than a failed turn.
 *  - `session-store.ts` (`sessionsDir`) — the session records themselves,
 *    `.desde/chat-sessions/<id>.json`. A save or a listing refuses;
 *    `findRecentWriterForFile` reports no writer, which is what it
 *    already does for every other unreadable directory.
 *  - `restart-clear.ts` — the boot-time sweep over those same records.
 *    Collects the refusal as a per-directory error and returns, because
 *    its own contract is that restart never blocks CLI boot.
 *  - `edit-fix-mini-turn.ts` — the headless mini-turn's own throwaway
 *    session cleanup, a recursive delete of
 *    `.desde/chat-sessions/<sessionId>` in a `finally` block. Refuses and
 *    logs rather than deleting, same tolerance as the retention sweeps.
 *  - `git-branches.ts` (`publishBranch`, `updateBranchFromRef`) — the
 *    ephemeral worktree each mints under `.desde/` (`publish-<uuid>` /
 *    `update-<uuid>`) for an isolated squash-merge or update. Both call
 *    the guard as a PRECONDITION, before their dirty-tree auto-commit, so
 *    a refusal leaves the repository byte-identical; the refusal then
 *    surfaces through the same `try`/`catch` that already converts a git
 *    failure into that function's ordinary `{ ok: false, reason }` result.
 *  - `session-turns-archive.ts` (`archiveFilePath`) — the shared path
 *    builder both the archive writer (`appendArchivedTurns`) and reader
 *    (`readArchivedTurns`) use for `.desde/chat-sessions/<id>.archive.jsonl`.
 *  - `onboarding/orchestrator.ts` (`ingestScratchRoot`) — the npm install
 *    or git clone an ingested design system lands in, under
 *    `.desde/ingested/`. Throws, which `ingest` surfaces the way it
 *    surfaces every other unusable source.
 *  - `onboarding/registry-store.ts` — `.desde/design-systems.json`. The
 *    read degrades to an empty registry (its documented fail-soft); the
 *    write throws, because every caller of `add`/`remove` is a route that
 *    can report a refusal.
 *  - `adapters/cached/index.ts` (`manifestCacheDir`) — `.desde/manifests`.
 *    Non-throwing: a refusal disables the manifest cache for that run
 *    (extraction still happens, it just is not cached), because this runs
 *    on the serving path. The two hint-GENERATING routes are the exception
 *    and use the throwing form, since a run that wrote nothing must not
 *    report success.
 *  - `editor-cli/src/attach/write-stampers.ts` — `.desde/stamp`, the
 *    generated source-tag plugins. Non-throwing: a refusal is reported
 *    through the `warnings` channel that function already returns, so a
 *    boot degrades to an editor without stamping instead of failing.
 *  - `edit-service/lock-event-persistence.ts` — the per-session lock-event
 *    audit log, `.desde/chat-sessions/<id>/lock-events.jsonl`. The append
 *    is best-effort by contract, so a refusal reaches the caller's
 *    `onError` and nothing else.
 *  - `editor-cli/src/server/stores/local-store-base.ts`
 *    (`resolveStorePath`) — every local artifact store: notes, comments,
 *    canvases, page statuses, screenshot plans, smoke runs.
 *  - `editor-cli/src/server/project-config.ts` (`configPathFor`) —
 *    `.desde/config.json`. The two writers throw; `readProjectConfig`
 *    reports it as a malformed config, because it runs on the boot path
 *    and that path degrades rather than refusing to start.
 *  - The two `.desde/ingested` containment checks that decide whether a
 *    registered design system's `packageRoot` may be read
 *    (`editor-cli/src/server/drift-handler.ts` and
 *    `design-systems-handler.ts`): with `.desde` linked away there is no
 *    containment left to check, so the entry resolves to `null`.
 *  - The retention sweeps, which all `rm` recursively and so refuse and
 *    log rather than proceed when the guard throws: `backups-gc.ts`
 *    (`.desde/backups/`), `proposal-blob-gc.ts` (`.desde/chat-sessions/`),
 *    `read-snapshot-gc.ts` (`.desde/chat-sessions/<id>/bases/`).
 *
 * **What this guard does NOT close, and why.**
 *
 * A swap between the check and the write is still a race. The resolver
 * returns a STRING, and every caller then writes through path-based
 * `mkdir`/`writeFile`/`rm`, which re-resolve each segment at call time —
 * so a process that replaces `.desde` with a symlink in that window
 * redirects the write. Node's promise API has no `O_NOFOLLOW` write and no
 * directory-handle-relative `rm`, so closing it fully means an fd-based
 * traversal this module does not have. What is done instead:
 * {@link desdeRemovalPath} re-resolves the target with `realpath` and
 * refuses when it lands outside the repository, and every recursive
 * deleter calls it immediately before its `rm`. That narrows the window to
 * the microseconds between that call and the `rm` itself, on the
 * operations where the damage is unrecoverable. It needs a process running
 * concurrently inside the prototype repo to matter at all.
 *
 * Hard links are deliberately out of scope. `lstat` cannot tell a hard
 * link from an ordinary file, but git has no hard-link representation in
 * the index (only regular file, executable, symlink and gitlink), so a
 * clone or checkout of a hostile repository cannot deliver one; the
 * dominant write pattern here is temp-file-plus-rename, which replaces the
 * name rather than writing through the shared inode; and deleting one name
 * of a hard link leaves the other file's data intact. There is nothing to
 * build for them.
 */

import { lstatSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

/**
 * Thrown by {@link desdePath} (and so by {@link desdeDir} and
 * {@link desdeRemovalPath}) when `<repoRoot>/.desde`, or any directory the
 * caller asked for beneath it, exists and is a symbolic link — or when a
 * removal target resolves outside the repository. Not a runtime condition
 * a well-formed request can trigger from inside the app: it names a
 * property of the repo itself, so every writer or deleter under `.desde/`
 * checks it before touching disk.
 */
export class DesdeDirSymlinkError extends Error {
  constructor(
    public readonly path: string,
    detail = '.desde is a symbolic link.',
  ) {
    super(
      `Refusing to write under '${path}': ${detail} Desde writes its journal and ledger only into a real directory in the working tree.`,
    )
    this.name = 'DesdeDirSymlinkError'
  }
}

/** Splits `'chat-sessions'` / `'a/b'` alike into single path segments. */
function toSegments(segments: readonly string[]): string[] {
  return segments.flatMap((segment) => segment.split(/[\\/]+/)).filter((s) => s.length > 0)
}

/**
 * The `.desde` directory under `repoRoot`, or a path beneath it, guarded.
 *
 * Walks `.desde` and then every segment the caller asked for, `lstat`ing
 * each one in turn, and throws {@link DesdeDirSymlinkError} naming the
 * FIRST that is a symbolic link. A segment that does not exist is fine —
 * nothing below it can exist either, and the caller's own `mkdir` will
 * create it as an ordinary directory — so the walk stops there and returns
 * the full path.
 *
 * Pass the whole subpath, not just `.desde`: `desdePath(root,
 * 'chat-sessions', id)` is guarded at three levels, whereas
 * `join(desdePath(root), 'chat-sessions', id)` is guarded at one.
 */
export function desdePath(repoRoot: string, ...segments: string[]): string {
  const parts = ['.desde', ...toSegments(segments)]
  const full = join(repoRoot, ...parts)
  let current = repoRoot
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    let st
    try {
      st = lstatSync(current)
    } catch {
      // Missing (or unreadable) — nothing below it can be a symlink
      // either, and the caller's own write reports any other problem.
      return full
    }
    if (st.isSymbolicLink()) {
      // Indexed, not `indexOf`: a repeated segment name would otherwise
      // name the wrong depth in the message.
      const label = parts.slice(0, i + 1).join('/')
      throw new DesdeDirSymlinkError(full, `${label} is a symbolic link.`)
    }
  }
  return full
}

/**
 * {@link desdePath} for callers that cannot throw: returns `null` instead
 * of raising {@link DesdeDirSymlinkError}.
 *
 * This exists for the boot and serving paths — the manifest cache, the
 * design-system registry read, the attach-mode stampers. Those four
 * writers were left unguarded for a whole release because the only guard
 * on offer threw, and a throw on a boot path is an outage; `null` lets
 * them skip the work and say so instead.
 */
export function desdePathOrNull(repoRoot: string, ...segments: string[]): string | null {
  try {
    return desdePath(repoRoot, ...segments)
  } catch (err) {
    if (err instanceof DesdeDirSymlinkError) return null
    throw err
  }
}

/**
 * A path under `.desde/` that is about to be REMOVED, guarded twice.
 *
 * Runs {@link desdePath}'s segment walk, then re-resolves the target with
 * `realpath` and refuses when the resolved path is not the repository root
 * or inside it. The second check is what makes a recursive `rm` safe
 * against a link swapped in after the walk — see the module header's note
 * on what remains a race. A target that does not exist passes: there is
 * nothing to delete. A `repoRoot` that cannot itself be resolved passes
 * too, since there is nothing to compare against; the segment walk has
 * already run in that case.
 */
export function desdeRemovalPath(repoRoot: string, ...segments: string[]): string {
  const target = desdePath(repoRoot, ...segments)
  let realTarget: string
  let realRoot: string
  try {
    realTarget = realpathSync(target)
  } catch {
    return target
  }
  try {
    realRoot = realpathSync(repoRoot)
  } catch {
    return target
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new DesdeDirSymlinkError(
      target,
      `it resolves outside the working tree ('${realRoot}').`,
    )
  }
  return target
}

/**
 * The `.desde` directory under `repoRoot`, guarded — {@link desdePath}
 * with no extra segments. Kept as its own name because most call sites
 * read better for it, but prefer `desdePath(root, …)` whenever the caller
 * goes on to join a subpath: only the segments passed here are checked.
 */
export function desdeDir(repoRoot: string): string {
  return desdePath(repoRoot)
}

/** {@link desdeDir} for callers that cannot throw. See {@link desdePathOrNull}. */
export function desdeDirOrNull(repoRoot: string): string | null {
  return desdePathOrNull(repoRoot)
}
