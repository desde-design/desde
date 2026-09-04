/**
 * Guards every writer of `.desde/*` (the backup journal, the edit ledger,
 * the SDK write guard, the CLI edit route) against a `.desde` that is a
 * symbolic link pointing outside the working tree.
 *
 * A prototype repo is untrusted input (2026-08-09 security audit doctrine):
 * nothing stops it from shipping `.desde` as a symlink to, say, `/`. Every
 * writer under `.desde/` joins a repo-relative path onto `canonicalRoot`
 * and writes there with `mkdir(..., { recursive: true })` /
 * `writeFile`/`appendFile` — none of which refuse to follow a symlink at
 * the join point, so the join silently lands outside the worktree. This is
 * the one place that check lives, called from every writer so a caller
 * that bypasses `brokeredWrite` (the SDK lane's `sdk-write-guard.ts`, the
 * CLI edit route) is still covered.
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Thrown by {@link assertDesdeDirIsNotASymlink} when `<repoRoot>/.desde`
 * exists and is a symbolic link. Not a runtime condition a well-formed
 * request can trigger from inside the app — it names a property of the
 * repo itself, so every writer under `.desde/` checks it before touching
 * disk.
 */
export class DesdeDirSymlinkError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to write under '${path}': .desde is a symlink, and Desde only writes its journal and ledger inside the working tree.`,
    )
    this.name = 'DesdeDirSymlinkError'
  }
}

/**
 * Throws {@link DesdeDirSymlinkError} when `<repoRoot>/.desde` exists and
 * is a symbolic link. A missing `.desde` is fine — it will be created as
 * an ordinary directory by the caller's own `mkdir`.
 */
export function assertDesdeDirIsNotASymlink(repoRoot: string): void {
  const desdeDir = join(repoRoot, '.desde')
  let st
  try {
    st = lstatSync(desdeDir)
  } catch {
    return
  }
  if (st.isSymbolicLink()) throw new DesdeDirSymlinkError(desdeDir)
}
