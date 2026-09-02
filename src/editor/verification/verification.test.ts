/**
 * Unit tests for the Tier-2 verification core (P1). Pure logic — the bridge
 * (`readRenderedValue`) and source (`readSourceAt`) readers are injected as
 * fakes, and the polling clock is driven by an injectable `now`/`sleep` so
 * the L2 loop is deterministic.
 *
 * Spec: tasks/editor-edit-verification.md.
 */

import { describe, expect, it, vi } from 'vitest'
import { classifyFailure } from './classify-failure'
import { deriveExpectation } from './derive-expectation'
import { verifyRender, type VerifyDeps } from './verify-render'
import { orchestrateVerification } from './orchestrate'
import type { EditExpectation } from './types'

// ──────────────── deriveExpectation ────────────────

describe('deriveExpectation', () => {
  it('maps an attribute dom-hint to an attr accessor', () => {
    const exp = deriveExpectation({
      editId: 'e1',
      selector: 'input.ui-input',
      expectedValue: 'Search…',
      editKind: 'prop',
      propName: 'placeholder',
      domField: 'attribute',
      attribute: 'placeholder',
    })
    expect(exp).not.toBeNull()
    expect(exp!.accessor).toEqual({ kind: 'attr', name: 'placeholder' })
    expect(exp!.provenance).toBe('deterministic')
  })

  it('maps a textContent dom-hint to a text accessor', () => {
    const exp = deriveExpectation({
      editId: 'e2',
      selector: '.ui-label',
      expectedValue: 'Submit',
      editKind: 'prop',
      propName: 'label',
      domField: 'textContent',
    })
    expect(exp!.accessor).toEqual({ kind: 'text' })
  })

  it('defaults slot/dom-text edits to text without a dom-hint', () => {
    const exp = deriveExpectation({
      editId: 'e3',
      selector: 'h1',
      expectedValue: 'Title',
      editKind: 'dom-text',
    })
    expect(exp!.accessor).toEqual({ kind: 'text' })
  })

  it('declines a prop edit with no dom-hint (unknown render site)', () => {
    expect(
      deriveExpectation({
        editId: 'e4',
        selector: '.thing',
        expectedValue: '3',
        editKind: 'prop',
        propName: 'step',
      }),
    ).toBeNull()
  })

  it('declines an attribute hint missing its attribute name', () => {
    expect(
      deriveExpectation({
        editId: 'e5',
        selector: 'input',
        expectedValue: 'x',
        editKind: 'prop',
        propName: 'value',
        domField: 'attribute',
      }),
    ).toBeNull()
  })

  it('declines when the selector is empty', () => {
    expect(
      deriveExpectation({
        editId: 'e6',
        selector: '',
        expectedValue: 'x',
        editKind: 'dom-text',
      }),
    ).toBeNull()
  })
})

