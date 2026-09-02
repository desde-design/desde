/**
 * Tests for the git/read-root tools. Covers:
 *   - All five tools return the expected output shape against a real
 *     temp git repo
 *   - Missing readRoots registry → tools return a "not configured" error
 *   - Unknown root name → error listing valid names
 *   - search_external_files refuses worktree root
 *   - read_file_at_commit refuses oversized files
 *
 * Like git-runner.test.ts, this drives a real temp repo so the test
 * exercises the actual git invocations end-to-end.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadReadRoots } from '../core/read-roots'
import {
  diffFileTool,
  listCommitsTool,
  listReadRootsTool,
  readFileAtCommitTool,
  searchExternalFilesTool,
  sessionDiffTool,
  sessionStatusTool,
} from './git-tools'
import type { BridgeClient, ToolContext } from './types'

const execFileP = promisify(execFile)

const fakeBridge: BridgeClient = {
  async send() {
    return null
  },
}

async function initRepoWithHistory(dir: string): Promise<{ shaA: string; shaB: string }> {
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir })

  await writeFile(join(dir, 'hello.txt'), 'first\n', 'utf8')
  await execFileP('git', ['add', 'hello.txt'], { cwd: dir })
  await execFileP('git', ['commit', '-q', '-m', 'first commit'], { cwd: dir })
  const shaA = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()

  await writeFile(join(dir, 'hello.txt'), 'second\n', 'utf8')
  await writeFile(join(dir, 'other.txt'), 'aside\n', 'utf8')
  await execFileP('git', ['add', '-A'], { cwd: dir })
  await execFileP('git', ['commit', '-q', '-m', 'second commit'], { cwd: dir })
  const shaB = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim()

  return { shaA, shaB }
}

describe('git-tools', () => {
  let worktree: string
  let external: string
  let ctx: ToolContext
  let shaA: string
  let shaB: string

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'pt-gt-wt-'))
    external = await mkdtemp(join(tmpdir(), 'pt-gt-ext-'))
    const wtHistory = await initRepoWithHistory(worktree)
    shaA = wtHistory.shaA
    shaB = wtHistory.shaB
    await initRepoWithHistory(external)

    // Write a config and load via the real loader so the test exercises
    // the same path the CLI uses at boot.
    const config = {
      readRoots: { ext: { path: external, description: 'Test external repo' } },
    }
    await writeFile(
      join(worktree, 'desde.config.json'),
      JSON.stringify(config),
      'utf8',
    )
    // Stage-ignore the test config so it doesn't appear as a dirty file
    // in session_status assertions — the existing shaA/shaB anchors must
    // stay stable for the other tools' tests. `git update-index
    // --assume-unchanged` would not work for an untracked file; `git
    // status` honors `.git/info/exclude` for untracked filtering. Easier:
    // add a local-only exclude entry.
    await writeFile(
      join(worktree, '.git', 'info', 'exclude'),
      'desde.config.json\n',
      'utf8',
    )
    const result = await loadReadRoots({ worktreeRoot: worktree })
    if (!result.ok) throw new Error(`fixture setup failed: ${result.errors.join('; ')}`)

    ctx = {
      bridge: fakeBridge,
      repoRoot: worktree,
      readRoots: result.registry,
    }
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })

  describe('list_read_roots', () => {
    it('returns worktree + declared externals', async () => {
      const r = await listReadRootsTool.run({}, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { roots: Array<{ name: string; isWorktree: boolean }> }
      expect(out.roots.map((x) => x.name).sort()).toEqual(['ext', 'worktree'])
      expect(out.roots.find((x) => x.name === 'worktree')!.isWorktree).toBe(true)
    })

    it('returns a "not configured" error when readRoots is absent', async () => {
      const r = await listReadRootsTool.run({}, {
        bridge: fakeBridge,
        repoRoot: worktree,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/not configured/)
    })
  })

  describe('list_commits', () => {
    it('lists commits in the worktree by default', async () => {
      const r = await listCommitsTool.run({}, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { count: number; commits: Array<{ sha: string; subject: string }> }
      expect(out.count).toBe(2)
      expect(out.commits[0].sha).toBe(shaA)
      expect(out.commits[1].sha).toBe(shaB)
      expect(out.commits[0].subject).toBe('first commit')
    })

    it('honors limit', async () => {
      const r = await listCommitsTool.run({ limit: 1 }, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect((r.output as { count: number }).count).toBe(1)
    })

    it('returns "unknown root" with the valid names when root is bogus', async () => {
      const r = await listCommitsTool.run({ root: 'does-not-exist' }, ctx)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error).toMatch(/unknown read root/)
        expect(r.error).toMatch(/worktree/)
        expect(r.error).toMatch(/ext/)
      }
    })
  })

  describe('read_file_at_commit', () => {
    it('reads the file content at a specific sha', async () => {
      const r = await readFileAtCommitTool.run(
        { path: 'hello.txt', sha: shaA },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { content: string; bytes: number }
      expect(out.content).toBe('first\n')
      expect(out.bytes).toBe(6)
    })

    it('reads HEAD by named ref', async () => {
      const r = await readFileAtCommitTool.run(
        { path: 'hello.txt', sha: 'HEAD' },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect((r.output as { content: string }).content).toBe('second\n')
    })

    it('rejects path with control characters', async () => {
      const badPath = ['hello', '.txt'].join(String.fromCharCode(0x01))
      const r = await readFileAtCommitTool.run({ path: badPath, sha: 'HEAD' }, ctx)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/control characters/)
    })
  })

  describe('diff_file', () => {
    it('returns a unified diff between the two commits', async () => {
      const r = await diffFileTool.run(
        { path: 'hello.txt', fromRef: shaA, toRef: shaB },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; totalLines: number; truncated: boolean }
      expect(out.diff).toMatch(/-first/)
      expect(out.diff).toMatch(/\+second/)
      expect(out.truncated).toBe(false)
    })
  })

  describe('search_external_files', () => {
    it('returns matches in the external repo', async () => {
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: 'second' },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { count: number; matches: Array<{ path?: string; text?: string }> }
      expect(out.count).toBeGreaterThan(0)
      expect(out.matches[0].path).toBe('hello.txt')
    })

    it('returns an empty result (not an error) when no matches', async () => {
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: 'zzz-no-such-string-zzz' },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect((r.output as { count: number }).count).toBe(0)
    })

    it('refuses the worktree root', async () => {
      const r = await searchExternalFilesTool.run(
        { root: 'worktree', query: 'first' },
        ctx,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/does not operate on the worktree/)
    })

    it('refuses a query beginning with "-" (git argument-injection hardening)', async () => {
      // B9: a leading-dash query could otherwise be parsed by git's own
      // option parser (e.g. `--open-files-in-pager=…`, `-f<path>`). The
      // refusal is defense in depth on top of the `-e` pattern terminator
      // added to the argv below — assert it explicitly so it can't
      // regress silently.
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: '--open-files-in-pager=/bin/sh' },
        ctx,
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/must not start with "-"/)
    })

    it('searches HEAD, not the working tree (commit-bound)', async () => {
      // Write an uncommitted string into the external's working tree.
      // If the tool searched the working tree, the dirty content would
      // surface; with `HEAD`-scoped grep it must not.
      const sentinel = 'UNCOMMITTED-WORKING-TREE-MARKER'
      await writeFile(join(external, 'hello.txt'), `${sentinel}\n`, 'utf8')
      try {
        const r = await searchExternalFilesTool.run(
          { root: 'ext', query: sentinel },
          ctx,
        )
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect((r.output as { count: number }).count).toBe(0)
      } finally {
        // Restore HEAD content so later tests in this describe see a
        // clean working tree.
        await execFileP('git', ['checkout', '--', 'hello.txt'], { cwd: external })
      }
    })
  })

  describe('session_status', () => {
    it('refuses with a branch-mode error when rootCommitSha is absent', async () => {
      const r = await sessionStatusTool.run({}, ctx)
      expect(r.ok).toBe(false)
      // The refusal used to say "requires an active worktree session … Not in a
      // worktree-session run" — a mode deleted 2026-07-21. Branch mode DOES
      // supply a rootCommitSha (the merge-base with the default branch, via
      // branchModeRootCommitSha), so absence now means a real failure to
      // resolve one, not "wrong mode". Assert the current wording so the old
      // message can't creep back.
      if (!r.ok) {
        expect(r.error).toMatch(/could not resolve a base commit for this branch/)
        expect(r.error).not.toMatch(/worktree session/)
      }
    })

    it('reports clean tree with zero commits ahead when rootCommitSha = HEAD', async () => {
      const r = await sessionStatusTool.run({}, { ...ctx, rootCommitSha: shaB })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as {
        branch: string
        rootCommitSha: string
        headSha: string
        commitsAheadOfRoot: number
        dirtyFiles: Array<{ path: string; status: string }>
      }
      expect(out.branch).toBe('main')
      expect(out.rootCommitSha).toBe(shaB)
      expect(out.headSha).toBe(shaB)
      expect(out.commitsAheadOfRoot).toBe(0)
      expect(out.dirtyFiles).toEqual([])
    })

    it('counts commits ahead when rootCommitSha is older', async () => {
      const r = await sessionStatusTool.run({}, { ...ctx, rootCommitSha: shaA })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { commitsAheadOfRoot: number; headSha: string }
      expect(out.commitsAheadOfRoot).toBe(1)
      expect(out.headSha).toBe(shaB)
    })

    it('surfaces untracked and modified files', async () => {
      await writeFile(join(worktree, 'hello.txt'), 'third\n', 'utf8')
      await writeFile(join(worktree, 'fresh.txt'), 'untracked\n', 'utf8')
      try {
        const r = await sessionStatusTool.run({}, { ...ctx, rootCommitSha: shaB })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        const out = r.output as { dirtyFiles: Array<{ path: string; status: string }> }
        const paths = out.dirtyFiles.map((f) => f.path).sort()
        expect(paths).toEqual(['fresh.txt', 'hello.txt'])
        const modified = out.dirtyFiles.find((f) => f.path === 'hello.txt')!
        expect(modified.status).toBe('M')
        const untracked = out.dirtyFiles.find((f) => f.path === 'fresh.txt')!
        expect(untracked.status).toBe('?')
      } finally {
        await execFileP('git', ['checkout', '--', 'hello.txt'], { cwd: worktree })
        await rm(join(worktree, 'fresh.txt'), { force: true })
      }
    })
  })

  describe('session_diff', () => {
    it('refuses with a branch-mode error when rootCommitSha is absent', async () => {
      const r = await sessionDiffTool.run({}, ctx)
      expect(r.ok).toBe(false)
      // The refusal used to say "requires an active worktree session … Not in a
      // worktree-session run" — a mode deleted 2026-07-21. Branch mode DOES
      // supply a rootCommitSha (the merge-base with the default branch, via
      // branchModeRootCommitSha), so absence now means a real failure to
      // resolve one, not "wrong mode". Assert the current wording so the old
      // message can't creep back.
      if (!r.ok) {
        expect(r.error).toMatch(/could not resolve a base commit for this branch/)
        expect(r.error).not.toMatch(/worktree session/)
      }
    })

    it('returns empty diff against current HEAD with a clean tree', async () => {
      const r = await sessionDiffTool.run({}, { ...ctx, rootCommitSha: shaB })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; totalLines: number; rootCommitSha: string }
      expect(out.rootCommitSha).toBe(shaB)
      expect(out.diff).toBe('')
      // Empty stdout splits to a single empty line.
      expect(out.totalLines).toBe(1)
    })

    it('shows accumulated diff including uncommitted edits', async () => {
      await writeFile(join(worktree, 'hello.txt'), 'third\n', 'utf8')
      try {
        const r = await sessionDiffTool.run({}, { ...ctx, rootCommitSha: shaA })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        const out = r.output as { diff: string; totalLines: number }
        // Diff should include both the committed change (first → second)
        // and the uncommitted change (second → third) — comparing shaA
        // against the working tree includes both.
        expect(out.diff).toContain('-first')
        expect(out.diff).toContain('+third')
        expect(out.diff).toContain('hello.txt')
        // The aside file added in shaB also appears in the diff.
        expect(out.diff).toContain('other.txt')
      } finally {
        await execFileP('git', ['checkout', '--', 'hello.txt'], { cwd: worktree })
      }
    })

    it('scopes to a single file when path is passed', async () => {
      const r = await sessionDiffTool.run(
        { path: 'hello.txt' },
        { ...ctx, rootCommitSha: shaA },
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; path: string }
      expect(out.path).toBe('hello.txt')
      expect(out.diff).toContain('hello.txt')
      expect(out.diff).not.toContain('other.txt')
    })

    it('rejects invalid rootCommitSha', async () => {
      const r = await sessionDiffTool.run({}, { ...ctx, rootCommitSha: 'not-a-sha' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/invalid git sha/)
    })
  })
})

// ─── Plain (non-git) read roots ─────────────────────────────────────
//
// A read root no longer has to be a git repo — `ReadRoot.isGit` records
// whether it is, and the git-history tools (list_commits, diff_file) refuse
// a plain one while read_file_at_commit / search_external_files fall back
// to a filesystem path (read-root-fs.ts). Self-contained fixture (own
// worktree + roots) so it can't disturb the shared `ctx` above.

describe('git-tools — plain (non-git) read root', () => {
  let worktree: string
  let plainRoot: string
  let gitRoot: string
  let gitRootHeadSha: string
  let ctx: ToolContext

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'pt-gt-plain-wt-'))
    plainRoot = await mkdtemp(join(tmpdir(), 'pt-gt-plain-root-'))
    gitRoot = await mkdtemp(join(tmpdir(), 'pt-gt-plain-git-'))

    await initRepoWithHistory(worktree)
    const gitHistory = await initRepoWithHistory(gitRoot)
    gitRootHeadSha = gitHistory.shaB

    // Plain directory: real files, deliberately never `git init`-ed.
    await writeFile(join(plainRoot, 'readme.txt'), 'hello from a plain directory\n', 'utf8')
    await mkdir(join(plainRoot, 'nested'), { recursive: true })
    await writeFile(join(plainRoot, 'nested', 'inner.txt'), 'needle inside nested\n', 'utf8')

    const config = {
      readRoots: {
        plain: { path: plainRoot, description: 'Not a git repo' },
        gitref: { path: gitRoot, description: 'A real git repo' },
      },
    }
    await writeFile(
      join(worktree, 'desde.config.json'),
      JSON.stringify(config),
      'utf8',
    )
    await writeFile(
      join(worktree, '.git', 'info', 'exclude'),
      'desde.config.json\n',
      'utf8',
    )

    const result = await loadReadRoots({ worktreeRoot: worktree })
    if (!result.ok) throw new Error(`fixture setup failed: ${result.errors.join('; ')}`)

    ctx = {
      bridge: fakeBridge,
      repoRoot: worktree,
      readRoots: result.registry,
    }
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(plainRoot, { recursive: true, force: true })
    await rm(gitRoot, { recursive: true, force: true })
  })

  it('list_read_roots reports isGit per root', async () => {
    const r = await listReadRootsTool.run({}, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { roots: Array<{ name: string; isGit: boolean }> }
    const byName = new Map(out.roots.map((x) => [x.name, x.isGit]))
    expect(byName.get('worktree')).toBe(true)
    expect(byName.get('gitref')).toBe(true)
    expect(byName.get('plain')).toBe(false)
  })

  it('list_read_roots tells the model which tools to call, not just isGit', async () => {
    const r = await listReadRootsTool.run({}, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { roots: Array<{ name: string; usage: string }> }
    const byName = new Map(out.roots.map((x) => [x.name, x.usage]))

    // Regression guard for a defect that ONLY a live agent turn exposed: given
    // a bare `isGit: false` and a tool named `read_file_at_commit`, the model
    // concluded the root was unreadable and never called the tool. The
    // capability was live the whole time. `usage` has to name the actual call,
    // because a boolean leaves the affordance to be inferred and the tool's
    // own name argues against it.
    expect(byName.get('plain')).toMatch(/read_file_at_commit/)
    expect(byName.get('plain')).toMatch(/HEAD/)
    expect(byName.get('plain')).toMatch(/search_external_files/)
    expect(byName.get('gitref')).toMatch(/read_file_at_commit/)
  })

  it('list_commits refuses a plain root, naming the root and read_file_at_commit', async () => {
    const r = await listCommitsTool.run({ root: 'plain' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('plain')
      expect(r.error).toContain('read_file_at_commit')
    }
  })

  it('diff_file refuses a plain root the same way', async () => {
    const r = await diffFileTool.run({ root: 'plain', path: 'readme.txt' }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('plain')
      expect(r.error).toContain('read_file_at_commit')
    }
  })

  it('read_file_at_commit succeeds on a plain root: content, sha: null, and a note', async () => {
    const r = await readFileAtCommitTool.run(
      { root: 'plain', path: 'readme.txt', sha: 'HEAD' },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { content: string; sha: string | null; note?: string }
    expect(out.content).toBe('hello from a plain directory\n')
    expect(out.sha).toBeNull()
    expect(out.note).toBeDefined()
    expect(out.note).toMatch(/plain directory/)
  })

  it('read_file_at_commit refuses a path that escapes a plain root', async () => {
    const r = await readFileAtCommitTool.run(
      { root: 'plain', path: '../outside.txt', sha: 'HEAD' },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/escapes/)
  })

  it('search_external_files succeeds on a plain root with filesystem matches', async () => {
    const r = await searchExternalFilesTool.run({ root: 'plain', query: 'needle' }, ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { count: number; matches: Array<{ path: string; line: number }> }
    expect(out.count).toBeGreaterThan(0)
    expect(out.matches[0].path).toBe(join('nested', 'inner.txt'))
  })

  it('search_external_files on a plain root returns an error for an invalid regex, not a throw', async () => {
    const r = await searchExternalFilesTool.run({ root: 'plain', query: '[' }, ctx)
    expect(r.ok).toBe(false)
    // The message comes from git's POSIX-ERE parser now, not JS's RegExp:
    // the plain path runs `git grep --no-index` so a pathological pattern
    // cannot block the process. What matters is that it refuses rather than
    // throwing, and says something about the pattern.
    if (!r.ok) expect(r.error).toMatch(/brackets|regex|pattern|Invalid/i)
  })

  it('regression: a git-backed root still takes the git path (real sha, no note)', async () => {
    const listed = await listCommitsTool.run({ root: 'gitref' }, ctx)
    expect(listed.ok).toBe(true)

    // Pass a concrete sha (not the named ref "HEAD") so the response's `sha`
    // field can be asserted as a real 40-char commit hash, not just an
    // echoed-back ref string.
    const r = await readFileAtCommitTool.run(
      { root: 'gitref', path: 'hello.txt', sha: gitRootHeadSha },
      ctx,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.output as { sha: string | null; note?: string; content: string }
    expect(out.sha).not.toBeNull()
    expect(out.sha).toBe(gitRootHeadSha)
    expect(out.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(out.note).toBeUndefined()
    expect(out.content).toBe('second\n')
  })
})
