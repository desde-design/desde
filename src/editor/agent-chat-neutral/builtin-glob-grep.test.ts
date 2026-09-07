import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildGlobToolSpec,
  buildGrepToolSpec,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  GREP_MAX_TOTAL_BYTES,
} from './builtin-glob-grep'
import { GREP_DEADLINE_MS } from './regex-line-scanner'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'neutral-glob-')))
  mkdirSync(join(root, 'src/views'), { recursive: true })
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(root, 'src/App.vue'), '<template><KButton/></template>\n', 'utf8')
  writeFileSync(join(root, 'src/views/Home.vue'), '<template><div/></template>\n', 'utf8')
  writeFileSync(join(root, 'node_modules/pkg/index.vue'), '<template><KButton/></template>\n', 'utf8')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Glob', () => {
  it('returns repo-relative POSIX paths, sorted', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern: 'src/**/*.vue' }, {})
    expect(out.content[0].text.split('\n')).toEqual(['src/App.vue', 'src/views/Home.vue'])
  })

  it('never returns anything under node_modules or .git', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern: '**/*.vue' }, {})
    expect(out.content[0].text).not.toMatch(/node_modules/)
  })

  it('says plainly when nothing matched', async () => {
    const out = await buildGlobToolSpec({ worktreeRoot: root }).handler({ pattern: '**/*.svelte' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toBe('No files matched.')
  })
})

describe('Grep', () => {
  it('returns file:line:text for each match', async () => {
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'KButton' }, {})
    expect(out.content[0].text).toBe('src/App.vue:1:<template><KButton/></template>')
  })

  it('scopes to a glob when given one', async () => {
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
      { pattern: 'template', glob: 'src/views/**' },
      {},
    )
    expect(out.content[0].text).toBe('src/views/Home.vue:1:<template><div/></template>')
  })

  it('reports an invalid regex instead of throwing', async () => {
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: '([' }, {})
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/not a valid regular expression/)
  })

  it('caps results and says the cap was hit', async () => {
    writeFileSync(join(root, 'src/many.txt'), 'hit\n'.repeat(500), 'utf8')
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'hit' }, {})
    expect(out.content[0].text).toMatch(/stopped at 200 matches/)
  })

  it('says when file enumeration was capped, even on the No matches path', async () => {
    for (let i = 0; i < 501; i++) {
      writeFileSync(join(root, `src/f${String(i).padStart(4, '0')}.txt`), 'nothing to see here\n', 'utf8')
    }
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
      { pattern: 'this-string-is-not-in-any-file' },
      {},
    )
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toMatch(/searched only the first 500 files/)
  })

  it('clamps one very long matching line instead of returning the whole line', async () => {
    // A checked-in minified bundle is one line. Pushing the whole line put
    // half a megabyte into the model's context from a single match.
    writeFileSync(join(root, 'src/bundle.min.js'), `var a=1;${'z'.repeat(300 * 1024)}//needle\n`, 'utf8')
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'needle' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text.length).toBeLessThan(GREP_MAX_LINE_CHARS + 500)
    expect(out.content[0].text).toMatch(/line truncated/)
  })

  it('stops on a total output byte cap and says so', async () => {
    const line = `needle ${'q'.repeat(1500)}`
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(root, `src/big${i}.txt`), `${`${line}\n`.repeat(40)}`, 'utf8')
    }
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'needle' }, {})
    expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThan(
      GREP_MAX_TOTAL_BYTES + 4096,
    )
    expect(out.content[0].text).toMatch(/output limit/)
  })

  it('names its caps in the description, so the model can act on them', () => {
    const spec = buildGrepToolSpec({ worktreeRoot: root })
    expect(spec.description).toContain(String(GREP_MAX_MATCHES))
    expect(spec.description).toContain(String(GREP_MAX_LINE_CHARS))
  })
})