describe('deriveExpectation — style + token lanes', () => {
  it('builds a cascade expectation for a Vue scoped-css-override edit', () => {
    const exp = deriveExpectation({
      editId: 's1',
      selector: '.ui-card',
      expectedValue: 'red',
      editKind: 'style',
      styleProperty: 'background-color',
      cascadeOwner: { kind: 'pt-src' },
    })
    expect(exp).not.toBeNull()
    expect(exp!.accessor).toEqual({ kind: 'style', name: 'background-color' })
    expect(exp!.cascade).toEqual({
      owner: { kind: 'pt-src' },
      properties: [{ property: 'background-color' }],
    })
    expect(exp!.label).toBe('background-color = "red"')
  })

  it('threads expectedDeclarationValue into the cascade spec when supplied', () => {
    const exp = deriveExpectation({
      editId: 's1b',
      selector: '.ui-card',
      expectedValue: '#3b82f6',
      editKind: 'style',
      styleProperty: 'background-color',
      cascadeOwner: { kind: 'pt-src' },
      expectedDeclarationValue: '#3b82f6',
    })
    expect(exp!.cascade).toEqual({
      owner: { kind: 'pt-src' },
      properties: [
        { property: 'background-color', expectedDeclarationValue: '#3b82f6' },
      ],
    })
  })

  it('builds a cascade expectation for a token edit', () => {
    const exp = deriveExpectation({
      editId: 's2',
      selector: '.ui-card',
      expectedValue: '#fff',
      editKind: 'token',
      styleProperty: 'background-color',
      cascadeOwner: { kind: 'token', token: '--acme-color-background' },
    })
    expect(exp!.cascade).toEqual({
      owner: { kind: 'token', token: '--acme-color-background' },
      properties: [{ property: 'background-color' }],
    })
  })

  it('declines a style edit with no CSS property (nothing to read back)', () => {
    expect(
      deriveExpectation({
        editId: 's3',
        selector: '.ui-card',
        expectedValue: 'red',
        editKind: 'style',
        cascadeOwner: { kind: 'pt-src' },
      }),
    ).toBeNull()
  })

  it('declines a style edit with no cascade owner (cannot tell whose rule won)', () => {
    expect(
      deriveExpectation({
        editId: 's4',
        selector: '.ui-card',
        expectedValue: 'red',
        editKind: 'style',
        styleProperty: 'color',
      }),
    ).toBeNull()
  })

  it('leaves the prop/slot/dom-text lanes free of a cascade spec', () => {
    const exp = deriveExpectation({
      editId: 's5',
      selector: '.ui-label',
      expectedValue: 'Submit',
      editKind: 'dom-text',
    })
    expect(exp!.cascade).toBeUndefined()
    expect(exp!.accessor).toEqual({ kind: 'text' })
  })
})

// ──────────────── classifyFailure ────────────────

describe('classifyFailure', () => {
  it('detects v-model on the source line', () => {
    expect(
      classifyFailure({
        sourceLine: '<input v-model="name" />',
        observedValue: 'old',
        expectedValue: 'new',
      }),
    ).toEqual({ cause: 'v-model', escalatable: true })
  })

  it('detects a dynamic v-bind spread', () => {
    expect(
      classifyFailure({
        sourceLine: '<UiButton v-bind="btnProps" />',
        observedValue: 'old',
        expectedValue: 'new',
      }).cause,
    ).toBe('dynamic-vbind')
  })

  it('detects a dynamic v-bind argument', () => {
    expect(
      classifyFailure({
        sourceLine: '<UiButton :[dynName]="val" />',
        observedValue: 'old',
        expectedValue: 'new',
      }).cause,
    ).toBe('dynamic-vbind')
  })

  it('detects a bound binding for the targeted prop', () => {
    expect(
      classifyFailure({
        sourceLine: '<UiButton :label="computedLabel" />',
        propName: 'label',
        observedValue: 'computed',
        expectedValue: 'Submit',
      }),
    ).toEqual({ cause: 'bound-binding', escalatable: true })
  })

  it('treats a bound binding for a different prop as not-this-prop', () => {
    // `:disabled` is bound but we edited `label`; no v-model/spread → falls
    // through to hmr-stale since the element is present.
    expect(
      classifyFailure({
        sourceLine: '<UiButton :disabled="isOff" label="Submit" />',
        propName: 'label',
        observedValue: 'Submit',
        expectedValue: 'Submit2',
      }).cause,
    ).toBe('hmr-stale')
  })

  it('flags a conditional render when the element is absent and gated', () => {
    expect(
      classifyFailure({
        sourceLine: '<UiAlert v-if="show" title="Hi" />',
        propName: 'title',
        observedValue: null,
        expectedValue: 'Bye',
      }).cause,
    ).toBe('conditional')
  })

  it('reports selector-missing when absent and ungated', () => {
    expect(
      classifyFailure({
        sourceLine: '<UiAlert title="Hi" />',
        observedValue: null,
        expectedValue: 'Bye',
      }).cause,
    ).toBe('selector-missing')
  })

  it('reports hmr-stale when present but unchanged with no binding form', () => {
    expect(
      classifyFailure({
        sourceLine: '<h1>Old</h1>',
        observedValue: 'Old',
        expectedValue: 'New',
      }).cause,
    ).toBe('hmr-stale')
  })

  it('handles a missing source line gracefully', () => {
    expect(
      classifyFailure({
        sourceLine: null,
        observedValue: 'x',
        expectedValue: 'y',
      }).cause,
    ).toBe('hmr-stale')
  })
})

