// @vitest-environment node
/**
 * The `node` environment above is load-bearing: `vi.mock` of a node builtin
 * is silently INERT under this project's default (jsdom) environment — the
 * factory never runs — so the stub below would leave the ordinary FIFO
 * refusal in place and the test would prove nothing. The `lied` counter is
 * what caught that.
 *
 * FX19 item 5. `stat` is stubbed to report a regular file for every path.
 *
 * That is not a contrivance, it is the defect stated as a test. The guard
 * inspected the path with one handle and then opened it again with another,
 * so anything the first lookup learned could be false by the time the second
 * ran. The verifier won that race with an ordinary `rename` loop — 12,273
 * attempts in 15 seconds, ending in a process that had to be SIGKILLed. A
 * loop cannot be a unit test, so the same disagreement is produced directly:
 * the check says regular, the path is a FIFO. Only a read that does not
 * trust a separate lookup can survive it.
 */
const fsSpy = vi.hoisted(() => ({
  factoryRan: false,
  /** Path lookups the handler made that were NOT the single open. */
  statByPath: 0,
  readFileByPath: 0,
  /** When on, every `stat` by path claims the target is a regular file. */
  lie: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fsSpy.factoryRan = true
  return {
    ...actual,
    stat: (async (...args: Parameters<typeof actual.stat>) => {
      fsSpy.statByPath++
      const info = await actual.stat(...args)
      if (!fsSpy.lie) return info
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lying: any = info
      lying.isFile = () => true
      lying.isDirectory = () => false
      lying.isFIFO = () => false
      return lying
    }) as typeof actual.stat,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (typeof args[0] === 'string') fsSpy.readFileByPath++
      return actual.readFile(...args)
    }) as typeof actual.readFile,
  }
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildReadToolSpec } from './builtin-read'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-read-')))
  mkdirSync(join(root, 'src'), { recursive: true })
})
afterEach(() => {
  fsSpy.lie = false
  fsSpy.statByPath = 0
  fsSpy.readFileByPath = 0
  rmSync(root, { recursive: true, force: true })
})

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

  it('refuses a FIFO even when the shape check is told it is a regular file', async () => {
    execFileSync('mkfifo', [join(root, 'src/pipe.txt')])
    fsSpy.lie = true
    const spec = buildReadToolSpec({ worktreeRoot: root })

    // The assertion is that the handler RETURNS. A read that opens the path
    // a second time blocks in `open(2)` on a FIFO with no writer, and no
    // signal or deadline above it can interrupt that — which is the whole
    // failure: the turn never ends and Stop cannot end it.
    const settled = await Promise.race([
      spec.handler({ file_path: 'src/pipe.txt' }, {}),
      new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 2000)),
    ])
    // Anti-vacuity: under this project's DEFAULT environment the factory
    // never runs, the stub is inert, and the ordinary FIFO refusal would
    // make this pass while proving nothing.
    expect(fsSpy.factoryRan).toBe(true)
    expect(settled).not.toBe('HUNG')
    if (settled === 'HUNG') return
    expect(settled.isError).toBe(true)
    expect(settled.content[0].text).toMatch(/not a regular file/i)
  }, 10_000)

  it('looks the path up exactly once, through the handle it reads from', async () => {
    // The defect stated structurally rather than behaviourally: the shape
    // verdict and the bytes must come from ONE open file description. A
    // second lookup by path is the window, whatever it happens to find.
    writeFileSync(join(root, 'src/ok.txt'), 'hello\n', 'utf8')
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const out = await spec.handler({ file_path: 'src/ok.txt' }, {})
    expect(out.isError).toBeUndefined()
    expect(fsSpy.statByPath).toBe(0)
    expect(fsSpy.readFileByPath).toBe(0)
  })

  it('still reads an ordinary file, and still names a missing one, with the lying check on', async () => {
    // Anti-vacuity for the tests above: the stub is only allowed to change
    // the FIFO verdict, not to break the ordinary paths around it.
    writeFileSync(join(root, 'src/ok.txt'), 'hello\n', 'utf8')
    fsSpy.lie = true
    const spec = buildReadToolSpec({ worktreeRoot: root })
    const good = await spec.handler({ file_path: 'src/ok.txt' }, {})
    expect(good.isError).toBeUndefined()
    expect(good.content[0].text).toBe('     1\thello')
    const missing = await spec.handler({ file_path: 'src/nope.txt' }, {})
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toMatch(/file not found/i)
  })
})
