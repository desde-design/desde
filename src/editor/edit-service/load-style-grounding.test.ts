import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DesignToken } from '../core/design-tokens'
import { loadStyleGrounding } from './load-style-grounding'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'style-grounding-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const SAMPLE_TOKENS: DesignToken[] = [
  {
    name: '--acme-color-background-primary',
    value: '#0044f4',
    category: 'color',
    source: '@acme/design-tokens',
  },
]

describe('loadStyleGrounding — tokens present', () => {
  it('carries the injected tokens through unchanged and omits rawStyleFallback', () => {
    fs.writeFileSync(
      path.join(root, 'tailwind.config.ts'),
      'export default { theme: {} }',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.tokens).toEqual(SAMPLE_TOKENS)
    expect(ctx.rawStyleFallback).toBeUndefined()
  })

  it('still derives classTaxonomy + preprocessor from .vue files', () => {
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'src', 'components', 'Card.vue'),
      [
        '<template>',
        '  <div class="card card-primary flex">',
        '    <div class="card-header">Title</div>',
        '  </div>',
        '</template>',
        '<style lang="scss">',
        '.card { display: flex; }',
        '</style>',
      ].join('\n'),
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.classTaxonomy).toContain('card')
    expect(ctx.classTaxonomy).toContain('card-primary')
    expect(ctx.preprocessor).toBe('scss')
  })

  // A React prototype's classes live in `className=`, so scanning `class=` in
  // `.vue` only handed the LLM edit lane an empty taxonomy on every React
  // project — the same Vue-only asymmetry the lane's refusal gate had.
  it.each(['Header.tsx', 'Header.jsx'])(
    'derives classTaxonomy from className= in %s',
    (name) => {
      fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true })
      fs.writeFileSync(
        path.join(root, 'src', 'components', name),
        [
          'export function Header() {',
          '  return (',
          '    <header className="bar bar-sticky flex">',
          '      <span className="bar-dot" />',
          '    </header>',
          '  );',
          '}',
        ].join('\n'),
        'utf-8',
      )
      const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
      expect(ctx.classTaxonomy).toContain('bar')
      expect(ctx.classTaxonomy).toContain('bar-sticky')
      expect(ctx.classTaxonomy).toContain('bar-dot')
      // No SFC <style lang> block exists in JSX, so the default stands.
      expect(ctx.preprocessor).toBe('css')
    },
  )

  // Codex review 2026-09-17, P3: matching only double quotes skipped every
  // single-quoted file, in both dialects.
  it('harvests single-quoted class attributes too', () => {
    fs.writeFileSync(
      path.join(root, 'Sq.tsx'),
      "export const S = () => <div className='sq-one sq-two' />;",
      'utf-8',
    )
    fs.writeFileSync(
      path.join(root, 'Sq.vue'),
      "<template><div class='sq-vue' /></template>",
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.classTaxonomy).toContain('sq-one')
    expect(ctx.classTaxonomy).toContain('sq-two')
    expect(ctx.classTaxonomy).toContain('sq-vue')
  })

  it('skips dynamic className expressions, as it does dynamic :class', () => {
    fs.writeFileSync(
      path.join(root, 'Dyn.tsx'),
      'export const D = () => <div className={cn("computed-only")} />;',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.classTaxonomy).not.toContain('computed-only')
  })

  it('defaults preprocessor to css when no <style lang> is found', () => {
    fs.writeFileSync(
      path.join(root, 'App.vue'),
      '<template><div class="root">hi</div></template>',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.preprocessor).toBe('css')
  })

  it('respects taxonomyLimit', () => {
    const classes = Array.from({ length: 10 }, (_, i) => `class-${i}`).join(' ')
    fs.writeFileSync(
      path.join(root, 'App.vue'),
      `<template><div class="${classes}">hi</div></template>`,
      'utf-8',
    )
    const ctx = loadStyleGrounding({
      prototypeRoot: root,
      tokens: SAMPLE_TOKENS,
      taxonomyLimit: 3,
    })
    expect(ctx.classTaxonomy.length).toBeLessThanOrEqual(3)
  })
})

describe('loadStyleGrounding — tokens empty (fallback)', () => {
  it('populates rawStyleFallback with tailwind config text when present', () => {
    fs.writeFileSync(
      path.join(root, 'tailwind.config.ts'),
      'export default { theme: { extend: {} } }',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: [] })
    expect(ctx.tokens).toEqual([])
    expect(ctx.rawStyleFallback).toBeDefined()
    expect(ctx.rawStyleFallback).toContain('## Tailwind config')
    expect(ctx.rawStyleFallback).toContain('extend: {}')
  })

  it('populates rawStyleFallback with a design-token file fragment when present', () => {
    fs.mkdirSync(path.join(root, 'tokens'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'tokens', 'colors.tokens.json'),
      '{ "--acme-color-background-primary": "#0044f4" }',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: [] })
    expect(ctx.rawStyleFallback).toBeDefined()
    expect(ctx.rawStyleFallback).toContain('## Design tokens (raw)')
    expect(ctx.rawStyleFallback).toContain('--acme-color-background-primary')
  })

  it('leaves rawStyleFallback undefined when neither source exists', () => {
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: [] })
    expect(ctx.rawStyleFallback).toBeUndefined()
  })

  it('does not scan for the raw fallback when tokens are present', () => {
    fs.writeFileSync(
      path.join(root, 'tailwind.config.ts'),
      'export default {}',
      'utf-8',
    )
    const ctx = loadStyleGrounding({ prototypeRoot: root, tokens: SAMPLE_TOKENS })
    expect(ctx.rawStyleFallback).toBeUndefined()
  })
})

describe('loadStyleGrounding — non-existent root', () => {
  it('does not throw and returns an empty-ish context', () => {
    const ctx = loadStyleGrounding({
      prototypeRoot: path.join(root, 'does-not-exist'),
      tokens: [],
    })
    expect(ctx.classTaxonomy).toEqual([])
    expect(ctx.preprocessor).toBe('css')
    expect(ctx.rawStyleFallback).toBeUndefined()
  })
})
