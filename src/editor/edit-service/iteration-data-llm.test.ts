/**
 * Colocated tests for the iteration-data LLM lane. The provider is injected
 * so tests return canned JSON without an API call — same pattern as
 * `apply-llm-patch.test.ts`.
 *
 * As of 2026-09-08 this lane takes a BUNDLE (`files: [{ path, source }]`,
 * loop file first, then page file, then the import chain) instead of a
 * single `source`/`file` pair, and the model must name exactly one bundled
 * file in its response.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { applyIterationDataLlm } from './iteration-data-llm'
import type { IterationDataIntent, IterationDataPromptFile } from './iteration-data-prompt'
import type { CompleteResult, CompletionProvider } from '../llm-providers/types'

interface CannedResponse {
  file?: string
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

function sha256(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex')
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

const SINGLE_FILE_BUNDLE: IterationDataPromptFile[] = [{ path: 'src/List.vue', source: SOURCE }]

describe('applyIterationDataLlm', () => {
  it('returns the proposal with a base hash when the model rewrites the file', async () => {
    const newSource = SOURCE.replace("label: 'B'", "label: 'Bee'")
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider({ file: 'src/List.vue', newSource, explanation: 'patched row b' }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe('src/List.vue')
    expect(result.newSource).toContain("label: 'Bee'")
    expect(result.originalSourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.explanation).toBe('patched row b')
  })

  it('refuses an unchanged rewrite, surfacing the model explanation as the reason', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider({
        file: 'src/List.vue',
        newSource: SOURCE,
        explanation: 'The data array lives in the caller file.',
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('The data array lives in the caller file.')
    expect(result.kind).toBe('refused')
  })

  it('surfaces a provider failure as a refusal, not a throw', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider(new Error('socket hang up')),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('socket hang up')
    expect(result.kind).toBe('unavailable')
  })

  it('refuses an empty source without calling the provider', async () => {
    const provider = makeFakeProvider({ file: 'src/List.vue', newSource: 'x' })
    const result = await applyIterationDataLlm({
      files: [{ path: 'src/List.vue', source: '' }],
      intent: INTENT,
      provider,
    })
    expect(result.ok).toBe(false)
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('rewrites the correct bundled file when the model names the data file, not the loop file', async () => {
    const loopSource = `export function List() {\n  return items.map((item) => <li key={item.key}>{item.label}</li>)\n}\n`
    const dataSource = `export const items = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]\n`
    const newDataSource = dataSource.replace("label: 'B'", "label: 'Bee'")
    const files: IterationDataPromptFile[] = [
      { path: 'src/List.tsx', source: loopSource },
      { path: 'src/data.ts', source: dataSource },
    ]
    const result = await applyIterationDataLlm({
      files,
      intent: INTENT,
      provider: makeFakeProvider({
        file: 'src/data.ts',
        newSource: newDataSource,
        explanation: 'patched row b in the data module',
      }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toBe('src/data.ts')
    expect(result.newSource).toBe(newDataSource)
    // The hash must be of the DATA file's original source, not the loop file's.
    expect(result.originalSourceHash).toBe(sha256(dataSource))
    expect(result.originalSourceHash).not.toBe(sha256(loopSource))
  })

  it('refuses when the model names a file that was not in the bundle', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider({
        file: 'src/secrets.ts',
        newSource: 'export const secrets = []\n',
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')
    expect(result.reason).toContain('src/secrets.ts')
    expect(result.reason).toContain('not given')
  })

  it('refuses when the model omits the file field', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider({ newSource: 'some new source' }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')
  })

  it('refuses when the model returns the named file unchanged, using the explanation as the reason', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider({
        file: 'src/List.vue',
        newSource: SOURCE,
        explanation: 'The array literal is not in any bundled file.',
      }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')
    expect(result.reason).toBe('The array literal is not in any bundled file.')
  })

  it('reports kind "unavailable" when the provider throws', async () => {
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      provider: makeFakeProvider(new Error('ECONNRESET')),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
  })

  it('reports kind "unavailable" and never calls the provider when resolveProvider throws', async () => {
    const provider = makeFakeProvider({ file: 'src/List.vue', newSource: 'x' })
    const resolveProvider = vi.fn(() => {
      throw new Error('No API key configured')
    })
    const result = await applyIterationDataLlm({
      files: SINGLE_FILE_BUNDLE,
      intent: INTENT,
      resolveProvider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('unavailable')
    expect(result.reason).toContain('No API key configured')
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('refuses an empty bundle without calling the provider', async () => {
    const provider = makeFakeProvider({ file: 'src/List.vue', newSource: 'x' })
    const result = await applyIterationDataLlm({
      files: [],
      intent: INTENT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('refused')
    expect(provider.complete).not.toHaveBeenCalled()
  })

  it('builds a prompt that lists every bundled file and covers both frameworks in the system prompt', async () => {
    const loopSource = `export function List() {\n  return items.map((item) => <li key={item.key}>{item.label}</li>)\n}\n`
    const dataSource = `export const items = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]\n`
    const files: IterationDataPromptFile[] = [
      { path: 'src/List.tsx', source: loopSource },
      { path: 'src/data.ts', source: dataSource },
    ]
    const provider = makeFakeProvider({ file: 'src/data.ts', newSource: dataSource })
    await applyIterationDataLlm({ files, intent: INTENT, provider })

    expect(provider.complete).toHaveBeenCalledTimes(1)
    const call = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      system: string
      user: string
    }
    expect(call.user).toContain('--- File: src/List.tsx ---')
    expect(call.user).toContain('--- File: src/data.ts ---')
    expect(call.user).toMatch(/Files you may rewrite.*src\/List\.tsx.*src\/data\.ts/)
    expect(call.system).toContain('v-for')
    expect(call.system).toContain('.map(')
  })
})
