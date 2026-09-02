import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { gcAllProposalBlobs } from './proposal-blob-gc'
import { writeProposalBlob } from './proposal-blob-store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proposal-blob-gc-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('gcAllProposalBlobs', () => {
  it('returns 0 when the chat-sessions dir does not exist', async () => {
    expect(await gcAllProposalBlobs(root)).toBe(0)
  })

  it('clears blobs across every session and returns the count', async () => {
    await writeProposalBlob(root, 'sess-a', 'e1', 'A')
    await writeProposalBlob(root, 'sess-a', 'e2', 'A2')
    await writeProposalBlob(root, 'sess-b', 'e1', 'B')
    expect(await gcAllProposalBlobs(root)).toBe(2)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-a', 'proposals')),
    ).toBe(false)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-b', 'proposals')),
    ).toBe(false)
  })

  it('does not touch non-proposal session state (e.g. the session JSON itself)', async () => {
    const sessionsDir = join(root, '.desde', 'chat-sessions', 'sess-a')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(root, '.desde', 'chat-sessions', 'sess-a.json'), '{}')
    await writeProposalBlob(root, 'sess-a', 'e1', 'A')
    await gcAllProposalBlobs(root)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-a.json')),
    ).toBe(true)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-a')),
    ).toBe(true)
  })

  it('ignores non-directory entries silently', async () => {
    mkdirSync(join(root, '.desde', 'chat-sessions'), { recursive: true })
    writeFileSync(
      join(root, '.desde', 'chat-sessions', 'orphan-file.json'),
      '{}',
    )
    await writeProposalBlob(root, 'sess-a', 'e1', 'content')
    expect(await gcAllProposalBlobs(root)).toBe(1)
  })

  it('continues clearing other sessions when one fails', async () => {
    // Invalid sessionId pattern: deleteProposalBlobsForSession will
    // throw at the validator. Plant a dir with a name that ALSO
    // exists in writeProposalBlob's allowed set so one delete works.
    await writeProposalBlob(root, 'sess-a', 'e1', 'A')
    // Create a dir with a name that wouldn't pass the regex (has a
    // dot). The store rejects it; the GC should log + move on.
    mkdirSync(join(root, '.desde', 'chat-sessions', 'bad.name'), {
      recursive: true,
    })
    const cleared = await gcAllProposalBlobs(root)
    // sess-a cleared. bad.name failed but the loop continued.
    expect(cleared).toBe(1)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-a', 'proposals')),
    ).toBe(false)
  })
})

describe('gcAllProposalBlobs — skips sessions with unresolved conflicts (audit Task 15, codex round 1)', () => {
  it('leaves a session\'s proposals untouched when its persisted conflicts map is non-empty', async () => {
    await writeProposalBlob(root, 'sess-conflicted', 'e1', 'loser content')
    writeFileSync(
      join(root, '.desde', 'chat-sessions', 'sess-conflicted.json'),
      JSON.stringify({
        schemaVersion: 1,
        conflicts: {
          '/abs/path/File.vue': {
            detectedAt: '2026-08-01T00:00:00.000Z',
            hashAtRead: 'aaa',
            hashAtWrite: 'bbb',
          },
        },
      }),
    )
    const cleared = await gcAllProposalBlobs(root)
    expect(cleared).toBe(0)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-conflicted', 'proposals')),
    ).toBe(true)
  })

  it('still sweeps a session with an EMPTY conflicts map', async () => {
    await writeProposalBlob(root, 'sess-clean', 'e1', 'content')
    writeFileSync(
      join(root, '.desde', 'chat-sessions', 'sess-clean.json'),
      JSON.stringify({ schemaVersion: 1, conflicts: {} }),
    )
    expect(await gcAllProposalBlobs(root)).toBe(1)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-clean', 'proposals')),
    ).toBe(false)
  })

  it('sweeps a conflicted session AND a conflict-free session independently in the same pass', async () => {
    await writeProposalBlob(root, 'sess-conflicted', 'e1', 'loser content')
    writeFileSync(
      join(root, '.desde', 'chat-sessions', 'sess-conflicted.json'),
      JSON.stringify({
        schemaVersion: 1,
        conflicts: { '/abs/File.vue': { detectedAt: 'x', hashAtRead: 'a', hashAtWrite: 'b' } },
      }),
    )
    await writeProposalBlob(root, 'sess-clean', 'e1', 'content')

    const cleared = await gcAllProposalBlobs(root)
    expect(cleared).toBe(1)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-conflicted', 'proposals')),
    ).toBe(true)
    expect(
      existsSync(join(root, '.desde', 'chat-sessions', 'sess-clean', 'proposals')),
    ).toBe(false)
  })

  it('treats a malformed session JSON as "no conflicts" (sweeps rather than accumulating forever)', async () => {
    await writeProposalBlob(root, 'sess-a', 'e1', 'content')
    writeFileSync(join(root, '.desde', 'chat-sessions', 'sess-a.json'), '{ not json')
    expect(await gcAllProposalBlobs(root)).toBe(1)
  })
})
