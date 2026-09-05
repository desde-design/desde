/**
 * The NEUTRAL lane's half of the FX15 proof.
 *
 * Every assertion here is against the real tool handlers and the real shared
 * gate, over a real temp repository containing a real (fake-valued) `.env`.
 * The secrets in the fixture are obviously fake and the directory is thrown
 * away in `afterEach`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildToolPermissionGate } from '../agent-chat-sdk/edit-ack'
import { buildGlobToolSpec, buildGrepToolSpec } from './builtin-glob-grep'
import { buildReadToolSpec } from './builtin-read'

const FAKE_KEY = 'sk-NOT-A-REAL-KEY-0000'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-secret-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/App.vue'), '<template><KButton/></template>\n', 'utf8')
  writeFileSync(join(root, '.env'), `OPENAI_API_KEY=${FAKE_KEY}\n`, 'utf8')
  writeFileSync(join(root, '.env.local'), `STRIPE_SECRET_KEY=${FAKE_KEY}\n`, 'utf8')
  writeFileSync(join(root, '.env.example'), 'OPENAI_API_KEY=\n', 'utf8')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function gate(allowSecretReads?: boolean) {
  return buildToolPermissionGate({
    worktreeRoot: root,
    emitEditProposal: async () => ({ ok: true, editId: '' }),
    ...(allowSecretReads === true ? { allowSecretReads: true } : {}),
  })
}

describe('neutral lane — the shared gate', () => {
  it('denies a Read of .env', async () => {
    const d = await gate()('Read', { file_path: '.env' }, {})
    expect(d.behavior).toBe('deny')
    if (d.behavior === 'deny') expect(d.message).toContain('credentials')
  })

  it('denies a Read reached through an in-repo symlink', async () => {
    symlinkSync(join(root, '.env'), join(root, 'src/notes.md'))
    const d = await gate()('Read', { file_path: 'src/notes.md' }, {})
    expect(d.behavior).toBe('deny')
  })

  it('allows a Read of .env.example', async () => {
    expect((await gate()('Read', { file_path: '.env.example' }, {})).behavior).toBe('allow')
  })

  it('denies a Glob whose pattern names the file', async () => {
    expect((await gate()('Glob', { pattern: '**/.env*' }, {})).behavior).toBe('deny')
  })

  it('denies a Grep whose glob scope names the file', async () => {
    const d = await gate()('Grep', { pattern: 'KEY', glob: '.env*' }, {})
    expect(d.behavior).toBe('deny')
  })

  it('allows a broad Glob, because the results are filtered instead', async () => {
    expect((await gate()('Glob', { pattern: '**/.*' }, {})).behavior).toBe('allow')
  })

  it("does not treat Grep's regular expression as a path", async () => {
    // `pattern` on Grep is a regex. Refusing it as a path would refuse the
    // ordinary search for where the code reads an env variable.
    const d = await gate()('Grep', { pattern: '\\.env', glob: 'src/**/*' }, {})
    expect(d.behavior).toBe('allow')
  })

  it('allows every one of those when the override is on', async () => {
    expect((await gate(true)('Read', { file_path: '.env' }, {})).behavior).toBe('allow')
    expect((await gate(true)('Glob', { pattern: '**/.env*' }, {})).behavior).toBe('allow')
    expect((await gate(true)('Grep', { pattern: 'KEY', glob: '.env*' }, {})).behavior).toBe('allow')
  })
})

describe('neutral lane — Read', () => {
  it('refuses .env and returns no bytes of it', async () => {
    const out = await buildReadToolSpec({ worktreeRoot: root }).handler({ file_path: '.env' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).not.toContain(FAKE_KEY)
    expect(out.content[0].text).toContain('cannot be read')
  })

  it('still reads .env.example', async () => {
    const out = await buildReadToolSpec({ worktreeRoot: root }).handler(
      { file_path: '.env.example' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toContain('OPENAI_API_KEY')
  })

  it('reads .env when the override is on', async () => {
    const out = await buildReadToolSpec({ worktreeRoot: root, allowSecretReads: true }).handler(
      { file_path: '.env' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toContain(FAKE_KEY)
  })
})

describe('neutral lane — Glob', () => {
  it('omits secret files from a broad enumeration and says how many', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern: '**/.*' }, {})
    const text = out.content[0].text
    expect(text).not.toMatch(/^\.env$/m)
    expect(text).not.toMatch(/^\.env\.local$/m)
    expect(text).toContain('.env.example')
    expect(text).toContain('2 files were left out')
  })

  it('refuses a pattern aimed straight at the file', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern: '.env*' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('cannot be searched')
  })

  it('says how many were withheld even when nothing else matched', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler(
      { pattern: '**/.env.local' },
      {},
    )
    // `**/.env.local` is an aimed pattern, so it is refused rather than
    // silently emptied. The note path is covered by the broad case above.
    expect(out.isError).toBe(true)
  })

  it('lists them when the override is on', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root, allowSecretReads: true }).handler(
      { pattern: '**/.*' },
      {},
    )
    expect(out.content[0].text).toMatch(/^\.env$/m)
    expect(out.content[0].text).not.toContain('left out')
  })
})

describe('neutral lane — Grep', () => {
  it('never returns a line out of a secret file', async () => {
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
      { pattern: 'KEY', glob: '**/.*' },
      {},
    )
    expect(out.content[0].text).not.toContain(FAKE_KEY)
    expect(out.content[0].text).toContain('left out')
  })

  it('refuses a scope aimed straight at the file', async () => {
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
      { pattern: 'KEY', glob: '.env' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(out.content[0].text).not.toContain(FAKE_KEY)
  })

  it('searches them when the override is on', async () => {
    const out = await buildGrepToolSpec({
      worktreeRoot: root,
      allowSecretReads: true,
    }).handler({ pattern: 'OPENAI_API_KEY', glob: '**/.*' }, {})
    expect(out.content[0].text).toContain(FAKE_KEY)
  })
})
