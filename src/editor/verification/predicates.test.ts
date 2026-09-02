/**
 * Unit tests for the L3a predicate registry (Tier-2 verification P2). Pure
 * functions over `Measurements`; no I/O, no LLM. One describe per predicate
 * (pass + fail), plus the color helpers and the dispatcher's degrade-to-skip.
 *
 * Spec: tasks/editor-edit-verification.md (P2).
 */

import { describe, expect, it } from 'vitest'
import type { Measurements } from '@/types/bridge'
import {
  aligned,
  applyTextTransform,
  bboxMatches,
  contrastRatio,
  contrastRatioValue,
  evaluatePredicate,
  fitsViewport,
  needsSecondElement,
  noOverflow,
  parseCssColor,
  textEquals,
} from './predicates'

/** Build a Measurements fixture; override any leaf via the partial. */
function meas(over: {
  bbox?: Partial<Measurements['bbox']>
  scrollWidth?: number
  clientWidth?: number
  scrollHeight?: number
  clientHeight?: number
  viewport?: Partial<Measurements['viewport']>
  computedStyle?: Partial<Measurements['computedStyle']>
  textContent?: string
} = {}): Measurements {
  const bbox = {
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    top: 0,
    left: 0,
    right: 100,
    bottom: 40,
    ...over.bbox,
  }
  return {
    bbox,
    scrollWidth: over.scrollWidth ?? 100,
    clientWidth: over.clientWidth ?? 100,
    scrollHeight: over.scrollHeight ?? 40,
    clientHeight: over.clientHeight ?? 40,
    parentBbox: null,
    viewport: { width: 1280, height: 800, ...over.viewport },
    computedStyle: {
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontSize: '16px',
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      textTransform: 'none',
      ...over.computedStyle,
    },
    textContent: over.textContent ?? '',
  }
}

