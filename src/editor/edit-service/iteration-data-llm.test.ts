/**
 * Colocated tests for the iteration-data LLM lane. The provider is injected
 * so tests return canned JSON without an API call — same pattern as
 * `repair-edit.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyIterationDataLlm } from './iteration-data-llm'
import type { IterationDataIntent } from './iteration-data-prompt'
import type { CompleteResult, CompletionProvider } from '../llm-providers/types'

interface CannedResponse {
  newSource?: string
  explanation?: string
}

function makeFakeProvider(canned: CannedResponse | Error): CompletionProvider {
  const complete = vi.fn(async (): Promise<CompleteResult> => {
    if (canned instanceof Error) throw canned
    const text = JSON.stringify(canned)
    return {
      text,
      parsed: JSON.parse(text),
      stopReason: 'end_turn',
    } as CompleteResult
  })
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    complete,
  }
}

const SOURCE = `<script setup>\nconst rows = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]\n</script>\n<template>\n  <li v-for="r in rows" :key="r.key">{{ r.label }}</li>\n</template>\n`

const INTENT: IterationDataIntent = {
  kind: 'iteration-data',
  description: "Set the text of row \"b\"",
  templateLocation: { file: 'src/List.vue', line: 5, column: 3 },
  iterationContext: { source: 'v-for', key: 'b', index: 1, siblingCount: 2, expression: 'rows' },
  pageSourceFile: null,
  payload: { operation: 'patch-text', value: 'Bee' },
}

describe('applyIterationDataLlm', () => {
  it('returns the proposal with a base hash when the model rewrites the file', async () => {
    const newSource = SOURCE.replace("label: 'B'", "label: 'Bee'")
    const result = await applyIterationDataLlm({
      source: SOURCE,
      file: 'src/List.vue',
      intent: INTENT,
      provider: makeFakeProvider({ newSource, explanation: 'patched row b' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newSource).toContain("label: 'Bee'")
    expect(result.originalSourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.explanation).toBe('patched row b')
  })

  it('refuses an unchanged rewrite, surfacing the model explanation as the reason', async () => {
    const result = await applyIterationDataLlm({
      source: SOURCE,
      file: 'src/List.vue',
      intent: INTENT,
      provider: makeFakeProvider({
        newSource: SOURCE,
        explanation: 'The data array lives in the caller file.',
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('The data array lives in the caller file.')
  })

  it('surfaces a provider failure as a refusal, not a throw', async () => {
    const result = await applyIterationDataLlm({
      source: SOURCE,
      file: 'src/List.vue',
      intent: INTENT,
      provider: makeFakeProvider(new Error('socket hang up')),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('socket hang up')
  })

  it('refuses an empty source without calling the provider', async () => {
    const provider = makeFakeProvider({ newSource: 'x' })
    const result = await applyIterationDataLlm({
      source: '',
      file: 'src/List.vue',
      intent: INTENT,
      provider,
    })
    expect(result.ok).toBe(false)
    expect(provider.complete).not.toHaveBeenCalled()
  })
})
