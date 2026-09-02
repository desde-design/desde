import { describe, expect, it } from 'vitest'

import { containsConflictMarkers, mergeContent } from './merge-content'

describe('mergeContent', () => {
  it('returns a clean merge when both sides edit different lines', async () => {
    const base = 'line1\nline2\nline3\nline4\nline5\n'
    const mine = 'line1\nMINE\nline3\nline4\nline5\n' // edited line 2
    const theirs = 'line1\nline2\nline3\nTHEIRS\nline5\n' // edited line 4
    const result = await mergeContent({ base, mine, theirs })
    expect(result).toEqual({
      ok: true,
      clean: true,
      content: 'line1\nMINE\nline3\nTHEIRS\nline5\n',
    })
  })

  it('returns a conflict when both sides edit the same line', async () => {
    const base = 'line1\nshared\nline3\n'
    const mine = 'line1\nMINE-VERSION\nline3\n'
    const theirs = 'line1\nTHEIRS-VERSION\nline3\n'
    const result = await mergeContent({ base, mine, theirs })
    if (!result.ok) {
      throw new Error(`unexpected error: ${result.reason}`)
    }
    expect(result.clean).toBe(false)
    expect(result.content).toMatch(/<{7} mine/)
    expect(result.content).toMatch(/={7}/)
    expect(result.content).toMatch(/>{7} theirs/)
    expect(result.content).toMatch(/MINE-VERSION/)
    expect(result.content).toMatch(/THEIRS-VERSION/)
  })

  it('handles same-line append (no conflict — both grew the file from base)', async () => {
    const base = 'line1\nline2\n'
    const mine = 'line1\nline2\nMINE-ADDED\n'
    const theirs = 'line1\nline2\nline3\nline4\n'
    const result = await mergeContent({ base, mine, theirs })
    // Both sides appended at the end of the file → conflicting.
    if (!result.ok) throw new Error(result.reason)
    expect(result.clean).toBe(false)
  })

  it('honors custom labels on the conflict markers', async () => {
    const base = 'shared\n'
    const mine = 'changed-by-A\n'
    const theirs = 'changed-by-B\n'
    const result = await mergeContent({
      base,
      mine,
      theirs,
      labels: {
        mine: 'session A — Button.vue',
        theirs: 'session B — Button.vue',
        base: 'read-time base',
      },
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.clean).toBe(false)
    expect(result.content).toMatch(/<{7} session A — Button\.vue/)
    expect(result.content).toMatch(/>{7} session B — Button\.vue/)
  })

  it('returns clean (unchanged) when mine and theirs are identical', async () => {
    const base = 'line1\n'
    const mine = 'line1\nADDED\n'
    const theirs = 'line1\nADDED\n'
    const result = await mergeContent({ base, mine, theirs })
    expect(result).toEqual({ ok: true, clean: true, content: 'line1\nADDED\n' })
  })

  it('returns clean when only one side changed the file', async () => {
    const base = 'line1\nline2\nline3\n'
    const mine = 'line1\nMINE\nline3\n'
    const theirs = 'line1\nline2\nline3\n' // unchanged
    const result = await mergeContent({ base, mine, theirs })
    expect(result).toEqual({ ok: true, clean: true, content: 'line1\nMINE\nline3\n' })
  })

  it('handles empty inputs without crashing', async () => {
    const result = await mergeContent({ base: '', mine: '', theirs: '' })
    expect(result).toEqual({ ok: true, clean: true, content: '' })
  })

  it('handles a file mine deleted but theirs kept (conflict — git surfaces this as removed)', async () => {
    const base = 'line1\nline2\nline3\n'
    const mine = ''
    const theirs = 'line1\nline2\nMODIFIED\n'
    const result = await mergeContent({ base, mine, theirs })
    if (!result.ok) throw new Error(result.reason)
    // git surfaces this as a conflict (one side wiped, other modified).
    expect(result.clean).toBe(false)
  })

  it('returns an error when git is not on PATH', async () => {
    const result = await mergeContent({
      base: 'a',
      mine: 'b',
      theirs: 'c',
      gitBin: '/nonexistent/git-binary',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/merge-file failed/i)
    }
  })

  it('preserves UTF-8 content faithfully', async () => {
    const base = 'コンポーネント\n'
    const mine = 'コンポーネント\n変更A\n'
    const theirs = 'コンポーネント\n変更B\n'
    const result = await mergeContent({ base, mine, theirs })
    if (!result.ok) throw new Error(result.reason)
    expect(result.clean).toBe(false)
    expect(result.content).toContain('変更A')
    expect(result.content).toContain('変更B')
  })
})

describe('containsConflictMarkers', () => {
  it('detects a standard git-style marker block', () => {
    const text =
      'before\n<<<<<<< mine\nmy version\n=======\ntheir version\n>>>>>>> theirs\nafter\n'
    expect(containsConflictMarkers(text)).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(containsConflictMarkers('just some prose')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(containsConflictMarkers('')).toBe(false)
  })

  it('detects markers without trailing labels (`<<<<<<<` at EOL)', () => {
    const text = '<<<<<<<\nx\n=======\ny\n>>>>>>>\n'
    expect(containsConflictMarkers(text)).toBe(true)
  })

  it('does NOT false-positive on legitimate text with angle brackets', () => {
    expect(containsConflictMarkers('a < b > c\n<some-tag>\n')).toBe(false)
    // 6 angle brackets (not 7) shouldn't match.
    expect(containsConflictMarkers('<<<<<<\n')).toBe(false)
    expect(containsConflictMarkers('>>>>>>\n')).toBe(false)
  })

  it('detects the =======  separator line on its own', () => {
    // Edge case: user pasted partial markers. Still flag so we
    // refuse to write.
    expect(containsConflictMarkers('a\n=======\nb\n')).toBe(true)
  })
})
