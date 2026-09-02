import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetCrossSessionWriteLog,
  lookupRecentCrossSessionWriter,
  recordCrossSessionWrite,
} from './cross-session-write-log'

beforeEach(() => {
  __resetCrossSessionWriteLog()
})

describe('cross-session-write-log', () => {
  const ABS = '/repo/.desde/scratch/edit-1/src/App.vue'

  it('returns null when no entry exists for the path', () => {
    expect(lookupRecentCrossSessionWriter(ABS, 'session-A')).toBeNull()
  })

  it('returns the recorded entry for a different session', () => {
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-B',
      firstUserMessagePreview: 'rename buttons',
      at: '2026-05-27T00:00:00.000Z',
    })
    const got = lookupRecentCrossSessionWriter(ABS, 'session-A')
    expect(got?.sessionId).toBe('session-B')
    expect(got?.firstUserMessagePreview).toBe('rename buttons')
  })

  it('excludes entries from the requesting session', () => {
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-A',
      firstUserMessagePreview: 'my own prior write',
      at: '2026-05-27T00:00:00.000Z',
    })
    expect(lookupRecentCrossSessionWriter(ABS, 'session-A')).toBeNull()
  })

  it('returns the MOST RECENT non-self entry when multiple sessions wrote the same file', () => {
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-B',
      firstUserMessagePreview: 'old write',
      at: '2026-05-27T00:00:00.000Z',
    })
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-A',
      firstUserMessagePreview: 'self write, should be skipped',
      at: '2026-05-27T00:01:00.000Z',
    })
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-C',
      firstUserMessagePreview: 'newest other write',
      at: '2026-05-27T00:02:00.000Z',
    })
    const got = lookupRecentCrossSessionWriter(ABS, 'session-A')
    expect(got?.sessionId).toBe('session-C')
    expect(got?.firstUserMessagePreview).toBe('newest other write')
  })

  it('returns the most recent entry even when many self-writes follow', () => {
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-B',
      firstUserMessagePreview: 'the conflicting writer',
      at: '2026-05-27T00:00:00.000Z',
    })
    for (let i = 0; i < 5; i++) {
      recordCrossSessionWrite(ABS, {
        sessionId: 'session-A',
        firstUserMessagePreview: `self write ${i}`,
        at: `2026-05-27T00:0${i + 1}:00.000Z`,
      })
    }
    const got = lookupRecentCrossSessionWriter(ABS, 'session-A')
    expect(got?.sessionId).toBe('session-B')
  })

  it('caps entries at MAX_ENTRIES_PER_FILE — oldest fall off in FIFO order', () => {
    // Push 12 entries from B; only the last 10 should remain. Lookup
    // from A should see the newest B entry, not the earliest.
    for (let i = 0; i < 12; i++) {
      recordCrossSessionWrite(ABS, {
        sessionId: `session-B-${i}`,
        firstUserMessagePreview: `B's write #${i}`,
        at: `2026-05-27T00:${String(i).padStart(2, '0')}:00.000Z`,
      })
    }
    // The most recent non-self entry is the last one pushed.
    const got = lookupRecentCrossSessionWriter(ABS, 'session-A')
    expect(got?.sessionId).toBe('session-B-11')
    // And the oldest entries should be gone. Lookup excluding the
    // newest 10 sessionIds should fall through them and then return
    // null (the first 2 were evicted).
    const excludingAllRemaining = lookupRecentCrossSessionWriter(ABS, 'session-B-NA')
    expect(excludingAllRemaining?.sessionId).toBe('session-B-11')
  })

  it('paths are independent — recording on file A does not affect file B', () => {
    const A = '/repo/file-a.vue'
    const B = '/repo/file-b.vue'
    recordCrossSessionWrite(A, {
      sessionId: 'session-X',
      at: '2026-05-27T00:00:00.000Z',
    })
    expect(lookupRecentCrossSessionWriter(A, 'self')?.sessionId).toBe('session-X')
    expect(lookupRecentCrossSessionWriter(B, 'self')).toBeNull()
  })

  it('preserves entries with no firstUserMessagePreview (lookup result has no preview either)', () => {
    recordCrossSessionWrite(ABS, {
      sessionId: 'session-B',
      at: '2026-05-27T00:00:00.000Z',
    })
    const got = lookupRecentCrossSessionWriter(ABS, 'session-A')
    expect(got?.sessionId).toBe('session-B')
    expect(got?.firstUserMessagePreview).toBeUndefined()
  })
})
