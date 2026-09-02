import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generateLlmHintsForComponent,
  isAllowedSelector,
  resolveDistExcerpt,
  runLlmHintsLane,
  validateLlmHints,
  HINTS_SCHEMA,
} from './llm-generate-hints'
import type { ComponentManifest, ComponentPropManifest } from '../core/manifest'
import type { CompleteOpts, CompleteResult, CompletionProvider } from '../llm-providers/types'
import type { ProbeFn } from './derive-hints'
import type { ProbeObservation } from './probe-driver'

function prop(over: Partial<ComponentPropManifest> = {}): ComponentPropManifest {
  return {
    name: 'label',
    type: 'string',
    required: false,
    control: { kind: 'text' },
    ...over,
  }
}

function manifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: 'acme-ds:UiButton',
    name: 'UiButton',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    props: [prop()],
    ...over,
  }
}

function makeFakeProvider(
  respond: (opts: CompleteOpts) => CompleteResult | Error,
): CompletionProvider {
  const complete = vi.fn(async (opts: CompleteOpts): Promise<CompleteResult> => {
    const r = respond(opts)
    if (r instanceof Error) throw r
    return r
  })
  return { name: 'fake', defaultModel: 'fake-default-model', complete }
}

function jsonResult(hints: unknown[]): CompleteResult {
  const body = { hints }
  return {
    text: JSON.stringify(body),
    parsed: body,
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
  }
}

describe('validateLlmHints', () => {
  it('accepts a well-formed textContent hint on a known prop, stamping generated/unverified', () => {
    const m = manifest({ props: [prop({ name: 'label' })] })
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }],
      m,
    )
    expect(out).toEqual([
      {
        kind: 'dom',
        source: { kind: 'prop', name: 'label' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'literal',
        provenance: 'generated',
        verified: false,
      },
    ])
  })

  it('rejects a hint whose source.name is not in the manifest props (drops just that one)', () => {
    const m = manifest({ props: [prop({ name: 'label' })] })
    const out = validateLlmHints(
      [
        { source: { kind: 'prop', name: 'notAProp' }, domTarget: { selector: ':root', field: 'textContent' } },
        { source: { kind: 'prop', name: 'label' }, domTarget: { selector: '.title', field: 'textContent' } },
      ],
      m,
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toEqual({ kind: 'prop', name: 'label' })
  })

  it('rejects a slot hint whose name is not in manifest.slots', () => {
    const m = manifest({ slots: [{ name: 'default' }] })
    const out = validateLlmHints(
      [{ source: { kind: 'slot', name: 'header' }, domTarget: { selector: ':root', field: 'textContent' } }],
      m,
    )
    expect(out).toEqual([])
  })

  it('accepts a known slot name', () => {
    const m = manifest({ props: [], slots: [{ name: 'default' }] })
    const out = validateLlmHints(
      [{ source: { kind: 'slot', name: 'default' }, domTarget: { selector: ':root', field: 'textContent' } }],
      m,
    )
    expect(out).toHaveLength(1)
  })

  it('rejects a selector containing a comma (combined selector)', () => {
    const m = manifest()
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: '.a, .b', field: 'textContent' } }],
      m,
    )
    expect(out).toEqual([])
  })

  it('rejects a selector with a pseudo-class other than :root', () => {
    const m = manifest()
    const out = validateLlmHints(
      [
        {
          source: { kind: 'prop', name: 'label' },
          domTarget: { selector: '.title:first-child', field: 'textContent' },
        },
      ],
      m,
    )
    expect(out).toEqual([])
  })

  it('accepts :root as a selector', () => {
    const m = manifest()
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'attribute', attribute: 'title' } }],
      m,
    )
    expect(out).toHaveLength(1)
  })

  it('rejects sibling combinators (+ and ~)', () => {
    const m = manifest()
    expect(
      validateLlmHints(
        [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: '.a + .b', field: 'textContent' } }],
        m,
      ),
    ).toEqual([])
    expect(
      validateLlmHints(
        [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: '.a ~ .b', field: 'textContent' } }],
        m,
      ),
    ).toEqual([])
  })

  it('rejects an overlong selector (>200 chars)', () => {
    const m = manifest()
    const longSelector = '.' + 'a'.repeat(201)
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: longSelector, field: 'textContent' } }],
      m,
    )
    expect(out).toEqual([])
  })

  it('rejects field=attribute with no attribute name', () => {
    const m = manifest()
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'attribute' } }],
      m,
    )
    expect(out).toEqual([])
  })

  it('rejects an invalid field enum value', () => {
    const m = manifest()
    const out = validateLlmHints(
      [{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'outerHTML' } }],
      m,
    )
    expect(out).toEqual([])
  })

  it('rejects non-array input and malformed items gracefully', () => {
    const m = manifest()
    expect(validateLlmHints('not-an-array', m)).toEqual([])
    expect(validateLlmHints([null, 42, 'x', {}], m)).toEqual([])
  })
})

