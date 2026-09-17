/**
 * The LLM patch lane's dialect classifier. Small surface, but three call sites
 * depend on it agreeing with itself: the refusal gate in `apply-llm-patch.ts`,
 * the system-prompt selection in `llm-patch-prompt.ts`, and the pre-write
 * parse validation in `editor-cli/src/server/edit-handler.ts`.
 */

import { describe, expect, it } from 'vitest'
import { resolvePatchFramework, SUPPORTED_PATCH_EXTENSIONS } from './patch-framework'

describe('resolvePatchFramework', () => {
  it('classifies Vue SFCs', () => {
    expect(resolvePatchFramework('src/components/Card.vue')).toBe('vue')
  })

  it('classifies React modules', () => {
    expect(resolvePatchFramework('src/components/AppHeader.tsx')).toBe('react')
    expect(resolvePatchFramework('src/components/AppHeader.jsx')).toBe('react')
  })

  it('returns null for anything else, so the lane refuses rather than guessing', () => {
    for (const file of [
      'src/styles.scss',
      'src/lib/store.ts',
      'src/lib/store.js',
      'package.json',
      'README.md',
      'src/components/Card.vue.bak',
    ]) {
      expect(resolvePatchFramework(file)).toBeNull()
    }
  })

  it('covers exactly the extensions it advertises', () => {
    for (const ext of SUPPORTED_PATCH_EXTENSIONS) {
      expect(resolvePatchFramework(`src/Thing${ext}`)).not.toBeNull()
    }
  })
})
