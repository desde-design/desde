/**
 * Guards writers AND deleters of `.desde/*` against a `.desde` that is
 * a symbolic link pointing outside the working tree.
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
 * This is the one place that check lives. `desdeDir` is what every call
 * site below obtains its base path through, so a caller cannot
 * accidentally join onto `canonicalRoot` directly and skip the check.
 * These are exactly the sites that go through it today — a new writer or
 * deleter under `.desde/` must join through `desdeDir` too, and add
 * itself to this list. **The list is not the same thing as complete
 * coverage**: the sites named at the bottom still do not go through the
 * guard, and this comment claiming otherwise is what the 2026-09-04
 * branch review caught.
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
 *    `update-<uuid>`) for an isolated squash-merge or update. A refusal
 *    surfaces through the same `try`/`catch` that already converts a git
 *    failure into that function's ordinary `{ ok: false, reason }` result
 *    — no special handling needed.
 *  - `session-turns-archive.ts` (`archiveFilePath`) — the shared path
 *    builder both the archive writer (`appendArchivedTurns`) and reader
 *    (`readArchivedTurns`) use for `.desde/chat-sessions/<id>.archive.jsonl`.
 *  - `onboarding/orchestrator.ts` (`ingestScratchRoot`) — the npm install
 *    or git clone an ingested design system lands in, under
 *    `.desde/ingested/`. Throws, which `ingest` surfaces the way it
 *    surfaces every other unusable source.
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
 * **Writers that do NOT go through the guard yet** (measured 2026-09-04 by
 * grepping both `'.desde'` and `'.desde/…'` spellings; each one still
 * follows a hostile symlink):
 *
 *  - `adapters/cached/index.ts`'s `CACHE_DIR_NAME` (`.desde/manifests`),
 *    joined at five call sites in `build-manifest-source.ts`,
 *    `repair-component.ts` and `onboarding/orchestrator.ts`.
 *  - `onboarding/registry-store.ts` (`.desde/design-systems.json`), whose
 *    path is built in a constructor that runs on the serving path.
 *  - `editor-cli/src/attach-preflight/stamper-files.ts` (`.desde/stamp`),
 *    which writes the generated source-tag plugins.
 *
 * They are left as they are deliberately, not by oversight: each builds
 * its path where a throw would land on a boot or serving path whose
 * failure behaviour has not been measured, and guessing at that is how a
 * containment fix becomes an outage. Guarding them is its own change.
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Thrown by {@link assertDesdeDirIsNotASymlink} (and so by {@link desdeDir})
 * when `<repoRoot>/.desde` exists and is a symbolic link. Not a runtime
 * condition a well-formed request can trigger from inside the app — it
 * names a property of the repo itself, so every writer or deleter under
 * `.desde/` checks it before touching disk.
 */
export class DesdeDirSymlinkError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to write under '${path}': .desde is a symbolic link. Desde writes its journal and ledger only into a real directory in the working tree.`,
    )
    this.name = 'DesdeDirSymlinkError'
  }
}

/**
 * Throws {@link DesdeDirSymlinkError} when `<repoRoot>/.desde` exists and
 * is a symbolic link. A missing `.desde` is fine — it will be created as
 * an ordinary directory by the caller's own `mkdir`.
 *
 * Not exported: {@link desdeDir} below is the one public entry point every
 * writer or deleter should use, so the guard cannot be skipped by
 * accident. It stays a separate named function (rather than inlined into
 * `desdeDir`) only for readability.
 */
function assertDesdeDirIsNotASymlink(repoRoot: string): void {
  const desdeDirPath = join(repoRoot, '.desde')
  let st
  try {
    st = lstatSync(desdeDirPath)
  } catch {
    return
  }
  if (st.isSymbolicLink()) throw new DesdeDirSymlinkError(desdeDirPath)
}

/**
 * The `.desde` directory under `repoRoot`, guarded. Runs
 * {@link assertDesdeDirIsNotASymlink} and returns `join(repoRoot,
 * '.desde')` — every writer or deleter under `.desde/` should build its
 * path from this, rather than joining `.desde` onto `repoRoot` itself, so
 * the guard cannot be skipped by accident.
 */
export function desdeDir(repoRoot: string): string {
  assertDesdeDirIsNotASymlink(repoRoot)
  return join(repoRoot, '.desde')
}
