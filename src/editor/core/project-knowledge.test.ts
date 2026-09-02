import { describe, expect, it } from 'vitest'
import {
  assembleRulesDigest,
  RULES_DIGEST_BUDGET,
  type RulesFileInput,
} from './project-knowledge'

describe('assembleRulesDigest', () => {
  it('returns an empty digest for no files', () => {
    const r = assembleRulesDigest([])
    expect(r.rules).toBe('')
    expect(r.rulesFiles).toEqual([])
    expect(r.truncated).toBe(false)
  })

  it('concatenates files in the given priority order with path headers', () => {
    const files: RulesFileInput[] = [
      { path: 'CLAUDE.md', content: 'claude rules' },
      { path: 'AGENTS.md', content: 'agents rules' },
    ]
    const r = assembleRulesDigest(files)
    expect(r.truncated).toBe(false)
    expect(r.rules).toContain('----- CLAUDE.md -----')
    expect(r.rules).toContain('claude rules')
    expect(r.rules).toContain('----- AGENTS.md -----')
    expect(r.rules).toContain('agents rules')
    // CLAUDE.md comes before AGENTS.md.
    expect(r.rules.indexOf('CLAUDE.md')).toBeLessThan(r.rules.indexOf('AGENTS.md'))
    expect(r.rulesFiles.map((f) => f.path)).toEqual(['CLAUDE.md', 'AGENTS.md'])
    expect(r.rulesFiles.every((f) => !f.truncated)).toBe(true)
  })

  it('records per-file char provenance that sums to the digest length', () => {
    const files: RulesFileInput[] = [
      { path: 'a.md', content: 'a'.repeat(100) },
      { path: 'b.md', content: 'b'.repeat(50) },
    ]
    const r = assembleRulesDigest(files)
    const total = r.rulesFiles.reduce((sum, f) => sum + f.chars, 0)
    expect(total).toBe(r.rules.length)
  })

  it('truncates the file that overruns the budget and drops the rest', () => {
    const budget = 500
    const files: RulesFileInput[] = [
      { path: 'big.md', content: 'x'.repeat(2000) },
      { path: 'dropped.md', content: 'should not appear' },
    ]
    const r = assembleRulesDigest(files, budget)
    expect(r.truncated).toBe(true)
    expect(r.rules).toContain('truncated to fit')
    expect(r.rules).not.toContain('should not appear')
    expect(r.rules.length).toBeLessThanOrEqual(budget)
    expect(r.rulesFiles).toHaveLength(1)
    expect(r.rulesFiles[0]).toMatchObject({ path: 'big.md', truncated: true })
  })

  it('drops a whole file when too little budget remains for a meaningful chunk', () => {
    // First file nearly fills the budget; the second has no room left.
    const budget = 400
    const files: RulesFileInput[] = [
      { path: 'first.md', content: 'y'.repeat(380) },
      { path: 'second.md', content: 'second content' },
    ]
    const r = assembleRulesDigest(files, budget)
    expect(r.truncated).toBe(true)
    expect(r.rules).toContain('first.md')
    expect(r.rules).not.toContain('second content')
    expect(r.rulesFiles.map((f) => f.path)).toEqual(['first.md'])
  })

  it('keeps a small file that fits whole even when < MIN_SECTION_BODY budget remains', () => {
    // Regression: the budget left after `first.md` (49 chars) is far below
    // the MIN_SECTION_BODY (200) threshold, but `tiny.md` fits whole, so it
    // must be kept — the threshold only gates *truncation*, not inclusion.
    const budget = 450
    const files: RulesFileInput[] = [
      { path: 'first.md', content: 'a'.repeat(380) },
      { path: 'tiny.md', content: 'x' },
    ]
    const r = assembleRulesDigest(files, budget)
    expect(r.rulesFiles.map((f) => f.path)).toEqual(['first.md', 'tiny.md'])
    expect(r.rulesFiles.every((f) => !f.truncated)).toBe(true)
    expect(r.truncated).toBe(false)
    expect(r.rules).toContain('tiny.md')
  })

  it('keeps everything and stays un-truncated when well under budget', () => {
    const files: RulesFileInput[] = [
      { path: 'CLAUDE.md', content: 'short' },
      { path: '.cursorrules', content: 'also short' },
    ]
    const r = assembleRulesDigest(files, RULES_DIGEST_BUDGET)
    expect(r.truncated).toBe(false)
    expect(r.rulesFiles).toHaveLength(2)
  })

  it('handles a single file larger than the entire budget', () => {
    const budget = 300
    const r = assembleRulesDigest(
      [{ path: 'huge.md', content: 'z'.repeat(100_000) }],
      budget,
    )
    expect(r.truncated).toBe(true)
    expect(r.rulesFiles).toHaveLength(1)
    expect(r.rulesFiles[0].truncated).toBe(true)
    expect(r.rules.length).toBeLessThanOrEqual(budget)
  })
})
