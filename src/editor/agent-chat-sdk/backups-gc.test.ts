import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BACKUPS_MIN_AGE_FLOOR_MS,
  DEFAULT_BACKUPS_KEEP_NEWEST,
  DEFAULT_BACKUPS_MAX_AGE_DAYS,
  gcBackups,
} from './backups-gc'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'backups-gc-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Create `<root>/.desde/backups/<name>/file.txt` and backdate its mtime. */
function makeBackupDir(name: string, ageMs: number, now: number): void {
  const dir = join(root, '.desde', 'backups', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'file.txt'), 'content')
  const mtime = (now - ageMs) / 1000
  utimesSync(dir, mtime, mtime)
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('gcBackups', () => {
  it('returns empty when the backups dir does not exist', async () => {
    expect(await gcBackups(root)).toEqual({ deleted: [], kept: 0, errors: 0 })
  })

  it('exposes sane defaults', () => {
    expect(DEFAULT_BACKUPS_KEEP_NEWEST).toBe(200)
    expect(DEFAULT_BACKUPS_MAX_AGE_DAYS).toBe(14)
    expect(BACKUPS_MIN_AGE_FLOOR_MS).toBe(10 * 60 * 1000)
  })

  it('prunes dirs beyond the newest-N count cap', async () => {
    const now = Date.now()
    // 5 dirs, all well past the 10-minute floor, none past the age cap.
    for (let i = 0; i < 5; i++) {
      makeBackupDir(`d${i}`, DAY_MS + i * 1000, now)
    }
    const result = await gcBackups(root, { keepNewest: 3, maxAgeDays: 365, now: () => now })
    expect(result.kept).toBe(3)
    expect(result.deleted).toHaveLength(2)
    // The two OLDEST (d3, d4 — largest ageMs) are the ones pruned.
    expect(result.deleted.sort()).toEqual(['d3', 'd4'])
    expect(existsSync(join(root, '.desde', 'backups', 'd0'))).toBe(true)
    expect(existsSync(join(root, '.desde', 'backups', 'd3'))).toBe(false)
  })

  it('prunes dirs beyond the max-age cap regardless of count', async () => {
    const now = Date.now()
    makeBackupDir('fresh', DAY_MS, now)
    makeBackupDir('stale', 20 * DAY_MS, now)
    const result = await gcBackups(root, { keepNewest: 200, maxAgeDays: 14, now: () => now })
    expect(result.deleted).toEqual(['stale'])
    expect(result.kept).toBe(1)
    expect(existsSync(join(root, '.desde', 'backups', 'fresh'))).toBe(true)
  })

  it('never deletes a dir younger than the 10-minute floor, even with keepNewest: 0', async () => {
    const now = Date.now()
    makeBackupDir('just-written', 60_000, now) // 1 minute old
    const result = await gcBackups(root, { keepNewest: 0, maxAgeDays: 0.0001, now: () => now })
    expect(result.deleted).toEqual([])
    expect(result.kept).toBe(1)
    expect(existsSync(join(root, '.desde', 'backups', 'just-written'))).toBe(true)
  })

  it('respects config overrides for keepNewest and maxAgeDays', async () => {
    const now = Date.now()
    makeBackupDir('a', 2 * DAY_MS, now)
    makeBackupDir('b', 2 * DAY_MS, now)
    // maxAgeDays override of 1 day prunes both (both are 2 days old).
    const result = await gcBackups(root, { keepNewest: 200, maxAgeDays: 1, now: () => now })
    expect(result.deleted.sort()).toEqual(['a', 'b'])
    expect(result.kept).toBe(0)
  })

  // The next three tests inject fake `readdir`/`stat`/`rm` (via
  // `BackupsGcOptions.fs`) rather than `vi.spyOn`/`vi.mock` on
  // `node:fs/promises`: its ESM exports are non-configurable
  // (`vi.spyOn` throws "Cannot redefine property"), and an async
  // `vi.mock` factory proved unreliable for making only ONE call among
  // several fail while the rest hit the real filesystem. Dependency
  // injection sidesteps both and needs no chmod-based fault injection
  // (which isn't portable — root-run CI containers ignore permission
  // bits).
  it('tolerates a delete failure on one entry and still prunes the rest (never throws)', async () => {
    const now = Date.now()
    makeBackupDir('boom', 20 * DAY_MS, now)
    makeBackupDir('fine', 20 * DAY_MS, now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await gcBackups(root, {
      keepNewest: 200,
      maxAgeDays: 1,
      now: () => now,
      fs: {
        readdir,
        stat,
        rm: (async (path: Parameters<typeof rm>[0], opts?: Parameters<typeof rm>[1]) => {
          if (String(path).includes('boom')) throw new Error('simulated EACCES')
          return rm(path, opts)
        }) as typeof rm,
      },
    })
    // 'boom' failed to delete — it's still on disk, counted as kept.
    expect(result.deleted).toEqual(['fine'])
    expect(result.kept).toBe(1)
    expect(existsSync(join(root, '.desde', 'backups', 'boom'))).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('tolerates a stat failure on one entry (logs + skips, does not throw)', async () => {
    const now = Date.now()
    makeBackupDir('normal', DAY_MS, now)
    mkdirSync(join(root, '.desde', 'backups', 'ghost'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await gcBackups(root, {
      now: () => now,
      fs: {
        readdir,
        rm,
        stat: (async (path: Parameters<typeof stat>[0]) => {
          if (String(path).includes('ghost')) throw new Error('simulated ENOENT race')
          return stat(path)
        }) as typeof stat,
      },
    })
    // 'ghost' failed to stat — excluded from both deleted and kept counts
    // but tracked in `errors` (codex round 1: `kept` must not silently
    // under-report the true directory count still on disk).
    expect(result.kept).toBe(1)
    expect(result.errors).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a listing failure (unreadable backups dir) returns empty and logs, never throws', async () => {
    mkdirSync(join(root, '.desde', 'backups'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await gcBackups(root, {
      fs: {
        readdir: (async () => {
          throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' })
        }) as unknown as typeof readdir,
        stat,
        rm,
      },
    })
    expect(result).toEqual({ deleted: [], kept: 0, errors: 0 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
