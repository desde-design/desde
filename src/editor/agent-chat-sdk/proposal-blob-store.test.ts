import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  deleteProposalBlobsForSession,
  proposalBlobPath,
  readProposalBlob,
  writeProposalBlob,
} from './proposal-blob-store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proposal-blob-store-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('proposalBlobPath', () => {
  it('produces the documented layout', () => {
    expect(proposalBlobPath(root, 'sess-1', 'edit-1')).toBe(
      join(root, '.desde', 'chat-sessions', 'sess-1', 'proposals', 'edit-1.txt'),
    )
  })

  it('rejects invalid sessionId (path-traversal guard)', () => {
    expect(() => proposalBlobPath(root, '../escape', 'edit-1')).toThrow(
      /sessionId must match/i,
    )
    expect(() => proposalBlobPath(root, '', 'edit-1')).toThrow(
      /sessionId must match/i,
    )
  })

  it('rejects invalid editId (path-traversal guard)', () => {
    expect(() => proposalBlobPath(root, 'sess-1', '../escape')).toThrow(
      /editId must match/i,
    )
    expect(() => proposalBlobPath(root, 'sess-1', '')).toThrow(/editId must match/i)
  })
})

describe('writeProposalBlob', () => {
  it('writes the blob + creates the session/proposals dirs lazily', async () => {
    await writeProposalBlob(root, 'sess-1', 'edit-1', '<template>hello</template>')
    const raw = readFileSync(
      proposalBlobPath(root, 'sess-1', 'edit-1'),
      'utf8',
    )
    expect(raw).toBe('<template>hello</template>')
  })

  it('isolates blobs across sessions', async () => {
    await Promise.all([
      writeProposalBlob(root, 'sess-1', 'edit-1', 'session-1 content'),
      writeProposalBlob(root, 'sess-2', 'edit-1', 'session-2 content'),
    ])
    expect(await readProposalBlob(root, 'sess-1', 'edit-1')).toBe('session-1 content')
    expect(await readProposalBlob(root, 'sess-2', 'edit-1')).toBe('session-2 content')
  })

  it('overwrites a prior blob for the same editId (defensive — uuid collisions are theoretically possible)', async () => {
    await writeProposalBlob(root, 'sess-1', 'edit-1', 'first')
    await writeProposalBlob(root, 'sess-1', 'edit-1', 'second')
    expect(await readProposalBlob(root, 'sess-1', 'edit-1')).toBe('second')
  })

  it('handles UTF-8 multi-byte content', async () => {
    const content = 'コンポーネント — 🚀 — 100% Unicode'
    await writeProposalBlob(root, 'sess-1', 'edit-utf8', content)
    expect(await readProposalBlob(root, 'sess-1', 'edit-utf8')).toBe(content)
  })

  it('handles large blobs (50 KB)', async () => {
    const big = 'x'.repeat(50_000)
    await writeProposalBlob(root, 'sess-1', 'edit-big', big)
    expect((await readProposalBlob(root, 'sess-1', 'edit-big'))?.length).toBe(50_000)
  })
})

describe('readProposalBlob', () => {
  it('returns null when the blob does not exist', async () => {
    expect(await readProposalBlob(root, 'sess-1', 'no-such')).toBeNull()
  })

  it('returns the persisted content for a written blob', async () => {
    await writeProposalBlob(root, 'sess-1', 'edit-1', 'persisted')
    expect(await readProposalBlob(root, 'sess-1', 'edit-1')).toBe('persisted')
  })

  it('rejects invalid editId at read time (defense in depth)', async () => {
    await expect(readProposalBlob(root, 'sess-1', '../escape')).rejects.toThrow(
      /editId must match/i,
    )
  })

  it('CX7 fix round 1: throws DesdeDirSymlinkError, not null, when .desde is a symlink out of the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'proposal-blob-store-outside-'))
    symlinkSync(outside, join(root, '.desde'))

    await expect(readProposalBlob(root, 'sess-1', 'edit-1')).rejects.toThrow(
      /is a symbolic link/i,
    )

    rmSync(outside, { recursive: true, force: true })
  })
})

describe('deleteProposalBlobsForSession', () => {
  it('removes every blob for the session', async () => {
    await writeProposalBlob(root, 'sess-1', 'e1', 'a')
    await writeProposalBlob(root, 'sess-1', 'e2', 'b')
    await writeProposalBlob(root, 'sess-1', 'e3', 'c')
    await deleteProposalBlobsForSession(root, 'sess-1')
    expect(await readProposalBlob(root, 'sess-1', 'e1')).toBeNull()
    expect(await readProposalBlob(root, 'sess-1', 'e2')).toBeNull()
    expect(await readProposalBlob(root, 'sess-1', 'e3')).toBeNull()
  })

  it('does not touch other sessions', async () => {
    await writeProposalBlob(root, 'sess-1', 'e1', 'A')
    await writeProposalBlob(root, 'sess-2', 'e1', 'B')
    await deleteProposalBlobsForSession(root, 'sess-1')
    expect(await readProposalBlob(root, 'sess-1', 'e1')).toBeNull()
    expect(await readProposalBlob(root, 'sess-2', 'e1')).toBe('B')
  })

  it('is idempotent on missing dir', async () => {
    await expect(
      deleteProposalBlobsForSession(root, 'no-such'),
    ).resolves.toBeUndefined()
  })

  it('rejects invalid sessionId', async () => {
    // Path-traversal guard runs synchronously inside the path build.
    await expect(
      deleteProposalBlobsForSession(root, '../escape'),
    ).rejects.toThrow(/sessionId must match/i)
  })

  it('CX7 item 6: refuses to delete, and removes nothing, when .desde is a symlink out of the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'proposal-blob-store-outside-'))
    mkdirSync(join(outside, 'chat-sessions', 'sess-1', 'proposals'), { recursive: true })
    writeFileSync(join(outside, 'chat-sessions', 'sess-1', 'proposals', 'e1.txt'), 'content')
    symlinkSync(outside, join(root, '.desde'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(deleteProposalBlobsForSession(root, 'sess-1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()

    expect(existsSync(join(outside, 'chat-sessions', 'sess-1', 'proposals', 'e1.txt'))).toBe(true)
    rmSync(outside, { recursive: true, force: true })
  })
})
