/**
 * Colocated test for `composeRefusalReason` (src/hooks/iteration-fallback.ts).
 *
 * The most specific reason should win: when the AI fallback lane never ran
 * (`kind: 'unavailable'`), the user needs the deterministic resolver's
 * reason PLUS a sentence saying the AI fallback didn't get a turn. When the
 * AI lane ran and refused (`kind: 'refused'`, or `kind` absent for an older
 * server), its own reason is the whole story.
 */

import { describe, expect, it } from 'vitest'
import { composeRefusalReason } from './iteration-fallback'

describe('composeRefusalReason', () => {
  it('appends the LLM reason to the static reason when the AI lane never ran', () => {
    const reason = composeRefusalReason({
      staticReason: "the list's data is imported from ../data, which does not export a plain array",
      llmReason: 'No API key configured',
      llmKind: 'unavailable',
    })
    expect(reason).toBe(
      "the list's data is imported from ../data, which does not export a plain array. The AI fallback could not run: No API key configured",
    )
  })

  it('does not double the period when the static reason already ends in one', () => {
    const reason = composeRefusalReason({
      staticReason: 'The static resolver could not find the array.',
      llmReason: 'No API key configured',
      llmKind: 'unavailable',
    })
    expect(reason).toBe(
      'The static resolver could not find the array. The AI fallback could not run: No API key configured',
    )
    expect(reason).not.toContain('..')
  })

  it('returns only the LLM reason when the AI lane ran and refused', () => {
    const reason = composeRefusalReason({
      staticReason: 'the static resolver could not trace the array',
      llmReason: 'LLM named a file it was not given (src/secrets.ts): refusing the rewrite',
      llmKind: 'refused',
    })
    expect(reason).toBe('LLM named a file it was not given (src/secrets.ts): refusing the rewrite')
  })

  it('returns only the LLM reason when kind is undefined (older server)', () => {
    const reason = composeRefusalReason({
      staticReason: 'the static resolver could not trace the array',
      llmReason: 'HTTP 500',
      llmKind: undefined,
    })
    expect(reason).toBe('HTTP 500')
  })
})
