import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildGlobToolSpec, buildGrepToolSpec } from './builtin-glob-grep'

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
})
