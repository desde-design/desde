import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildReadToolSpec } from './builtin-read'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-read-')))
  mkdirSync(join(root, 'src'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Read', () => {
  it('returns cat -n numbered lines from a repo-relative path', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'one\ntwo\nthree\n', 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/App.vue' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toBe('     1\tone\n     2\ttwo\n     3\tthree')
  })

  it('honours offset and limit', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'a\nb\nc\nd\n', 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/App.vue', offset: 2, limit: 2 }, {})
    expect(out.content[0].text).toBe('     2\tb\n     3\tc')
  })

  it('records hashAtRead so a later write can detect a stale base', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'one\n', 'utf8')
    const seen: Array<{ absolutePath: string; hashAtRead: string }> = []
    const spec = buildReadToolSpec({
      worktreeRoot: root,
      onFileRead: (r) => {
        seen.push({ absolutePath: r.absolutePath, hashAtRead: r.hashAtRead })
      },
    })
    await spec.handler({ file_path: 'src/App.vue' }, {})
    expect(seen).toHaveLength(1)
    expect(seen[0].absolutePath).toBe(join(root, 'src/App.vue'))
    expect(seen[0].hashAtRead).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a path that escapes the worktree', async () => {
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: '../../etc/passwd' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/escapes repo root/)
  })

  it('says the file is missing rather than throwing', async () => {
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/Nope.vue' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/not found/)
  })

  it('truncates a large file and says so', async () => {
    writeFileSync(join(root, 'src/big.txt'), 'x'.repeat(300 * 1024), 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/big.txt' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toMatch(/truncated/)
  })
})
