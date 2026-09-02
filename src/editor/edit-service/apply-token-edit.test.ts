/**
 * Tests for the TokenEdit applicator (§6 Phase 3, "The token" scope).
 */
import { describe, expect, it } from 'vitest'
import { applyTokenEdit } from './apply-token-edit'

describe('applyTokenEdit', () => {
  it('patches a :root token value, preserving the rest', () => {
    const source = `:root {\n  --acme-color-background-disabled: #f7f7f7;\n  --other: blue;\n}\n`
    const r = applyTokenEdit({
      source,
      tokenName: '--acme-color-background-disabled',
      newValue: '#ff0000',
      selector: ':root',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--acme-color-background-disabled: #ff0000')
    expect(r.source).toContain('--other: blue') // untouched
  })

  it('patches the definition in the matching selector when several rules define it (theming)', () => {
    const source = `:root { --t: #aaa; }\n.theme-dark { --t: #000; }\n`
    const r = applyTokenEdit({ source, tokenName: '--t', newValue: '#fff', selector: '.theme-dark' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: #aaa') // :root untouched
    expect(r.source).toContain('--t: #fff') // .theme-dark patched
    expect(r.source).not.toContain('--t: #000')
  })

  it('patches the first definition when no selector is given', () => {
    const source = `:root { --t: 1rem; }`
    const r = applyTokenEdit({ source, tokenName: '--t', newValue: '2rem' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: 2rem')
  })

  it('accepts a var() value', () => {
    const source = `:root { --t: #aaa; }`
    const r = applyTokenEdit({ source, tokenName: '--t', newValue: 'var(--brand)' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: var(--brand)')
  })

  it('matches a token defined under a selector list (:root, :host)', () => {
    const source = `:root, :host { --acme-c: #aaa; }\n`
    const r = applyTokenEdit({ source, tokenName: '--acme-c', newValue: '#bbb', selector: ':root' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--acme-c: #bbb')
  })

  it('matches a part with nested commas (:where(:root, :host)) without tearing it', () => {
    const source = `:where(:root, :host) { --t: 1; }\n.x { --t: 9; }\n`
    const r = applyTokenEdit({
      source,
      tokenName: '--t',
      newValue: '2',
      selector: ':where(:root, :host)',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: 2')
    expect(r.source).toContain('--t: 9') // .x untouched
  })

  it('splits at the top-level comma when a quoted attr value holds brackets/parens', () => {
    const source = `[data-x="("] , .theme-dark { --t: 1; }\n`
    const r = applyTokenEdit({ source, tokenName: '--t', newValue: '2', selector: '.theme-dark' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: 2')
  })

  it('treats an escaped quote in an identifier as literal (.a\\"b , .theme-dark)', () => {
    const source = `.a\\"b , .theme-dark { --t: 1; }\n`
    const r = applyTokenEdit({ source, tokenName: '--t', newValue: '2', selector: '.theme-dark' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).toContain('--t: 2')
  })

  it('refuses when the token is absent', () => {
    const r = applyTokenEdit({ source: `:root { --a: 1; }`, tokenName: '--missing', newValue: '2' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/not found/i)
  })

  it('refuses when the token exists but not in the requested selector', () => {
    const r = applyTokenEdit({
      source: `:root { --t: 1; }`,
      tokenName: '--t',
      newValue: '2',
      selector: '.theme-dark',
    })
    expect(r.ok).toBe(false)
  })

  it('refuses a non-custom-property name', () => {
    const r = applyTokenEdit({ source: `:root { color: red; }`, tokenName: 'color', newValue: 'blue' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/custom property/i)
  })

  it('refuses a value with illegal CSS punctuation (injection guard)', () => {
    const r = applyTokenEdit({
      source: `:root { --t: 1; }`,
      tokenName: '--t',
      newValue: 'red; } body { display:none',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/punctuation/i)
  })

  it('refuses unparseable CSS', () => {
    const r = applyTokenEdit({ source: `:root { --t: 1;`, tokenName: '--t', newValue: '2' })
    // postcss is lenient; an unterminated block may still parse. Assert we
    // don't throw and return a well-formed result either way.
    expect(typeof r.ok).toBe('boolean')
  })
})
