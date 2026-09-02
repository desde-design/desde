import { describe, expect, it } from 'vitest'
import { extractJsxInterpolationKey } from './extract-jsx-interpolation-key'

/**
 * The refusal set is held to the SAME shape as the Vue extractor's
 * (`extract-slot-interpolation-key.test.ts`). Both feed one server route and
 * one dialog, so a designer must not discover that "this row" means something
 * different depending on which framework they are in.
 */

/** `<Row>` sits on line 3 at column 6 in each fixture below. */
function fixture(child: string): string {
  return [
    'export function List({ items }) {',
    '  return items.map((item) => (',
    `      <Row>${child}</Row>`,
    '  ))',
    '}',
    '',
  ].join('\n')
}
const AT = { line: 3, column: 6, itemVar: 'item' }

describe('extractJsxInterpolationKey', () => {
  it('reads a single-level member access on the iteratee', () => {
    const r = extractJsxInterpolationKey({ source: fixture('{item.label}'), ...AT })
    expect(r).toEqual({ ok: true, propertyKey: 'label' })
  })

  it('refuses static text — nothing is bound to the row', () => {
    const r = extractJsxInterpolationKey({ source: fixture('Logging'), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/static text/)
  })

  it('refuses when the text sits inside a wrapper element', () => {
    const r = extractJsxInterpolationKey({
      source: fixture('<span>{item.title}</span>'),
      ...AT,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/child element/)
  })

  it('refuses the entry itself — there is no single property to patch', () => {
    const r = extractJsxInterpolationKey({ source: fixture('{item}'), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/entry itself/)
  })

  it('refuses nested access — the applicator patches top-level fields only', () => {
    const r = extractJsxInterpolationKey({ source: fixture('{item.title.text}'), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/nested property/)
  })

  it('refuses a computed expression', () => {
    const r = extractJsxInterpolationKey({
      source: fixture('{item.label.toUpperCase()}'),
      ...AT,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not a simple member access/)
  })

  it('refuses bracket access — `computed` is the discriminator, not a regex', () => {
    const r = extractJsxInterpolationKey({ source: fixture('{item["label"]}'), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/Computed member access/)
  })

  it('refuses a root that is not the iteratee', () => {
    // The guard that stops a stray variable in the same element being read as
    // the iteration field.
    const r = extractJsxInterpolationKey({ source: fixture('{other.label}'), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/does not match the map iteratee/)
  })

  it('refuses two significant children as ambiguous', () => {
    const r = extractJsxInterpolationKey({
      source: fixture('{item.label}{item.suffix}'),
      ...AT,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/ambiguous/)
  })

  it('ignores whitespace-only JSXText — indentation is not content', () => {
    const source = [
      'export function List({ items }) {',
      '  return items.map((item) => (',
      '      <Row>',
      '        {item.label}',
      '      </Row>',
      '  ))',
      '}',
      '',
    ].join('\n')
    expect(extractJsxInterpolationKey({ source, ...AT })).toEqual({
      ok: true,
      propertyKey: 'label',
    })
  })

  it('refuses an element with no content', () => {
    const r = extractJsxInterpolationKey({ source: fixture(''), ...AT })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/no significant slot content/)
  })

  it('refuses a non-identifier iteratee root before parsing anything', () => {
    const r = extractJsxInterpolationKey({
      source: fixture('{item.label}'),
      line: 3,
      column: 6,
      itemVar: 'item.x',
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not a bare identifier/)
  })

  it('refuses when no element sits at the coordinate', () => {
    const r = extractJsxInterpolationKey({
      source: fixture('{item.label}'),
      line: 99,
      column: 0,
      itemVar: 'item',
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/No JSX element found/)
  })

  it('works on TypeScript JSX, not just plain .jsx', () => {
    const source = [
      'type Item = { label: string }',
      'export function List({ items }: { items: Item[] }) {',
      '  return items.map((item) => (',
      '      <Row>{item.label}</Row>',
      '  ))',
      '}',
      '',
    ].join('\n')
    expect(
      extractJsxInterpolationKey({ source, line: 4, column: 6, itemVar: 'item' }),
    ).toEqual({ ok: true, propertyKey: 'label' })
  })
})
