/**
 * Tests for the `readRoots` declaration writer. Covers:
 *   - `validateReadRootDeclaration` (pure): the shape/name/path rules
 *   - `suggestReadRootName` (pure): basename → slug, collision handling
 *   - `loadReadRootDeclarations`: missing file/block → [], malformed block → errors
 *   - `appendReadRoot`: creates the file/block, preserves unrelated keys byte-stable,
 *     dedupes by name (not by path)
 *   - `removeReadRoot`: removes one entry, drops the block when empty, refuses unknowns
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CONFIG_FILENAME, READ_ROOT_NAME_RE } from './read-roots'
import {
  appendReadRoot,
  loadReadRootDeclarations,
  removeReadRoot,
  suggestReadRootName,
  validateReadRootDeclaration,
  type ReadRootDeclaration,
} from './read-root-declarations'

// A literal NUL character, built via escape (never embed a raw control byte
// in this source file).
const NUL = String.fromCharCode(0)

describe('validateReadRootDeclaration', () => {
  it('accepts a valid declaration with a description', () => {
    const result = validateReadRootDeclaration({
      name: 'prod-app',
      path: '../prod-app',
      description: 'The production app',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declaration).toEqual({
        name: 'prod-app',
        path: '../prod-app',
        description: 'The production app',
      })
    }
  })

  it('accepts a valid declaration without a description', () => {
    const result = validateReadRootDeclaration({ name: 'prod', path: '../prod-app' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declaration).toEqual({ name: 'prod', path: '../prod-app' })
      expect('description' in result.declaration).toBe(false)
    }
  })

  it('rejects a non-object candidate', () => {
    expect(validateReadRootDeclaration('nope').ok).toBe(false)
    expect(validateReadRootDeclaration(null).ok).toBe(false)
    expect(validateReadRootDeclaration(['name', 'path']).ok).toBe(false)
  })

  it('rejects a name with uppercase letters', () => {
    const result = validateReadRootDeclaration({ name: 'Prod', path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/invalid name/)
  })

  it('rejects a name starting with a digit', () => {
    const result = validateReadRootDeclaration({ name: '1prod', path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/invalid name/)
  })

  it('rejects a name longer than 31 characters', () => {
    const longName = 'a'.repeat(32)
    const result = validateReadRootDeclaration({ name: longName, path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/invalid name/)
  })

  it('accepts a name exactly 31 characters long', () => {
    const maxName = 'a'.repeat(31)
    const result = validateReadRootDeclaration({ name: maxName, path: '../prod-app' })
    expect(result.ok).toBe(true)
  })

  it('rejects an empty name', () => {
    const result = validateReadRootDeclaration({ name: '', path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/must not be empty/)
  })

  it('rejects the reserved name "worktree"', () => {
    const result = validateReadRootDeclaration({ name: 'worktree', path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/reserved/)
  })

  it('rejects a missing path', () => {
    const result = validateReadRootDeclaration({ name: 'prod' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/"path" must be a string/)
  })

  it('rejects a non-string path', () => {
    const result = validateReadRootDeclaration({ name: 'prod', path: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/"path" must be a string/)
  })

  it('rejects a path that is empty after trimming', () => {
    const result = validateReadRootDeclaration({ name: 'prod', path: '   ' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/must not be empty/)
  })

  it('rejects control characters in the name', () => {
    const result = validateReadRootDeclaration({ name: `pr${NUL}od`, path: '../prod-app' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/control characters/)
  })

  it('rejects control characters in the path', () => {
    const result = validateReadRootDeclaration({ name: 'prod', path: `..${NUL}/prod-app` })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/control characters/)
  })

  it('rejects control characters in the description', () => {
    const result = validateReadRootDeclaration({
      name: 'prod',
      path: '../prod-app',
      description: `bad${NUL}desc`,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/control characters/)
  })

  it('trims whitespace from name, path, and description', () => {
    const result = validateReadRootDeclaration({
      name: '  prod  ',
      path: '  ../prod-app  ',
      description: '  the prod app  ',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declaration).toEqual({
        name: 'prod',
        path: '../prod-app',
        description: 'the prod app',
      })
    }
  })
})

describe('suggestReadRootName', () => {
  it('lowercases a plain basename into a slug', () => {
    expect(suggestReadRootName('MyApp')).toBe('myapp')
  })

  it('turns spaces and punctuation into hyphens', () => {
    expect(suggestReadRootName('Billing Web (prod)')).toBe('billing-web-prod')
  })

  it('strips leading digits (the rule requires a leading letter)', () => {
    expect(suggestReadRootName('123abc')).toBe('abc')
  })

  it('falls back to "ref" when nothing usable remains', () => {
    expect(suggestReadRootName('___')).toBe('ref')
  })

  it('appends a "-2" suffix when the base name is already taken', () => {
    expect(suggestReadRootName('prod', ['prod'])).toBe('prod-2')
  })

  it('appends a suffix when the base name collides with the reserved "worktree" name', () => {
    expect(suggestReadRootName('worktree')).toBe('worktree-2')
  })

  it('produces a name that still passes READ_ROOT_NAME_RE when a long basename collides', () => {
    const longBase = 'a'.repeat(40) // slices down to 31 chars before collision handling
    const taken = ['a'.repeat(31)] // exactly what the un-suffixed slug would be
    const result = suggestReadRootName(longBase, taken)
    expect(READ_ROOT_NAME_RE.test(result)).toBe(true)
    expect(result.length).toBeLessThanOrEqual(31)
  })
})

describe('loadReadRootDeclarations', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-rr-decl-load-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('returns [] when the config file is missing', async () => {
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declarations).toEqual([])
  })

  it('returns [] when the file exists but has no readRoots key', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify({ figma: { enabled: true } }, null, 2) + '\n', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declarations).toEqual([])
  })

  it('loads a valid block with 2 entries, one with a description and one without', async () => {
    const config = {
      readRoots: {
        prod: { path: '../prod-app', description: 'Production app' },
        staging: { path: '../staging-app' },
      },
    }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.declarations).toHaveLength(2)
    expect(result.declarations).toContainEqual({
      name: 'prod',
      path: '../prod-app',
      description: 'Production app',
    })
    expect(result.declarations).toContainEqual({ name: 'staging', path: '../staging-app' })
  })

  it('fails when readRoots is an array', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify({ readRoots: [] }, null, 2) + '\n', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/"readRoots" must be an object/)
  })

  it('fails when readRoots is a string', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify({ readRoots: 'nope' }, null, 2) + '\n', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/"readRoots" must be an object/)
  })

  it('fails when an entry is not an object', async () => {
    const config = { readRoots: { foo: 'just a string' } }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/readRoots\."foo"/)
      expect(result.errors[0]).toMatch(/must be an object/)
    }
  })

  it('fails when an entry has a bad name key, naming it in the message', async () => {
    const config = { readRoots: { BadName: { path: '../prod-app' } } }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/BadName/)
    }
  })

  it('fails with a parse error message when JSON is malformed', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), '{ not valid json', 'utf8')
    const result = await loadReadRootDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(CONFIG_FILENAME)
      expect(result.errors[0]).toMatch(/failed to parse/)
    }
  })
})

describe('appendReadRoot', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-rr-decl-append-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('creates the file and block when absent', async () => {
    const decl: ReadRootDeclaration = { name: 'prod', path: '../prod-app', description: 'Prod app' }
    const result = await appendReadRoot(workdir, decl)
    expect(result.ok).toBe(true)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text)
    expect(parsed.readRoots).toEqual({ prod: { path: '../prod-app', description: 'Prod app' } })
  })

  it('preserves ALL unrelated keys byte-for-byte', async () => {
    const original = {
      figma: { enabled: true },
      designSystems: [{ kind: 'installed', package: '@acme/design-system' }],
      chat: { detachedSessions: false },
      readRoots: { existing: { path: '../existing-app', description: 'Existing' } },
    }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    await writeFile(join(workdir, CONFIG_FILENAME), originalText, 'utf8')

    const decl: ReadRootDeclaration = { name: 'prod', path: '../prod-app', description: 'Prod app' }
    const result = await appendReadRoot(workdir, decl)
    expect(result.ok).toBe(true)

    const nextText = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const expected = {
      ...original,
      readRoots: {
        ...original.readRoots,
        prod: { path: '../prod-app', description: 'Prod app' },
      },
    }
    expect(nextText).toBe(JSON.stringify(expected, null, 2) + '\n')
  })

  it('refuses a duplicate name without writing', async () => {
    const first = await appendReadRoot(workdir, { name: 'prod', path: '../prod-app' })
    expect(first.ok).toBe(true)

    const second = await appendReadRoot(workdir, { name: 'prod', path: '../a-different-path' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toMatch(/already exists/)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed.readRoots)).toEqual(['prod'])
    expect(parsed.readRoots.prod.path).toBe('../prod-app')
  })

  it('allows two different names pointing at the same path', async () => {
    const a = await appendReadRoot(workdir, { name: 'a', path: '../shared-app' })
    expect(a.ok).toBe(true)
    const b = await appendReadRoot(workdir, { name: 'b', path: '../shared-app' })
    expect(b.ok).toBe(true)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed.readRoots.a.path).toBe('../shared-app')
    expect(parsed.readRoots.b.path).toBe('../shared-app')
  })

  it('refuses an invalid declaration without creating the file', async () => {
    const bad = { name: 'Bad Name', path: '../prod-app' } as unknown as ReadRootDeclaration
    const result = await appendReadRoot(workdir, bad)
    expect(result.ok).toBe(false)

    await expect(readFile(join(workdir, CONFIG_FILENAME), 'utf8')).rejects.toThrow()
  })
})

describe('removeReadRoot', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-rr-decl-remove-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('removes one entry and leaves others', async () => {
    const config = {
      readRoots: {
        prod: { path: '../prod-app', description: 'Prod' },
        staging: { path: '../staging-app' },
      },
    }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await removeReadRoot(workdir, 'prod')
    expect(result.ok).toBe(true)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect(Object.keys(parsed.readRoots)).toEqual(['staging'])
  })

  it('drops the readRoots key entirely when the last entry is removed', async () => {
    const config = { readRoots: { prod: { path: '../prod-app' } } }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await removeReadRoot(workdir, 'prod')
    expect(result.ok).toBe(true)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect('readRoots' in parsed).toBe(false)
  })

  it('refuses an unknown name', async () => {
    const config = { readRoots: { prod: { path: '../prod-app' } } }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await removeReadRoot(workdir, 'nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no reference directory named "nope"/)
  })

  it('refuses when the config file does not exist', async () => {
    const result = await removeReadRoot(workdir, 'prod')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no reference directory named "prod"/)
  })

  it('preserves unrelated keys', async () => {
    const original = {
      figma: { enabled: true },
      readRoots: {
        prod: { path: '../prod-app' },
        staging: { path: '../staging-app', description: 'Staging' },
      },
    }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    await writeFile(join(workdir, CONFIG_FILENAME), originalText, 'utf8')

    const result = await removeReadRoot(workdir, 'prod')
    expect(result.ok).toBe(true)

    const nextText = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const expected = {
      ...original,
      readRoots: { staging: original.readRoots.staging },
    }
    expect(nextText).toBe(JSON.stringify(expected, null, 2) + '\n')
  })
})
