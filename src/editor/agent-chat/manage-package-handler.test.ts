/**
 * Tests for `managePackageHandler`. Uses a stub PackageManagerAdapter so
 * we can drive the manifest write + install sequence without running a
 * real `npm install`. The install command is faked to return success and
 * optionally create/mutate a lockfile. Branch mode: the handler edits the
 * working tree in place with no per-op commit — undo comes from the
 * backup journal, not git history.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ApplyManifestOpResult,
  PackageManagerAdapter,
  PackageOp,
} from '../core/package-manager-adapter'
import type { VerificationRunResult } from '../core/verification-adapter'
import type { EditProposalPayload } from '../agent-tools/types'
import {
  getSharedEditHistory,
  resetSharedEditHistoryForTests,
} from '../edit-service/edit-history'
import type { EmitEditResult, FileWriteToolResult } from './editor-tools'
import { managePackageHandler } from './fs-structural-tools'

const execFileP = promisify(execFile)

async function makeWorktreeWithManifest(initialManifest: object): Promise<{
  root: string
  initialSrc: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'pt-mp-'))
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: root })
  const initialSrc = JSON.stringify(initialManifest, null, 2) + '\n'
  await writeFile(join(root, 'package.json'), initialSrc, 'utf8')
  await execFileP('git', ['add', 'package.json'], { cwd: root })
  await execFileP('git', ['commit', '-q', '-m', 'seed'], { cwd: root })
  return { root, initialSrc }
}

function captureEmit(): {
  emitEdit: (p: EditProposalPayload) => Promise<EmitEditResult>
  emissions: EditProposalPayload[]
} {
  const emissions: EditProposalPayload[] = []
  return {
    emissions,
    emitEdit: async (payload) => {
      emissions.push(payload)
      return { ok: true, editId: `eid-${emissions.length}` }
    },
  }
}

function asJson(r: FileWriteToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>
}

/**
 * Build a stub adapter that uses the real `applyManifestOp` import but
 * fakes `install` (no network). Optionally, `installSideEffect` runs
 * synchronously to mutate the lockfile, simulating what real
 * `npm install` would do.
 */
function makeStubAdapter(opts: {
  applyResult?: ApplyManifestOpResult
  installResult?: VerificationRunResult
  installSideEffect?: () => Promise<void> | void
} = {}): PackageManagerAdapter {
  return {
    substrateLabel: 'npm',
    applyManifestOp(src, op: PackageOp): ApplyManifestOpResult {
      if (opts.applyResult) return opts.applyResult
      // Default: minimal add op
      if (op.kind === 'add') {
        const parsed = JSON.parse(src) as Record<string, unknown>
        const deps = (parsed.dependencies as Record<string, string> | undefined) ?? {}
        const next = { ...deps, [op.packageName]: op.versionSpec ?? 'latest' }
        return {
          ok: true,
          newSrc: JSON.stringify({ ...parsed, dependencies: next }, null, 2) + '\n',
        }
      }
      return { ok: false, reason: 'stub does not support remove' }
    },
    async install() {
      if (opts.installSideEffect) await opts.installSideEffect()
      return (
        opts.installResult ?? {
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          command: 'npm install',
        }
      )
    },
  }
}