// ──────────────── verifyRender ────────────────

const baseExpectation: EditExpectation = {
  editId: 'edit-1',
  label: 'label = "Submit"',
  selector: '.ui-label',
  accessor: { kind: 'text' },
  expectedValue: 'Submit',
  sourceLoc: { file: 'src/App.vue', line: 10, column: 4 },
  targetFile: 'src/App.vue',
  provenance: 'deterministic',
}

/** A controllable fake clock so the poll loop is deterministic. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('verifyRender — L2', () => {
  it('passes when the DOM reflects the value on the first poll', async () => {
    const clock = fakeClock()
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockResolvedValue('Submit'),
      now: clock.now,
      sleep: clock.sleep,
    }
    const r = await verifyRender(baseExpectation, deps)
    expect(r.status).toBe('pass')
    expect(r.observedValue).toBe('Submit')
    expect(deps.readRenderedValue).toHaveBeenCalledTimes(1)
  })

  it('passes after the value settles on a later poll (HMR delay)', async () => {
    const clock = fakeClock()
    const values = ['Old', 'Old', 'Submit']
    let i = 0
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockImplementation(() =>
        Promise.resolve(values[Math.min(i++, values.length - 1)]),
      ),
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 2500,
    }
    const r = await verifyRender(baseExpectation, deps)
    expect(r.status).toBe('pass')
    expect((deps.readRenderedValue as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('normalizes whitespace when comparing', async () => {
    const clock = fakeClock()
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockResolvedValue('  Submit\n  '),
      now: clock.now,
      sleep: clock.sleep,
    }
    expect((await verifyRender(baseExpectation, deps)).status).toBe('pass')
  })

  it('fails at L2 and classifies a bound binding as escalatable', async () => {
    const clock = fakeClock()
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockResolvedValue('Computed'),
      readSourceAt: vi.fn().mockResolvedValue('<UiButton :label="computed">Submit</UiButton>'),
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      timeoutMs: 500,
    }
    const r = await verifyRender(
      { ...baseExpectation, expectedValue: 'Submit', accessor: { kind: 'attr', name: 'label' } },
      deps,
    )
    expect(r.status).toBe('fail')
    expect(r.failedAt).toBe('L2')
    expect(r.cause).toBe('bound-binding')
    expect(r.escalatable).toBe(true)
    expect(r.detail).toMatch(/chat/i)
  })

  it('fails at L2 as hmr-stale (non-escalatable) for a plain literal', async () => {
    const clock = fakeClock()
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockResolvedValue('Old'),
      readSourceAt: vi.fn().mockResolvedValue('<h1>Submit</h1>'),
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 300,
    }
    const r = await verifyRender(baseExpectation, deps)
    expect(r.status).toBe('fail')
    expect(r.cause).toBe('hmr-stale')
    expect(r.escalatable).toBe(false)
  })

  it('confirm-stable defeats the live-override false-pass (HMR reverts a bound value)', async () => {
    // Editor's instant override shows "Submit"; after HMR the bound value
    // "Computed" wins. Without confirm-stable the first poll would false-pass.
    const clock = fakeClock()
    const reads = ['Submit', 'Computed', 'Computed', 'Computed']
    let i = 0
    const deps: VerifyDeps = {
      readRenderedValue: vi
        .fn()
        .mockImplementation(() => Promise.resolve(reads[Math.min(i++, reads.length - 1)])),
      readSourceAt: vi.fn().mockResolvedValue('<UiButton :label="computed" />'),
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100,
      confirmStableMs: 600,
      timeoutMs: 2000,
    }
    const r = await verifyRender(
      { ...baseExpectation, accessor: { kind: 'attr', name: 'label' } },
      deps,
    )
    expect(r.status).toBe('fail')
    expect(r.cause).toBe('bound-binding')
    expect(r.escalatable).toBe(true)
  })

  it('confirm-stable still passes a genuinely-applied edit (value stays put)', async () => {
    const clock = fakeClock()
    const deps: VerifyDeps = {
      readRenderedValue: vi.fn().mockResolvedValue('Submit'),
      now: clock.now,
      sleep: clock.sleep,
      confirmStableMs: 600,
      timeoutMs: 2000,
    }
    expect((await verifyRender(baseExpectation, deps)).status).toBe('pass')
  })

  it('polls at least once even with a zero timeout', async () => {
    const clock = fakeClock()
    const read = vi.fn().mockResolvedValue('Submit')
    const r = await verifyRender(baseExpectation, {
      readRenderedValue: read,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 0,
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(r.status).toBe('pass')
  })
})

describe('verifyRender — L1', () => {
  it('fails fast (non-escalatable) when the literal is absent from source', async () => {
    const clock = fakeClock()
    const read = vi.fn().mockResolvedValue('whatever')
    const r = await verifyRender(baseExpectation, {
      readRenderedValue: read,
      readSourceAt: vi.fn().mockResolvedValue('<h1>SomethingElse</h1>'),
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(r.status).toBe('fail')
    expect(r.failedAt).toBe('L1')
    expect(r.escalatable).toBe(false)
    // L1 short-circuits before any DOM read.
    expect(read).not.toHaveBeenCalled()
  })

  it('proceeds to L2 when the literal is present at the source location', async () => {
    const clock = fakeClock()
    const r = await verifyRender(baseExpectation, {
      readRenderedValue: vi.fn().mockResolvedValue('Submit'),
      readSourceAt: vi.fn().mockResolvedValue('<h1>Submit</h1>'),
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(r.status).toBe('pass')
  })

  it('skips L1 when no source reader is wired', async () => {
    const clock = fakeClock()
    const r = await verifyRender(baseExpectation, {
      readRenderedValue: vi.fn().mockResolvedValue('Submit'),
      now: clock.now,
      sleep: clock.sleep,
    })
    expect(r.status).toBe('pass')
  })
})

// ──────────────── orchestrateVerification ────────────────

describe('orchestrateVerification', () => {
  const input = {
    editId: 'edit-9',
    selector: '.ui-label',
    expectedValue: 'Submit',
    editKind: 'dom-text' as const,
    // Join key for the Activity-row badge — threaded through to `begin`.
    commitSha: 'deadbeef',
  }

  it('returns null and records nothing when no oracle can be derived', async () => {
    const begin = vi.fn()
    const complete = vi.fn()
    const r = await orchestrateVerification(
      { editId: 'x', selector: '.a', expectedValue: 'v', editKind: 'prop', propName: 'step' },
      { begin, complete },
      { readRenderedValue: vi.fn(), settleMs: 0 },
    )
    expect(r).toBeNull()
    expect(begin).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('begins then completes a passing verification', async () => {
    const clock = fakeClock()
    const begin = vi.fn()
    const complete = vi.fn()
    const r = await orchestrateVerification(
      input,
      { begin, complete },
      {
        readRenderedValue: vi.fn().mockResolvedValue('Submit'),
        now: clock.now,
        sleep: clock.sleep,
        settleMs: 0,
      },
    )
    expect(begin).toHaveBeenCalledWith(
      'edit-9',
      expect.any(String),
      expect.any(Number),
      'deadbeef',
    )
    expect(complete).toHaveBeenCalledWith('edit-9', expect.objectContaining({ status: 'pass' }))
    expect(r?.status).toBe('pass')
  })

  it('classifies a bound-binding failure as escalatable without a repair callback (no auto-escalation)', async () => {
    const clock = fakeClock()
    const r = await orchestrateVerification(
      {
        ...input,
        editKind: 'prop',
        propName: 'label',
        domField: 'attribute',
        attribute: 'label',
        targetFile: 'src/App.vue',
        sourceLoc: { file: 'src/App.vue', line: 3, column: 1 },
      },
      { begin: vi.fn(), complete: vi.fn() },
      {
        readRenderedValue: vi.fn().mockResolvedValue('Computed'),
        readSourceAt: vi.fn().mockResolvedValue('<UiButton :label="x" />'),
        now: clock.now,
        sleep: clock.sleep,
        settleMs: 0,
        timeoutMs: 200,
      },
    )
    expect(r?.cause).toBe('bound-binding')
    expect(r?.escalatable).toBe(true)
  })

  it('records a skipped result if the reader throws unexpectedly', async () => {
    const complete = vi.fn()
    const r = await orchestrateVerification(
      input,
      { begin: vi.fn(), complete },
      {
        readRenderedValue: vi.fn().mockRejectedValue(new Error('boom')),
        settleMs: 0,
        timeoutMs: 0,
      },
    )
    expect(r?.status).toBe('skipped')
    expect(complete).toHaveBeenCalledWith('edit-9', expect.objectContaining({ status: 'skipped' }))
  })
})

describe('verifyRender — cascade lane', () => {
  const OURS = {
    selector: '[data-desde-src="src/App.vue:3:2"][data-v-a1]',
    stylesheet: { href: 'http://x/src/App.vue' },
    declaration: 'background-color: red !important',
    specificity: [0, 2, 0] as [number, number, number],
  }
  const THEIRS = {
    selector: '.ui-card',
    stylesheet: {
      href: 'http://x/node_modules/@acme/design-system/style.css',
      package: '@acme/design-system',
    },
    declaration: 'background-color: #f7f7f7 !important',
    specificity: [0, 1, 0] as [number, number, number],
  }

  function styleExpectation(): EditExpectation {
    return {
      editId: 'c1',
      label: 'background-color = "red"',
      selector: '.ui-card',
      accessor: { kind: 'style', name: 'background-color' },
      expectedValue: 'red',
      cascade: { owner: { kind: 'pt-src' }, properties: [{ property: 'background-color' }] },
      provenance: 'deterministic',
    }
  }

  function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
    return {
      readRenderedValue: async () => 'block',
      pollIntervalMs: 1,
      timeoutMs: 10,
      sleep: async () => {},
      ...over,
    }
  }

  it('passes when our rule owns the property', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(255, 0, 0)',
            winningRule: OURS,
            varChain: [],
          },
        }),
      }),
    )
    expect(result.status).toBe('pass')
  })

  it('fails with css-overridden and names the winner when a library rule wins', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(247, 247, 247)',
            winningRule: THEIRS,
            varChain: [],
          },
        }),
      }),
    )
    expect(result.status).toBe('fail')
    expect(result.failedAt).toBe('L2')
    expect(result.cause).toBe('css-overridden')
    expect(result.escalatable).toBe(false)
    expect(result.detail).toContain('@acme/design-system')
    expect(result.detail).toContain('.ui-card')
  })

  // Phase 3 live finding 1, at the verify-render layer. The stylesheet-owner
  // lanes are immune to the shim in the evaluator, so a held shim no longer
  // false-fails a landed `[data-desde-src]` rule.
  it('passes while editor’s own preview shim is still held (pt-src owner)', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(255, 0, 0)',
            winningRule: OURS,
            varChain: [],
            inline: { value: 'rgb(255, 0, 0)', important: true, fromPreview: true },
          },
        }),
      }),
    )
    expect(result.status).toBe('pass')
  })

  // …and the `inline` owner, whose evidence the shim occupies, must degrade to
  // `skipped` — never a pass (false pass) and never a fail (false alarm).
  it('skips, rather than passing or failing, when the inline owner’s slot holds the shim', async () => {
    const exp = styleExpectation()
    exp.cascade = {
      owner: { kind: 'inline' },
      properties: [{ property: 'background-color' }],
    }
    const result = await verifyRender(
      exp,
      deps({
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(255, 0, 0)',
            winningRule: null,
            varChain: [],
            inline: { value: 'rgb(255, 0, 0)', important: true, fromPreview: true },
          },
        }),
      }),
    )
    expect(result.status).toBe('skipped')
    expect(result.cause).toBeUndefined()
    expect(result.escalatable).toBe(false)
    expect(result.detail).toContain('live preview is still applied')
  })

  it('polls until our rule wins rather than failing on the first read', async () => {
    let call = 0
    const result = await verifyRender(
      styleExpectation(),
      deps({
        timeoutMs: 100,
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(255, 0, 0)',
            winningRule: ++call >= 3 ? OURS : THEIRS,
            varChain: [],
          },
        }),
        now: (() => {
          let t = 0
          return () => (t += 5)
        })(),
      }),
    )
    expect(result.status).toBe('pass')
    expect(call).toBeGreaterThanOrEqual(3)
  })

  it('reports css-hidden when our rule wins but the element is not visible', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readRenderedValue: async (_selector, accessor) =>
          accessor.name === 'display' ? 'none' : 'visible',
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(255, 0, 0)',
            winningRule: OURS,
            varChain: [],
          },
        }),
      }),
    )
    expect(result.status).toBe('fail')
    expect(result.cause).toBe('css-hidden')
    expect(result.escalatable).toBe(false)
  })

  // residual-review R2: a successful-but-empty read is ambiguous. The element
  // being PRESENT with no rule declaring the property is a real signal — keep it
  // a failure. (`deps().readRenderedValue` answers `'block'`, i.e. present.)
  it('reports selector-missing when the element is present but no rule declares the property', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({ readStyleProvenance: async () => ({}) }),
    )
    expect(result.status).toBe('fail')
    expect(result.cause).toBe('selector-missing')
  })

  // The other reading of the same empty map, and the case four places used to
  // claim was covered by the `null` → `skipped` mapping: the selector no longer
  // matches anything. Reachable on the React `classes` lane — the bridge builds
  // class-based selectors, so `div.bg-white` stops matching once the background
  // class is swapped, and the bridge answers that gracefully with `{}` rather
  // than a read failure. We cannot substantiate a failure against an element we
  // can't find, so probe once and skip.
  it('skips when provenance is empty AND the selector matches no element', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readStyleProvenance: async () => ({}),
        readRenderedValue: async () => null,
      }),
    )
    expect(result.status).toBe('skipped')
    expect(result.cause).toBeUndefined()
    expect(result.detail).toContain('no element matches')
  })

  it('does not probe (or skip) when the cascade was simply lost to another rule', async () => {
    // An origin EXISTS — a library rule owns the property. That is a substantiated
    // failure, and the no-element probe must not run and must not soften it.
    let probes = 0
    const result = await verifyRender(
      styleExpectation(),
      deps({
        readStyleProvenance: async () => ({
          'background-color': {
            property: 'background-color',
            computedValue: 'rgb(247, 247, 247)',
            winningRule: {
              selector: '.ui-card',
              stylesheet: { href: '/node_modules/@acme/design-system/dist/style.css', package: '@acme/design-system' },
              declaration: 'background-color: #f7f7f7',
              specificity: [0, 1, 0],
            },
            varChain: [],
          },
        }),
        readRenderedValue: async () => {
          probes++
          return null
        },
      }),
    )
    expect(result.status).toBe('fail')
    expect(result.cause).toBe('css-overridden')
    // Only the two visibility reads (which run on the `won` path) would use the
    // reader; on this path nothing does.
    expect(probes).toBe(0)
  })

  // codex P1 (false pass): a repeat edit of a property our own rule already owns
  // leaves ownership unchanged, so the first poll reported `won` even when the
  // DOM still showed the previous value. These three gate the wired lane.
  describe('value dimension (pt-src)', () => {
    function valueExpectation(): EditExpectation {
      const exp = styleExpectation()
      exp.expectedValue = '#3b82f6'
      exp.cascade = {
        owner: { kind: 'pt-src' },
        properties: [
          { property: 'background-color', expectedDeclarationValue: '#3b82f6' },
        ],
      }
      return exp
    }
    const staleRule = { ...OURS, declaration: 'background-color: rgb(239, 68, 68) !important' }
    const freshRule = { ...OURS, declaration: 'background-color: rgb(59, 130, 246) !important' }
    const provenance = (winningRule: typeof OURS) => async () => ({
      'background-color': {
        property: 'background-color',
        computedValue: 'rgb(239, 68, 68)',
        winningRule,
        varChain: [],
      },
    })

    it('passes when our rule carries the new value', async () => {
      const result = await verifyRender(
        valueExpectation(),
        deps({ readStyleProvenance: provenance(freshRule) }),
      )
      expect(result.status).toBe('pass')
    })

    it('fails as hmr-stale — NOT css-overridden — when our rule still shows the old value', async () => {
      const result = await verifyRender(
        valueExpectation(),
        deps({ readStyleProvenance: provenance(staleRule) }),
      )
      expect(result.status).toBe('fail')
      expect(result.failedAt).toBe('L2')
      // `css-overridden` would tell the user to escalate the scope against a
      // rule that outranked them — but nothing did; our own rule owns it.
      expect(result.cause).toBe('hmr-stale')
      expect(result.escalatable).toBe(false)
      expect(result.detail).toContain('still declares the previous value')
      expect(result.detail).not.toContain('broader scope')
    })

    it('KEEPS POLLING on a stale value rather than hard-failing the first read', async () => {
      // HMR legitimately takes time, so a stale declaration must exhaust the
      // budget before it becomes a verdict. Injected-clock idiom, as above.
      let reads = 0
      const result = await verifyRender(
        valueExpectation(),
        deps({
          timeoutMs: 100,
          readStyleProvenance: async () => {
            reads++
            return {
              'background-color': {
                property: 'background-color',
                computedValue: 'rgb(239, 68, 68)',
                winningRule: staleRule,
                varChain: [],
              },
            }
          },
          now: (() => {
            let t = 0
            return () => (t += 5)
          })(),
        }),
      )
      expect(result.status).toBe('fail')
      expect(result.cause).toBe('hmr-stale')
      expect(reads).toBeGreaterThan(1)
    })

    it('passes when the declaration updates mid-poll (HMR lands late)', async () => {
      let call = 0
      const result = await verifyRender(
        valueExpectation(),
        deps({
          timeoutMs: 100,
          readStyleProvenance: async () => ({
            'background-color': {
              property: 'background-color',
              computedValue: 'rgb(59, 130, 246)',
              winningRule: ++call >= 3 ? freshRule : staleRule,
              varChain: [],
            },
          }),
          now: (() => {
            let t = 0
            return () => (t += 5)
          })(),
        }),
      )
      expect(result.status).toBe('pass')
      expect(call).toBeGreaterThanOrEqual(3)
    })

    it('leaves the ownership-only lane untouched when no expected value is set', async () => {
      // Same stale declaration, no `expectedDeclarationValue` → ownership decides,
      // exactly as before this fix. Guards every existing call path.
      const result = await verifyRender(
        styleExpectation(),
        deps({ readStyleProvenance: provenance(staleRule) }),
      )
      expect(result.status).toBe('pass')
    })
  })

  // codex P2: the same false pass for the React inline lane — presence of an
  // inline declaration was enough, so a repeat edit passed while the previous
  // value still rendered.
  describe('value dimension (inline)', () => {
    function inlineExpectation(expectedDeclarationValue?: string): EditExpectation {
      const exp = styleExpectation()
      exp.expectedValue = '#3b82f6'
      exp.cascade = {
        owner: { kind: 'inline' },
        properties: [
          {
            property: 'background-color',
            ...(expectedDeclarationValue ? { expectedDeclarationValue } : {}),
          },
        ],
      }
      return exp
    }
    const inlineProvenance = (value: string) => async () => ({
      'background-color': {
        property: 'background-color',
        computedValue: value,
        winningRule: null,
        inline: { value, important: false },
        varChain: [],
      },
    })

    it('passes when the inline declaration carries the new value', async () => {
      const result = await verifyRender(
        inlineExpectation('#3b82f6'),
        deps({ readStyleProvenance: inlineProvenance('rgb(59, 130, 246)') }),
      )
      expect(result.status).toBe('pass')
    })

    it('fails as hmr-stale — NOT css-overridden — when the old inline value is still there', async () => {
      const result = await verifyRender(
        inlineExpectation('#3b82f6'),
        deps({ readStyleProvenance: inlineProvenance('rgb(239, 68, 68)') }),
      )
      expect(result.status).toBe('fail')
      expect(result.failedAt).toBe('L2')
      expect(result.cause).toBe('hmr-stale')
      expect(result.escalatable).toBe(false)
      expect(result.detail).toContain('still declares the previous value')
      expect(result.detail).not.toContain('broader scope')
    })

    it('leaves the presence-only lane untouched when no expected value is set', async () => {
      const result = await verifyRender(
        inlineExpectation(),
        deps({ readStyleProvenance: inlineProvenance('rgb(239, 68, 68)') }),
      )
      expect(result.status).toBe('pass')
    })
  })

  // codex R4: the same false pass for the token lane — the chain still
  // containing the patched token was enough, so a repeat token edit passed while
  // the old definition still rendered.
  describe('value dimension (token)', () => {
    function tokenExpectation(expectedDeclarationValue?: string): EditExpectation {
      const exp = styleExpectation()
      exp.expectedValue = '#3b82f6'
      exp.cascade = {
        owner: { kind: 'token', token: '--brand-bg' },
        properties: [
          {
            property: 'background-color',
            ...(expectedDeclarationValue ? { expectedDeclarationValue } : {}),
          },
        ],
      }
      return exp
    }
    const tokenProvenance = (definition: string) => async () => ({
      'background-color': {
        property: 'background-color',
        computedValue: 'rgb(239, 68, 68)',
        winningRule: {
          selector: '.consumer',
          stylesheet: { href: '/src/App.vue' },
          declaration: 'background-color: var(--brand-bg)',
          specificity: [0, 1, 0] as [number, number, number],
        },
        varChain: [
          {
            name: '--brand-bg',
            value: definition,
            definedAt: { selector: ':root', stylesheet: { href: '/src/tokens.css' } },
          },
        ],
      },
    })

    it('passes when the token definition carries the new value', async () => {
      const result = await verifyRender(
        tokenExpectation('#3b82f6'),
        deps({ readStyleProvenance: tokenProvenance('#3b82f6') }),
      )
      expect(result.status).toBe('pass')
    })

    it('fails as hmr-stale — NOT css-overridden — when the token still holds the old value', async () => {
      const result = await verifyRender(
        tokenExpectation('#3b82f6'),
        deps({ readStyleProvenance: tokenProvenance('#ef4444') }),
      )
      expect(result.status).toBe('fail')
      expect(result.failedAt).toBe('L2')
      expect(result.cause).toBe('hmr-stale')
      expect(result.escalatable).toBe(false)
      expect(result.detail).toContain('still declares the previous value')
      expect(result.detail).not.toContain('broader scope')
    })

    it('leaves the ownership-only lane untouched when no expected value is set', async () => {
      const result = await verifyRender(
        tokenExpectation(),
        deps({ readStyleProvenance: tokenProvenance('#ef4444') }),
      )
      expect(result.status).toBe('pass')
    })

    it('declines (passes on ownership) for a chained token definition', async () => {
      const result = await verifyRender(
        tokenExpectation('#3b82f6'),
        deps({ readStyleProvenance: tokenProvenance('var(--red-500)') }),
      )
      expect(result.status).toBe('pass')
    })
  })

  it('skips (does not fail) when no provenance reader is wired', async () => {
    const result = await verifyRender(styleExpectation(), deps())
    expect(result.status).toBe('skipped')
    expect(result.detail).toContain('provenance')
  })

  // final-review I3: `null` = the read FAILED, which is NOT evidence of
  // anything (timeout, disposed target, old bridge) — reporting it as "Did not
  // take effect" is a false failure on a good edit. The self-invalidated-selector
  // case is NOT this branch: the bridge answers that with an empty map, covered
  // by the R2 probe above.
  it('skips (does not fail) when the provenance read itself fails', async () => {
    const result = await verifyRender(
      styleExpectation(),
      deps({ readStyleProvenance: async () => null }),
    )
    expect(result.status).toBe('skipped')
    expect(result.cause).toBeUndefined()
    expect(result.detail).toContain('could not read style provenance')
  })

  it('does not keep polling after a failed read', async () => {
    let calls = 0
    const result = await verifyRender(
      styleExpectation(),
      deps({
        timeoutMs: 100,
        readStyleProvenance: async () => {
          calls++
          return null
        },
        now: (() => {
          let t = 0
          return () => (t += 5)
        })(),
      }),
    )
    expect(result.status).toBe('skipped')
    expect(calls).toBe(1)
  })
})
