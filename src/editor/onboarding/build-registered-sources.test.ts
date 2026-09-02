import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'

import { buildRegisteredSources, type RegisteredSourceDeps } from './build-registered-sources'
import type { RegisteredDesignSystem } from './types'

function vueEntry(o: Partial<RegisteredDesignSystem> = {}): RegisteredDesignSystem {
  return {
    id: 'acme-ds',
    source: { kind: 'installed', package: '@acme/design-system' },
    package: '@acme/design-system',
    version: '9.0.0',
    framework: 'vue3',
    designSystem: 'acme-ds',
    importPath: '@acme/design-system',
    dtsRoots: ['dist/types/components'],
    addedAt: 'x',
    ...o,
  }
}

function fakeDeps(over: Partial<RegisteredSourceDeps> = {}): {
  deps: RegisteredSourceDeps
  vueArgs: unknown[]
  reactArgs: unknown[]
  cachedArgs: unknown[]
} {
  const vueArgs: unknown[] = []
  const reactArgs: unknown[] = []
  const cachedArgs: unknown[] = []
  const deps: RegisteredSourceDeps = {
    discoverVueDtsComponents: vi.fn(() => [
      { componentName: 'UiButton', declarationFile: '/x/UiButton.vue.d.ts', exportName: 'default' },
    ]),
    VueDtsMetaManifestSource: vi.fn(function (this: Record<string, unknown>, o: unknown) {
      vueArgs.push(o)
      this.id = (o as { id: string }).id
      this.framework = 'vue3'
      this.designSystem = (o as { designSystem: string }).designSystem
    }) as unknown as RegisteredSourceDeps['VueDtsMetaManifestSource'],
    discoverReactDtsEntries: vi.fn(() => ['/x/index.d.ts']),
    ReactDtsMetaManifestSource: vi.fn(function (this: Record<string, unknown>, o: unknown) {
      reactArgs.push(o)
      this.id = (o as { id: string }).id
      this.framework = 'react'
      this.designSystem = (o as { designSystem: string }).designSystem
    }) as unknown as RegisteredSourceDeps['ReactDtsMetaManifestSource'],
    resolvePackageVersion: vi.fn(() => '9.0.0'),
    CachedManifestSource: vi.fn(function (this: Record<string, unknown>, o: unknown) {
      cachedArgs.push(o)
      const inner = (o as { inner: { id: string; framework: string; designSystem: string } }).inner
      this.id = inner.id
      this.framework = inner.framework
      this.designSystem = inner.designSystem
    }) as unknown as RegisteredSourceDeps['CachedManifestSource'],
    fingerprintFile: vi.fn(() => 'fp-abc'),
    ...over,
  }
  return { deps, vueArgs, reactArgs, cachedArgs }
}

const base = {
  prototypeRoot: '/proto',
  tsconfigPath: '/proto/tsconfig.json',
  cacheDir: '/proto/.desde/manifests',
}

