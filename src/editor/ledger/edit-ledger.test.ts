import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// F1 (round-9 whole-branch review finding, 2026-08-19) needs to force
// `currentBranch` to fail on demand, on a HEAD that is otherwise
// perfectly readable and symbolic — a real transient git failure has no
// deterministic trigger to script against. `currentBranch` itself never
// throws (it catches internally and resolves `null`), so the mock wraps
// the REAL implementation by default and only overrides individual
// calls where a test needs to simulate the failure; every other test in
// this file exercises the genuine `git` subprocess unchanged.
vi.mock('../worktree/git-branches', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worktree/git-branches')>()
  return { ...actual, currentBranch: vi.fn(actual.currentBranch) }
})
import { currentBranch } from '../worktree/git-branches'

import {
  appendLedgerEntry,
  hashContent,
  invalidateBranchCache,
  ledgerPath,
  readGitHeadRaw,
  readLedger,
  reconcileLedger,
  resolveBranchCached,
} from './edit-ledger'
import type { LedgerEditEntry } from './entry'

// `reconcileLedger` now requires POSITIVE evidence per file — an entry
// with no recorded hash for a file can never be proven committed (the
// same conservative default as an unresolvable branch/fingerprint). Most
// tests below aren't about that check itself, so `edit()` gives every
// file a real, deterministic hash by default (of the file's own NAME —
// arbitrary but stable) and `matchesEveryHash`/`matchesNoHash` stand in
// for "yes, HEAD holds this" / "no it doesn't" so each call site doesn't
// have to hand-build a predicate. A test that cares about the FILE-level
// detail (the multi-file partial-match case below) writes its own.
const matchesEveryHash = () => true
const matchesNoHash = () => false

function edit(id: string, files: string[], branch?: string): LedgerEditEntry {
  return {
    type: 'edit',
    id,
    at: '2026-08-18T10:00:00.000Z',
    kind: 'prop',
    lane: 'direct',
    files,
    afterHashes: Object.fromEntries(files.map((f) => [f, hashContent(f)])),
    ...(branch !== undefined ? { branch } : {}),
  }
}

