/**
 * `detectFirstParty` against real temp directories. The shadcn marker is a
 * file on disk with a vendor `$schema`, so the tests write one; the count
 * comes through the same adapters the boot uses, so a `.tsx` with an exported
 * component is enough to make it non-zero.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFirstParty } from './detect-first-party'

const BUTTON_TSX = `
export function Button({ variant = "default" }: { variant?: "default" | "outline" }) {
  return <button data-variant={variant} />
}
`

describe('detectFirstParty', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'desde-first-party-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns null for a repo with no marker and no components', async () => {
    await writeFile(path.join(root, 'README.md'), '# empty')
    expect(await detectFirstParty(root)).toBeNull()
  })

  it('names shadcn/ui from components.json and counts the first-party components', async () => {
    await writeFile(
      path.join(root, 'components.json'),
      JSON.stringify({ $schema: 'https://ui.shadcn.com/schema.json', style: 'radix-nova' }),
    )
    await mkdir(path.join(root, 'src/components/ui'), { recursive: true })
    await writeFile(path.join(root, 'src/components/ui/button.tsx'), BUTTON_TSX)

    const detection = await detectFirstParty(root)
    expect(detection).toEqual({
      system: { id: 'shadcn', label: 'shadcn/ui', style: 'radix-nova' },
      componentCount: 1,
    })
  })

  it('reports first-party components with no named system when there is no marker', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/Button.tsx'), BUTTON_TSX)

    expect(await detectFirstParty(root)).toEqual({ system: null, componentCount: 1 })
  })

  it('ignores a components.json that is not shadcn', async () => {
    // Same filename, some other tool: the $schema is what proves the vendor.
    await writeFile(path.join(root, 'components.json'), JSON.stringify({ components: [] }))
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/Button.tsx'), BUTTON_TSX)

    expect(await detectFirstParty(root)).toEqual({ system: null, componentCount: 1 })
  })

  it('does not count tests or files under node_modules', async () => {
    await mkdir(path.join(root, 'node_modules/lib'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/lib/Vendored.tsx'), BUTTON_TSX)
    await mkdir(path.join(root, 'src'), { recursive: true })
    await writeFile(path.join(root, 'src/Button.test.tsx'), BUTTON_TSX)

    expect(await detectFirstParty(root)).toBeNull()
  })
})
