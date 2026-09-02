import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectFramework } from './detect-framework'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pt-detect-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

describe('detectFramework', () => {
  it('detects vue3 from a *.vue.d.ts under dist/types/components', async () => {
    const dir = await pkg('acme', {
      'package.json': JSON.stringify({ name: '@acme/design-system', version: '1.0.0' }),
      'dist/types/components/UiButton.vue.d.ts': 'export default {}',
    })
    expect(detectFramework(dir)).toEqual({
      framework: 'vue3',
      via: 'vue-dts',
      dtsRoot: 'dist/types/components',
    })
  })

  it('detects vue3 even when the .vue.d.ts is nested deeper under a dts root', async () => {
    const dir = await pkg('acme2', {
      'package.json': '{}',
      'dist/types/a/b/UiCard.vue.d.ts': 'export default {}',
    })
    expect(detectFramework(dir).framework).toBe('vue3')
  })

  it('detects react from a resolvable .d.ts types entry (no vue.d.ts)', async () => {
    const dir = await pkg('radix', {
      'package.json': JSON.stringify({ name: '@radix-ui/react-switch', version: '1', types: './index.d.ts' }),
      'index.d.ts': 'export declare const Switch: unknown',
    })
    const res = detectFramework(dir)
    expect(res.framework).toBe('react')
    if (res.framework === 'react') {
      expect(res.entryFiles.some((f) => f.endsWith('index.d.ts'))).toBe(true)
    }
  })

  it('returns unknown when there is neither a vue.d.ts nor a types entry', async () => {
    const dir = await pkg('plain', {
      'package.json': JSON.stringify({ name: 'plain-lib', version: '1', main: './index.js' }),
      'index.js': 'module.exports = {}',
    })
    expect(detectFramework(dir)).toEqual({ framework: 'unknown' })
  })

  it('vue wins over react when both signals are present', async () => {
    const dir = await pkg('both', {
      'package.json': JSON.stringify({ name: 'both', version: '1', types: './index.d.ts' }),
      'index.d.ts': 'export declare const X: unknown',
      'dist/types/Y.vue.d.ts': 'export default {}',
    })
    expect(detectFramework(dir).framework).toBe('vue3')
  })
})
