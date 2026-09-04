import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildToolPermissionGate } from '../agent-chat-sdk/edit-ack'
import { buildGlobToolSpec, buildGrepToolSpec } from './builtin-glob-grep'
import { buildReadToolSpec } from './builtin-read'
import { buildEditToolSpec, buildWriteToolSpec } from './builtin-edit'

/**
 * The adversarial containment battery.
 *
 * Every case asserts ON DISK that nothing moved, not merely that the tool
 * returned an error. A refusal that still wrote is the failure mode this file
 * exists to catch, and a return-value assertion cannot see it.
 *
 * These run against the NEUTRAL lane's own tools, which is the point: the SDK
 * lane's containment is enforced by a callback in front of a write the SDK
 * performs, and this lane performs the write itself.
 */

let root: string
let outside: string

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-contain-')))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'ORIGINAL SECRET', 'utf8')
  writeFileSync(join(root, 'src/App.vue'), '<template><div/></template>\n', 'utf8')
  writeFileSync(join(root, 'vite.config.ts'), 'export default {}\n', 'utf8')
  writeFileSync(join(root, '.mcp.json'), '{}\n', 'utf8')
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root })
})
afterEach(() => rmSync(dirname(root), { recursive: true, force: true }))

const emitEdit = async () => ({ ok: true as const, editId: 'e1' })
const writeOpts = () => ({ worktreeRoot: root, emitEdit })
const gate = () =>
  buildToolPermissionGate({
    worktreeRoot: root,
    emitEditProposal: async () => ({ ok: true as const, editId: '' }),
  })

describe('containment battery', () => {
  it('refuses a write through a symlink pointing out of the worktree', async () => {
    symlinkSync(outside, join(root, 'src/link'))
    const decision = await gate()('Write', { file_path: 'src/link/secret.txt', content: 'PWNED' }, {})
    expect(decision.behavior).toBe('deny')
    const out = await buildWriteToolSpec(writeOpts()).handler(
      { file_path: 'src/link/secret.txt', content: 'PWNED' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('ORIGINAL SECRET')
  })

  it('refuses a write to a parent directory', async () => {
    const out = await buildWriteToolSpec(writeOpts()).handler(
      { file_path: '../outside/new.md', content: 'PWNED' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
  })

  it('refuses a write to an absolute path outside the worktree', async () => {
    const out = await buildWriteToolSpec(writeOpts()).handler(
      { file_path: join(outside, 'new.md'), content: 'PWNED' },
      {},
    )
    expect(out.isError).toBe(true)
    expect(existsSync(join(outside, 'new.md'))).toBe(false)
  })

  it('refuses an edit to a protected path and leaves it byte-identical', async () => {
    for (const path of ['vite.config.ts', '.mcp.json']) {
      const before = readFileSync(join(root, path), 'utf8')
      const out = await buildEditToolSpec(writeOpts()).handler(
        { file_path: path, old_string: '{}', new_string: '{"evil":true}' },
        {},
      )
      expect(out.isError).toBe(true)
      expect(readFileSync(join(root, path), 'utf8')).toBe(before)
    }
  })

  it('refuses to create a disallowed extension anywhere in the tree', async () => {
    for (const path of ['setup.sh', 'src/.env', 'src/nested/run.bat']) {
      const out = await buildWriteToolSpec(writeOpts()).handler(
        { file_path: path, content: 'x' },
        {},
      )
      expect(out.isError).toBe(true)
      expect(existsSync(join(root, path))).toBe(false)
    }
  })

  it('refuses a Read outside the worktree, and through a symlink out of it', async () => {
    symlinkSync(outside, join(root, 'src/link'))
    const spec = buildReadToolSpec({ worktreeRoot: root })
    for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'src/link/secret.txt']) {
      const decision = await gate()('Read', { file_path: path }, {})
      expect(decision.behavior).toBe('deny')
      const out = await spec.handler({ file_path: path }, {})
      expect(out.isError).toBe(true)
      expect(out.content[0].text).not.toContain('ORIGINAL SECRET')
    }
  })

  it('leaves no backup directory behind for a refused write', async () => {
    await buildWriteToolSpec(writeOpts()).handler({ file_path: '../outside/x.md', content: 'x' }, {})
    expect(existsSync(join(root, '.desde/backups'))).toBe(false)
  })

  it('refuses a write when .desde is a symlink out of the worktree, and leaves the target file and the symlink target untouched', async () => {
    symlinkSync(outside, join(root, '.desde'))
    const before = readFileSync(join(root, 'src/App.vue'), 'utf8')

    const out = await buildEditToolSpec(writeOpts()).handler(
      { file_path: 'src/App.vue', old_string: '<div/>', new_string: '<div>PWNED</div>' },
      {},
    )

    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('.desde')
    expect(readFileSync(join(root, 'src/App.vue'), 'utf8')).toBe(before)
    expect(existsSync(join(outside, 'backups'))).toBe(false)
    expect(existsSync(join(outside, 'edit-log.jsonl'))).toBe(false)
  })
})

/**
 * Glob's own description promises "Build output, dependencies and
 * version-control internals are never returned" and Read's promises "This tool
 * only sees files inside the repository". A pattern is model input, and the
 * model reads the prototype repo, which is untrusted (2026-08-09 doctrine), so
 * a pattern that walks out of the tree has to come back empty rather than
 * enumerate the machine. Path NAMES are the leak here: Grep never returned
 * outside CONTENT because it re-checks each path before reading it.
 */
describe('search containment', () => {
  const globText = async (pattern: string): Promise<string> => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern }, {})
    return out.content[0].text
  }

  it('returns nothing for an absolute pattern outside the worktree', async () => {
    const text = await globText(join(outside, '*'))
    expect(text).toBe('No files matched.')
    expect(text).not.toContain('secret.txt')
  })

  it('returns nothing for a parent-directory pattern', async () => {
    const text = await globText('../outside/*')
    expect(text).toBe('No files matched.')
    expect(text).not.toContain('secret.txt')
  })

  it('returns nothing through a symlink inside the repo pointing out of it', async () => {
    symlinkSync(outside, join(root, 'src/link'))
    for (const pattern of ['src/link/*', 'src/**/*']) {
      const text = await globText(pattern)
      expect(text).not.toContain('secret.txt')
      expect(text).not.toContain('link')
    }
  })

  it('still returns files that are genuinely inside the repository', async () => {
    expect(await globText('src/*.vue')).toBe('src/App.vue')
  })

  it("does not leak an outside path through Grep's own scope argument", async () => {
    symlinkSync(outside, join(root, 'src/link'))
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
      { pattern: 'SECRET', glob: 'src/link/*' },
      {},
    )
    expect(out.content[0].text).not.toContain('ORIGINAL SECRET')
    expect(out.content[0].text).not.toContain('secret.txt')
  })
})