describe('buildRegisteredSources', () => {
  it('wraps a Vue source in CachedManifestSource with the registered dtsRoots + INSTALLED-version cache key', () => {
    // The registry stored 9.0.0, but node_modules is upgraded to 9.1.0 — the
    // cache key must track the installed version so an upgrade busts the cache.
    const { deps, vueArgs, cachedArgs } = fakeDeps({ resolvePackageVersion: vi.fn(() => '9.1.0') })
    const res = buildRegisteredSources({ registry: [vueEntry({ version: '9.0.0' })], ...base, deps })
    expect(res.sources).toHaveLength(1)
    expect(res.registeredPackages.has('@acme/design-system')).toBe(true)
    expect(deps.discoverVueDtsComponents).toHaveBeenCalledWith(
      path.join('/proto', 'node_modules', '@acme/design-system'),
      { dtsRoots: ['dist/types/components'] },
    )
    expect(vueArgs[0]).toMatchObject({
      id: '@acme/design-system-registered',
      tsconfigPath: '/proto/tsconfig.json',
      designSystem: 'acme-ds',
      importPath: '@acme/design-system',
    })
    // The extractor itself is a pure extractor now — no cache option.
    expect(vueArgs[0]).not.toHaveProperty('cache')

    expect(cachedArgs).toHaveLength(1)
    const cacheOpts = cachedArgs[0] as {
      cacheDir: string
      key: string
      version: string
      context: string
    }
    expect(cacheOpts.cacheDir).toBe(base.cacheDir)
    expect(cacheOpts.version).toBe('9.1.0')
    expect(cacheOpts.context).toBe('fp-abc')
    // Registry-specific cache identity — NOT the bare package name (which the
    // auto-scan uses), so the two don't collide.
    expect(cacheOpts.key).not.toBe('@acme/design-system')
    expect(cacheOpts.key).toMatch(/^@acme\/design-system#reg-/)
  })

  it('gives different cache keys to two registrations of the same package with different designSystem', () => {
    const { deps, cachedArgs } = fakeDeps()
    buildRegisteredSources({
      registry: [
        vueEntry({ id: 'a', designSystem: 'acme-ds' }),
        vueEntry({ id: 'b', designSystem: 'acme-custom' }),
      ],
      ...base,
      deps,
    })
    const nameA = (cachedArgs[0] as { key: string }).key
    const nameB = (cachedArgs[1] as { key: string }).key
    expect(nameA).not.toBe(nameB)
  })

  it('gives different cache keys to a Vue and a React registration sharing designSystem/importPath/dtsRoots', () => {
    // Same identity fields except `framework` — folding `fw` into the hash
    // means flipping an entry's framework busts the cache instead of one
    // framework's registration silently replaying the other's cached JSON.
    const { deps, cachedArgs } = fakeDeps()
    buildRegisteredSources({
      registry: [
        vueEntry({ id: 'a', framework: 'vue3', dtsRoots: ['dist/index.d.ts'] }),
        vueEntry({ id: 'b', framework: 'react', dtsRoots: ['dist/index.d.ts'] }),
      ],
      ...base,
      deps,
    })
    const nameA = (cachedArgs[0] as { key: string }).key
    const nameB = (cachedArgs[1] as { key: string }).key
    expect(nameA).not.toBe(nameB)
  })

  it('builds a React source from the resolved types entry, wrapped in the cache decorator', () => {
    // resolvePackageVersion returning null (e.g. an unreadable package.json)
    // falls back to entry.version, same as the Vue branch.
    const { deps, reactArgs, cachedArgs } = fakeDeps({ resolvePackageVersion: vi.fn(() => null) })
    const entry = vueEntry({
      id: 'radix',
      package: '@radix-ui/react-switch',
      framework: 'react',
      designSystem: 'radix',
      importPath: '@radix-ui/react-switch',
      dtsRoots: undefined,
      version: '2.0.0',
    })
    const res = buildRegisteredSources({ registry: [entry], ...base, deps })
    expect(res.sources).toHaveLength(1)
    expect(deps.discoverReactDtsEntries).toHaveBeenCalledWith(
      path.join('/proto', 'node_modules', '@radix-ui/react-switch'),
    )
    expect(reactArgs[0]).toMatchObject({
      framework: 'react',
      designSystem: 'radix',
      entryFiles: ['/x/index.d.ts'],
    })
    expect(cachedArgs).toHaveLength(1)
    const cacheOpts = cachedArgs[0] as { key: string; version: string; context: string }
    expect(cacheOpts.key).toMatch(/^@radix-ui\/react-switch#reg-/)
    expect(cacheOpts.version).toBe('2.0.0')
    expect(cacheOpts.context).toBe('fp-abc')
  })

  it('wraps an INSTALLED React source with the on-disk package version (not the stale registry version)', () => {
    // The registry stored 2.0.0, but node_modules is upgraded to 2.1.0 — the
    // cache key must track the installed version so an upgrade busts the
    // cache, mirroring the Vue installed-entry behavior above.
    const { deps, cachedArgs } = fakeDeps({ resolvePackageVersion: vi.fn(() => '2.1.0') })
    const entry = vueEntry({
      id: 'radix',
      package: '@radix-ui/react-switch',
      framework: 'react',
      designSystem: 'radix',
      importPath: '@radix-ui/react-switch',
      dtsRoots: undefined,
      version: '2.0.0',
      // No packageRoot override — this is an INSTALLED (node_modules) entry.
    })
    const res = buildRegisteredSources({ registry: [entry], ...base, deps })
    expect(res.sources).toHaveLength(1)
    expect(deps.resolvePackageVersion).toHaveBeenCalledWith(
      path.join('/proto', 'node_modules', '@radix-ui/react-switch'),
    )
    expect(cachedArgs).toHaveLength(1)
    const cacheOpts = cachedArgs[0] as { version: string }
    expect(cacheOpts.version).toBe('2.1.0')
  })

  it('treats React .d.ts dtsRoots as explicit entry files under packageRoot', () => {
    const { deps, reactArgs } = fakeDeps()
    const entry = vueEntry({
      package: '@acme/ui',
      framework: 'react',
      designSystem: 'acme',
      importPath: '@acme/ui',
      dtsRoots: ['dist/index.d.ts'],
    })
    buildRegisteredSources({ registry: [entry], ...base, deps })
    expect(deps.discoverReactDtsEntries).not.toHaveBeenCalled()
    expect(reactArgs[0]).toMatchObject({
      entryFiles: [path.join('/proto', 'node_modules', '@acme/ui', 'dist/index.d.ts')],
    })
  })

  it('ignores a React dtsRoots DIRECTORY and falls back to types-entry resolution', () => {
    const { deps, reactArgs } = fakeDeps()
    const entry = vueEntry({
      package: '@acme/ui',
      framework: 'react',
      designSystem: 'acme',
      importPath: '@acme/ui',
      dtsRoots: ['dist/types'], // a dir, not a .d.ts file → no source for the checker
    })
    buildRegisteredSources({ registry: [entry], ...base, deps })
    // Dir-style root ignored → auto-resolve the package's types entry instead.
    expect(deps.discoverReactDtsEntries).toHaveBeenCalledWith(
      path.join('/proto', 'node_modules', '@acme/ui'),
    )
    expect(reactArgs[0]).toMatchObject({ entryFiles: ['/x/index.d.ts'] })
  })

  it('resolves an entry.packageRoot override (npm-ingested scratch dir)', () => {
    const { deps } = fakeDeps()
    const entry = vueEntry({
      packageRoot: '.desde/ingested/acme/node_modules/@acme/ui',
    })
    buildRegisteredSources({ registry: [entry], ...base, deps })
    expect(deps.discoverVueDtsComponents).toHaveBeenCalledWith(
      path.resolve('/proto', '.desde/ingested/acme/node_modules/@acme/ui'),
      { dtsRoots: ['dist/types/components'] },
    )
  })

  it('skips a packageRoot override that escapes the prototype root', () => {
    const onSkip = vi.fn()
    const { deps } = fakeDeps()
    const entry = vueEntry({ packageRoot: '../../../etc' })
    const res = buildRegisteredSources({ registry: [entry], ...base, deps, onSkip })
    expect(res.sources).toHaveLength(0)
    expect(deps.discoverVueDtsComponents).not.toHaveBeenCalled()
    expect(onSkip).toHaveBeenCalledWith('@acme/design-system', expect.stringMatching(/escapes/i))
  })

  it('skips an entry that yields no components and reports the reason', () => {
    const onSkip = vi.fn()
    const { deps } = fakeDeps({ discoverVueDtsComponents: vi.fn(() => []) })
    const res = buildRegisteredSources({ registry: [vueEntry()], ...base, deps, onSkip })
    expect(res.sources).toHaveLength(0)
    expect(res.registeredPackages.size).toBe(0)
    expect(onSkip).toHaveBeenCalledWith('@acme/design-system', expect.stringMatching(/no .*components/i))
  })

  it('contributes nothing when there is no tsconfig', () => {
    const { deps } = fakeDeps()
    const res = buildRegisteredSources({ registry: [vueEntry()], ...base, tsconfigPath: null, deps })
    expect(res.sources).toEqual([])
    expect(res.registeredPackages.size).toBe(0)
  })

  it('uses entry.version (not resolvePackageVersion) as the cache key for a scratch entry', () => {
    // A repo scratch entry: package.json says 1.0.0, but entry.version folds in
    // the commit. The cache must key on entry.version so a new branch (same
    // package.json version) busts the cache.
    const { deps, cachedArgs } = fakeDeps({ resolvePackageVersion: vi.fn(() => '1.0.0') })
    const entry = vueEntry({
      packageRoot: '.desde/ingested/repo/repo',
      version: '1.0.0+git.deadbeef0000',
    })
    buildRegisteredSources({ registry: [entry], ...base, deps })
    const cacheOpts = cachedArgs[0] as { version: string }
    expect(cacheOpts.version).toBe('1.0.0+git.deadbeef0000')
    // resolvePackageVersion is NOT consulted for scratch entries.
    expect(deps.resolvePackageVersion).not.toHaveBeenCalled()
  })

  it('extracts with an entry.tsconfigPath override (npm scratch tsconfig)', () => {
    const { deps, vueArgs } = fakeDeps()
    const entry = vueEntry({ tsconfigPath: '.desde/ingested/x/tsconfig.json' })
    buildRegisteredSources({ registry: [entry], ...base, deps })
    expect(vueArgs[0]).toMatchObject({
      tsconfigPath: path.resolve('/proto', '.desde/ingested/x/tsconfig.json'),
    })
  })

  it('builds an entry with its OWN tsconfig even when the prototype has none', () => {
    const { deps } = fakeDeps()
    const entry = vueEntry({ tsconfigPath: '.desde/ingested/x/tsconfig.json' })
    // Global tsconfig null (prototype has none) — the npm entry still builds.
    const res = buildRegisteredSources({ registry: [entry], ...base, tsconfigPath: null, deps })
    expect(res.sources).toHaveLength(1)
  })

  it('fires onSource with packageName/sourceId/discovered for a built Vue source', () => {
    const onSource = vi.fn()
    const { deps } = fakeDeps()
    const res = buildRegisteredSources({ registry: [vueEntry()], ...base, deps, onSource })
    expect(res.sources).toHaveLength(1)
    expect(onSource).toHaveBeenCalledWith({
      packageName: '@acme/design-system',
      sourceId: '@acme/design-system-registered',
      discovered: 1,
    })
  })

  it('fires onSource with the entryFiles count for a built React source', () => {
    const onSource = vi.fn()
    const { deps } = fakeDeps()
    const entry = vueEntry({
      package: '@radix-ui/react-switch',
      framework: 'react',
      designSystem: 'radix',
      importPath: '@radix-ui/react-switch',
      dtsRoots: undefined,
      version: '2.0.0',
    })
    buildRegisteredSources({ registry: [entry], ...base, deps, onSource })
    expect(onSource).toHaveBeenCalledWith({
      packageName: '@radix-ui/react-switch',
      sourceId: '@radix-ui/react-switch-registered',
      discovered: 1,
    })
  })

  it('does not fire onSource for a skipped entry', () => {
    const onSource = vi.fn()
    const { deps } = fakeDeps({ discoverVueDtsComponents: vi.fn(() => []) })
    buildRegisteredSources({ registry: [vueEntry()], ...base, deps, onSource, onSkip: vi.fn() })
    expect(onSource).not.toHaveBeenCalled()
  })

  it('skips an entry whose tsconfigPath escapes the prototype root', () => {
    const onSkip = vi.fn()
    const { deps } = fakeDeps()
    const entry = vueEntry({ tsconfigPath: '../../../etc/tsconfig.json' })
    const res = buildRegisteredSources({ registry: [entry], ...base, deps, onSkip })
    expect(res.sources).toHaveLength(0)
    expect(onSkip).toHaveBeenCalledWith('@acme/design-system', expect.stringMatching(/escapes/i))
  })
})
