import { describe, expect, it } from 'vitest'
import { planLedgerUndo } from './undo-entry'
import type { LedgerEditEntry } from './entry'

function entry(over: Partial<LedgerEditEntry> = {}): LedgerEditEntry {
  return {
    type: 'edit',
    id: 'e1',
    at: '2026-08-19T10:00:00.000Z',
    kind: 'prop',
    lane: 'direct',
    files: ['src/App.vue'],
    backupDir: '.desde/backups/1-abc',
    afterHashes: { 'src/App.vue': 'HASH_AFTER' },
    ...over,
  }
}

const deps = {
  hashFile: async (repoRel: string) => (repoRel === 'src/App.vue' ? 'HASH_AFTER' : null),
  backupDirExists: async () => true,
  readBackup: async () => Buffer.from('before'),
  backupHasFile: async () => true,
}

describe('planLedgerUndo', () => {
  it('plans a restore when every hash still matches', async () => {
    const plan = await planLedgerUndo(entry(), deps)
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('expected ok')
    expect(plan.ops).toEqual([
      { kind: 'restore', repoRel: 'src/App.vue', content: Buffer.from('before') },
    ])
  })

  it('refuses when a file changed after the edit', async () => {
    const plan = await planLedgerUndo(entry(), {
      ...deps,
      hashFile: async () => 'DIFFERENT',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('drifted')
    // The reason names the file, because "something changed" is unactionable.
    expect(plan.reason).toContain('src/App.vue')
  })

  it('refuses when the file is gone', async () => {
    const plan = await planLedgerUndo(entry(), { ...deps, hashFile: async () => null })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('drifted')
  })

  it('refuses when the backup was cleaned up', async () => {
    const plan = await planLedgerUndo(entry(), { ...deps, backupDirExists: async () => false })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('backup-gone')
  })

  it('deletes the file when the entry created it (no backupDir, recorded in createdFiles)', async () => {
    const plan = await planLedgerUndo(
      entry({ backupDir: undefined, createdFiles: ['src/App.vue'] }),
      deps,
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('expected ok')
    expect(plan.ops).toEqual([{ kind: 'delete', repoRel: 'src/App.vue' }])
  })

  // P1-1 (codex review ROUND 3, 2026-08-20): a missing `backupDir` used
  // to be read, on its own, as proof the edit created EVERY file it
  // touched. That's the same ambiguity round 1's P1-3 fix closed for the
  // "backup exists but lacks this file" case, left open for the
  // "backup was never taken at all" case: `manage_package`'s
  // lockfile-tracking append (`fs-structural-tools.ts`) writes exactly
  // this shape — an `afterHash` with no `backupDir` — even when the
  // lockfile already existed. Before this fix, undo would DELETE it.
  it('refuses (never deletes) when the entry has no backup at all and does not record the file as created', async () => {
    const plan = await planLedgerUndo(entry({ backupDir: undefined }), deps)
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('unbacked')
    expect(plan.reason).toContain('src/App.vue')
  })

  it('refuses (never deletes) when the entry has no backup at all and createdFiles is an empty array', async () => {
    const plan = await planLedgerUndo(
      entry({ backupDir: undefined, createdFiles: [] }),
      deps,
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('unbacked')
  })

  it('deletes a file the backup does not contain when the entry recorded it as created, and restores one it does', async () => {
    const plan = await planLedgerUndo(
      entry({
        files: ['src/App.vue', 'src/New.vue'],
        afterHashes: { 'src/App.vue': 'HASH_AFTER', 'src/New.vue': 'HASH_NEW' },
        createdFiles: ['src/New.vue'],
      }),
      {
        ...deps,
        hashFile: async (f) => (f === 'src/App.vue' ? 'HASH_AFTER' : 'HASH_NEW'),
        backupHasFile: async (f) => f === 'src/App.vue',
      },
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('expected ok')
    expect(plan.ops).toEqual([
      { kind: 'restore', repoRel: 'src/App.vue', content: Buffer.from('before') },
      { kind: 'delete', repoRel: 'src/New.vue' },
    ])
  })

  // P1-3 (codex review finding, 2026-08-20): a file missing from the
  // backup does NOT by itself prove the edit created it — a backup
  // directory can survive while one of its children was removed or
  // became unreadable (an interrupted retention GC is the obvious way).
  // Before this fix, `backupHasFile` returning false was treated as
  // proof of creation on its own, and undo would DELETE the user's
  // current file for what was really just an overwrite with a damaged
  // backup. The safe direction is to refuse, not guess.
  it('refuses (never deletes) when the backup lacks a file the entry did NOT record as created', async () => {
    const plan = await planLedgerUndo(
      entry({
        files: ['src/App.vue', 'src/Mystery.vue'],
        afterHashes: { 'src/App.vue': 'HASH_AFTER', 'src/Mystery.vue': 'HASH_MYSTERY' },
        // createdFiles deliberately omits 'src/Mystery.vue' — the entry
        // itself never claimed this edit created it.
        createdFiles: [],
      }),
      {
        ...deps,
        hashFile: async (f) => (f === 'src/App.vue' ? 'HASH_AFTER' : 'HASH_MYSTERY'),
        backupHasFile: async (f) => f === 'src/App.vue',
      },
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('backup-gone')
    expect(plan.reason).toContain('src/Mystery.vue')
  })

  // Same ambiguous case, but on an entry written BEFORE `createdFiles`
  // existed at all (the field is absent, not an empty array). Absence
  // must read exactly like "not recorded," not like "recorded as
  // nothing created" — both refuse, but for the same reason: an old
  // entry gets no less safety than a new one that happens to have an
  // empty list.
  it('refuses when the backup lacks a file and the entry predates createdFiles entirely', async () => {
    const plan = await planLedgerUndo(
      entry({
        files: ['src/App.vue', 'src/Mystery.vue'],
        afterHashes: { 'src/App.vue': 'HASH_AFTER', 'src/Mystery.vue': 'HASH_MYSTERY' },
        createdFiles: undefined,
      }),
      {
        ...deps,
        hashFile: async (f) => (f === 'src/App.vue' ? 'HASH_AFTER' : 'HASH_MYSTERY'),
        backupHasFile: async (f) => f === 'src/App.vue',
      },
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('backup-gone')
  })

  it('refuses an entry with no afterHashes at all', async () => {
    const plan = await planLedgerUndo(entry({ afterHashes: {} }), deps)
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('expected refusal')
    expect(plan.code).toBe('unverifiable')
  })
})
