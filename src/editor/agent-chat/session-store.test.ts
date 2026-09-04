/**
 * Tests for the chat-session persistence layer. Covers:
 *   - Missing file → fresh session
 *   - Malformed JSON → fresh session (never throws)
 *   - Schema mismatch → fresh session
 *   - Wrong projectId → fresh session
 *   - Round-trip: save then load returns the same content
 *   - Save creates the directory if missing
 *   - Atomic write: a partial tempfile from a prior crash doesn't break a read
 *   - Distinct project ids per repo root (worktree isolation)
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findRecentWriterForFile,
  listSessionsForProject,
  loadSession,
  projectIdForRepoRoot,
  saveSession,
  sessionFilePath,
  withSessionStatus,
} from './session-store'
import { makeEmptySession, type ChatSession } from './types'

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'desde-session-'))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('projectIdForRepoRoot', () => {
  it('produces a 16-char hex id that is stable for the same input', () => {
    const a = projectIdForRepoRoot('/a/b/c')
    const b = projectIdForRepoRoot('/a/b/c')
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
  })

  it('produces distinct ids for distinct paths (worktree isolation)', () => {
    const a = projectIdForRepoRoot('/repos/myapp')
    const b = projectIdForRepoRoot('/repos/myapp-feature-branch')
    expect(a).not.toBe(b)
  })
})

describe('loadSession', () => {
  it('returns a fresh session when no file exists', async () => {
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(true)
    expect(result.freshReason).toBe('no-file')
    expect(result.session.turns).toEqual([])
    expect(result.session.schemaVersion).toBe(1)
  })

  it('returns a fresh session when the file is malformed JSON', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const path = sessionFilePath(repoRoot, projectId)
    await writeFile(path, '{not json', 'utf8').catch(async () => {
      // dir doesn't exist yet — create it via save() then overwrite
      await saveSession(repoRoot, makeEmptySession(projectId))
      await writeFile(path, '{not json', 'utf8')
    })
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(true)
    expect(result.freshReason).toBe('malformed-json')
    expect(result.session.turns).toEqual([])
  })

  it('returns a fresh session when schemaVersion is wrong', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Seed an empty save to create the directory, then overwrite with
    // an invalid schema version.
    await saveSession(repoRoot, makeEmptySession(projectId))
    const path = sessionFilePath(repoRoot, projectId)
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 999,
        id: { projectId },
        createdAt: 'x',
        updatedAt: 'y',
        turns: [],
      }),
      'utf8',
    )
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(true)
    expect(result.freshReason).toBe('schema-mismatch')
  })

  it('returns a fresh session when projectId in file does not match repo root', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    await saveSession(repoRoot, makeEmptySession(projectId))
    const path = sessionFilePath(repoRoot, projectId)
    // Tamper with the file: change projectId to something unrelated.
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as ChatSession
    parsed.id.projectId = 'deadbeefdeadbeef'
    await writeFile(path, JSON.stringify(parsed), 'utf8')
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(true)
    expect(result.freshReason).toBe('schema-mismatch')
  })

  it('loads a previously-saved session intact (round-trip)', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const original = makeEmptySession(projectId)
    original.turns.push({
      id: 'turn-1',
      startedAt: '2026-05-13T00:00:00.000Z',
      completedAt: '2026-05-13T00:00:05.000Z',
      userMessage: 'change the button to primary',
      assistantContent: [{ type: 'text', text: 'Updated the button variant.' }],
      toolResults: {},
      editProposals: [
        {
          editId: 'edit-1',
          kind: 'prop_edit',
          files: ['src/Demo.vue'],
          proposedAt: '2026-05-13T00:00:03.000Z',
        },
      ],
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await saveSession(repoRoot, original)

    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(false)
    expect(result.freshReason).toBeUndefined()
    expect(result.session.turns).toHaveLength(1)
    expect(result.session.turns[0].id).toBe('turn-1')
    expect(result.session.turns[0].editProposals[0].editId).toBe('edit-1')
  })
})

/**
 * Steered messages — text the user typed WHILE a turn was running — are part
 * of the turn record (`ChatTurn.steers`). The rule they encode: the user typed
 * it, so it must survive a re-hydrate. A transcript that keeps the assistant's
 * answer and loses the question is the same loss as dropping the message on
 * the wire, one layer down.
 */