describe('isAllowedSelector', () => {
  it('allows plain descendant/child selectors and :root', () => {
    expect(isAllowedSelector(':root')).toBe(true)
    expect(isAllowedSelector('.foo .bar')).toBe(true)
    expect(isAllowedSelector('.foo > .bar')).toBe(true)
  })
  it('rejects non-string, empty, comma, pseudo-class, and combinators', () => {
    expect(isAllowedSelector(42)).toBe(false)
    expect(isAllowedSelector('')).toBe(false)
    expect(isAllowedSelector('.a, .b')).toBe(false)
    expect(isAllowedSelector('.a:hover')).toBe(false)
    expect(isAllowedSelector('.a + .b')).toBe(false)
  })
})

describe('generateLlmHintsForComponent', () => {
  it('calls provider.complete with the json_schema response format and returns validated hints', async () => {
    let captured: CompleteOpts | undefined
    const provider = makeFakeProvider((opts) => {
      captured = opts
      return jsonResult([
        { source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } },
      ])
    })
    const result = await generateLlmHintsForComponent({ manifest: manifest(), provider })
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([
      {
        kind: 'dom',
        source: { kind: 'prop', name: 'label' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'literal',
        provenance: 'generated',
        verified: false,
      },
    ])
    expect(captured?.responseFormat).toEqual({ kind: 'json_schema', schema: HINTS_SCHEMA })
    expect(captured?.model).toBe('fake-default-model')
  })

  it('defaults the model to provider.defaultModel when no model is passed', async () => {
    const provider = makeFakeProvider(() => jsonResult([]))
    await generateLlmHintsForComponent({ manifest: manifest(), provider })
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'fake-default-model' }))
  })

  it('honors an explicit model override', async () => {
    const provider = makeFakeProvider(() => jsonResult([]))
    await generateLlmHintsForComponent({ manifest: manifest(), provider, model: 'claude-explicit' })
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-explicit' }))
  })

  it('resolves to ok:false when the provider throws', async () => {
    const provider = makeFakeProvider(() => new Error('network blew up'))
    const result = await generateLlmHintsForComponent({ manifest: manifest(), provider })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/network blew up/)
    expect(result.hints).toEqual([])
  })

  it('resolves to ok:false when the response is not valid JSON', async () => {
    const provider = makeFakeProvider(() => ({
      text: 'not json',
      parsed: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }))
    const result = await generateLlmHintsForComponent({ manifest: manifest(), provider })
    expect(result.ok).toBe(false)
    expect(result.hints).toEqual([])
  })

  it('resolves to ok:true with empty hints when the model legitimately found nothing', async () => {
    const provider = makeFakeProvider(() => jsonResult([]))
    const result = await generateLlmHintsForComponent({ manifest: manifest(), provider })
    expect(result.ok).toBe(true)
    expect(result.hints).toEqual([])
  })

  it('includes the dist source excerpt in the user prompt when provided', async () => {
    let captured: CompleteOpts | undefined
    const provider = makeFakeProvider((opts) => {
      captured = opts
      return jsonResult([])
    })
    await generateLlmHintsForComponent({
      manifest: manifest(),
      provider,
      distSourceExcerpt: 'export default { template: "<button>{{ label }}</button>" }',
    })
    const userText = typeof captured!.user === 'string' ? captured!.user : captured!.user.map((b) => b.text).join('\n')
    expect(userText).toContain('<button>{{ label }}</button>')
  })
})

