import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ingestRepo,
  parseRepoSource,
  RepoIngestError,
  type GitRunner,
  type NpmRunner,
} from './git-repo'

let scratchRoot: string
beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'git-ingest-'))
})
afterEach(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})

/** The clone target is the last argv (after `--`). */
function cloneDirOf(args: readonly string[]): string {
  return args[args.length - 1]
}

const FAKE_COMMIT = 'abc123def4567890fff'

/** A git runner whose `clone` writes the given files; `rev-parse` returns a SHA. */
function fakeGit(files: Record<string, string>): GitRunner {
  return async (args) => {
    if (args[0] === 'rev-parse') return FAKE_COMMIT
    if (args[0] !== 'clone') return ''
    const dir = cloneDirOf(args)
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel)
      await fs.mkdir(join(full, '..'), { recursive: true })
      await fs.writeFile(full, content, 'utf8')
    }
    return ''
  }
}

describe('parseRepoSource', () => {
  it('accepts https / ssh / git@ URLs', () => {
    expect(parseRepoSource({ url: 'https://github.com/k/k.git' }).url).toContain('github')
    expect(parseRepoSource({ url: 'ssh://git@github.com/k/k.git' }).url).toContain('ssh')
    expect(parseRepoSource({ url: 'git@github.com:k/k.git' }).url).toContain('git@')
  })

  it('rejects local paths, file://, and flag-injection URLs', () => {
    for (const url of ['/etc/passwd', 'file:///etc', '../x', '--upload-pack=evil', 'http://x/y']) {
      expect(() => parseRepoSource({ url })).toThrow(RepoIngestError)
    }
  })

  it('rejects `..` traversal in ref and subdir', () => {
    expect(() => parseRepoSource({ url: 'https://x/y.git', ref: '../evil' })).toThrow(/ref/)
    expect(() => parseRepoSource({ url: 'https://x/y.git', subdir: 'a/../b' })).toThrow(/subdir/)
  })
})