describe('edit ledger', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'edit-ledger-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns an empty log when the file does not exist', async () => {
    expect(await readLedger(root)).toEqual([])
  })

  it('appends and reads back in order', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, edit('e2', ['b.vue']))
    const entries = await readLedger(root)
    expect(entries.map((e) => (e.type === 'edit' ? e.id : e.type))).toEqual(['e1', 'e2'])
  })

  it('writes one JSON object per line', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, edit('e2', ['b.vue']))
    const lines = readFileSync(ledgerPath(root), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).id).toBe('e1')
  })

  it('skips a malformed line instead of throwing', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    // Simulates a torn append after a crash.
    writeFileSync(ledgerPath(root), readFileSync(ledgerPath(root), 'utf8') + '{"type":"ed')
    await appendLedgerEntry(root, edit('e2', ['b.vue']))
    const entries = await readLedger(root)
    expect(entries.map((e) => (e.type === 'edit' ? e.id : e.type))).toEqual(['e1', 'e2'])
  })

  it('skips a line that parses but is not a known entry type', async () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    writeFileSync(ledgerPath(root), '{"type":"nonsense"}\n')
    expect(await readLedger(root)).toEqual([])
  })

  it('skips a line whose type is valid but required fields are missing', async () => {
    // A line that parses and carries a recognised `type` discriminant is
    // NOT automatically a well-formed entry — `readLedger`'s contract is
    // to tolerate a torn/corrupt line, and `{"type":"edit"}` with nothing
    // else is exactly that: an entry a downstream reader (the ledger
    // route) cannot safely render (no `id`, no `files` to derive a
    // description from).
    mkdirSync(join(root, '.desde'), { recursive: true })
    writeFileSync(ledgerPath(root), '{"type":"edit"}\n')
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    const entries = await readLedger(root)
    expect(entries.map((e) => (e.type === 'edit' ? e.id : e.type))).toEqual(['e1'])
  })

  it('skips a commit line missing its sha or message', async () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    writeFileSync(
      ledgerPath(root),
      '{"type":"commit","at":"2026-08-18T10:00:00.000Z"}\n',
    )
    expect(await readLedger(root)).toEqual([])
  })

  it('skips a reconcile line missing its committedIds array', async () => {
    mkdirSync(join(root, '.desde'), { recursive: true })
    writeFileSync(
      ledgerPath(root),
      '{"type":"reconcile","at":"2026-08-18T10:00:00.000Z"}\n',
    )
    expect(await readLedger(root)).toEqual([])
  })

  it('never throws when the ledger cannot be written', async () => {
    // A path that cannot hold `.desde/` — append must swallow it.
    await expect(appendLedgerEntry(join(root, 'no', 'such', '\0bad'), edit('e1', ['a.vue'])))
      .resolves.toBeUndefined()
  })

  it('writes nothing outside the worktree when .desde is a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'edit-ledger-outside-'))
    symlinkSync(outside, join(root, '.desde'))

    // Best-effort by contract (a ledger failure must never fail the
    // source write it accompanies) — it resolves, not rejects, and
    // writes nothing at the symlink target.
    await expect(appendLedgerEntry(root, edit('e1', ['a.vue']))).resolves.toBeUndefined()
    expect(existsSync(join(outside, 'edit-log.jsonl'))).toBe(false)

    rmSync(outside, { recursive: true, force: true })
  })

  describe('backupDir containment (P1, codex review round 5, SECURITY)', () => {
    // The ledger file (`.desde/edit-log.jsonl`) lives INSIDE the
    // repository — so every field on a line, including `backupDir`, is
    // attacker-controlled for anyone who can get a repo opened in the
    // Editor. This is the DEFENSE-IN-DEPTH layer: a purely lexical
    // (`path.resolve`, no `fs.realpath`) pre-filter at the ledger's disk
    // layer, so every OTHER consumer of `readLedger`'s output (not just
    // the undo route) inherits a truthful `backupDir`. The AUTHORITATIVE
    // check — realpath, right before any stat/read — lives in
    // `createRealUndoDeps` (`editor-cli/src/server/http-server.ts`) and
    // is exercised end to end in `ledger-undo-route.test.ts`, including
    // the symlink case this purely-lexical check cannot see.

    it('strips a backupDir that escapes .desde/backups via ../, leaving the rest of the entry intact', async () => {
      const evil: LedgerEditEntry = {
        ...edit('evil-1', ['id_rsa']),
        backupDir: '../../../../home/user/.ssh',
        afterHashes: { id_rsa: 'deadbeef' },
      }
      await appendLedgerEntry(root, evil)
      const [entry] = await readLedger(root)
      expect(entry.type).toBe('edit')
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.backupDir).toBeUndefined()
      // Everything else survives untouched — this is a field-level
      // sanitization, not a whole-entry drop.
      expect(entry.id).toBe('evil-1')
      expect(entry.files).toEqual(['id_rsa'])
      expect(entry.afterHashes).toEqual({ id_rsa: 'deadbeef' })
    })

    it('strips a backupDir given as an absolute path outside the repo', async () => {
      // `path.resolve(canonicalRoot, backupDir, ...)` treats a leading
      // absolute segment as an anchor that overrides `canonicalRoot`
      // entirely (unlike `path.join`, which would nest it) — so an
      // absolute `backupDir` is a second, simpler way to reach the same
      // escape as a `../`-heavy relative one, and must be caught too.
      const evil: LedgerEditEntry = {
        ...edit('evil-2', ['id_rsa']),
        backupDir: '/etc',
        afterHashes: { id_rsa: 'deadbeef' },
      }
      await appendLedgerEntry(root, evil)
      const [entry] = await readLedger(root)
      expect(entry.type).toBe('edit')
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.backupDir).toBeUndefined()
    })

    it('leaves a legitimate backupDir under .desde/backups untouched', async () => {
      const legit: LedgerEditEntry = {
        ...edit('legit-1', ['App.vue']),
        backupDir: '.desde/backups/2026-08-20_10-00-00-000-abc',
        afterHashes: { 'App.vue': 'deadbeef' },
      }
      await appendLedgerEntry(root, legit)
      const [entry] = await readLedger(root)
      expect(entry.type).toBe('edit')
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.backupDir).toBe('.desde/backups/2026-08-20_10-00-00-000-abc')
    })

    it('leaves an entry with no backupDir at all untouched', async () => {
      await appendLedgerEntry(root, edit('no-backup-1', ['App.vue']))
      const [entry] = await readLedger(root)
      expect(entry.type).toBe('edit')
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.backupDir).toBeUndefined()
    })
  })

  describe('createdFiles validation (P2-2, codex review round 6, SECURITY)', () => {
    // `isLedgerEntry`'s TypeScript signature (`value is LedgerEntry`)
    // can't stop a malformed value from reaching it at RUNTIME — the
    // ledger file lives INSIDE the repository, so a corrupted or cloned
    // `.desde/edit-log.jsonl` is an ordinary condition here, not an
    // attack-only one (the log is append-only and already tolerates torn
    // lines by design). Before this fix `createdFiles` reached every
    // consumer as whatever JSON value the line happened to carry:
    // `activity-row.tsx`'s `changeTypeForRow`/`undoAvailability` call
    // `.includes()` on it directly. An object or number there CRASHES the
    // Activity render; a bare STRING silently does JS substring matching
    // instead of array membership (`"src/App.vue".includes("App.vue")`
    // is `true`), which can misclassify a row AND feeds the identical bad
    // value into `planLedgerUndo`, where it is exactly the signal that
    // authorizes a delete.
    //
    // Each malformed case drops the WHOLE entry — the same treatment
    // `isLedgerEntry` already gives a malformed `files`/`afterHashes`: a
    // torn/corrupt line is tolerated by being skipped, never by being
    // half-trusted.

    function writeRawLine(json: unknown): void {
      mkdirSync(join(root, '.desde'), { recursive: true })
      writeFileSync(ledgerPath(root), `${JSON.stringify(json)}\n`)
    }

    const base = {
      type: 'edit',
      id: 'e1',
      at: '2026-08-18T10:00:00.000Z',
      kind: 'prop',
      lane: 'direct',
      files: ['App.vue'],
      afterHashes: {},
    }

    it('drops an entry whose createdFiles is an object', async () => {
      writeRawLine({ ...base, createdFiles: { evil: true } })
      expect(await readLedger(root)).toEqual([])
    })

    it('drops an entry whose createdFiles is a number', async () => {
      writeRawLine({ ...base, createdFiles: 42 })
      expect(await readLedger(root)).toEqual([])
    })

    it('drops an entry whose createdFiles is a bare string (not an array)', async () => {
      // The specific exploit shape the task names: a plain string
      // authorizes a delete for any file whose path happens to be a
      // SUBSTRING of it, via `String.prototype.includes` running instead
      // of `Array.prototype.includes`.
      writeRawLine({ ...base, createdFiles: 'App.vue' })
      expect(await readLedger(root)).toEqual([])
    })

    it('drops an entry whose createdFiles array contains a non-string element', async () => {
      writeRawLine({ ...base, createdFiles: ['App.vue', 42] })
      expect(await readLedger(root)).toEqual([])
    })

    it('keeps an entry whose createdFiles is a genuine string array', async () => {
      writeRawLine({ ...base, createdFiles: ['App.vue'] })
      const entries = await readLedger(root)
      expect(entries).toHaveLength(1)
      const [entry] = entries
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.createdFiles).toEqual(['App.vue'])
    })

    it('keeps an entry with no createdFiles field at all (pre-P1-3 entries)', async () => {
      writeRawLine(base)
      const entries = await readLedger(root)
      expect(entries).toHaveLength(1)
      const [entry] = entries
      if (entry.type !== 'edit') throw new Error('expected an edit entry')
      expect(entry.createdFiles).toBeUndefined()
    })
  })

  it('reconciles edits whose files are all clean', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, edit('e2', ['b.vue']))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      (f) => f === 'b.vue',
      matchesEveryHash,
    )
    expect(reconciled).toEqual(['e1'])
    const entries = await readLedger(root)
    const last = entries[entries.length - 1]
    expect(last.type).toBe('reconcile')
    expect(last.type === 'reconcile' && last.committedIds).toEqual(['e1'])
  })

  it('writes no reconcile line when nothing changed', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => true,
      matchesEveryHash,
    )
    expect(reconciled).toEqual([])
    expect((await readLedger(root)).every((e) => e.type === 'edit')).toBe(true)
  })

  it('does not reconcile an edit twice', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await reconcileLedger(root, await readLedger(root), () => false, matchesEveryHash)
    // Re-reads: the first reconcile appended a `reconcile` line, and the
    // second call must see it to know e1 is already accounted for.
    const second = await reconcileLedger(root, await readLedger(root), () => false, matchesEveryHash)
    expect(second).toEqual([])
  })

  // P1 (round-4 whole-branch review finding, 2026-08-19): reconcile used
  // to re-read the ledger from disk ITSELF, after the caller had already
  // taken its `git status` snapshot. An edit landing in that window
  // appended a ledger line the re-read then saw — but its file was never
  // in the already-captured dirty set, because status ran before the
  // edit wrote. The still-uncommitted edit got durably marked committed.
  //
  // This reproduces the exact interleaving the finding describes:
  //   1. take a status snapshot (nothing dirty yet — the edit hasn't
  //      landed)
  //   2. an edit lands: it appends its ledger line
  //   3. reconcile runs
  // and asserts the late entry is NOT marked committed. The fix moves
  // the ledger read OUT of `reconcileLedger` and onto the caller, whose
  // contract is now: read the ledger BEFORE taking the status snapshot.
  // Simulating that correct order here means capturing `entries` before
  // step 2, not after — which is exactly what excludes the late entry.
  it('does not mark an edit committed when its ledger line is appended after the entries snapshot passed to reconcile', async () => {
    // Step 1: the caller's ledger read, taken before the status
    // snapshot and before the race — empty, since nothing has been
    // appended yet.
    const entriesBeforeRace = await readLedger(root)
    // The status snapshot itself: nothing is dirty, because at the
    // moment status ran, the edit below had not yet written its file.
    const dirty = new Set<string>()

    // Step 2: an edit lands IN the race window — it appends its ledger
    // line after `entriesBeforeRace` was captured.
    await appendLedgerEntry(root, edit('late', ['b.vue']))

    // Step 3: reconcile runs. Passing `entriesBeforeRace` (not a fresh
    // `readLedger(root)`) is the fixed caller's contract — the late
    // entry is simply not a candidate this round.
    const reconciled = await reconcileLedger(
      root,
      entriesBeforeRace,
      (f) => dirty.has(f),
      matchesEveryHash,
    )
    expect(reconciled).toEqual([])

    // Nothing durable was written naming the late entry — no reconcile
    // line at all, since the only entry that existed pre-snapshot was
    // none.
    const entries = await readLedger(root)
    expect(entries.every((e) => e.type === 'edit')).toBe(true)
  })

  it('does reconcile the same edit once a LATER read captures it before the next status snapshot', async () => {
    // Same edit as above, but now simulating the NEXT poll: this time
    // the caller's read happens after the edit has already landed, so
    // it is a legitimate candidate.
    await appendLedgerEntry(root, edit('late', ['b.vue']))
    const entries = await readLedger(root)
    // On this next poll, the file genuinely reads clean (e.g. the user
    // committed it in their own terminal in between).
    const reconciled = await reconcileLedger(root, entries, () => false, matchesEveryHash)
    expect(reconciled).toEqual(['late'])
  })

  // LIVE SMOKE FINDING (2026-08-20) — the defect this whole file's fix is
  // for. "Clean" alone was never proof: a file reads clean because an
  // edit was committed, OR because something else (a `git checkout --`
  // discarding it, an ignored path git can't see, a stash) put it back
  // the way it was. `matchesHeadContent` returning `false` is how a
  // caller reports either of those — this is pure-reducer coverage of
  // "clean + no positive evidence ⇒ still not committed," no real git
  // involved. See the sibling integration test
  // (`http-server-ledger-commit.integration.test.ts`, "an edit to a
  // .gitignore'd file stays pending…") for the real-git, real-HTTP-route
  // version, and the "reconcileLedger against a real repo" block below
  // for the exact `git checkout --` repro this finding names.
  //
  // This also documents why the OLD `isIgnored` parameter was removed
  // rather than kept alongside this check: an ignored path is always
  // untracked (MEASURED, see `reconcileLedger`'s own doc comment), so it
  // was always going to fail a positive-evidence check anyway — this
  // test's fake `matchesHeadContent` stands in for that outcome without
  // needing a real git repo to prove it.
  it('does not reconcile an edit whose content is unconfirmed against HEAD, even though it reads clean', async () => {
    await appendLedgerEntry(root, edit('e1', ['ignored.txt']))
    // Clean by `isDirty`'s own account — this is exactly the ambiguous
    // case: "not dirty" on its own can't distinguish "committed" from
    // "HEAD doesn't hold this."
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesNoHash,
    )
    expect(reconciled).toEqual([])
    expect((await readLedger(root)).every((e) => e.type === 'edit')).toBe(true)
  })

  it('reconciles an edit once its file is clean AND its content is confirmed against HEAD', async () => {
    await appendLedgerEntry(root, edit('e1', ['App.vue']))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
    )
    expect(reconciled).toEqual(['e1'])
  })

  // The multi-file, partial-evidence case: never write a wrong permanent
  // marker. Both files are clean (`isDirty` always `false`), but only
  // `App.vue`'s content is confirmed against HEAD — `other.vue` is clean
  // for some OTHER reason (never committed, or overwritten by something
  // else entirely). Marking the entry committed anyway would be exactly
  // the false-permanent-"Committed" defect this file's fix closes, just
  // for one file out of several instead of all of them.
  it('does not reconcile a multi-file edit when only ONE of its files is confirmed against HEAD', async () => {
    await appendLedgerEntry(root, edit('e1', ['App.vue', 'other.vue']))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      (repoRel) => repoRel === 'App.vue',
    )
    expect(reconciled).toEqual([])
  })

  // Whole-branch review finding (Important, 2026-08-18): reconcile used
  // to have no notion of branch at all, so a pending edit recorded on
  // ANOTHER branch got checked against THIS branch's clean tree — a
  // stash-and-switch durably marked it "committed" though nothing on
  // that branch was ever committed.
  it('does not reconcile an edit recorded on a different branch, even when its files read clean', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue'], 'feature'))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      'main',
    )
    expect(reconciled).toEqual([])
    expect((await readLedger(root)).every((e) => e.type === 'edit')).toBe(true)
  })

  it('reconciles an edit recorded on the current branch', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue'], 'main'))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      'main',
    )
    expect(reconciled).toEqual(['e1'])
  })

  it('reconciles an edit with no recorded branch regardless of the current branch', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      'feature',
    )
    expect(reconciled).toEqual(['e1'])
  })

  // P1-2 (codex review round 3, 2026-08-20). Undoing an UNCOMMITTED
  // edit whose pre-edit bytes happen to already match HEAD makes the
  // file clean again — not because anything was committed, but because
  // the restore landed on content HEAD already held. Before this fix,
  // `reconcileLedger` read that cleanliness as proof of a commit it
  // never observed and durably marked BOTH the original edit (`e1`) and
  // the undo entry that reverted it (`undo-1`, `reverts: 'e1'`)
  // committed. Neither should reconcile — no `git commit` ever ran.
  it('does not reconcile an entry that was undone, or the undo entry that reverted it, even though the file reads clean', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      afterHashes: {},
      reverts: 'e1',
    })
    // `isDirty` always returns false — 'a.vue' now matches HEAD exactly,
    // the state undo produced.
    const reconciled = await reconcileLedger(root, await readLedger(root), () => false, matchesEveryHash)
    expect(reconciled).toEqual([])
  })

  // Same pair, but a GENUINE commit happens after the undo (the user
  // edits 'a.vue' again and commits it for real, or commits something
  // unrelated while 'a.vue' happens to be dirty from a later edit not
  // shown here) — `revertedEntryIds`/`reverts` must not blanket-refuse
  // an UNRELATED entry that merely shares no connection to the pair.
  it('still reconciles an unrelated clean entry alongside an undone pair', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      afterHashes: {},
      reverts: 'e1',
    })
    await appendLedgerEntry(root, edit('e2', ['b.vue']))
    const reconciled = await reconcileLedger(root, await readLedger(root), () => false, matchesEveryHash)
    expect(reconciled).toEqual(['e2'])
  })

  // F1 (codex review round 4, 2026-08-20): round 3's fix above excluded
  // the undo entry FOREVER. That is wrong whenever the user commits from
  // their own terminal after the undo — no `commit` line is ever written
  // for it, so the permanent exclusion meant this entry could never
  // self-heal into "Committed" even once HEAD had genuinely moved past
  // it. `headAtWrite` (recorded on the undo entry at write time) lets
  // this function tell the two cases apart: no `headFingerprint` passed
  // at all is the conservative default (unchanged from round 3 — a
  // caller that hasn't been updated must not start advancing entries it
  // used to protect).
  it('without a headFingerprint, still excludes the undo entry forever (unchanged default)', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      afterHashes: {},
      reverts: 'e1',
      headAtWrite: 'ref: refs/heads/main',
    })
    const reconciled = await reconcileLedger(root, await readLedger(root), () => false, matchesEveryHash)
    expect(reconciled).toEqual([])
  })

  it('excludes the undo entry while the current HEAD still matches the fingerprint recorded at its own write time', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      afterHashes: {},
      reverts: 'e1',
      headAtWrite: 'ref: refs/heads/main',
    })
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      undefined,
      'ref: refs/heads/main',
    )
    expect(reconciled).toEqual([])
  })

  it('reconciles the undo entry once the current HEAD differs from the fingerprint recorded at its own write time (a real commit landed after the undo)', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      // Once the `headAtWrite` bracket expires (below), this entry falls
      // through to the SAME positive-evidence check every ordinary entry
      // gets — unlike the other tests in this block, it must actually
      // pass it to reconcile, so it needs a real recorded hash here (the
      // `edit()` helper's `hashContent(filename)` convention, matched by
      // `matchesEveryHash` ignoring its arguments and always confirming).
      afterHashes: { 'a.vue': hashContent('a.vue') },
      reverts: 'e1',
      headAtWrite: 'ref: refs/heads/main',
    })
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      undefined,
      // A different sha — HEAD moved (a real commit landed) since the
      // undo's own write.
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    )
    // The undo entry itself reconciles; the entry it reverted (`e1`)
    // never does — see the "does not reconcile an entry that was
    // undone" test above, which this must not regress.
    expect(reconciled).toEqual(['undo-1'])
  })

  it('still excludes an undo entry written before headAtWrite existed, even with a headFingerprint passed (degrades to the conservative default)', async () => {
    await appendLedgerEntry(root, edit('e1', ['a.vue']))
    await appendLedgerEntry(root, {
      type: 'edit',
      id: 'undo-1',
      at: '2026-08-18T10:01:00.000Z',
      kind: 'undo',
      lane: 'undo',
      files: ['a.vue'],
      afterHashes: {},
      reverts: 'e1',
      // No `headAtWrite` — an entry written before this field existed.
    })
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      undefined,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    )
    expect(reconciled).toEqual([])
  })

  // P1-2 (round-3 whole-branch review finding, 2026-08-19), corrected by
  // F2 (round-10, a regression IN round 3's own fix). Round 3's scenario:
  // a direct-lane edit written on a WINDOWS host carried a backslash-
  // separated path (`src\App.vue`), because the pre-fix `repoRelOf`
  // (editor-cli's `edit-handler.ts`) built ledger paths from the
  // platform-bound `node:path.relative`. `git status --porcelain` reports
  // the SAME file as `src/App.vue` on every OS — it's plumbing output,
  // always forward-slash — so the exact-string comparison this function
  // makes (`entry.files.some((f) => isDirty(f))`) found no match on that
  // SAME Windows host: the file read as clean even though it was
  // genuinely still dirty, and got swept into a durable `reconcile`
  // marker calling it committed (the log is append-only, so a wrong
  // "committed" can never be un-said). `normalize-path.test.ts` proves
  // that half deterministically, by injecting `path.sep` as an explicit
  // argument — the only call site that can, since `reconcileLedger` has
  // no separator parameter of its own to inject through.
  //
  // What THIS suite's real host (POSIX) can prove directly, and the
  // round-10 regression this asserts against instead: round 3's fix
  // folded `\` into `/` UNCONDITIONALLY, on every platform — which also
  // silently rewrote a GENUINELY POSIX path that happens to contain a
  // literal backslash. Round 10 scopes the fold to platforms whose
  // separator actually IS `\`. On THIS host, `src\App.vue` is therefore
  // left exactly as stored — a distinct literal string, not an
  // equivalent spelling of `src/App.vue` — so it does NOT match the
  // forward-slash dirty set below, and correctly reconciles: this
  // entry's file, spelled that way, simply isn't the one `dirty` is
  // reporting on THIS platform.
  it('does not conflate a backslash-separated ledger path with a differently-spelled dirty entry on this (POSIX) host', async () => {
    await appendLedgerEntry(root, edit('e1', ['src\\App.vue'], 'main'))
    // `dirty` mimics `listDirtyRepoRelativePaths` — always forward-slash,
    // built from real `git status` porcelain output.
    const dirty = new Set(['src/App.vue'])
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      (f) => dirty.has(f),
      matchesEveryHash,
      'main',
    )
    expect(reconciled).toEqual(['e1'])
  })

  it('reconciles a backslash-separated ledger path once its OWN literal spelling reads clean', async () => {
    await appendLedgerEntry(root, edit('e1', ['src\\App.vue'], 'main'))
    const reconciled = await reconcileLedger(
      root,
      await readLedger(root),
      () => false,
      matchesEveryHash,
      'main',
    )
    expect(reconciled).toEqual(['e1'])
  })

  it('hashes content stably across string and buffer', () => {
    expect(hashContent('hello')).toBe(hashContent(Buffer.from('hello')))
    expect(hashContent('hello')).not.toBe(hashContent('world'))
  })

  // LIVE SMOKE FINDING (2026-08-20) — the reproduction, against a REAL
  // repo with the REAL `readHeadBlobs` (not a fake predicate). Every test
  // above proves `reconcileLedger`'s own logic gates correctly on
  // whatever a predicate answers; this block proves the predicate this
  // codebase actually wires up (`readHeadBlobs` + `hashContent`, the
  // exact pairing `http-server.ts`'s `handleLedgerRequest` builds)
  // answers correctly against genuine git behavior — a fake `() => true`
  // predicate could never have caught the original defect, since the
  // defect WAS the missing check, not a bug in how reconcileLedger uses
  // one once supplied.
  describe('reconcileLedger against a real repo — positive evidence over cleanliness', () => {
    function git(repoRoot: string, ...args: string[]): void {
      execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' })
    }

    let repoRoot: string

    beforeEach(() => {
      repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'edit-ledger-real-git-')))
      git(repoRoot, 'init', '--initial-branch=main', '--quiet')
      git(repoRoot, 'config', 'user.email', 't@e.com')
      git(repoRoot, 'config', 'user.name', 'T')
      git(repoRoot, 'config', 'commit.gpgsign', 'false')
      writeFileSync(join(repoRoot, 'App.vue'), 'original\n')
      git(repoRoot, 'add', 'App.vue')
      git(repoRoot, 'commit', '-m', 'init', '--quiet')
    })

    afterEach(() => {
      rmSync(repoRoot, { recursive: true, force: true })
    })

    /** Mirrors exactly what `handleLedgerRequest` builds — see its own doc comment. */
    async function matchesRealHead(paths: readonly string[]) {
      const { readHeadBlobs } = await import('../worktree/git-branches')
      const blobs = await readHeadBlobs(repoRoot, paths)
      return (repoRel: string, expectedHash: string): boolean => {
        const content = blobs.get(repoRel)
        return content !== undefined && hashContent(content) === expectedHash
      }
    }

    // THE reproduction: make an edit, then discard it with `git checkout
    // --` — no commit anywhere — then reconcile. Before this fix, the
    // file reading clean was the WHOLE test, and this entry was marked
    // Committed. The Activity panel's "Committed" claim would have been
    // permanently wrong about an edit the user's own action just threw
    // away.
    it('does not mark an edit committed after the file is discarded with `git checkout --`, even though the tree is clean again', async () => {
      const editedContent = 'edited by the user\n'
      writeFileSync(join(repoRoot, 'App.vue'), editedContent)
      await appendLedgerEntry(repoRoot, {
        type: 'edit',
        id: 'e1',
        at: '2026-08-20T10:00:00.000Z',
        kind: 'prop',
        lane: 'direct',
        files: ['App.vue'],
        afterHashes: { 'App.vue': hashContent(editedContent) },
      })

      // The discard: restores App.vue to HEAD's committed content
      // ('original\n'), with no commit involved. The working tree is
      // clean again — exactly the condition the old, insufficient check
      // treated as proof.
      git(repoRoot, 'checkout', '--', 'App.vue')
      expect(readFileSync(join(repoRoot, 'App.vue'), 'utf8')).toBe('original\n')

      const entries = await readLedger(repoRoot)
      const matches = await matchesRealHead(['App.vue'])
      const reconciled = await reconcileLedger(repoRoot, entries, () => false, matches)

      expect(reconciled).toEqual([])
      expect((await readLedger(repoRoot)).every((e) => e.type === 'edit')).toBe(true)
    })

    // The positive control — equally important: a fix that simply stops
    // reconciling everything would also pass the test above. A genuine
    // commit of the edit's own content must still reconcile.
    it('marks an edit committed once its own content genuinely reaches a commit', async () => {
      const editedContent = 'edited by the user\n'
      writeFileSync(join(repoRoot, 'App.vue'), editedContent)
      await appendLedgerEntry(repoRoot, {
        type: 'edit',
        id: 'e1',
        at: '2026-08-20T10:00:00.000Z',
        kind: 'prop',
        lane: 'direct',
        files: ['App.vue'],
        afterHashes: { 'App.vue': hashContent(editedContent) },
      })

      git(repoRoot, 'add', 'App.vue')
      git(repoRoot, 'commit', '-m', 'edit', '--quiet')

      const entries = await readLedger(repoRoot)
      const matches = await matchesRealHead(['App.vue'])
      const reconciled = await reconcileLedger(repoRoot, entries, () => false, matches)

      expect(reconciled).toEqual(['e1'])
    })

    // Multi-file, against real git: one file's edit is genuinely
    // committed, the other is discarded the same way as the repro above.
    // Partial evidence must not reconcile the whole entry.
    it('does not reconcile a multi-file edit when only some of its files genuinely reached the commit', async () => {
      writeFileSync(join(repoRoot, 'Other.vue'), 'other original\n')
      git(repoRoot, 'add', 'Other.vue')
      git(repoRoot, 'commit', '-m', 'add Other.vue', '--quiet')

      const appEdited = 'App edited\n'
      const otherEdited = 'Other edited\n'
      writeFileSync(join(repoRoot, 'App.vue'), appEdited)
      writeFileSync(join(repoRoot, 'Other.vue'), otherEdited)
      await appendLedgerEntry(repoRoot, {
        type: 'edit',
        id: 'e1',
        at: '2026-08-20T10:00:00.000Z',
        kind: 'prop',
        lane: 'direct',
        files: ['App.vue', 'Other.vue'],
        afterHashes: { 'App.vue': hashContent(appEdited), 'Other.vue': hashContent(otherEdited) },
      })

      // Only App.vue's edit reaches a commit; Other.vue's is discarded.
      git(repoRoot, 'add', 'App.vue')
      git(repoRoot, 'commit', '-m', 'only App.vue', '--quiet')
      git(repoRoot, 'checkout', '--', 'Other.vue')

      const entries = await readLedger(repoRoot)
      const matches = await matchesRealHead(['App.vue', 'Other.vue'])
      const reconciled = await reconcileLedger(repoRoot, entries, () => false, matches)

      expect(reconciled).toEqual([])
    })
  })

  // P2-1 (whole-branch review finding, 2026-08-18): `resolveBranchCached`
  // never had a test of its own — this module's tests above never
  // exercise it (they run in a plain tmp dir with no git repo, so
  // `currentBranch` always resolves `null` regardless of caching). A real
  // repo is needed to tell "served the cache" apart from "recomputed and
  // got the same answer by coincidence".
  describe('resolveBranchCached / invalidateBranchCache', () => {
    function git(...args: string[]): void {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    }

    beforeEach(() => {
      git('init', '--initial-branch=main', '--quiet')
      git('config', 'user.email', 't@e.com')
      git('config', 'user.name', 'T')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(root, 'a.txt'), 'x')
      git('add', 'a.txt')
      git('commit', '-m', 'init', '--quiet')
    })

    it('resolves the current branch', async () => {
      expect(await resolveBranchCached(root)).toBe('main')
    })

    it('still returns the right name across repeated calls when nothing has changed', async () => {
      expect(await resolveBranchCached(root)).toBe('main')
      expect(await resolveBranchCached(root)).toBe('main')
      expect(await resolveBranchCached(root)).toBe('main')
    })

    // P2-1 (round-3 whole-branch review finding, 2026-08-19): this test
    // used to be named "serves the cached branch even after a real
    // switch, until invalidated" and asserted the STALE name here — that
    // assertion was pinning the bug in place. A user switching branches
    // from their OWN terminal calls no product handler and so never
    // calls `invalidateBranchCache` at all; the fix is that
    // `resolveBranchCached` no longer needs that call to notice.
    it('picks up a branch switch made from a bare terminal command, with no invalidateBranchCache call at all', async () => {
      expect(await resolveBranchCached(root)).toBe('main')
      // Mutate the checkout the way a user's OWN terminal would —
      // nothing in this product's code runs, so nothing calls
      // `invalidateBranchCache`.
      git('checkout', '-b', 'feature', '--quiet')
      expect(await resolveBranchCached(root)).toBe('feature')
    })

    it('picks up a branch rename made from a bare terminal command', async () => {
      expect(await resolveBranchCached(root)).toBe('main')
      git('branch', '-m', 'main', 'renamed-main')
      expect(await resolveBranchCached(root)).toBe('renamed-main')
    })

    it('invalidateBranchCache still works (harmless — the next call would self-correct regardless)', async () => {
      expect(await resolveBranchCached(root)).toBe('main')
      git('checkout', '-b', 'feature', '--quiet')
      invalidateBranchCache(root)
      expect(await resolveBranchCached(root)).toBe('feature')
    })

    it('invalidating an uncached root is a harmless no-op', () => {
      expect(() => invalidateBranchCache(join(root, 'never-resolved'))).not.toThrow()
    })
  })

  // F1 (round-9 whole-branch review finding, 2026-08-19): the cache is
  // keyed on a HEAD fingerprint (P2-1 above), not a TTL — but when HEAD
  // is SYMBOLIC (`ref: refs/heads/<name>`, a branch genuinely IS checked
  // out) and `currentBranch` transiently fails anyway, the old code
  // cached that `null` against the valid fingerprint. Every later call
  // then returned `undefined` with no retry, until HEAD's bytes next
  // changed — an edit made in that window lands with no branch on it
  // forever, and the ledger route's branch filter treats a no-branch
  // entry as eligible on EVERY branch, permanently un-scoping it. A
  // genuinely DETACHED HEAD (a bare sha, no `ref:` prefix) is the
  // opposite case: `null` there is the correct, STABLE answer, so it
  // should still be cached rather than re-spawning `git` on every call.
  describe('resolveBranchCached — F1 transient currentBranch failure vs. a genuine detached HEAD', () => {
    function git(...args: string[]): void {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    }

    beforeEach(() => {
      git('init', '--initial-branch=main', '--quiet')
      git('config', 'user.email', 't@e.com')
      git('config', 'user.name', 'T')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(root, 'a.txt'), 'x')
      git('add', 'a.txt')
      git('commit', '-m', 'init', '--quiet')
    })

    it('retries on the very next call after a transient failure on a SYMBOLIC HEAD, instead of caching the miss', async () => {
      // HEAD is symbolic (`ref: refs/heads/main`) the whole time — only
      // `currentBranch`'s own git spawn fails, once. The call count is
      // measured as a DELTA rather than an absolute — the mock is shared
      // across this whole describe block's tests, with no per-test reset.
      const callsBefore = vi.mocked(currentBranch).mock.calls.length
      vi.mocked(currentBranch).mockImplementationOnce(async () => null)

      expect(await resolveBranchCached(root)).toBeUndefined()
      // HEAD has not moved a single byte since the call above. Before
      // the fix, this served the cached `undefined` without ever calling
      // `currentBranch` again — it now must retry and get the real name.
      expect(await resolveBranchCached(root)).toBe('main')
      expect(vi.mocked(currentBranch).mock.calls.length - callsBefore).toBe(2)
    })

    it('still caches a genuine DETACHED HEAD — no retry spawn on repeat calls', async () => {
      git('checkout', '--detach', 'HEAD', '--quiet')

      expect(await resolveBranchCached(root)).toBeUndefined()
      const callsAfterFirst = vi.mocked(currentBranch).mock.calls.length
      expect(await resolveBranchCached(root)).toBeUndefined()
      expect(await resolveBranchCached(root)).toBeUndefined()
      // Genuinely detached: nothing about a repeat call should trigger
      // another `currentBranch` spawn — the cached `null` is correct and
      // stable until HEAD itself moves.
      expect(vi.mocked(currentBranch)).toHaveBeenCalledTimes(callsAfterFirst)
    })

    it('picks up a real branch after coming back from a detached HEAD', async () => {
      git('checkout', '--detach', 'HEAD', '--quiet')
      expect(await resolveBranchCached(root)).toBeUndefined()
      git('checkout', 'main', '--quiet')
      // HEAD's bytes changed (bare sha → `ref: refs/heads/main`), so the
      // fingerprint check alone already forces a fresh resolve here —
      // this is a sanity check that the F1 change didn't disturb it.
      expect(await resolveBranchCached(root)).toBe('main')
    })
  })

  // Residual risk closed 2026-08-19: `readGitHeadRaw` used to read only
  // `<root>/.git/HEAD`. A LINKED git worktree (`git worktree add`) keeps
  // `.git` as a FILE there — `gitdir: <path-to-the-real-.git/worktrees/name>`
  // — not a directory, so that exact path never resolved. Both call sites
  // (the cache-freshness check above, and the round-8 before/after
  // fingerprint in the ledger route) read `undefined` from every call in a
  // worktree checkout and silently treated it as "nothing changed" —
  // this repo itself is a linked worktree, which is how the gap was found.
  describe('readGitHeadRaw / resolveBranchCached against a LINKED git worktree', () => {
    let worktreeRoot: string

    function git(...args: string[]): void {
      execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
    }
    function gitInWorktree(...args: string[]): void {
      execFileSync('git', ['-C', worktreeRoot, ...args], { stdio: 'ignore' })
    }

    beforeEach(() => {
      git('init', '--initial-branch=main', '--quiet')
      git('config', 'user.email', 't@e.com')
      git('config', 'user.name', 'T')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(root, 'a.txt'), 'x')
      git('add', 'a.txt')
      git('commit', '-m', 'init', '--quiet')

      // `git worktree add` creates the target directory itself — give it
      // a path inside a fresh tmp dir that does not exist yet, rather
      // than pre-creating it.
      const parent = realpathSync(mkdtempSync(join(tmpdir(), 'edit-ledger-worktree-')))
      worktreeRoot = join(parent, 'wt')
      git('worktree', 'add', worktreeRoot, '-b', 'wt-branch', '--quiet')
    })

    afterEach(() => {
      rmSync(worktreeRoot, { recursive: true, force: true })
    })

    it('a linked worktree keeps .git as a FILE, not a directory — the premise the fix rests on', () => {
      // Pins the on-disk layout this fix depends on. If git ever changes
      // it, this fails loudly instead of the fix silently doing nothing.
      expect(statSync(join(worktreeRoot, '.git')).isDirectory()).toBe(false)
    })

    it('readGitHeadRaw returns a real fingerprint (not undefined) for a linked worktree', async () => {
      const head = await readGitHeadRaw(worktreeRoot)
      expect(head).toBeDefined()
      expect(head).toContain('wt-branch')
    })

    it('resolveBranchCached resolves the WORKTREE checkout, not the main repo it was created from', async () => {
      expect(await resolveBranchCached(worktreeRoot)).toBe('wt-branch')
      // The main checkout never moved off `main` — proves this actually
      // read the worktree's OWN HEAD, not the main repo's.
      expect(await resolveBranchCached(root)).toBe('main')
    })

    it('picks up a branch switch made inside the linked worktree, with no invalidateBranchCache call', async () => {
      expect(await resolveBranchCached(worktreeRoot)).toBe('wt-branch')
      gitInWorktree('checkout', '-b', 'wt-branch-2', '--quiet')
      expect(await resolveBranchCached(worktreeRoot)).toBe('wt-branch-2')
    })
  })
})
