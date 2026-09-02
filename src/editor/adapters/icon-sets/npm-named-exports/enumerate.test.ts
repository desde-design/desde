import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enumerateNamedExports } from './enumerate'

describe('enumerateNamedExports', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-icon-enum-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns flat list when entry declares icons directly', async () => {
    await writeFile(
      join(root, 'index.d.ts'),
      [
        `export { default as AddIcon } from './AddIcon.vue';`,
        `export { default as TrashIcon } from './TrashIcon.vue';`,
      ].join('\n'),
    )
    await writeFile(join(root, 'AddIcon.vue'), '<template/>')
    await writeFile(join(root, 'TrashIcon.vue'), '<template/>')

    const result = await enumerateNamedExports({ rootTypesFile: join(root, 'index.d.ts') })

    expect(result.map((r) => r.exportName).sort()).toEqual(['AddIcon', 'TrashIcon'])
    expect(result.every((r) => r.categoryPath.length === 0)).toBe(true)
    expect(result.find((r) => r.exportName === 'AddIcon')?.sourceFile).toBe(
      join(root, 'AddIcon.vue'),
    )
  })

  it('walks export-star redirects and tracks the category path', async () => {
    // pkg/index.d.ts -> components/index.d.ts -> solid/index.d.ts -> { AddIcon }
    await writeFile(join(root, 'index.d.ts'), `export * from './components';`)
    await mkdir(join(root, 'components'))
    await writeFile(
      join(root, 'components', 'index.d.ts'),
      [`export * from './solid';`, `export * from './flags';`].join('\n'),
    )
    await mkdir(join(root, 'components', 'solid'))
    await writeFile(
      join(root, 'components', 'solid', 'index.d.ts'),
      `export { default as AddIcon } from './AddIcon.vue';`,
    )
    await writeFile(join(root, 'components', 'solid', 'AddIcon.vue'), '<template/>')
    await mkdir(join(root, 'components', 'flags'))
    await writeFile(
      join(root, 'components', 'flags', 'index.d.ts'),
      `export { default as UsFlagIcon } from './UsFlagIcon.vue';`,
    )
    await writeFile(join(root, 'components', 'flags', 'UsFlagIcon.vue'), '<template/>')

    const result = await enumerateNamedExports({ rootTypesFile: join(root, 'index.d.ts') })

    const byName = new Map(result.map((r) => [r.exportName, r]))
    expect(byName.get('AddIcon')?.categoryPath).toEqual(['components', 'solid'])
    expect(byName.get('UsFlagIcon')?.categoryPath).toEqual(['components', 'flags'])
  })

  it('ignores exports that do not match the icon pattern', async () => {
    await writeFile(
      join(root, 'index.d.ts'),
      [
        `export { default as AddIcon } from './AddIcon.vue';`,
        `export { default as helperFn } from './helperFn';`,
        `export { default as BaseRenderer } from './BaseRenderer';`,
      ].join('\n'),
    )

    const result = await enumerateNamedExports({ rootTypesFile: join(root, 'index.d.ts') })

    expect(result.map((r) => r.exportName)).toEqual(['AddIcon'])
  })

  it('honors a custom icon pattern', async () => {
    await writeFile(
      join(root, 'index.d.ts'),
      [
        `export { default as Trash } from './Trash';`,
        `export { default as helperFn } from './helperFn';`,
      ].join('\n'),
    )

    const result = await enumerateNamedExports({
      rootTypesFile: join(root, 'index.d.ts'),
      iconPattern: /^[A-Z]/,
    })

    expect(result.map((r) => r.exportName)).toEqual(['Trash'])
  })

  it('does not recurse forever when files reference each other', async () => {
    await writeFile(join(root, 'a.d.ts'), `export * from './b';`)
    await writeFile(join(root, 'b.d.ts'), `export * from './a';`)

    const result = await enumerateNamedExports({ rootTypesFile: join(root, 'a.d.ts') })

    expect(result).toEqual([])
  })

  it('respects maxDepth', async () => {
    // a -> b -> c -> d -> e -> IconX  (depth 5)
    await writeFile(join(root, 'a.d.ts'), `export * from './b';`)
    await writeFile(join(root, 'b.d.ts'), `export * from './c';`)
    await writeFile(join(root, 'c.d.ts'), `export * from './d';`)
    await writeFile(join(root, 'd.d.ts'), `export * from './e';`)
    await writeFile(
      join(root, 'e.d.ts'),
      `export { default as DeepIcon } from './DeepIcon.vue';`,
    )

    const tooShallow = await enumerateNamedExports({
      rootTypesFile: join(root, 'a.d.ts'),
      maxDepth: 3,
    })
    expect(tooShallow).toEqual([])

    const deepEnough = await enumerateNamedExports({
      rootTypesFile: join(root, 'a.d.ts'),
      maxDepth: 6,
    })
    expect(deepEnough.map((r) => r.exportName)).toEqual(['DeepIcon'])
  })

  it('skips export-star redirects that resolve to nothing on disk', async () => {
    await writeFile(
      join(root, 'index.d.ts'),
      [
        `export * from './does-not-exist';`,
        `export { default as AddIcon } from './AddIcon.vue';`,
      ].join('\n'),
    )

    const result = await enumerateNamedExports({ rootTypesFile: join(root, 'index.d.ts') })

    expect(result.map((r) => r.exportName)).toEqual(['AddIcon'])
  })
})
