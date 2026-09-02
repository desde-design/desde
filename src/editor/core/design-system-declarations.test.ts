/**
 * Tests for the `designSystems` declaration loader/writer. Covers:
 *   - Valid file with all 3 source kinds loads
 *   - Missing file / missing block → ok with []
 *   - Malformed entries (unknown kind, missing required field, NUL char) →
 *     ok:false with per-entry errors
 *   - `validateDeclaration` as the single validation path (loader is built
 *     on top of it)
 *   - `appendDesignSystemDeclaration` creates the file/block, preserves
 *     unrelated keys byte-stable, and dedupes by identity
 *   - `declarationIdentity` distinguishes repo refs/subdirs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CONFIG_FILENAME } from './read-roots'
import {
  appendDesignSystemDeclaration,
  declarationIdentity,
  loadDesignSystemDeclarations,
  validateDeclaration,
  type DesignSystemDeclaration,
} from './design-system-declarations'

// A literal NUL character, built via escape (never embed a raw control byte
// in this source file).
const NUL = String.fromCharCode(0)

describe('loadDesignSystemDeclarations', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-ds-decl-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('returns [] when the config file is missing', async () => {
    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declarations).toEqual([])
    }
  })

  it('returns [] when the file exists but has no designSystems block', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify({ readRoots: {} }, null, 2) + '\n', 'utf8')
    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declarations).toEqual([])
    }
  })

  it('loads a valid config with all 3 source kinds', async () => {
    const config = {
      designSystems: [
        { kind: 'installed', package: '@acme/design-system' },
        { kind: 'npm', spec: '@acme/ds@^2', designSystem: 'acme' },
        {
          kind: 'repo',
          url: 'https://github.com/acme/ds',
          ref: 'main',
          subdir: 'packages/ui',
          allowBuild: true,
        },
      ],
    }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.declarations).toHaveLength(3)

    expect(result.declarations[0]).toEqual({
      source: { kind: 'installed', package: '@acme/design-system' },
    })
    expect(result.declarations[1]).toEqual({
      source: { kind: 'npm', spec: '@acme/ds@^2' },
      designSystem: 'acme',
    })
    expect(result.declarations[2]).toEqual({
      source: { kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main', subdir: 'packages/ui' },
      allowBuild: true,
    })
  })

  it('trims whitespace from string fields', async () => {
    const config = { designSystems: [{ kind: 'installed', package: '  @acme/design-system  ' }] }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')
    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declarations[0].source).toEqual({ kind: 'installed', package: '@acme/design-system' })
    }
  })

  it('fails with per-entry errors: unknown kind, missing required field, NUL char', async () => {
    const config = {
      designSystems: [
        { kind: 'bogus', package: 'whatever' },
        { kind: 'repo' /* missing url */ },
        { kind: 'installed', package: `has${NUL}nul` },
      ],
    }
    await writeFile(join(workdir, CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n', 'utf8')

    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toMatch(/designSystems\[0\]/)
    expect(result.errors[0]).toMatch(/unknown|kind/i)
    expect(result.errors[1]).toMatch(/designSystems\[1\]/)
    expect(result.errors[1]).toMatch(/url/i)
    expect(result.errors[2]).toMatch(/designSystems\[2\]/)
  })

  it('fails when designSystems is present but not an array', async () => {
    await writeFile(
      join(workdir, CONFIG_FILENAME),
      JSON.stringify({ designSystems: 'nope' }, null, 2) + '\n',
      'utf8',
    )
    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/designSystems/)
      expect(result.errors[0]).toMatch(/array/i)
    }
  })

  it('fails with a parse error message when JSON is malformed', async () => {
    await writeFile(join(workdir, CONFIG_FILENAME), '{ not valid json', 'utf8')
    const result = await loadDesignSystemDeclarations(workdir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(CONFIG_FILENAME)
      expect(result.errors[0]).toMatch(/failed to parse/)
    }
  })
})