describe('ingestRepo', () => {
  const url = 'https://github.com/acme/ui.git'

  it('extracts directly when the repo already ships .d.ts (no build)', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/ui', version: '3.1.0' }),
      'dist/types/KButton.vue.d.ts': 'export default {}',
    })
    const run = vi.fn<NpmRunner>(async () => {})
    const res = await ingestRepo({ url, scratchRoot, git, run })
    expect(res).toMatchObject({
      package: '@acme/ui',
      version: '3.1.0',
      built: false,
      commit: FAKE_COMMIT,
    })
    expect(res.packageRoot).toBe(join(res.scratchDir, 'repo'))
    // install ran, build did NOT.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0][0]).toBe('install')
    // tsconfig written.
    await expect(fs.readFile(res.tsconfigPath, 'utf8')).resolves.toContain('moduleResolution')
  })

  it('locates the package under a subdir', async () => {
    const git = fakeGit({
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
      'packages/ui/index.d.ts': 'export const x: number',
    })
    const res = await ingestRepo({ url, subdir: 'packages/ui', scratchRoot, git, run: async () => {} })
    expect(res.packageRoot).toBe(join(res.scratchDir, 'repo', 'packages/ui'))
    expect(res.package).toBe('@acme/ui')
  })

  it('refuses to build when the repo ships no .d.ts and allowBuild is false', async () => {
    const git = fakeGit({ 'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }) })
    await expect(
      ingestRepo({ url, scratchRoot, git, run: async () => {}, allowBuild: false }),
    ).rejects.toThrow(/enable "allow build"/i)
  })

  it('builds to emit .d.ts when allowBuild is true', async () => {
    const git = fakeGit({ 'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }) })
    const run = vi.fn<NpmRunner>(async (args, cwd) => {
      if (args[0] === 'run' && args[1] === 'build') {
        await fs.mkdir(join(cwd, 'dist'), { recursive: true })
        await fs.writeFile(join(cwd, 'dist/KCard.vue.d.ts'), 'export default {}', 'utf8')
      }
    })
    const res = await ingestRepo({ url, scratchRoot, git, run, allowBuild: true })
    expect(res.built).toBe(true)
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['install', 'run'])
  })

  it('runs a subdir package build in the package dir (not the clone root)', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({ name: 'root', version: '1.0.0' }),
      'packages/ui/package.json': JSON.stringify({
        name: '@acme/ui',
        version: '2.0.0',
        scripts: { build: 'tsc' },
      }),
    })
    let buildCwd: string | null = null
    const run = vi.fn<NpmRunner>(async (args, cwd) => {
      if (args[0] === 'run' && args[1] === 'build') {
        buildCwd = cwd
        await fs.mkdir(join(cwd, 'dist'), { recursive: true })
        await fs.writeFile(join(cwd, 'dist/KCard.vue.d.ts'), 'export default {}', 'utf8')
      }
    })
    const res = await ingestRepo({ url, subdir: 'packages/ui', scratchRoot, git, run, allowBuild: true })
    expect(res.built).toBe(true)
    // Build ran in the package dir (…/repo/packages/ui), NOT the clone root.
    expect(buildCwd).toMatch(/repo[/\\]packages[/\\]ui$/)
  })

  it('does NOT treat an incidental .d.ts stub (vite-env) as shipped types — builds instead', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
      'src/vite-env.d.ts': '/// <reference types="vite/client" />',
    })
    // allowBuild false → refuse, because the incidental stub is not extractable.
    await expect(
      ingestRepo({ url, scratchRoot, git, run: async () => {}, allowBuild: false }),
    ).rejects.toThrow(/enable "allow build"/i)

    // allowBuild true → build emits a real component declaration → succeeds.
    const run = vi.fn<NpmRunner>(async (args, cwd) => {
      if (args[0] === 'run') {
        await fs.mkdir(join(cwd, 'dist'), { recursive: true })
        await fs.writeFile(join(cwd, 'dist/Btn.vue.d.ts'), 'export default {}', 'utf8')
      }
    })
    const res = await ingestRepo({ url, scratchRoot, git, run, allowBuild: true })
    expect(res.built).toBe(true)
  })

  it('does NOT count a *.vue.d.ts outside the extractor roots (src/) — builds instead', async () => {
    // A src-level .vue.d.ts isn't where the extractor looks (dist/types/*), so
    // ingest must build (which emits into dist) rather than skip + fail detection.
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
      'src/Button.vue.d.ts': 'export default {}',
    })
    await expect(
      ingestRepo({ url, scratchRoot, git, run: async () => {}, allowBuild: false }),
    ).rejects.toThrow(/enable "allow build"/i)
  })

  it('forces devDependencies in the install (build needs typescript/vue-tsc)', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
      'dist/types/K.vue.d.ts': 'export default {}',
    })
    const run = vi.fn<NpmRunner>(async () => {})
    await ingestRepo({ url, scratchRoot, git, run })
    expect(run.mock.calls[0]![0]).toContain('--include=dev')
  })

  it('recognizes a declared `types` entry (React-style) without building', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/r', version: '1.0.0', types: 'dist/index.d.ts' }),
      'dist/index.d.ts': 'export declare const X: number',
    })
    const run = vi.fn<NpmRunner>(async () => {})
    const res = await ingestRepo({ url, scratchRoot, git, run, allowBuild: false })
    expect(res.built).toBe(false)
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['install']) // no build
  })

  it('recognizes an exports-only types entry (modern layout) without building', async () => {
    const git = fakeGit({
      'package.json': JSON.stringify({
        name: '@acme/modern',
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
      'dist/index.d.ts': 'export declare const X: number',
    })
    const run = vi.fn<NpmRunner>(async () => {})
    const res = await ingestRepo({ url, scratchRoot, git, run, allowBuild: false })
    expect(res.built).toBe(false)
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['install']) // no build
  })

  it('errors when the build still emits no .d.ts', async () => {
    const git = fakeGit({ 'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }) })
    await expect(
      ingestRepo({ url, scratchRoot, git, run: async () => {}, allowBuild: true }),
    ).rejects.toThrow(/produced no extractable/i)
  })

  it('leaves the existing scratch dir intact when a re-onboard fails', async () => {
    // First onboard succeeds.
    const git = fakeGit({
      'package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.0' }),
      'index.d.ts': 'export {}',
    })
    const ok = await ingestRepo({ url, scratchRoot, git, run: async () => {} })
    const marker = join(ok.scratchDir, 'repo', 'index.d.ts')
    await expect(fs.readFile(marker, 'utf8')).resolves.toContain('export')

    // Re-onboard the SAME source but the clone fails this time.
    const failingGit: GitRunner = async (args) => {
      if (args[0] === 'clone') throw new RepoIngestError('network down')
      return ''
    }
    await expect(
      ingestRepo({ url, scratchRoot, git: failingGit, run: async () => {} }),
    ).rejects.toThrow(/network down/)
    // The previously-onboarded clone is still there (not wiped mid-flight).
    await expect(fs.readFile(marker, 'utf8')).resolves.toContain('export')
  })

  it('errors when the located package has no package.json', async () => {
    const git = fakeGit({ 'README.md': '# nothing here' })
    await expect(
      ingestRepo({ url, subdir: 'packages/missing', scratchRoot, git, run: async () => {} }),
    ).rejects.toThrow(/no package\.json/i)
  })

  it('passes --branch when a ref is given, and terminates flags with --', async () => {
    const calls: string[][] = []
    const git: GitRunner = async (args) => {
      calls.push([...args])
      if (args[0] === 'clone') {
        const dir = cloneDirOf(args)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1' }))
        await fs.writeFile(join(dir, 'index.d.ts'), 'export {}')
      }
      return ''
    }
    await ingestRepo({ url, ref: 'v3', scratchRoot, git, run: async () => {} })
    const clone = calls.find((c) => c[0] === 'clone')!
    expect(clone).toContain('--branch')
    expect(clone).toContain('v3')
    expect(clone).toContain('--')
    expect(clone.indexOf('--')).toBeLessThan(clone.indexOf(url))
  })
})
