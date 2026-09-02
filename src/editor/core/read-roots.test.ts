/**
 * Tests for the read-roots config loader. Covers:
 *   - Missing config → registry with just the worktree
 *   - Malformed JSON → ok:false with a specific error
 *   - Invalid root name → rejected with the regex hint
 *   - Reserved name "worktree" → rejected
 *   - Missing "path" field → rejected
 *   - A git-repo root → loads with isGit: true
 *   - A plain (non-git) directory root → now VALID, loads with isGit: false
 *   - A path that does not exist → NOT fatal: skipped with a warning
 *   - A path that points at a file (not a directory) → still fatal
 *   - Duplicate paths → warning, not error
 *   - Path resolves to the worktree itself → rejected
 *   - The implicit worktree root → always isGit: true, gitPrefix: '', isWorktree: true
 *   - Valid config → ok:true with worktree + declared roots
 */

import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadReadRoots } from './read-roots'

const execFileP = promisify(execFile)
const CONFIG = 'desde.config.json'

describe('loadReadRoots', () => {
  let workdir: string
  // Always-true gitRepo check by default — individual tests override per call
  // when they want to exercise the rejection path.
  const isGitRepoAlwaysTrue = async () => true

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'pt-read-roots-'))
  })
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
  })

  it('returns just the worktree when no config file is present', async () => {
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.registry.roots).toHaveLength(1)
      expect(result.registry.roots[0]).toMatchObject({
        name: 'worktree',
        isWorktree: true,
        isGit: true, gitPrefix: '',
      })
      expect(result.registry.resolve('worktree')?.path).toBeDefined()
      expect(result.registry.resolve('nope')).toBeUndefined()
    }
  })

  it('fails when the worktree is not a git repo', async () => {
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: async () => false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/worktree root is not a git repo/)
    }
  })

  it('fails with a parse error message when JSON is malformed', async () => {
    await writeFile(join(workdir, CONFIG), '{ not valid json', 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/desde.config.json/)
      expect(result.errors[0]).toMatch(/failed to parse/)
    }
  })

  it('rejects invalid root names', async () => {
    const config = {
      readRoots: {
        '1bad': { path: workdir }, // starts with digit
        'UPPER': { path: workdir }, // uppercase
      },
    }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('1bad'))).toBe(true)
      expect(result.errors.some((e) => e.includes('UPPER'))).toBe(true)
    }
  })

  it('rejects the reserved "worktree" name', async () => {
    const config = { readRoots: { worktree: { path: workdir } } }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('reserved'))).toBe(true)
    }
  })

  it('rejects a root missing the "path" field', async () => {
    const config = { readRoots: { nopath: {} } }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('missing a "path"'))).toBe(true)
    }
  })

  it('loads a declared git-repo root with isGit: true', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'pt-rr-gitroot-'))
    try {
      const config = { readRoots: { prodgit: { path: ext } } }
      await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
      const result = await loadReadRoots({
        worktreeRoot: workdir,
        isGitRepo: isGitRepoAlwaysTrue,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const root = result.registry.resolve('prodgit')
        expect(root).toBeDefined()
        expect(root!.isGit).toBe(true)
        expect(root!.isWorktree).toBe(false)
      }
    } finally {
      await rm(ext, { recursive: true, force: true })
    }
  })

  // Behavior change (2026-08-13): a declared root that is NOT a git repo used
  // to be a fatal config error. It is now a valid root — the read tools just
  // take the plain-filesystem path instead of the git-backed one for it.
  it('accepts a plain (non-git) directory as a valid root, with isGit: false', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'pt-rr-plainroot-'))
    try {
      const config = { readRoots: { plain: { path: ext } } }
      await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
      // Compare against the RESOLVED worktree path — loadReadRoots realpath's
      // the worktree before probing it, and on macOS tmpdir() sits behind a
      // symlink (/var -> /private/var), so a raw-path comparison here would
      // wrongly report the worktree itself as non-git too.
      const worktreeReal = await realpath(workdir)
      const result = await loadReadRoots({
        worktreeRoot: workdir,
        isGitRepo: async (p) => p === worktreeReal, // only the worktree is a git repo
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const plain = result.registry.resolve('plain')
        expect(plain).toBeDefined()
        expect(plain!.isGit).toBe(false)
        expect(plain!.isWorktree).toBe(false)
      }
    } finally {
      await rm(ext, { recursive: true, force: true })
    }
  })

  // Exercises the DEFAULT `git rev-parse` probe (no injected isGitRepo), using
  // real `git init`'d directories rather than a stub — the other isGit tests
  // above control git-ness via the injectable option instead.
  it('exercises the default git probe against real repos', async () => {
    await execFileP('git', ['-C', workdir, 'init', '--quiet'])
    const extGit = await mkdtemp(join(tmpdir(), 'pt-rr-realgit-'))
    const extPlain = await mkdtemp(join(tmpdir(), 'pt-rr-realplain-'))
    try {
      await execFileP('git', ['-C', extGit, 'init', '--quiet'])
      const config = {
        readRoots: {
          realgit: { path: extGit },
          realplain: { path: extPlain },
        },
      }
      await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
      // No isGitRepo override — this drives the real `git rev-parse` probe.
      const result = await loadReadRoots({ worktreeRoot: workdir })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.registry.resolve('worktree')).toMatchObject({
          isGit: true, gitPrefix: '',
          isWorktree: true,
        })
        expect(result.registry.resolve('realgit')?.isGit).toBe(true)
        expect(result.registry.resolve('realplain')?.isGit).toBe(false)
      }
    } finally {
      await rm(extGit, { recursive: true, force: true })
      await rm(extPlain, { recursive: true, force: true })
    }
  })

  // Behavior change (2026-08-13): a path that does not resolve — an
  // unmounted drive, a repo the user moved or deleted — used to abort the
  // whole CLI boot. It now skips just that one root and warns.
  it('skips a declared path that does not exist, with a warning, and does not error', async () => {
    const missing = join(workdir, 'does-not-exist')
    const config = { readRoots: { missing: { path: missing } } }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.registry.resolve('missing')).toBeUndefined()
      expect(result.registry.roots.map((r) => r.name)).toEqual(['worktree'])
      expect(result.warnings.some((w) => w.includes('missing') && w.includes('not found'))).toBe(true)
    }
  })

  it('skips a directory it cannot read, with a warning, rather than erroring', async () => {
    // Exists and is a directory, but has no read/execute permission. Every
    // later read and search would fail one at a time while the root was
    // presented to the agent as available.
    const locked = join(workdir, 'locked')
    await mkdir(locked, { recursive: true })
    await chmod(locked, 0o000)
    try {
      await writeFile(
        join(workdir, CONFIG),
        JSON.stringify({ readRoots: { locked: { path: locked } } }),
      )
      const result = await loadReadRoots({ worktreeRoot: workdir, isGitRepo: async () => true })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.registry.resolve('locked')).toBeUndefined()
        expect(result.warnings.some((w) => w.includes('locked'))).toBe(true)
      }
    } finally {
      // Restore so the afterEach cleanup can remove it.
      await chmod(locked, 0o755)
    }
  })

  it('still errors when a declared path points at a file, not a directory', async () => {
    const filePath = join(workdir, 'a-file.txt')
    await writeFile(filePath, 'hello', 'utf8')
    const config = { readRoots: { notadir: { path: filePath } } }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('not a directory'))).toBe(true)
    }
  })

  it('rejects a declared path that resolves to the worktree itself', async () => {
    const config = { readRoots: { selfref: { path: workdir } } }
    await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
    const result = await loadReadRoots({
      worktreeRoot: workdir,
      isGitRepo: isGitRepoAlwaysTrue,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('points at the worktree itself'))).toBe(true)
    }
  })

  it('warns (but does not error) when two roots point at the same path', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'pt-rr-ext-'))
    try {
      const config = {
        readRoots: {
          a: { path: ext },
          b: { path: ext, description: 'alias of a' },
        },
      }
      await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
      const result = await loadReadRoots({
        worktreeRoot: workdir,
        isGitRepo: isGitRepoAlwaysTrue,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.registry.roots.map((r) => r.name)).toEqual(['worktree', 'a', 'b'])
        expect(result.warnings.some((w) => w.includes('same path as'))).toBe(true)
      }
    } finally {
      await rm(ext, { recursive: true, force: true })
    }
  })

  it('loads a valid config with one external root', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'pt-rr-ext-'))
    await mkdir(join(ext, 'subdir'), { recursive: true })
    try {
      const config = {
        readRoots: {
          'prod-app': { path: ext, description: 'Production app' },
        },
      }
      await writeFile(join(workdir, CONFIG), JSON.stringify(config), 'utf8')
      const result = await loadReadRoots({
        worktreeRoot: workdir,
        isGitRepo: isGitRepoAlwaysTrue,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.registry.roots).toHaveLength(2)
        const prod = result.registry.resolve('prod-app')
        expect(prod).toBeDefined()
        expect(prod!.isWorktree).toBe(false)
        expect(prod!.description).toBe('Production app')
      }
    } finally {
      await rm(ext, { recursive: true, force: true })
    }
  })
})
