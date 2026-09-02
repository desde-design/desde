/**
 * Audit Task 15 — retention sweep for
 * `.desde/chat-sessions/<sessionId>/bases/`.
 *
 * `file-read-snapshot.ts` writes one content-addressed sidecar
 * (`bases/<sha256>.txt`) every time the SDK's built-in `Read` tool runs
 * during a chat turn — the "base" content the stale-base conflict check
 * (`edit-ack.ts`) compares a later write against. With no GC this grows
 * without bound: every distinct file content any session has ever read
 * leaves a permanent file.
 *
 * SAFETY (read `file-read-snapshot.ts` + `edit-ack.ts` +
 * `resolve-conflict.ts` before touching this sweep — codex round 1
 * caught a missed SECOND consumer here). There are TWO independent
 * readers of `bases/<hash>.txt`, not one:
 *
 *   1. The overwrite-detection lane (`edit-ack.ts`) looks up
 *      `session.fileReads[absolutePath].{hashAtRead,baseContentPath}`.
 *   2. `resolve-conflict.ts`'s "merge" resolution looks up
 *      `session.conflicts[file].hashAtRead` and reads
 *      `bases/<hashAtRead>.txt` DIRECTLY (it doesn't go through
 *      `fileReads` at all — see its own inline comment on `basePath`).
 *      A conflict entry is written once, at write-conflict-detection
 *      time, and is NOT updated by a later Read of the same file — so a
 *      re-Read that replaces `fileReads[absolutePath]` with a new hash
 *      leaves the OLD hash still live in `conflicts`, pointing at a base
 *      that reference (1) alone no longer protects.
 *
 * Pruning a base still referenced by EITHER map would make a later
 * stale-base check or merge resolution silently fail — a false
 * NEGATIVE (conflict detection) or a 409 with a misleading "base
 * snapshot missing" diagnostic (merge), both worse than leaving stale
 * bytes on disk. So a base is deleted only if ALL of:
 *
 *   - its content hash is NOT referenced by that session's persisted
 *     `fileReads`, AND
 *   - its content hash is NOT referenced by that session's persisted
 *     `conflicts` map (both loaded fresh, best-effort, from
 *     `<sessionId>.json` each sweep — no caching, so a session that
 *     re-reads a file, or accrues a new conflict, always re-protects
 *     its bases on the next sweep), AND
 *   - it is older than `maxAgeDays`.
 *
 * A conservative age floor (`READ_SNAPSHOT_MIN_AGE_FLOOR_MS`, 10
 * minutes — same value the backups sweep uses) additionally protects
 * ANY base younger than that regardless of reference status: the
 * `PreToolUse` hook writes the base file synchronously during the Read
 * tool call, but the referencing `fileReads` entry only reaches disk
 * later, at the turn's `saveSession` call. A sweep landing inside that
 * window (a boot or a Commit racing a slow in-flight turn) must not
 * delete a base that's about to be referenced.
 *
 * A missing/malformed session file (session was deleted, or the JSON
 * doesn't parse) is treated as "nothing referenced" for that session —
 * its bases are all age-eligible. This IS the reference-tracking-
 * infeasible fallback the design calls out: age-only, gated by the same
 * floor, for the case where there's no session record left to consult.
 *
 * Best-effort, same tolerance as `proposal-blob-gc.ts`.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Delete unreferenced base files older than this many days. */
export const DEFAULT_READ_SNAPSHOT_MAX_AGE_DAYS = 14
/** Never delete a base file younger than this, regardless of reference status. */
export const READ_SNAPSHOT_MIN_AGE_FLOOR_MS = 10 * 60 * 1000

