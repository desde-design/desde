import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoDetectIconSets, iconSetId, iconSetLabel, __testing } from './auto-detect'

/**
 * Detection is shape-verified, not name-listed: a candidate is registered
 * only if its real TS declarations enumerate at least one icon-shaped export.
 * So every test here installs an actual (tiny) package tree — writing a
 * dependency name into `package.json` alone is deliberately NOT enough.
 */
describe('autoDetectIconSets', () => {
  let prototypeRoot: string

  beforeEach(async () => {
    prototypeRoot = await mkdtemp(join(tmpdir(), 'pt-icon-detect-'))
  })

  afterEach(async () => {
    await rm(prototypeRoot, { recursive: true, force: true })
  })

  async function writePkgJson(deps: Record<string, Record<string, string>>): Promise<void> {
    await writeFile(
      join(prototypeRoot, 'package.json'),
      JSON.stringify({ name: 'prototype', ...deps }),
    )
  }

  /**
   * Install a package that enumerates as an icon set: a `types` entry that
   * re-exports a category barrel, which default-re-exports `*Icon` bindings.
   * `renderer` decides which framework the probe should infer.
   */
  async function installIconPackage(
    packageName: string,
    opts: { renderer?: 'vue' | 'react' | 'none'; icons?: string[]; ext?: string } = {},
  ): Promise<void> {
    const { renderer = 'vue', icons = ['StarIcon', 'HeartIcon'], ext = '.vue' } = opts
    const pkgDir = join(prototypeRoot, 'node_modules', ...packageName.split('/'))
    const typesDir = join(pkgDir, 'dist', 'types')
    await mkdir(join(typesDir, 'components'), { recursive: true })

    const peerDependencies =
      renderer === 'vue' ? { vue: '^3.0.0' } : renderer === 'react' ? { react: '^18.0.0' } : {}

    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        types: 'dist/types/index.d.ts',
        peerDependencies,
      }),
    )
    await writeFile(join(typesDir, 'index.d.ts'), `export * from './components';\n`)
    await writeFile(
      join(typesDir, 'components', 'index.d.ts'),
      icons.map((n) => `export { default as ${n} } from './${n}${ext}';`).join('\n') + '\n',
    )
    for (const n of icons) {
      await writeFile(join(typesDir, 'components', `${n}${ext}.d.ts`), 'export default {};\n')
    }
  }

  it('returns nothing when prototype has no package.json', async () => {
    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources).toEqual([])
  })

  it('returns nothing when no dependency name looks icon-ish', async () => {
    await writePkgJson({ dependencies: { vue: '^3.0.0', axios: '^1.0.0' } })

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources).toEqual([])
  })

  it('detects an installed icon package and derives its id, label and usage pattern', async () => {
    await writePkgJson({ dependencies: { '@acme/icons': '^1.0.0', vue: '^3.0.0' } })
    await installIconPackage('@acme/icons')

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })

    expect(sources.map((s) => s.id)).toEqual(['acme-icons'])
    expect(sources[0].displayName).toBe('Acme Icons')
    expect(sources[0].framework).toBe('vue3')
    expect(sources[0].usagePattern).toEqual({
      kind: 'named-component-import',
      packageName: '@acme/icons',
    })
  })

  it('does NOT register an icon-named dependency that is not installed', async () => {
    // The name gate alone must never produce a set — stage 2 is what decides.
    await writePkgJson({ dependencies: { '@acme/icons': '^1.0.0' } })

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources).toEqual([])
  })

  it('does NOT register an installed icon package whose declarations enumerate nothing', async () => {
    // This is the honesty guarantee: a package whose declaration shape the
    // enumerator does not support is skipped, not offered as an empty set.
    await writePkgJson({ dependencies: { '@acme/icons': '^1.0.0' } })
    await installIconPackage('@acme/icons', { icons: [] })

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources).toEqual([])
  })

  it('infers react for a react-rendering package and filters it out of a vue prototype', async () => {
    await writePkgJson({ dependencies: { 'lucide-icons-react': '^1.0.0' } })
    await installIconPackage('lucide-icons-react', { renderer: 'react', ext: '.js' })

    const reactSources = await autoDetectIconSets({ prototypeRoot, framework: 'react' })
    expect(reactSources.map((s) => s.id)).toEqual(['lucide-icons-react'])
    expect(reactSources[0].framework).toBe('react')

    const vueSources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(vueSources).toEqual([])
  })

  it('returns every detected set when no framework filter is given', async () => {
    await writePkgJson({
      dependencies: { '@acme/icons': '^1.0.0', 'other-icons': '^1.0.0' },
    })
    await installIconPackage('@acme/icons')
    await installIconPackage('other-icons', { renderer: 'react', ext: '.js' })

    const sources = await autoDetectIconSets({ prototypeRoot })
    expect(sources.map((s) => s.id).sort()).toEqual(['acme-icons', 'other-icons'])
  })

  it('scans devDependencies, peerDependencies, and optionalDependencies too', async () => {
    await writePkgJson({ devDependencies: { '@acme/icons': '^1.0.0' } })
    await installIconPackage('@acme/icons')

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources.map((s) => s.id)).toEqual(['acme-icons'])
  })

  it('ignores malformed package.json without throwing', async () => {
    await writeFile(join(prototypeRoot, 'package.json'), '{ not valid json')

    const sources = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sources).toEqual([])
  })

  it('derives stable, collision-free ids and human labels from package names', () => {
    expect(iconSetId('@acme/icons')).toBe('acme-icons')
    expect(iconSetId('tabler-icons-vue')).toBe('tabler-icons-vue')
    expect(iconSetLabel('@acme/icons')).toBe('Acme Icons')
    expect(iconSetLabel('tabler-icons-vue')).toBe('Tabler Icons Vue')
  })

  it('gates candidates on an icon-ish name before doing any filesystem work', () => {
    expect(__testing.ICON_ISH_NAME_RE.test('@acme/icons')).toBe(true)
    expect(__testing.ICON_ISH_NAME_RE.test('@heroicons/vue')).toBe(true)
    expect(__testing.ICON_ISH_NAME_RE.test('axios')).toBe(false)
  })
})

