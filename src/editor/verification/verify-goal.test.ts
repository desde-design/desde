/**
 * Unit tests for the L3a goal verifier (Tier-2 verification P2). The translator
 * and the measurement reader are injected as fakes, so the test drives the
 * compose/verdict logic deterministically — no LLM, no bridge.
 *
 * Spec: tasks/editor-edit-verification.md (P2).
 */

import { describe, expect, it, vi } from 'vitest'
import type { Measurements } from '@/types/bridge'
import { verifyGoal, isRelationalGoal, type TranslateResult, type VerifyGoalDeps } from './verify-goal'
import type { TranslatedPredicate } from './translate-goal'

function meas(over: Partial<{
  width: number
  scrollWidth: number
  clientWidth: number
  left: number
  color: string
  bg: string
  text: string
}> = {}): Measurements {
  const width = over.width ?? 100
  return {
    bbox: { x: over.left ?? 0, y: 0, width, height: 40, top: 0, left: over.left ?? 0, right: (over.left ?? 0) + width, bottom: 40 },
    scrollWidth: over.scrollWidth ?? 100,
    clientWidth: over.clientWidth ?? 100,
    scrollHeight: 40,
    clientHeight: 40,
    parentBbox: null,
    viewport: { width: 1280, height: 800 },
    computedStyle: {
      color: over.color ?? 'rgb(0, 0, 0)',
      backgroundColor: over.bg ?? 'rgb(255, 255, 255)',
      fontSize: '16px',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      textTransform: 'none',
    },
    textContent: over.text ?? '',
  }
}

function deps(over: Partial<VerifyGoalDeps>): VerifyGoalDeps {
  return {
    translate: vi.fn(async (): Promise<TranslateResult> => ({ ok: true, predicates: [] })),
    readMeasurements: vi.fn(async () => meas()),
    ...over,
  }
}

const translateTo = (predicates: TranslatedPredicate[]) =>
  vi.fn(async (): Promise<TranslateResult> => ({ ok: true, predicates }))

describe('isRelationalGoal', () => {
  it('matches alignment / size-match phrasings (incl. "lines up")', () => {
    for (const g of [
      'align this with the header',
      'aligns with the nav',
      'line it up with the sidebar',
      'make sure this lines up with the sidebar',
      'lined up with the footer',
      'same width as the card',
      'same dimensions as the header',
      'same box as the toolbar',
      'same proportions as the card',
      'as wide as the sidebar',
      'as tall as the nav',
      'equal height to the footer',
      'match the size of the toolbar',
      'flush with the header',
      'against the sidebar',
      'next to the nav',
    ]) {
      expect(isRelationalGoal(g)).toBe(true)
    }
  })
  it('does not match single-element goals', () => {
    for (const g of ['fit the content width', 'enough contrast', 'make it say Save', 'fit on screen']) {
      expect(isRelationalGoal(g)).toBe(false)
    }
  })
})

