/**
 * Tests for `applyRepairEdit` — Tier 2 LLM-assisted repair. An LLM
 * provider is injected so tests return canned JSON without an API call.
 * Same pattern as `apply-llm-patch.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyRepairEdit } from './repair-edit'
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
      parsed: canned,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }
  })
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    complete,
  }
}

function fakeMalformedJson(): CompletionProvider {
  const complete = vi.fn(
    async (): Promise<CompleteResult> => ({
      text: 'this is not json',
      parsed: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }),
  )
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    complete,
  }
}

const SAMPLE_SOURCE = `<template>
  <section>
    <template v-if="multi">
      <div v-for="x in xs" :key="x">{{ x }}</div>
    </template>
    <template v-else>
      <p>single</p>
    </template>
  </section>
</template>
`

const REPAIRED_SOURCE = `<template>
  <section>
    <div v-for="x in xs" :key="x">{{ x }}</div>
  </section>
</template>
`

describe('applyRepairEdit — happy path', () => {
  it('returns the new source when the LLM produces a valid rewrite', async () => {
    const provider = makeFakeProvider({
      newSource: REPAIRED_SOURCE,
      explanation: 'Dissolved the multi/else conditional, keeping the v-if branch.',
    })
    const result = await applyRepairEdit({
      source: SAMPLE_SOURCE,
      file: 'src/views/Demo.vue',
      intent: {
        kind: 'unwrap',
        description: 'Unwrap <template v-if="multi">',
        sourceLine: 3,
        sourceColumn: 5,
      },
      errorReason: 'v-else has no adjacent v-if',
      provider,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.newSource).toBe(REPAIRED_SOURCE)
    expect(result.explanation).toMatch(/conditional/i)
    // SHA-256 hex is 64 chars; the hash of SAMPLE_SOURCE must be
    // deterministic.
    expect(result.originalSourceHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('applyRepairEdit — refusals', () => {
  it('refuses when the LLM returns the original source unchanged (no-op)', async () => {
    const provider = makeFakeProvider({
      newSource: SAMPLE_SOURCE,
      explanation: 'Could not repair without rewriting <script setup>.',
    })
    const result = await applyRepairEdit({
      source: SAMPLE_SOURCE,
      file: 'src/views/Demo.vue',
      intent: { kind: 'unwrap', description: 'Unwrap something' },
      errorReason: 'compile failed',
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unchanged|no repair/i)
  })

  it('refuses when LLM omits newSource', async () => {
    const provider = makeFakeProvider({ explanation: 'no source returned' })
    const result = await applyRepairEdit({
      source: SAMPLE_SOURCE,
      file: 'src/views/Demo.vue',
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'x',
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/newSource/i)
  })

  it('refuses when LLM returns malformed JSON', async () => {
    const provider = fakeMalformedJson()
    const result = await applyRepairEdit({
      source: SAMPLE_SOURCE,
      file: 'src/views/Demo.vue',
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'x',
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid JSON/i)
  })

  it('refuses when the API call throws', async () => {
    const provider = makeFakeProvider(new Error('rate limit'))
    const result = await applyRepairEdit({
      source: SAMPLE_SOURCE,
      file: 'src/views/Demo.vue',
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'x',
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/rate limit/i)
  })

  it('refuses when given empty source', async () => {
    const provider = makeFakeProvider({ newSource: 'whatever' })
    const result = await applyRepairEdit({
      source: '',
      file: 'src/views/Demo.vue',
      intent: { kind: 'unwrap', description: 'Unwrap' },
      errorReason: 'x',
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/empty/i)
  })
})