describe('chat input steering — ChatTurn.steers persistence', () => {
  /** A turn in the shape it had BEFORE `steers` existed. */
  function unsteeredTurn(): ChatSession['turns'][number] {
    return {
      id: 'turn-1',
      startedAt: '2026-08-14T00:00:00.000Z',
      completedAt: '2026-08-14T00:00:09.000Z',
      userMessage: 'fix the footer',
      assistantContent: [{ type: 'text', text: 'on it' }],
      toolResults: {},
      editProposals: [],
    }
  }

  it('round-trips two steers in order, with their positions', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns.push({
      ...unsteeredTurn(),
      assistantContent: [
        { type: 'text', text: 'looking' },
        { type: 'text', text: 'on it' },
      ],
      steers: [
        { text: 'also fix the header', afterAssistantBlocks: 1 },
        { text: 'and this screenshot', hadImages: true, afterAssistantBlocks: 2 },
      ],
    })
    await saveSession(repoRoot, session)

    const { session: loaded } = await loadSession(repoRoot)
    expect(loaded.turns[0].steers).toEqual([
      { text: 'also fix the header', afterAssistantBlocks: 1 },
      { text: 'and this screenshot', hadImages: true, afterAssistantBlocks: 2 },
    ])
  })

  it('never persists steered image bytes, only that images rode along', async () => {
    // Same rule as the turn's opening images: base64 in the session JSON would
    // bloat every file, and the SDK's own JSONL transcript retains the bytes.
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns.push({
      ...unsteeredTurn(),
      steers: [{ text: 'match this', hadImages: true, afterAssistantBlocks: 0 }],
    })
    await saveSession(repoRoot, session)

    const raw = await readFile(sessionFilePath(repoRoot, projectId), 'utf8')
    expect(raw).toContain('"hadImages": true')
    expect(raw).not.toContain('base64')
    expect(raw).not.toContain('"data"')
  })

  it('writes a turn with no steers exactly as it was written before the field existed', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns.push(unsteeredTurn())
    await saveSession(repoRoot, session)

    const raw = await readFile(sessionFilePath(repoRoot, projectId), 'utf8')
    // No empty array, no null, no key at all — an unsteered turn and a turn
    // from before steering existed must be indistinguishable on disk.
    expect(raw).not.toContain('steers')
    expect((JSON.parse(raw) as ChatSession).turns[0]).toEqual(unsteeredTurn())
  })

  it('loads a pre-existing session file that has no steers field', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Hand-written in the on-disk shape a session file had before this change,
    // not produced by the current writer — that is the whole point of the test.
    await saveSession(repoRoot, makeEmptySession(projectId))
    await writeFile(
      sessionFilePath(repoRoot, projectId),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId, sessionId: projectId },
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:10.000Z',
        turns: [unsteeredTurn()],
      }),
      'utf8',
    )

    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(false)
    expect(result.session.turns).toHaveLength(1)
    expect(result.session.turns[0].steers).toBeUndefined()
    expect(result.session.turns[0].userMessage).toBe('fix the footer')
  })
})

