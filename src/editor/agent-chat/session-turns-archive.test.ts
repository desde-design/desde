import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ChatTurn } from './types'
import {
  DEFAULT_MAX_CHAT_TURNS,
  appendArchivedTurns,
  archiveFilePath,
  readArchivedTurns,
  splitTurnsForArchive,
  sumTurnCostUsd,
} from './session-turns-archive'
import { estimateUsageCost } from '../llm-providers/rate-cards'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-turns-archive-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeTurn(id: string, costUsd?: number): ChatTurn {
  return {
    id,
    startedAt: new Date().toISOString(),
    userMessage: `turn ${id}`,
    assistantContent: [],
    toolResults: {},
    editProposals: [],
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

/** A turn with only a usage record (no vendor-reported `costUsd`) — the shape this
 * whole test group is about (audit Task 15, codex round 4 P2). */
function makeUsageTurn(
  id: string,
  usage: { inputTokens: number; outputTokens: number },
  model?: string,
): ChatTurn {
  return {
    id,
    startedAt: new Date().toISOString(),
    userMessage: `turn ${id}`,
    assistantContent: [],
    toolResults: {},
    editProposals: [],
    usage,
    ...(model !== undefined ? { model } : {}),
  }
}

describe('splitTurnsForArchive', () => {
  it('exposes a default cap of 500', () => {
    expect(DEFAULT_MAX_CHAT_TURNS).toBe(500)
  })

  it('archives nothing when under the cap', () => {
    const turns = [makeTurn('1'), makeTurn('2')]
    const result = splitTurnsForArchive(turns, 10)
    expect(result.head).toEqual(turns)
    expect(result.archived).toEqual([])
  })

  it('archives nothing when exactly at the cap', () => {
    const turns = [makeTurn('1'), makeTurn('2')]
    const result = splitTurnsForArchive(turns, 2)
    expect(result.head).toEqual(turns)
    expect(result.archived).toEqual([])
  })

  it('moves the OLDEST overflow turns to archived, keeps the newest as head', () => {
    const turns = [makeTurn('1'), makeTurn('2'), makeTurn('3'), makeTurn('4'), makeTurn('5')]
    const result = splitTurnsForArchive(turns, 3)
    expect(result.archived.map((t) => t.id)).toEqual(['1', '2'])
    expect(result.head.map((t) => t.id)).toEqual(['3', '4', '5'])
  })

  it('treats a non-positive cap as "no cap" (never archives everything out from under a session)', () => {
    const turns = [makeTurn('1'), makeTurn('2')]
    expect(splitTurnsForArchive(turns, 0).archived).toEqual([])
    expect(splitTurnsForArchive(turns, -5).archived).toEqual([])
    expect(splitTurnsForArchive(turns, NaN).archived).toEqual([])
  })
})

describe('sumTurnCostUsd', () => {
  it('sums costUsd across turns, treating missing as 0', () => {
    const turns = [makeTurn('1', 0.5), makeTurn('2'), makeTurn('3', 1.25)]
    expect(sumTurnCostUsd(turns)).toBeCloseTo(1.75)
  })

  it('returns 0 for an empty array', () => {
    expect(sumTurnCostUsd([])).toBe(0)
  })

  // Audit Task 15, codex round 4 P2 — a usage-only turn (no vendor
  // costUsd) must fold in at its rate-card ESTIMATE, not silently as
  // zero. Before the fix, sumTurnCostUsd only looked at `costUsd`.
  it('estimates a usage-only turn from the rate card, matching estimateUsageCost exactly', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const turn = makeUsageTurn('u1', usage, 'claude-sonnet-5')
    const expected = estimateUsageCost('claude-sonnet-5', usage)
    expect(expected).toBeGreaterThan(0) // sanity: this model has a real rate card
    expect(sumTurnCostUsd([turn])).toBe(expected)
  })

  it('sums a MIXED batch (vendor costUsd + usage-only) matching a hand-computed total', () => {
    const usageA = { inputTokens: 500_000, outputTokens: 100_000 }
    const usageB = { inputTokens: 200_000, outputTokens: 50_000 }
    const turns = [
      makeTurn('vendor-1', 2.5), // vendor-reported, ground truth
      makeUsageTurn('usage-1', usageA, 'claude-sonnet-5'),
      makeTurn('vendor-2', 0.75),
      makeUsageTurn('usage-2', usageB, 'claude-haiku-4-5'),
      makeTurn('zero'), // neither costUsd nor usage -> contributes 0
    ]
    const expected =
      2.5 +
      estimateUsageCost('claude-sonnet-5', usageA) +
      0.75 +
      estimateUsageCost('claude-haiku-4-5', usageB) +
      0
    expect(sumTurnCostUsd(turns)).toBeCloseTo(expected, 10)
  })

  it('prefers costUsd over usage when a turn has BOTH (vendor cost is ground truth)', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const turn: ChatTurn = { ...makeUsageTurn('both', usage, 'claude-sonnet-5'), costUsd: 0.01 }
    expect(sumTurnCostUsd([turn])).toBe(0.01)
  })

  it('a usage-only turn with no model falls back to the unknown-model rate, no NaN', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    const turn = makeUsageTurn('no-model', usage) // model omitted
    const expected = estimateUsageCost('unknown-model', usage)
    expect(Number.isNaN(sumTurnCostUsd([turn]))).toBe(false)
    expect(sumTurnCostUsd([turn])).toBe(expected)
  })

  it('an old-format turn with neither costUsd nor usage sums to 0, not NaN', () => {
    const bare: ChatTurn = {
      id: 'ancient',
      startedAt: new Date().toISOString(),
      userMessage: 'pre-usage-tracking turn',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
    }
    const total = sumTurnCostUsd([bare])
    expect(Number.isNaN(total)).toBe(false)
    expect(total).toBe(0)
  })
})

