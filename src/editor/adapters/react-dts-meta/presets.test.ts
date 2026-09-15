/**
 * `discoverReactDtsEntries` — resolving a package's type ENTRY, the barrel the
 * React extractor then scans. Pure filesystem + `package.json` reads, so these
 * build real temp packages rather than mocking.
 *
 * The shapes named after real packages come from a 2026-09-15 measurement pass
 * over 42 installed libraries; see `onboarding/suggest.ts` for the table.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverReactDtsEntries } from './presets'

describe('discoverReactDtsEntries', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-dts-entry-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function write(rel: string, content = 'export {}'): Promise<void> {
    const full = join(root, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  const pkg = (o: Record<string, unknown>) => write('package.json', JSON.stringify(o))

  it('reads the `types` field', async () => {
    await pkg({ name: 'a', types: 'dist/index.d.ts' })
    await write('dist/index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'dist/index.d.ts')])
  })

  it('reads `typings` when `types` is absent', async () => {
    await pkg({ name: 'a', typings: 'types/main.d.ts' })
    await write('types/main.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'types/main.d.ts')])
  })

  it('reads a nested `exports["."]` types condition', async () => {
    await pkg({ name: 'a', exports: { '.': { types: './dist/i.d.ts', import: './dist/i.js' } } })
    await write('dist/i.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'dist/i.d.ts')])
  })

  it('takes the first declaration path out of an `exports` array of fallbacks', async () => {
    await pkg({ name: 'a', exports: { '.': [{ import: './x.js' }, { types: './x.d.ts' }] } })
    await write('x.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'x.d.ts')])
  })

  // `.d.mts` and `.d.cts` do not end in `.d.ts`. Matching on that suffix alone
  // skipped every ESM-only package that names its types through `exports`.
  it('accepts a `.d.mts` / `.d.cts` entry', async () => {
    await pkg({ name: 'a', exports: { '.': { types: './esm/i.d.mts' } } })
    await write('esm/i.d.mts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'esm/i.d.mts')])
  })

  // grommet's shape: no `types` field at all, declarations next to `main`.
  it('falls back to the declaration sibling of `main`', async () => {
    await pkg({ name: 'a', main: 'index.js' })
    await write('index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'index.d.ts')])
  })

  // @cloudscape-design/components' shape: `exports["."]` is a bare JS string,
  // which names no declarations, and the root `index.d.ts` is the real entry.
  it('falls back when `exports["."]` is a plain JavaScript path', async () => {
    await pkg({ name: 'a', main: './index.js', exports: { '.': './index.js' } })
    await write('index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'index.d.ts')])
  })

  it('treats a `main` with no extension as a directory', async () => {
    await pkg({ name: 'a', main: 'lib' })
    await write('lib/index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'lib/index.d.ts')])
  })

  // An extensionless `main` can name a FILE. TypeScript tries `dist/index.d.ts`
  // before `dist/index/index.d.ts`, so a package shipping both must not get the
  // directory barrel.
  it('prefers the file sibling over the directory index for an extensionless main', async () => {
    await pkg({ name: 'a', main: 'dist/index' })
    await write('dist/index.d.ts')
    await write('dist/index/index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'dist/index.d.ts')])
  })

  it('preserves the m/c variant when swapping `main`s extension', async () => {
    await pkg({ name: 'a', main: 'dist/bundle.mjs' })
    await write('dist/bundle.d.mts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'dist/bundle.d.mts')])
  })

  // The common real shape: one `.d.ts` beside an `.mjs`, nowhere near the root,
  // so neither the `.d.mts` pairing nor the root `index.d.ts` finds it.
  it('also accepts a plain `.d.ts` beside an `.mjs` main', async () => {
    await pkg({ name: 'a', main: 'dist/bundle.mjs' })
    await write('dist/bundle.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'dist/bundle.d.ts')])
  })

  it('falls through to the implicit layout when a declared entry is missing', async () => {
    await pkg({ name: 'a', types: 'dist/gone.d.ts', main: 'index.js' })
    await write('index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'index.d.ts')])
  })

  // primereact's shape: types exist only under subpaths (`primereact/button`).
  // Still unresolved, and deliberately so — see suggest.ts's gap list.
  it('returns nothing when the package ships no root declarations', async () => {
    await pkg({ name: 'a', main: 'primereact.all.min.js' })
    await write('button/button.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([])
  })

  // An `exports` map is a gate. Without a `"."` the bare specifier does not
  // resolve, so a root `index.d.ts` left over from an older layout describes an
  // import the prototype cannot write.
  it('offers nothing for a subpath-only `exports` map, even with a root index.d.ts', async () => {
    await pkg({ name: 'a', main: 'index.js', exports: { './button': './button/index.js' } })
    await write('index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([])
  })

  // TypeScript substitutes the declaration extension on the target `exports`
  // selected, which is not necessarily `main`.
  it('substitutes the declaration extension on the `exports["."]` target', async () => {
    await pkg({ name: 'a', main: 'legacy/old.js', exports: { '.': './modern/new.js' } })
    await write('legacy/old.d.ts')
    await write('modern/new.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'modern/new.d.ts')])
  })

  it('substitutes through nested `exports` conditions', async () => {
    await pkg({ name: 'a', exports: { '.': { import: './esm/i.mjs', require: './cjs/i.cjs' } } })
    await write('esm/i.d.mts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'esm/i.d.mts')])
  })

  // `moduleResolution: node` ignores `exports` outright, so a root entry is
  // still worth offering when the map names no declarations of its own.
  it('still falls back when an `exports["."]` target has no declarations', async () => {
    await pkg({ name: 'a', main: 'index.js', exports: { '.': './dist/bundle.js' } })
    await write('index.d.ts')
    expect(discoverReactDtsEntries(root)).toEqual([join(root, 'index.d.ts')])
  })

  it('returns nothing for an unreadable package.json', async () => {
    await write('package.json', '{ not json')
    expect(discoverReactDtsEntries(root)).toEqual([])
  })

  it('does not mistake a JavaScript entry for declarations', async () => {
    await pkg({ name: 'a', main: 'index.js' })
    await write('index.js')
    expect(discoverReactDtsEntries(root)).toEqual([])
  })
})