describe('saveSession', () => {
  it('creates the sessions directory if missing', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    await saveSession(repoRoot, makeEmptySession(projectId))
    const path = sessionFilePath(repoRoot, projectId)
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('"schemaVersion": 1')
  })

  it('updates `updatedAt` on every write', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.updatedAt = '2020-01-01T00:00:00.000Z' // stale
    await saveSession(repoRoot, session)
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(false)
    // saveSession bumps updatedAt to "now"; loaded value must differ
    // from the stale value we passed in.
    expect(result.session.updatedAt).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('concurrent saves do not collide on a shared tempfile name', async () => {
    // Two saves in flight at the same millisecond would previously
    // collide on a `pid+ms` suffix. With randomUUID, both produce
    // distinct tempfiles and at least one final rename succeeds without
    // an ENOENT error. We don't assert which wins; "last write wins" is
    // documented behavior.
    const projectId = projectIdForRepoRoot(repoRoot)
    const a = makeEmptySession(projectId)
    a.turns.push({
      id: 'turn-a',
      startedAt: '2026-05-13T00:00:01.000Z',
      userMessage: 'a',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    const b = makeEmptySession(projectId)
    b.turns.push({
      id: 'turn-b',
      startedAt: '2026-05-13T00:00:01.000Z',
      userMessage: 'b',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })

    const results = await Promise.allSettled([
      saveSession(repoRoot, a),
      saveSession(repoRoot, b),
      saveSession(repoRoot, a),
      saveSession(repoRoot, b),
    ])
    for (const r of results) {
      expect(r.status).toBe('fulfilled')
    }

    const loaded = await loadSession(repoRoot)
    expect(loaded.fresh).toBe(false)
    // The file must be a fully-formed, parseable session — not a
    // half-merged byte stream from two concurrent writes.
    expect(loaded.session.turns).toHaveLength(1)
    expect(['turn-a', 'turn-b']).toContain(loaded.session.turns[0].id)
  })

  it("an unrelated stray .tmp file in the dir doesn't break a load", async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    await saveSession(repoRoot, makeEmptySession(projectId))
    const dir = join(repoRoot, '.desde/chat-sessions')
    // Simulate a partial tempfile left over from a crashed prior write.
    await writeFile(join(dir, `${projectId}.json.tmp-1234-5678`), 'garbage', 'utf8')
    // Load should ignore the tempfile entirely (it reads the canonical
    // path, not whatever is in the dir).
    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(false)
    expect(result.session.turns).toEqual([])
  })
})

describe('saveSession — turns retention (audit Task 15)', () => {
  function turn(id: string, costUsd?: number): ChatSession['turns'][number] {
    return {
      id,
      startedAt: '2026-08-01T00:00:00.000Z',
      userMessage: `msg ${id}`,
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      ...(costUsd !== undefined ? { costUsd } : {}),
    }
  }

  it('keeps every turn in the head file when under the cap', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [turn('1'), turn('2')]
    await saveSession(repoRoot, session, { maxTurns: 500 })
    const loaded = await loadSession(repoRoot)
    expect(loaded.session.turns.map((t) => t.id)).toEqual(['1', '2'])
    expect(loaded.session.archivedTurnCount).toBeUndefined()
  })

  it('archives the oldest overflow turns and bounds the head file at maxTurns', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [turn('1', 0.1), turn('2', 0.2), turn('3', 0.3), turn('4', 0.4)]
    await saveSession(repoRoot, session, { maxTurns: 2 })

    const loaded = await loadSession(repoRoot)
    expect(loaded.session.turns.map((t) => t.id)).toEqual(['3', '4'])
    expect(loaded.session.archivedTurnCount).toBe(2)
    expect(loaded.session.archivedCostUsd).toBeCloseTo(0.3) // turns 1 + 2

    const { readArchivedTurns } = await import('./session-turns-archive')
    const archived = await readArchivedTurns(repoRoot, session.id.sessionId)
    expect(archived.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('accumulates archivedTurnCount / archivedCostUsd across multiple overflowing saves', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    let session = makeEmptySession(projectId)
    session.turns = [turn('1', 1), turn('2', 1)]
    await saveSession(repoRoot, session, { maxTurns: 1 })
    session = (await loadSession(repoRoot)).session
    expect(session.turns.map((t) => t.id)).toEqual(['2'])
    expect(session.archivedTurnCount).toBe(1)

    session.turns.push(turn('3', 1))
    await saveSession(repoRoot, session, { maxTurns: 1 })
    const final = (await loadSession(repoRoot)).session
    expect(final.turns.map((t) => t.id)).toEqual(['3'])
    expect(final.archivedTurnCount).toBe(2)
    expect(final.archivedCostUsd).toBeCloseTo(2)

    const { readArchivedTurns } = await import('./session-turns-archive')
    const archived = await readArchivedTurns(repoRoot, session.id.sessionId)
    expect(archived.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('defaults maxTurns to 500 when the option is omitted', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = Array.from({ length: 3 }, (_, i) => turn(String(i)))
    await saveSession(repoRoot, session)
    const loaded = await loadSession(repoRoot)
    expect(loaded.session.turns).toHaveLength(3)
    expect(loaded.session.archivedTurnCount).toBeUndefined()
  })

  it('never loses turns when the archive append fails — keeps the full array in the head file', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [turn('1'), turn('2'), turn('3')]

    // Force the archive sidecar path to be unwritable: pre-create it as a
    // directory so appendFile (which expects a regular file) fails.
    const archiveDir = join(
      repoRoot,
      '.desde/chat-sessions',
      `${session.id.sessionId}.archive.jsonl`,
    )
    const { mkdir } = await import('node:fs/promises')
    await mkdir(archiveDir, { recursive: true })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await saveSession(repoRoot, session, { maxTurns: 1 })
    warn.mockRestore()

    const loaded = await loadSession(repoRoot)
    // Trim was skipped for this save — every turn survives in the head.
    expect(loaded.session.turns.map((t) => t.id)).toEqual(['1', '2', '3'])
    expect(loaded.session.archivedTurnCount).toBeUndefined()
  })

  it('loading a session whose head was trimmed hydrates without the archived turns (head-only)', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [turn('1'), turn('2'), turn('3'), turn('4'), turn('5')]
    await saveSession(repoRoot, session, { maxTurns: 2 })

    const loaded = await loadSession(repoRoot)
    expect(loaded.fresh).toBe(false)
    expect(loaded.session.turns).toHaveLength(2)
    expect(loaded.session.turns.map((t) => t.id)).toEqual(['4', '5'])
    // Hydration must not throw or fall back to "fresh" just because
    // earlier turns are absent from the head file.
  })
})

describe('saveSession — idempotent archive append across a partial-save retry (codex round 3, Task 15 Batch 5 gate P2)', () => {
  function turn(id: string, costUsd: number): ChatSession['turns'][number] {
    return {
      id,
      startedAt: '2026-08-01T00:00:00.000Z',
      userMessage: `msg ${id}`,
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      costUsd,
    }
  }

  /**
   * Mirrors `computeSessionCost` (`run-chat-turn-sdk.ts`): archived
   * spend + whatever's left in the head. Used to assert the ceiling
   * math stays stable across a retry, without needing to export the
   * (deliberately private) function itself.
   */
  function totalCost(session: ChatSession): number {
    const headCost = session.turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
    return (session.archivedCostUsd ?? 0) + headCost
  }

  it('a head-write failure AFTER a successful archive append does not duplicate on retry', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => turn(`t${i}`, 1))

    // Force the HEAD write's rename step to fail while leaving the
    // archive append free to succeed: pre-create the session's JSON
    // path as a DIRECTORY. `writeFile(tmp, ...)` (a fresh, randomly-
    // named sibling file) still succeeds; `rename(tmp, path)` fails
    // because `path` already exists and is a directory.
    const { mkdir: mkdirFs, rm: rmFs } = await import('node:fs/promises')
    const headPath = sessionFilePath(repoRoot, session.id.sessionId)
    await mkdirFs(headPath, { recursive: true })

    await expect(saveSession(repoRoot, session, { maxTurns: 5 })).rejects.toThrow()

    // The archive append ran (and succeeded) before the doomed rename.
    const { readArchivedTurns } = await import('./session-turns-archive')
    const afterFailedAttempt = await readArchivedTurns(repoRoot, session.id.sessionId)
    expect(afterFailedAttempt.map((t) => t.id)).toEqual(['t1', 't2', 't3'])

    // "Process restarts" — the directory blocking the head path goes
    // away (nothing in production leaves that artifact; it only
    // exists here to force the rename failure above), and the SAME
    // stale, untrimmed session (the head was never actually updated)
    // gets retried.
    await rmFs(headPath, { recursive: true, force: true })
    const retried = await saveSession(repoRoot, session, { maxTurns: 5 })

    // No duplicates: still exactly t1-t3, once each.
    const afterRetry = await readArchivedTurns(repoRoot, session.id.sessionId)
    expect(afterRetry.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(new Set(afterRetry.map((t) => t.id)).size).toBe(afterRetry.length)

    // Metadata reflects the TRUE total, not double-counted.
    expect(retried.archivedTurnCount).toBe(3)
    expect(retried.archivedCostUsd).toBe(3)
    expect(retried.turns.map((t) => t.id)).toEqual(['t4', 't5', 't6', 't7', 't8'])

    // computeSessionCost-equivalent: archived ($3) + head (5 x $1 = $5) = $8,
    // matching the true total (8 turns @ $1) — not $11 from a phantom
    // double-count of t1-t3.
    expect(totalCost(retried)).toBe(8)

    const loaded = await loadSession(repoRoot)
    expect(loaded.session).toMatchObject({
      archivedTurnCount: 3,
      archivedCostUsd: 3,
    })
  })

  it('repairs a hand-crafted crash-window state (archive has tail lines the head does not know about yet)', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId)
    session.turns = [1, 2, 3, 4, 5].map((i) => turn(`t${i}`, 2))

    // Simulate exactly the crash window the review named: the archive
    // sidecar already has lines from a PRIOR attempt that never
    // finished updating the head. Write them directly (bypassing
    // saveSession) — the head file doesn't exist yet at all, matching
    // "first-ever archiving save crashed right after the append".
    const { appendArchivedTurns } = await import('./session-turns-archive')
    await appendArchivedTurns(repoRoot, session.id.sessionId, [turn('t1', 2), turn('t2', 2)])

    // The caller retries with the session exactly as it was BEFORE
    // the crashed attempt (all 5 turns still present — the head was
    // never updated) at the same maxTurns.
    const result = await saveSession(repoRoot, session, { maxTurns: 3 })

    const { readArchivedTurns } = await import('./session-turns-archive')
    const archived = await readArchivedTurns(repoRoot, session.id.sessionId)
    // t1, t2 already existed (hand-crafted) — must NOT be duplicated.
    // t1, t2 are exactly what this save's own split would also
    // archive (5 turns, maxTurns 3 -> oldest 2), so nothing NEW gets
    // appended this round.
    expect(archived.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(result.archivedTurnCount).toBe(2)
    expect(result.archivedCostUsd).toBe(4)
    expect(result.turns.map((t) => t.id)).toEqual(['t3', 't4', 't5'])
    expect(totalCost(result)).toBe(10) // 5 turns @ $2, no double-count
  })
})

