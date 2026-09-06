/**
 * FX20 item 1 (codex review + adversarial verification, 2026-09-06,
 * SECURITY) — the two content-returning read-root tools must decide what
 * they may return from the CONCRETE PATHS they read, not from the spelling
 * of the scope they were handed.
 *
 * ## Why this file exists rather than more cases in `secret-paths.test.ts`
 *
 * Five review rounds each found a new way to spell a scope that reached a
 * credential file, and each round added the spelling it had just been shown
 * to a pattern analyser. The verifier's judgement, which this file encodes:
 * those were not five defects but one, because glob and pathspec syntax have
 * unbounded spellings for identical reach, so a spelling test buys exactly
 * one spelling per round.
 *
 * So the assertions here are not "this pattern is refused". They are: for
 * EVERY scope in the table, whatever the tool returns contains no byte of a
 * credential file. That property is spelling-independent, which is the whole
 * point — a new spelling invented tomorrow is already covered by it.
 *
 * The table is the verifier's own reproduction inputs verbatim: the six
 * `search_external_files` scopes and three `session_diff` scopes from
 * `probe2.mts`, plus the eight brace and character-class directory spellings
 * from `probe3.mts` that walked past the analyser.
 *
 * Every secret in the fixtures is obviously fake and lives in a temp
 * directory that is removed after each test.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadReadRoots } from '../core/read-roots'
import { searchExternalFilesTool, sessionDiffTool } from './git-tools'
import type { BridgeClient, ToolContext } from './types'

const execFileP = promisify(execFile)

const fakeBridge: BridgeClient = {
  async send() {
    return null
  },
}

/** Obviously fake. Any of these appearing in a tool result is the defect. */
const FAKE_ENV_KEY = 'OPENAI_API_KEY=sk-FAKE-not-a-real-key-000'
const FAKE_NESTED_TOKEN = 'NESTED_FAKE_TOKEN=abc123'
const FAKE_PEM = '-----BEGIN FAKE PRIVATE KEY-----'
const FAKE_SSH_KEY = 'SSH_FAKE_PRIVATE_MATERIAL_000'
const FAKE_AWS_KEY = 'aws_secret_access_key = FAKE0000'
/** A line the tools SHOULD still return, so a green run cannot be vacuous. */
const REAL_HIT = 'const API_KEY_NAME = "OPENAI_API_KEY"'

const EVERY_FAKE_SECRET = [
  FAKE_ENV_KEY,
  FAKE_NESTED_TOKEN,
  FAKE_PEM,
  FAKE_SSH_KEY,
  FAKE_AWS_KEY,
]

/**
 * A repository whose credential files sit at every shape the policy names:
 * a root dot-file, a nested one, a non-dot key file, and two secret
 * DIRECTORIES (the lane `probe3.mts` walked past).
 */
async function seedRepo(dir: string): Promise<void> {
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, '.ssh'), { recursive: true })
  await mkdir(join(dir, '.aws'), { recursive: true })
  await writeFile(join(dir, '.env'), `${FAKE_ENV_KEY}\n`, 'utf8')
  await writeFile(join(dir, 'src', '.env'), `${FAKE_NESTED_TOKEN}\n`, 'utf8')
  await writeFile(join(dir, 'deploy.pem'), `${FAKE_PEM}\n`, 'utf8')
  await writeFile(join(dir, '.ssh', 'notes.txt'), `${FAKE_SSH_KEY}\n`, 'utf8')
  await writeFile(join(dir, '.aws', 'credentials'), `${FAKE_AWS_KEY}\n`, 'utf8')
  // The legitimate hit: an ordinary source file that mentions the same
  // words the query matches on.
  await writeFile(join(dir, 'src', 'app.ts'), `${REAL_HIT}\n`, 'utf8')
  await execFileP('git', ['add', '-A', '-f'], { cwd: dir })
  await execFileP('git', ['commit', '-q', '-m', 'seed'], { cwd: dir })
}

function resultText(r: { ok: boolean; output?: unknown; error?: string }): string {
  return JSON.stringify(r.ok ? r.output : r.error)
}

