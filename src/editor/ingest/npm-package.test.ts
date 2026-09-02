/**
 * Tests for npm-package ingestion. Spec parsing/validation is pure; the
 * install orchestration is exercised with an injected runner that fakes
 * the install by materializing a node_modules tree — so no network, but
 * the scratch layout, security flags, and version read are all asserted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NpmIngestError,
  ingestNpmPackage,
  parsePackageSpec,
  type NpmRunner,
} from './npm-package'

describe('parsePackageSpec', () => {
  it('parses an unversioned name', () => {
    expect(parsePackageSpec('vue')).toEqual({ name: 'vue', range: undefined })
  })

  it('parses a scoped name without a version', () => {
    expect(parsePackageSpec('@vue-flow/core')).toEqual({
      name: '@vue-flow/core',
      range: undefined,
    })
  })

  it('splits the version at the last @ (not the scope @)', () => {
    expect(parsePackageSpec('@vue-flow/core@1.48.0')).toEqual({
      name: '@vue-flow/core',
      range: '1.48.0',
    })
    expect(parsePackageSpec('lodash@^4.17.0')).toEqual({
      name: 'lodash',
      range: '^4.17.0',
    })
  })

  it.each([
    ['git+https://evil.example/x.git', 'git URL'],
    ['../../etc/passwd', 'local path'],
    ['https://evil.example/pkg.tgz', 'tarball URL'],
    ['pkg; rm -rf /', 'shell metacharacters'],
    ['file:./local', 'file spec'],
    ['UPPER/Case', 'uppercase / slash'],
    ['', 'empty'],
  ])('rejects %s (%s)', (spec) => {
    expect(() => parsePackageSpec(spec)).toThrow(NpmIngestError)
  })
})

describe('ingestNpmPackage', () => {
  let scratchRoot: string
  beforeEach(() => {
    scratchRoot = mkdtempSync(path.join(tmpdir(), 'ingest-'))
  })
  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  /** Fake runner: records argv, then materializes the installed package. */
  function fakeInstall(version = '1.2.3'): {
    run: NpmRunner
    calls: { args: readonly string[]; cwd: string }[]
  } {
    const calls: { args: readonly string[]; cwd: string }[] = []
    const run: NpmRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      const pkgDir = path.join(cwd, 'node_modules', '@vue-flow/core')
      await fs.mkdir(pkgDir, { recursive: true })
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@vue-flow/core', version }),
      )
    }
    return { run, calls }
  }

  it('installs into an isolated scratch dir and returns location + version', async () => {
    const { run, calls } = fakeInstall('1.48.0')
    const result = await ingestNpmPackage({
      spec: '@vue-flow/core@1.48.0',
      scratchRoot,
      run,
    })

    expect(result.package).toBe('@vue-flow/core')
    expect(result.version).toBe('1.48.0')
    expect(result.packageRoot).toBe(
      path.join(result.scratchDir, 'node_modules/@vue-flow/core'),
    )
    expect(result.scratchDir.startsWith(scratchRoot)).toBe(true)
    expect(existsSync(result.tsconfigPath)).toBe(true)

    // Scratch pinning: a private package.json keeps npm from walking up.
    const pkg = JSON.parse(
      readFileSync(path.join(result.scratchDir, 'package.json'), 'utf8'),
    )
    expect(pkg.private).toBe(true)

    // Exactly one install, hardened.
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'install',
      '@vue-flow/core@1.48.0',
      '--prefix',
      result.scratchDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--loglevel=error',
    ])
  })

  it('passes the bare name when no version is given', async () => {
    const { run, calls } = fakeInstall()
    await ingestNpmPackage({ spec: '@vue-flow/core', scratchRoot, run })
    expect(calls[0].args[1]).toBe('@vue-flow/core') // no @range suffix
  })

  it('always installs with --ignore-scripts (lifecycle-hook RCE guard)', async () => {
    const { run, calls } = fakeInstall()
    await ingestNpmPackage({ spec: '@vue-flow/core', scratchRoot, run })
    expect(calls[0].args).toContain('--ignore-scripts')
  })

  it('synthesizes a tsconfig the extractor can resolve modules with', async () => {
    const { run } = fakeInstall()
    const result = await ingestNpmPackage({
      spec: '@vue-flow/core',
      scratchRoot,
      run,
    })
    const ts = JSON.parse(readFileSync(result.tsconfigPath, 'utf8'))
    expect(ts.compilerOptions.moduleResolution).toBe('bundler')
    expect(ts.compilerOptions.skipLibCheck).toBe(true)
  })

  it('throws if the package is absent after a "successful" install', async () => {
    // Runner that does nothing (install reported success, package missing).
    const run: NpmRunner = async () => {}
    await expect(
      ingestNpmPackage({ spec: '@vue-flow/core', scratchRoot, run }),
    ).rejects.toThrow(NpmIngestError)
  })

  it('wipes the scratch dir before install (hermetic — no stale/pre-seed)', async () => {
    const { run } = fakeInstall('1.0.0')
    // First ingest creates the dir; pre-seed a hostile artifact in it.
    const first = await ingestNpmPackage({
      spec: '@vue-flow/core@1.0.0',
      scratchRoot,
      run,
    })
    await fs.writeFile(path.join(first.scratchDir, 'PWNED'), 'x')
    await fs.mkdir(path.join(first.scratchDir, 'node_modules/evil'), {
      recursive: true,
    })

    // Re-ingesting the same spec wipes the dir first → the seeded files go.
    const second = await ingestNpmPackage({
      spec: '@vue-flow/core@1.0.0',
      scratchRoot,
      run,
    })
    expect(second.scratchDir).toBe(first.scratchDir)
    expect(existsSync(path.join(second.scratchDir, 'PWNED'))).toBe(false)
    expect(existsSync(path.join(second.scratchDir, 'node_modules/evil'))).toBe(
      false,
    )
  })

  it('gives slug-colliding specs distinct scratch dirs (hash suffix)', async () => {
    const { run } = fakeInstall()
    // 'a.b' and 'a-b' both collapse to the same readable slug but differ.
    const x = await ingestNpmPackage({ spec: '@vue-flow/core', scratchRoot, run })
    const y = await ingestNpmPackage({
      spec: '@vue-flow/core@1.0.0',
      scratchRoot,
      run,
    })
    expect(x.scratchDir).not.toBe(y.scratchDir)
  })

  it('rejects an invalid spec before running npm', async () => {
    let ran = false
    const run: NpmRunner = async () => {
      ran = true
    }
    await expect(
      ingestNpmPackage({ spec: 'git+https://x.git', scratchRoot, run }),
    ).rejects.toThrow(NpmIngestError)
    expect(ran).toBe(false)
  })
})
