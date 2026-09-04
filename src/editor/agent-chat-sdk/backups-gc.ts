/**
 * Audit Task 15 — retention sweep for `.desde/backups/`.
 *
 * The per-edit backup journal (`backup-journal.ts`) writes one fresh
 * timestamped directory per mutation — the CLI edit handler's
 * deterministic + LLM-lane applicators, and (since audit Tasks 13/14)
 * every SDK built-in `Write`/`Edit` including denied no-ops. With no
 * retention this directory grows without bound.
 *
 * Policy — a backup directory is KEPT only if it satisfies BOTH:
 *   - rank: it's among the `keepNewest` (default 200) most-recently-
 *     modified directories, AND
 *   - age: its mtime is within `maxAgeDays` (default 14) of now.
 * It is pruned if it violates EITHER. A directory younger than
 * `BACKUPS_MIN_AGE_FLOOR_MS` (10 minutes) is NEVER pruned regardless of
 * rank or age — an in-flight rollback (the edit handler's own undo
 * path, `POST /api/editor/edit/undo` and friends) may still reference
 * a backup that was just written.
 *
 * Best-effort, same tolerance discipline as `proposal-blob-gc.ts`: a
 * listing failure, a stat failure on one entry, or a delete failure on
 * one entry all log a warning and never throw. This sweep must never
 * fail the CLI boot or the Commit it rides along with.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { desdeDir, DesdeDirSymlinkError } from '../worktree/desde-dir'

/**
 * Test-only dependency injection for the fs calls below. `node:fs/promises`
 * ESM exports are non-configurable at runtime, so `vi.spyOn` can't
 * intercept them and async `vi.mock` factories proved unreliable for
 * simulating a SINGLE failing call among several real ones — this is the
 * portable alternative for exercising the failure-tolerance paths (a
 * `readdir`/`stat`/`rm` that throws for one specific entry) without
 * chmod-based fault injection, which isn't reliable across platforms/CI
 * (root-run containers ignore permission bits).
 */
export interface BackupsGcFsDeps {
  readdir: typeof readdir
  stat: typeof stat
  rm: typeof rm
}

const defaultFsDeps: BackupsGcFsDeps = { readdir, stat, rm }

/** Keep at most this many newest backup directories. */
export const DEFAULT_BACKUPS_KEEP_NEWEST = 200
/** Delete backup directories older than this many days. */
export const DEFAULT_BACKUPS_MAX_AGE_DAYS = 14
/**
 * Never delete a backup dir younger than this, regardless of the
 * count/age caps above — protects an in-flight rollback.
 */
export const BACKUPS_MIN_AGE_FLOOR_MS = 10 * 60 * 1000

export interface BackupsGcOptions {
  keepNewest?: number
  maxAgeDays?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Test-only fs dependency injection. Defaults to the real `node:fs/promises`. */
  fs?: BackupsGcFsDeps
}

export interface BackupsGcResult {
  /** Backup directory names (not full paths) that were deleted. */
  deleted: string[]
  /** Number of backup directories that remain after the sweep. */
  kept: number
  /**
   * Number of entries a `stat` call failed for (excluded from BOTH
   * `deleted` and `kept` — codex round 1: without this, a stat failure
   * made `kept` silently under-report the true directory count still
   * on disk, since the entry drops out of accounting entirely rather
   * than falling through to "kept"). A `rm` failure is NOT counted
   * here — it's already correctly reflected in `kept` (the directory
   * survives on disk, same as any other kept entry).
   */
  errors: number
}

export async function gcBackups(
  repoRoot: string,
  opts: BackupsGcOptions = {},
): Promise<BackupsGcResult> {
  const keepNewest = opts.keepNewest ?? DEFAULT_BACKUPS_KEEP_NEWEST
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_BACKUPS_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
  const now = (opts.now ?? Date.now)()
  const fs = opts.fs ?? defaultFsDeps
  let dir: string
  try {
    dir = join(desdeDir(repoRoot), 'backups')
  } catch (err) {
    // A recursive `rm` under a hostile symlink is worse than a plain
    // write: refuse and log rather than sweep whatever the symlink
    // points at.
    if (err instanceof DesdeDirSymlinkError) {
      console.warn(`[backups-gc] refusing to sweep '${repoRoot}': ${err.message}`)
      return { deleted: [], kept: 0, errors: 0 }
    }
    throw err
  }

  let entries: string[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }).then((dirents) =>
      dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { deleted: [], kept: 0, errors: 0 }
    console.warn(`[backups-gc] failed to read .desde/backups: ${(err as Error).message}`)
    return { deleted: [], kept: 0, errors: 0 }
  }

  let errors = 0
  const stamped: { name: string; ageMs: number }[] = []
  for (const name of entries) {
    try {
      const s = await fs.stat(join(dir, name))
      stamped.push({ name, ageMs: now - s.mtimeMs })
    } catch (err) {
      errors++
      console.warn(
        `[backups-gc] failed to stat backup dir '${name}' (skipping): ${(err as Error).message}`,
      )
    }
  }
  // Newest first (smallest age).
  stamped.sort((a, b) => a.ageMs - b.ageMs)

  const deleted: string[] = []
  let kept = 0
  for (let i = 0; i < stamped.length; i++) {
    const entry = stamped[i]
    const protectedByFloor = entry.ageMs < BACKUPS_MIN_AGE_FLOOR_MS
    const violatesRank = i >= keepNewest
    const violatesAge = entry.ageMs > maxAgeMs
    if (!protectedByFloor && (violatesRank || violatesAge)) {
      try {
        await fs.rm(join(dir, entry.name), { recursive: true, force: true })
        deleted.push(entry.name)
        continue
      } catch (err) {
        console.warn(
          `[backups-gc] failed to delete backup dir '${entry.name}': ${(err as Error).message}`,
        )
        // Falls through to counted-as-kept — it's still on disk.
      }
    }
    kept++
  }
  return { deleted, kept, errors }
}
