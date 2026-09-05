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
