/**
 * Colocated test for `composeRefusalReason` (src/hooks/iteration-fallback.ts).
 *
 * The most specific reason should win: when the AI fallback lane never ran
 * (`kind: 'unavailable'`), the user needs the deterministic resolver's
 * reason PLUS a sentence saying the AI fallback didn't get a turn. When the
 * AI lane ran and refused (`kind: 'refused'`, or `kind` absent for an older
 * server), its own reason is the whole story.
 */

import { describe, expect, it, vi } from 'vitest'
import { composeRefusalReason, requestIterationProposal } from './iteration-fallback'

const editorFetchMock = vi.fn()
vi.mock('@/lib/editor-fetch', () => ({
  editorFetch: (...args: unknown[]) => editorFetchMock(...args),
}))

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

describe('requestIterationProposal', () => {
  it("surfaces the server's own reason on a non-422 static failure instead of 'HTTP 404' (codex round 4)", async () => {
    editorFetchMock.mockReset()
    editorFetchMock.mockImplementation(async () => ({
      status: 404,
      ok: false,
      json: async () => ({ ok: false, reason: 'Could not read file: ENOENT' }),
    }))
    const result = await requestIterationProposal({
      editKind: 'dom-text',
      templateLocation: { file: 'src/pages/overview.tsx', line: 3, column: 20 },
      iterationContext: { source: 'map', key: 1, index: 0, siblingCount: 1, expression: null },
      pageSourceFile: null,
      payload: { operation: 'patch-text', value: 'x' },
      description: 'Set the text of row 1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('Could not read file: ENOENT')
    expect(editorFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the deterministic reason when the AI lane request itself fails (codex round 1: "Network error" alone)', async () => {
    editorFetchMock.mockReset()
    editorFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/editor/edit-iteration') {
        return { status: 422, ok: false, json: async () => ({ reason: 'METRICS is imported from ../data but is not a plain array' }) }
      }
      throw new Error('socket closed')
    })
    const result = await requestIterationProposal({
      editKind: 'dom-text',
      templateLocation: { file: 'src/pages/overview.tsx', line: 3, column: 20 },
      iterationContext: { source: 'map', key: 1, index: 0, siblingCount: 1, expression: null },
      pageSourceFile: null,
      payload: { operation: 'patch-text', value: 'x' },
      description: 'Set the text of row 1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe(
      'METRICS is imported from ../data but is not a plain array. The AI fallback could not run: Network error: socket closed',
    )
  })

  it("passes the caller's signal to BOTH requests, so a teardown cancels the work and not only the answer", async () => {
    // The client holds the bridge's draft across this whole round trip. When
    // the bridge session ends the proposal is a rewrite for a page that is
    // gone, so the requests have to stop, not just be ignored.
    editorFetchMock.mockReset()
    const seen: Array<AbortSignal | undefined> = []
    editorFetchMock.mockImplementation(async (path: string, init: RequestInit) => {
      seen.push(init.signal ?? undefined)
      if (path === '/api/editor/edit-iteration') {
        return { status: 422, ok: false, json: async () => ({ reason: 'unresolved' }) }
      }
      return { status: 200, ok: true, json: async () => ({ ok: false, reason: 'refused', kind: 'refused' }) }
    })
    const controller = new AbortController()
    await requestIterationProposal({
      editKind: 'dom-text',
      templateLocation: { file: 'src/pages/overview.tsx', line: 3, column: 20 },
      iterationContext: { source: 'map', key: 1, index: 0, siblingCount: 1, expression: null },
      pageSourceFile: null,
      payload: { operation: 'patch-text', value: 'x' },
      description: 'Set the text of row 1',
      signal: controller.signal,
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(controller.signal)
    expect(seen[1]).toBe(controller.signal)
  })

  it('sends no signal at all when the caller has none', async () => {
    editorFetchMock.mockReset()
    const seen: Array<RequestInit> = []
    editorFetchMock.mockImplementation(async (_path: string, init: RequestInit) => {
      seen.push(init)
      return { status: 404, ok: false, json: async () => ({ reason: 'nope' }) }
    })
    await requestIterationProposal({
      editKind: 'dom-text',
      templateLocation: { file: 'src/pages/overview.tsx', line: 3, column: 20 },
      iterationContext: { source: 'map', key: 1, index: 0, siblingCount: 1, expression: null },
      pageSourceFile: null,
      payload: { operation: 'patch-text', value: 'x' },
      description: 'Set the text of row 1',
    })
    expect(seen).toHaveLength(1)
    expect('signal' in seen[0]!).toBe(false)
  })
})
