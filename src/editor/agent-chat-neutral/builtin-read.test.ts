import { execFileSync } from 'node:child_process'
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
    // The continuation line is part of the contract, not decoration: it is how
    // the model tells "the limit cut this short" from "the file ended here".
    expect(out.content[0].text).toBe(
      '     2\tb\n     3\tc\n\n[showed lines 2 to 3 of 4; continue with offset=4]',
    )
  })

  it('adds no continuation line when the whole file fitted', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'a\nb\n', 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/App.vue' }, {})
    expect(out.content[0].text).toBe('     1\ta\n     2\tb')
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

  it('pages a file past the byte cap: a high offset returns that part of the file', async () => {
    // 13000 lines, about 1 MB — five times READ_FILE_MAX_BYTES. Slicing the
    // buffer before applying offset made every line past the first 200 KB
    // unreachable by ANY offset, while the description told the model to page
    // with offset. The instruction has to be true.
    const lines = Array.from({ length: 13000 }, (_, i) => `line ${i + 1} ${'y'.repeat(70)}`)
    writeFileSync(join(root, 'src/huge.txt'), `${lines.join('\n')}\n`, 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/huge.txt', offset: 12000, limit: 5 }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toContain('line 12000')
    expect(out.content[0].text).toContain('line 12004')
    expect(out.content[0].text).not.toContain('line 12005')
  })

  it('says an offset past the end is past the end, not empty', async () => {
    writeFileSync(join(root, 'src/App.vue'), 'a\nb\n', 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/App.vue', offset: 99 }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toMatch(/past the end/)
    expect(out.content[0].text).toMatch(/2 lines/)
  })

  it('names the line to continue from when the byte cap stops the slice', async () => {
    const lines = Array.from({ length: 13000 }, (_, i) => `line ${i + 1} ${'y'.repeat(70)}`)
    writeFileSync(join(root, 'src/huge.txt'), `${lines.join('\n')}\n`, 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/huge.txt' }, {})
    const text = out.content[0].text
    expect(text).toMatch(/truncated/)
    const m = text.match(/offset=(\d+)/)
    expect(m).not.toBeNull()
    const next = Number(m![1])
    const rest = await spec.handler({ file_path: 'src/huge.txt', offset: next, limit: 1 }, {})
    expect(rest.content[0].text).toContain(`line ${next} `)
  })

  it('truncates a large file and says so', async () => {
    writeFileSync(join(root, 'src/big.txt'), 'x'.repeat(300 * 1024), 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/big.txt' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toMatch(/truncated/)
  })
})

describe('Read: a path that is not a regular file', () => {
  // FX16 item 2 (2026-09-05). Same block as Grep's, on the same syscall:
  // `readFile` blocks in `open(2)` on a FIFO with no writer, so the handler
  // never returns, so the turn's `await runOneTool(...)` never returns and
  // Stop cannot end the turn. `stat` does not block on a FIFO, so the shape
  // of the path is decided before anything is opened.
  it('refuses a FIFO by name instead of blocking on open', async () => {
    execFileSync('mkfifo', [join(root, 'src/pipe.txt')])
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/pipe.txt' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/not a regular file/i)
  })
})
