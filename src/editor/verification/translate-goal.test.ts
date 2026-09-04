/**
 * Tests for the goal → predicate translator (Tier-2 verification P2). A mock
 * `CompletionProvider` returns canned json_schema output, so the test exercises
 * the validation/sanitization layer — not a real model. The translator's job
 * is to pick + validate predicates, never to judge; these tests guard that
 * boundary and the degrade-to-refusal paths.
 *
 * Same fake-provider pattern as repair-edit.test.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CompleteOpts, CompleteResult, CompletionProvider } from '../llm-providers/types'
import { translateGoal } from './translate-goal'

/** Mock provider that returns `canned` as the parsed json_schema result. */
function fakeProvider(canned: unknown | Error): CompletionProvider {
  const complete = vi.fn(async (): Promise<CompleteResult> => {
    if (canned instanceof Error) throw canned
    return {
      text: JSON.stringify(canned),
      parsed: canned,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }
  })
  return { name: 'fake', defaultModel: 'fake-model', complete }
}

/** Mock provider that returns non-JSON (parsed === undefined). */
function fakeMalformed(): CompletionProvider {
  const complete = vi.fn(async (): Promise<CompleteResult> => ({
    text: 'not json',
    parsed: undefined,
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
  }))
  return { name: 'fake', defaultModel: 'fake-model', complete }
}