/**
 * FX14 item 1 (2026-09-05), a P1 from the neutral-runtime review.
 *
 * The pattern is model input, and the model reads an untrusted repository, so
 * a README saying "search for `^( +)+X`" is enough to supply it. V8's RegExp
 * backtracks, so a nested quantifier is exponential in the length of the run
 * it is matched against, and 32 characters is already minutes.
 *
 * The verifier MEASURED the shape below at 272,769 ms on a single 43-character
 * line, during which a 200 ms interval ticked ZERO times and an abort
 * scheduled for 500 ms never fired at all: its timer could not run either. The
 * process this happens in is the local CLI that also serves the HTTP API and
 * supervises Vite, so the whole Editor is gone, and Stop cannot even be
 * registered.
 *
 * These tests assert the two things a deadline has to buy, and neither of them
 * can be read off the source: that the call RETURNS, and that the event loop
 * kept running while it was in there. A deadline checked every N lines would
 * pass an inspection and fail both of these, because the whole 272 s is inside
 * ONE `re.test` on ONE line.
 */
describe('Grep cannot freeze the process', () => {
  /** The verifier's exact fixture: 32 leading spaces, then ordinary code. */
  const CATASTROPHIC = '^( +)+X'
  function writeIndentedLine(): void {
    writeFileSync(join(root, 'src/indent.ts'), `${' '.repeat(32)}const x = 1\n`, 'utf8')
  }

  it(
    'returns on a deadline instead of running for minutes, and the event loop keeps ticking',
    async () => {
      writeIndentedLine()
      let ticks = 0
      const interval = setInterval(() => {
        ticks++
      }, 50)
      const startedAt = Date.now()
      let out
      try {
        out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
          { pattern: CATASTROPHIC, glob: 'src/indent.ts' },
          {},
        )
      } finally {
        clearInterval(interval)
      }
      const elapsed = Date.now() - startedAt

      // Returns, and within a small multiple of the deadline.
      expect(elapsed).toBeLessThan(GREP_DEADLINE_MS * 3)
      // And the process was ALIVE while it searched. This is the assertion the
      // per-N-lines version of this fix cannot pass.
      expect(ticks).toBeGreaterThan(5)
      // Said plainly enough that the model can act on it.
      expect(out.content[0].text).toMatch(/cut short|too slow|stopped after/i)
    },
    30_000,
  )

  it(
    'honours the abort signal the runner threads in, and the abort can still fire',
    async () => {
      writeIndentedLine()
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      const startedAt = Date.now()
      const out = await buildGrepToolSpec({ worktreeRoot: root }).handler(
        { pattern: CATASTROPHIC, glob: 'src/indent.ts' },
        { signal: controller.signal },
      )
      const elapsed = Date.now() - startedAt

      // The abort's own timer could run, which it could not before.
      expect(controller.signal.aborted).toBe(true)
      expect(elapsed).toBeLessThan(GREP_DEADLINE_MS)
      expect(out.content[0].text).toMatch(/cancelled/i)
    },
    30_000,
  )

  it('an ordinary search is unaffected and still reports its matches', async () => {
    writeIndentedLine()
    const startedAt = Date.now()
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'KButton' }, {})
    expect(Date.now() - startedAt).toBeLessThan(GREP_DEADLINE_MS)
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text).toBe('src/App.vue:1:<template><KButton/></template>')
  })
})

describe('Grep: a path that is not a regular file', () => {
  // FX16 item 2 (2026-09-05). MEASURED by the adversarial verifier: a real
  // `mkfifo` in the scanned tree hung Grep past 12 seconds with the 3000 ms
  // deadline AND an abort at 2000 ms both ignored, and the process had to be
  // killed. Neither guard could reach it: `readFile` blocks in `open(2)` on a
  // FIFO with no writer, and the deadline is enforced inside `scanner.scan`,
  // which is only called AFTER the read returns. The turn's
  // `await runOneTool(...)` therefore never returns either, so Stop cannot end
  // the turn and the user restarts the CLI.
  //
  // `stat` does not block on a FIFO. Only `open` does.
  it('skips a FIFO instead of blocking on open, and still reports the files around it', async () => {
    execFileSync('mkfifo', [join(root, 'src/pipe.vue')])
    writeFileSync(join(root, 'src/Zed.vue'), '<template><KButton/></template>\n', 'utf8')
    const out = await buildGrepToolSpec({ worktreeRoot: root }).handler({ pattern: 'KButton' }, {})
    expect(out.isError).toBeUndefined()
    expect(out.content[0].text.split('\n')).toEqual([
      'src/App.vue:1:<template><KButton/></template>',
      'src/Zed.vue:1:<template><KButton/></template>',
    ])
  })
})