describe('read-root tools decide on the resolved set (FX20 item 1)', () => {
  let worktree: string
  let external: string
  let baseSha: string
  let ctx: ToolContext

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'fx20-wt-'))
    external = await mkdtemp(join(tmpdir(), 'fx20-ext-'))
    await seedRepo(external)

    // The worktree gets its base commit FIRST, then the credential files, so
    // `session_diff` (base commit → working tree) has them all in range.
    await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
    await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree })
    await execFileP('git', ['config', 'user.name', 'Test'], { cwd: worktree })
    await writeFile(join(worktree, 'README.md'), 'base\n', 'utf8')
    await execFileP('git', ['add', '-A'], { cwd: worktree })
    await execFileP('git', ['commit', '-q', '-m', 'base'], { cwd: worktree })
    baseSha = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim()
    await mkdir(join(worktree, 'src'), { recursive: true })
    await mkdir(join(worktree, '.ssh'), { recursive: true })
    await writeFile(join(worktree, '.env'), `${FAKE_ENV_KEY}\n`, 'utf8')
    await writeFile(join(worktree, 'src', '.env'), `${FAKE_NESTED_TOKEN}\n`, 'utf8')
    await writeFile(join(worktree, 'deploy.pem'), `${FAKE_PEM}\n`, 'utf8')
    await writeFile(join(worktree, '.ssh', 'notes.txt'), `${FAKE_SSH_KEY}\n`, 'utf8')
    await writeFile(join(worktree, 'src', 'app.ts'), `${REAL_HIT}\n`, 'utf8')
    // Tracked, so `git diff <base>` reports them without an untracked-file
    // walk — the shape a real session produces after the agent has written.
    await execFileP('git', ['add', '-A', '-f'], { cwd: worktree })

    await writeFile(
      join(worktree, 'desde.config.json'),
      JSON.stringify({ readRoots: { ext: { path: external, description: 'External' } } }),
      'utf8',
    )
    const roots = await loadReadRoots({ worktreeRoot: worktree })
    if (!roots.ok) throw new Error(`fixture setup failed: ${roots.errors.join('; ')}`)
    ctx = {
      bridge: fakeBridge,
      repoRoot: worktree,
      readRoots: roots.registry,
      rootCommitSha: baseSha,
      blockSecretReads: true,
    }
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })

  describe('search_external_files', () => {
    /**
     * `probe2.mts`'s six scopes plus the empty form. Under the old rule the
     * empty one was refused and every other one was served, which is the
     * defect stated at its plainest: a call refused in one spelling and
     * allowed in its one-character synonym.
     */
    const SCOPES: ReadonlyArray<{ label: string; paths?: string[] }> = [
      { label: 'no paths at all' },
      { label: 'empty list', paths: [] },
      { label: 'aimed at the file', paths: ['.env'] },
      { label: 'dot', paths: ['.'] },
      { label: 'a directory', paths: ['src'] },
      { label: 'star', paths: ['*'] },
      { label: 'globstar', paths: ['**'] },
    ]

    for (const scope of SCOPES) {
      it(`returns no credential content for ${scope.label}`, async () => {
        const r = await searchExternalFilesTool.run(
          { root: 'ext', query: 'KEY|TOKEN|FAKE', ...(scope.paths ? { paths: scope.paths } : {}) },
          ctx,
        )
        const text = resultText(r)
        for (const secret of EVERY_FAKE_SECRET) expect(text).not.toContain(secret)
      })
    }

    /**
     * `probe3.mts`, verbatim. Seven of these eight walked past the pattern
     * analyser while the literal spelling was refused. The assertion is not
     * that they are refused now — it is that no spelling of a scope can
     * bring back a byte of the file it reaches.
     */
    const DIRECTORY_SPELLINGS = [
      '.{ssh,zzz}/notes.txt',
      '.{ssh}/notes.txt',
      '[.]ssh/notes.txt',
      '.ss[h]/notes.txt',
      '.{aws,zzz}/credentials',
      '.{aws,zzz}/anything.txt',
      '.ssh/notes.txt',
      '.ssh/*',
    ]

    for (const spelling of DIRECTORY_SPELLINGS) {
      it(`returns no credential content for the pathspec '${spelling}'`, async () => {
        const r = await searchExternalFilesTool.run(
          { root: 'ext', query: 'FAKE|KEY|SSH', paths: [spelling] },
          ctx,
        )
        const text = resultText(r)
        for (const secret of EVERY_FAKE_SECRET) expect(text).not.toContain(secret)
      })
    }

    it('still returns the ordinary matches, and says what it withheld', async () => {
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: 'KEY|TOKEN|FAKE', paths: ['.'] },
        ctx,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as {
        matches: Array<{ path?: string; text?: string }>
        withheld?: number
        note?: string
      }
      // Anti-vacuity: the search DID reach the tree and DID find the
      // legitimate line. An empty result would pass the secret assertions
      // above for the wrong reason.
      expect(out.matches.some((m) => m.text?.includes('API_KEY_NAME'))).toBe(true)
      expect(out.matches.every((m) => m.path !== '.env' && m.path !== 'deploy.pem')).toBe(true)
      // Counted, not silently dropped: a short result set with no
      // explanation reads to the model as "the repository does not contain
      // that", which is the belief that makes it keep searching.
      expect(out.withheld ?? 0).toBeGreaterThan(0)
      expect(out.note ?? '').toContain('withheld')
    })

    it('returns everything, credential files included, when the project has not opted in', async () => {
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: 'KEY|TOKEN|FAKE', paths: ['.'] },
        { ...ctx, blockSecretReads: false },
      )
      expect(r.ok).toBe(true)
      // The policy is opt-in and OFF by default. A test that passed with the
      // gate off would prove the filter, not the gate.
      expect(resultText(r)).toContain(FAKE_ENV_KEY)
    })
  })

  describe('session_diff', () => {
    const SCOPES: ReadonlyArray<{ label: string; path?: string }> = [
      { label: 'no path at all' },
      { label: 'aimed at the file', path: '.env' },
      { label: 'dot', path: '.' },
      { label: 'a directory', path: 'src' },
    ]

    for (const scope of SCOPES) {
      it(`returns no credential content for ${scope.label}`, async () => {
        const r = await sessionDiffTool.run(scope.path === undefined ? {} : { path: scope.path }, ctx)
        const text = resultText(r)
        for (const secret of EVERY_FAKE_SECRET) expect(text).not.toContain(secret)
      })
    }

    it('still returns the ordinary diff, and says what it withheld', async () => {
      const r = await sessionDiffTool.run({}, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; withheld?: number; note?: string }
      expect(out.diff).toContain('src/app.ts')
      expect(out.diff).not.toContain('.env')
      expect(out.withheld ?? 0).toBeGreaterThan(0)
      expect(out.note ?? '').toContain('withheld')
    })

    it('returns the credential diff when the project has not opted in', async () => {
      const r = await sessionDiffTool.run({}, { ...ctx, blockSecretReads: false })
      expect(resultText(r)).toContain(FAKE_ENV_KEY)
    })

    it('withholds everything, rather than falling back to the whole tree, when every file in scope is a credential', async () => {
      const r = await sessionDiffTool.run({ path: '.env' }, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; withheld?: number }
      expect(out.diff).toBe('')
      expect(out.withheld).toBe(1)
    })
  })
})