describe('translateGoal', () => {
  it('translates a single-element goal', async () => {
    const provider = fakeProvider({ predicates: [{ predicate: 'noOverflow' }] })
    const r = await translateGoal({ goal: 'fit the content width', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.predicates).toEqual([{ predicate: 'noOverflow', args: {} }])
    }
  })

  it('translates a two-element goal when the goal names the selector verbatim', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '.header', axis: 'left' } }],
    })
    const r = await translateGoal({ goal: 'align with .header', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.predicates[0]).toEqual({ predicate: 'aligned', args: { other: '.header', axis: 'left' } })
    }
  })

  it('grounds `other` from the referenceElements inventory when the selector is NOT in the goal text', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '[role="banner"]', axis: 'left' } }],
    })
    // The goal says "the header" in prose; the selector `[role="banner"]` is
    // NOT a token in the goal, so it can ONLY be accepted via the inventory —
    // isolating the new grounding path (it would be dropped without it).
    const r = await translateGoal({
      goal: 'align this with the header',
      selector: '.btn',
      provider,
      referenceElements: [{ selector: '[role="banner"]', label: 'Site title' }],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.predicates[0]).toEqual({ predicate: 'aligned', args: { other: '[role="banner"]', axis: 'left' } })
    }
  })

  it('drops an inventory-absent `other` when no inventory is supplied (proves the test above needs the inventory)', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '[role="banner"]', axis: 'left' } }],
    })
    // Same goal + `other`, but NO referenceElements → not grounded → dropped.
    const r = await translateGoal({ goal: 'align this with the header', selector: '.btn', provider })
    expect(r.ok).toBe(false)
  })

  it('drops an `other` that is neither in the goal text nor the inventory', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '.invented', axis: 'left' } }],
    })
    const r = await translateGoal({
      goal: 'align this with the header',
      selector: '.btn',
      provider,
      referenceElements: [{ selector: 'header' }],
    })
    // `.invented` isn't grounded → predicate dropped → no measurable predicate.
    expect(r.ok).toBe(false)
  })

  it('renders the reference-element inventory into the prompt', async () => {
    let capturedUser = ''
    const provider: CompletionProvider = {
      name: 'fake',
      defaultModel: 'm',
      complete: async (opts) => {
        capturedUser = typeof opts.user === 'string' ? opts.user : JSON.stringify(opts.user)
        return {
          text: JSON.stringify({ predicates: [{ predicate: 'noOverflow' }] }),
          parsed: { predicates: [{ predicate: 'noOverflow' }] },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn' as const,
        }
      },
    }
    await translateGoal({
      goal: 'align with the nav',
      selector: '.btn',
      provider,
      referenceElements: [{ selector: 'nav', label: 'Home About' }],
    })
    expect(capturedUser).toContain('Available elements')
    expect(capturedUser).toContain('nav')
    expect(capturedUser).toContain('Home About')
  })

  it('grounds `other` by whole-token match, not substring (.head ≠ .header)', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '.head', axis: 'left' } }],
    })
    // Goal contains ".header" but NOT ".head" as a token → must not be accepted.
    const r = await translateGoal({ goal: 'align with .header', selector: '.btn', provider })
    expect(r.ok).toBe(false)
  })

  it('grounds `other` even with trailing prose punctuation', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'bboxMatches', args: { other: '.card' } }],
    })
    const r = await translateGoal({ goal: 'match the size of .card, please', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.predicates[0]).toEqual({ predicate: 'bboxMatches', args: { other: '.card' } })
  })

  it('grounds `other` when the selector ends the sentence (trailing period)', async () => {
    for (const goal of ['align with .header.', 'match .card.']) {
      const other = goal.includes('.header') ? '.header' : '.card'
      const predicate = goal.includes('align') ? 'aligned' : 'bboxMatches'
      const args = predicate === 'aligned' ? { other, axis: 'left' as const } : { other }
      const provider = fakeProvider({ predicates: [{ predicate, args }] })
      const r = await translateGoal({ goal, selector: '.btn', provider })
      expect(r.ok, goal).toBe(true)
    }
  })

  it('drops a hallucinated `other` not named in the goal (→ skip, not wrong-element)', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'aligned', args: { other: '.header', axis: 'left' } }],
    })
    // Goal mentions "the header" in prose but never the selector `.header`.
    const r = await translateGoal({ goal: 'align this with the header', selector: '.btn', provider })
    expect(r.ok).toBe(false) // ungrounded → dropped → no measurable predicate
  })

  it('keeps recognized args and drops unknown ones', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'contrastRatio', args: { min: 7, bogus: 'x', expected: 'kept' } }],
    })
    const r = await translateGoal({ goal: 'AAA contrast', selector: '.t', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // `min` + `expected` are known keys; `bogus` is stripped.
      expect(r.predicates[0].args).toEqual({ min: 7, expected: 'kept' })
    }
  })

  it('drops a two-element predicate missing its secondary selector', async () => {
    const provider = fakeProvider({
      predicates: [
        { predicate: 'aligned', args: { axis: 'left' } }, // no `other` → dropped
        { predicate: 'noOverflow' },
      ],
    })
    const r = await translateGoal({ goal: 'align and fit', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.predicates).toEqual([{ predicate: 'noOverflow', args: {} }])
    }
  })

  it('skips unknown predicate names', async () => {
    const provider = fakeProvider({
      predicates: [{ predicate: 'looksNicer' }, { predicate: 'fitsViewport' }],
    })
    const r = await translateGoal({ goal: 'fit on screen', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.predicates).toEqual([{ predicate: 'fitsViewport', args: {} }])
    }
  })

  it('refuses an aesthetic goal (empty predicate list)', async () => {
    const provider = fakeProvider({ predicates: [] })
    const r = await translateGoal({ goal: 'make it look nicer', selector: '.btn', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/aesthetic|vision judge/i)
  })

  it('refuses when every entry is malformed', async () => {
    const provider = fakeProvider({ predicates: [{ predicate: 'nope' }, { foo: 1 }] })
    const r = await translateGoal({ goal: 'whatever', selector: '.btn', provider })
    expect(r.ok).toBe(false)
  })

  it('refuses an empty goal without calling the model', async () => {
    const provider = fakeProvider({ predicates: [{ predicate: 'noOverflow' }] })
    const r = await translateGoal({ goal: '   ', selector: '.btn', provider })
    expect(r.ok).toBe(false)
    expect((provider.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('drops nonsensical numeric args (negative tol, out-of-range min)', async () => {
    const provider = fakeProvider({
      predicates: [
        { predicate: 'bboxMatches', args: { other: '.x', tol: -5 } },
        { predicate: 'contrastRatio', args: { min: 0.5 } }, // below WCAG floor
        { predicate: 'contrastRatio', args: { min: 100 } }, // above WCAG ceiling
        { predicate: 'contrastRatio', args: { min: 7 } }, // valid AAA → kept
      ],
    })
    // Goal names `.x` verbatim so the secondary selector is grounded.
    const r = await translateGoal({ goal: 'match .x + contrast', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Bad numerics stripped → predicates fall back to safe defaults; valid kept.
      expect(r.predicates[0].args).toEqual({ other: '.x' })
      expect(r.predicates[1].args).toEqual({})
      expect(r.predicates[2].args).toEqual({})
      expect(r.predicates[3].args).toEqual({ min: 7 })
    }
  })

  it('drops a predicate missing a non-selector required arg', async () => {
    const provider = fakeProvider({
      predicates: [
        { predicate: 'aligned', args: { other: '.h' } }, // no axis → dropped
        { predicate: 'textEquals', args: {} }, // no expected → dropped
        { predicate: 'noOverflow' },
      ],
    })
    const r = await translateGoal({ goal: 'mixed', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.predicates).toEqual([{ predicate: 'noOverflow', args: {} }])
  })

  it('reports a refusal distinctly (not a JSON error)', async () => {
    const complete = vi.fn(async (): Promise<CompleteResult> => ({
      text: '',
      parsed: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'refusal',
    }))
    const provider: CompletionProvider = { name: 'fake', defaultModel: 'm', complete }
    const r = await translateGoal({ goal: 'fit', selector: '.btn', provider })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/declined/i)
      expect(r.reason).not.toMatch(/JSON/i)
    }
  })

  it('reports a clean failure on malformed JSON', async () => {
    const r = await translateGoal({ goal: 'fit', selector: '.btn', provider: fakeMalformed() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not valid JSON/)
  })

  it('reports a clean failure when the provider throws', async () => {
    const r = await translateGoal({ goal: 'fit', selector: '.btn', provider: fakeProvider(new Error('boom')) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/LLM call failed: boom/)
  })

  it('does not force a Claude model — leaves model undefined so the provider picks its default', async () => {
    const complete = vi.fn(async (_opts: CompleteOpts): Promise<CompleteResult> => ({
      text: JSON.stringify({ predicates: [{ predicate: 'noOverflow' }] }),
      parsed: { predicates: [{ predicate: 'noOverflow' }] },
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }))
    const provider: CompletionProvider = { name: 'openai', defaultModel: 'gpt-5.2', complete }
    await translateGoal({ goal: 'fit', selector: '.btn', provider })
    // The call must NOT pin a Claude model — the OpenAI provider would reject it.
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0][0].model).toBeUndefined()
  })

  it('does not judge — output carries no pass/fail', async () => {
    const provider = fakeProvider({ predicates: [{ predicate: 'noOverflow' }] })
    const r = await translateGoal({ goal: 'fit', selector: '.btn', provider })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(JSON.stringify(r.predicates)).not.toMatch(/pass|fail/i)
    }
  })
})

describe('the provider comes from the caller, resolved lazily', () => {
  it('uses the injected resolver rather than the process-wide registry', async () => {
    const provider = fakeProvider({ predicates: [{ predicate: 'widthWithin' }] })
    const resolveProvider = vi.fn(() => provider)
    await translateGoal({
      goal: 'make this fit the content width',
      selector: '.card',
      resolveProvider,
    })
    expect(resolveProvider).toHaveBeenCalledTimes(1)
  })

  it('turns a credential failure into a clean refusal, not a throw', async () => {
    // `getProvider()` throws on a missing key, and this lane used to resolve it
    // as a destructuring default, so the throw escaped the try/catch below and
    // reached `verify_goal` as an unhandled error rather than a skip reason.
    const result = await translateGoal({
      goal: 'make this fit',
      selector: '.card',
      resolveProvider: () => {
        throw new Error('Missing OPENAI_API_KEY.')
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('error')
    expect(result.reason).toContain('Missing OPENAI_API_KEY')
  })
})
