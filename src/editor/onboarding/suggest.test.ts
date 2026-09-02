import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractPackageName, suggestDesignSystems } from './suggest'

describe('extractPackageName', () => {
  it('resolves scoped + unscoped package names and ignores relative paths', () => {
    expect(extractPackageName('@acme/design-system')).toBe('@acme/design-system')
    expect(extractPackageName('@acme/design-system/dist/styles.css')).toBe('@acme/design-system')
    expect(extractPackageName('vue')).toBe('vue')
    expect(extractPackageName('vue/dist/runtime')).toBe('vue')
    expect(extractPackageName('./local')).toBeNull()
    expect(extractPackageName('../up')).toBeNull()
    expect(extractPackageName('/abs')).toBeNull()
    expect(extractPackageName('')).toBeNull()
    expect(extractPackageName('@scope')).toBeNull()
  })
})

describe('suggestDesignSystems', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-suggest-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function write(rel: string, content: string): Promise<void> {
    const full = join(root, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  it('suggests an installed Vue lib that the prototype depends on + imports', async () => {
    await write('package.json', JSON.stringify({ dependencies: { '@acme/design-system': '^9.0.0' } }))
    await write(
      'node_modules/@acme/design-system/package.json',
      JSON.stringify({ name: '@acme/design-system', version: '9.0.0' }),
    )
    await write('node_modules/@acme/design-system/dist/types/components/UiButton.vue.d.ts', 'export default {}')
    // Two source files import it → importFrequency 2.
    await write('src/App.vue', `<script setup>\nimport { UiButton } from '@acme/design-system'\n</script>`)
    await write('src/Page.vue', `<script setup>\nimport { UiButton } from '@acme/design-system'\n</script>`)

    const out = await suggestDesignSystems(root)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      package: '@acme/design-system',
      version: '9.0.0',
      framework: 'vue3',
      componentCount: 1,
      importFrequency: 2,
    })
  })

  it('excludes a Vue lib not declared in the prototype package.json deps', async () => {
    // Installed (transitive) but NOT a declared dependency → not a "used" DS.
    await write('package.json', JSON.stringify({ dependencies: {} }))
    await write(
      'node_modules/@other/lib/package.json',
      JSON.stringify({ name: '@other/lib', version: '1.0.0' }),
    )
    await write('node_modules/@other/lib/dist/types/components/Thing.vue.d.ts', 'export default {}')

    expect(await suggestDesignSystems(root)).toEqual([])
  })

  it('ranks by import frequency (most-imported first)', async () => {
    await write(
      'package.json',
      JSON.stringify({ dependencies: { '@a/ui': '1', '@b/ui': '1' } }),
    )
    for (const name of ['@a/ui', '@b/ui']) {
      await write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }))
      await write(`node_modules/${name}/dist/types/components/C.vue.d.ts`, 'export default {}')
    }
    // @b/ui imported in 2 files, @a/ui in 1.
    await write('src/One.vue', `import { C } from '@a/ui'\nimport { C as D } from '@b/ui'`)
    await write('src/Two.vue', `import { C } from '@b/ui'`)

    const out = await suggestDesignSystems(root)
    expect(out.map((s) => s.package)).toEqual(['@b/ui', '@a/ui'])
  })
})