/**
 * FX21 (codex review + adversarial verification, 2026-09-06, SECURITY) — the
 * two tools ask git for machine-readable output instead of parsing its
 * human-readable output.
 *
 * Both cases below are the same mistake in two places: a field git prints for
 * a person to read was split on a byte that can legally appear in a path, so
 * the classifier was asked about a path the repository does not contain.
 *
 * Neither was reachable by the agent in the shipped configuration — the
 * verifier downgraded them to P3 and P4 for that reason. They are here
 * because the filter's whole claim is that it judges the CONCRETE path git
 * resolved, and a parser that invents a path breaks that claim at the root.
 *
 * Fixtures are the verifier's, and every secret value in them is fake.
 */

/** Obviously fake. In a file whose path contains a colon. */
const FAKE_COLON_FILE_KEY = 'AKIA_FAKE_COLON_LEAK=zzz-fake-colon-1'
/** Obviously fake. In an ordinary `.env` under a directory containing a colon. */
const FAKE_COLON_DIR_KEY = 'AKIA_FAKE_DIRCOLON=zzz-fake-colon-2'
/** Obviously fake. Lives in a `.env` the fixture then renames to an innocent name. */
const FAKE_RENAMED_KEY = 'AWS_SECRET_ACCESS_KEY=zzz-fake-rename-leak'