describe('appendArchivedTurns + readArchivedTurns round-trip', () => {
  it('is a no-op for an empty turns array (never creates the file)', async () => {
    await appendArchivedTurns(root, 'sess-a', [])
    expect(await readArchivedTurns(root, 'sess-a')).toEqual([])
  })

  it('returns empty when the archive file has never been written', async () => {
    expect(await readArchivedTurns(root, 'never-archived')).toEqual([])
  })

  it('round-trips archived turns oldest-first', async () => {
    const turns = [makeTurn('1'), makeTurn('2'), makeTurn('3')]
    await appendArchivedTurns(root, 'sess-a', turns)
    const readBack = await readArchivedTurns(root, 'sess-a')
    expect(readBack.map((t) => t.id)).toEqual(['1', '2', '3'])
    expect(readBack).toEqual(turns)
  })

  // Audit Task 15, codex round 4 P2 — verifies the JSONL sidecar
  // actually retains `usage` (the review flagged this as something to
  // confirm, not assume): appendArchivedTurns serializes the whole
  // ChatTurn via JSON.stringify with no field allowlist, so it should
  // already round-trip. This pins that empirically rather than by
  // code-reading alone.
  it('preserves the usage field across the JSONL round-trip, so sumTurnCostUsd works on re-read turns', async () => {
    const usage = { inputTokens: 300_000, outputTokens: 40_000 }
    const turn = makeUsageTurn('usage-rt', usage, 'claude-sonnet-5')
    await appendArchivedTurns(root, 'sess-a', [turn])
    const readBack = await readArchivedTurns(root, 'sess-a')
    expect(readBack).toHaveLength(1)
    expect(readBack[0].usage).toEqual(usage)
    expect(readBack[0].model).toBe('claude-sonnet-5')
    expect(readBack[0].costUsd).toBeUndefined()
    // And the re-read turn prices identically to the original.
    expect(sumTurnCostUsd(readBack)).toBe(sumTurnCostUsd([turn]))
  })

  // Audit Task 15, codex round 4 P2 — an archive line written before
  // usage-fallback pricing existed (or a turn that genuinely never
  // captured either field) must load and price at 0, not throw or
  // produce NaN. Written directly (bypassing appendArchivedTurns) to
  // simulate a REAL pre-existing on-disk line, not just an in-memory
  // object missing the field.
  it('loads an old-format archive line lacking BOTH costUsd and usage without NaN', async () => {
    const dir = join(root, '.desde', 'chat-sessions')
    mkdirSync(dir, { recursive: true })
    const oldFormatLine = JSON.stringify({
      id: 'legacy-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      userMessage: 'archived before usage-fallback pricing existed',
      assistantContent: [],
      toolResults: {},
      editProposals: [],
      // no costUsd, no usage — deliberately absent, not null/0.
    })
    writeFileSync(join(dir, 'sess-a.archive.jsonl'), `${oldFormatLine}\n`, 'utf8')
    const readBack = await readArchivedTurns(root, 'sess-a')
    expect(readBack).toHaveLength(1)
    expect(readBack[0].usage).toBeUndefined()
    expect(readBack[0].costUsd).toBeUndefined()
    const total = sumTurnCostUsd(readBack)
    expect(Number.isNaN(total)).toBe(false)
    expect(total).toBe(0) // NOT retroactively invented — genuinely unknown cost stays 0.
  })

  it('accumulates across multiple append calls (append-only)', async () => {
    await appendArchivedTurns(root, 'sess-a', [makeTurn('1'), makeTurn('2')])
    await appendArchivedTurns(root, 'sess-a', [makeTurn('3')])
    const readBack = await readArchivedTurns(root, 'sess-a')
    expect(readBack.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('writes one JSON object per line at the documented path', async () => {
    await appendArchivedTurns(root, 'sess-a', [makeTurn('1')])
    const path = archiveFilePath(root, 'sess-a')
    expect(path).toBe(join(root, '.desde', 'chat-sessions', 'sess-a.archive.jsonl'))
  })

  it('skips a torn trailing line rather than failing the whole read', async () => {
    const dir = join(root, '.desde', 'chat-sessions')
    mkdirSync(dir, { recursive: true })
    const good = JSON.stringify(makeTurn('1'))
    writeFileSync(join(dir, 'sess-a.archive.jsonl'), `${good}\n{"id":"2","broken`, 'utf8')
    const readBack = await readArchivedTurns(root, 'sess-a')
    expect(readBack.map((t) => t.id)).toEqual(['1'])
  })

  it('CX7 fix round 1: the writer creates nothing at the target when .desde is a symlink out of the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'session-turns-archive-outside-'))
    symlinkSync(outside, join(root, '.desde'))

    await expect(appendArchivedTurns(root, 'sess-a', [makeTurn('1')])).rejects.toThrow(
      /symbolic link/i,
    )
    expect(readdirSync(outside)).toEqual([])

    rmSync(outside, { recursive: true, force: true })
  })

  it('CX7 fix round 1: the reader also refuses rather than reading through the symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'session-turns-archive-outside-'))
    symlinkSync(outside, join(root, '.desde'))

    await expect(readArchivedTurns(root, 'sess-a')).rejects.toThrow(/symbolic link/i)

    rmSync(outside, { recursive: true, force: true })
  })
})
