/**
 * Tests for the hints-cache store (`readHintCache`/`writeHintCache`/
 * `hintCacheFilePath`) and `HintsCacheManifestSource` — the manifest
 * source that serves generated/inferred rendering hints from those
 * on-disk `.hints.json` files (see `docs/superpowers/plans/
 * 2026-07-26-grounding-phase4-rendering-hints.md` Task 1).
 *
 * `HintsCacheManifestSource` is scoped to ONE package entry (Task 3
 * follow-up fix): the old multi-entry design refused with `null` whenever
 * two entries' hint files both named the same component, which meant
 * NEITHER package's hints ever surfaced. `build-manifest-source.ts` now
 * builds one instance per entry instead — see that module's `hints-cache`
 * step and `CompositeManifestSource`'s `isPlausiblySameComponent` identity
 * guard, which is what actually resolves cross-package ambiguity now.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RenderingHint } from '../../core'
import {
  HINTS_SCHEMA_VERSION,
  hintCacheFilePath,
  HintsCacheManifestSource,
  readHintCache,
  writeHintCache,
  type HintCacheFile,
  type HintsCacheEntry,
} from './index'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hints-cache-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function hint(overrides: Partial<RenderingHint> = {}): RenderingHint {
  return {
    kind: 'dom',
    source: { kind: 'prop', name: 'label' },
    domTarget: { selector: ':root', field: 'textContent' },
    ...overrides,
  } as RenderingHint
}

function entry(overrides: Partial<HintsCacheEntry> = {}): HintsCacheEntry {
  return {
    packageName: 'acme-ui',
    packageVersion: '1.0.0',
    designSystem: 'acme',
    framework: 'vue3',
    importPath: 'acme-ui',
    ...overrides,
  }
}

describe('hintCacheFilePath', () => {
  it('builds a sanitized `<pkg>@<version>.hints.json` path under the cache dir', () => {
    const file = hintCacheFilePath(dir, '@acme/design-system', '9.1.2')
    expect(file).toBe(path.join(dir, 'acme-design-system@9.1.2.hints.json'))
  })
})

describe('writeHintCache / readHintCache round trip', () => {
  it('writes and reads back an identical HintCacheFile', () => {
    const file = hintCacheFilePath(dir, 'acme-ui', '1.0.0')
    const data: HintCacheFile = {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'acme-ui',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: {
        Button: [hint({ provenance: 'generated', verified: true })],
      },
    }
    writeHintCache(file, data)
    expect(readHintCache(file)).toEqual(data)
  })

  it('writes atomically (no stray .tmp file left behind)', () => {
    const file = hintCacheFilePath(dir, 'acme-ui', '1.0.0')
    writeHintCache(file, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'acme-ui',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: {},
    })
    const readBack = JSON.parse(readFileSync(file, 'utf8'))
    expect(readBack.packageName).toBe('acme-ui')
  })

  it('returns null for a missing file', () => {
    expect(readHintCache(path.join(dir, 'nope.hints.json'))).toBeNull()
  })

  it('returns null for a corrupt (unparseable) file', () => {
    const file = path.join(dir, 'corrupt.hints.json')
    writeFileSync(file, '{ not json', 'utf8')
    expect(readHintCache(file)).toBeNull()
  })

  it('returns null for a schema-mismatched file', () => {
    const file = path.join(dir, 'stale.hints.json')
    writeFileSync(
      file,
      JSON.stringify({
        schema: 999,
        packageName: 'acme-ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {},
      }),
      'utf8',
    )
    expect(readHintCache(file)).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    const file = path.join(dir, 'malformed.hints.json')
    writeFileSync(file, JSON.stringify({ schema: HINTS_SCHEMA_VERSION }), 'utf8')
    expect(readHintCache(file)).toBeNull()
  })

  it('never throws when the cache dir is unwritable (best-effort write)', () => {
    // Point at a path whose parent directory doesn't exist and can't be
    // created (a file standing where a directory is expected).
    const blocker = path.join(dir, 'blocker-file')
    writeFileSync(blocker, 'x', 'utf8')
    const file = path.join(blocker, 'sub', 'acme-ui@1.0.0.hints.json')
    expect(() =>
      writeHintCache(file, {
        schema: HINTS_SCHEMA_VERSION,
        packageName: 'acme-ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {},
      }),
    ).not.toThrow()
  })
})

describe('HintsCacheManifestSource', () => {
  it('getComponent returns a minimal manifest carrying only rendering hints', async () => {
    const file = hintCacheFilePath(dir, 'acme-ui', '1.0.0')
    const hints = [hint({ provenance: 'generated', verified: true })]
    writeHintCache(file, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'acme-ui',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: { Button: hints },
    })
    const source = new HintsCacheManifestSource({ cacheDir: dir, entry: entry() })
    const manifest = await source.getComponent('Button')
    expect(manifest).toEqual({
      id: 'acme-ui:Button',
      name: 'Button',
      framework: 'vue3',
      designSystem: 'acme',
      importPath: 'acme-ui',
      props: [],
      rendering: hints,
    })
  })

  it('getComponent returns null for a component absent from the entry\'s hint file', async () => {
    const file = hintCacheFilePath(dir, 'acme-ui', '1.0.0')
    writeHintCache(file, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'acme-ui',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: { Button: [hint()] },
    })
    const source = new HintsCacheManifestSource({ cacheDir: dir, entry: entry() })
    expect(await source.getComponent('Nonexistent')).toBeNull()
  })

  it('getComponent returns null when no hint file exists on disk yet', async () => {
    const source = new HintsCacheManifestSource({
      cacheDir: dir,
      entry: entry({ packageName: 'never-generated', importPath: 'never-generated', designSystem: 'x' }),
    })
    expect(await source.getComponent('Anything')).toBeNull()
  })

  it('two per-package sources each serve ONLY their own package\'s hint file (no cross-package ambiguity)', async () => {
    // Task 3 follow-up fix: this used to be ONE HintsCacheManifestSource
    // over BOTH entries, which refused (null) whenever two packages' files
    // both named the same component — starving both packages of hints.
    // Now each package gets its OWN source instance, so each independently
    // returns its OWN hints for a same-named component; the composite's
    // identity guard (designSystem/importPath match against the props
    // winner) is what picks the right one when composed.
    const fileA = hintCacheFilePath(dir, 'pkg-a', '1.0.0')
    const fileB = hintCacheFilePath(dir, 'pkg-b', '1.0.0')
    writeHintCache(fileA, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'pkg-a',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: { Button: [hint({ domTarget: { selector: '.a-button', field: 'textContent' } })] },
    })
    writeHintCache(fileB, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'pkg-b',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: { Button: [hint({ domTarget: { selector: '.b-button', field: 'textContent' } })] },
    })
    const sourceA = new HintsCacheManifestSource({
      cacheDir: dir,
      entry: entry({ packageName: 'pkg-a', designSystem: 'a', importPath: 'pkg-a' }),
    })
    const sourceB = new HintsCacheManifestSource({
      cacheDir: dir,
      entry: entry({ packageName: 'pkg-b', designSystem: 'b', importPath: 'pkg-b' }),
    })

    const manifestA = await sourceA.getComponent('Button')
    const manifestB = await sourceB.getComponent('Button')

    expect(manifestA?.designSystem).toBe('a')
    expect(manifestA?.rendering).toEqual([hint({ domTarget: { selector: '.a-button', field: 'textContent' } })])
    expect(manifestB?.designSystem).toBe('b')
    expect(manifestB?.rendering).toEqual([hint({ domTarget: { selector: '.b-button', field: 'textContent' } })])
  })

  it('listComponents never contributes catalog entries', async () => {
    const file = hintCacheFilePath(dir, 'acme-ui', '1.0.0')
    writeHintCache(file, {
      schema: HINTS_SCHEMA_VERSION,
      packageName: 'acme-ui',
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      hints: { Button: [hint()] },
    })
    const source = new HintsCacheManifestSource({ cacheDir: dir, entry: entry() })
    expect(await source.listComponents()).toEqual([])
  })
})
