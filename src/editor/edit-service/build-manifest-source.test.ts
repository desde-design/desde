import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildManifestSource, MANIFEST_SOURCE_ORDER } from './build-manifest-source'
import { writeHintCache, hintCacheFilePath, HINTS_SCHEMA_VERSION } from '../adapters/hints-cache'

describe('MANIFEST_SOURCE_ORDER', () => {
  it('pins the load-bearing priority order', () => {
    expect([...MANIFEST_SOURCE_ORDER]).toEqual([
      'storybook', 'vue-component-meta', 'local-vue', 'local-react',
      'registered', 'library-dts-auto-scan', 'react-dts-auto-scan',
      'hints-cache', 'storybook-url',
    ])
  })
})

describe('buildManifestSource', () => {
  it('returns null for an unreadable root', async () => {
    expect(await buildManifestSource('/nonexistent/nope')).toBeNull()
  })

  it('visits every step in order against an empty fixture project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    const visited: string[] = []
    const result = await buildManifestSource(root, { onStep: (step) => visited.push(step) })
    expect(result?.source).not.toBeNull()
    expect(visited).toEqual([...MANIFEST_SOURCE_ORDER])
  })

  it('registered entries suppress the auto-scan of the same package', async () => {
    // Fixture: node_modules/@acme/ui shipping one Button.vue.d.ts under
    // dist/types/components + a .desde/design-systems.json registering
    // @acme/ui. Assert via onStep that 'library-dts-auto-scan' contributes
    // zero sources while 'registered' contributes one.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    const pkg = path.join(root, 'node_modules/@acme/ui')
    await fs.mkdir(path.join(pkg, 'dist/types/components/Button'), { recursive: true })
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/ui', version: '1.0.0' }))
    await fs.writeFile(
      path.join(pkg, 'dist/types/components/Button/Button.vue.d.ts'),
      'declare const _default: import("vue").DefineComponent<{}, {}, any>;\nexport default _default;\n',
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({ version: 1, designSystems: [{ id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() }] }),
    )
    const byStep = new Map<string, number>()
    const result = await buildManifestSource(root, { onStep: (step, sources) => byStep.set(step, sources.length) })
    expect(byStep.get('registered')).toBe(1)
    expect(byStep.get('library-dts-auto-scan')).toBe(0)

    // Health mirrors the same precedence: one 'ok' entry for the registered
    // package, none for the auto-scan (it never entered the scan loop for
    // this package — the auto-scan loop skipped it outright).
    const health = result?.health
    expect(health?.root).toBe(await fs.realpath(root))
    const registeredEntries = health?.sources.filter((s) => s.step === 'registered') ?? []
    expect(registeredEntries).toHaveLength(1)
    expect(registeredEntries[0]).toMatchObject({
      packageName: '@acme/ui',
      discovered: 1,
      status: 'ok',
    })
    expect(health?.sources.some((s) => s.step === 'library-dts-auto-scan')).toBe(false)
  })

  it('hints-cache overlays generated rendering hints onto a registered package\'s props, and reports health only when a hint file is found', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    const pkg = path.join(root, 'node_modules/@acme/ui')
    await fs.mkdir(path.join(pkg, 'dist/types/components/Button'), { recursive: true })
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/ui', version: '1.0.0' }))
    await fs.writeFile(
      path.join(pkg, 'dist/types/components/Button/Button.vue.d.ts'),
      'declare const _default: import("vue").DefineComponent<{}, {}, any>;\nexport default _default;\n',
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({ version: 1, designSystems: [{ id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() }] }),
    )
    // Pre-seed a hint cache file for @acme/ui@1.0.0, as the (out of scope
    // here) generation pipeline would after an explicit "generate hints" run.
    await fs.mkdir(path.join(root, '.desde/manifests'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/manifests/acme-ui@1.0.0.hints.json'),
      JSON.stringify({
        schema: 1,
        packageName: '@acme/ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {
          Button: [
            {
              kind: 'dom',
              source: { kind: 'slot', name: 'default' },
              domTarget: { selector: ':root', field: 'textContent' },
              editability: 'literal',
              provenance: 'generated',
              verified: true,
            },
          ],
        },
      }),
    )

    const byStep = new Map<string, number>()
    const result = await buildManifestSource(root, { onStep: (step, sources) => byStep.set(step, sources.length) })
    expect(byStep.get('hints-cache')).toBe(1)

    const manifest = await result?.source.getComponent('Button')
    expect(manifest?.rendering).toEqual([
      {
        kind: 'dom',
        source: { kind: 'slot', name: 'default' },
        domTarget: { selector: ':root', field: 'textContent' },
        editability: 'literal',
        provenance: 'generated',
        verified: true,
      },
    ])
    // Props still come from the registered vue-dts-meta source, not from
    // hints-cache's minimal manifest — the overlay only supplies `rendering`.
    expect(Array.isArray(manifest?.props)).toBe(true)

    const health = result?.health
    const hintsCacheEntries = health?.sources.filter((s) => s.step === 'hints-cache') ?? []
    expect(hintsCacheEntries).toHaveLength(1)
    expect(hintsCacheEntries[0]).toMatchObject({
      packageName: '@acme/ui',
      discovered: 1,
      status: 'ok',
    })
  })

  it('M1: hints-cache resolves the CURRENTLY installed version, not the onboard-time registry record', async () => {
    // Registry says @acme/ui was onboarded at 1.0.0, but node_modules now has
    // 2.0.0 installed (e.g. the user ran `npm install @acme/ui@2` without
    // hitting the explicit /refresh route). Hint files exist for BOTH
    // versions; the live-installed one must win.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    const pkg = path.join(root, 'node_modules/@acme/ui')
    await fs.mkdir(path.join(pkg, 'dist/types/components/Button'), { recursive: true })
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/ui', version: '2.0.0' }))
    await fs.writeFile(
      path.join(pkg, 'dist/types/components/Button/Button.vue.d.ts'),
      'declare const _default: import("vue").DefineComponent<{}, {}, any>;\nexport default _default;\n',
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({ version: 1, designSystems: [{ id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() }] }),
    )
    await fs.mkdir(path.join(root, '.desde/manifests'), { recursive: true })
    const hintFor = (selector: string) => ({
      schema: 1,
      packageName: '@acme/ui',
      hints: {
        Button: [
          {
            kind: 'dom',
            source: { kind: 'slot', name: 'default' },
            domTarget: { selector, field: 'textContent' },
            editability: 'literal',
            provenance: 'generated',
            verified: true,
          },
        ],
      },
    })
    await fs.writeFile(
      path.join(root, '.desde/manifests/acme-ui@1.0.0.hints.json'),
      JSON.stringify({ ...hintFor('.stale-1.0.0-selector'), packageVersion: '1.0.0', generatedAt: new Date().toISOString() }),
    )
    await fs.writeFile(
      path.join(root, '.desde/manifests/acme-ui@2.0.0.hints.json'),
      JSON.stringify({ ...hintFor('.fresh-2.0.0-selector'), packageVersion: '2.0.0', generatedAt: new Date().toISOString() }),
    )

    const result = await buildManifestSource(root)
    const manifest = await result?.source.getComponent('Button')
    expect(manifest?.rendering).toEqual([
      expect.objectContaining({ domTarget: { selector: '.fresh-2.0.0-selector', field: 'textContent' } }),
    ])
  })

  it('M1: falls back to entry.version when the installed package is unresolvable (no node_modules install)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    // No node_modules/@acme/ui at all — resolvePackageVersion returns null.
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({ version: 1, designSystems: [{ id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() }] }),
    )
    await fs.mkdir(path.join(root, '.desde/manifests'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/manifests/acme-ui@1.0.0.hints.json'),
      JSON.stringify({
        schema: 1,
        packageName: '@acme/ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {
          Button: [
            {
              kind: 'dom',
              source: { kind: 'slot', name: 'default' },
              domTarget: { selector: ':root', field: 'textContent' },
              editability: 'literal',
              provenance: 'generated',
              verified: true,
            },
          ],
        },
      }),
    )

    const result = await buildManifestSource(root)
    const health = result?.health
    const hintsCacheEntries = health?.sources.filter((s) => s.step === 'hints-cache') ?? []
    // The package isn't installed at all (props extraction has nothing to
    // build), but the hints-cache step still falls back to entry.version and
    // finds the pre-existing 1.0.0 hint file on disk.
    expect(hintsCacheEntries).toHaveLength(1)
    expect(hintsCacheEntries[0]).toMatchObject({ packageName: '@acme/ui', status: 'ok' })
  })

  it('two registered packages both exporting "Button" each get THEIR OWN hints-cache hints, never the other\'s and never none', async () => {
    // Task 3 follow-up fix regression test: the old design built ONE
    // HintsCacheManifestSource over every entry, and refused (null) whenever
    // two entries' hint files both named the same component — starving
    // BOTH packages of hints for a same-named component. Now each package
    // gets its own per-entry source, and the composite's
    // `isPlausiblySameComponent` identity guard (designSystem/importPath
    // match) picks the correct package's hints for whichever props winner
    // the composite resolves.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))

    for (const pkgName of ['@acme/ui', '@beta/ui']) {
      const pkg = path.join(root, 'node_modules', pkgName)
      await fs.mkdir(path.join(pkg, 'dist/types/components/Button'), { recursive: true })
      await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0' }))
      await fs.writeFile(
        path.join(pkg, 'dist/types/components/Button/Button.vue.d.ts'),
        'declare const _default: import("vue").DefineComponent<{}, {}, any>;\nexport default _default;\n',
      )
    }
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({
        version: 1,
        designSystems: [
          { id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() },
          { id: 'beta', source: { kind: 'installed', package: '@beta/ui' }, package: '@beta/ui', version: '1.0.0', framework: 'vue3', designSystem: 'beta', importPath: '@beta/ui', addedAt: new Date().toISOString() },
        ],
      }),
    )
    await fs.mkdir(path.join(root, '.desde/manifests'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/manifests/acme-ui@1.0.0.hints.json'),
      JSON.stringify({
        schema: 1,
        packageName: '@acme/ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {
          Button: [
            {
              kind: 'dom',
              source: { kind: 'slot', name: 'default' },
              domTarget: { selector: '.acme-button', field: 'textContent' },
              editability: 'literal',
              provenance: 'generated',
              verified: true,
            },
          ],
        },
      }),
    )
    await fs.writeFile(
      path.join(root, '.desde/manifests/beta-ui@1.0.0.hints.json'),
      JSON.stringify({
        schema: 1,
        packageName: '@beta/ui',
        packageVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        hints: {
          Button: [
            {
              kind: 'dom',
              source: { kind: 'slot', name: 'default' },
              domTarget: { selector: '.beta-button', field: 'textContent' },
              editability: 'literal',
              provenance: 'generated',
              verified: true,
            },
          ],
        },
      }),
    )

    const result = await buildManifestSource(root)
    const manifest = await result?.source.getComponent('Button')
    // @acme/ui is registered first, so it wins the props race; its OWN
    // hints-cache entry must overlay — never @beta/ui's, and never empty.
    expect(manifest?.designSystem).toBe('acme')
    expect(manifest?.rendering).toEqual([
      expect.objectContaining({ domTarget: { selector: '.acme-button', field: 'textContent' } }),
    ])

    const hintsCacheEntries = result?.health?.sources.filter((s) => s.step === 'hints-cache') ?? []
    expect(hintsCacheEntries).toHaveLength(2)
    expect(hintsCacheEntries.map((e) => e.packageName).sort()).toEqual(['@acme/ui', '@beta/ui'])
  })

  it('hints-cache reports no health entries when no hint files exist on disk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    const pkg = path.join(root, 'node_modules/@acme/ui')
    await fs.mkdir(path.join(pkg, 'dist/types/components/Button'), { recursive: true })
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@acme/ui', version: '1.0.0' }))
    await fs.writeFile(
      path.join(pkg, 'dist/types/components/Button/Button.vue.d.ts'),
      'declare const _default: import("vue").DefineComponent<{}, {}, any>;\nexport default _default;\n',
    )
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({ version: 1, designSystems: [{ id: 'acme', source: { kind: 'installed', package: '@acme/ui' }, package: '@acme/ui', version: '1.0.0', framework: 'vue3', designSystem: 'acme', importPath: '@acme/ui', addedAt: new Date().toISOString() }] }),
    )

    const result = await buildManifestSource(root)
    const health = result?.health
    expect(health?.sources.some((s) => s.step === 'hints-cache')).toBe(false)
  })

  it('hints-cache supplies rendering hints for a registered package', async () => {
    // The hint cache is THE source of `rendering` hints now that the
    // hand-authored per-design-system source is gone. This pins the whole
    // path: a registered package produces a `hintsCacheEntries` row, the
    // on-disk hint file for that package@version is read, and the composite
    // overlays its hints onto the manifest `getComponent` returns.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.desde/design-systems.json'),
      JSON.stringify({
        version: 1,
        designSystems: [
          {
            id: 'acme',
            source: { kind: 'installed', package: '@acme/design-system' },
            package: '@acme/design-system',
            version: '9.0.0',
            framework: 'vue3',
            designSystem: 'acme-ds',
            importPath: '@acme/design-system',
            addedAt: new Date().toISOString(),
          },
        ],
      }),
    )

    const hint = {
      kind: 'dom' as const,
      source: { kind: 'prop' as const, name: 'placeholder' },
      domTarget: { selector: '.acme-input__placeholder', field: 'textContent' as const },
      editability: 'literal' as const,
      provenance: 'generated' as const,
      verified: true,
    }
    writeHintCache(
      hintCacheFilePath(path.join(root, '.desde/manifests'), '@acme/design-system', '9.0.0'),
      {
        schema: HINTS_SCHEMA_VERSION,
        packageName: '@acme/design-system',
        packageVersion: '9.0.0',
        generatedAt: new Date().toISOString(),
        hints: { UiInput: [hint] },
      },
    )

    const result = await buildManifestSource(root)

    const health = result?.health
    const hintsCacheEntry = health?.sources.find(
      (s) => s.step === 'hints-cache' && s.packageName === '@acme/design-system',
    )
    expect(hintsCacheEntry).toMatchObject({ discovered: 1, status: 'ok' })
  })

  it('react-dts-auto-scan contributes a source for a react-declaring prototype', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        dependencies: { react: '^18.0.0', 'acme-react-ui': '^1.0.0' },
      }),
    )
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
    const pkg = path.join(root, 'node_modules/acme-react-ui')
    await fs.mkdir(pkg, { recursive: true })
    await fs.writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: 'acme-react-ui',
        version: '1.0.0',
        types: 'index.d.ts',
        peerDependencies: { react: '^18.0.0' },
      }),
    )
    await fs.writeFile(path.join(pkg, 'index.d.ts'), 'export declare const Button: () => null;\n')

    const byStep = new Map<string, number>()
    const result = await buildManifestSource(root, { onStep: (step, sources) => byStep.set(step, sources.length) })
    expect(byStep.get('react-dts-auto-scan')).toBe(1)

    const health = result?.health
    const entries = health?.sources.filter((s) => s.step === 'react-dts-auto-scan') ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      packageName: 'acme-react-ui',
      sourceId: 'acme-react-ui-react-dts',
      status: 'ok',
    })
  })

  it('react-dts-auto-scan contributes nothing for a non-react (Vue) prototype', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))

    const byStep = new Map<string, number>()
    const result = await buildManifestSource(root, { onStep: (step, sources) => byStep.set(step, sources.length) })
    expect(byStep.get('react-dts-auto-scan')).toBe(0)

    const health = result?.health
    const entries = health?.sources.filter((s) => s.step === 'react-dts-auto-scan') ?? []
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'skipped', reason: 'prototype does not declare react' })
  })

  it('reports GroundingHealth with one entry per non-empty step against an empty fixture', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bms-'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
    const result = await buildManifestSource(root)
    expect(result).not.toBeNull()
    const health = result?.health
    expect(health?.root).toBe(await fs.realpath(root))
    expect(typeof health?.builtAt).toBe('string')
    expect(Number.isNaN(Date.parse(health?.builtAt ?? ''))).toBe(false)
    expect(health?.runtimeErrors).toEqual([])

    // No tsconfig + no node_modules + no registry + no storybook URLs → only
    // the unconditionally-constructed sources (storybook, local-vue,
    // local-react) plus the three structural skips (vue-component-meta,
    // library-dts-auto-scan, react-dts-auto-scan: all "no tsconfig") report
    // anything. registered / hints-cache / storybook-url have nothing to
    // iterate over, so they contribute zero entries — not a synthetic empty
    // one.
    const byStep = new Map(health?.sources.map((s) => [s.step, s]))
    expect([...byStep.keys()].sort()).toEqual(
      [
        'storybook',
        'vue-component-meta',
        'local-vue',
        'local-react',
        'library-dts-auto-scan',
        'react-dts-auto-scan',
      ].sort(),
    )
    expect(byStep.get('storybook')).toMatchObject({ discovered: 0, status: 'ok' })
    expect(byStep.get('vue-component-meta')).toMatchObject({ status: 'skipped', reason: 'no tsconfig' })
    expect(byStep.get('local-vue')).toMatchObject({ discovered: 0, status: 'ok' })
    expect(byStep.get('local-react')).toMatchObject({ discovered: 0, status: 'ok' })
    expect(byStep.get('library-dts-auto-scan')).toMatchObject({
      sourceId: 'library-dts-auto-scan',
      discovered: 0,
      status: 'skipped',
      reason: 'no tsconfig',
    })
    expect(byStep.get('react-dts-auto-scan')).toMatchObject({ status: 'skipped' })
  })
})
