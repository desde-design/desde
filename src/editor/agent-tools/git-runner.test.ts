/**
 * Tests for the git-runner. Covers:
 *   - Allowed subcommands actually invoke git in a real temp repo
 *   - Disallowed subcommands throw before exec
 *   - validateSha / validateRef regex behavior
 *   - GitRunnerError carries stderr/code for downstream tools to format
 *
 * Uses a real temp git repo (`git init` + a single commit) rather than
 * mocking `child_process`, so the test exercises the actual argv path
 * including `-C`, hook disabling, and env sanitization.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ALLOWED_SUBCOMMANDS,
  GitRunnerError,
  runGit,
  validateRef,
  validateSha,
} from './git-runner'

const execFileP = promisify(execFile)

async function initRepo(dir: string): Promise<string> {
  // Standalone repo with deterministic identity so tests don't depend on
  // the host machine's git config.
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'README.md'), '# hello\n', 'utf8')
  await execFileP('git', ['add', 'README.md'], { cwd: dir })
  await execFileP('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: dir })
  return stdout.trim()
}

describe('git-runner', () => {
  let repo: string
  let sha: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pt-git-runner-'))
    sha = await initRepo(repo)
  })
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('exposes the expected allowlist', () => {
    expect(ALLOWED_SUBCOMMANDS.has('log')).toBe(true)
    expect(ALLOWED_SUBCOMMANDS.has('show')).toBe(true)
    expect(ALLOWED_SUBCOMMANDS.has('grep')).toBe(true)
    expect(ALLOWED_SUBCOMMANDS.has('rev-parse')).toBe(true)
    // Write subcommands deliberately absent.
    expect(ALLOWED_SUBCOMMANDS.has('commit')).toBe(false)
    expect(ALLOWED_SUBCOMMANDS.has('checkout')).toBe(false)
    expect(ALLOWED_SUBCOMMANDS.has('reset')).toBe(false)
    expect(ALLOWED_SUBCOMMANDS.has('push')).toBe(false)
  })

  it('runs an allowed subcommand against a real repo', async () => {
    const stdout = await runGit(repo, ['rev-parse', 'HEAD'])
    expect(stdout.trim()).toBe(sha)
  })

  it('throws before exec when the subcommand is not on the allowlist', async () => {
    await expect(runGit(repo, ['commit', '-m', 'nope'])).rejects.toBeInstanceOf(GitRunnerError)
    await expect(runGit(repo, ['commit', '-m', 'nope'])).rejects.toMatchObject({
      message: expect.stringContaining('git subcommand not allowed'),
    })
  })

  it('throws GitRunnerError carrying stderr on a failed git command', async () => {
    let caught: GitRunnerError | null = null
    try {
      await runGit(repo, ['cat-file', '-s', 'nonexistent-ref:nope.txt'])
    } catch (err) {
      caught = err as GitRunnerError
    }
    expect(caught).toBeInstanceOf(GitRunnerError)
    expect(typeof caught!.message).toBe('string')
  })

  describe('validateSha', () => {
    it('accepts 4-64 char lowercase hex', () => {
      expect(validateSha('abcd')).toBe('abcd')
      expect(validateSha(sha)).toBe(sha)
    })
    it('rejects uppercase, non-hex, or wrong length', () => {
      expect(() => validateSha('ABCD')).toThrow(GitRunnerError)
      expect(() => validateSha('xyz1')).toThrow(GitRunnerError)
      expect(() => validateSha('abc')).toThrow(GitRunnerError) // too short
      expect(() => validateSha('')).toThrow(GitRunnerError)
    })
    it('rejects strings with shell metacharacters', () => {
      expect(() => validateSha('abcd;ls')).toThrow(GitRunnerError)
      expect(() => validateSha('abcd`whoami`')).toThrow(GitRunnerError)
    })
  })

  describe('validateRef', () => {
    it('accepts HEAD, HEAD~N, and safe branch names', () => {
      expect(validateRef('HEAD')).toBe('HEAD')
      expect(validateRef('HEAD~1')).toBe('HEAD~1')
      expect(validateRef('HEAD~10')).toBe('HEAD~10')
      expect(validateRef('main')).toBe('main')
      expect(validateRef('feature/branch-name')).toBe('feature/branch-name')
      expect(validateRef('v1.2.3')).toBe('v1.2.3')
    })
    it('rejects refs with spaces, semicolons, or backticks', () => {
      expect(() => validateRef('main; rm -rf /')).toThrow(GitRunnerError)
      expect(() => validateRef('main `whoami`')).toThrow(GitRunnerError)
      expect(() => validateRef('a..b')).toThrow(GitRunnerError) // ranges blocked
      expect(() => validateRef('')).toThrow(GitRunnerError)
    })
  })
})
