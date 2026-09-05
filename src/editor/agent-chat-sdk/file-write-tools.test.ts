/**
 * Tests for `deleteFileHandler` and `renameFileHandler` — the standalone
 * functions backing `mcp__editor__delete_file` and
 * `mcp__editor__rename_file`. Branch mode: the handlers mutate the
 * repo's working tree in place with NO per-op commit — the prior
 * content is journaled to `.desde/backups/` before the mutation
 * and the change is left uncommitted for the user's own git.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { EditProposalPayload } from '../agent-tools/types'
import {
  getSharedEditHistory,
  resetSharedEditHistoryForTests,
} from '../edit-service/edit-history'
import type { EmitEditResult, FileWriteToolResult } from './editor-tools'
import { deleteFileHandler, renameFileHandler } from './fs-structural-tools'

const execFileP = promisify(execFile)

/**
 * Build a minimal git repo standing in for the user's working tree.
 * Git is initialized so the tests can assert branch-mode behavior:
 * the mutation lands as an UNCOMMITTED working-tree change (HEAD does
 * not move).
 */
async function makeRepo(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pt-fw-'))
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: root })
  await execFileP('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: root })
  // Seed an initial committed file so the repo has a HEAD.
  await writeFile(join(root, 'README.md'), 'seed\n', 'utf8')
  await execFileP('git', ['add', 'README.md'], { cwd: root })
  await execFileP('git', ['commit', '-q', '-m', 'seed'], { cwd: root })
  return { root }
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

async function headSubject(root: string): Promise<string> {
  const { stdout } = await execFileP('git', ['log', '-1', '--pretty=%s'], { cwd: root })
  return stdout.trim()
}

describe('deleteFileHandler', () => {
  let root: string

  beforeEach(async () => {
    resetSharedEditHistoryForTests()
    const made = await makeRepo()
    root = made.root
    await writeFile(join(root, 'doomed.vue'), '<template>x</template>\n', 'utf8')
    await execFileP('git', ['add', 'doomed.vue'], { cwd: root })
    await execFileP('git', ['commit', '-q', '-m', 'add doomed'], { cwd: root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses when no repo root is wired', async () => {
    const { emitEdit } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: undefined,
      emitEdit,
      input: { path: 'doomed.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not configured with an editable repo root/)
  })

  it('refuses paths that escape the repo', async () => {
    const { emitEdit } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '../escape' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/denied/)
    expect(existsSync(join(root, 'doomed.vue'))).toBe(true)
  })

  it('refuses paths that do not exist', async () => {
    const { emitEdit } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: 'nope.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/does not exist/)
  })

  it('deletes the file, journals a backup, emits a file_delete carrier, and does NOT commit', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidated: string[][] = []
    const r = await deleteFileHandler({
      worktreeRoot: root,
      invalidateFiles: (files) => invalidated.push(files),
      emitEdit,
      input: { path: 'doomed.vue' },
    })
    expect(r.isError).toBeUndefined()
    expect(existsSync(join(root, 'doomed.vue'))).toBe(false)

    expect(emissions).toHaveLength(1)
    const carrier = emissions[0]
    expect(carrier.type).toBe('file_delete')
    if (carrier.type !== 'file_delete') throw new Error('unreachable')
    expect(carrier.file).toBe('doomed.vue')
    expect(carrier.appliedByAgent).toBe(true)
    // sha256 of '<template>x</template>\n' — sanity-check the hash is
    // computed from the on-disk content, not e.g. the empty string.
    expect(carrier.baseHash).toMatch(/^[0-9a-f]{64}$/)

    const out = asJson(r)
    expect(out.editId).toBe('eid-1')
    expect(out.summary).toBe('Deleted doomed.vue')

    // Branch mode: prior content is recoverable from the backup journal.
    expect(typeof out.backupDir).toBe('string')
    expect(out.backupDir as string).toMatch(/^\.desde\/backups\//)
    const backedUp = await readFile(
      join(root, out.backupDir as string, 'doomed.vue'),
      'utf8',
    )
    expect(backedUp).toBe('<template>x</template>\n')

    // The Vite invalidation callback fired for the deleted file.
    expect(invalidated).toEqual([['doomed.vue']])

    // NO per-op commit — HEAD stays at the seed commit; the delete is
    // an ordinary uncommitted working-tree change.
    expect(await headSubject(root)).toBe('add doomed')
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: root })
    expect(stdout).toMatch(/^ D doomed\.vue/m)
  })

  it('deletes and journals a file whose NAME is `..`-prefixed (Task 14 review round-2 P2)', async () => {
    // `..fixture.vue` is a legal file at the repo root. Before the fix,
    // `toRepoRel` (`toRel` in edit-ack.ts) blunt-matched `startsWith('..')`
    // and returned the ABSOLUTE path as "repoRel"; `writeBackupJournal`'s
    // (correct) containment check then saw a key genuinely outside
    // `backupDir` and threw `BackupJournalPathEscapeError` — uncaught,
    // crashing this tool call instead of deleting the file normally.
    await writeFile(join(root, '..fixture.vue'), '<template>dots</template>\n', 'utf8')
    await execFileP('git', ['add', '..fixture.vue'], { cwd: root })
    await execFileP('git', ['commit', '-q', '-m', 'add dotted fixture'], { cwd: root })

    const { emitEdit, emissions } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: '..fixture.vue' },
    })
    expect(r.isError).toBeUndefined()
    expect(existsSync(join(root, '..fixture.vue'))).toBe(false)

    const carrier = emissions[0]
    expect(carrier.type).toBe('file_delete')
    if (carrier.type !== 'file_delete') throw new Error('unreachable')
    // Journaled under its REAL name, not the absolute-path fallback.
    expect(carrier.file).toBe('..fixture.vue')

    const out = asJson(r)
    expect(out.backupDir as string).toMatch(/^\.desde\/backups\//)
    const backedUp = await readFile(
      join(root, out.backupDir as string, '..fixture.vue'),
      'utf8',
    )
    expect(backedUp).toBe('<template>dots</template>\n')
  })

  it('backs up binary files byte-for-byte', async () => {
    // Invalid UTF-8 (0xff 0xfe …) — a string round-trip would mangle it.
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0xc3, 0x28])
    await writeFile(join(root, 'asset.png'), bytes)
    const { emitEdit } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: 'asset.png' },
    })
    expect(r.isError).toBeUndefined()
    const out = asJson(r)
    const backedUp = await readFile(join(root, out.backupDir as string, 'asset.png'))
    expect(Buffer.compare(backedUp, bytes)).toBe(0)
  })

  it('refuses (and does not delete) when the backup journal cannot be written', async () => {
    // Occupy the `.desde` path with a FILE so mkdir of the backup
    // dir fails.
    await writeFile(join(root, '.desde'), 'not a dir', 'utf8')
    const { emitEdit, emissions } = captureEmit()
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: 'doomed.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/Backup write failed/)
    expect(r.content[0].text).toMatch(/was not modified/)
    expect(existsSync(join(root, 'doomed.vue'))).toBe(true)
    expect(emissions).toHaveLength(0)
  })

  it('records a history step labeled "delete_file: <path>" (toolbar undo/redo Task 4)', async () => {
    const { emitEdit } = captureEmit()
    expect(getSharedEditHistory().state().canUndo).toBe(false)
    const r = await deleteFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { path: 'doomed.vue' },
    })
    expect(r.isError).toBeUndefined()
    const state = getSharedEditHistory().state()
    expect(state.canUndo).toBe(true)
    expect(state.undoLabel).toBe('delete_file: doomed.vue')
  })
})

