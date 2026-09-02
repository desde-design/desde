import { describe, expect, it } from 'vitest'
import { detectWired } from '../detect-wired.js'
import { generateNextBlock, generateViteBlock } from '../generate-block.js'

describe('detectWired', () => {
  it('does not match an unrelated config', () => {
    const config = `export default defineNuxtConfig({ modules: ['@nuxt/ui'] })`
    expect(detectWired(config, 'nuxt')).toBeNull()
  })

  it('does not match an incidental mention of the product name', () => {
    // A weak marker here would be worse than no marker: claiming "already
    // wired" leaves the user with a prototype that refuses every edit.
    const config = `// TODO: try desde on this project one day\nexport default {}`
    expect(detectWired(config, 'next')).toBeNull()
  })

  it('matches its own generated Vite block', () => {
    const block = generateViteBlock({
      host: 'nuxt',
      framework: 'vue3',
      syntax: 'esm',
      configFileRelative: 'nuxt.config.ts',
    })
    const match = detectWired(block, 'nuxt')
    expect(match?.marker).toBe('.desde/stamp/')
    expect(match?.warnings).toEqual([])
  })

  it('matches its own generated Next block with no warnings', () => {
    const block = generateNextBlock({ syntax: 'esm', typed: false, allowedDevHostnames: ['127.0.0.1'] })
    const match = detectWired(block, 'next')
    expect(match?.marker).toBe('.desde/stamp/')
    expect(match?.warnings).toEqual([])
  })

  it('matches a hand-wired plugin import', () => {
    const config = `import { jsxSourceTagPlugin } from '../../pt-jsx.mjs'\nexport default { plugins: [jsxSourceTagPlugin({ repoRoot: import.meta.dirname })] }`
    expect(detectWired(config, 'react-router')?.marker).toBe('jsxSourceTagPlugin')
  })

  it('warns when a hand-wired Vite plugin has no production gate', () => {
    const config = `import { sourceTagPlugin } from './pt.mjs'\nexport default { plugins: [sourceTagPlugin({ repoRoot: '.' })] }`
    const match = detectWired(config, 'nuxt')
    expect(match?.warnings).toHaveLength(1)
    expect(match?.warnings[0]).toContain("apply: 'serve'")
  })

  it('warns when Next has a *.tsx rule but no *.jsx rule', () => {
    const config = [
      "const loader = './.desde/stamp/next-loader.cjs'",
      "import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'",
      "export default { turbopack: { rules: { '*.tsx': { loaders: [loader] } } }, allowedDevOrigins: ['127.0.0.1'] }",
    ].join('\n')
    const warnings = detectWired(config, 'next')?.warnings ?? []
    expect(warnings.some((w) => w.includes("no '*.jsx' entry"))).toBe(true)
  })

  it('warns loudly when Next is gated on NODE_ENV instead of the phase', () => {
    const config = [
      // Real wiring, not a comment: a commented marker no longer counts as
      // wired, and this test is about the NODE_ENV warning, not about detection.
      "import stamp from './.desde/stamp/next-loader.cjs'",
      "const rules = process.env.NODE_ENV === 'development' ? { '*.tsx': {}, '*.jsx': {} } : {}",
      "export default { turbopack: { rules }, allowedDevOrigins: ['127.0.0.1'] }",
    ].join('\n')
    const warnings = detectWired(config, 'next')?.warnings ?? []
    expect(warnings.some((w) => w.includes('NODE_ENV is ambient'))).toBe(true)
  })

  it('warns when Next has no allowedDevOrigins', () => {
    const config = [
      "import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js'",
      "import stamp from './.desde/stamp/next-loader.cjs'",
      "export default { turbopack: { rules: { '*.tsx': {}, '*.jsx': {} } } }",
    ].join('\n')
    const warnings = detectWired(config, 'next')?.warnings ?? []
    expect(warnings.some((w) => w.includes('allowedDevOrigins'))).toBe(true)
  })
})

/**
 * Regression: a COMMENTED-OUT wiring must not read as wired.
 *
 * The match is substring-based, so before comments were blanked, a user who
 * commented the block out while debugging got `already-wired` — attach mode
 * booted, their dev server had no stamper, and every edit was refused with no
 * warning. That is precisely the failure the gate exists to prevent, so the
 * gate must not inflict it.
 *
 * String literals are deliberately NOT stripped: a real wiring puts the marker
 * inside one.
 */
describe('detectWired — comments are not wiring', () => {
  it('does not match a line-commented marker', () => {
    expect(detectWired(`// import x from './.desde/stamp/next-loader.cjs'\nexport default {}`, 'next')).toBeNull()
  })

  it('does not match a block-commented marker', () => {
    expect(detectWired(`/* jsxSourceTagPlugin was here */\nexport default {}`, 'vite')).toBeNull()
  })

  it('STILL matches a marker inside a string literal — that is a real wiring', () => {
    const wired = detectWired(`import s from './.desde/stamp/next-loader.cjs'`, 'next')
    expect(wired).not.toBeNull()
  })

  it('does not mistake a // inside a string for a comment', () => {
    // The URL's `//` must not blank the rest of the line and hide the marker.
    const text = `const docs = "https://example.com/x"\nimport s from './.desde/stamp/next-loader.cjs'`
    expect(detectWired(text, 'next')).not.toBeNull()
  })

  it('does not let a commented PHASE gate suppress the production-leak warning', () => {
    const text = [
      `import s from './.desde/stamp/next-loader.cjs'`,
      `// PHASE_DEVELOPMENT_SERVER`,
      `export default { turbopack: { rules: { '*.tsx': {}, '*.jsx': {} } }, allowedDevOrigins: ['127.0.0.1'] }`,
    ].join('\n')
    const wired = detectWired(text, 'next')
    expect(wired).not.toBeNull()
    expect(wired!.warnings.join(' ')).toMatch(/PHASE_DEVELOPMENT_SERVER/)
  })
})

/**
 * A template literal's `${…}` is CODE, so a comment inside one is a real
 * comment. Treating the whole backtick region as opaque left a commented
 * marker inside an interpolation matchable — a false "already wired", which
 * boots the user with no stamper. That is the dangerous direction.
 */
describe('detectWired — comments inside template interpolations', () => {
  it('blanks a commented marker inside ${...}', () => {
    const text = 'const s = `x${/* ./.desde/stamp/next-loader.cjs */ 1}y`\nexport default {}'
    expect(detectWired(text, 'next')).toBeNull()
  })

  it('blanks a line comment inside ${...}', () => {
    const text = 'const s = `x${\n  // jsxSourceTagPlugin\n  1\n}y`\nexport default {}'
    expect(detectWired(text, 'vite')).toBeNull()
  })

  it('still treats template TEXT as a string, not code', () => {
    // `//` here is literal text, not a comment: it must not blank the marker
    // that follows on the same line.
    const text = "const u = `https://example.com`\nimport s from './.desde/stamp/next-loader.cjs'"
    expect(detectWired(text, 'next')).not.toBeNull()
  })

  it('finds a marker in a nested interpolation after the template closes', () => {
    const text = 'const a = `${`${1}`}`\nimport s from "./.desde/stamp/next-loader.cjs"'
    expect(detectWired(text, 'next')).not.toBeNull()
  })
})
