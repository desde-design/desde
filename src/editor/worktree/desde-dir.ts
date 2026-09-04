/**
 * Guards every writer AND deleter of `.desde/*` against a `.desde` that is
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
 * This is the one place that check lives. `desdeDir` is what every one of
 * those call sites obtains its base path through, so a caller cannot
 * accidentally join onto `canonicalRoot` directly and skip the check:
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
 *  - The retention sweeps, which all `rm` recursively and so refuse and
 *    log rather than proceed when the guard throws: `backups-gc.ts`
 *    (`.desde/backups/`), `proposal-blob-gc.ts` (`.desde/chat-sessions/`),
 *    `read-snapshot-gc.ts` (`.desde/chat-sessions/<id>/bases/`).
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
