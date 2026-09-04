/**
 * Real-git integration tests for the branch-management layer
 * (tasks/branches-vs-worktree.md, Phase 2). Exercises list / switch /
 * create / rename against a throwaway repo.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

import {
  listBranches,
  switchBranch,
  createBranch,
  renameBranch,
  currentBranch,
  publishBranch,
  commitWorkingTree,
  isWorkingTreeDirty,
  listWorkingTreeChanges,
  countCommitsAhead,
  countCommitsBehind,
  branchUpstream,
  fetchOrigin,
  pushToOrigin,
  hasUnpushedCommits,
  updateFromDefault,
  updateFromRemote,
  discardFile,
  listDirtyRepoRelativePaths,
  isIgnoredPath,
  readHeadBlobs,
} from './git-branches'

const run = promisify(execFile)

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branches-'))
  await run('git', ['-C', dir, 'init', '--initial-branch=main', '--quiet'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@e.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await run('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
  await fs.writeFile(path.join(dir, 'a.txt'), 'a\n')
  await run('git', ['-C', dir, 'add', 'a.txt'])
  await run('git', ['-C', dir, 'commit', '-m', 'init', '--quiet'])
  return dir
}

describe('git-branches', () => {
  let repo: string
  beforeEach(async () => {
    repo = await makeRepo()
  })
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true })
  })

  it('lists a single branch as current + default', async () => {
    const { branches, current, defaultBranch } = await listBranches(repo)
    expect(current).toBe('main')
    expect(defaultBranch).toBe('main')
    expect(branches).toEqual([{ name: 'main', current: true, isDefault: true }])
  })

  it('creates a branch from the default and switches to it', async () => {
    const res = await createBranch(repo, 'feat/x', 'default')
    expect(res.ok).toBe(true)
    expect(await currentBranch(repo)).toBe('feat/x')
    const list = await listBranches(repo)
    expect(list.current).toBe('feat/x')
    expect(list.defaultBranch).toBe('main')
    const names = list.branches.map((b) => b.name).sort()
    expect(names).toEqual(['feat/x', 'main'])
    expect(list.branches.find((b) => b.name === 'feat/x')?.isDefault).toBe(false)
  })

  it('duplicates the current branch when base is "current"', async () => {
    // Diverge current so we can prove the new branch points at HEAD, not the default.
    await run('git', ['-C', repo, 'checkout', '-b', 'work', '--quiet'])
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n')
    await run('git', ['-C', repo, 'add', 'b.txt'])
    await run('git', ['-C', repo, 'commit', '-m', 'b', '--quiet'])

    const res = await createBranch(repo, 'work-copy', 'current')
    expect(res.ok).toBe(true)
    // work-copy branched from work's HEAD, so b.txt is present.
    expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('switches between existing branches', async () => {
    await createBranch(repo, 'feat/y', 'default')
    const back = await switchBranch(repo, 'main')
    expect(back.ok).toBe(true)
    expect(back.ok && back.current).toBe('main')
  })

  it('refuses to switch branches with a dirty working tree (branch isolation)', async () => {
    await createBranch(repo, 'other', 'default')
    await switchBranch(repo, 'main')
    await fs.writeFile(path.join(repo, 'a.txt'), 'uncommitted edit\n')
    const res = await switchBranch(repo, 'other')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/uncommitted changes/i)
    // Still on main — the switch was refused, not half-applied.
    expect(await currentBranch(repo)).toBe('main')
  })

  it('refuses to create a branch with a dirty working tree', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'uncommitted edit\n')
    const res = await createBranch(repo, 'newpage', 'default')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/uncommitted changes/i)
  })

  it('refuses switching to a non-existent branch', async () => {
    const res = await switchBranch(repo, 'ghost')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/No branch named 'ghost'/)
  })

  it('rejects invalid branch names (injection-safe)', async () => {
    for (const bad of ['-force', 'a..b', 'has space', 'trailing/', '']) {
      const res = await createBranch(repo, bad, 'default')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/Invalid branch name/)
    }
  })

  it('refuses creating a branch that already exists', async () => {
    await createBranch(repo, 'dup', 'default')
    const res = await createBranch(repo, 'dup', 'default')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/already exists/)
  })

  it('renames a branch', async () => {
    await createBranch(repo, 'old-name', 'default')
    await switchBranch(repo, 'main')
    const res = await renameBranch(repo, 'old-name', 'new-name')
    expect(res.ok).toBe(true)
    const names = (await listBranches(repo)).branches.map((b) => b.name).sort()
    expect(names).toContain('new-name')
    expect(names).not.toContain('old-name')
  })

  it("hides Editor's internal editor/session-* branches from the list", async () => {
    await run('git', ['-C', repo, 'branch', 'editor/session-deadbeef'])
    await createBranch(repo, 'real-page', 'default')
    const names = (await listBranches(repo)).branches.map((b) => b.name)
    expect(names).toContain('real-page')
    expect(names).toContain('main')
    expect(names).not.toContain('editor/session-deadbeef')
  })

  it('refuses renaming onto an existing branch', async () => {
    await createBranch(repo, 'p1', 'default')
    await createBranch(repo, 'p2', 'default')
    const res = await renameBranch(repo, 'p1', 'p2')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.reason).toMatch(/already exists/)
  })

  describe('publishBranch', () => {
    it('squash-merges a branch into the default and leaves the user on the branch', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'feat.txt'), 'feature work\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'feat', '--quiet'])

      const res = await publishBranch(repo, 'feature')
      expect(res.ok).toBe(true)
      // User stays on the branch; the default advanced.
      expect(await currentBranch(repo)).toBe('feature')
      const mainTree = await run('git', ['-C', repo, 'ls-tree', '--name-only', 'main'])
      expect(mainTree.stdout).toContain('feat.txt')
      // Ephemeral worktree cleaned up.
      const wt = await run('git', ['-C', repo, 'worktree', 'list'])
      expect(wt.stdout).not.toContain('.desde/publish-')
    })

    it('commits uncommitted branch edits before publishing', async () => {
      await createBranch(repo, 'wip', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'edited on wip\n') // uncommitted
      const res = await publishBranch(repo, 'wip')
      expect(res.ok).toBe(true)
      expect(res.ok && res.committedBranch).toBe(true)
      const show = await run('git', ['-C', repo, 'show', 'main:a.txt'])
      expect(show.stdout).toBe('edited on wip\n')
      // Branch tree is clean after publish.
      const st = await run('git', ['-C', repo, 'status', '--porcelain'])
      expect(st.stdout.trim()).toBe('')
    })

    it('refuses when there is nothing to publish', async () => {
      await createBranch(repo, 'empty-page', 'default')
      const res = await publishBranch(repo, 'empty-page')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/Nothing to publish/)
    })

    it('refuses to publish the default branch itself', async () => {
      const res = await publishBranch(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/default branch/i)
    })

    it('re-publishing only carries the new delta (idempotent)', async () => {
      await createBranch(repo, 'iter', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'v1\n')
      const first = await publishBranch(repo, 'iter')
      expect(first.ok).toBe(true)
      // Nothing new since → nothing to publish.
      const again = await publishBranch(repo, 'iter')
      expect(again.ok).toBe(false)
      expect(again.ok === false && again.reason).toMatch(/Nothing to publish/)
      // New edit → publishes the delta.
      await fs.writeFile(path.join(repo, 'a.txt'), 'v2\n')
      const third = await publishBranch(repo, 'iter')
      expect(third.ok).toBe(true)
      expect((await run('git', ['-C', repo, 'show', 'main:a.txt'])).stdout).toBe('v2\n')
    })

    it('reports a conflict without touching the user checkout', async () => {
      await createBranch(repo, 'conflicting', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'page version\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'page', '--quiet'])
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'a.txt'), 'trunk version\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'trunk', '--quiet'])
      await switchBranch(repo, 'conflicting')

      const res = await publishBranch(repo, 'conflicting')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBe(true)
      // The conflict NAMES its files — read from the ephemeral worktree
      // before teardown, so the user knows what to resolve.
      expect(res.ok === false && res.conflictFiles).toEqual(['a.txt'])
      // The recovery it recommends must be one that works. The in-product
      // "Update from <default>" action refuses on this same conflict, so
      // the message points at the user's own git tools instead.
      expect(res.ok === false && res.reason).toMatch(/your own git tools/i)
      expect(res.ok === false && res.reason).not.toMatch(/update this branch/i)
      // User untouched: still on the branch, clean tree, no leftover worktree.
      expect(await currentBranch(repo)).toBe('conflicting')
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
      const wt = await run('git', ['-C', repo, 'worktree', 'list'])
      expect(wt.stdout).not.toContain('.desde/publish-')
    })

    // Audit K11: publish ends with `git reset --hard <default>` on the
    // user's checkout to rebaseline the branch. That is destructive to
    // tracked-file modifications, and the six SDK structural write tools
    // bypass the tree gate publish holds — so a write CAN land in the
    // window between the pre-merge snapshot and the reset. It must be
    // refused, not reset over.
    it('skips the rebaseline rather than reset over a write that landed mid-publish', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'feat.txt'), 'feature work\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'feat', '--quiet'])

      // Simulate the concurrent write with a post-commit hook. The only
      // commit left in this publish is the ephemeral worktree's merge
      // commit, which happens exactly inside the vulnerable window.
      const hooks = path.join(repo, '.git', 'hooks')
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, 'post-commit'),
        `#!/bin/sh\nprintf 'concurrent structural write\\n' > '${path.join(repo, 'a.txt')}'\n`,
        { mode: 0o755 },
      )

      const res = await publishBranch(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.rebaselined).toBe(false)
      // The concurrent write survived — this is the whole point.
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe(
        'concurrent structural write\n',
      )
      // The publish itself still landed on the default branch.
      const mainTree = await run('git', ['-C', repo, 'ls-tree', '--name-only', 'main'])
      expect(mainTree.stdout).toContain('feat.txt')
    })

    it('rebaselines normally when the tree is settled', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'feat.txt'), 'feature work\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'feat', '--quiet'])

      const res = await publishBranch(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.rebaselined).toBe(true)
      // Branch tip now equals the default branch.
      const branchSha = await run('git', ['-C', repo, 'rev-parse', 'feature'])
      const mainSha = await run('git', ['-C', repo, 'rev-parse', 'main'])
      expect(branchSha.stdout.trim()).toBe(mainSha.stdout.trim())
    })

    it('CX7 fix round 1: refuses, and creates nothing at the target, when .desde is a symlink out of the worktree', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'feat.txt'), 'feature work\n')
      await run('git', ['-C', repo, 'add', '.'])
      await run('git', ['-C', repo, 'commit', '-m', 'feat', '--quiet'])

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branches-outside-'))
      await fs.symlink(outside, path.join(repo, '.desde'))

      const res = await publishBranch(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/symbolic link/i)
      // Nothing landed under the symlink target: no ephemeral worktree
      // directory, and no `git worktree add` was ever attempted.
      expect(await fs.readdir(outside)).toEqual([])

      await fs.rm(outside, { recursive: true, force: true })
    })
  })

  describe('commitWorkingTree', () => {
    it('commits working-tree changes onto the current branch', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n')
      await fs.writeFile(path.join(repo, 'new.txt'), 'new\n') // untracked too
      expect(await isWorkingTreeDirty(repo)).toBe(true)

      const res = await commitWorkingTree(repo, 'my edits')
      expect(res.ok).toBe(true)
      expect(res.ok === true && res.branch).toBe('feature')
      // The actual message used is echoed back — the edit ledger's commit
      // line has no other way to learn it (the git log isn't re-read).
      expect(res.ok === true && res.message).toBe('my edits')
      // Tree is clean and the commit landed on this branch with our message.
      expect(await isWorkingTreeDirty(repo)).toBe(false)
      const log = await run('git', ['-C', repo, 'log', '-1', '--pretty=%s'])
      expect(log.stdout.trim()).toBe('my edits')
    })

    it('commits on the default branch too (not just feature branches)', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'trunk edit\n')
      const res = await commitWorkingTree(repo)
      expect(res.ok).toBe(true)
      expect(res.ok === true && res.branch).toBe('main')
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('falls back to a default message when none is given', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'x\n')
      const res = await commitWorkingTree(repo, '   ')
      expect(res.ok).toBe(true)
      const log = await run('git', ['-C', repo, 'log', '-1', '--pretty=%s'])
      expect(log.stdout.trim()).toBe('Editor: commit working tree')
      // Same fallback the caller has no other way to observe.
      expect(res.ok === true && res.message).toBe('Editor: commit working tree')
    })

    it('refuses on a clean working tree', async () => {
      const res = await commitWorkingTree(repo)
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/clean/i)
    })
  })

  describe('listWorkingTreeChanges', () => {
    it('returns [] on a clean tree', async () => {
      expect(await listWorkingTreeChanges(repo)).toEqual([])
    })

    it('lists added, modified, and deleted files', async () => {
      await fs.writeFile(path.join(repo, 'b.txt'), 'b\n')
      await run('git', ['-C', repo, 'add', 'b.txt'])
      await run('git', ['-C', repo, 'commit', '-m', 'add b', '--quiet'])

      await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n') // modified
      await fs.rm(path.join(repo, 'b.txt')) // deleted
      await fs.writeFile(path.join(repo, 'new.txt'), 'new\n') // untracked

      const changes = await listWorkingTreeChanges(repo)
      const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]))
      expect(byPath).toEqual({
        'a.txt': 'modified',
        'b.txt': 'deleted',
        'new.txt': 'added',
      })
    })

    it('lists a staged rename with its original path', async () => {
      await run('git', ['-C', repo, 'mv', 'a.txt', 'renamed.txt'])
      const changes = await listWorkingTreeChanges(repo)
      expect(changes).toEqual([
        { path: 'renamed.txt', status: 'renamed', from: 'a.txt' },
      ])
    })

    it('parses paths with spaces exactly (-z delimiting)', async () => {
      await fs.writeFile(path.join(repo, 'has space.txt'), 'x\n')
      const changes = await listWorkingTreeChanges(repo)
      expect(changes).toEqual([
        { path: 'has space.txt', status: 'added', from: undefined },
      ])
    })

    it('returns [] for a non-repo root instead of throwing', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'not-a-repo-'))
      try {
        expect(await listWorkingTreeChanges(dir)).toEqual([])
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('countCommitsAhead', () => {
    it('counts commits on the branch not in the base', async () => {
      await createBranch(repo, 'feat', 'default')
      expect(await countCommitsAhead(repo, 'feat', 'main')).toBe(0)
      await fs.writeFile(path.join(repo, 'c.txt'), 'c\n')
      await commitWorkingTree(repo, 'c')
      expect(await countCommitsAhead(repo, 'feat', 'main')).toBe(1)
    })

    it('returns 0 for a bad ref instead of throwing', async () => {
      expect(await countCommitsAhead(repo, 'ghost', 'main')).toBe(0)
    })
  })

  describe('push + unpushed detection', () => {
    async function makeBareRemote(): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-remote-'))
      await run('git', ['-C', dir, 'init', '--bare', '--initial-branch=main', '--quiet'])
      return dir
    }

    it('pushes to origin, and unpushed flips true→false→true', async () => {
      const remote = await makeBareRemote()
      try {
        await run('git', ['-C', repo, 'remote', 'add', 'origin', remote])
        // Never pushed → everything is unpushed.
        expect(await hasUnpushedCommits(repo, 'main')).toBe(true)

        const res = await pushToOrigin(repo, 'main')
        expect(res.ok).toBe(true)
        // origin/main now exists and matches → nothing unpushed.
        expect(await hasUnpushedCommits(repo, 'main')).toBe(false)

        // A fresh commit is unpushed again.
        await fs.writeFile(path.join(repo, 'd.txt'), 'd\n')
        await commitWorkingTree(repo, 'd')
        expect(await hasUnpushedCommits(repo, 'main')).toBe(true)
      } finally {
        await fs.rm(remote, { recursive: true, force: true })
      }
    })

    it('pushToOrigin fails cleanly with no origin remote', async () => {
      const res = await pushToOrigin(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/origin/i)
    })
  })

  describe('updateFromDefault', () => {
    /** Diverge: b.txt lands on main while `feature` is checked out with c.txt. */
    async function divergeNonConflicting(): Promise<void> {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'c.txt'), 'branch work\n')
      await commitWorkingTree(repo, 'c')
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'b.txt'), 'trunk work\n')
      await commitWorkingTree(repo, 'b')
      await switchBranch(repo, 'feature')
    }

    it('merges the default into the branch and updates the working tree', async () => {
      await divergeNonConflicting()
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(false)
      // Still on the branch; both sides' files present; tree clean.
      expect(await currentBranch(repo)).toBe('feature')
      expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('trunk work\n')
      expect(await fs.readFile(path.join(repo, 'c.txt'), 'utf8')).toBe('branch work\n')
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
      // Ephemeral worktree cleaned up.
      const wt = await run('git', ['-C', repo, 'worktree', 'list'])
      expect(wt.stdout).not.toContain('.desde/update-')
    })

    it('commits uncommitted branch edits first, and keeps them through the merge', async () => {
      await divergeNonConflicting()
      await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted\n')
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.committedBranch).toBe(true)
      expect(await fs.readFile(path.join(repo, 'wip.txt'), 'utf8')).toBe('uncommitted\n')
      expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('trunk work\n')
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
    })

    it('reports up to date when the branch already contains the default', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'c.txt'), 'branch work\n')
      await commitWorkingTree(repo, 'c')
      const before = (await run('git', ['-C', repo, 'rev-parse', 'feature'])).stdout.trim()
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(true)
      // Nothing moved.
      expect((await run('git', ['-C', repo, 'rev-parse', 'feature'])).stdout.trim()).toBe(before)
    })

    it('refuses on the default branch itself', async () => {
      const res = await updateFromDefault(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/default branch/i)
    })

    // THE safety claim: a conflicting update changes NOTHING in the user's
    // real checkout — bytes identical, no in-progress merge state (which
    // would make the editor refuse to boot: canonical-preflight.ts refuses
    // on MERGE_HEAD), no leftover worktree.
    it('a conflict leaves the real working tree byte-identical and merge-free', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'page version\n')
      await commitWorkingTree(repo, 'page')
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'a.txt'), 'trunk version\n')
      await commitWorkingTree(repo, 'trunk')
      await switchBranch(repo, 'feature')
      // An uncommitted edit on top, to prove it survives too.
      await fs.writeFile(path.join(repo, 'extra.txt'), 'uncommitted extra\n')

      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBe(true)
      expect(res.ok === false && res.conflictFiles).toEqual(['a.txt'])

      // Real tree: byte-identical.
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('page version\n')
      expect(await fs.readFile(path.join(repo, 'extra.txt'), 'utf8')).toBe('uncommitted extra\n')
      // Still on the branch, no in-progress merge, no leftover worktree.
      expect(await currentBranch(repo)).toBe('feature')
      await expect(fs.access(path.join(repo, '.git', 'MERGE_HEAD'))).rejects.toThrow()
      const wt = await run('git', ['-C', repo, 'worktree', 'list'])
      expect(wt.stdout).not.toContain('.desde/update-')
    })

    // THE honesty claim (review blocker): the auto-commit runs BEFORE the
    // merge can fail, so a conflicting update has still moved the branch
    // tip and flipped the tree clean. The result must report that commit
    // and the message must not claim nothing changed.
    it('a conflicting update reports the auto-commit and never claims nothing changed', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'a.txt'), 'page version\n')
      await commitWorkingTree(repo, 'page')
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'a.txt'), 'trunk version\n')
      await commitWorkingTree(repo, 'trunk')
      await switchBranch(repo, 'feature')
      await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted work\n')
      const tipBefore = (await run('git', ['-C', repo, 'rev-parse', 'feature'])).stdout.trim()

      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBe(true)
      expect(res.ok === false && res.committedBranch).toBe(true)
      // The message tells the truth: the edits were committed and the
      // commit survives; it does NOT say nothing was changed.
      expect(res.ok === false && res.reason).not.toMatch(/nothing was changed/i)
      expect(res.ok === false && res.reason).toMatch(/committed/i)
      // The commit is real: the tip moved, the tree is clean, and the
      // uncommitted work is inside the new commit.
      const tipAfter = (await run('git', ['-C', repo, 'rev-parse', 'feature'])).stdout.trim()
      expect(tipAfter).not.toBe(tipBefore)
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
      const show = await run('git', ['-C', repo, 'show', 'feature:wip.txt'])
      expect(show.stdout).toBe('uncommitted work\n')
    })

    it('reports the auto-commit on the up-to-date path, with the post-commit sha', async () => {
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted\n')

      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(true)
      // The commit is reported, and `sha` is the tip AFTER it — a caller
      // reading `upToDate` must not conclude no ref moved.
      expect(res.ok && res.committedBranch).toBe(true)
      const tip = (await run('git', ['-C', repo, 'rev-parse', 'feature'])).stdout.trim()
      expect(res.ok && res.sha).toBe(tip)
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
    })

    it('a failing commit-msg hook cannot fail the update (the merge runs --no-verify)', async () => {
      await divergeNonConflicting()
      const hooks = path.join(repo, '.git', 'hooks')
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, 'commit-msg'),
        '#!/bin/sh\necho "policy: nope" >&2\nexit 1\n',
        { mode: 0o755 },
      )
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('trunk work\n')
    })

    // A merge failure with NO unmerged paths is not a conflict. Before the
    // classification fix, a refusing hook (or unrelated histories) came
    // back `conflict: true` with an empty file list and git's actual
    // reason was thrown away. prepare-commit-msg is the probe because,
    // unlike commit-msg, `--no-verify` does not suppress it.
    it("a non-conflict merge failure carries git's reason instead of claiming a conflict", async () => {
      await divergeNonConflicting()
      const hooks = path.join(repo, '.git', 'hooks')
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, 'prepare-commit-msg'),
        '#!/bin/sh\necho "policy: nope" >&2\nexit 1\n',
        { mode: 0o755 },
      )
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBeUndefined()
      expect(res.ok === false && res.conflictFiles).toBeUndefined()
      expect(res.ok === false && res.reason).toMatch(/policy: nope/)
      // ...as ONE line. Classifying this away from a fake conflict is only
      // half the job: handing the toast git's whole multi-line block back is
      // the very thing the fetch and push classifiers exist to prevent.
      expect(res.ok === false && res.reason.split('\n')).toHaveLength(1)
    })

    it('names a conflicted path with a space and non-ASCII exactly, not C-quoted', async () => {
      // The file exists on main first so both sides can diverge on it.
      await fs.writeFile(path.join(repo, 'café note.txt'), 'base\n')
      await commitWorkingTree(repo, 'base')
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'café note.txt'), 'page version\n')
      await commitWorkingTree(repo, 'page')
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'café note.txt'), 'trunk version\n')
      await commitWorkingTree(repo, 'trunk')
      await switchBranch(repo, 'feature')

      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBe(true)
      // The REAL path — the whole point is naming a file the user can go
      // open, so `"caf\\303\\251 note.txt"` (quotes included) is a bug.
      expect(res.ok === false && res.conflictFiles).toEqual(['café note.txt'])
    })

    it('the concurrent-write refusal reports the auto-commit honestly', async () => {
      await divergeNonConflicting()
      await fs.writeFile(path.join(repo, 'wip.txt'), 'uncommitted\n')
      // Simulate a concurrent write landing mid-update: post-commit fires
      // on the auto-commit (--no-verify does not suppress it) and dirties
      // a tracked file, so the settled check refuses the fast-forward.
      const hooks = path.join(repo, '.git', 'hooks')
      await fs.mkdir(hooks, { recursive: true })
      await fs.writeFile(
        path.join(hooks, 'post-commit'),
        `#!/bin/sh\nprintf 'concurrent write\\n' > '${path.join(repo, 'a.txt')}'\n`,
        { mode: 0o755 },
      )
      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.committedBranch).toBe(true)
      expect(res.ok === false && res.reason).not.toMatch(/nothing was changed/i)
      expect(res.ok === false && res.reason).toMatch(/committed/i)
      // The concurrent write survived — the refusal is what protects it.
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('concurrent write\n')
    })

    it('a fast-forward that cannot write the checkout fails honestly instead of claiming no change', async () => {
      // main modifies a file inside `sub/`; feature diverges elsewhere so
      // the merge is clean, and applying it must rewrite `sub/f.txt` in the
      // REAL checkout — which an unwritable directory makes fail part-way.
      await fs.mkdir(path.join(repo, 'sub'), { recursive: true })
      await fs.writeFile(path.join(repo, 'sub', 'f.txt'), 'base\n')
      await commitWorkingTree(repo, 'base')
      await createBranch(repo, 'feature', 'default')
      await fs.writeFile(path.join(repo, 'c.txt'), 'branch work\n')
      await commitWorkingTree(repo, 'c')
      await switchBranch(repo, 'main')
      await fs.writeFile(path.join(repo, 'sub', 'f.txt'), 'trunk version\n')
      await commitWorkingTree(repo, 'trunk')
      await switchBranch(repo, 'feature')

      await fs.chmod(path.join(repo, 'sub'), 0o555)
      try {
        const res = await updateFromDefault(repo, 'feature')
        expect(res.ok).toBe(false)
        // Not a conflict, and no false "nothing changed" claim: either the
        // branch was restored, or the message says the tree may be mixed.
        expect(res.ok === false && res.conflict).toBeUndefined()
        expect(res.ok === false && res.reason).not.toMatch(/nothing was changed/i)
        expect(res.ok === false && res.reason).toMatch(/restored|mix two commits/i)
      } finally {
        await fs.chmod(path.join(repo, 'sub'), 0o755)
      }
    })

    it('CX7 fix round 1: refuses, and creates nothing at the target, when .desde is a symlink out of the worktree', async () => {
      await divergeNonConflicting()

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'git-branches-outside-'))
      await fs.symlink(outside, path.join(repo, '.desde'))

      const res = await updateFromDefault(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/symbolic link/i)
      // Nothing landed under the symlink target: no ephemeral worktree
      // directory, and no `git worktree add` was ever attempted.
      expect(await fs.readdir(outside)).toEqual([])

      await fs.rm(outside, { recursive: true, force: true })
    })
  })

  describe('remote sync: fetch, behind, pull, rejected push', () => {
    let remote: string
    let clone: string

    beforeEach(async () => {
      remote = await fs.mkdtemp(path.join(os.tmpdir(), 'git-remote-'))
      await run('git', ['-C', remote, 'init', '--bare', '--initial-branch=main', '--quiet'])
      await run('git', ['-C', repo, 'remote', 'add', 'origin', remote])
      await pushToOrigin(repo, 'main')
      // A second checkout standing in for a collaborator (or another machine).
      clone = await fs.mkdtemp(path.join(os.tmpdir(), 'git-clone-'))
      await run('git', ['clone', '--quiet', remote, clone])
      await run('git', ['-C', clone, 'config', 'user.email', 't2@e.com'])
      await run('git', ['-C', clone, 'config', 'user.name', 'T2'])
      await run('git', ['-C', clone, 'config', 'commit.gpgsign', 'false'])
    })
    afterEach(async () => {
      await fs.rm(remote, { recursive: true, force: true })
      await fs.rm(clone, { recursive: true, force: true })
    })

    /** Commit a file in the collaborator clone and push it to origin. */
    async function remoteCommit(file: string, content: string): Promise<void> {
      await fs.writeFile(path.join(clone, file), content)
      await run('git', ['-C', clone, 'add', '--', file])
      await run('git', ['-C', clone, 'commit', '-m', `remote ${file}`, '--quiet'])
      await run('git', ['-C', clone, 'push', '--quiet'])
    }

    it('fetch surfaces the behind count, and pull merges the remote commits in', async () => {
      await remoteCommit('b.txt', 'remote work\n')
      // Before the fetch the remote-tracking ref is stale: behind reads 0.
      expect(await countCommitsBehind(repo, 'main', 'origin/main')).toBe(0)
      const fetched = await fetchOrigin(repo)
      expect(fetched.ok).toBe(true)
      expect(await countCommitsBehind(repo, 'main', 'origin/main')).toBe(1)

      const res = await updateFromRemote(repo, 'main')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(false)
      expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('remote work\n')
      expect((await run('git', ['-C', repo, 'status', '--porcelain'])).stdout.trim()).toBe('')
      expect(await countCommitsBehind(repo, 'main', 'origin/main')).toBe(0)
    })

    it('a conflicting pull changes nothing in the real tree and names the file', async () => {
      await remoteCommit('a.txt', 'remote version\n')
      await fs.writeFile(path.join(repo, 'a.txt'), 'local version\n')
      await commitWorkingTree(repo, 'local')
      expect((await fetchOrigin(repo)).ok).toBe(true)

      const res = await updateFromRemote(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.conflict).toBe(true)
      expect(res.ok === false && res.conflictFiles).toEqual(['a.txt'])
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('local version\n')
      expect(await currentBranch(repo)).toBe('main')
      await expect(fs.access(path.join(repo, '.git', 'MERGE_HEAD'))).rejects.toThrow()
      const wt = await run('git', ['-C', repo, 'worktree', 'list'])
      expect(wt.stdout).not.toContain('.desde/update-')
    })

    it('pull reports up to date when origin has nothing new', async () => {
      expect((await fetchOrigin(repo)).ok).toBe(true)
      const res = await updateFromRemote(repo, 'main')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(true)
    })

    it('classifies a non-fast-forward push into one sentence with the pull action', async () => {
      await remoteCommit('b.txt', 'remote work\n')
      await fs.writeFile(path.join(repo, 'c.txt'), 'local work\n')
      await commitWorkingTree(repo, 'local')

      const res = await pushToOrigin(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.rejected).toBe(true)
      expect(res.ok === false && res.reason).toMatch(/pull remote changes/i)
      // The raw git hint block is replaced, not surfaced.
      expect(res.ok === false && res.reason).not.toMatch(/hint:/)
    })

    // The state `git push origin main:other` (or a fork/rename workflow)
    // leaves behind: the branch's upstream is NOT origin/<branch>. Pull
    // must follow the configured upstream, and the hardcoded ref must not
    // silently report "0 behind" for it.
    it('pulls from the configured upstream when it is not origin/<same-name>', async () => {
      // Push main under the name `other` and track it.
      await run('git', ['-C', repo, 'push', '--quiet', 'origin', 'main:other'])
      await run('git', ['-C', repo, 'branch', '--set-upstream-to=origin/other', 'main'])
      expect(await branchUpstream(repo, 'main')).toBe('origin/other')

      // A collaborator advances the `other` remote branch.
      await fs.writeFile(path.join(clone, 'b.txt'), 'remote work\n')
      await run('git', ['-C', clone, 'add', '--', 'b.txt'])
      await run('git', ['-C', clone, 'commit', '-m', 'remote b', '--quiet'])
      await run('git', ['-C', clone, 'push', '--quiet', 'origin', 'main:other'])

      expect((await fetchOrigin(repo)).ok).toBe(true)
      // The hardcoded convention reads 0 here — indistinguishable from up
      // to date — while the real upstream is 1 behind.
      expect(await countCommitsBehind(repo, 'main', 'origin/main')).toBe(0)
      expect(await countCommitsBehind(repo, 'main', 'origin/other')).toBe(1)

      const res = await updateFromRemote(repo, 'main')
      expect(res.ok).toBe(true)
      expect(res.ok && res.upToDate).toBe(false)
      expect(await fs.readFile(path.join(repo, 'b.txt'), 'utf8')).toBe('remote work\n')
    })

    it('refuses to pull a branch with no upstream, naming the branch', async () => {
      // The remote exists, but this fresh branch was never pushed.
      await createBranch(repo, 'feature', 'default')
      const res = await updateFromRemote(repo, 'feature')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/'feature' has no upstream/)
      expect(res.ok === false && res.committedBranch).toBe(false)
    })
  })

  describe('fetchOrigin / updateFromRemote without a remote', () => {
    it('fetchOrigin fails cleanly with no origin remote', async () => {
      const res = await fetchOrigin(repo)
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason.length).toBeGreaterThan(0)
    })

    it('a fetch failure is one plain sentence, never the raw git block', async () => {
      // An origin that is not a reachable repository — git answers with a
      // five-line `fatal:` block, which must not reach a toast verbatim.
      await run('git', [
        '-C', repo, 'remote', 'add', 'origin',
        path.join(os.tmpdir(), 'no-such-remote-anywhere'),
      ])
      const res = await fetchOrigin(repo)
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).not.toContain('\n')
      expect(res.ok === false && res.reason).not.toMatch(/^fatal:/)
    })

    it('updateFromRemote refuses a branch with no upstream by name instead of erroring', async () => {
      const res = await updateFromRemote(repo, 'main')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/'main' has no upstream/)
      expect(res.ok === false && res.committedBranch).toBe(false)
    })
  })

  describe('discardFile', () => {
    it('rejects the repo root as a pathspec ("." / absolute root) — codex P1', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n')
      for (const evil of ['.', '', repo, './']) {
        const res = await discardFile(repo, evil, 'modified')
        expect(res.ok).toBe(false)
      }
      // The tree-wide wipe must NOT have happened.
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('edited\n')
    })

    // Audit S19: the containment check validates a git PATHSPEC as if it
    // were a filesystem path. `path.resolve(root, '*')` is `<root>/*` —
    // inside the root, so it PASSED — and git then expanded it tree-wide.
    it('rejects git pathspec magic that a path-containment check waves through', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n')
      await fs.mkdir(path.join(repo, 'src'), { recursive: true })
      await fs.writeFile(path.join(repo, 'src', 'b.txt'), 'b\n')
      await fs.writeFile(path.join(repo, 'brand-new.txt'), 'untracked\n')

      for (const evil of ['*', '**', ':/', ':(glob)**', '?', '[a-z]*', 'src/*']) {
        for (const status of ['modified', 'added'] as const) {
          const res = await discardFile(repo, evil, status)
          expect(res.ok).toBe(false)
          expect(res.ok === false && res.reason).toMatch(/not a plain file path/i)
        }
      }

      // Nothing restored, nothing deleted.
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('edited\n')
      expect(await fs.readFile(path.join(repo, 'src', 'b.txt'), 'utf8')).toBe('b\n')
      expect(await fs.readFile(path.join(repo, 'brand-new.txt'), 'utf8')).toBe('untracked\n')
    })

    it("rejects pathspec magic in a rename's 'from' path too", async () => {
      await fs.writeFile(path.join(repo, 'brand-new.txt'), 'untracked\n')
      const res = await discardFile(repo, 'a.txt', 'renamed', '*')
      expect(res.ok).toBe(false)
      expect(await fs.readFile(path.join(repo, 'brand-new.txt'), 'utf8')).toBe('untracked\n')
    })

    // The other half of the S19 fix: GIT_LITERAL_PATHSPECS in GIT_ENV. The
    // lexical guard above refuses these spellings outright, so this proves
    // the env pin independently — via a filename git would otherwise read
    // as a glob if it reached the command.
    it('treats a filename containing a glob character as a literal path', async () => {
      // A file literally named `weird[1].txt` — legal on disk, and a glob
      // to git without GIT_LITERAL_PATHSPECS.
      await fs.writeFile(path.join(repo, 'weird[1].txt'), 'x\n')
      await run('git', ['-C', repo, 'add', '--', 'weird[1].txt'])
      await run('git', ['-C', repo, 'commit', '-m', 'weird', '--quiet'])
      await fs.writeFile(path.join(repo, 'weird[1].txt'), 'edited\n')
      await fs.writeFile(path.join(repo, 'a.txt'), 'also edited\n')

      // Our lexical guard refuses it (defense in depth costs this file the
      // one-click discard) — and, crucially, nothing else is touched.
      const res = await discardFile(repo, 'weird[1].txt', 'modified')
      expect(res.ok).toBe(false)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('also edited\n')
    })

    it('discards an unstaged modification back to HEAD content', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n')
      const res = await discardFile(repo, 'a.txt', 'modified')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a modification that is both staged and further edited (MM)', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'staged\n')
      await run('git', ['-C', repo, 'add', 'a.txt'])
      await fs.writeFile(path.join(repo, 'a.txt'), 'then edited unstaged\n')
      const res = await discardFile(repo, 'a.txt', 'modified')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a deleted file by restoring it from HEAD', async () => {
      await fs.rm(path.join(repo, 'a.txt'))
      const res = await discardFile(repo, 'a.txt', 'deleted')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a staged deletion too', async () => {
      await run('git', ['-C', repo, 'rm', '-q', 'a.txt'])
      const res = await discardFile(repo, 'a.txt', 'deleted')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards an untracked (added) file by removing it', async () => {
      await fs.writeFile(path.join(repo, 'new.txt'), 'new\n')
      const res = await discardFile(repo, 'new.txt', 'added')
      expect(res.ok).toBe(true)
      await expect(fs.access(path.join(repo, 'new.txt'))).rejects.toThrow()
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a staged-but-uncommitted added file', async () => {
      await fs.writeFile(path.join(repo, 'new.txt'), 'new\n')
      await run('git', ['-C', repo, 'add', 'new.txt'])
      const res = await discardFile(repo, 'new.txt', 'added')
      expect(res.ok).toBe(true)
      await expect(fs.access(path.join(repo, 'new.txt'))).rejects.toThrow()
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a rename, restoring the original file and removing the new one', async () => {
      await run('git', ['-C', repo, 'mv', 'a.txt', 'renamed.txt'])
      const res = await discardFile(repo, 'renamed.txt', 'renamed', 'a.txt')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      await expect(fs.access(path.join(repo, 'renamed.txt'))).rejects.toThrow()
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it('discards a rename with extra content edits on top (RM)', async () => {
      await run('git', ['-C', repo, 'mv', 'a.txt', 'renamed.txt'])
      await fs.writeFile(path.join(repo, 'renamed.txt'), 'a\nextra\n')
      const res = await discardFile(repo, 'renamed.txt', 'renamed', 'a.txt')
      expect(res.ok).toBe(true)
      expect(await fs.readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('a\n')
      await expect(fs.access(path.join(repo, 'renamed.txt'))).rejects.toThrow()
      expect(await isWorkingTreeDirty(repo)).toBe(false)
    })

    it("refuses a rename discard with no 'from' path", async () => {
      await run('git', ['-C', repo, 'mv', 'a.txt', 'renamed.txt'])
      const res = await discardFile(repo, 'renamed.txt', 'renamed')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/original path/i)
    })

    it('refuses a path that escapes the repo root', async () => {
      const res = await discardFile(repo, '../outside.txt', 'added')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/not a plain file path/i)
    })

    it("refuses a rename discard whose 'from' path escapes the repo root", async () => {
      const res = await discardFile(repo, 'a.txt', 'renamed', '../outside.txt')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason).toMatch(/not a plain file path/i)
    })

    it('reports a git failure cleanly instead of throwing', async () => {
      const res = await discardFile(repo, 'does-not-exist.txt', 'modified')
      expect(res.ok).toBe(false)
      expect(res.ok === false && res.reason.length).toBeGreaterThan(0)
    })
  })

  // P2 (round-4 whole-branch review finding, 2026-08-19): a `.gitignore`d
  // path is invisible to `git status` — that's what "ignored" means — so
  // it was indistinguishable from "clean because committed" to the
  // edit-ledger route's reconcile step. `listDirtyRepoRelativePaths` now
  // ALSO reports what's ignored, from the SAME `git status` invocation
  // (`--ignored=matching`, not the default `traditional` mode — see the
  // function's own doc comment for the measured cost difference between
  // the two on a large ignored tree).
  describe('listDirtyRepoRelativePaths — ignored paths', () => {
    it('reports an ignored FILE as its own path, not expanded from a directory', async () => {
      await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n')
      await run('git', ['-C', repo, 'add', '.gitignore'])
      await run('git', ['-C', repo, 'commit', '-m', 'gitignore', '--quiet'])
      await fs.writeFile(path.join(repo, 'ignored.txt'), 'x\n')

      const { dirty, ignoredPrefixes } = await listDirtyRepoRelativePaths(repo)
      expect(dirty.has('ignored.txt')).toBe(false)
      expect(ignoredPrefixes).toEqual(['ignored.txt'])
    })

    it('reports an ignored DIRECTORY as one directory-shaped entry, not one per file inside it', async () => {
      await fs.writeFile(path.join(repo, '.gitignore'), 'ignored-dir/\n')
      await run('git', ['-C', repo, 'add', '.gitignore'])
      await run('git', ['-C', repo, 'commit', '-m', 'gitignore', '--quiet'])
      await fs.mkdir(path.join(repo, 'ignored-dir', 'nested'), { recursive: true })
      await fs.writeFile(path.join(repo, 'ignored-dir', 'one.txt'), '1\n')
      await fs.writeFile(path.join(repo, 'ignored-dir', 'nested', 'two.txt'), '2\n')

      const { ignoredPrefixes } = await listDirtyRepoRelativePaths(repo)
      // Exactly one entry for the whole directory — MEASURED: expanding
      // this the way untracked files are expanded would cost one line
      // per file for every ignored file in the repo (e.g. every file
      // under a real `node_modules/`), on every single reconcile poll.
      expect(ignoredPrefixes).toEqual(['ignored-dir/'])
    })

    it('still reports genuinely dirty (non-ignored) files as dirty, unaffected by --ignored', async () => {
      await fs.writeFile(path.join(repo, 'a.txt'), 'changed\n')
      const { dirty, ignoredPrefixes } = await listDirtyRepoRelativePaths(repo)
      expect(dirty.has('a.txt')).toBe(true)
      expect(ignoredPrefixes).toEqual([])
    })
  })

  // F2 (round-8 whole-branch review finding, 2026-08-19): `--untracked-files=all`
  // (above) expands every untracked FILE into its own porcelain -z entry, so
  // output size scales with total untracked file count, not top-level entry
  // count. Node's `execFile` defaults to a 1 MiB stdout/stderr buffer and
  // throws `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` past it — a real risk on a
  // large enough tree, and worse than a one-off failure here specifically:
  // both callers of this function (`reconcileLedger`'s caller and
  // `captureCommitCoverage`) catch and skip on any error, so a MAXBUFFER
  // throw doesn't surface loudly, it silently strands ledger entries as
  // pending forever.
  describe('listDirtyRepoRelativePaths — output larger than the default execFile buffer', () => {
    it('does not throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER on a tree with enough untracked files to exceed 1 MiB of porcelain output', async () => {
      // Three 200-char path segments plus a short filename, repeated
      // 4,000 times, produces ~2.4 MB of `-z` porcelain output (~611
      // bytes/entry: 3-byte status prefix + ~607-byte path + trailing
      // NUL) — well past Node's 1 MiB default, comfortably under the 32
      // MiB cap the fix sets. Nested nonsense-named directories keep
      // each path component under typical filesystem limits (~255
      // bytes) while keeping file count (and so test runtime) low.
      const seg = 'a'.repeat(200)
      const deepDir = path.join(repo, seg, seg, seg)
      await fs.mkdir(deepDir, { recursive: true })
      const fileCount = 4000
      for (let i = 0; i < fileCount; i++) {
        await fs.writeFile(path.join(deepDir, `f${i}`), '')
      }

      const { dirty } = await listDirtyRepoRelativePaths(repo)
      expect(dirty.size).toBeGreaterThanOrEqual(fileCount)
    }, 30000)
  })

  describe('isIgnoredPath', () => {
    it('matches an exact ignored-file entry', () => {
      expect(isIgnoredPath('ignored.txt', ['ignored.txt'])).toBe(true)
      expect(isIgnoredPath('other.txt', ['ignored.txt'])).toBe(false)
    })

    it('matches a file nested inside an ignored-directory entry', () => {
      const prefixes = ['.desde/']
      expect(isIgnoredPath('.desde/edit-log.jsonl', prefixes)).toBe(true)
      expect(isIgnoredPath('.desde/backups/1/App.vue', prefixes)).toBe(true)
    })

    it('does not match a directory-shaped entry against an unrelated sibling with a shared prefix', () => {
      // `.desde-extra/x.txt` must not match the `.desde/` entry
      // — plain `startsWith` on the un-slashed name would be wrong here.
      expect(isIgnoredPath('.desde-extra/x.txt', ['.desde/'])).toBe(false)
    })

    it('returns false when nothing is ignored', () => {
      expect(isIgnoredPath('App.vue', [])).toBe(false)
    })

    // MEASURED (2026-08-20): this is the empirical proof `reconcileLedger`'s
    // doc comment cites for removing `isIgnored` as a SEPARATE gate — a
    // tracked file never shows up as "ignored" in git's own status output,
    // even once a later `.gitignore` rule would otherwise match it, so an
    // untracked-and-ignored path (the only kind `isIgnoredPath` can ever
    // report `true` for from real `listDirtyRepoRelativePaths` output) has
    // no blob at HEAD for `readHeadBlobs` to find either way.
    it('a tracked file that later matches .gitignore never appears in --ignored=matching output', async () => {
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'hello\n')
      await run('git', ['-C', repo, 'add', 'tracked.txt'])
      await run('git', ['-C', repo, 'commit', '-m', 'track it', '--quiet'])
      await fs.writeFile(path.join(repo, '.gitignore'), 'tracked.txt\n')
      await run('git', ['-C', repo, 'add', '.gitignore'])
      await run('git', ['-C', repo, 'commit', '-m', 'ignore it', '--quiet'])
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n')

      const { dirty, ignoredPrefixes } = await listDirtyRepoRelativePaths(repo)
      expect(dirty.has('tracked.txt')).toBe(true)
      expect(ignoredPrefixes).toEqual([])
    })
  })

  // `readHeadBlobs` — the positive-evidence read `reconcileLedger`'s call
  // site (`http-server.ts`) uses to prove an entry's own bytes genuinely
  // reached HEAD, not merely that the working tree is quiet. See its own
  // doc comment for the batching/cost reasoning.
  describe('readHeadBlobs', () => {
    it('reads HEAD content for multiple paths in one batch, and omits a path HEAD holds nothing for', async () => {
      await fs.writeFile(path.join(repo, 'b.txt'), 'b content\n')
      await run('git', ['-C', repo, 'add', 'b.txt'])
      await run('git', ['-C', repo, 'commit', '-m', 'add b', '--quiet'])

      const blobs = await readHeadBlobs(repo, ['a.txt', 'b.txt', 'never-committed.txt'])
      expect(blobs.get('a.txt')?.toString('utf8')).toBe('a\n')
      expect(blobs.get('b.txt')?.toString('utf8')).toBe('b content\n')
      expect(blobs.has('never-committed.txt')).toBe(false)
      expect(blobs.size).toBe(2)
    })

    it('returns an empty map for an empty path list, without spawning git', async () => {
      // A bad root would make any real spawn throw — reaching the empty
      // map instead of a throw is itself proof no subprocess ran.
      const blobs = await readHeadBlobs(path.join(repo, 'does-not-exist'), [])
      expect(blobs.size).toBe(0)
    })

    // The "unknown must never read as committed" contract starts here:
    // a genuine git/spawn failure must throw, not return a partial or
    // empty map that a caller could mistake for "nothing matches" (which
    // reconcileLedger's own conservative default would treat the same as
    // "confirmed not committed" — correct for a real miss, wrong for "we
    // couldn't even ask").
    it('throws rather than returning a partial or empty map when the repo cannot be read', async () => {
      await expect(readHeadBlobs(path.join(repo, 'does-not-exist'), ['a.txt'])).rejects.toThrow()
    })
  })
})