export interface ReadSnapshotGcOptions {
  maxAgeDays?: number
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface ReadSnapshotGcResult {
  /** Number of session `bases/` directories swept (found + readable). */
  sessionsSwept: number
  /** Number of base files deleted across all sessions. */
  deleted: number
}

export async function gcReadSnapshotBases(
  repoRoot: string,
  opts: ReadSnapshotGcOptions = {},
): Promise<ReadSnapshotGcResult> {
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_READ_SNAPSHOT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000
  const now = (opts.now ?? Date.now)()
  const chatSessionsDir = join(repoRoot, '.desde', 'chat-sessions')

  let sessionDirNames: string[]
  try {
    sessionDirNames = await readdir(chatSessionsDir, { withFileTypes: true }).then((dirents) =>
      dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { sessionsSwept: 0, deleted: 0 }
    }
    console.warn(
      `[read-snapshot-gc] failed to read .desde/chat-sessions: ${(err as Error).message}`,
    )
    return { sessionsSwept: 0, deleted: 0 }
  }

  let sessionsSwept = 0
  let deleted = 0
  for (const sessionId of sessionDirNames) {
    const basesDir = join(chatSessionsDir, sessionId, 'bases')
    let files: string[]
    try {
      files = await readdir(basesDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      console.warn(
        `[read-snapshot-gc] failed to read bases for session '${sessionId}' (skipping): ${(err as Error).message}`,
      )
      continue
    }
    sessionsSwept++
    const referenced = await loadReferencedBaseNames(chatSessionsDir, sessionId)
    for (const file of files) {
      const filePath = join(basesDir, file)
      let ageMs: number
      try {
        const s = await stat(filePath)
        ageMs = now - s.mtimeMs
      } catch {
        // Vanished between readdir and stat — nothing to delete.
        continue
      }
      if (ageMs < READ_SNAPSHOT_MIN_AGE_FLOOR_MS) continue
      if (referenced.has(file)) continue
      if (ageMs <= maxAgeMs) continue
      try {
        await rm(filePath, { force: true })
        deleted++
      } catch (err) {
        console.warn(
          `[read-snapshot-gc] failed to delete base '${sessionId}/bases/${file}': ${(err as Error).message}`,
        )
      }
    }
  }
  return { sessionsSwept, deleted }
}

/**
 * The set of base-file basenames (`<sha256>.txt`) referenced by a
 * session's persisted `fileReads` OR `conflicts` map — see the file
 * header's SAFETY note for why both are consulted. Reads the raw JSON
 * directly (rather than `session-store.ts`'s `loadSession`, which
 * validates the full session schema) — this sweep only needs the two
 * fields and must degrade to "nothing referenced" on any parse
 * failure, never throw.
 */
async function loadReferencedBaseNames(
  chatSessionsDir: string,
  sessionId: string,
): Promise<Set<string>> {
  const sessionFile = join(chatSessionsDir, `${sessionId}.json`)
  try {
    const raw = await readFile(sessionFile, 'utf8')
    const parsed = JSON.parse(raw) as {
      fileReads?: Record<string, { baseContentPath?: unknown }>
      conflicts?: Record<string, { hashAtRead?: unknown }>
    }
    const referenced = new Set<string>()
    for (const record of Object.values(parsed.fileReads ?? {})) {
      if (typeof record?.baseContentPath === 'string' && record.baseContentPath.length > 0) {
        referenced.add(basename(record.baseContentPath))
      }
    }
    // `resolve-conflict.ts`'s "merge" path reads `bases/<hashAtRead>.txt`
    // straight off the conflict entry, independent of `fileReads` — a
    // later re-Read of the same file can replace the `fileReads` record
    // with a fresh hash while the conflict (written once, at
    // detection time) still points at the OLD one.
    for (const record of Object.values(parsed.conflicts ?? {})) {
      if (typeof record?.hashAtRead === 'string' && record.hashAtRead.length > 0) {
        referenced.add(`${record.hashAtRead}.txt`)
      }
    }
    return referenced
  } catch {
    // Missing/malformed session file → nothing to protect via
    // reference-tracking; the age floor is what keeps this safe (see
    // the file header's "reference-tracking-infeasible fallback" note).
    return new Set()
  }
}