describe('detached session keying (Phase 1)', () => {
  it('loads a distinct file when sessionId is provided', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const sessionId = 'detached-abc123'
    const session = makeEmptySession(projectId, sessionId)
    session.turns.push({
      id: 'turn-detached',
      startedAt: '2026-05-22T00:00:00.000Z',
      userMessage: 'detached prompt',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    await saveSession(repoRoot, session)

    const result = await loadSession(repoRoot, { sessionId })
    expect(result.fresh).toBe(false)
    expect(result.session.id.sessionId).toBe(sessionId)
    expect(result.session.id.projectId).toBe(projectId)
    expect(result.session.turns[0].id).toBe('turn-detached')
  })

  it('keeps default session (sessionId omitted) separate from detached sessions', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const defaultSession = makeEmptySession(projectId)
    defaultSession.turns.push({
      id: 'turn-default',
      startedAt: 'x',
      userMessage: 'default prompt',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    const detached = makeEmptySession(projectId, 'detached-1')
    detached.turns.push({
      id: 'turn-detached',
      startedAt: 'y',
      userMessage: 'detached prompt',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    await Promise.all([
      saveSession(repoRoot, defaultSession),
      saveSession(repoRoot, detached),
    ])

    const a = await loadSession(repoRoot)
    expect(a.session.turns[0].id).toBe('turn-default')

    const b = await loadSession(repoRoot, { sessionId: 'detached-1' })
    expect(b.session.turns[0].id).toBe('turn-detached')
  })

  it('reads a pre-Phase-1 file (no id.sessionId field) as the project default', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Seed the dir, then overwrite with a pre-Phase-1 shape.
    await saveSession(repoRoot, makeEmptySession(projectId))
    const path = sessionFilePath(repoRoot, projectId)
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        // Pre-Phase-1: id is just { projectId }, no sessionId.
        id: { projectId },
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
        turns: [],
      }),
      'utf8',
    )

    const result = await loadSession(repoRoot)
    expect(result.fresh).toBe(false)
    // The store fills sessionId = projectId so the in-memory record
    // exposes the new shape without rewriting the file.
    expect(result.session.id.sessionId).toBe(projectId)
    expect(result.session.id.projectId).toBe(projectId)
  })

  it('returns a fresh session for an unseen sessionId', async () => {
    const result = await loadSession(repoRoot, { sessionId: 'never-saved' })
    expect(result.fresh).toBe(true)
    expect(result.session.id.sessionId).toBe('never-saved')
  })

  it('listSessionsForProject returns empty when no sessions exist', async () => {
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries).toEqual([])
  })

  it('listSessionsForProject returns all sessions for the project sorted by updatedAt desc', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const older = makeEmptySession(projectId, 'sess-older')
    older.createdAt = '2026-05-20T00:00:00.000Z'
    older.updatedAt = '2026-05-20T00:00:00.000Z'
    const newer = makeEmptySession(projectId, 'sess-newer')
    newer.createdAt = '2026-05-22T00:00:00.000Z'
    newer.updatedAt = '2026-05-22T00:00:00.000Z'
    newer.turns.push({
      id: 'turn-1',
      startedAt: 'x',
      userMessage: 'hello world prompt',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    // Save older then newer so file-system updatedAt would NOT match
    // session.updatedAt. The listing must order by the in-file timestamp,
    // not by mtime.
    await saveSession(repoRoot, older)
    await saveSession(repoRoot, newer)
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.map((s) => s.sessionId)).toEqual(['sess-newer', 'sess-older'])
    const newerSummary = summaries[0]
    expect(newerSummary.projectId).toBe(projectId)
    expect(newerSummary.turnCount).toBe(1)
    expect(newerSummary.lastUserMessagePreview).toBe('hello world prompt')
  })

  it('listSessionsForProject filters out sessions persisted for a different projectId', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    await saveSession(repoRoot, makeEmptySession(projectId, 'sess-mine'))
    // Manually plant a file with a foreign projectId in the same dir.
    const foreign = {
      schemaVersion: 1,
      id: { projectId: 'foreignproj1234', sessionId: 'foreign-1' },
      createdAt: 'x',
      updatedAt: 'y',
      turns: [],
    }
    const dir = join(repoRoot, '.desde/chat-sessions')
    await writeFile(join(dir, 'foreign-1.json'), JSON.stringify(foreign), 'utf8')

    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.map((s) => s.sessionId)).toEqual(['sess-mine'])
  })

  it('listSessionsForProject ignores tempfiles and non-json entries', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    await saveSession(repoRoot, makeEmptySession(projectId, 'sess-1'))
    const dir = join(repoRoot, '.desde/chat-sessions')
    await writeFile(join(dir, 'sess-2.json.tmp-abc'), 'garbage', 'utf8')
    await writeFile(join(dir, 'README'), 'not a session', 'utf8')

    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.map((s) => s.sessionId)).toEqual(['sess-1'])
  })

  it('listSessionsForProject populates Phase 3 drawer fields (firstUserMessagePreview, conflictCount, lastTurnError, pinnedPage, pinnedSelection)', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rich')
    session.createdAt = '2026-05-23T00:00:00.000Z'
    session.updatedAt = '2026-05-23T00:01:00.000Z'
    session.turns.push({
      id: 'turn-1',
      startedAt: '2026-05-23T00:00:00.000Z',
      completedAt: '2026-05-23T00:00:30.000Z',
      userMessage: 'tighten card padding everywhere on the login page',
      selection: {
        selector: '#card-1',
        componentName: 'KCard',
        componentFile: 'src/components/KCard.vue',
      },
      page: {
        url: 'http://localhost:3000/login',
        route: '/login',
        sourceFile: 'src/views/Login.vue',
        framework: 'vue3',
      },
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      error: 'turn aborted',
    })
    session.conflicts = {
      '/abs/src/components/KCard.vue': {
        detectedAt: '2026-05-23T00:00:25.000Z',
        hashAtRead: 'aaa',
        hashAtWrite: 'bbb',
      },
      '/abs/src/views/Login.vue': {
        detectedAt: '2026-05-23T00:00:26.000Z',
        hashAtRead: 'ccc',
        hashAtWrite: 'ddd',
      },
    }
    await saveSession(repoRoot, session)

    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries).toHaveLength(1)
    const s = summaries[0]
    expect(s.firstUserMessagePreview).toBe(
      'tighten card padding everywhere on the login page',
    )
    expect(s.lastUserMessagePreview).toContain('tighten card padding')
    expect(s.conflictCount).toBe(2)
    expect(s.lastTurnError).toBe('turn aborted')
    expect(s.pinnedPage).toEqual({
      url: 'http://localhost:3000/login',
      route: '/login',
      sourceFile: 'src/views/Login.vue',
    })
    expect(s.pinnedSelection).toEqual({
      selector: '#card-1',
      componentName: 'KCard',
      componentFile: 'src/components/KCard.vue',
    })
  })

  it('listSessionsForProject omits Phase 3 fields when the data is absent', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-bare')
    session.turns.push({
      id: 'turn-1',
      startedAt: 'x',
      userMessage: 'just a prompt',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    await saveSession(repoRoot, session)
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries).toHaveLength(1)
    const s = summaries[0]
    expect(s.firstUserMessagePreview).toBe('just a prompt')
    expect(s.conflictCount).toBeUndefined()
    expect(s.lastTurnError).toBeUndefined()
    expect(s.pinnedPage).toBeUndefined()
    expect(s.pinnedSelection).toBeUndefined()
  })

  it('listSessionsForProject does not crash on a malformed userMessage in the last turn', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Seed the dir, then plant a session with a non-string userMessage.
    await saveSession(repoRoot, makeEmptySession(projectId, 'sess-malformed'))
    const dir = join(repoRoot, '.desde/chat-sessions')
    await writeFile(
      join(dir, 'sess-malformed.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: { projectId, sessionId: 'sess-malformed' },
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        // userMessage is a number — the listing must type-guard before slicing.
        turns: [{ userMessage: 123 }],
      }),
      'utf8',
    )

    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.length).toBe(1)
    expect(summaries[0].sessionId).toBe('sess-malformed')
    expect(summaries[0].turnCount).toBe(1)
    // No preview because userMessage isn't a string — the field is omitted.
    expect(summaries[0].lastUserMessagePreview).toBeUndefined()
  })
})

