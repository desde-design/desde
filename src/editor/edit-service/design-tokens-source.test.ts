import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDesignTokenSources,
  loadDesignTokens,
  TOKEN_SOURCE_ORDER,
} from './design-tokens-source'
import { CompositeDesignTokenSource } from '../adapters/composite-tokens'
import type { DesignTokenSource } from '../core/design-tokens'

describe('TOKEN_SOURCE_ORDER', () => {
  it('is pinned to app-stylesheets, package-css', () => {
    expect(TOKEN_SOURCE_ORDER).toEqual(['app-stylesheets', 'package-css'])
  })
})

describe('buildDesignTokenSources / loadDesignTokens', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
  })

  async function mkPrototype(pkgJson: Record<string, unknown> = {}): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'design-tokens-source-'))
    tmpDirs.push(root)
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0', ...pkgJson }),
    )
    return root
  }

  /**
   * Install a design-system package that publishes token CSS at the
   * conventional `dist/tokens/css/custom-properties.css` path. It must ALSO
   * be a declared dependency with a token-ish name — that is exactly what
   * `discoverTokenStylesheets` uses to bound its probe, and it is the whole
   * discovery path now that there is no per-vendor preset.
   */
  const TOKEN_PACKAGE = '@acme/design-tokens'

  async function addTokenPackage(root: string, css: string): Promise<void> {
    const dir = path.join(root, 'node_modules', '@acme', 'design-tokens', 'dist', 'tokens', 'css')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'custom-properties.css'), css)
    await fs.writeFile(
      path.join(root, 'node_modules', '@acme', 'design-tokens', 'package.json'),
      JSON.stringify({ name: TOKEN_PACKAGE, version: '1.0.0' }),
    )
  }

  it('builds sources in TOKEN_SOURCE_ORDER (app-stylesheets before package-css)', async () => {
    const root = await mkPrototype({ dependencies: { [TOKEN_PACKAGE]: '^1.0.0' } })
    await addTokenPackage(root, ':root {\n  --space-50: 12px;\n}')
    await fs.writeFile(path.join(root, 'tokens.css'), ':root {\n  --color-primary: #000;\n}')

    const sources = await buildDesignTokenSources(root)

    expect(sources.map((s) => s.id)).toEqual(['app-stylesheets', `${TOKEN_PACKAGE}-css`])
  })

  it('discovers a package token stylesheet with no per-vendor preset', async () => {
    // The regression this pins: token discovery used to run through a
    // hardcoded per-vendor preset, and the generic probe
    // explicitly SKIPPED that vendor's package so the preset could own it. Both are
    // gone; the generic probe is the only path and must find the package.
    const root = await mkPrototype({ dependencies: { [TOKEN_PACKAGE]: '^1.0.0' } })
    await addTokenPackage(root, ':root {\n  --color-background-primary: #0044f4; /** Primary. */\n}')

    const tokens = await loadDesignTokens({ prototypeRoot: root })
    const token = tokens.find((t) => t.name === '--color-background-primary')

    expect(token?.value).toBe('#0044f4')
    expect(token?.category).toBe('color')
    expect(token?.description).toBe('Primary.')
    expect(token?.source).toBe(TOKEN_PACKAGE)
  })

  it("the app's own stylesheet wins a name collision against a package (first-source-wins)", async () => {
    // Precedence flipped when the hardcoded vendor preset was removed: the
    // preset used to be ordered FIRST and shadow the app's own declaration.
    // App-first is what the CSS cascade does at runtime (the app stylesheet
    // is loaded after the package's), so grounding now agrees with paint.
    const root = await mkPrototype({ dependencies: { [TOKEN_PACKAGE]: '^1.0.0' } })
    await addTokenPackage(
      root,
      ':root {\n  --color-background-primary: #0044f4; /** Package. */\n}',
    )
    await fs.writeFile(
      path.join(root, 'app-tokens.css'),
      ':root {\n  --color-background-primary: #999999;\n}',
    )

    const tokens = await loadDesignTokens({ prototypeRoot: root })
    const token = tokens.find((t) => t.name === '--color-background-primary')

    expect(token?.value).toBe('#999999')
    expect(token?.source).toBe('app-stylesheets')
  })

  it('an app-stylesheets source built by buildDesignTokenSources self-invalidates on mutation (Phase 2 I1)', async () => {
    // DeferredDesignTokenSource / loadDesignTokens only memoize the SOURCE
    // LIST (discovery-once-per-process — new css FILES still need a
    // restart), not each source's listTokens() result. Because
    // CssCustomPropertiesTokenSource now self-invalidates on its own
    // mtime+size fingerprint, calling listTokens() twice on the SAME
    // app-stylesheets source instance (as a long-lived editor would) picks
    // up an edit to an already-known css file with zero extra plumbing here.
    const root = await mkPrototype()
    const cssPath = path.join(root, 'tokens.css')
    await fs.writeFile(cssPath, ':root {\n  --color-primary: #0044f4;\n}')

    const sources = await buildDesignTokenSources(root)
    const appSource = sources.find((s) => s.id === 'app-stylesheets')
    expect(appSource).toBeDefined()

    const first = await appSource!.listTokens()
    expect(first.find((t) => t.name === '--color-primary')).toBeDefined()

    await fs.writeFile(cssPath, ':root {\n  --color-secondary: #123456;\n}')
    const second = await appSource!.listTokens()

    expect(second.find((t) => t.name === '--color-secondary')).toBeDefined()
    expect(second.find((t) => t.name === '--color-primary')).toBeUndefined()
  })

  it('one throwing source does not blank the rest (composite default: warn + skip)', async () => {
    const root = await mkPrototype({ dependencies: { [TOKEN_PACKAGE]: '^1.0.0' } })
    await addTokenPackage(root, ':root {\n  --space-50: 12px;\n}')

    const sources = await buildDesignTokenSources(root)
    const throwing: DesignTokenSource = {
      id: 'throwing-source',
      designSystem: 'broken',
      listTokens: async () => {
        throw new Error('simulated read failure')
      },
      getToken: async () => {
        throw new Error('simulated read failure')
      },
    }

    // Mirrors exactly how `loadDesignTokens` composes `buildDesignTokenSources`'s
    // output — no custom `onSourceError`, i.e. the composite's DEFAULT (warn +
    // skip). A real stylesheet read/parse failure inside a
    // `CssCustomPropertiesTokenSource` would surface to the composite the same
    // way (a rejected `listTokens()`), so this proves the fail-loud override
    // that used to wrap this composition is gone.
    const composite = new CompositeDesignTokenSource({ sources: [...sources, throwing] })
    const tokens = await composite.listTokens()

    expect(tokens.find((t) => t.name === '--space-50')).toBeDefined()
  })
})
