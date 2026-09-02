/**
 * Every LLM edit lane must turn "no credentials configured" into a refusal it
 * returns, never an exception it throws.
 *
 * The shape that gets this wrong is a parameter default:
 *
 *     provider = getProvider(),
 *
 * `getProvider()` THROWS when no API key is set and the subscription flag is
 * off. A default parameter is evaluated during destructuring, which is before
 * the function body runs, so every `try` inside the function is still ahead of
 * it. The throw escapes the lane entirely, misses the handler's error mapping,
 * and reaches the client as a raw 500 with a stack trace in the response body.
 *
 * MEASURED on the iteration lane before it was fixed. The repair lane had the
 * identical wart and was fixed the same way. Neither had a test, which is why
 * one file covers both: this invariant belongs to the LANE PATTERN, not to
 * either function, and the next lane someone adds should be added here too.
 *
 * These call the real `getProvider()` rather than mocking the registry. The
 * throw is the thing under test, so faking it would only prove the fake works.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyIterationDataLlm, type ApplyIterationDataLlmInput } from './iteration-data-llm'
import { applyRepairEdit, type ApplyRepairEditInput } from './repair-edit'

/**
 * Strip both credential paths so `getProvider()` reaches its throw.
 *
 * `ANTHROPIC_API_KEY` absent alone is not enough: with
 * `EDITOR_USE_CLAUDE_SUBSCRIPTION` on, the registry picks the bundled
 * `claude` binary instead and never throws. Both have to be off, and this
 * machine may well have either one set.
 */
function withNoCredentials(): void {
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('EDITOR_USE_CLAUDE_SUBSCRIPTION', '')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const SOURCE = `<template>\n  <p>hello</p>\n</template>\n`

/**
 * Both inputs are spelled out against their real types, with no cast. The
 * credentials check runs before either lane looks at its intent, so the
 * content here does not matter — but the SHAPE does: a cast would let these
 * drift from the types they claim to exercise, which is how the first draft
 * of this file passed its tests and failed typecheck.
 */
const REPAIR_INPUT: ApplyRepairEditInput = {
  source: SOURCE,
  file: 'src/App.vue',
  intent: { kind: 'unwrap', description: 'Unwrap <KCard>' },
  errorReason: 'the deterministic applicator refused',
}

const ITERATION_INPUT: ApplyIterationDataLlmInput = {
  source: SOURCE,
  file: 'src/App.vue',
  intent: {
    kind: 'iteration-data',
    description: 'Remove the second row',
    templateLocation: { file: 'src/App.vue', line: 2, column: 3 },
    iterationContext: {
      source: 'v-for',
      key: 'b',
      index: 1,
      siblingCount: 3,
      expression: 'items',
    },
    pageSourceFile: null,
    payload: { operation: 'remove' },
  },
}

describe('an LLM edit lane with no credentials configured', () => {
  it('refuses from applyRepairEdit instead of throwing', async () => {
    withNoCredentials()

    // Not `.rejects` — the whole point is that this resolves.
    const result = await applyRepairEdit(REPAIR_INPUT)

    expect(result.ok).toBe(false)
    // The registry's own sentence reaches the caller, so the person is told
    // which variable to set rather than seeing a generic failure.
    expect(result.ok === false && result.reason).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('refuses from applyIterationDataLlm instead of throwing', async () => {
    withNoCredentials()

    const result = await applyIterationDataLlm(ITERATION_INPUT)

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/ANTHROPIC_API_KEY/)
  })
})