describe('storage-boundary sessionId validation (defense in depth)', () => {
  it('rejects path-traversal sessionId in saveSession', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const bad = makeEmptySession(projectId)
    bad.id.sessionId = '../../../etc/passwd'
    await expect(saveSession(repoRoot, bad)).rejects.toThrow(/Invalid sessionId/i)
  })

  it('rejects path-traversal sessionId in loadSession', async () => {
    await expect(
      loadSession(repoRoot, { sessionId: '../../../etc/passwd' }),
    ).rejects.toThrow(/Invalid sessionId/i)
  })

  it('rejects an empty sessionId in sessionFilePath', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    void projectId
    expect(() => sessionFilePath(repoRoot, '')).toThrow(/Invalid sessionId/i)
  })

  it('accepts a valid UUID-shaped sessionId in saveSession', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    // Standard hyphen-separated uuid-ish string is well within the
    // accepted pattern.
    const valid = makeEmptySession(projectId, 'detached-abc-123_XYZ')
    // saveSession now RETURNS the persisted session (codex round 2,
    // Task 15 Batch 5 gate P2 — see session-store.ts's doc comment);
    // it no longer resolves to undefined.
    await expect(saveSession(repoRoot, valid)).resolves.toMatchObject({
      id: { projectId, sessionId: 'detached-abc-123_XYZ' },
    })
  })
})

