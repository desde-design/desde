/**
 * Tests for `applyLLMPatch`. The LLM provider is injected via the
 * `provider` parameter — the production path defaults to the configured
 * provider, but tests pass a fake that returns canned JSON.
 *
 * One live integration test is gated by `RUN_LIVE_LLM_TESTS=1` —
 * that path requires `ANTHROPIC_API_KEY` to be set and is skipped in
 * normal CI runs.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyLLMPatch, type ProjectStyleContext } from './apply-llm-patch'
import type { Mutation } from '../core/edit'
import type {
  CompleteOpts,
  CompleteResult,
  CompletionProvider,
} from '../llm-providers/types'

interface CannedResponse {
  newSource: string
  perMutationOutcome: Array<{ mutationId: string; outcome: 'applied' | 'skipped' | 'refused'; reason?: string }>
  notes?: string
}

/**
 * Concatenates all text from a user-content payload so file-path
 * detection (`File: \`<path>\``) works regardless of whether the caller
 * passed a string or an array of `ContentBlock`s.
 */
function userText(opts: CompleteOpts): string {
  if (typeof opts.user === 'string') return opts.user
  return opts.user.map((b) => b.text).join('\n')
}

function makeFakeProvider(
  perFileResponses: Map<string, CannedResponse | Error>,
): CompletionProvider {
  const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
    const text = userText(opts)
    const m = /File: `([^`]+)`/.exec(text)
    if (!m) throw new Error('test fake: could not find file path in user content')
    const path = m[1]
    const canned = perFileResponses.get(path)
    if (!canned) throw new Error(`test fake: no canned response for '${path}'`)
    if (canned instanceof Error) throw canned
    const responseText = JSON.stringify(canned)
    return {
      text: responseText,
      parsed: canned,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }
  })
  return { name: 'fake', defaultModel: 'fake-model', complete }
}

function makeMutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: 'm-1',
    kind: 'text',
    sourceLoc: 'src/components/Card.vue:12:4',
    resolutionKind: 'direct',
    scope: 'definition',
    callsiteLoc: null,
    instancePath: '[0]',
    selector: '[data-testid="title"]',
    before: 'Hello',
    after: 'Hi',
    ...overrides,
  }
}

const STYLE_CONTEXT: ProjectStyleContext = {
  tokens: [],
  classTaxonomy: ['btn', 'btn-primary', 'card', 'flex', 'gap-2'],
  preprocessor: 'scss',
}

describe('applyLLMPatch', () => {
  it('returns ok with empty result on empty mutations', async () => {
    const result = await applyLLMPatch({
      files: new Map(),
      mutations: [],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.patchedFiles.size).toBe(0)
      expect(result.perMutationOutcomes).toEqual([])
    }
  })

  it('refuses non-direct resolutionKind', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/Foo.vue', '<template></template>']]),
      mutations: [makeMutation({ resolutionKind: 'ancestor' })],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/resolutionKind='ancestor'/)
    }
  })

  it('refuses missing sourceLoc', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/Foo.vue', '<template></template>']]),
      mutations: [makeMutation({ sourceLoc: null })],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no sourceLoc/)
    }
  })

  it('refuses non-.vue target file', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/styles.scss', '$primary: red;']]),
      mutations: [makeMutation({ sourceLoc: 'src/styles.scss:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/non-\.vue file/)
    }
  })

  it('refuses when sourceLoc file is not in the input files map', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/Other.vue', '<template></template>']]),
      mutations: [makeMutation({ sourceLoc: 'src/Missing.vue:5:5' })],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not in the input files map/)
    }
  })

  it('refuses when per-file mutation count exceeds the cap', async () => {
    // Each mutation gets a distinct sourceLoc so the disambiguation
    // gate doesn't fire first.
    const muts = Array.from({ length: 25 }, (_, i) =>
      makeMutation({ id: `m-${i}`, sourceLoc: `src/Big.vue:${i + 1}:1` }),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/Big.vue', '<template></template>']]),
      mutations: muts,
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
      maxMutationsPerFile: 20,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/cap is 20/)
    }
  })

  it('happy path: single text mutation, one file, returns patched source', async () => {
    const original = '<template>\n  <h1>Hello</h1>\n</template>'
    const patched = '<template>\n  <h1>Hi</h1>\n</template>'
    const provider = makeFakeProvider(
      new Map([
        [
          'src/components/Card.vue',
          {
            newSource: patched,
            perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
          },
        ],
      ]),
    )

    const result = await applyLLMPatch({
      files: new Map([['src/components/Card.vue', original]]),
      mutations: [makeMutation()],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.patchedFiles.get('src/components/Card.vue')).toBe(patched)
      expect(result.perMutationOutcomes).toEqual([
        { mutationId: 'm-1', outcome: 'applied' },
      ])
    }
  })

  it('groups mutations across files and patches each independently', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/A.vue',
          {
            newSource: '<template><a>NEW-A</a></template>',
            perMutationOutcome: [{ mutationId: 'm-A', outcome: 'applied' }],
          },
        ],
        [
          'src/B.vue',
          {
            newSource: '<template><b>NEW-B</b></template>',
            perMutationOutcome: [{ mutationId: 'm-B', outcome: 'applied' }],
          },
        ],
      ]),
    )

    const result = await applyLLMPatch({
      files: new Map([
        ['src/A.vue', '<template><a>OLD-A</a></template>'],
        ['src/B.vue', '<template><b>OLD-B</b></template>'],
      ]),
      mutations: [
        makeMutation({ id: 'm-A', sourceLoc: 'src/A.vue:1:1', before: 'OLD-A', after: 'NEW-A' }),
        makeMutation({ id: 'm-B', sourceLoc: 'src/B.vue:1:1', before: 'OLD-B', after: 'NEW-B' }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.patchedFiles.size).toBe(2)
      expect(result.patchedFiles.get('src/A.vue')).toBe('<template><a>NEW-A</a></template>')
      expect(result.patchedFiles.get('src/B.vue')).toBe('<template><b>NEW-B</b></template>')
    }
  })

  it('rejects when LLM omits an outcome for an input mutation', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/C.vue',
          {
            newSource: '<template></template>',
            // Missing m-2 outcome.
            perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
          },
        ],
      ]),
    )

    const result = await applyLLMPatch({
      files: new Map([['src/C.vue', '<template></template>']]),
      mutations: [
        makeMutation({ id: 'm-1', sourceLoc: 'src/C.vue:1:1' }),
        makeMutation({ id: 'm-2', sourceLoc: 'src/C.vue:2:2' }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/missing outcomes for mutations: m-2/)
    }
  })

  it('rejects when LLM returns invalid JSON', async () => {
    const provider: CompletionProvider = {
      name: 'fake',
      defaultModel: 'fake-model',
      complete: vi.fn(
        async (): Promise<CompleteResult> => ({
          text: '{"malformed": tru',
          parsed: undefined,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        }),
      ),
    }

    const result = await applyLLMPatch({
      files: new Map([['src/D.vue', '<template></template>']]),
      mutations: [makeMutation({ sourceLoc: 'src/D.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not valid JSON/)
    }
  })

  it('rejects when LLM call throws (e.g. rate limit)', async () => {
    const provider = makeFakeProvider(
      new Map([['src/E.vue', new Error('rate_limit_exceeded')]]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/E.vue', '<template></template>']]),
      mutations: [makeMutation({ sourceLoc: 'src/E.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/rate_limit_exceeded/)
    }
  })

  it('hard-refuses class and style mutations in V1', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/F.vue', '<template></template>']]),
      mutations: [makeMutation({ kind: 'class', sourceLoc: 'src/F.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/V1 only patches text and attr/)
    }
  })

  it('refuses unresolved v-for ambiguity (multiple mutations at DIFFERENT instancePaths sharing sourceLoc, no disambiguationChoice)', async () => {
    const result = await applyLLMPatch({
      files: new Map([['src/G.vue', '<template></template>']]),
      mutations: [
        makeMutation({ id: 'm-1', sourceLoc: 'src/G.vue:5:5', instancePath: '[0]' }),
        makeMutation({ id: 'm-2', sourceLoc: 'src/G.vue:5:5', instancePath: '[1]' }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider: makeFakeProvider(new Map()),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/disambiguationChoice/)
    }
  })

  it('accepts multiple mutations sharing sourceLoc AND instancePath (same instance edited twice — not v-for ambiguity)', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/Same.vue',
          {
            newSource: '<template>final</template>',
            perMutationOutcome: [
              { mutationId: 'm-1', outcome: 'applied' },
              { mutationId: 'm-2', outcome: 'applied' },
            ],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/Same.vue', '<template>orig</template>']]),
      mutations: [
        // Same element edited twice across debounce intervals.
        makeMutation({
          id: 'm-1',
          sourceLoc: 'src/Same.vue:1:1',
          instancePath: '[0]',
          before: 'orig',
          after: 'middle',
        }),
        makeMutation({
          id: 'm-2',
          sourceLoc: 'src/Same.vue:1:1',
          instancePath: '[0]',
          before: 'orig',
          after: 'final',
        }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(true)
  })

  it('accepts shared sourceLoc when all mutations carry disambiguationChoice', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/H.vue',
          {
            newSource: 'patched',
            perMutationOutcome: [
              { mutationId: 'm-1', outcome: 'applied' },
              { mutationId: 'm-2', outcome: 'applied' },
            ],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/H.vue', 'orig']]),
      mutations: [
        makeMutation({ id: 'm-1', sourceLoc: 'src/H.vue:5:5', disambiguationChoice: 'this-instance' }),
        makeMutation({ id: 'm-2', sourceLoc: 'src/H.vue:5:5', disambiguationChoice: 'this-instance' }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects when LLM returns newSource as a non-string', async () => {
    const bad = {
      newSource: 12345 as unknown as string,
      perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' as const }],
    }
    const provider: CompletionProvider = {
      name: 'fake',
      defaultModel: 'fake-model',
      complete: vi.fn(
        async (): Promise<CompleteResult> => ({
          text: JSON.stringify(bad),
          parsed: bad,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        }),
      ),
    }
    const result = await applyLLMPatch({
      files: new Map([['src/I.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/I.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/missing newSource string/)
    }
  })

  it('strips markdown code fences from newSource', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/J.vue',
          {
            newSource: '```vue\n<template>patched</template>\n```',
            perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/J.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/J.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.patchedFiles.get('src/J.vue')).toBe('<template>patched</template>')
    }
  })

  it('rejects invalid outcome enum values', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/K.vue',
          {
            newSource: 'orig',
            perMutationOutcome: [
              { mutationId: 'm-1', outcome: 'maybe' as 'applied' },
            ],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/K.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/K.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid outcome='maybe'/)
    }
  })

  it('rejects duplicate outcome rows for the same mutationId', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/L.vue',
          {
            newSource: 'orig',
            perMutationOutcome: [
              { mutationId: 'm-1', outcome: 'applied' },
              { mutationId: 'm-1', outcome: 'applied' },
            ],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/L.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/L.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/duplicate outcome/)
    }
  })

  it('rejects outcome rows with mutationIds not in the input', async () => {
    const provider = makeFakeProvider(
      new Map([
        [
          'src/M.vue',
          {
            newSource: 'orig',
            perMutationOutcome: [
              { mutationId: 'm-1', outcome: 'applied' },
              { mutationId: 'm-extra', outcome: 'applied' },
            ],
          },
        ],
      ]),
    )
    const result = await applyLLMPatch({
      files: new Map([['src/M.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/M.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown mutationId='m-extra'/)
    }
  })

  it('forwards cacheHint=ephemeral on prompt blocks through to the provider (round-trip)', async () => {
    // Prompt builder emits Anthropic-shaped cache_control:ephemeral; the
    // service translates to neutral cacheHint:ephemeral; the Anthropic
    // provider translates back. If any link breaks, prompt caching
    // silently disappears. This test pins the middle hop.
    const canned = {
      newSource: 'orig',
      perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' as const }],
    }
    let capturedOpts: CompleteOpts | undefined
    const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
      capturedOpts = opts
      return {
        text: JSON.stringify(canned),
        parsed: canned,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      }
    })
    const provider: CompletionProvider = { name: 'fake', defaultModel: 'fake-model', complete }
    await applyLLMPatch({
      files: new Map([['src/Cache.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/Cache.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })
    expect(capturedOpts).toBeDefined()
    const systemBlocks = capturedOpts!.system
    const userBlocks = capturedOpts!.user
    expect(Array.isArray(systemBlocks)).toBe(true)
    expect(Array.isArray(userBlocks)).toBe(true)
    // The prompt builder marks SYSTEM and the first two USER blocks
    // (project style + source) as cacheable; the third (per-save
    // mutations) is volatile. We assert at least one block on each side
    // carries the hint — exact count is left to the prompt builder.
    if (!Array.isArray(systemBlocks) || !Array.isArray(userBlocks)) return
    expect(systemBlocks.some((b) => b.cacheHint === 'ephemeral')).toBe(true)
    expect(userBlocks.some((b) => b.cacheHint === 'ephemeral')).toBe(true)
    // And at least one user block is intentionally NOT cached.
    expect(userBlocks.some((b) => b.cacheHint === undefined)).toBe(true)
  })

  it('forwards model and maxTokens parameters to the provider', async () => {
    const canned = {
      newSource: 'orig',
      perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' as const }],
    }
    const complete = vi.fn(async (): Promise<CompleteResult> => ({
      text: JSON.stringify(canned),
      parsed: canned,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }))
    const provider: CompletionProvider = { name: 'fake', defaultModel: 'fake-model', complete }
    await applyLLMPatch({
      files: new Map([['src/N.vue', 'orig']]),
      mutations: [makeMutation({ sourceLoc: 'src/N.vue:1:1' })],
      projectStyleContext: STYLE_CONTEXT,
      provider,
      model: 'claude-sonnet-4-6',
      maxTokens: 4096,
    })
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        responseFormat: expect.objectContaining({ kind: 'json_schema' }),
      }),
    )
  })

  it('does not apply partial patches: any per-file failure aborts the whole bundle', async () => {
    // First file succeeds, second fails — we should NOT see file A in
    // patchedFiles on the failure path (the bundle is atomic).
    const responses = new Map<string, CannedResponse | Error>()
    responses.set('src/A.vue', {
      newSource: '<template><a>NEW-A</a></template>',
      perMutationOutcome: [{ mutationId: 'm-A', outcome: 'applied' }],
    })
    responses.set('src/B.vue', new Error('something broke'))
    const provider = makeFakeProvider(responses)

    const result = await applyLLMPatch({
      files: new Map([
        ['src/A.vue', '<template><a>OLD-A</a></template>'],
        ['src/B.vue', '<template><b>OLD-B</b></template>'],
      ]),
      mutations: [
        makeMutation({ id: 'm-A', sourceLoc: 'src/A.vue:1:1' }),
        makeMutation({ id: 'm-B', sourceLoc: 'src/B.vue:1:1' }),
      ],
      projectStyleContext: STYLE_CONTEXT,
      provider,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Outcomes from file A may be reported (best-effort) but the
      // bundle is not "applied".
      expect(result.reason).toMatch(/something broke/)
    }
  })

  // ─── Phase 2 — Adaptive fan-out by file ─────────────────────────────
  describe('Phase 2 adaptive fan-out', () => {
    /**
     * Provider whose per-file `complete()` resolves only when the test
     * releases its gate, so completion order can be controlled
     * independently of input order (to prove order-stable assembly). Also
     * tracks max concurrent in-flight calls. `streamComplete` records
     * whether it was used (multi-file must NOT stream).
     */
    function makeGatedProvider(opts: {
      files: string[]
      /** Resolve order by file path; defaults to input order. */
      releaseOrder?: string[]
    }) {
      const { files, releaseOrder = opts.files } = opts
      let inFlight = 0
      let maxInFlight = 0
      let streamCalls = 0
      // One deferred per file; resolved in `releaseOrder`.
      const gates = new Map<string, () => void>()
      const ready = new Map<string, Promise<void>>()
      for (const f of files) {
        ready.set(f, new Promise<void>((res) => gates.set(f, res)))
      }

      const respond = (path: string): CompleteResult => {
        const canned: CannedResponse = {
          newSource: `<template>${path}-PATCHED</template>`,
          perMutationOutcome: [{ mutationId: `m-${path}`, outcome: 'applied' }],
        }
        return {
          text: JSON.stringify(canned),
          parsed: canned,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        }
      }

      const fileOf = (o: CompleteOpts): string => {
        const m = /File: `([^`]+)`/.exec(userText(o))
        if (!m) throw new Error('no file path in user content')
        return m[1]
      }

      const complete = vi.fn(async (o: CompleteOpts): Promise<CompleteResult> => {
        const path = fileOf(o)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await ready.get(path)
          return respond(path)
        } finally {
          inFlight--
        }
      })
      const streamComplete = vi.fn(
        async (o: CompleteOpts): Promise<CompleteResult> => {
          streamCalls++
          const path = fileOf(o)
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            await ready.get(path)
            return respond(path)
          } finally {
            inFlight--
          }
        },
      )

      const provider: CompletionProvider = {
        name: 'gated',
        defaultModel: 'fake-model',
        complete,
        streamComplete,
      }

      // Release all gates in the configured order on the next microtasks.
      const releaseAll = async () => {
        for (const f of releaseOrder) {
          gates.get(f)!()
          // Yield so the released file can progress before the next.
          await Promise.resolve()
        }
      }

      return {
        provider,
        releaseAll,
        getMaxInFlight: () => maxInFlight,
        getStreamCalls: () => streamCalls,
      }
    }

    function mkFile(path: string): { file: string; source: string; mut: Mutation } {
      return {
        file: path,
        source: `<template>${path}-ORIG</template>`,
        mut: makeMutation({ id: `m-${path}`, sourceLoc: `${path}:1:1` }),
      }
    }

    it('reassembles multi-file outcomes in input order even when calls finish out of order', async () => {
      const a = mkFile('src/A.vue')
      const b = mkFile('src/B.vue')
      const c = mkFile('src/C.vue')
      // Finish C, then A, then B — deliberately NOT input order.
      const gp = makeGatedProvider({
        files: ['src/A.vue', 'src/B.vue', 'src/C.vue'],
        releaseOrder: ['src/C.vue', 'src/A.vue', 'src/B.vue'],
      })
      const p = applyLLMPatch({
        files: new Map([
          [a.file, a.source],
          [b.file, b.source],
          [c.file, c.source],
        ]),
        mutations: [a.mut, b.mut, c.mut],
        projectStyleContext: STYLE_CONTEXT,
        provider: gp.provider,
      })
      await gp.releaseAll()
      const result = await p
      expect(result.ok).toBe(true)
      if (result.ok) {
        // Map + outcomes assembled in byFile insertion (= mutation) order.
        expect(Array.from(result.patchedFiles.keys())).toEqual([
          'src/A.vue',
          'src/B.vue',
          'src/C.vue',
        ])
        expect(result.perMutationOutcomes.map((o) => o.mutationId)).toEqual([
          'm-src/A.vue',
          'm-src/B.vue',
          'm-src/C.vue',
        ])
      }
    })

    it('respects the concurrency cap (never more than maxConcurrency in flight)', async () => {
      const paths = ['src/A.vue', 'src/B.vue', 'src/C.vue', 'src/D.vue', 'src/E.vue']
      const entries = paths.map(mkFile)
      const gp = makeGatedProvider({ files: paths })
      const p = applyLLMPatch({
        files: new Map(entries.map((e) => [e.file, e.source])),
        mutations: entries.map((e) => e.mut),
        projectStyleContext: STYLE_CONTEXT,
        provider: gp.provider,
        maxConcurrency: 2,
      })
      // Let the pool fill before releasing any gate.
      await Promise.resolve()
      await Promise.resolve()
      expect(gp.getMaxInFlight()).toBeLessThanOrEqual(2)
      await gp.releaseAll()
      const result = await p
      expect(result.ok).toBe(true)
      // With 5 files and a cap of 2, the pool actually saturates the cap.
      expect(gp.getMaxInFlight()).toBe(2)
    })

    it('disables per-token streaming for multi-file bundles (uses complete, emits a coarse status)', async () => {
      const a = mkFile('src/A.vue')
      const b = mkFile('src/B.vue')
      const gp = makeGatedProvider({ files: ['src/A.vue', 'src/B.vue'] })
      const deltas: string[] = []
      const p = applyLLMPatch({
        files: new Map([
          [a.file, a.source],
          [b.file, b.source],
        ]),
        mutations: [a.mut, b.mut],
        projectStyleContext: STYLE_CONTEXT,
        provider: gp.provider,
        onTextDelta: (d) => deltas.push(d),
      })
      await gp.releaseAll()
      const result = await p
      expect(result.ok).toBe(true)
      // streamComplete must NOT be called for a multi-file bundle.
      expect(gp.getStreamCalls()).toBe(0)
      // A single coarse status is emitted; no per-file `--- file ---`
      // markers (those interleave under concurrency).
      expect(deltas.join('')).toContain('Applying 2 files…')
      expect(deltas.join('')).not.toContain('--- src/A.vue ---')
    })

    it('single-file bundle still streams per-token with the file marker (byte-identical path)', async () => {
      const a = mkFile('src/Solo.vue')
      const gp = makeGatedProvider({ files: ['src/Solo.vue'] })
      const deltas: string[] = []
      const p = applyLLMPatch({
        files: new Map([[a.file, a.source]]),
        mutations: [a.mut],
        projectStyleContext: STYLE_CONTEXT,
        provider: gp.provider,
        onTextDelta: (d) => deltas.push(d),
      })
      await gp.releaseAll()
      const result = await p
      expect(result.ok).toBe(true)
      // Single-file uses the streaming path + the per-file marker.
      expect(gp.getStreamCalls()).toBe(1)
      expect(deltas.join('')).toContain('--- src/Solo.vue ---')
      expect(deltas.join('')).not.toContain('Applying')
    })

    it('multi-file fail-fast: stops scheduling new files after one fails (no wasted LLM calls)', async () => {
      // cap=1 makes scheduling deterministic: A is pulled first, fails,
      // and B/C must never be requested. Track which files `complete`
      // was called for.
      const calledFor: string[] = []
      const complete = vi.fn(async (o: CompleteOpts): Promise<CompleteResult> => {
        const m = /File: `([^`]+)`/.exec(userText(o))
        const path = m![1]
        calledFor.push(path)
        if (path === 'src/A.vue') throw new Error('A broke')
        const canned: CannedResponse = {
          newSource: 'patched',
          perMutationOutcome: [{ mutationId: `m-${path}`, outcome: 'applied' }],
        }
        return {
          text: JSON.stringify(canned),
          parsed: canned,
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        }
      })
      const provider: CompletionProvider = {
        name: 'fake',
        defaultModel: 'fake-model',
        complete,
      }
      const result = await applyLLMPatch({
        files: new Map([
          ['src/A.vue', 'a'],
          ['src/B.vue', 'b'],
          ['src/C.vue', 'c'],
        ]),
        mutations: [
          makeMutation({ id: 'm-src/A.vue', sourceLoc: 'src/A.vue:1:1' }),
          makeMutation({ id: 'm-src/B.vue', sourceLoc: 'src/B.vue:1:1' }),
          makeMutation({ id: 'm-src/C.vue', sourceLoc: 'src/C.vue:1:1' }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
        maxConcurrency: 1,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/A broke/)
      // B and C must NOT have been requested.
      expect(calledFor).toEqual(['src/A.vue'])
    })

    it('multi-file: first failure in input order rejects the whole bundle atomically', async () => {
      const a = mkFile('src/A.vue')
      const responses = new Map<string, CannedResponse | Error>()
      responses.set('src/A.vue', {
        newSource: '<template>A-OK</template>',
        perMutationOutcome: [{ mutationId: 'm-src/A.vue', outcome: 'applied' }],
      })
      responses.set('src/Z.vue', new Error('z broke'))
      const provider = makeFakeProvider(responses)
      const result = await applyLLMPatch({
        files: new Map([
          ['src/A.vue', '<template>A-ORIG</template>'],
          ['src/Z.vue', '<template>Z-ORIG</template>'],
        ]),
        mutations: [
          a.mut,
          makeMutation({ id: 'm-src/Z.vue', sourceLoc: 'src/Z.vue:1:1' }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/z broke/)
      }
    })
  })

  // ─── Phase E — Cross-file 'this-instance' edits ─────────────────────
  describe('Phase E cross-file routing', () => {
    it("routes 'callsite' + 'this-instance' mutations to callsiteLoc's file, not sourceLoc's", async () => {
      // Designer edits a button INSIDE UiButton; chooses "this instance"
      // → patch should land in the parent SFC at callsiteLoc, not in
      // UiButton.vue. Provide ONLY the parent in `files`; if the
      // service tried to patch UiButton.vue it would fail with
      // "not in input files map".
      const provider = makeFakeProvider(
        new Map([
          [
            'src/pages/Catalog.vue',
            {
              newSource: '<template><UiButton variant="danger">Save</UiButton></template>',
              perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
            },
          ],
        ]),
      )
      const result = await applyLLMPatch({
        files: new Map([
          ['src/pages/Catalog.vue', '<template><UiButton variant="primary">Save</UiButton></template>'],
        ]),
        mutations: [
          makeMutation({
            id: 'm-1',
            kind: 'attr',
            sourceLoc: 'node_modules/@acme/design-system/UiButton.vue:5:7',
            scope: 'callsite',
            callsiteLoc: 'src/pages/Catalog.vue:1:11',
            disambiguationChoice: 'this-instance',
            target: 'variant',
            before: 'primary',
            after: 'danger',
          }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        // The patch went to the parent SFC (Catalog.vue), not the host
        // (UiButton.vue). The host file isn't even in the input map.
        expect(Array.from(result.patchedFiles.keys())).toEqual([
          'src/pages/Catalog.vue',
        ])
      }
    })

    it("routes 'callsite' + 'all-instances' mutations to sourceLoc's file (host SFC)", async () => {
      // 'all-instances' means edit the component definition. The host
      // SFC is the patch target, same as scope='definition'.
      const provider = makeFakeProvider(
        new Map([
          [
            'src/components/MyButton.vue',
            {
              newSource: '<template><button>Save</button></template>',
              perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
            },
          ],
        ]),
      )
      const result = await applyLLMPatch({
        files: new Map([
          ['src/components/MyButton.vue', '<template><button>Submit</button></template>'],
        ]),
        mutations: [
          makeMutation({
            id: 'm-1',
            kind: 'text',
            sourceLoc: 'src/components/MyButton.vue:1:11',
            scope: 'callsite',
            callsiteLoc: 'src/pages/Form.vue:5:1',
            disambiguationChoice: 'all-instances',
            before: 'Submit',
            after: 'Save',
          }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(Array.from(result.patchedFiles.keys())).toEqual([
          'src/components/MyButton.vue',
        ])
      }
    })

    it('refuses cross-file mutation with malformed callsiteLoc', async () => {
      const result = await applyLLMPatch({
        files: new Map([['src/pages/X.vue', 'orig']]),
        mutations: [
          makeMutation({
            id: 'm-1',
            scope: 'callsite',
            callsiteLoc: 'no-colons-here',
            disambiguationChoice: 'this-instance',
          }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider: makeFakeProvider(new Map()),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/malformed callsiteLoc/)
      }
    })

    it('does NOT trigger v-for ambiguity guard for cross-file mutations even when sourceLocs collide', async () => {
      // Two cards in a v-for, both edited with 'this-instance'. They
      // share sourceLoc (both rendered from the same UiCard internal)
      // but route to different patch sites in the parent SFC. The
      // ambiguity guard should NOT fire — they're not patching the
      // host template at all.
      const provider = makeFakeProvider(
        new Map([
          [
            'src/pages/Catalog.vue',
            {
              newSource: 'patched',
              perMutationOutcome: [
                { mutationId: 'm-1', outcome: 'applied' },
                { mutationId: 'm-2', outcome: 'applied' },
              ],
            },
          ],
        ]),
      )
      const result = await applyLLMPatch({
        files: new Map([['src/pages/Catalog.vue', 'orig']]),
        mutations: [
          makeMutation({
            id: 'm-1',
            sourceLoc: 'node_modules/@acme/design-system/UiCard.vue:3:3',
            instancePath: '[0]',
            scope: 'callsite',
            callsiteLoc: 'src/pages/Catalog.vue:5:5',
            disambiguationChoice: 'this-instance',
          }),
          makeMutation({
            id: 'm-2',
            sourceLoc: 'node_modules/@acme/design-system/UiCard.vue:3:3',
            instancePath: '[1]',
            scope: 'callsite',
            callsiteLoc: 'src/pages/Catalog.vue:5:5',
            disambiguationChoice: 'this-instance',
          }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
      })
      // Both mutations route to Catalog.vue; the ambiguity guard sees
      // the byLoc bucket is empty for the host (UiCard) so it doesn't
      // fire. The save proceeds.
      expect(result.ok).toBe(true)
    })

    it("treats 'callsite' + this-instance with null callsiteLoc as host-template (degenerate fallback)", async () => {
      // If the bridge somehow set this-instance without populating
      // callsiteLoc, the cross-file path can't activate. patchFileFor
      // falls back to sourceLoc's file. This shouldn't normally happen
      // (the panel only allows the toggle when callsiteLoc is set) but
      // we guard against it.
      const provider = makeFakeProvider(
        new Map([
          [
            'src/components/Foo.vue',
            {
              newSource: 'patched',
              perMutationOutcome: [{ mutationId: 'm-1', outcome: 'applied' }],
            },
          ],
        ]),
      )
      const result = await applyLLMPatch({
        files: new Map([['src/components/Foo.vue', 'orig']]),
        mutations: [
          makeMutation({
            id: 'm-1',
            sourceLoc: 'src/components/Foo.vue:1:1',
            scope: 'callsite',
            callsiteLoc: null,
            disambiguationChoice: 'this-instance',
          }),
        ],
        projectStyleContext: STYLE_CONTEXT,
        provider,
      })
      expect(result.ok).toBe(true)
    })
  })
})
