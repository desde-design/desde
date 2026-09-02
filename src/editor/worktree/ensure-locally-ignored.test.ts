/**
 * Tests for `ensureLocallyIgnored` (relocated from `session-manager.ts` —
 * see that file's history / ensure-locally-ignored.ts header for why).
 *
 * Uses real git (not a mock), same rationale as the original suite: catches
 * behavioral changes in git's `rev-parse --git-common-dir` and exclude-file
 * handling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

import { ensureLocallyIgnored } from './ensure-locally-ignored'

const execFileAsync = promisify(execFile)

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-ensure-locally-ignored-test-'))
  await execFileAsync('git', ['-C', dir, 'init', '--initial-branch=main', '--quiet'])
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Editor Test'])
  // Disable signing / hook surprises in CI environments.
  await execFileAsync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(dir, 'hello.txt'), 'hello\n', 'utf8')
  await execFileAsync('git', ['-C', dir, 'add', 'hello.txt'])
  await execFileAsync('git', ['-C', dir, 'commit', '-m', 'initial', '--quiet'])
  return dir
}

async function rmRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

describe('ensureLocallyIgnored', () => {
  let repo: string
  beforeEach(async () => {
    repo = await makeRepo()
  })
  afterEach(async () => {
    await rmRepo(repo)
  })

  it('adds the entry to .git/info/exclude', async () => {
    await ensureLocallyIgnored(repo, '.desde/')
    const content = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(content).toContain('.desde/')
  })

  it('is idempotent — does not duplicate an existing entry', async () => {
    await ensureLocallyIgnored(repo, '.desde/')
    await ensureLocallyIgnored(repo, '.desde/')
    const content = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    const occurrences = content.split('\n').filter((l) => l.trim() === '.desde/').length
    expect(occurrences).toBe(1)
  })
})
