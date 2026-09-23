import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_READ_SNAPSHOT_MAX_AGE_DAYS,
  READ_SNAPSHOT_MIN_AGE_FLOOR_MS,
  gcReadSnapshotBases,
} from './read-snapshot-gc'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'read-snapshot-gc-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const DAY_MS = 24 * 60 * 60 * 1000

function chatSessionsDir(): string {
  return join(root, '.desde', 'chat-sessions')
}

/** Write a base file under `<sessionId>/bases/<hash>.txt`, backdated to `ageMs`. */
function makeBase(sessionId: string, hash: string, ageMs: number, now: number): string {
  const dir = join(chatSessionsDir(), sessionId, 'bases')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${hash}.txt`)
  writeFileSync(path, 'content')
  const mtime = (now - ageMs) / 1000
  utimesSync(path, mtime, mtime)
  return path
}

function writeSessionFile(
  sessionId: string,
  fileReads: Record<string, { baseContentPath: string }>,
): void {
  mkdirSync(chatSessionsDir(), { recursive: true })
  writeFileSync(
    join(chatSessionsDir(), `${sessionId}.json`),
    JSON.stringify({ schemaVersion: 1, fileReads }),
  )
}

function writeSessionFileWithConflicts(
  sessionId: string,
  fileReads: Record<string, { baseContentPath: string }>,
  conflicts: Record<string, { hashAtRead: string }>,
): void {
  mkdirSync(chatSessionsDir(), { recursive: true })
  writeFileSync(
    join(chatSessionsDir(), `${sessionId}.json`),
    JSON.stringify({ schemaVersion: 1, fileReads, conflicts }),
  )
}

describe('gcReadSnapshotBases', () => {
  it('returns empty when chat-sessions dir does not exist', async () => {
    expect(await gcReadSnapshotBases(root)).toEqual({ sessionsSwept: 0, deleted: 0 })
  })

  it('exposes sane defaults', () => {
    expect(DEFAULT_READ_SNAPSHOT_MAX_AGE_DAYS).toBe(14)
    expect(READ_SNAPSHOT_MIN_AGE_FLOOR_MS).toBe(10 * 60 * 1000)
  })

  it('never deletes a base referenced by the session file, no matter how old', async () => {
    const now = Date.now()
    const basePath = makeBase('sess-a', 'aaa111', 30 * DAY_MS, now)
    writeSessionFile('sess-a', {
      '/abs/path/to/file.vue': { baseContentPath: basePath },
    })
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.deleted).toBe(0)
    expect(existsSync(basePath)).toBe(true)
  })

  it('deletes an unreferenced base past the age threshold', async () => {
    const now = Date.now()
    const basePath = makeBase('sess-a', 'stale111', 30 * DAY_MS, now)
    writeSessionFile('sess-a', {}) // no fileReads reference this hash
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.sessionsSwept).toBe(1)
    expect(result.deleted).toBe(1)
    expect(existsSync(basePath)).toBe(false)
  })

  it('keeps an unreferenced base that is not yet past the age threshold', async () => {
    const now = Date.now()
    const basePath = makeBase('sess-a', 'young111', 2 * DAY_MS, now)
    writeSessionFile('sess-a', {})
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.deleted).toBe(0)
    expect(existsSync(basePath)).toBe(true)
  })

  it('never deletes a base younger than the 10-minute floor even if unreferenced and maxAgeDays is tiny', async () => {
    const now = Date.now()
    const basePath = makeBase('sess-a', 'brandnew', 60_000, now) // 1 minute old
    writeSessionFile('sess-a', {})
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 0.0001, now: () => now })
    expect(result.deleted).toBe(0)
    expect(existsSync(basePath)).toBe(true)
  })

  it('treats a missing session file as "nothing referenced" (age-only fallback)', async () => {
    const now = Date.now()
    // bases dir exists but there's no <sessionId>.json alongside it —
    // e.g. the session record was deleted independently.
    const basePath = makeBase('orphan-sess', 'orphanhash', 30 * DAY_MS, now)
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.deleted).toBe(1)
    expect(existsSync(basePath)).toBe(false)
  })

  it('treats a malformed session file as "nothing referenced" rather than throwing', async () => {
    const now = Date.now()
    mkdirSync(chatSessionsDir(), { recursive: true })
    writeFileSync(join(chatSessionsDir(), 'sess-a.json'), '{ not valid json')
    const basePath = makeBase('sess-a', 'brokenjson', 30 * DAY_MS, now)
    await expect(gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })).resolves.toEqual({
      sessionsSwept: 1,
      deleted: 1,
    })
    expect(existsSync(basePath)).toBe(false)
  })

  it('sweeps multiple sessions independently', async () => {
    const now = Date.now()
    const staleUnreferenced = makeBase('sess-a', 'x1', 30 * DAY_MS, now)
    const referenced = makeBase('sess-b', 'x2', 30 * DAY_MS, now)
    writeSessionFile('sess-a', {})
    writeSessionFile('sess-b', { '/abs/f.vue': { baseContentPath: referenced } })
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.sessionsSwept).toBe(2)
    expect(result.deleted).toBe(1)
    expect(existsSync(staleUnreferenced)).toBe(false)
    expect(existsSync(referenced)).toBe(true)
  })

  it('never throws when a per-session bases listing fails (logs + continues)', async () => {
    const now = Date.now()
    // sess-a has a real bases dir; sess-b's "bases" is a FILE not a dir,
    // so readdir on it throws something other than ENOENT.
    makeBase('sess-a', 'ok1', 30 * DAY_MS, now)
    writeSessionFile('sess-a', {})
    mkdirSync(join(chatSessionsDir(), 'sess-b'), { recursive: true })
    writeFileSync(join(chatSessionsDir(), 'sess-b', 'bases'), 'not a directory')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.sessionsSwept).toBe(1)
    expect(result.deleted).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('gcReadSnapshotBases — conflicts map protection (audit Task 15, codex round 1)', () => {
  it('never deletes a base referenced ONLY by conflicts[file].hashAtRead (fileReads replaced by a later Read)', async () => {
    const now = Date.now()
    // The conflict was detected against 'oldhash' — resolve-conflict.ts's
    // merge path reads bases/oldhash.txt directly off the conflict entry.
    const conflictBase = makeBase('sess-a', 'oldhash', 30 * DAY_MS, now)
    // A later Read of the SAME file replaced fileReads with a NEW hash —
    // the old hash's base is now unreferenced by fileReads alone.
    const newerBase = makeBase('sess-a', 'newhash', 30 * DAY_MS, now)
    writeSessionFileWithConflicts(
      'sess-a',
      { '/abs/path/to/file.vue': { baseContentPath: newerBase } },
      { '/abs/path/to/file.vue': { hashAtRead: 'oldhash' } },
    )
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    // Neither base is deleted: 'newhash' via fileReads, 'oldhash' via conflicts.
    expect(result.deleted).toBe(0)
    expect(existsSync(conflictBase)).toBe(true)
    expect(existsSync(newerBase)).toBe(true)
  })

  it('deletes a base unreferenced by BOTH fileReads and conflicts, past the age threshold', async () => {
    const now = Date.now()
    const orphanBase = makeBase('sess-a', 'orphanhash', 30 * DAY_MS, now)
    writeSessionFileWithConflicts(
      'sess-a',
      {},
      { '/abs/other-file.vue': { hashAtRead: 'unrelatedhash' } },
    )
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result.deleted).toBe(1)
    expect(existsSync(orphanBase)).toBe(false)
  })

  it('CX7 item 6: refuses to sweep, and removes nothing, when .desde is a symlink out of the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'read-snapshot-gc-outside-'))
    mkdirSync(join(outside, 'chat-sessions', 'sess-a', 'bases'), { recursive: true })
    writeFileSync(join(outside, 'chat-sessions', 'sess-a', 'bases', 'orphanhash.txt'), 'content')
    symlinkSync(outside, join(root, '.desde'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    const result = await gcReadSnapshotBases(root, { maxAgeDays: 14, now: () => now })
    expect(result).toEqual({ sessionsSwept: 0, deleted: 0 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    expect(
      existsSync(join(outside, 'chat-sessions', 'sess-a', 'bases', 'orphanhash.txt')),
    ).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })
})