describe('withSessionStatus (Phase 5)', () => {
  it('writes status + statusUpdatedAt and preserves all other fields', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-x')
    session.turns.push({
      id: 't1',
      startedAt: 'x',
      userMessage: 'hello',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    const next = withSessionStatus(session, 'in-flight')
    expect(next.status).toBe('in-flight')
    expect(next.statusUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(next.turns).toBe(session.turns)
    // Returns a fresh object, not a mutation.
    expect(next).not.toBe(session)
  })

  it('attaches the reason when provided (failed case)', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-x')
    const next = withSessionStatus(session, 'failed', 'rate-limited')
    expect(next.status).toBe('failed')
    expect(next.statusReason).toBe('rate-limited')
  })

  it('clears a stale reason on the idle path (recovered turn)', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-x')
    session.status = 'failed'
    session.statusReason = 'previous error'
    const next = withSessionStatus(session, 'idle')
    expect(next.status).toBe('idle')
    expect(next.statusReason).toBeUndefined()
  })

  it('clears a stale reason on the in-flight path (codex round-1 #7 — failed → retry)', () => {
    // A session that previously `failed` shouldn't carry its old
    // failure reason into the next turn's `in-flight` state. The
    // Running badge's tooltip would otherwise misrepresent why the
    // session is busy.
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-x')
    session.status = 'failed'
    session.statusReason = 'previous error'
    const next = withSessionStatus(session, 'in-flight')
    expect(next.status).toBe('in-flight')
    expect(next.statusReason).toBeUndefined()
  })

  it('preserves reason on the failed path even when none is supplied', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-x')
    session.status = 'failed'
    session.statusReason = 'prior failure'
    const next = withSessionStatus(session, 'failed')
    expect(next.status).toBe('failed')
    // Without an explicit new reason on a `failed` → `failed`
    // transition, the existing reason persists.
    expect(next.statusReason).toBe('prior failure')
  })

  // Phase 5 rate-limit handling — failure-kind metadata propagation.
  it('attaches failureKind + retryAfterSeconds on a rate-limited failure', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    const next = withSessionStatus(session, 'failed', '429 too many requests', {
      failureKind: 'rate-limited',
      retryAfterSeconds: 30,
    })
    expect(next.statusFailureKind).toBe('rate-limited')
    expect(next.statusRetryAfterSeconds).toBe(30)
  })

  it('clears failureKind + retryAfterSeconds on a non-failed transition', () => {
    // A successful retry of a rate-limited session must not leave
    // the rate-limited badge sticky on the resulting `idle` row.
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    session.status = 'failed'
    session.statusReason = '429 too many requests'
    session.statusFailureKind = 'rate-limited'
    session.statusRetryAfterSeconds = 30
    const next = withSessionStatus(session, 'idle')
    expect(next.statusFailureKind).toBeUndefined()
    expect(next.statusRetryAfterSeconds).toBeUndefined()
  })

  it('allows attaching only failureKind without retryAfterSeconds', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    const next = withSessionStatus(session, 'failed', 'rate_limit', {
      failureKind: 'rate-limited',
    })
    expect(next.statusFailureKind).toBe('rate-limited')
    expect(next.statusRetryAfterSeconds).toBeUndefined()
  })

  it('clears stale retryAfterSeconds on failed→failed when new meta omits the field (codex round-1 #3)', () => {
    // Without this clear, a rate-limited failure followed by a
    // generic failure (no retry hint) would preserve the prior
    // retryAfterSeconds — the picker badge tooltip would lie.
    // The contract: when `meta` is supplied, treat absent fields
    // as the new ground truth.
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    session.status = 'failed'
    session.statusFailureKind = 'rate-limited'
    session.statusRetryAfterSeconds = 30
    const next = withSessionStatus(session, 'failed', 'Bridge timeout', {
      failureKind: 'other',
      // retryAfterSeconds intentionally omitted
    })
    expect(next.statusFailureKind).toBe('other')
    expect(next.statusRetryAfterSeconds).toBeUndefined()
  })

  it('clears stale failureKind on failed→failed when new meta omits it', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    session.status = 'failed'
    session.statusFailureKind = 'rate-limited'
    const next = withSessionStatus(session, 'failed', 'new reason', {})
    expect(next.statusFailureKind).toBeUndefined()
  })

  it('legacy callers (no meta arg) preserve existing failureKind on failed→failed', () => {
    // The 3-arg signature predates Phase 5 rate-limit; callers
    // using it (or passing `undefined` for meta) shouldn't be
    // surprised by silent metadata mutation.
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    session.status = 'failed'
    session.statusFailureKind = 'rate-limited'
    session.statusRetryAfterSeconds = 30
    const next = withSessionStatus(session, 'failed', 'new reason')
    expect(next.statusFailureKind).toBe('rate-limited')
    expect(next.statusRetryAfterSeconds).toBe(30)
  })

  it('clears failureKind on retry path (failed rate-limited → in-flight)', () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, 'sess-rl')
    session.status = 'failed'
    session.statusFailureKind = 'rate-limited'
    session.statusRetryAfterSeconds = 30
    const next = withSessionStatus(session, 'in-flight')
    expect(next.statusFailureKind).toBeUndefined()
    expect(next.statusRetryAfterSeconds).toBeUndefined()
  })
})

