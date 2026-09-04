import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
})