describe('resolveDistExcerpt', () => {
  let dir: string
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'dist-excerpt-'))
    return dir
  }
  const teardown = () => rmSync(dir, { recursive: true, force: true })

  it('finds a component file under dist/ by exact basename match and truncates to maxBytes', () => {
    setup()
    try {
      mkdirSync(join(dir, 'dist', 'components'), { recursive: true })
      const content = 'x'.repeat(20)
      writeFileSync(join(dir, 'dist', 'components', 'UiButton.mjs'), content)
      const out = resolveDistExcerpt(dir, 'UiButton', 10)
      expect(out).toBe('x'.repeat(10))
    } finally {
      teardown()
    }
  })

  it('falls back to the whole packageRoot when dist/ has no match', () => {
    setup()
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'UiButton.vue'), '<template>hi</template>')
      const out = resolveDistExcerpt(dir, 'UiButton')
      expect(out).toBe('<template>hi</template>')
    } finally {
      teardown()
    }
  })

  it('returns undefined when nothing matches (best-effort, never throws)', () => {
    setup()
    try {
      const out = resolveDistExcerpt(dir, 'NoSuchComponent')
      expect(out).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('returns undefined for a nonexistent packageRoot', () => {
    const out = resolveDistExcerpt(join(tmpdir(), 'does-not-exist-xyz'), 'UiButton')
    expect(out).toBeUndefined()
  })
})

describe('runLlmHintsLane', () => {
  it('generates hints for every target under the concurrency cap', async () => {
    const targets = [manifest({ name: 'A' }), manifest({ name: 'B' }), manifest({ name: 'C' })]
    const provider = makeFakeProvider(() =>
      jsonResult([{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }]),
    )
    const result = await runLlmHintsLane({ targets, mountable: new Set(), provider })
    expect(Object.keys(result.hints).sort()).toEqual(['A', 'B', 'C'])
    expect(result.skipped).toEqual([])
  })

  it('never exceeds maxConcurrency concurrent provider calls', async () => {
    const targets = Array.from({ length: 8 }, (_, i) => manifest({ name: `C${i}` }))
    let concurrent = 0
    let maxSeen = 0
    const complete = vi.fn(async (): Promise<CompleteResult> => {
      concurrent++
      maxSeen = Math.max(maxSeen, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return jsonResult([])
    })
    const provider: CompletionProvider = { name: 'fake', defaultModel: 'm', complete }
    await runLlmHintsLane({ targets, mountable: new Set(), provider, maxConcurrency: 3 })
    expect(maxSeen).toBeLessThanOrEqual(3)
  })

  it('caps at maxComponents, skipping the excess with reason "llm budget" and never calling the provider for them', async () => {
    const targets = Array.from({ length: 5 }, (_, i) => manifest({ name: `C${i}` }))
    const provider = makeFakeProvider(() => jsonResult([]))
    const result = await runLlmHintsLane({ targets, mountable: new Set(), provider, maxComponents: 2 })
    const budgetSkips = result.skipped.filter((s) => s.reason === 'llm budget')
    expect(budgetSkips.map((s) => s.name).sort()).toEqual(['C2', 'C3', 'C4'])
    expect(provider.complete).toHaveBeenCalledTimes(2)
  })

  it('defaults maxComponents to 100 when not specified', async () => {
    const targets = Array.from({ length: 3 }, (_, i) => manifest({ name: `C${i}` }))
    const provider = makeFakeProvider(() => jsonResult([]))
    const result = await runLlmHintsLane({ targets, mountable: new Set(), provider })
    expect(result.skipped.some((s) => s.reason === 'llm budget')).toBe(false)
  })

  it('flips verified:true when a probe-verify mount confirms the CLAIMED selector+field for a mountable component', async () => {
    const target = manifest({ name: 'UiButton' })
    const provider = makeFakeProvider(() =>
      jsonResult([{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }]),
    )
    const probe: ProbeFn = vi.fn(async (): Promise<ProbeObservation> => ({
      ok: true,
      findings: [
        {
          sentinel: 'PT_LLM_0_S',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [{ selector: ':root', field: 'textContent' }],
        },
      ],
    }))
    const result = await runLlmHintsLane({
      targets: [target],
      mountable: new Set(['UiButton']),
      probe,
      provider,
      sentinelSuffix: 'S',
    })
    expect(result.hints.UiButton).toEqual([
      expect.objectContaining({ verified: true, provenance: 'generated' }),
    ])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps verified:false when the probe mismatches the claimed selector', async () => {
    const target = manifest({ name: 'UiButton' })
    const provider = makeFakeProvider(() =>
      jsonResult([{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }]),
    )
    const probe: ProbeFn = vi.fn(async (): Promise<ProbeObservation> => ({
      ok: true,
      findings: [
        {
          sentinel: 'x',
          propOrSlot: { kind: 'prop', name: 'label' },
          matches: [{ selector: '.something-else', field: 'textContent' }],
        },
      ],
    }))
    const result = await runLlmHintsLane({
      targets: [target],
      mountable: new Set(['UiButton']),
      probe,
      provider,
    })
    expect(result.hints.UiButton).toEqual([expect.objectContaining({ verified: false })])
  })

  it('never attempts probe verification for a component NOT in `mountable`, even when a probe fn is supplied', async () => {
    const target = manifest({ name: 'Unmountable' })
    const provider = makeFakeProvider(() =>
      jsonResult([{ source: { kind: 'prop', name: 'label' }, domTarget: { selector: ':root', field: 'textContent' } }]),
    )
    const probe: ProbeFn = vi.fn(async (): Promise<ProbeObservation> => ({
      ok: true,
      findings: [{ sentinel: 'x', propOrSlot: { kind: 'prop', name: 'label' }, matches: [{ selector: ':root', field: 'textContent' }] }],
    }))
    const result = await runLlmHintsLane({
      targets: [target],
      mountable: new Set(), // Unmountable is NOT in here.
      probe,
      provider,
    })
    expect(probe).not.toHaveBeenCalled()
    expect(result.hints.Unmountable).toEqual([expect.objectContaining({ verified: false })])
  })

  it('skips a component with reason when the LLM call fails', async () => {
    const target = manifest({ name: 'Broken' })
    const provider = makeFakeProvider(() => new Error('rate limited'))
    const result = await runLlmHintsLane({ targets: [target], mountable: new Set(), provider })
    expect(result.hints.Broken).toBeUndefined()
    expect(result.skipped).toEqual([{ name: 'Broken', reason: expect.stringMatching(/rate limited/) }])
  })

  it('skips a component with reason when the LLM produced zero usable hints', async () => {
    const target = manifest({ name: 'NoHints' })
    const provider = makeFakeProvider(() => jsonResult([]))
    const result = await runLlmHintsLane({ targets: [target], mountable: new Set(), provider })
    expect(result.hints.NoHints).toBeUndefined()
    expect(result.skipped).toEqual([{ name: 'NoHints', reason: 'llm produced no usable hints' }])
  })

  it('C1: drops both hints (and reports the skip reason) when the model claims two different props at the same site', async () => {
    const target = manifest({
      name: 'KDialog',
      props: [prop({ name: 'title' }), prop({ name: 'heading' })],
    })
    const provider = makeFakeProvider(() =>
      jsonResult([
        { source: { kind: 'prop', name: 'title' }, domTarget: { selector: 'div.msg', field: 'textContent' } },
        { source: { kind: 'prop', name: 'heading' }, domTarget: { selector: 'div.msg', field: 'textContent' } },
      ]),
    )
    const result = await runLlmHintsLane({ targets: [target], mountable: new Set(), provider })
    expect(result.hints.KDialog).toBeUndefined()
    expect(result.skipped).toEqual([
      { name: 'KDialog', reason: 'llm hints dropped: cross-prop selector collision' },
    ])
  })

  it('passes resolveDistExcerpt output through to the provider prompt', async () => {
    let captured: CompleteOpts | undefined
    const provider = makeFakeProvider((opts) => {
      captured = opts
      return jsonResult([])
    })
    await runLlmHintsLane({
      targets: [manifest({ name: 'UiButton' })],
      mountable: new Set(),
      provider,
      resolveDistExcerpt: (m) => `SOURCE FOR ${m.name}`,
    })
    const userText = typeof captured!.user === 'string' ? captured!.user : captured!.user.map((b) => b.text).join('\n')
    expect(userText).toContain('SOURCE FOR UiButton')
  })
})
