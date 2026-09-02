/**
 * Tests for the Tailwind global-important-mode detector. The bias under test is
 * CONSERVATISM: a false positive needlessly steers the user away from a style
 * scope that works, so "can't tell" must read as not-detected.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  cssEnablesTailwindImportantMode,
  configEnablesTailwindImportantMode,
  detectTailwindImportantMode,
} from './detect-important-utilities'

describe('cssEnablesTailwindImportantMode', () => {
  it('matches the canonical v4 spelling', () => {
    expect(cssEnablesTailwindImportantMode('@import "tailwindcss" important;')).toBe(true)
  })

  it('matches single quotes', () => {
    expect(cssEnablesTailwindImportantMode("@import 'tailwindcss' important;")).toBe(true)
  })

  it('matches extra / irregular whitespace and a trailing space before the semicolon', () => {
    expect(
      cssEnablesTailwindImportantMode('@import   "tailwindcss"    important  ;'),
    ).toBe(true)
    expect(cssEnablesTailwindImportantMode('@import\n  "tailwindcss"\n  important;')).toBe(
      true,
    )
  })

  it('matches alongside other v4 import options, in either order', () => {
    expect(
      cssEnablesTailwindImportantMode('@import "tailwindcss" source(none) important;'),
    ).toBe(true)
    expect(
      cssEnablesTailwindImportantMode('@import "tailwindcss" important prefix(tw);'),
    ).toBe(true)
  })

  it('matches a subpath import (the split-entrypoint form)', () => {
    expect(
      cssEnablesTailwindImportantMode(
        '@import "tailwindcss/utilities" layer(utilities) important;',
      ),
    ).toBe(true)
  })

  it('matches a url()-wrapped specifier', () => {
    expect(
      cssEnablesTailwindImportantMode('@import url("tailwindcss") important;'),
    ).toBe(true)
  })

  it('matches when the file has other rules around the import', () => {
    const css = [
      '@charset "utf-8";',
      '@import "./reset.css";',
      '@import "tailwindcss" important;',
      ':root { --brand: #123456; }',
    ].join('\n')
    expect(cssEnablesTailwindImportantMode(css)).toBe(true)
  })

  it('does NOT match an ordinary Tailwind import', () => {
    expect(cssEnablesTailwindImportantMode('@import "tailwindcss";')).toBe(false)
  })

  it('does NOT match an import with other options but no important', () => {
    expect(
      cssEnablesTailwindImportantMode('@import "tailwindcss" source(none) prefix(tw);'),
    ).toBe(false)
    expect(
      cssEnablesTailwindImportantMode('@import "tailwindcss/utilities" layer(utilities);'),
    ).toBe(false)
  })

  it('does NOT match a commented-out important import', () => {
    expect(
      cssEnablesTailwindImportantMode('/* @import "tailwindcss" important; */'),
    ).toBe(false)
    expect(
      cssEnablesTailwindImportantMode(
        ['/*', '  @import "tailwindcss" important;', '*/', '@import "tailwindcss";'].join(
          '\n',
        ),
      ),
    ).toBe(false)
  })

  it('does NOT match an unrelated use of the word important', () => {
    // `!important` on an ordinary declaration, an import of a DIFFERENT package,
    // and a selector/property that merely contains the substring.
    expect(
      cssEnablesTailwindImportantMode(
        [
          '@import "tailwindcss";',
          '@import "some-other-lib" important;',
          '.important { color: red !important; }',
          '/* important: read the docs */',
        ].join('\n'),
      ),
    ).toBe(false)
  })

  it('does NOT match `importantly` or a glued token (must be its own word)', () => {
    expect(cssEnablesTailwindImportantMode('@import "tailwindcss" importantly;')).toBe(
      false,
    )
    expect(
      cssEnablesTailwindImportantMode('@import "tailwindcss" source(important);'),
    ).toBe(false)
  })
})

describe('configEnablesTailwindImportantMode', () => {
  it('matches `important: true` in an ESM config', () => {
    const src = [
      'export default {',
      "  content: ['./src/**/*.vue'],",
      '  important: true,',
      '}',
    ].join('\n')
    expect(configEnablesTailwindImportantMode(src)).toBe(true)
  })

  it('matches a CJS config, a quoted key, and no trailing comma', () => {
    expect(configEnablesTailwindImportantMode('module.exports = { important: true }')).toBe(
      true,
    )
    expect(configEnablesTailwindImportantMode('module.exports = { "important": true }')).toBe(
      true,
    )
  })

  it('does NOT match a config without the flag', () => {
    expect(
      configEnablesTailwindImportantMode(
        ['export default {', "  content: ['./src/**/*.tsx'],", '  theme: {},', '}'].join(
          '\n',
        ),
      ),
    ).toBe(false)
  })

  it('does NOT match `important: false` or the v3 selector strategy', () => {
    expect(configEnablesTailwindImportantMode('export default { important: false }')).toBe(
      false,
    )
    // `important: '#app'` adds specificity, not `!important` — a different mechanism.
    expect(configEnablesTailwindImportantMode("export default { important: '#app' }")).toBe(
      false,
    )
  })

  it('does NOT match a commented-out flag (line or block)', () => {
    expect(
      configEnablesTailwindImportantMode(
        ['export default {', '  // important: true,', '}'].join('\n'),
      ),
    ).toBe(false)
    expect(
      configEnablesTailwindImportantMode(
        ['export default {', '  /* important: true, */', '}'].join('\n'),
      ),
    ).toBe(false)
  })

  it('does NOT match a longer identifier that ends in important', () => {
    expect(configEnablesTailwindImportantMode('export default { notImportant: true }')).toBe(
      false,
    )
    expect(
      configEnablesTailwindImportantMode('export default { veryimportant: true }'),
    ).toBe(false)
  })
})

describe('detectTailwindImportantMode (filesystem)', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-important-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function write(rel: string, content: string): void {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }

  it('detects the v4 import modifier in a nested app stylesheet', async () => {
    write('src/styles/main.css', '@import "tailwindcss" important;\n')
    const result = await detectTailwindImportantMode(root)
    expect(result.detected).toBe(true)
    expect(result.evidence?.signal).toBe('v4-import-important')
    expect(result.evidence?.file).toContain('main.css')
  })

  it('detects the v3 config flag', async () => {
    write('tailwind.config.ts', 'export default { important: true }\n')
    const result = await detectTailwindImportantMode(root)
    expect(result.detected).toBe(true)
    expect(result.evidence?.signal).toBe('v3-config-important')
  })

  it('reports not-detected for an ordinary Tailwind project', async () => {
    write('src/index.css', '@import "tailwindcss";\n')
    write('tailwind.config.js', 'module.exports = { content: [] }\n')
    const result = await detectTailwindImportantMode(root)
    expect(result.detected).toBe(false)
    expect(result.evidence).toBeUndefined()
  })

  it('reports not-detected for a project with no CSS and no config', async () => {
    write('package.json', '{}')
    expect((await detectTailwindImportantMode(root)).detected).toBe(false)
  })

  it('ignores node_modules (a dependency’s own important import is not the app’s)', async () => {
    write('node_modules/some-lib/dist/lib.css', '@import "tailwindcss" important;\n')
    expect((await detectTailwindImportantMode(root)).detected).toBe(false)
  })

  it('does not throw on a nonexistent root (fails closed)', async () => {
    const result = await detectTailwindImportantMode(path.join(root, 'nope'))
    expect(result.detected).toBe(false)
  })
})