describe('noOverflow', () => {
  it('passes when content fits its box', () => {
    expect(noOverflow(meas({ scrollWidth: 100, clientWidth: 100 })).pass).toBe(true)
  })
  it('passes within the 1px tolerance', () => {
    expect(noOverflow(meas({ scrollWidth: 101, clientWidth: 100 })).pass).toBe(true)
  })
  it('fails on horizontal overflow', () => {
    const r = noOverflow(meas({ scrollWidth: 160, clientWidth: 100 }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/x by 60px/)
  })
  it('fails on vertical overflow', () => {
    const r = noOverflow(meas({ scrollHeight: 120, clientHeight: 40 }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/y by 80px/)
  })
  it('is indeterminate on an inline element (no layout box → 0 metrics)', () => {
    const r = noOverflow(meas({ scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, computedStyle: { display: 'inline' } }))
    expect(r.indeterminate).toBe(true)
    expect(r.pass).toBe(false)
  })
  it('is indeterminate when the client box is 0×0', () => {
    const r = noOverflow(meas({ scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 }))
    expect(r.indeterminate).toBe(true)
  })
})

describe('fitsViewport', () => {
  it('passes when the box is on-screen', () => {
    expect(fitsViewport(meas({ bbox: { left: 10, right: 110, top: 10, bottom: 50 } })).pass).toBe(true)
  })
  it('fails when the right edge spills past the viewport', () => {
    const r = fitsViewport(meas({ bbox: { left: 1200, right: 1400, top: 10, bottom: 50 }, viewport: { width: 1280 } }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/right edge/)
  })
  it('fails when the element is off the top', () => {
    const r = fitsViewport(meas({ bbox: { top: -50, bottom: -10 } }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/top edge/)
  })
})

describe('aligned', () => {
  const a = meas({ bbox: { left: 20, right: 120, top: 0, bottom: 40, width: 100, height: 40 } })
  it('passes when left edges coincide', () => {
    const b = meas({ bbox: { left: 21, right: 200, width: 179 } })
    expect(aligned(a, b, 'left').pass).toBe(true)
  })
  it('fails when left edges differ beyond tolerance', () => {
    const b = meas({ bbox: { left: 40, right: 200 } })
    const r = aligned(a, b, 'left')
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/not aligned on left/)
  })
  it('handles centerX', () => {
    // a center = 20 + 50 = 70. b spans 0..140 → center 70.
    const b = meas({ bbox: { left: 0, right: 140, width: 140 } })
    expect(aligned(a, b, 'centerX').pass).toBe(true)
  })
})

describe('bboxMatches', () => {
  const a = meas({ bbox: { width: 100, height: 40 } })
  it('passes when dimensions match within tolerance', () => {
    const b = meas({ bbox: { width: 102, height: 41 } })
    expect(bboxMatches(a, b).pass).toBe(true)
  })
  it('fails when widths diverge', () => {
    const b = meas({ bbox: { width: 200, height: 40 } })
    const r = bboxMatches(a, b)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/width 100 vs 200/)
  })
  it('honors an explicit tolerance', () => {
    const b = meas({ bbox: { width: 110, height: 40 } })
    expect(bboxMatches(a, b, 4).pass).toBe(false)
    expect(bboxMatches(a, b, 20).pass).toBe(true)
  })
})

describe('color helpers', () => {
  it('parses rgb and rgba', () => {
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseCssColor('rgb(255 255 255 / 50%)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
  })
  it('returns null on unparseable input', () => {
    expect(parseCssColor('hotpink')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
  it('computes a known contrast ratio (black on white = 21)', () => {
    const ratio = contrastRatioValue({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })
    expect(ratio).toBeCloseTo(21, 1)
  })
})

describe('contrastRatio', () => {
  it('passes black-on-white (21:1)', () => {
    expect(contrastRatio(meas()).pass).toBe(true)
  })
  it('fails low-contrast gray-on-white against AA', () => {
    const r = contrastRatio(meas({ computedStyle: { color: 'rgb(170, 170, 170)', backgroundColor: 'rgb(255, 255, 255)' } }))
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/below 4.5/)
  })
  it('honors a custom min', () => {
    // ~2.3:1 light gray passes a relaxed 2:1 floor but not 4.5.
    const m = meas({ computedStyle: { color: 'rgb(150, 150, 150)', backgroundColor: 'rgb(255, 255, 255)' } })
    expect(contrastRatio(m, 2).pass).toBe(true)
  })
  it('is indeterminate on a transparent background', () => {
    const r = contrastRatio(meas({ computedStyle: { backgroundColor: 'rgba(0, 0, 0, 0)' } }))
    expect(r.indeterminate).toBe(true)
    expect(r.pass).toBe(false)
  })
  it('is indeterminate on a semi-transparent background', () => {
    const r = contrastRatio(meas({ computedStyle: { backgroundColor: 'rgba(255, 255, 255, 0.5)' } }))
    expect(r.indeterminate).toBe(true)
    expect(r.detail).toMatch(/translucent/)
  })
  it('is indeterminate on semi-transparent text', () => {
    const r = contrastRatio(meas({ computedStyle: { color: 'rgba(0, 0, 0, 0.5)' } }))
    expect(r.indeterminate).toBe(true)
    expect(r.detail).toMatch(/text color is translucent/)
  })
  it('is indeterminate when element opacity < 1 (washed out)', () => {
    const r = contrastRatio(meas({ computedStyle: { color: 'rgb(0,0,0)', backgroundColor: 'rgb(255,255,255)', opacity: '0.2' } }))
    expect(r.indeterminate).toBe(true)
    expect(r.pass).toBe(false)
  })
  it('still measures at full opacity', () => {
    expect(contrastRatio(meas({ computedStyle: { opacity: '1' } })).pass).toBe(true)
  })
})

describe('textEquals', () => {
  it('passes on a normalized match', () => {
    expect(textEquals(meas({ textContent: '  Submit\n ' }), 'Submit').pass).toBe(true)
  })
  it('fails on a mismatch', () => {
    const r = textEquals(meas({ textContent: 'Cancel' }), 'Submit')
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/expected "Submit"/)
  })

  // text-transform normalization: both observed + expected are transformed, so
  // a casing transform never decides the comparison regardless of goal phrasing.
  it('passes under uppercase transform when the goal is authored-case', () => {
    // source "save" rendered "SAVE"; user typed "save".
    const r = textEquals(meas({ textContent: 'save', computedStyle: { textTransform: 'uppercase' } }), 'save')
    expect(r.pass).toBe(true)
  })
  it('passes under uppercase transform when the goal is rendered-case', () => {
    // source "save" rendered "SAVE"; user typed "SAVE".
    const r = textEquals(meas({ textContent: 'save', computedStyle: { textTransform: 'uppercase' } }), 'SAVE')
    expect(r.pass).toBe(true)
  })
  it('passes under lowercase transform', () => {
    const r = textEquals(meas({ textContent: 'SAVE', computedStyle: { textTransform: 'lowercase' } }), 'save')
    expect(r.pass).toBe(true)
  })
  it('passes under capitalize transform regardless of phrasing', () => {
    const r = textEquals(meas({ textContent: 'save now', computedStyle: { textTransform: 'capitalize' } }), 'save now')
    expect(r.pass).toBe(true)
  })
  it('passes capitalize across a punctuation boundary (save-now vs Save-Now)', () => {
    const r = textEquals(meas({ textContent: 'save-now', computedStyle: { textTransform: 'capitalize' } }), 'Save-Now')
    expect(r.pass).toBe(true)
  })
  it('still distinguishes genuinely different text under a transform', () => {
    const r = textEquals(meas({ textContent: 'save', computedStyle: { textTransform: 'uppercase' } }), 'cancel')
    expect(r.pass).toBe(false)
  })
})

describe('applyTextTransform', () => {
  it('handles the keywords + identity', () => {
    expect(applyTextTransform('aB', 'uppercase')).toBe('AB')
    expect(applyTextTransform('aB', 'lowercase')).toBe('ab')
    expect(applyTextTransform('hello world', 'capitalize')).toBe('Hello World')
    // CSS capitalize breaks on punctuation, not just whitespace.
    expect(applyTextTransform('save-now', 'capitalize')).toBe('Save-Now')
    expect(applyTextTransform('a/b c', 'capitalize')).toBe('A/B C')
    expect(applyTextTransform('hello world', 'none')).toBe('hello world')
    expect(applyTextTransform('hello world', '')).toBe('hello world')
  })
})

describe('evaluatePredicate (dispatch)', () => {
  it('routes single-element predicates', () => {
    expect(evaluatePredicate('noOverflow', {}, meas({ scrollWidth: 200, clientWidth: 100 })).pass).toBe(false)
    expect(evaluatePredicate('textEquals', { expected: 'Hi' }, meas({ textContent: 'Hi' })).pass).toBe(true)
  })
  it('routes two-element predicates with the secondary measurements', () => {
    const a = meas({ bbox: { left: 10 } })
    const b = meas({ bbox: { left: 11 } })
    expect(evaluatePredicate('aligned', { other: '.b', axis: 'left' }, a, b).pass).toBe(true)
  })
  it('degrades to indeterminate when the secondary element is missing', () => {
    const r = evaluatePredicate('aligned', { other: '.b', axis: 'left' }, meas(), null)
    expect(r.indeterminate).toBe(true)
  })
  it('degrades to indeterminate when a required arg is absent', () => {
    expect(evaluatePredicate('textEquals', {}, meas()).indeterminate).toBe(true)
    expect(evaluatePredicate('aligned', { other: '.b' }, meas(), meas()).indeterminate).toBe(true)
  })
})

describe('needsSecondElement', () => {
  it('flags exactly the two-element predicates', () => {
    expect(needsSecondElement('aligned')).toBe(true)
    expect(needsSecondElement('bboxMatches')).toBe(true)
    expect(needsSecondElement('noOverflow')).toBe(false)
    expect(needsSecondElement('contrastRatio')).toBe(false)
  })
})