/**
 * Regression: the probe budget must bound WORK, not truncate the candidate
 * list.
 *
 * Candidates were sliced to a cap BEFORE shape verification, so detection
 * depended on package.json order — a project carrying more icon-ish
 * dependency NAMES than the cap would silently skip a genuinely valid icon
 * package sitting later in the list, because unsupported candidates ahead of
 * it had already spent the budget. Several icon-ish names in one project is
 * ordinary (lucide, heroicons, iconify, phosphor, a first-party set…), and
 * the failure was invisible: an empty picker with no reason given.
 */
describe('autoDetectIconSets — candidate budget', () => {
  let prototypeRoot: string

  beforeEach(async () => {
    prototypeRoot = await mkdtemp(join(tmpdir(), 'pt-icon-budget-'))
  })
  afterEach(async () => {
    await rm(prototypeRoot, { recursive: true, force: true })
  })

  it('finds a valid icon package listed after many icon-ish non-packages', async () => {
    // Twelve icon-ish names that are NOT installed (so each probe fails),
    // then the real one last. Under the old slice-first cap of 8 the real
    // package was never probed.
    const decoys: Record<string, string> = {}
    for (let i = 0; i < 12; i += 1) decoys[`@decoy/icons-${i}`] = '^1.0.0'

    await writeFile(
      join(prototypeRoot, 'package.json'),
      JSON.stringify({
        name: 'prototype',
        dependencies: { ...decoys, '@real/icons': '^1.0.0' },
      }),
    )

    const pkgDir = join(prototypeRoot, 'node_modules', '@real', 'icons')
    const typesDir = join(pkgDir, 'dist', 'types')
    await mkdir(join(typesDir, 'components'), { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@real/icons',
        version: '1.0.0',
        types: 'dist/types/index.d.ts',
        peerDependencies: { vue: '^3.0.0' },
      }),
    )
    await writeFile(join(typesDir, 'index.d.ts'), `export * from './components';\n`)
    await writeFile(
      join(typesDir, 'components', 'index.d.ts'),
      ['StarIcon', 'HeartIcon']
        .map((n) => `export { default as ${n} } from './${n}.vue';`)
        .join('\n') + '\n',
    )
    for (const n of ['StarIcon', 'HeartIcon']) {
      await writeFile(join(typesDir, 'components', `${n}.vue.d.ts`), 'export default {};\n')
    }

    const sets = await autoDetectIconSets({ prototypeRoot })
    expect(sets.map((s) => s.id)).toContain(iconSetId('@real/icons'))
  })
})

/**
 * Regression: wrong-framework packages must not starve the probe budget.
 *
 * Bounding work rather than truncating candidates fixed order-dependence for
 * FAILED probes, but a package that probes SUCCESSFULLY and is then discarded
 * by the framework filter had still spent budget. A Vue prototype carrying
 * enough React icon packages ahead of its Vue one would therefore still end
 * up with an empty picker — the same bug in a new place. The framework a
 * package declares is readable from its package.json alone, so a definite
 * mismatch is skipped before it can cost anything.
 */
describe('autoDetectIconSets — wrong-framework candidates do not starve detection', () => {
  let prototypeRoot: string

  beforeEach(async () => {
    prototypeRoot = await mkdtemp(join(tmpdir(), 'pt-icon-starve-'))
  })
  afterEach(async () => {
    await rm(prototypeRoot, { recursive: true, force: true })
  })

  async function install(packageName: string, renderer: 'vue' | 'react'): Promise<void> {
    const pkgDir = join(prototypeRoot, 'node_modules', ...packageName.split('/'))
    const typesDir = join(pkgDir, 'dist', 'types')
    await mkdir(join(typesDir, 'components'), { recursive: true })
    const ext = renderer === 'vue' ? '.vue' : '.tsx'
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        types: 'dist/types/index.d.ts',
        peerDependencies: renderer === 'vue' ? { vue: '^3.0.0' } : { react: '^18.0.0' },
      }),
    )
    await writeFile(join(typesDir, 'index.d.ts'), `export * from './components';\n`)
    await writeFile(
      join(typesDir, 'components', 'index.d.ts'),
      `export { default as StarIcon } from './StarIcon${ext}';\n`,
    )
    await writeFile(join(typesDir, 'components', `StarIcon${ext}.d.ts`), 'export default {};\n')
  }

  it('finds the Vue icon set behind 40 valid React icon packages', async () => {
    const deps: Record<string, string> = {}
    for (let i = 0; i < 40; i += 1) deps[`@react-only/icons-${i}`] = '^1.0.0'
    deps['@vue-real/icons'] = '^1.0.0'

    await writeFile(
      join(prototypeRoot, 'package.json'),
      JSON.stringify({ name: 'prototype', dependencies: deps }),
    )
    for (let i = 0; i < 40; i += 1) await install(`@react-only/icons-${i}`, 'react')
    await install('@vue-real/icons', 'vue')

    const sets = await autoDetectIconSets({ prototypeRoot, framework: 'vue3' })
    expect(sets.map((s) => s.id)).toContain(iconSetId('@vue-real/icons'))
  })
})
