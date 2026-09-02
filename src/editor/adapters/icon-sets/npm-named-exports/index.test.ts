import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NpmNamedExportsAdapter, __testing } from './index'

const LIVE_PROTOTYPE = '/Users/mo.chang/Documents/Prototypes/Test/ai-gateway-prototype'
const LIVE_PROTOTYPE_INSTALLED = existsSync(join(LIVE_PROTOTYPE, 'node_modules', '@acme/icons', 'package.json'))

describe('humanize', () => {
  it.each([
    ['DataObjectIcon', 'Data object'],
    ['AddIcon', 'Add'],
    ['ArrowTopLeftIcon', 'Arrow top left'],
    ['AiAgentIcon', 'Ai agent'],
    ['AwsIcon', 'Aws'],
    ['KeyIcon', 'Key'],
    ['Icon', 'Icon'], // edge case: nothing left after stripping suffix
  ])('humanizes %s to %s', (input, expected) => {
    expect(__testing.humanize(input)).toBe(expected)
  })
})

describe('NpmNamedExportsAdapter — synthetic package', () => {
  let prototypeRoot: string
  const packageName = '@example/icons'

  beforeEach(async () => {
    prototypeRoot = await mkdtemp(join(tmpdir(), 'pt-icon-adapter-'))
    const pkgDir = join(prototypeRoot, 'node_modules', packageName)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0', types: 'dist/index.d.ts' }),
    )
    const distDir = join(pkgDir, 'dist')
    await mkdir(distDir, { recursive: true })
    await writeFile(join(distDir, 'index.d.ts'), `export * from './solid';`)
    const solidDir = join(distDir, 'solid')
    await mkdir(solidDir)
    await writeFile(
      join(solidDir, 'index.d.ts'),
      [
        `export { default as AddIcon } from './AddIcon';`,
        `export { default as TrashIcon } from './TrashIcon';`,
        `export { default as helperFn } from './helperFn';`,
      ].join('\n'),
    )
  })

  afterEach(async () => {
    await rm(prototypeRoot, { recursive: true, force: true })
  })

  it('enumerates icons with humanized labels and category', async () => {
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName,
      id: 'example-icons',
      displayName: 'Example Icons',
      framework: 'vue3',
      skipPreviews: true,
    })

    const icons = await adapter.listIcons()
    expect(icons.map((i) => i.id).sort()).toEqual(['AddIcon', 'TrashIcon'])

    const add = icons.find((i) => i.id === 'AddIcon')!
    expect(add.displayName).toBe('Add')
    expect(add.category).toBe('solid')
    expect(add.ref).toEqual({
      kind: 'named-component-import',
      exportName: 'AddIcon',
      importPath: packageName,
    })
    expect(add.preview.kind).toBe('svg')
  })

  it('exposes the named-component-import usage pattern with the package name', () => {
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName,
      id: 'example-icons',
      displayName: 'Example Icons',
      framework: 'vue3',
      skipPreviews: true,
    })

    expect(adapter.usagePattern).toEqual({
      kind: 'named-component-import',
      packageName,
    })
  })

  it('getIcon returns null for unknown ids', async () => {
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName,
      id: 'example-icons',
      displayName: 'Example Icons',
      framework: 'vue3',
      skipPreviews: true,
    })

    expect(await adapter.getIcon('NotARealIcon')).toBeNull()
    expect(await adapter.getIcon('AddIcon')).not.toBeNull()
  })

  it('caches the icon list across calls', async () => {
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName,
      id: 'example-icons',
      displayName: 'Example Icons',
      framework: 'vue3',
      skipPreviews: true,
    })

    const a = await adapter.listIcons()
    const b = await adapter.listIcons()
    expect(a).toBe(b)
  })

  it('throws when the package is not installed', async () => {
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName: '@example/not-installed',
      id: 'missing',
      displayName: 'Missing',
      framework: 'vue3',
    })

    await expect(adapter.listIcons()).rejects.toThrow(/Cannot read package\.json/)
  })

  it('does not cache rejected promises across listIcons() calls', async () => {
    // First call: package missing → rejects. Without rejection clearing,
    // the cached rejected promise would poison every subsequent call.
    // "Install" the package between calls and verify the adapter recovers.
    const lateInstall = '@example/late-install'
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName: lateInstall,
      id: 'late',
      displayName: 'Late',
      framework: 'vue3',
      skipPreviews: true,
    })

    await expect(adapter.listIcons()).rejects.toThrow(/Cannot read package\.json/)

    const pkgDir = join(prototypeRoot, 'node_modules', lateInstall)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: lateInstall, version: '1.0.0', types: 'index.d.ts' }),
    )
    await writeFile(
      join(pkgDir, 'index.d.ts'),
      `export { default as AddIcon } from './AddIcon';`,
    )

    const icons = await adapter.listIcons()
    expect(icons.map((i) => i.id)).toEqual(['AddIcon'])
  })

  it('throws when the package has no types entry', async () => {
    const noTypesPkg = '@example/no-types'
    const pkgDir = join(prototypeRoot, 'node_modules', noTypesPkg)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: noTypesPkg, version: '1.0.0' }))

    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName: noTypesPkg,
      id: 'no-types',
      displayName: 'No Types',
      framework: 'vue3',
    })

    await expect(adapter.listIcons()).rejects.toThrow(/no "types" or "typings"/)
  })

  it('falls back to placeholder previews when the renderer subprocess fails', async () => {
    // Don't pass skipPreviews — let the renderer try and fail. The
    // synthetic package's "icons" are empty files, not real Vue
    // components, so the subprocess import will throw and we expect
    // the adapter to swallow that and emit placeholders.
    const adapter = new NpmNamedExportsAdapter({
      prototypeRoot,
      packageName,
      id: 'example-icons',
      displayName: 'Example Icons',
      framework: 'vue3',
    })

    const icons = await adapter.listIcons()
    expect(icons.length).toBeGreaterThan(0)
    expect(
      icons.every(
        (i) => i.preview.kind === 'svg' && i.preview.markup.includes('stroke-dasharray'),
      ),
    ).toBe(true)
  })
})

