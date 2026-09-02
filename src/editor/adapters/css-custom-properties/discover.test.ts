/**
 * Tests for `discoverTokenStylesheets` — the bounded stylesheet discovery
 * feeding the generic `css-custom-properties` token source family. Pure
 * filesystem fixtures under a tmpdir; no real package installs.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverTokenStylesheets } from './discover'

const tmpDirs: string[] = []

async function mkPrototype(pkgJson: Record<string, unknown> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discover-tokens-'))
  tmpDirs.push(root)
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', ...pkgJson }),
  )
  return root
}

async function addPackage(
  prototypeRoot: string,
  packageName: string,
  pkgJson: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const pkgRoot = path.join(prototypeRoot, 'node_modules', ...packageName.split('/'))
  await fs.mkdir(pkgRoot, { recursive: true })
  await fs.writeFile(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', ...pkgJson }),
  )
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pkgRoot, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return pkgRoot
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('discoverTokenStylesheets — app CSS', () => {
  it('finds an app css file with a :root custom-property declaration', async () => {
    const root = await mkPrototype()
    await fs.writeFile(
      path.join(root, 'tokens.css'),
      ':root {\n  --color-primary: #0044f4;\n}',
    )

    const { appCssFiles } = await discoverTokenStylesheets(root)

    expect(appCssFiles).toEqual([path.join(root, 'tokens.css')])
  })

  it('excludes a css file whose declarations are all component-scoped', async () => {
    const root = await mkPrototype()
    await fs.writeFile(
      path.join(root, 'component.css'),
      '.button {\n  --local-gap: 8px;\n  color: var(--local-gap);\n}',
    )

    const { appCssFiles } = await discoverTokenStylesheets(root)

    expect(appCssFiles).toEqual([])
  })

  it('respects the depth bound (does not descend past depth 6)', async () => {
    const root = await mkPrototype()
    // depth 0 = root itself; build a path 8 directories deep, past the bound.
    const deepDir = path.join(root, ...Array.from({ length: 8 }, (_, i) => `d${i}`))
    await fs.mkdir(deepDir, { recursive: true })
    await fs.writeFile(path.join(deepDir, 'tokens.css'), ':root {\n  --color-deep: #000;\n}')

    const { appCssFiles } = await discoverTokenStylesheets(root)

    expect(appCssFiles).toEqual([])
  })

  it('skips SKIP_DIRS like node_modules and dist during the app walk', async () => {
    const root = await mkPrototype()
    await fs.mkdir(path.join(root, 'dist'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'dist', 'tokens.css'),
      ':root {\n  --color-built: #000;\n}',
    )

    const { appCssFiles } = await discoverTokenStylesheets(root)

    expect(appCssFiles).toEqual([])
  })
})

describe('discoverTokenStylesheets — package CSS', () => {
  it('probes a dep named token-ish (@acme/design-tokens) via its style field', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    const pkgRoot = await addPackage(
      root,
      '@acme/design-tokens',
      { style: './tokens.css' },
      { 'tokens.css': ':root {\n  --acme-color-primary: #123456;\n}' },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([
      {
        packageName: '@acme/design-tokens',
        cssFiles: [path.join(pkgRoot, 'tokens.css')],
      },
    ])
  })

  it('does not probe a dep with a non-token-ish name (lodash) that is not registered', async () => {
    const root = await mkPrototype({ dependencies: { lodash: '^4.0.0' } })
    await addPackage(
      root,
      'lodash',
      { style: './tokens.css' },
      { 'tokens.css': ':root {\n  --lodash-color: #123456;\n}' },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('probes a registered design system even when its name is not token-ish', async () => {
    const root = await mkPrototype({ dependencies: { 'acme-ui': '^1.0.0' } })
    const pkgRoot = await addPackage(
      root,
      'acme-ui',
      { style: './tokens.css' },
      { 'tokens.css': ':root {\n  --acme-color-primary: #123456;\n}' },
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde', 'design-systems.json'),
      JSON.stringify({
        version: 1,
        designSystems: [
          {
            id: 'acme-ui-1',
            source: { kind: 'installed', package: 'acme-ui' },
            package: 'acme-ui',
            version: '1.0.0',
            framework: 'vue3',
            designSystem: 'acme-ui',
            importPath: 'acme-ui',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([
      {
        packageName: 'acme-ui',
        cssFiles: [path.join(pkgRoot, 'tokens.css')],
      },
    ])
  })

  it('discovers a dedicated token package at the conventional path — nothing is excluded', async () => {
    // Inverted 2026-08-10. This used to assert that one specific vendor's
    // token package was SKIPPED here, because a hardcoded preset owned it.
    // The preset is deleted; this generic probe is the only path, so a
    // token package must be discovered like any other. The conventional
    // `dist/tokens/css/custom-properties.css` layout is what such packages
    // ship, and it is exactly what the preset used to read.
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    const pkgRoot = await addPackage(
      root,
      '@acme/design-tokens',
      {},
      {
        'dist/tokens/css/custom-properties.css':
          ':root {\n  --acme-color-background-primary: #0044f4;\n}',
      },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([
      {
        packageName: '@acme/design-tokens',
        cssFiles: [path.join(pkgRoot, 'dist/tokens/css/custom-properties.css')],
      },
    ])
  })

  it('rejects a registry entry whose packageRoot escapes the prototype root', async () => {
    const root = await mkPrototype()
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde', 'design-systems.json'),
      JSON.stringify({
        version: 1,
        designSystems: [
          {
            id: 'escape-1',
            source: { kind: 'installed', package: 'evil-ui' },
            package: 'evil-ui',
            version: '1.0.0',
            framework: 'vue3',
            designSystem: 'evil-ui',
            importPath: 'evil-ui',
            packageRoot: '../../../etc',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a declared dependency name that escapes node_modules', async () => {
    // A hand-edited package.json dependency key can be anything — including
    // a `../` escape. "escape-design" still trips the token-ish name
    // heuristic (matches /design/i), so this must be rejected by containment
    // alone, not by the name-heuristic filter.
    const root = await mkPrototype({ dependencies: { '../../escape-design': '1.0.0' } })
    // A real css-bearing package planted exactly where
    // `<root>/node_modules/../../escape-design` resolves to if the escape
    // succeeded: `<dirname(root)>/escape-design`.
    const escapedPkgRoot = path.join(path.dirname(root), 'escape-design')
    tmpDirs.push(escapedPkgRoot)
    await fs.mkdir(escapedPkgRoot, { recursive: true })
    await fs.writeFile(
      path.join(escapedPkgRoot, 'package.json'),
      JSON.stringify({
        name: 'escape-design',
        version: '1.0.0',
        style: './tokens.css',
      }),
    )
    await fs.writeFile(
      path.join(escapedPkgRoot, 'tokens.css'),
      ':root {\n  --leaked: #123456;\n}',
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a registry entry with no packageRoot whose package escapes node_modules', async () => {
    const root = await mkPrototype()
    // A real css-bearing package planted exactly where `../../outside-pkg`
    // resolves to from `<root>/node_modules` if the escape succeeded:
    // `<root>/node_modules/../../outside-pkg` === `<dirname(root)>/outside-pkg`.
    const escapedPkgRoot = path.join(path.dirname(root), 'outside-pkg')
    tmpDirs.push(escapedPkgRoot)
    await fs.mkdir(escapedPkgRoot, { recursive: true })
    await fs.writeFile(
      path.join(escapedPkgRoot, 'package.json'),
      JSON.stringify({ name: 'outside-pkg', version: '1.0.0', style: './tokens.css' }),
    )
    await fs.writeFile(
      path.join(escapedPkgRoot, 'tokens.css'),
      ':root {\n  --leaked: #123456;\n}',
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde', 'design-systems.json'),
      JSON.stringify({
        version: 1,
        designSystems: [
          {
            id: 'escape-2',
            source: { kind: 'installed', package: '../../outside-pkg' },
            package: '../../outside-pkg',
            version: '1.0.0',
            framework: 'vue3',
            designSystem: 'outside-pkg',
            importPath: 'outside-pkg',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a style field that is an absolute path (outside packageRoot)', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    await addPackage(
      root,
      '@acme/design-tokens',
      { style: '/etc/passwd' },
      { 'tokens.css': ':root {\n  --acme-color-primary: #123456;\n}' },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a style field that escapes packageRoot via ../', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    // A real file that `../../../secrets.css` (3 levels up from
    // node_modules/@acme/design-tokens) would reach if the escape succeeded.
    await fs.writeFile(
      path.join(root, 'secrets.css'),
      ':root {\n  --leaked: #123456;\n}',
    )
    await addPackage(root, '@acme/design-tokens', { style: '../../../secrets.css' })

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a style field that does not end in .css', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    await addPackage(
      root,
      '@acme/design-tokens',
      { style: 'theme.txt' },
      { 'theme.txt': ':root {\n  --acme-color-primary: #123456;\n}' },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('rejects a style field that is a symlink escaping packageRoot', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    // A real css file OUTSIDE the package that the symlink will target.
    const outsideCss = path.join(path.dirname(root), 'outside-symlink-target.css')
    tmpDirs.push(outsideCss)
    await fs.writeFile(outsideCss, ':root {\n  --leaked: #123456;\n}')
    const pkgRoot = await addPackage(root, '@acme/design-tokens', { style: './tokens.css' })
    // tokens.css lexically resolves inside packageRoot, but is a symlink
    // whose REAL target is outside it.
    await fs.symlink(outsideCss, path.join(pkgRoot, 'tokens.css'))

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([])
  })

  it('still accepts a style field that is a symlink to a file inside the same package', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/design-tokens': '^1.0.0' } })
    const pkgRoot = await addPackage(
      root,
      '@acme/design-tokens',
      { style: './tokens.css' },
      { 'real-tokens.css': ':root {\n  --acme-color-primary: #123456;\n}' },
    )
    // tokens.css is a symlink to another file INSIDE the same package — legit.
    await fs.symlink(path.join(pkgRoot, 'real-tokens.css'), path.join(pkgRoot, 'tokens.css'))

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([
      {
        packageName: '@acme/design-tokens',
        cssFiles: [path.join(pkgRoot, 'tokens.css')],
      },
    ])
  })

  it('falls back to the first dist/*.css when the conventional path is absent', async () => {
    const root = await mkPrototype({ dependencies: { '@acme/theme-pack': '^1.0.0' } })
    const pkgRoot = await addPackage(
      root,
      '@acme/theme-pack',
      {},
      {
        'dist/b-tokens.css': ':root {\n  --acme-b: #000;\n}',
        'dist/a-tokens.css': ':root {\n  --acme-a: #000;\n}',
      },
    )

    const { packageCss } = await discoverTokenStylesheets(root)

    expect(packageCss).toEqual([
      {
        packageName: '@acme/theme-pack',
        cssFiles: [path.join(pkgRoot, 'dist', 'a-tokens.css')],
      },
    ])
  })
})
