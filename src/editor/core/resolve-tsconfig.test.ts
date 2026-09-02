/**
 * Candidate ORDER is the whole contract here, so these run against real temp
 * directories rather than a mocked `fs`: the bug being locked out
 * (`jsconfig.json` never probed, 2026-08-10) was a missing entry in the list,
 * which a mock built from the same list could not have caught.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveTsconfig, TSCONFIG_CANDIDATE_FILENAMES } from './resolve-tsconfig'

let root: string
const savedOverride = process.env.EDITOR_PROTOTYPE_TSCONFIG

beforeEach(async () => {
  delete process.env.EDITOR_PROTOTYPE_TSCONFIG
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-tsconfig-')))
})

afterEach(async () => {
  if (savedOverride === undefined) delete process.env.EDITOR_PROTOTYPE_TSCONFIG
  else process.env.EDITOR_PROTOTYPE_TSCONFIG = savedOverride
  await fs.rm(root, { recursive: true, force: true })
})

const write = (name: string) => fs.writeFile(path.join(root, name), '{"compilerOptions":{}}')

describe('resolveTsconfig', () => {
  it('resolves jsconfig.json — the JavaScript-prototype case', async () => {
    await write('jsconfig.json')
    expect(await resolveTsconfig(root)).toBe(path.join(root, 'jsconfig.json'))
  })

  it('prefers tsconfig.app.json over tsconfig.json (Vite split-config convention)', async () => {
    await write('tsconfig.json')
    await write('tsconfig.app.json')
    expect(await resolveTsconfig(root)).toBe(path.join(root, 'tsconfig.app.json'))
  })

  it('prefers tsconfig.json over jsconfig.json — a TS project that also ships editor path hints', async () => {
    await write('jsconfig.json')
    await write('tsconfig.json')
    expect(await resolveTsconfig(root)).toBe(path.join(root, 'tsconfig.json'))
  })

  it('returns null when the root has no candidate at all', async () => {
    expect(await resolveTsconfig(root)).toBeNull()
  })

  it('returns null for a root that does not exist', async () => {
    expect(await resolveTsconfig('/definitely/not/a/real/prototype/root')).toBeNull()
  })

  it('honors EDITOR_PROTOTYPE_TSCONFIG ahead of every root candidate', async () => {
    await write('tsconfig.app.json')
    const nested = path.join(root, 'apps', 'web')
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, 'tsconfig.json'), '{"compilerOptions":{}}')
    process.env.EDITOR_PROTOTYPE_TSCONFIG = path.join(nested, 'tsconfig.json')
    expect(await resolveTsconfig(root)).toBe(path.join(nested, 'tsconfig.json'))
  })

  it('an unresolvable override is a hard stop, not a fall-through to the root candidates', async () => {
    await write('tsconfig.json')
    process.env.EDITOR_PROTOTYPE_TSCONFIG = path.join(root, 'nope', 'tsconfig.json')
    expect(await resolveTsconfig(root)).toBeNull()
  })

  it('exports the candidate list callers report refusals with, in probe order', () => {
    expect([...TSCONFIG_CANDIDATE_FILENAMES]).toEqual([
      'tsconfig.app.json',
      'tsconfig.json',
      'jsconfig.json',
    ])
  })
})
