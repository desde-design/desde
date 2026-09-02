import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CssCustomPropertiesTokenSource } from './index'

describe('CssCustomPropertiesTokenSource', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-custom-properties-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists tokens from :root and @theme blocks with correct stamps', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(
      cssPath,
      [
        ':root {',
        '  --color-primary: #0044f4; /** Primary brand color. */',
        '}',
        '@theme {',
        '  --color-accent: oklch(0.7 0.15 200);',
        '  --spacing-md: 12px;',
        '}',
      ].join('\n'),
    )

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const tokens = await source.listTokens()

    expect(tokens).toContainEqual({
      name: '--color-primary',
      value: '#0044f4',
      category: 'color',
      description: 'Primary brand color.',
      source: 'app-stylesheets',
    })
    // Inside @theme, default classifier is tailwindThemeClassifier.
    expect(tokens.find((t) => t.name === '--color-accent')).toMatchObject({
      category: 'color',
      source: 'app-stylesheets',
    })
    expect(tokens.find((t) => t.name === '--spacing-md')).toMatchObject({
      category: 'space',
      source: 'app-stylesheets',
    })

    expect(source.id).toBe('app-tokens')
    expect(source.designSystem).toBe('generic')
  })

  it('skips missing files silently and still parses the remaining ones', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(cssPath, ':root {\n  --color-primary: #0044f4;\n}')
    const missingPath = path.join(tmpDir, 'does-not-exist.css')

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [missingPath, cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const tokens = await source.listTokens()
    expect(tokens).toEqual([
      {
        name: '--color-primary',
        value: '#0044f4',
        category: 'color',
        source: 'app-stylesheets',
      },
    ])
  })

  it('memoizes listTokens() across calls when the file is unchanged', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(cssPath, ':root {\n  --color-primary: #0044f4;\n}')

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const first = await source.listTokens()
    const second = await source.listTokens()

    // Same array reference — no reload when the mtime+size fingerprint is
    // unchanged.
    expect(second).toBe(first)
  })

  it('reloads when a known css file is mutated (mtime+size fingerprint changed)', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(cssPath, ':root {\n  --color-primary: #0044f4;\n}')

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const first = await source.listTokens()
    expect(first.find((t) => t.name === '--color-primary')).toBeDefined()

    // Mutate the file after the first successful load (Phase 2 carry-forward
    // I1 — app-token mtime invalidation). The new content differs in byte
    // size from the original, so the fingerprint changes even on filesystems
    // with coarse mtime resolution.
    fs.writeFileSync(cssPath, ':root {\n  --color-secondary: #123456;\n}')
    const second = await source.listTokens()

    expect(second).not.toBe(first)
    expect(second.find((t) => t.name === '--color-secondary')).toBeDefined()
    expect(second.find((t) => t.name === '--color-primary')).toBeUndefined()
  })

  it('fingerprint() changes when a file is mutated and treats a missing file as 0', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(cssPath, ':root {\n  --color-primary: #0044f4;\n}')
    const missingPath = path.join(tmpDir, 'does-not-exist.css')

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [missingPath, cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const before = source.fingerprint()
    expect(before.startsWith('0,')).toBe(true)

    fs.writeFileSync(cssPath, ':root {\n  --color-secondary: #123456;\n}')
    const after = source.fingerprint()

    expect(after).not.toBe(before)
  })

  it('getToken() round-trips a single token by name', async () => {
    const cssPath = path.join(tmpDir, 'tokens.css')
    fs.writeFileSync(
      cssPath,
      ':root {\n  --color-primary: #0044f4;\n  --spacing-md: 12px;\n}',
    )

    const source = new CssCustomPropertiesTokenSource({
      id: 'app-tokens',
      designSystem: 'generic',
      cssFiles: [cssPath],
      sourceLabel: 'app-stylesheets',
    })

    const token = await source.getToken('--spacing-md')
    expect(token).toMatchObject({ name: '--spacing-md', value: '12px' })
    expect(await source.getToken('--does-not-exist')).toBeNull()
  })
})
