/**
 * Tests for `renderStyleGrounding` — the block builder for
 * `ProjectStyleContext` v2 (tokens from the grounding seam +
 * classTaxonomy/preprocessor from the raw component-file scan + an optional
 * raw fallback), plus `buildPatchPrompt`'s framework dialect selection. See
 * `load-style-grounding.test.ts` for the loader itself.
 *
 * Assertions are substring checks against the rendered text, not
 * snapshots — the brief calls for snapshot-free assertions so the block's
 * prose can evolve without a snapshot-update ritual.
 */

import { describe, expect, it } from 'vitest'
import type { DesignToken } from '../core/design-tokens'
import {
  buildPatchPrompt,
  renderStyleGrounding,
  type ProjectStyleContext,
} from './llm-patch-prompt'
import type { Mutation } from '../core/edit'

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

/** Minimal style context — the dialect tests care about the system block only. */
const EMPTY_STYLE_CONTEXT: ProjectStyleContext = {
  tokens: [],
  classTaxonomy: [],
  preprocessor: 'css',
}

function makeTextMutation(sourceLoc: string): Mutation {
  return {
    id: 'm-1',
    kind: 'text',
    sourceLoc,
    resolutionKind: 'direct',
    scope: 'definition',
    callsiteLoc: null,
    instancePath: '[0]',
    selector: '[data-testid="title"]',
    before: 'Sooth',
    after: 'Sayer',
  }
}

function promptFor(file: string, source: string) {
  const out = buildPatchPrompt({
    file,
    originalSource: source,
    mutations: [makeTextMutation(`${file}:1:1`)],
    projectStyleContext: EMPTY_STYLE_CONTEXT,
  })
  return {
    system: out.systemBlocks.map((b) => b.text).join('\n'),
    user: out.userContent.map((b) => b.text).join('\n'),
  }
}

describe('buildPatchPrompt — framework dialect', () => {
  it('describes a Vue SFC in Vue terms', () => {
    const { system } = promptFor('src/Card.vue', '<template><h1>Sooth</h1></template>')
    expect(system).toContain('Vue Single-File Component')
    expect(system).toContain('{{ expr }}')
    expect(system).toContain('v-for template')
    expect(system).not.toContain('React/JSX source-patching engine')
  })

  it.each(['src/AppHeader.tsx', 'src/AppHeader.jsx'])(
    'describes %s in React terms',
    (file) => {
      const { system } = promptFor(file, 'export const H = () => <h1>Sooth</h1>;')
      expect(system).toContain('React/JSX source-patching engine')
      expect(system).toContain('className')
      expect(system).toContain('.map()')
      expect(system).not.toContain('Vue Single-File Component')
      expect(system).not.toContain('v-model')
    },
  )

  it('tells the React dialect to escape JSX-structural characters in the new text', () => {
    const { system } = promptFor('src/AppHeader.tsx', 'export const H = () => <h1>Sooth</h1>;')
    expect(system).toContain('&#123;')
    expect(system).toContain('&lt;')
  })

  // Codex review 2026-09-17, P1: the escaping rule omitted `&`, which
  // `escapeJsxText` escapes FIRST. Without it, a designer who types the literal
  // characters `&lt;b&gt;` gets `<b>` rendered.
  it('tells the React dialect to escape & first, not just the structural characters', () => {
    const { system } = promptFor('src/AppHeader.tsx', 'export const H = () => null;')
    expect(system).toContain('&amp;')
    expect(system).toMatch(/`&` → `&amp;` FIRST/)
    // And the two concrete traps are spelled out, not left to inference.
    expect(system).toContain('Add &#123;n&#125;')
    expect(system).toContain('&amp;lt;b&amp;gt;')
  })

  // Codex review 2026-09-17, P2: React has no attribute fallthrough, so Vue's
  // "add the absent prop" rule is unsound on a component call-site — the file
  // changes, every check passes, and nothing renders.
  it('lets React add an absent attribute on a DOM tag but refuses one on a component', () => {
    const { system } = promptFor('src/AppHeader.tsx', 'export const H = () => null;')
    expect(system).toContain('React has NO attribute fallthrough')
    expect(system).toContain('prop-not-passed-at-callsite')
    expect(system).toContain('a bare lowercase name with no dot')
    expect(system).toContain('Anything else is a component')
    // Codex delta review 2026-09-17, P3: `<ui.Button />` has a lowercase base
    // but is a component, so the first cut of this rule authorized adding a
    // prop that would be silently ignored.
    expect(system).toContain('member expression WHATEVER its base case')
    expect(system).toContain('<ui.Button>')
    // Vue keeps its own rule, which is correct there.
    const vue = promptFor('src/Card.vue', '<template></template>').system
    expect(vue).toContain('attr on a prop the call-site doesn\'t yet pass**: add it')
    expect(vue).not.toContain('prop-not-passed-at-callsite')
  })

  // Codex review 2026-09-17, P3: three examples are not a mapping. A mutation
  // targeting DOM `maxlength` against source `maxLength={10}` had no rule.
  it('states the DOM-to-JSX attribute mapping as a rule, not a short list', () => {
    const { system } = promptFor('src/AppHeader.tsx', 'export const H = () => null;')
    expect(system).toContain('multi-word DOM attributes are camelCase in JSX')
    expect(system).toContain('maxLength')
    expect(system).toContain('`data-*` and `aria-*` keep their hyphens')
    expect(system).toContain('never add a second lowercase copy')
  })

  it('keeps the shared contract, outcome and determinism rules in both dialects', () => {
    const vue = promptFor('src/Card.vue', '<template></template>').system
    const react = promptFor('src/Card.tsx', 'export const C = () => null;').system
    for (const system of [vue, react]) {
      expect(system).toContain('# Outcome semantics (precise)')
      expect(system).toContain('Determinism: re-running with the same inputs')
      expect(system).toContain('V1 only handles `text` and `attr` mutations')
      expect(system).toContain('# Cross-file rewriting rules')
    }
  })

  it('fences the source block with the file\'s own language', () => {
    expect(promptFor('src/Card.vue', 'X').user).toContain('```vue\nX\n```')
    expect(promptFor('src/Card.tsx', 'X').user).toContain('```tsx\nX\n```')
    expect(promptFor('src/Card.jsx', 'X').user).toContain('```jsx\nX\n```')
  })
})
