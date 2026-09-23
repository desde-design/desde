/**
 * Unit tests for `writeBackupJournal` — mainly the containment check added
 * in the Task 14 review round-1 CRITICAL fix.
 *
 * The bug: a `file` key that resolves OUTSIDE the fresh
 * `.desde/backups/<ts>-<uuid>/` directory once joined against it
 * (e.g. enough leading `../` segments) let a caller's journal entry land
 * anywhere on the filesystem, with intermediate directories auto-created
 * by `mkdir(..., { recursive: true })`. This module doesn't know or care
 * whether `entry.file` came from a request the CALLER already proved
 * resolves inside the repo root — see `edit-handler.ts`'s `repoRelOf` for
 * why a key that passes THAT check can still be dangerous here — so it
 * validates independently, as the defense-in-depth backstop for every
 * caller (current and future).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  writeBackupJournal,
  BackupJournalPathEscapeError,
} from './backup-journal'
import { DesdeDirSymlinkError } from '../worktree/desde-dir'

describe('writeBackupJournal', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'backup-journal-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes entries into a fresh timestamp+uuid directory', async () => {
    const result = await writeBackupJournal(root, [
      { file: 'App.vue', content: 'ORIGINAL' },
      { file: 'src/nested/Card.vue', content: 'NESTED-ORIGINAL' },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backupDir).toMatch(/^\.desde[/\\]backups[/\\]/)
    expect(readFileSync(join(root, result.backupDir, 'App.vue'), 'utf8')).toBe('ORIGINAL')
    expect(readFileSync(join(root, result.backupDir, 'src/nested/Card.vue'), 'utf8')).toBe(
      'NESTED-ORIGINAL',
    )
  })

  it('rejects a `..`-escaping key and writes NOTHING (not even for other entries in the batch)', async () => {
    // A handful of `../` is enough to pop past `.desde/backups/<ts>-
    // <uuid>/` (3 segments) regardless of where `root` itself lives.
    const escaping = '../../../../canary/Pwned.vue'

    await expect(
      writeBackupJournal(root, [
        { file: 'App.vue', content: 'LEGIT' },
        { file: escaping, content: 'MALICIOUS' },
      ]),
    ).rejects.toThrow(BackupJournalPathEscapeError)

    // Nothing touched disk — validation runs for every entry BEFORE any
    // of them are written, so the legitimate sibling entry didn't land
    // either.
    expect(existsSync(join(root, '.desde'))).toBe(false)
    // And nothing escaped upward from `root` — walk up a few levels
    // looking for the canary the escaping key targeted.
    let probe = root
    for (let i = 0; i < 6; i++) {
      probe = dirname(probe)
      expect(existsSync(join(probe, 'canary', 'Pwned.vue'))).toBe(false)
    }
  })

  it('rejects an absolute path key', async () => {
    await expect(
      writeBackupJournal(root, [{ file: '/etc/Pwned.vue', content: 'X' }]),
    ).rejects.toThrow(BackupJournalPathEscapeError)
    expect(existsSync(join(root, '.desde'))).toBe(false)
  })

  it('accepts a key that merely CONTAINS ".." as a literal path segment name, not a traversal', async () => {
    // Sanity check that the containment check isn't a blunt string match
    // on "..' — a legitimately-named `..foo` directory/file segment is
    // fine as long as the resolved path stays inside backupDir.
    const result = await writeBackupJournal(root, [{ file: '..foo/Bar.vue', content: 'OK' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readFileSync(join(root, result.backupDir, '..foo/Bar.vue'), 'utf8')).toBe('OK')
  })

  it('rejects a symlinked .desde and writes nothing outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'backup-journal-outside-'))
    symlinkSync(outside, join(root, '.desde'))

    await expect(
      writeBackupJournal(root, [{ file: 'App.vue', content: 'ORIGINAL' }]),
    ).rejects.toThrow(DesdeDirSymlinkError)

    expect(existsSync(join(outside, 'backups'))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  it('the error names the offending key', async () => {
    try {
      await writeBackupJournal(root, [{ file: '../../../../x/Pwned.vue', content: 'X' }])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(BackupJournalPathEscapeError)
      expect((err as BackupJournalPathEscapeError).file).toBe('../../../../x/Pwned.vue')
      expect((err as Error).message).toContain('../../../../x/Pwned.vue')
    }
  })
})