describe.skipIf(!LIVE_PROTOTYPE_INSTALLED)(
  'NpmNamedExportsAdapter — integration with real @acme/icons',
  () => {
    it('enumerates the live the package icons set with categories from the dist/types tree', async () => {
      const adapter = new NpmNamedExportsAdapter({
        prototypeRoot: LIVE_PROTOTYPE,
        packageName: '@acme/icons',
        id: 'acme-icons',
        displayName: 'Acme Icons',
        framework: 'vue3',
      })

      const icons = await adapter.listIcons()

      // The package ships 500+ icons; assert a generous lower bound so a
      // single new icon doesn't break the test.
      expect(icons.length).toBeGreaterThan(400)

      const dataObject = icons.find((i) => i.id === 'DataObjectIcon')
      expect(dataObject).toBeDefined()
      expect(dataObject?.displayName).toBe('Data object')
      expect(dataObject?.ref).toEqual({
        kind: 'named-component-import',
        exportName: 'DataObjectIcon',
        importPath: '@acme/icons',
      })

      // Verify category bucketing came through (the package types tree is
      // organized into solid / multi-color / flags subfolders).
      const categories = new Set(icons.map((i) => i.category).filter(Boolean))
      expect(categories.size).toBeGreaterThanOrEqual(2)

      // Real preview render must produce SVG markup for the live set
      // — not the placeholder. Sample a known icon.
      expect(dataObject?.preview.kind).toBe('svg')
      expect(dataObject?.preview.kind === 'svg' && dataObject.preview.markup.includes('<path')).toBe(true)
      expect(dataObject?.preview.kind === 'svg' && dataObject.preview.markup.includes('stroke-dasharray')).toBe(false)
    }, 60_000)
  },
)
