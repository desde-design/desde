import { describe, expect, it } from 'vitest'
import { ledgerFieldsForEdit } from './fields-from-edit'
import { describeLedgerEntry } from './describe-entry'
import type { LedgerEditEntry } from './entry'

function describeWith(edit: Parameters<typeof ledgerFieldsForEdit>[0]): string {
  const entry: LedgerEditEntry = {
    type: 'edit',
    id: 'e1',
    at: '2026-08-18T10:00:00.000Z',
    kind: edit.kind,
    lane: 'direct',
    files: ['src/components/PricingCard.vue'],
    afterHashes: {},
    fields: ledgerFieldsForEdit(edit),
  }
  return describeLedgerEntry(entry)
}

describe('ledgerFieldsForEdit', () => {
  it('carries a prop name and value', () => {
    expect(
      ledgerFieldsForEdit({
        kind: 'prop',
        file: 'a.vue',
        line: 1,
        column: 1,
        propName: 'title',
        value: 'Pricing',
      }),
    ).toEqual({ propName: 'title', value: 'Pricing' })
  })

  it('carries both component names for a swap', () => {
    expect(
      ledgerFieldsForEdit({
        kind: 'swap',
        file: 'a.vue',
        line: 1,
        column: 1,
        fromComponentName: 'KButton',
        toComponentName: 'KSelect',
      }),
    ).toEqual({ fromComponentName: 'KButton', toComponentName: 'KSelect' })
  })

  it('summarises an llm-patch bundle by count, not content', () => {
    expect(
      ledgerFieldsForEdit({
        kind: 'llm-patch',
        mutations: [
          {
            id: 'm1',
            kind: 'text',
            sourceLoc: null,
            resolutionKind: 'direct',
            scope: 'callsite',
            callsiteLoc: null,
            instancePath: '',
            selector: 'p',
            before: 'a',
            after: 'b',
          },
        ],
      }),
    ).toEqual({ mutationCount: 1 })
  })

  it('produces fields the deriver can render for every kind it maps', () => {
    expect(
      describeWith({
        kind: 'token-value',
        file: 'tokens.css',
        tokenName: '--brand',
        newValue: '#0f6e56',
      }),
    ).toBe('--brand = "#0f6e56"')
    expect(
      describeWith({
        kind: 'detach',
        file: 'a.vue',
        line: 1,
        column: 1,
        componentFile: 'b.vue',
        componentName: 'KCard',
      }),
    ).toBe('Detached KCard')
  })

  it('returns undefined for a kind with nothing worth carrying', () => {
    expect(ledgerFieldsForEdit({ kind: 'delete', file: 'a.vue', line: 1, column: 1 }))
      .toBeUndefined()
  })

  // These four cross the mapper -> deriver boundary on purpose: a fixture
  // built by hand-constructing `fields` (as describe-entry.test.ts does)
  // can never catch a mapper that fails to SUPPLY those fields. Each case
  // here starts from a real edit request body, runs it through
  // ledgerFieldsForEdit, then through describeLedgerEntry, and asserts on
  // the rendered string.
  it('crosses mapper -> deriver: scoped-css-override declarations render the properties', () => {
    expect(
      describeWith({
        kind: 'scoped-css-override',
        file: 'a.vue',
        line: 1,
        column: 1,
        declarations: { color: 'red', padding: '4px' },
      }),
    ).toBe('color: red, padding: 4px')
  })

  it('crosses mapper -> deriver: scoped-css-override applyClasses render as added classes', () => {
    expect(
      describeWith({
        kind: 'scoped-css-override',
        file: 'a.vue',
        line: 1,
        column: 1,
        applyClasses: ['p-2', 'gap-4'],
      }),
    ).toBe('Added p-2 gap-4')
  })

  it('crosses mapper -> deriver: jsx-style inline declarations render the properties', () => {
    expect(
      describeWith({
        kind: 'jsx-style',
        file: 'a.tsx',
        line: 1,
        column: 1,
        mode: 'inline',
        declarations: { color: 'red' },
      }),
    ).toBe('color: red')
  })

  it('crosses mapper -> deriver: jsx-style removeClasses render as a removal', () => {
    expect(
      describeWith({
        kind: 'jsx-style',
        file: 'a.tsx',
        line: 1,
        column: 1,
        mode: 'classname',
        removeClasses: ['p-2'],
      }),
    ).toBe('Removed p-2')
  })
})
