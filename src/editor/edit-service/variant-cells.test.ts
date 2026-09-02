import { describe, expect, it } from 'vitest'
import { buildVariantCells } from './variant-cells'
import type { VariantAxis } from './component-catalog'

describe('buildVariantCells', () => {
  it('returns empty array when no hints', () => {
    expect(buildVariantCells([])).toEqual([])
  })

  it('emits one cell per (axis × value) with label and prop set', () => {
    const hints: VariantAxis[] = [
      { prop: 'appearance', values: ['primary', 'danger'], label: 'appearance' },
    ]
    expect(buildVariantCells(hints)).toEqual([
      { label: 'appearance: primary', props: { appearance: 'primary' } },
      { label: 'appearance: danger', props: { appearance: 'danger' } },
    ])
  })

  it('attaches default-slot text when componentName is provided', () => {
    // Components like KButton render invisibly without slot content.
    // Passing componentName makes each cell carry visible text.
    const hints: VariantAxis[] = [
      { prop: 'appearance', values: ['primary'] },
    ]
    const cells = buildVariantCells(hints, 'KButton')
    expect(cells[0]).toEqual({
      label: 'appearance: primary',
      props: { appearance: 'primary' },
      children: 'KButton',
    })
  })

  it('renders rows-by-axis (each cell varies only its own axis)', () => {
    // Verifies the design choice: NOT cartesian product. A 2-axis
    // component yields axis1.length + axis2.length cells, not
    // axis1.length * axis2.length.
    const hints: VariantAxis[] = [
      { prop: 'size', values: ['sm', 'lg'], label: 'size' },
      { prop: 'disabled', values: [false, true], label: 'disabled' },
    ]
    const cells = buildVariantCells(hints)
    expect(cells).toHaveLength(4)
    // Each cell sets exactly one prop.
    for (const cell of cells) {
      expect(Object.keys(cell.props)).toHaveLength(1)
    }
  })

  it('falls back to prop name when label is missing', () => {
    const hints: VariantAxis[] = [
      { prop: 'size', values: ['sm'] },
    ]
    expect(buildVariantCells(hints)[0].label).toBe('size: sm')
  })

  it('caps each axis at 8 values', () => {
    const hints: VariantAxis[] = [
      {
        prop: 'shade',
        values: Array.from({ length: 12 }, (_, i) => `c${i}`),
      },
    ]
    expect(buildVariantCells(hints)).toHaveLength(8)
  })

  it('caps the total grid at 24 cells across axes', () => {
    // 4 axes × 8 values = 32 → should clip to 24.
    const hints: VariantAxis[] = Array.from({ length: 4 }, (_, i) => ({
      prop: `axis${i}`,
      values: Array.from({ length: 8 }, (_, j) => `v${j}`),
    }))
    expect(buildVariantCells(hints)).toHaveLength(24)
  })

  it('serializes boolean and number values into the label', () => {
    const hints: VariantAxis[] = [
      { prop: 'disabled', values: [false, true] },
      { prop: 'level', values: [1, 2, 3] },
    ]
    const cells = buildVariantCells(hints)
    expect(cells.map((c) => c.label)).toEqual([
      'disabled: false',
      'disabled: true',
      'level: 1',
      'level: 2',
      'level: 3',
    ])
  })
})
