import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OverwriteConflictDetected } from '../agent-chat-sdk/edit-ack'
import { buildToolPermissionGate } from '../agent-chat-sdk/edit-ack'
import type { EditProposalPayload } from '../agent-tools/types'
import type { LedgerEditEntry } from '../ledger/entry'
import { describeLedgerEntry } from '../ledger/describe-entry'
import { buildEditToolSpec, buildWriteToolSpec } from './builtin-edit'

/** The ledger rows this lane appended, newest last. */
function ledgerEntries(): LedgerEditEntry[] {
  return readFileSync(join(root, '.desde/edit-log.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEditEntry)
}

let root: string
let emitted: EditProposalPayload[]
let invalidated: string[][]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-write-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/App.vue'), '<template>\n  <div>Old</div>\n</template>\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
  emitted = []
  invalidated = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const opts = () => ({
  worktreeRoot: root,
  emitEdit: async (payload: EditProposalPayload) => {
    emitted.push(payload)
    return { ok: true as const, editId: 'e1' }
  },
  invalidateFiles: (files: string[]) => invalidated.push(files),
})

describe('Edit', () => {
  it('replaces the unique match and writes it to disk', async () => {
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: '<div>Old</div>', new_string: '<div>New</div>' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toContain('<div>New</div>')
  })

  it('journals the original before writing, so the change is recoverable', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    const backups = readdirSync(join(root, '.desde/backups'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, '.desde/backups', backups[0], 'src/App.vue'), 'utf8')).toContain(
      'Old',
    )
  })

  it('emits ONE edit_proposed carrying the new source, marked as already applied', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'overwrite',
      file: 'src/App.vue',
      appliedByAgent: true,
    })
    expect(String((emitted[0] as { newSource: string }).newSource)).toContain('New')
  })

  it('invalidates the file so the dev server reloads it without waiting on the watcher', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    expect(invalidated).toEqual([['src/App.vue']])
  })

  it('appends a ledger entry naming the lane', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    const log = readFileSync(join(root, '.desde/edit-log.jsonl'), 'utf8')
    expect(log).toContain('"lane":"chat"')
  })

  it('appends a ledger entry the Activity panel can describe', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    const [entry] = ledgerEntries()
    expect(entry.kind).toBe('edit')
    expect(describeLedgerEntry(entry)).toBe('Edited App.vue')
  })

  it('refuses a non-unique old_string and says how to fix it', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'x\nx\n', 'utf8')
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'x', new_string: 'y' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/not unique/)
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe('x\nx\n')
  })

  it('refuses an edit that changes nothing', async () => {
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'Old' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/no change/)
  })

  it('leaves HEAD alone: a chat write is an uncommitted working-tree change', async () => {
    await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      {},
    )
    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root }).toString().trim()
    expect(subject).toBe('seed')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim()).not.toBe('')
  })
})

