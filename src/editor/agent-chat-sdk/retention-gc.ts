/**
 * Audit Task 15 — orchestrates the two on-disk retention sweeps
 * (`backups-gc.ts`, `read-snapshot-gc.ts`) as a single best-effort unit.
 *
 * Lives here (not in `editor-cli/src/core.ts` or `http-server.ts`,
 * its two callers) so both can import it without creating a
 * `core.ts` ↔ `http-server.ts` circular import — `core.ts` calls
 * `startHttpServer` (defined in `http-server.ts`), so `http-server.ts`
 * can't import anything back from `core.ts`.
 *
 * Callers: CLI boot (`core.ts`, fire-and-forget, non-blocking) and the
 * nav-bar Commit route (`handleBranchCommitRequest` in `http-server.ts`,
 * awaited after a successful commit). Never throws — every failure is
 * caught, logged, and swallowed, matching `proposal-blob-gc.ts`'s
 * tolerance discipline. A GC failure must never fail the operation
 * (boot, or the Commit) that triggered the sweep.
 */

import { gcBackups } from './backups-gc'
import { gcReadSnapshotBases } from './read-snapshot-gc'

export interface RetentionConfig {
  backups?: { keepNewest?: number; maxAgeDays?: number }
  chatSessionTurns?: { maxTurns?: number }
}

/**
 * @param repoRoot Git ROOT of the user's repo — where `.desde/`
 *   (backups, chat-sessions) actually lives. NOT `canonicalRoot`
 *   (codex round-1 fix): in a monorepo subdirectory, or the
 *   editor-cli/self-host harness, `canonicalRoot` is a different,
 *   deeper path than the git root, and passing it here makes both
 *   sweeps silently ENOENT/no-op. Both callers (`core.ts` boot,
 *   `handleBranchCommitRequest` in `http-server.ts`) pass their
 *   `repoRoot` variable, not `canonicalRoot`.
 */
export async function runRetentionGc(
  repoRoot: string,
  retention: RetentionConfig | undefined,
): Promise<void> {
  try {
    const backupsResult = await gcBackups(repoRoot, retention?.backups)
    if (backupsResult.deleted.length > 0 || backupsResult.errors > 0) {
      console.log(
        `[retention-gc] pruned ${backupsResult.deleted.length} backup dir(s), ${backupsResult.kept} remain` +
          (backupsResult.errors > 0 ? `, ${backupsResult.errors} stat error(s)` : ''),
      )
    }
  } catch (err) {
    console.warn(`[retention-gc] backups sweep failed: ${(err as Error).message}`)
  }
  try {
    // Bases pruning reuses the backups sweep's `maxAgeDays` — see
    // `read-snapshot-gc.ts`'s file header for why there's no separate
    // config knob ("the same age threshold" the design decision calls for).
    const basesResult = await gcReadSnapshotBases(repoRoot, {
      maxAgeDays: retention?.backups?.maxAgeDays,
    })
    if (basesResult.deleted > 0) {
      console.log(
        `[retention-gc] pruned ${basesResult.deleted} read-snapshot base(s) across ${basesResult.sessionsSwept} session(s)`,
      )
    }
  } catch (err) {
    console.warn(`[retention-gc] read-snapshot bases sweep failed: ${(err as Error).message}`)
  }
}
