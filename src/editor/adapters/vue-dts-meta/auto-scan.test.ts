/**
 * Tests for `scanInstalledVueLibraries` — which installed packages the Vue
 * manifest pipeline offers to `discoverVueDtsComponents`, and which
 * declaration root it picks for each.
 *
 * Filesystem-only (no TS checker), so these run against tmpdir trees shaped
 * after real installs.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanInstalledVueLibraries } from './auto-scan'

const tmpDirs: string[] = []

async function mkPrototype(
  packages: Record<string, Record<string, string>>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-auto-scan-'))
  tmpDirs.push(root)
  for (const [packageName, files] of Object.entries(packages)) {
    const pkgRoot = path.join(root, 'node_modules', ...packageName.split('/'))
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(pkgRoot, rel)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content)
    }
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  )
})

describe('scanInstalledVueLibraries', () => {
  it('prefers the deepest matching dist root', async () => {
    const root = await mkPrototype({
      'acme-ui': {
        'dist/types/components/Alpha.vue.d.ts': '',
        'dist/types/index.d.ts': '',
      },
    })
    const found = await scanInstalledVueLibraries(root)
    expect(found).toHaveLength(1)
    expect(path.relative(found[0].packageRoot, found[0].dtsRoot)).toBe(
      path.join('dist', 'types', 'components'),
    )
  })

  it('finds a package that ships components at its root with no dist tree', async () => {
    // PrimeVue's shape: `primevue/button/index.d.ts` beside `Button.vue`,
    // and no `dist` anywhere. Before the package root was a probe root AND
    // the barrel layout counted, this package scanned to nothing.
    const root = await mkPrototype({
      primevue: {
        'button/index.d.ts': 'export default {} as unknown\n',
        'button/Button.vue': '<template><button /></template>\n',
        'config/index.d.ts': 'export default {} as unknown\n',
        'package.json': '{"name":"primevue","version":"4.5.4"}',
      },
    })
    const found = await scanInstalledVueLibraries(root)
    expect(found).toHaveLength(1)
    expect(found[0].packageName).toBe('primevue')
    expect(path.relative(found[0].packageRoot, found[0].dtsRoot)).toBe('')
  })

  it('scans scoped packages', async () => {
    const root = await mkPrototype({
      '@acme/ui': {
        'card/index.d.ts': 'export default {} as unknown\n',
        'card/CardPanel.vue': '<template><div /></template>\n',
      },
    })
    const found = await scanInstalledVueLibraries(root)
    expect(found.map((f) => f.packageName)).toEqual(['@acme/ui'])
  })

  it('ignores an index.d.ts whose sibling SFC is unrelated to its directory', async () => {
    // Nuxt ships `dist/pages/runtime/index.d.ts` next to `app.vue`. The
    // colocation is incidental; treating it as a declaration invented a
    // bogus component.
    const root = await mkPrototype({
      'some-lib': {
        'dist/pages/runtime/index.d.ts': 'export default {} as unknown\n',
        'dist/pages/runtime/app.vue': '<template><div /></template>\n',
      },
    })
    expect(await scanInstalledVueLibraries(root)).toEqual([])
  })

  it('ignores a package with declarations but no Vue components', async () => {
    const root = await mkPrototype({
      'plain-lib': { 'dist/index.d.ts': 'export declare const x: number;\n' },
    })
    expect(await scanInstalledVueLibraries(root)).toEqual([])
  })

  it("does not credit a package for a nested dependency's components", async () => {
    const root = await mkPrototype({
      'wrapper-lib': {
        'dist/index.d.ts': 'export declare const x: number;\n',
        'node_modules/inner-ui/dist/types/Alpha.vue.d.ts': '',
      },
    })
    expect(await scanInstalledVueLibraries(root)).toEqual([])
  })

  it('returns nothing when there is no node_modules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-auto-scan-'))
    tmpDirs.push(root)
    expect(await scanInstalledVueLibraries(root)).toEqual([])
  })
})
