/**
 * Tests for `renderStyleGrounding` — the block builder for
 * `ProjectStyleContext` v2 (tokens from the grounding seam +
 * classTaxonomy/preprocessor from the raw `.vue` scan + an optional raw
 * fallback). See `load-style-grounding.test.ts` for the loader itself.
 *
 * Assertions are substring checks against the rendered text, not
 * snapshots — the brief calls for snapshot-free assertions so the block's
 * prose can evolve without a snapshot-update ritual.
 */

import { describe, expect, it } from 'vitest'
import type { DesignToken } from '../core/design-tokens'
import { renderStyleGrounding, type ProjectStyleContext } from './llm-patch-prompt'

function makeToken(overrides: Partial<DesignToken> = {}): DesignToken {
  return {
    name: '--acme-color-background-primary',
    value: '#0044f4',
    category: 'color',
    source: '@acme/design-tokens',
    ...overrides,
  }
}

describe('renderStyleGrounding', () => {
  it('renders preprocessor and taxonomy when tokens are empty', () => {
    const ctx: ProjectStyleContext = {
      tokens: [],
      classTaxonomy: ['btn', 'btn-primary'],
      preprocessor: 'scss',
    }
    const out = renderStyleGrounding(ctx)
    expect(out).toContain('Preprocessor: scss')
    expect(out).toContain('## Most-used class names in this prototype')
    expect(out).toContain('btn, btn-primary')
    expect(out).not.toContain('## Design tokens')
  })

  it('renders a ## Design tokens section grouped by category when tokens are present', () => {
    const ctx: ProjectStyleContext = {
      tokens: [
        makeToken({ name: '--acme-color-a', category: 'color' }),
        makeToken({ name: '--acme-space-a', value: '4px', category: 'space' }),
      ],
      classTaxonomy: [],
      preprocessor: 'css',
    }
    const out = renderStyleGrounding(ctx)
    expect(out).toContain('## Design tokens')
    expect(out).toContain('### color')
    expect(out).toContain('--acme-color-a')
    expect(out).toContain('### space')
    expect(out).toContain('--acme-space-a')
  })

  it('includes a token description when present', () => {
    const ctx: ProjectStyleContext = {
      tokens: [makeToken({ description: 'Primary brand background.' })],
      classTaxonomy: [],
      preprocessor: 'css',
    }
    const out = renderStyleGrounding(ctx)
    expect(out).toContain('Primary brand background.')
  })

  it('caps a single category at 40 tokens and summarizes the rest', () => {
    const tokens = Array.from({ length: 55 }, (_, i) =>
      makeToken({ name: `--acme-color-${i}` }),
    )
    const ctx: ProjectStyleContext = {
      tokens,
      classTaxonomy: [],
      preprocessor: 'css',
    }
    const out = renderStyleGrounding(ctx)
    for (let i = 0; i < 40; i++) {
      expect(out).toContain(`--acme-color-${i}`)
    }
    for (let i = 40; i < 55; i++) {
      expect(out).not.toContain(`--acme-color-${i}\``)
    }
    expect(out).toContain('…and 15 more color tokens')
  })

  it('caps the aggregate at 200 tokens across categories', () => {
    const tokens: DesignToken[] = [
      ...Array.from({ length: 40 }, (_, i) =>
        makeToken({ name: `--acme-color-${i}`, category: 'color' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makeToken({ name: `--acme-space-${i}`, value: '4px', category: 'space' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makeToken({ name: `--acme-font-size-${i}`, value: '12px', category: 'font-size' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makeToken({ name: `--acme-font-weight-${i}`, value: '400', category: 'font-weight' }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        makeToken({ name: `--acme-line-height-${i}`, value: '1.5', category: 'line-height' }),
      ),
      // 200 tokens above the total cap already; these should be entirely
      // summarized, not rendered as individual bullet lines.
      ...Array.from({ length: 10 }, (_, i) =>
        makeToken({ name: `--acme-shadow-${i}`, value: '0 1px 2px', category: 'shadow' }),
      ),
    ]
    const out = renderStyleGrounding({ tokens, classTaxonomy: [], preprocessor: 'css' })
    expect(out).not.toContain('--acme-shadow-0')
    expect(out).toContain('…and 10 more shadow tokens')
  })

  it('renders app-stylesheets tokens before package tokens within a category, so the 40-cap never crowds them out', () => {
    const kuiTokens = Array.from({ length: 50 }, (_, i) =>
      makeToken({ name: `--acme-color-${i}`, category: 'color', source: '@acme/design-tokens' }),
    )
    const appTokens = ['--app-color-brand', '--app-color-accent', '--app-color-muted'].map(
      (name) => makeToken({ name, category: 'color', source: 'app-stylesheets' }),
    )
    // App tokens interleaved at the END of the input list — if render order
    // just mirrored input order, the 40-per-category cap would drop all 3.
    const ctx: ProjectStyleContext = {
      tokens: [...kuiTokens, ...appTokens],
      classTaxonomy: [],
      preprocessor: 'css',
    }
    const out = renderStyleGrounding(ctx)
    for (const token of appTokens) {
      expect(out).toContain(token.name)
    }
  })

  it('renders rawStyleFallback verbatim only when present', () => {
    const withFallback: ProjectStyleContext = {
      tokens: [],
      classTaxonomy: [],
      preprocessor: 'css',
      rawStyleFallback: '## Tailwind config\n\n```ts\nexport default {}\n```\n',
    }
    const out = renderStyleGrounding(withFallback)
    expect(out).toContain('## Tailwind config')
    expect(out).toContain('export default {}')

    const withoutFallback: ProjectStyleContext = {
      tokens: [],
      classTaxonomy: [],
      preprocessor: 'css',
    }
    expect(renderStyleGrounding(withoutFallback)).not.toContain('## Tailwind config')
  })
})