describe('git output is parsed as data, not as prose (FX21)', () => {
  let worktree: string
  let external: string
  let ctx: ToolContext

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'fx21-wt-'))
    external = await mkdtemp(join(tmpdir(), 'fx21-ext-'))
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  })

  /**
   * A colon is a legal byte in a POSIX filename and git tracks it happily —
   * measured on macOS 24.6 / APFS with git 2.54.0. `git grep`'s default
   * output separates path, line number and text with colons, so the path
   * field is ambiguous the moment a path contains one.
   */
  describe('search_external_files with a colon in the path', () => {
    beforeEach(async () => {
      // `loadReadRoots` reads the worktree's own git config, so the worktree
      // has to be a repo even though this case only searches the external one.
      await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
      await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: external })
      await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: external })
      await execFileP('git', ['config', 'user.name', 'Test'], { cwd: external })
      // The credential file's own NAME carries the colon.
      await writeFile(join(external, 'foo:.env'), `${FAKE_COLON_FILE_KEY}\n`, 'utf8')
      // The stronger variant: an ordinary `.env`, made ambiguous only by a
      // colon in a DIRECTORY name above it.
      await mkdir(join(external, 'a:b'), { recursive: true })
      await writeFile(join(external, 'a:b', '.env'), `${FAKE_COLON_DIR_KEY}\n`, 'utf8')
      // The anti-vacuity line: an ordinary file the search must still return.
      await writeFile(join(external, 'app.ts'), 'const AKIA_FAKE_NAME = "example"\n', 'utf8')
      await execFileP('git', ['add', '-A', '-f'], { cwd: external })
      await execFileP('git', ['commit', '-q', '-m', 'seed'], { cwd: external })

      await writeFile(
        join(worktree, 'desde.config.json'),
        JSON.stringify({ readRoots: { ext: { path: external, description: 'External' } } }),
        'utf8',
      )
      const roots = await loadReadRoots({ worktreeRoot: worktree })
      if (!roots.ok) throw new Error(`fixture setup failed: ${roots.errors.join('; ')}`)
      ctx = {
        bridge: fakeBridge,
        repoRoot: worktree,
        readRoots: roots.registry,
        blockSecretReads: true,
      }
    })

    it('withholds a credential file whose own name contains a colon', async () => {
      const r = await searchExternalFilesTool.run({ root: 'ext', query: 'AKIA_FAKE' }, ctx)
      expect(resultText(r)).not.toContain(FAKE_COLON_FILE_KEY)
    })

    it('withholds a credential file under a directory whose name contains a colon', async () => {
      const r = await searchExternalFilesTool.run({ root: 'ext', query: 'AKIA_FAKE' }, ctx)
      expect(resultText(r)).not.toContain(FAKE_COLON_DIR_KEY)
    })

    it('reports the colon paths verbatim, and still returns the ordinary match', async () => {
      const r = await searchExternalFilesTool.run({ root: 'ext', query: 'AKIA_FAKE' }, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as {
        matches: Array<{ path?: string; line?: number; text?: string }>
        withheld?: number
      }
      // Anti-vacuity: an empty result would satisfy the two assertions above
      // for the wrong reason.
      const kept = out.matches.find((m) => m.path === 'app.ts')
      expect(kept).toBeDefined()
      // A truncated path is the visible tell of the old parser, and so is a
      // line number parsed out of the rest of the filename.
      expect(out.matches.some((m) => m.path === 'foo' || m.path === 'a')).toBe(false)
      expect(kept?.line).toBe(1)
      expect(kept?.text).toContain('AKIA_FAKE_NAME')
      expect(out.withheld).toBe(2)
    })

    it('returns the colon-pathed files when the project has not opted in', async () => {
      // The policy is opt-in and OFF by default; a green run with the gate
      // off would prove the filter rather than the gate.
      const r = await searchExternalFilesTool.run(
        { root: 'ext', query: 'AKIA_FAKE' },
        { ...ctx, blockSecretReads: false },
      )
      const text = resultText(r)
      expect(text).toContain(FAKE_COLON_FILE_KEY)
      expect(text).toContain(FAKE_COLON_DIR_KEY)
    })
  })

  /**
   * `session_diff` enumerates the files its scope covers and judges each one.
   * A rename is one change with two names, and the credential half is the
   * one being dropped, so the two names have to be judged together.
   *
   * This is defense-in-depth, not a closed escalation: the agent cannot
   * perform the rename (`rename_file` refuses a secret source, and `Bash` is
   * not among its tools), and once a user has renamed the file themselves
   * the same bytes are readable through a plain `Read` of the new name.
   */
  describe('session_diff across a rename', () => {
    let baseSha: string

    beforeEach(async () => {
      await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: worktree })
      await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree })
      await execFileP('git', ['config', 'user.name', 'Test'], { cwd: worktree })
      await writeFile(join(worktree, '.env'), `${FAKE_RENAMED_KEY}\n`, 'utf8')
      await writeFile(join(worktree, 'app.ts'), 'export const ok = 1\n', 'utf8')
      await execFileP('git', ['add', '-A', '-f'], { cwd: worktree })
      await execFileP('git', ['commit', '-q', '-m', 'base'], { cwd: worktree })
      baseSha = (await execFileP('git', ['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim()
      // The user's own rename, staged. An UNSTAGED `mv` leaves the new name
      // untracked and git reports nothing, so staging is the precondition.
      await execFileP('git', ['mv', '.env', 'notes.txt'], { cwd: worktree })
      // An ordinary edit alongside it, so the diff is not empty once the
      // rename is withheld.
      await writeFile(join(worktree, 'app.ts'), 'export const ok = 2\n', 'utf8')

      const roots = await loadReadRoots({ worktreeRoot: worktree })
      if (!roots.ok) throw new Error(`fixture setup failed: ${roots.errors.join('; ')}`)
      ctx = {
        bridge: fakeBridge,
        repoRoot: worktree,
        readRoots: roots.registry,
        rootCommitSha: baseSha,
        blockSecretReads: true,
      }
    })

    const SCOPES: ReadonlyArray<{ label: string; path?: string }> = [
      { label: 'no path at all' },
      { label: 'dot', path: '.' },
      // The scope that names the destination directly. Under a scoped
      // rename detection git reports a plain addition, so this spelling is
      // the one a per-invocation fix would leave open.
      { label: 'the new name', path: 'notes.txt' },
    ]

    for (const scope of SCOPES) {
      it(`withholds the renamed credential file for ${scope.label}`, async () => {
        const r = await sessionDiffTool.run(scope.path === undefined ? {} : { path: scope.path }, ctx)
        expect(resultText(r)).not.toContain(FAKE_RENAMED_KEY)
      })
    }

    it('still returns the ordinary change, and says what it withheld', async () => {
      const r = await sessionDiffTool.run({}, ctx)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const out = r.output as { diff: string; withheld?: number; note?: string }
      expect(out.diff).toContain('app.ts')
      expect(out.withheld).toBe(1)
      expect(out.note ?? '').toContain('withheld')
    })

    it('shows the rename, and no credential bytes, when the project has not opted in', async () => {
      // Worth stating plainly, because it inverts the usual shape of these
      // cases: with the policy OFF there is nothing to leak here. git's own
      // rename detection is on by default, so an unfiltered `git diff` prints
      // a `rename from`/`rename to` record and no file content at all. The
      // bytes appeared only once the policy rewrote the scope into a literal
      // pathspec for the destination, which is a scope too narrow for git to
      // pair the halves — so it printed the whole file as an addition.
      const r = await sessionDiffTool.run({}, { ...ctx, blockSecretReads: false })
      const text = resultText(r)
      expect(text).toContain('rename to notes.txt')
      expect(text).not.toContain(FAKE_RENAMED_KEY)
    })
  })
})