describe('verifyGoal', () => {
  it('passes when the single predicate passes', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit content width', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'noOverflow', args: {} }]),
        readMeasurements: async () => meas({ scrollWidth: 100, clientWidth: 100 }),
      }),
    )
    expect(r.status).toBe('pass')
    expect(r.expectedValue).toBe('fit content width')
  })

  it('fails (L3) when the predicate fails', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit content width', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'noOverflow', args: {} }]),
        readMeasurements: async () => meas({ scrollWidth: 200, clientWidth: 100 }),
      }),
    )
    expect(r.status).toBe('fail')
    expect(r.failedAt).toBe('L3')
    expect(r.escalatable).toBe(false)
    expect(r.detail).toMatch(/overflows/)
  })

  it('reads a secondary element for two-element predicates', async () => {
    const readMeasurements = vi.fn(async (sel: string) =>
      sel === '.header' ? meas({ left: 20 }) : meas({ left: 20 }),
    )
    const r = await verifyGoal(
      { editId: 'e1', goal: 'align with header', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'aligned', args: { other: '.header', axis: 'left' } }]),
        readMeasurements,
      }),
    )
    expect(r.status).toBe('pass')
    expect(readMeasurements).toHaveBeenCalledWith('.header', undefined)
    expect(readMeasurements).toHaveBeenCalledWith('.btn', undefined)
  })

  it('gathers a DOM inventory for a relational goal and passes present elements to translate', async () => {
    const translateArgs: Array<Parameters<VerifyGoalDeps['translate']>[0]> = []
    const translate: VerifyGoalDeps['translate'] = async (args) => {
      translateArgs.push(args)
      return { ok: true, predicates: [{ predicate: 'aligned', args: { other: 'header', axis: 'left' } }] }
    }
    // Only `header` (and the primary) are present; every other candidate probe
    // returns null and must be excluded from the inventory.
    const readMeasurements = vi.fn(async (sel: string) =>
      sel === 'header' || sel === '.btn' ? meas({ left: 20, text: 'Site title' }) : null,
    )
    await verifyGoal(
      { editId: 'e1', goal: 'align this with the header', selector: '.btn' },
      deps({ translate, readMeasurements }),
    )
    expect(translateArgs[0]?.referenceElements).toEqual([{ selector: 'header', label: 'Site title' }])
  })

  it('does NOT gather an inventory for a single-element goal (no extra reads)', async () => {
    const translateArgs: Array<Parameters<VerifyGoalDeps['translate']>[0]> = []
    const translate: VerifyGoalDeps['translate'] = async (args) => {
      translateArgs.push(args)
      return { ok: true, predicates: [{ predicate: 'noOverflow', args: {} }] }
    }
    const readMeasurements = vi.fn(async () => meas({ scrollWidth: 100, clientWidth: 100 }))
    await verifyGoal(
      { editId: 'e1', goal: 'fit the content width', selector: '.btn' },
      deps({ translate, readMeasurements }),
    )
    expect(translateArgs[0]?.referenceElements).toBeUndefined()
    // Only the primary read — no candidate probes for a non-relational goal.
    expect(readMeasurements).toHaveBeenCalledTimes(1)
  })

  it('dedupes repeated selector reads', async () => {
    const readMeasurements = vi.fn(async () => meas())
    await verifyGoal(
      { editId: 'e1', goal: 'g', selector: '.btn' },
      deps({
        translate: translateTo([
          { predicate: 'noOverflow', args: {} },
          { predicate: 'fitsViewport', args: {} },
        ]),
        readMeasurements,
      }),
    )
    // Primary read once despite two predicates over it.
    expect(readMeasurements).toHaveBeenCalledTimes(1)
  })

  it('passes the measurable predicate and ignores an indeterminate one', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit + contrast', selector: '.btn' },
      deps({
        translate: translateTo([
          { predicate: 'noOverflow', args: {} },
          { predicate: 'contrastRatio', args: {} },
        ]),
        // transparent bg → contrast indeterminate; overflow fine → pass overall
        readMeasurements: async () => meas({ scrollWidth: 100, clientWidth: 100, bg: 'rgba(0, 0, 0, 0)' }),
      }),
    )
    expect(r.status).toBe('pass')
    expect(r.detail).toMatch(/\?/) // the indeterminate predicate is shown with a ?
  })

  it('skips when every predicate is indeterminate', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'enough contrast', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'contrastRatio', args: {} }]),
        readMeasurements: async () => meas({ bg: 'rgba(0, 0, 0, 0)' }),
      }),
    )
    expect(r.status).toBe('skipped')
  })

  it('skips when the goal is not measurable (translator refusal)', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'make it nicer', selector: '.btn' },
      deps({ translate: vi.fn(async (): Promise<TranslateResult> => ({ ok: false, reason: 'aesthetic', kind: 'unmeasurable' })) }),
    )
    expect(r.status).toBe('skipped')
    expect(r.skipReason).toBe('unmeasurable')
    expect(r.detail).toMatch(/aesthetic/)
  })

  it('tags a translate infra-error distinctly (skipReason translate-error)', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit content', selector: '.btn' },
      deps({ translate: vi.fn(async (): Promise<TranslateResult> => ({ ok: false, reason: 'LLM call failed: 401', kind: 'error' })) }),
    )
    expect(r.status).toBe('skipped')
    expect(r.skipReason).toBe('translate-error')
  })

  it('skips when the primary element cannot be read', async () => {
    const readMeasurements = vi.fn(async () => null)
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit', selector: '.gone' },
      deps({ translate: translateTo([{ predicate: 'noOverflow', args: {} }]), readMeasurements }),
    )
    expect(r.status).toBe('skipped')
    expect(r.detail).toMatch(/Could not read/)
  })

  it('treats a translator throw as a skip, never a throw', async () => {
    const r = await verifyGoal(
      { editId: 'e1', goal: 'fit', selector: '.btn' },
      deps({ translate: vi.fn(async () => { throw new Error('net') }) }),
    )
    expect(r.status).toBe('skipped')
    expect(r.detail).toMatch(/errored/)
  })

  it('forwards the abort signal into measurement reads', async () => {
    const ac = new AbortController()
    const readMeasurements = vi.fn(async (_sel: string, signal?: AbortSignal) => {
      expect(signal).toBe(ac.signal)
      return meas()
    })
    await verifyGoal(
      { editId: 'e1', goal: 'fit', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'noOverflow', args: {} }]),
        readMeasurements,
        signal: ac.signal,
      }),
    )
    expect(readMeasurements).toHaveBeenCalledWith('.btn', ac.signal)
  })

  it('marks the secondary-element-missing predicate indeterminate → skip', async () => {
    const readMeasurements = vi.fn(async (sel: string) => (sel === '.btn' ? meas() : null))
    const r = await verifyGoal(
      { editId: 'e1', goal: 'align', selector: '.btn' },
      deps({
        translate: translateTo([{ predicate: 'aligned', args: { other: '.missing', axis: 'left' } }]),
        readMeasurements,
      }),
    )
    expect(r.status).toBe('skipped')
  })
})