describe('listSessionsForProject — Phase 5 status filtering', () => {
  it('omits cancelled sessions from the listing', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const visible = makeEmptySession(projectId, 'sess-visible')
    visible.status = 'idle'
    const hidden = makeEmptySession(projectId, 'sess-hidden')
    hidden.status = 'cancelled'
    hidden.statusReason = 'restart-clear'
    await saveSession(repoRoot, visible)
    await saveSession(repoRoot, hidden)
    const summaries = await listSessionsForProject(repoRoot)
    expect(summaries.map((s) => s.sessionId)).toEqual(['sess-visible'])
  })

  it('surfaces status + statusReason on the summary for non-cancelled rows', async () => {
    const projectId = projectIdForRepoRoot(repoRoot)
    const failed = makeEmptySession(projectId, 'sess-failed')
    failed.status = 'failed'
    failed.statusReason = 'rate-limited'
    failed.turns.push({
      id: 't1',
      startedAt: 'x',
      userMessage: 'hi',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    })
    await saveSession(repoRoot, failed)
    const [summary] = await listSessionsForProject(repoRoot)
    expect(summary.status).toBe('failed')
    expect(summary.statusReason).toBe('rate-limited')
  })
})

describe('findRecentWriterForFile', () => {
  const projectId = () => projectIdForRepoRoot(repoRoot)

  function buildSession(opts: {
    sessionId: string
    updatedAt: string
    firstUserMessage: string
    files: string[]
    /** Override the edit proposals' `proposedAt`. Defaults to `updatedAt`. */
    proposedAt?: string
  }): ChatSession {
    const session = makeEmptySession(projectId(), opts.sessionId)
    session.updatedAt = opts.updatedAt
    session.turns.push({
      id: `${opts.sessionId}-t1`,
      startedAt: opts.updatedAt,
      completedAt: opts.updatedAt,
      userMessage: opts.firstUserMessage,
      assistantContent: [],
      toolResults: {},
      editProposals: opts.files.map((file, i) => ({
        editId: `${opts.sessionId}-e${i}`,
        kind: 'overwrite' as const,
        files: [file],
        proposedAt: opts.proposedAt ?? opts.updatedAt,
      })),
    })
    return session
  }

  it('returns null when no session has touched the file', async () => {
    const result = await findRecentWriterForFile(
      repoRoot,
      'excluded',
      'src/Untouched.vue',
    )
    expect(result).toBeNull()
  })

  it('returns null when the only writer is the excluded session', async () => {
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'self',
        updatedAt: '2026-05-13T00:00:00.000Z',
        firstUserMessage: 'change my own file',
        files: ['src/App.vue'],
      }),
    )
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result).toBeNull()
  })

  it('returns the other session that touched the file', async () => {
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'self',
        updatedAt: '2026-05-13T00:00:00.000Z',
        firstUserMessage: 'my prompt',
        files: ['src/Other.vue'],
      }),
    )
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'rival',
        updatedAt: '2026-05-13T00:01:00.000Z',
        firstUserMessage: 'rename Submit to Save',
        files: ['src/App.vue'],
      }),
    )
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result?.sessionId).toBe('rival')
    expect(result?.firstUserMessagePreview).toBe('rename Submit to Save')
  })

  it('picks the session whose file write was most recent', async () => {
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'older',
        updatedAt: '2026-05-13T00:00:00.000Z',
        firstUserMessage: 'old refactor',
        files: ['src/App.vue'],
      }),
    )
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'newer',
        updatedAt: '2026-05-13T00:05:00.000Z',
        firstUserMessage: 'newer refactor',
        files: ['src/App.vue'],
      }),
    )
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result?.sessionId).toBe('newer')
  })

  it('ranks by file proposedAt, not session updatedAt (Codex PR2 P2)', async () => {
    // Session A wrote App.vue at T=0 but kept chatting (no further
    // touches to App.vue) until T=10. Session B wrote App.vue at
    // T=5. The correct conflicting writer for App.vue is B — the
    // recent ACTIVE writer on this file — even though A's session
    // looks "more recently updated" overall.
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'session-A',
        updatedAt: '2026-05-13T00:10:00.000Z',
        firstUserMessage: 'A: early write, late chat',
        files: ['src/App.vue'],
        proposedAt: '2026-05-13T00:00:00.000Z',
      }),
    )
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'session-B',
        updatedAt: '2026-05-13T00:05:00.000Z',
        firstUserMessage: 'B: actual recent writer',
        files: ['src/App.vue'],
        proposedAt: '2026-05-13T00:05:00.000Z',
      }),
    )
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result?.sessionId).toBe('session-B')
  })

  it('survives a malformed session file without throwing', async () => {
    await saveSession(
      repoRoot,
      buildSession({
        sessionId: 'good',
        updatedAt: '2026-05-13T00:00:00.000Z',
        firstUserMessage: 'good prompt',
        files: ['src/App.vue'],
      }),
    )
    const garbagePath = join(repoRoot, '.desde/chat-sessions/garbage.json')
    await writeFile(garbagePath, '{not valid json', 'utf8')
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result?.sessionId).toBe('good')
  })

  it('returns null when the sessions directory does not exist', async () => {
    // No saveSession called — directory never created.
    const result = await findRecentWriterForFile(repoRoot, 'self', 'src/App.vue')
    expect(result).toBeNull()
  })
})

/**
 * A prototype repo is untrusted input (2026-08-09 doctrine) and can ship
 * `.desde` as a symlink. The session record carries the whole conversation, so
 * following such a link would write every message the user typed into whatever
 * directory the repo chose. See `src/editor/worktree/desde-dir.ts`.
 */
describe('a .desde that is a symlink', () => {
  let target: string

  beforeEach(async () => {
    target = join(repoRoot, 'target')
    await mkdir(target, { recursive: true })
    await symlink(target, join(repoRoot, '.desde'))
  })

  it('refuses to save a session, and leaves the link target empty', async () => {
    await expect(saveSession(repoRoot, makeEmptySession('p1'))).rejects.toThrow(
      /\.desde is a symbolic link/,
    )
    expect(await readdir(target)).toEqual([])
  })

  it('refuses to list sessions rather than reading through the link', async () => {
    await expect(listSessionsForProject(repoRoot)).rejects.toThrow(
      /\.desde is a symbolic link/,
    )
  })

  it('reports no recent writer instead of scanning through the link', async () => {
    expect(await findRecentWriterForFile(repoRoot, 'other', 'src/App.vue')).toBeNull()
  })
})
