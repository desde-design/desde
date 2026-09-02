/**
 * Pins `kebabCase`'s behavior (shared by local-vue/local-react manifest
 * ids) AND the deliberate divergence from `component-meta/normalize.ts`'s own
 * `kebabCase` (audit Task 20, item 3). The two were NOT unified: on a
 * consecutive-capital name — the single-letter-prefix convention many design
 * systems use (`XPanel`, `UIButton`, ...) — they disagree, and unifying would
 * silently change every manifest id produced by the component-meta path.
 */
import { describe, expect, it } from 'vitest'
import { kebabCase } from './kebab-case'
import { kebabCase as componentMetaKebabCase } from './component-meta/normalize'

describe('kebabCase (local-vue / local-react)', () => {
  it('dashes at a lowercase-to-uppercase transition', () => {
    expect(kebabCase('MyButton')).toBe('my-button')
    expect(kebabCase('metricsCard')).toBe('metrics-card')
  })

  it('does not dash consecutive capitals (no lowercase/digit before the second)', () => {
    // "X" is never preceded by a lowercase/digit, so no dash is inserted —
    // this is the point of divergence from component-meta's kebabCase below.
    expect(kebabCase('XPanel')).toBe('xpanel')
  })

  it('normalizes whitespace/underscores to dashes', () => {
    expect(kebabCase('user_avatar')).toBe('user-avatar')
    expect(kebabCase('user avatar')).toBe('user-avatar')
  })
})

describe('kebabCase divergence: local-vue/react vs component-meta', () => {
  it('agrees on ordinary PascalCase/camelCase names', () => {
    for (const name of ['MyButton', 'metricsCard', 'AppHeader', 'userAvatar']) {
      expect(kebabCase(name)).toBe(componentMetaKebabCase(name))
    }
  })

  it('disagrees on consecutive-capital (single-letter-prefix) names — documented, not a bug', () => {
    // component-meta dashes EVERY capital, including a leading one;
    // local-vue/react only dashes a capital that follows a lowercase/digit.
    expect(componentMetaKebabCase('XPanel')).toBe('x-panel')
    expect(kebabCase('XPanel')).toBe('xpanel')
    expect(kebabCase('XPanel')).not.toBe(componentMetaKebabCase('XPanel'))
  })
})