describe('Write', () => {
  it('creates a new file with an allowed extension', async () => {
    const out = await buildWriteToolSpec(opts()).handler(
      { file_path: 'docs/plan.md', content: '# Plan\n' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(readFileSync(join(root, 'docs/plan.md'), 'utf8')).toBe('# Plan\n')
    expect(emitted[0]).toMatchObject({ allowCreate: true, appliedByAgent: true })
  })

  it('appends a ledger entry the Activity panel can describe', async () => {
    await buildWriteToolSpec(opts()).handler({ file_path: 'docs/plan.md', content: '# Plan\n' }, {})
    const [entry] = ledgerEntries()
    expect(entry.kind).toBe('write')
    expect(describeLedgerEntry(entry)).toBe('Wrote plan.md')
  })

  it('refuses a disallowed extension and writes nothing', async () => {
    const out = await buildWriteToolSpec(opts()).handler(
      { file_path: 'setup.sh', content: 'rm -rf /' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(existsSync(join(root, 'setup.sh'))).toBe(false)
  })

  it('overwrites an existing file of any extension', async () => {
    writeFileSync(join(root, 'src/data.bin'), 'old', 'utf8')
    const out = await buildWriteToolSpec(opts()).handler(
      { file_path: 'src/data.bin', content: 'new' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(readFileSync(join(root, 'src/data.bin'), 'utf8')).toBe('new')
  })

  it('refuses a write outside the worktree, reading as one sentence not two prefixes', async () => {
    const out = await runWriteRefusedOnProtectedPath()
    const text = out.content[0].type === 'text' ? out.content[0].text : ''
    expect(text).not.toMatch(/refused: .*denied:/)
    expect(text).toMatch(/^(Write|Edit) (refused|denied)/)
  })

  it('on an ack failure for a NEW file, says the change is on disk and does not name a backup', async () => {
    const out = await buildWriteToolSpec({
      worktreeRoot: root,
      emitEdit: async () => ({ ok: false as const, reason: 'proposal store unavailable' }),
      invalidateFiles: (files: string[]) => invalidated.push(files),
    }).handler({ file_path: 'docs/new.md', content: '# New\n' }, {})

    expect(out.isError).toBe(true)
    const text = out.content[0].type === 'text' ? out.content[0].text : ''
    expect(text).toContain('The change IS on disk')
    expect(text).not.toContain('backup at')
    // No backup directory was ever created — the new file had no prior
    // content to journal.
    expect(existsSync(join(root, '.desde/backups'))).toBe(false)
  })
})

/**
 * FX11 items 2 to 4 (codex review + adversarial verification, 2026-09-05).
 * Three defects in this lane's Write/Edit, each reproduced before it was
 * fixed. None of them lost data; all three misled either the model or the
 * user.
 */
describe('FX11', () => {
  const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

  /**
   * Item 2. The baseline is what tells a later edit "somebody else changed
   * this file". It used to advance when the permission gate ALLOWED the
   * write, which on this lane is before the write happens, so a write the
   * broker then refused still moved it.
   */
  it('advances the read baseline after the write lands', async () => {
    const advanced: Array<{ absPath: string; hash: string }> = []
    const out = await buildEditToolSpec({
      ...opts(),
      recordOwnWrite: (absPath: string, hash: string) => advanced.push({ absPath, hash }),
    }).handler({ file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' }, {})

    expect(out.isError).toBeUndefined()
    expect(advanced).toEqual([
      { absPath: join(root, 'src/App.vue'), hash: sha256(readFileSync(join(root, 'src/App.vue'), 'utf8')) },
    ])
  })

  it('leaves the read baseline alone when the broker refuses the write', async () => {
    const advanced: Array<{ absPath: string; hash: string }> = []
    const before = readFileSync(join(root, 'src/App.vue'), 'utf8')
    const out = await buildEditToolSpec({
      ...opts(),
      recordOwnWrite: (absPath: string, hash: string) => advanced.push({ absPath, hash }),
      // A concurrent writer lands between the reconstruction and the broker's
      // locked window, so the precondition refuses the batch.
      acquireTreeGate: async () => {
        writeFileSync(join(root, 'src/App.vue'), `${before}// concurrent\n`, 'utf8')
        return () => {}
      },
    }).handler({ file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' }, {})

    expect(out.isError).toBe(true)
    expect(advanced).toEqual([])
  })

  /**
   * Item 5 of the same review was REFUTED, and this pins the behaviour that
   * refuted it, because item 4 above changed the very field it rests on: the
   * precondition's expected bytes. The claim was that a stale precondition
   * could erase a concurrent write from the CLI edit route. It cannot. The
   * precondition is built from the same read that produced the new content,
   * and it is evaluated inside the broker's path locks, so a writer landing
   * in between refuses the batch with the other writer's bytes intact. Both
   * tools, because a whole-file Write is the clobber-prone shape.
   */
  for (const tool of ['Write', 'Edit'] as const) {
    it(`refuses a ${tool} when another writer landed after the file was read, and keeps their content`, async () => {
      const theirs = 'THEIRS\n'
      const spec =
        tool === 'Write'
          ? buildWriteToolSpec({
              ...opts(),
              acquireTreeGate: async () => {
                writeFileSync(join(root, 'src/App.vue'), theirs, 'utf8')
                return () => {}
              },
            })
          : buildEditToolSpec({
              ...opts(),
              acquireTreeGate: async () => {
                writeFileSync(join(root, 'src/App.vue'), theirs, 'utf8')
                return () => {}
              },
            })
      const input =
        tool === 'Write'
          ? { file_path: 'src/App.vue', content: 'MINE\n' }
          : { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' }

      const out = await spec.handler(input, {})

      expect(out.isError).toBe(true)
      expect(out.content[0].text).toMatch(/changed on disk/)
      expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe(theirs)
    })
  }

  /**
   * Item 3. The uniqueness scan resumed past the end of the first match, so
   * two matches that OVERLAP counted as one. A string that borders itself is
   * ordinary in source: repeated closing tags, repeated blank lines, repeated
   * imports. The edit was then applied to the first pair, which is a
   * wrong-location edit the user has to notice on their own.
   */
  it('refuses a self-overlapping old_string instead of editing the first pair', async () => {
    const content = '<a>\n  </div>\n  </div>\n  </div>\n</a>\n'
    writeFileSync(join(root, 'src/App.vue'), content, 'utf8')
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: '  </div>\n  </div>\n', new_string: '  </section>\n' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/not unique/)
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe(content)
  })

  it('leaves replace_all counting occurrences the way it always has', async () => {
    // `replace_all` is `split`/`join`, which is non-overlapping, and that is
    // also the reference Edit semantics. Only the UNIQUENESS check changed.
    writeFileSync(join(root, 'src/App.vue'), 'abcabcab', 'utf8')
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'abcab', new_string: 'ZZ', replace_all: true },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe('ZZcab')
  })

  /**
   * Item 4. A file holding bytes that are not valid UTF-8 decoded lossily,
   * so the precondition re-encoded to different bytes than the ones on disk
   * and could never match. Every edit to such a file was refused as "changed
   * on disk", which is false and which the model cannot act on: re-reading
   * decodes identically, so it loops.
   */
  it('edits a file whose bytes are not valid UTF-8, and journals the real bytes', async () => {
    const original = Buffer.concat([
      Buffer.from('const a = 1 // '),
      Buffer.from([0x80, 0xfe]),
      Buffer.from('\nconst b = 2\n'),
    ])
    writeFileSync(join(root, 'src/b.ts'), original)

    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/b.ts', old_string: 'const b = 2', new_string: 'const b = 3' },
      {},
    )

    expect(out.isError).toBeUndefined()
    expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toContain('const b = 3')
    // The backup holds the file's REAL bytes, so undo restores the invalid
    // ones exactly. The written file does not: `newSource` is built from a
    // UTF-8 decode, so those two bytes come back as the replacement
    // character. Byte-preserving edits would mean editing at the byte level,
    // which is a different change from this one.
    const backups = readdirSync(join(root, '.desde/backups'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, '.desde/backups', backups[0], 'src/b.ts')).equals(original)).toBe(
      true,
    )
  })
})

/**
 * The reason `reconstructWriteEdit` returns for a path the agent may never
 * touch (here: one that escapes the worktree entirely, via `..` traversal)
 * already begins `Write denied: ...`. Before the fix, `applyWrite`'s error
 * wrapper prefixed `Write refused: ` onto that unconditionally, producing
 * `Write refused: Write denied: ...`.
 */
async function runWriteRefusedOnProtectedPath() {
  return buildWriteToolSpec(opts()).handler(
    { file_path: '../escaped.md', content: 'nope' },
    {},
  )
}

/**
 * FX14 item 2 (2026-09-05). A `Write` could silently overwrite a concurrent
 * edit, in the window between the permission gate and this handler.
 *
 * The overwrite itself is by design: a whole-file `Write` over a file that
 * changed replaces it, and the user is told through the `edit_overwrite_warning`
 * banner. The warning is therefore the only thing between the user and a
 * silent loss, and it was anchored in the wrong place. The gate hashed the
 * file, allowed the write, and the handler then re-read the file and wrote it;
 * a writer landing between those two reads made BOTH checks agree with each
 * other and disagree with what the model had actually read. The verifier
 * measured the window at 0.197 ms and reproduced `warnings=0` with the other
 * writer's bytes gone.
 *
 * The fix moves the comparison onto the bytes this handler actually replaced,
 * which the broker's precondition has already pinned under the file's lock.
 * `Edit` was never affected: it re-applies `old_string` to whatever it reads.
 */
describe('FX14: a concurrent write is never overwritten silently', () => {
  const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

  /** Replays `runOneTool`'s gate-then-handler sequence, with the race in between. */
  async function writeWithRaceBetweenGateAndHandler(theirs: string | null) {
    const abs = join(root, 'src/App.vue')
    const fileReads = { [abs]: { hashAtRead: sha256(readFileSync(abs, 'utf8')) } }
    const warnings: OverwriteConflictDetected[] = []
    const conflictOpts = {
      getFileReads: () => fileReads,
      onConflictDetected: (c: OverwriteConflictDetected) => {
        warnings.push(c)
      },
    }
    const input = { file_path: 'src/App.vue', content: 'MINE\n' }

    // 1. The permission gate runs, against the bytes the model read.
    const gate = buildToolPermissionGate({
      worktreeRoot: root,
      emitEditProposal: async () => ({ ok: true as const, editId: '' }),
      ...conflictOpts,
    })
    const decision = await gate('Write', input, {} as never)
    expect(decision.behavior).toBe('allow')

    // 2. The CLI edit route, another chat session, or the user's own editor
    //    lands in the sub-millisecond window before the handler starts.
    if (theirs !== null) writeFileSync(abs, theirs, 'utf8')

    // 3. The handler runs.
    const out = await buildWriteToolSpec({ ...opts(), ...conflictOpts }).handler(input, {})
    return { out, warnings, abs }
  }

  it('warns about the bytes it actually replaced, not the bytes the gate read', async () => {
    const theirs = 'THEIRS\n'
    const { out, warnings, abs } = await writeWithRaceBetweenGateAndHandler(theirs)

    expect(out.isError).toBeUndefined()
    // The write still lands: that is the documented Write contract.
    expect(readFileSync(abs, 'utf8')).toBe('MINE\n')
    // But it is announced, which is the whole point.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ file: 'src/App.vue', hashAtWrite: sha256(theirs) })
    // And the loss is recoverable: the journal holds THEIR bytes, not the
    // gate's older ones, so Undo restores what was actually lost.
    const backups = readdirSync(join(root, '.desde/backups'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, '.desde/backups', backups[0], 'src/App.vue'), 'utf8')).toBe(theirs)
  })

  it('stays quiet when nothing raced it', async () => {
    const { out, warnings } = await writeWithRaceBetweenGateAndHandler(null)
    expect(out.isError).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('does not warn about a write the broker refused', async () => {
    const abs = join(root, 'src/App.vue')
    const before = readFileSync(abs, 'utf8')
    const warnings: OverwriteConflictDetected[] = []
    const out = await buildWriteToolSpec({
      ...opts(),
      getFileReads: () => ({ [abs]: { hashAtRead: sha256('something else entirely') } }),
      onConflictDetected: (c: OverwriteConflictDetected) => {
        warnings.push(c)
      },
      // Lands after the reconstruction, so the precondition refuses the batch.
      acquireTreeGate: async () => {
        writeFileSync(abs, `${before}// concurrent\n`, 'utf8')
        return () => {}
      },
    }).handler({ file_path: 'src/App.vue', content: 'MINE\n' }, {})

    expect(out.isError).toBe(true)
    // A banner about an overwrite that never happened is the FX11 item 2
    // defect in a different costume.
    expect(warnings).toEqual([])
  })
})

/**
 * FX16 item 4 (2026-09-05). MEASURED by the adversarial verifier on a file
 * holding `alpha ` + 0xFF + ` omega`: `hashAtRead` hashes the raw Buffer
 * (`builtin-read.ts`, and `file-read-snapshot.ts` on the SDK lane agrees),
 * while `baseHash` hashed `currentBytes.toString('utf8')` and then re-encoded
 * that string. A file that is not valid UTF-8 does not round-trip, so the two
 * could never agree and every first write after a read raised a conflict
 * nobody caused.
 *
 * It fails safe — the write still lands, because the broker's precondition
 * uses the raw `priorBytes` — so this is a spurious banner, not a refusal.
 */
describe('FX16: a file that is not valid UTF-8 does not report a conflict nobody caused', () => {
  const NOT_UTF8 = Buffer.concat([
    Buffer.from('alpha '),
    Buffer.from([0xff]),
    Buffer.from(' omega\n'),
  ])

  /** Hash the bytes, the way both producers of `hashAtRead` do. */
  const hashBytes = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

  it('raises no warning when nothing touched the file between Read and Edit', async () => {
    const abs = join(root, 'data.txt')
    writeFileSync(abs, NOT_UTF8)
    const warnings: OverwriteConflictDetected[] = []
    const out = await buildEditToolSpec({
      ...opts(),
      getFileReads: () => ({ [abs]: { hashAtRead: hashBytes(NOT_UTF8) } }),
      onConflictDetected: (c: OverwriteConflictDetected) => {
        warnings.push(c)
      },
    }).handler({ file_path: 'data.txt', old_string: 'omega', new_string: 'OMEGA' }, {})

    expect(out.isError).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('still warns when the bytes really did change under it', async () => {
    const abs = join(root, 'data.txt')
    writeFileSync(abs, NOT_UTF8)
    const warnings: OverwriteConflictDetected[] = []
    await buildWriteToolSpec({
      ...opts(),
      getFileReads: () => ({ [abs]: { hashAtRead: hashBytes(Buffer.from('what the model read')) } }),
      onConflictDetected: (c: OverwriteConflictDetected) => {
        warnings.push(c)
      },
    }).handler({ file_path: 'data.txt', content: 'MINE\n' }, {})

    expect(warnings).toHaveLength(1)
    expect(warnings[0].hashAtWrite).toBe(hashBytes(NOT_UTF8))
  })
})

/**
 * FX16 item 1 (2026-09-05). The loop rechecks the signal between the gate's
 * `allow` and the handler, but `brokeredWrite` then waits for the repo's tree
 * gate, which a Commit or a Publish can hold for seconds. The handler is the
 * only code left inside that window, so it reads the signal too rather than
 * naming its context `_ctx` and dropping it.
 */
describe('FX16: a stopped turn does not write', () => {
  it('refuses a Write whose turn was already stopped, and touches no bytes', async () => {
    const abs = join(root, 'src/App.vue')
    const before = readFileSync(abs, 'utf8')
    const controller = new AbortController()
    controller.abort()
    const out = await buildWriteToolSpec(opts()).handler(
      { file_path: 'src/App.vue', content: 'MINE\n' },
      { signal: controller.signal },
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/turn was stopped/i)
    expect(readFileSync(abs, 'utf8')).toBe(before)
    expect(emitted).toEqual([])
  })

  it('refuses an Edit whose turn was already stopped', async () => {
    const abs = join(root, 'src/App.vue')
    const before = readFileSync(abs, 'utf8')
    const controller = new AbortController()
    controller.abort()
    const out = await buildEditToolSpec(opts()).handler(
      { file_path: 'src/App.vue', old_string: 'Old', new_string: 'New' },
      { signal: controller.signal },
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/turn was stopped/i)
    expect(readFileSync(abs, 'utf8')).toBe(before)
  })
})