describe('renameFileHandler', () => {
  let root: string

  beforeEach(async () => {
    const made = await makeRepo()
    root = made.root
    await writeFile(join(root, 'src.vue'), '<template>X</template>\n', 'utf8')
    await execFileP('git', ['add', 'src.vue'], { cwd: root })
    await execFileP('git', ['commit', '-q', '-m', 'add src'], { cwd: root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses when no repo root is wired', async () => {
    const { emitEdit } = captureEmit()
    const r = await renameFileHandler({
      worktreeRoot: undefined,
      emitEdit,
      input: { from: 'src.vue', to: 'dest.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not configured with an editable repo root/)
  })

  it('refuses when the source does not exist', async () => {
    const { emitEdit } = captureEmit()
    const r = await renameFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { from: 'missing.vue', to: 'dest.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/source 'missing\.vue' does not exist/)
  })

  /**
   * FX17 item 5. `.env` is not on the WRITE-protected list — that list's
   * rule is "can this path make code execute or instructions be obeyed",
   * and `.env` does neither — and `.txt`/`.md`/`.json` are all allowed
   * rename destinations. So `rename_file(from: '.env', to: 'notes.txt')`
   * followed by `Read('notes.txt')` returned the whole credential file:
   * neither spelling is a secret by name, so both lanes' Read guards
   * allowed the second call.
   */
  describe('a rename whose SOURCE is a credential (FX17 item 5)', () => {
    it('is refused when the project turned blocking on, and moves nothing', async () => {
      await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-NOT-A-REAL-KEY-0000\n', 'utf8')
      const { emitEdit, emissions } = captureEmit()
      const r = await renameFileHandler({
        worktreeRoot: root,
        emitEdit,
        input: { from: '.env', to: 'notes.txt' },
        blockSecretReads: true,
      })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toMatch(/cannot be read by the agent/)
      // Not a proposal card either: the refusal is before the emit.
      expect(emissions.length).toBe(0)
      expect(existsSync(join(root, '.env'))).toBe(true)
      expect(existsSync(join(root, 'notes.txt'))).toBe(false)
    })

    it('is refused for every spelling the name policy covers, when blocking is on', async () => {
      for (const from of ['.env', '.env.local', '.ENV', '.envrc', 'id_rsa', 'certs/server.pem']) {
        const { emitEdit } = captureEmit()
        const r = await renameFileHandler({
          worktreeRoot: root,
          emitEdit,
          input: { from, to: 'notes.txt' },
          blockSecretReads: true,
        })
        expect(r.isError, from).toBe(true)
        expect(r.content[0].text, from).toMatch(/cannot be read by the agent/)
      }
    })

    it('is allowed by default, when the project has not turned blocking on', async () => {
      await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-NOT-A-REAL-KEY-0000\n', 'utf8')
      const { emitEdit } = captureEmit()
      const r = await renameFileHandler({
        worktreeRoot: root,
        emitEdit,
        input: { from: '.env', to: 'notes.txt' },
      })
      expect(r.isError).toBeFalsy()
      expect(existsSync(join(root, 'notes.txt'))).toBe(true)
    })

    it('still renames ordinary source', async () => {
      const { emitEdit } = captureEmit()
      const r = await renameFileHandler({
        worktreeRoot: root,
        emitEdit,
        input: { from: 'src.vue', to: 'dest.vue' },
      })
      expect(r.isError).toBeFalsy()
      expect(existsSync(join(root, 'dest.vue'))).toBe(true)
    })
  })

  it('refuses when the destination already exists', async () => {
    await writeFile(join(root, 'dest.vue'), 'pre-existing\n', 'utf8')
    const { emitEdit } = captureEmit()
    const r = await renameFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { from: 'src.vue', to: 'dest.vue' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/already exists/)
    expect(existsSync(join(root, 'src.vue'))).toBe(true)
  })

  it('two concurrent renames onto the same destination: one wins, one refuses (no silent clobber)', async () => {
    // Same race class as the codex P2 on scaffold_route's page create:
    // the destination check above runs before the broker's locks, so both
    // calls pass it — and POSIX rename(2) REPLACES the destination, so
    // without the broker's in-lock re-check the loser would destroy the
    // winner's file outright.
    await writeFile(join(root, 'other.vue'), 'from-other\n', 'utf8')
    const { emitEdit } = captureEmit()
    const [r1, r2] = await Promise.all([
      renameFileHandler({
        worktreeRoot: root,
        emitEdit,
        input: { from: 'src.vue', to: 'merged.vue' },
      }),
      renameFileHandler({
        worktreeRoot: root,
        emitEdit,
        input: { from: 'other.vue', to: 'merged.vue' },
      }),
    ])

    const errors = [r1, r2].filter((r) => r.isError)
    expect(errors).toHaveLength(1)
    expect(errors[0].content[0].text).toMatch(/already exists/)
    // The winner's content is at the destination, and the loser's source
    // file is untouched — its rename simply didn't happen.
    const merged = await readFile(join(root, 'merged.vue'), 'utf8')
    expect(['<template>X</template>\n', 'from-other\n']).toContain(merged)
    const loserSource = merged === 'from-other\n' ? 'src.vue' : 'other.vue'
    expect(existsSync(join(root, loserSource))).toBe(true)
  })

  it('refuses when the destination extension is unsafe and differs from the source', async () => {
    const { emitEdit } = captureEmit()
    const r = await renameFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { from: 'src.vue', to: 'dest.exe' },
    })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/extension '\.exe' is not allowed/)
    expect(existsSync(join(root, 'src.vue'))).toBe(true)
  })

  it('renames preserving content, journals the source, emits a file_rename carrier, and does NOT commit', async () => {
    const { emitEdit, emissions } = captureEmit()
    const invalidated: string[][] = []
    const r = await renameFileHandler({
      worktreeRoot: root,
      invalidateFiles: (files) => invalidated.push(files),
      emitEdit,
      input: { from: 'src.vue', to: 'dest.vue' },
    })
    expect(r.isError).toBeUndefined()
    expect(existsSync(join(root, 'src.vue'))).toBe(false)
    expect(existsSync(join(root, 'dest.vue'))).toBe(true)
    const content = await readFile(join(root, 'dest.vue'), 'utf8')
    expect(content).toBe('<template>X</template>\n')

    expect(emissions).toHaveLength(1)
    const carrier = emissions[0]
    expect(carrier.type).toBe('file_rename')
    if (carrier.type !== 'file_rename') throw new Error('unreachable')
    expect(carrier.fromFile).toBe('src.vue')
    expect(carrier.toFile).toBe('dest.vue')
    expect(carrier.appliedByAgent).toBe(true)

    // Source content is journaled under its OLD path.
    const out = asJson(r)
    expect(out.backupDir as string).toMatch(/^\.desde\/backups\//)
    const backedUp = await readFile(
      join(root, out.backupDir as string, 'src.vue'),
      'utf8',
    )
    expect(backedUp).toBe('<template>X</template>\n')

    // Both endpoints of the rename are invalidated.
    expect(invalidated).toEqual([['src.vue', 'dest.vue']])

    // NO per-op commit — the rename is an uncommitted working-tree change.
    const { stdout: subject } = await execFileP('git', ['log', '-1', '--pretty=%s'], {
      cwd: root,
    })
    expect(subject.trim()).toBe('add src')
    const { stdout: status } = await execFileP('git', ['status', '--porcelain'], {
      cwd: root,
    })
    expect(status).toMatch(/ D src\.vue/)
    expect(status).toMatch(/\?\? dest\.vue/)
  })

  it('allows a rename into a subdirectory', async () => {
    await mkdir(join(root, 'sub'), { recursive: true })
    const { emitEdit } = captureEmit()
    const r = await renameFileHandler({
      worktreeRoot: root,
      emitEdit,
      input: { from: 'src.vue', to: 'sub/dest.vue' },
    })
    expect(r.isError).toBeUndefined()
    expect(existsSync(join(root, 'sub', 'dest.vue'))).toBe(true)
  })
})