describe('validateDeclaration', () => {
  it('accepts a minimal installed declaration', () => {
    const result = validateDeclaration({ source: { kind: 'installed', package: '@acme/design-system' } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declaration).toEqual({ source: { kind: 'installed', package: '@acme/design-system' } })
    }
  })

  it('rejects a non-object value', () => {
    const result = validateDeclaration('nope')
    expect(result.ok).toBe(false)
  })

  it('rejects a missing source', () => {
    const result = validateDeclaration({ designSystem: 'acme' })
    expect(result.ok).toBe(false)
  })

  it('rejects an unknown source kind', () => {
    const result = validateDeclaration({ source: { kind: 'weird' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/unknown/i)
    }
  })

  it('rejects control characters in a string field', () => {
    const result = validateDeclaration({ source: { kind: 'npm', spec: `foo${NUL}bar` } })
    expect(result.ok).toBe(false)
  })

  it('rejects a non-boolean allowBuild', () => {
    const result = validateDeclaration({
      source: { kind: 'repo', url: 'https://x' },
      allowBuild: 'yes',
    })
    expect(result.ok).toBe(false)
  })

  it('accepts an npm spec pinned to a dist-tag', () => {
    const result = validateDeclaration({ source: { kind: 'npm', spec: '@scope/pkg@latest' } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.declaration).toEqual({ source: { kind: 'npm', spec: '@scope/pkg@latest' } })
    }
  })
})

describe('declarationIdentity', () => {
  it('uses the package name for installed sources', () => {
    expect(declarationIdentity({ kind: 'installed', package: '@acme/design-system' })).toBe(
      '@acme/design-system',
    )
  })

  it('strips the version from an npm spec (scoped and unscoped)', () => {
    expect(declarationIdentity({ kind: 'npm', spec: '@acme/ds@^2' })).toBe('@acme/ds')
    expect(declarationIdentity({ kind: 'npm', spec: 'lodash@4.17.21' })).toBe('lodash')
    expect(declarationIdentity({ kind: 'npm', spec: 'lodash' })).toBe('lodash')
  })

  it('strips a dist-tag from an npm spec (scoped and unscoped)', () => {
    expect(declarationIdentity({ kind: 'npm', spec: '@scope/pkg@latest' })).toBe('@scope/pkg')
    expect(declarationIdentity({ kind: 'npm', spec: 'lodash@latest' })).toBe('lodash')
  })

  it('matches installed and npm identity for the same package name', () => {
    expect(declarationIdentity({ kind: 'installed', package: '@acme/ds' })).toBe(
      declarationIdentity({ kind: 'npm', spec: '@acme/ds@^2' }),
    )
  })

  it('distinguishes repo declarations by ref and subdir', () => {
    const base = declarationIdentity({ kind: 'repo', url: 'https://github.com/acme/ds' })
    const withRef = declarationIdentity({ kind: 'repo', url: 'https://github.com/acme/ds', ref: 'main' })
    const withSubdir = declarationIdentity({
      kind: 'repo',
      url: 'https://github.com/acme/ds',
      ref: 'main',
      subdir: 'packages/ui',
    })
    const withOtherRef = declarationIdentity({ kind: 'repo', url: 'https://github.com/acme/ds', ref: 'dev' })

    expect(new Set([base, withRef, withSubdir, withOtherRef]).size).toBe(4)
  })
})

describe('appendDesignSystemDeclaration', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-ds-append-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('creates the file and block when absent', async () => {
    const decl: DesignSystemDeclaration = { source: { kind: 'installed', package: '@acme/design-system' } }
    const result = await appendDesignSystemDeclaration(workdir, decl)
    expect(result.ok).toBe(true)

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text)
    expect(parsed.designSystems).toEqual([{ kind: 'installed', package: '@acme/design-system' }])
  })

  it('preserves unrelated keys byte-stable apart from the new entry', async () => {
    const original = {
      readRoots: { prod: { path: '../prod-app', description: 'Production app' } },
      figma: { enabled: true },
      designSystems: [{ kind: 'installed', package: '@acme/design-system' }],
    }
    const originalText = JSON.stringify(original, null, 2) + '\n'
    await writeFile(join(workdir, CONFIG_FILENAME), originalText, 'utf8')

    const decl: DesignSystemDeclaration = { source: { kind: 'npm', spec: '@acme/ds@^2' } }
    const result = await appendDesignSystemDeclaration(workdir, decl)
    expect(result.ok).toBe(true)

    const nextText = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const expected = {
      ...original,
      designSystems: [...original.designSystems, { kind: 'npm', spec: '@acme/ds@^2' }],
    }
    expect(nextText).toBe(JSON.stringify(expected, null, 2) + '\n')
  })

  it('refuses to append a declaration with an identity that already exists', async () => {
    const decl: DesignSystemDeclaration = { source: { kind: 'installed', package: '@acme/design-system' } }
    const first = await appendDesignSystemDeclaration(workdir, decl)
    expect(first.ok).toBe(true)

    const dup: DesignSystemDeclaration = { source: { kind: 'npm', spec: '@acme/design-system@^1' } }
    const second = await appendDesignSystemDeclaration(workdir, dup)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toMatch(/already exists/)
    }

    const text = await readFile(join(workdir, CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed.designSystems).toHaveLength(1)
  })

  it('rejects an invalid declaration without writing', async () => {
    const bad = { source: { kind: 'weird' } } as unknown as DesignSystemDeclaration
    const result = await appendDesignSystemDeclaration(workdir, bad)
    expect(result.ok).toBe(false)

    // Nothing was written.
    await expect(readFile(join(workdir, CONFIG_FILENAME), 'utf8')).rejects.toThrow()
  })
})