describe('managePackageHandler', () => {
  let root: string
  let initialSrc: string

  beforeEach(async () => {
    resetSharedEditHistoryForTests()
    const made = await makeWorktreeWithManifest({
      name: 'fixture',
      dependencies: {},
    })
    root = made.root
    initialSrc = made.initialSrc
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses when no editable repo root or package-manager adapter is wired', async () => {
    const { emitEdit } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: undefined,
      packageManagerAdapter: undefined,
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(
      /not configured with an editable repo root and a package-manager adapter/,
    )
  })

  it('refuses when package.json is missing', async () => {
    // Remove the manifest fixture wrote.
    await rm(join(root, 'package.json'), { force: true })
    const { emitEdit } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter(),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/package\.json not found/)
  })

  it('surfaces a no-op refusal from the adapter without writing or backing up', async () => {
    const { emitEdit, emissions } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter({
        applyResult: { ok: false, reason: 'lodash is already in dependencies at "latest"' },
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/already in dependencies/)
    expect(emissions).toHaveLength(0)
    // package.json untouched, and HEAD did not move.
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(initialSrc)
    const { stdout } = await execFileP('git', ['log', '-1', '--pretty=%s'], { cwd: root })
    expect(stdout.trim()).toBe('seed')
  })

  it('writes the new manifest, journals a backup, emits an overwrite carrier, and invalidates package.json', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidateFiles = vi.fn()
    const r = await managePackageHandler({
      worktreeRoot: root,
      invalidateFiles,
      packageManagerAdapter: makeStubAdapter({
        async installSideEffect() {
          await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8')
        },
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash', versionSpec: '^4.0.0' },
    })
    expect(r.isError).toBeUndefined()

    // package.json mutated on disk.
    const updated = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(updated.dependencies).toEqual({ lodash: '^4.0.0' })

    // Carrier emitted with appliedByAgent=true.
    expect(emissions).toHaveLength(1)
    const carrier = emissions[0]
    expect(carrier.type).toBe('overwrite')
    if (carrier.type !== 'overwrite') throw new Error('unreachable')
    expect(carrier.file).toBe('package.json')
    expect(carrier.appliedByAgent).toBe(true)
    expect(carrier.baseHash).toMatch(/^[0-9a-f]{64}$/)

    // invalidateFiles called for package.json.
    expect(invalidateFiles).toHaveBeenCalledWith(['package.json'])

    // No per-op commit — HEAD does not move; the manifest + lockfile are
    // ordinary uncommitted working-tree changes.
    const { stdout } = await execFileP('git', ['log', '-1', '--pretty=%s'], { cwd: root })
    expect(stdout.trim()).toBe('seed')
    const status = (await execFileP('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()
    expect(status).not.toBe('')

    // Response shape: backupDir replaces manifestCommitted/lockfileCommitted.
    const out = asJson(r)
    expect(out.backupDir).toMatch(/^\.desde\/backups\//)
    expect(out.manifestCommitted).toBeUndefined()
    expect(out.lockfileCommitted).toBeUndefined()
    expect((out.install as { ok: boolean }).ok).toBe(true)
    expect(out.summary).toBe('Added lodash@^4.0.0')

    // The backup journal holds the ORIGINAL (pre-edit) package.json.
    const backedUp = await readFile(join(root, out.backupDir as string, 'package.json'), 'utf8')
    expect(backedUp).toBe(initialSrc)
  })

  it('does NOT record a history step (toolbar undo/redo Task 4 — npm side effects are not restorable)', async () => {
    const { emitEdit } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter({
        async installSideEffect() {
          await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8')
        },
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash', versionSpec: '^4.0.0' },
    })
    expect(r.isError).toBeUndefined()
    expect(getSharedEditHistory().state().canUndo).toBe(false)
  })

  it('reports install failure but keeps the manifest change on disk with a backup', async () => {
    const { emitEdit, emissions } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter({
        installResult: {
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: 'npm ERR! E404 not found',
          durationMs: 100,
          command: 'npm install',
        },
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBe(true)
    // Manifest still mutated on disk — the user can roll it back via the
    // backup journal if they don't want the partial state.
    const updated = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(updated.dependencies.lodash).toBe('latest')
    expect(emissions).toHaveLength(1)
    const out = asJson(r)
    expect((out.install as { ok: boolean; stderr?: string }).ok).toBe(false)
    expect((out.install as { stderr?: string }).stderr).toContain('E404')
    expect(out.backupDir).toMatch(/^\.desde\/backups\//)
    expect(out.lockfileCommitted).toBeUndefined()
    expect(out.summary).toMatch(
      /If they want to roll back, restore package\.json from the backup journal\./,
    )
  })

  it('journals a pre-existing lockfile before install mutates it', async () => {
    const originalLock = '{"lockfileVersion": 3, "packages": {}}\n'
    await writeFile(join(root, 'package-lock.json'), originalLock, 'utf8')
    const { emitEdit } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter({
        async installSideEffect() {
          await writeFile(
            join(root, 'package-lock.json'),
            '{"lockfileVersion": 3, "packages": {"node_modules/lodash": {}}}\n',
            'utf8',
          )
        },
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBeUndefined()
    const out = asJson(r)
    // Install rewrote the lockfile on disk, but the journal preserved
    // the ORIGINAL alongside package.json — the only rollback path in
    // branch mode (no per-op commit).
    const backedUpLock = await readFile(
      join(root, out.backupDir as string, 'package-lock.json'),
      'utf8',
    )
    expect(backedUpLock).toBe(originalLock)
    const onDisk = await readFile(join(root, 'package-lock.json'), 'utf8')
    expect(onDisk).toContain('node_modules/lodash')
  })

  it('does not create a lockfile entry in the response when install produces none', async () => {
    const { emitEdit } = captureEmit()
    const r = await managePackageHandler({
      worktreeRoot: root,
      packageManagerAdapter: makeStubAdapter({
        // Install "succeeds" but doesn't create a lockfile.
      }),
      emitEdit,
      input: { operation: 'add', packageName: 'lodash' },
    })
    expect(r.isError).toBeUndefined()
    expect(existsSync(join(root, 'package-lock.json'))).toBe(false)
    const out = asJson(r)
    expect(out.manifestCommitted).toBeUndefined()
    expect(out.lockfileCommitted).toBeUndefined()
    expect(out.backupDir).toMatch(/^\.desde\/backups\//)
  })

  describe('tree gate spans the install step (P1-1, round 3)', () => {
    async function readEntries() {
      const { readLedger } = await import('../ledger/edit-ledger')
      return readLedger(root)
    }

    it('does not release the gate until AFTER install() has finished', async () => {
      let released = false
      let releasedBeforeInstallRan = false
      const acquireTreeGate = vi.fn(async () => {
        return () => {
          released = true
        }
      })
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        acquireTreeGate,
        packageManagerAdapter: makeStubAdapter({
          async installSideEffect() {
            // The moment npm/pnpm/yarn is actually mutating the
            // lockfile — this is exactly the window the pre-fix code
            // left the gate released for.
            releasedBeforeInstallRan = released
            await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8')
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()
      expect(acquireTreeGate).toHaveBeenCalledTimes(1)
      expect(releasedBeforeInstallRan).toBe(false)
      // Released by the time the handler returns.
      expect(released).toBe(true)
    })

    it('releases the gate even when install() fails', async () => {
      let released = false
      const acquireTreeGate = vi.fn(async () => () => {
        released = true
      })
      const { emitEdit } = captureEmit()
      await managePackageHandler({
        worktreeRoot: root,
        acquireTreeGate,
        packageManagerAdapter: makeStubAdapter({
          installResult: {
            ok: false,
            exitCode: 1,
            stdout: '',
            stderr: 'npm ERR! E404 not found',
            durationMs: 5,
            command: 'npm install',
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(released).toBe(true)
    })

    it('does not acquire a gate when the caller supplies none (no behavior change)', async () => {
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        packageManagerAdapter: makeStubAdapter({
          async installSideEffect() {
            await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8')
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()
    })

    it('records a follow-up ledger entry for the lockfile install() actually changed', async () => {
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        packageManagerAdapter: makeStubAdapter({
          async installSideEffect() {
            await writeFile(
              join(root, 'package-lock.json'),
              '{"lockfileVersion": 3, "packages": {"node_modules/lodash": {}}}\n',
              'utf8',
            )
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()

      const entries = await readEntries()
      const editEntries = entries.filter((e) => e.type === 'edit')
      // One entry from brokeredWrite (package.json), one follow-up for
      // the lockfile install() rewrote.
      expect(editEntries).toHaveLength(2)
      const lockEntry = editEntries.find((e) => e.files.includes('package-lock.json'))
      expect(lockEntry).toBeTruthy()
      if (!lockEntry) throw new Error('unreachable')
      expect(lockEntry.kind).toBe('manage_package')
      expect(lockEntry.lane).toBe('chat')
      expect(lockEntry.files).toEqual(['package-lock.json'])
      expect(lockEntry.afterHashes['package-lock.json']).toMatch(/^[0-9a-f]{64}$/)
      const onDisk = await readFile(join(root, 'package-lock.json'), 'utf8')
      const { hashContent } = await import('../ledger/edit-ledger')
      expect(lockEntry.afterHashes['package-lock.json']).toBe(hashContent(onDisk))
      // P2-1 (codex review round 6, 2026-08-20): no `package-lock.json`
      // was written before this handler ran (this test never seeds one,
      // unlike "journals a pre-existing lockfile…" below) — install()
      // created it from nothing. `baselineLockHashes` never got an entry
      // for it (see that map's own comment: "A lockfile absent from this
      // map did not exist before install ran"), so this is exactly the
      // fact `createdFiles` exists to state, and Plan B's Undo can prove
      // "delete it" is safe instead of refusing as `unbacked`.
      expect(lockEntry.createdFiles).toEqual(['package-lock.json'])
    })

    it('does NOT mark createdFiles when install() rewrites a lockfile that already existed', async () => {
      const originalLock = '{"lockfileVersion": 3, "packages": {}}\n'
      await writeFile(join(root, 'package-lock.json'), originalLock, 'utf8')
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        packageManagerAdapter: makeStubAdapter({
          async installSideEffect() {
            await writeFile(
              join(root, 'package-lock.json'),
              '{"lockfileVersion": 3, "packages": {"node_modules/lodash": {}}}\n',
              'utf8',
            )
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()

      const entries = await readEntries()
      const editEntries = entries.filter((e) => e.type === 'edit')
      const lockEntry = editEntries.find((e) => e.files.includes('package-lock.json'))
      expect(lockEntry).toBeTruthy()
      if (!lockEntry) throw new Error('unreachable')
      // The lockfile pre-existed — this is an ordinary overwrite, not a
      // creation. `createdFiles` must stay absent so the planner keeps
      // refusing Undo for it (correctly — there is no backup for this
      // follow-up entry either; see the module's own comment on why that
      // gap is separate and still open).
      expect(lockEntry.createdFiles).toBeUndefined()
    })

    it('does not record a follow-up entry when install() leaves the lockfile untouched', async () => {
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        packageManagerAdapter: makeStubAdapter({
          // No installSideEffect — install "succeeds" but touches nothing.
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()
      const entries = await readEntries()
      const editEntries = entries.filter((e) => e.type === 'edit')
      expect(editEntries).toHaveLength(1)
      expect(editEntries[0].files).toEqual(['package.json'])
    })

    it('does not record a follow-up entry when install() rewrites the lockfile back to its original content', async () => {
      const originalLock = '{"lockfileVersion": 3, "packages": {}}\n'
      await writeFile(join(root, 'package-lock.json'), originalLock, 'utf8')
      const { emitEdit } = captureEmit()
      const r = await managePackageHandler({
        worktreeRoot: root,
        packageManagerAdapter: makeStubAdapter({
          async installSideEffect() {
            // Simulate a no-op install that rewrites the exact same bytes.
            await writeFile(join(root, 'package-lock.json'), originalLock, 'utf8')
          },
        }),
        emitEdit,
        input: { operation: 'add', packageName: 'lodash' },
      })
      expect(r.isError).toBeUndefined()
      const entries = await readEntries()
      const editEntries = entries.filter((e) => e.type === 'edit')
      expect(editEntries).toHaveLength(1)
      expect(editEntries[0].files).toEqual(['package.json'])
    })
  })
})
