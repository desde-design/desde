import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ListedReactComponent } from '@/editor/adapters/react-dts-meta/count-components'
import { extractPackageName, looksLikeIconSet, suggestDesignSystems } from './suggest'

/** Each name takes its own props: the design-system shape of a list. */
const own = (names: readonly string[]): ListedReactComponent[] =>
  names.map((name, i) => ({ name, propsType: `#${i}` }))
/** Every name takes the same props: the icon-set shape of a list. */
const shared = (names: readonly string[], propsType: string | null = '#shared'): ListedReactComponent[] =>
  names.map((name) => ({ name, propsType }))

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
      confidence: 'certain',
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

/**
 * The React arm. Its marker (declared dep + `react` peer + a `.d.ts` entry) is
 * weaker than `*.vue.d.ts`, so it also demands that the prototype imports the
 * package and that the entry exports something that types as a component.
 * Hermetic: no `@types/react`; a PascalCase callable taking an object is a
 * component to the extractor's predicate, and that is what is used here.
 */
describe('suggestDesignSystems (React arm)', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-suggest-react-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function write(rel: string, content: string): Promise<void> {
    const full = join(root, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  /** A React component library: `react` peer, a `types` entry, two components and a hook. */
  async function writeReactLib(name: string, version = '2.0.0'): Promise<void> {
    await write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version, types: 'dist/index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write(
      `node_modules/${name}/dist/index.d.ts`,
      [
        'interface ButtonProps { tone?: "primary" | "danger"; }',
        'interface ReactElement { readonly $$typeof: symbol; }',
        'declare const Button: (props: ButtonProps) => ReactElement;',
        'declare const Card: (props: { title?: string }) => ReactElement;',
        'declare const useTheme: () => string;',
        'export { Button, Card, useTheme };',
      ].join('\n'),
    )
  }

  it('suggests an imported React component library, counting only its components', async () => {
    await write('package.json', JSON.stringify({ dependencies: { '@acme/react-ui': '^2.0.0' } }))
    await writeReactLib('@acme/react-ui')
    await write('src/App.tsx', `import { Button } from '@acme/react-ui'`)
    await write('src/Page.tsx', `import { Card } from '@acme/react-ui'`)

    const out = await suggestDesignSystems(root)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      package: '@acme/react-ui',
      version: '2.0.0',
      framework: 'react',
      componentCount: 2,
      importFrequency: 2,
      confidence: 'likely',
    })
  })

  it('does not suggest a React library the prototype never imports', async () => {
    await write('package.json', JSON.stringify({ dependencies: { '@acme/react-ui': '^2.0.0' } }))
    await writeReactLib('@acme/react-ui')
    await write('src/App.tsx', `export const App = () => null`)

    expect(await suggestDesignSystems(root)).toEqual([])
  })

  it('does not suggest a React-peer package that exports no components (hooks, clients, routers)', async () => {
    await write('package.json', JSON.stringify({ dependencies: { 'use-things': '1.0.0' } }))
    await write(
      'node_modules/use-things/package.json',
      JSON.stringify({ name: 'use-things', version: '1.0.0', types: 'index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write(
      'node_modules/use-things/index.d.ts',
      'export declare function useThing(): void;\nexport declare const VERSION: string;',
    )
    await write('src/App.tsx', `import { useThing } from 'use-things'`)

    expect(await suggestDesignSystems(root)).toEqual([])
  })

  it('works for a plain-JavaScript prototype with no tsconfig', async () => {
    await write('package.json', JSON.stringify({ dependencies: { '@acme/react-ui': '^2.0.0' } }))
    await writeReactLib('@acme/react-ui')
    await write('src/App.jsx', `import { Button } from '@acme/react-ui'`)

    const out = await suggestDesignSystems(root)
    expect(out.map((s) => s.package)).toEqual(['@acme/react-ui'])
  })

  it('ranks Vue and React libraries in one list by import frequency, and reports a Vue package once', async () => {
    await write(
      'package.json',
      JSON.stringify({ dependencies: { '@acme/react-ui': '^2.0.0', '@acme/vue-ui': '^1.0.0' } }),
    )
    await writeReactLib('@acme/react-ui')
    // A Vue library that ALSO lists react as a peer must not be offered twice.
    await write(
      'node_modules/@acme/vue-ui/package.json',
      JSON.stringify({ name: '@acme/vue-ui', version: '1.0.0', types: 'dist/index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write('node_modules/@acme/vue-ui/dist/index.d.ts', 'export {}')
    await write('node_modules/@acme/vue-ui/dist/types/components/UiButton.vue.d.ts', 'export default {}')
    await write('src/A.tsx', `import { Button } from '@acme/react-ui'`)
    await write('src/B.tsx', `import { Button } from '@acme/react-ui'`)
    await write('src/C.vue', `<script setup>\nimport { UiButton } from '@acme/vue-ui'\n</script>`)

    const out = await suggestDesignSystems(root)
    expect(out.map((s) => [s.package, s.framework])).toEqual([
      ['@acme/react-ui', 'react'],
      ['@acme/vue-ui', 'vue3'],
    ])
  })
})

/** Design-system part names (Chakra's vocabulary) and icon variant names. */
const DS_PARTS = ['Root', 'Trigger', 'Content', 'Item', 'Indicator', 'Label', 'Context', 'Provider']
const ICON_VARIANTS = ['Outlined', 'Rounded', 'Sharp', 'TwoTone', 'Filled']

/**
 * `families` distinct first words, with `total` names spread over them using
 * `parts` as suffixes.
 *
 * A compound design system and a variant-per-glyph icon set have the SAME
 * shape under this builder. Only the family count differs, which is the whole
 * point: it is the one thing that tells them apart. Counts come from the
 * measurement table in `suggest.ts`.
 */
function spread(families: number, total: number, parts: readonly string[]): string[] {
  const stems = Array.from({ length: families }, (_, i) => `Stem${String(i).padStart(4, '0')}`)
  const names: string[] = []
  for (let round = 0; names.length < total; round++) {
    for (const stem of stems) {
      if (names.length >= total) break
      names.push(round === 0 ? stem : `${stem}${parts[(round - 1) % parts.length]}`)
    }
  }
  return names
}

describe('looksLikeIconSet', () => {
  const comps = (n: number, fmt: (i: number) => string) => Array.from({ length: n }, (_, i) => fmt(i))

  // 120 families: above @shopify/polaris (89, the largest flat design system
  // measured) and above @chakra-ui/react (114), below the 150 flat floor.
  it('a design-system-sized list of ordinary names is not an icon set', () => {
    expect(looksLikeIconSet(own(comps(120, (i) => `Widget${i}`)))).toBe(false)
  })
  it('a majority of `XIcon` or `IconX` names is an icon set', () => {
    expect(looksLikeIconSet(own(comps(40, (i) => (i % 2 ? `Thing${i}Icon` : `Thing${i}`))))).toBe(true)
    expect(looksLikeIconSet(own(comps(40, (i) => `IconThing${i}`)))).toBe(true)
  })
  it('a small list is never judged by name (a design system may ship a few icons)', () => {
    expect(looksLikeIconSet(own(['MenuIcon', 'CloseIcon', 'Button']))).toBe(false)
  })

  // The defect this rule was rewritten for: Chakra v3 exports 775 symbols that
  // type as React components, and the old rule called anything over 400 icons.
  it('a compound design system is not an icon set however many parts it exports', () => {
    const chakra = spread(114, 775, DS_PARTS)
    expect(chakra).toHaveLength(775)
    expect(looksLikeIconSet(own(chakra))).toBe(false)
  })

  // Why a bigger number would not have worked either: @ant-design/icons ships
  // 832 exports and Chakra ships 775, so no raw cutoff separates them. The
  // family count does: 319 against 114. Same total, same builder, one differs.
  it('separates an icon set from a design system of the same export count', () => {
    expect(looksLikeIconSet(own(spread(319, 832, ICON_VARIANTS)))).toBe(true)
    expect(looksLikeIconSet(own(spread(114, 832, DS_PARTS)))).toBe(false)
  })

  // lucide-react: 5,211 exports, only 33% icon-named, because each glyph also
  // ships bare and brand-prefixed. @mui/icons-material is worse — 10,615
  // exports, not one of them named `Icon`. The name ratio misses both.
  it('catches an icon set that the name ratio misses', () => {
    const lucide = Array.from({ length: 1737 }, (_, i) => `Glyph${i}`).flatMap((g) => [
      g,
      `${g}Icon`,
      `Lucide${g}`,
    ])
    expect(lucide).toHaveLength(5211)
    expect(lucide.filter((n) => /Icon$/.test(n)).length / lucide.length).toBeLessThan(0.5)
    expect(looksLikeIconSet(own(lucide))).toBe(true)

    const muiIcons = spread(2121, 10615, ICON_VARIANTS)
    expect(muiIcons.some((n) => /Icon/.test(n))).toBe(false)
    expect(looksLikeIconSet(own(muiIcons))).toBe(true)
  })

  // @tabler/icons-react collapses to 7 families because every name starts
  // `Icon`. Only the name ratio catches it — the two signals cover each other.
  it('catches an icon set that the family count misses', () => {
    const tabler = comps(6250, (i) => `IconGlyph${i}`)
    expect(new Set(tabler.map((n) => /^Icon[a-z0-9]*/.exec(n)?.[0])).size).toBeLessThan(250)
    expect(looksLikeIconSet(own(tabler))).toBe(true)
  })

  // Signal 3, the flat-catalog pair. react-feather is 286 names over 195
  // families, with no name containing `Icon` — under the 250 line and past
  // neither of the first two signals. Its 1.47 names per family is what
  // gives it away.
  it('catches a flat catalog below the family threshold', () => {
    const featherish = spread(195, 286, ICON_VARIANTS)
    expect(featherish).toHaveLength(286)
    expect(featherish.some((n) => /Icon/.test(n))).toBe(false)
    expect(looksLikeIconSet(own(featherish))).toBe(true)
  })

  // And the half of the pair that keeps it safe. Both of these have MORE
  // families than any design system measured (react-admin, at 127), and the
  // dense one is still judged a design system.
  it('needs both halves of the flat pair, not either one', () => {
    // 195 families, 3 parts each: dense, so not caught.
    expect(looksLikeIconSet(own(spread(195, 585, DS_PARTS)))).toBe(false)
    // 149 families, 1.4 parts each: flat, but under the family floor.
    expect(looksLikeIconSet(own(spread(149, 209, ICON_VARIANTS)))).toBe(false)
    // Both at once is what fires.
    expect(looksLikeIconSet(own(spread(150, 210, ICON_VARIANTS)))).toBe(true)
  })

  // The shape the pair exists to protect: a design system BIGGER than Chakra.
  // A plain 150-family rule would have thrown this away.
  it('keeps a compound design system larger than any measured today', () => {
    const biggerThanChakra = spread(200, 1400, DS_PARTS)
    expect(looksLikeIconSet(own(biggerThanChakra))).toBe(false)
  })

  // The property the whole rewrite rests on, and the threshold it turns on.
  // Every list here is dense (3+ names per family) so signal 3 stays out of it.
  it('counts families, not parts', () => {
    expect(looksLikeIconSet(own(spread(249, 747, DS_PARTS)))).toBe(false)

    // Three times as many names, still 249 families. Still not an icon set.
    const denser = spread(249, 2241, DS_PARTS)
    expect(denser).toHaveLength(2241)
    expect(looksLikeIconSet(own(denser))).toBe(false)

    // One more FAMILY is what tips it over, at either size.
    expect(looksLikeIconSet(own(spread(250, 750, DS_PARTS)))).toBe(true)
    expect(looksLikeIconSet(own(spread(250, 2250, DS_PARTS)))).toBe(true)
  })

  // Real spellings, so a change to how a family is read off a name shows up
  // here rather than only against an installed package.
  it('reads one family off the parts of a real compound component', () => {
    // 248 families at 3 names each, so density never enters into it.
    const base = spread(248, 744, DS_PARTS)
    // Both lists below are 747 names. Chakra's three Dialog parts are one
    // family, so that one is 249 families and stays a design system.
    expect(looksLikeIconSet(own([...base, 'DialogRoot', 'DialogTrigger', 'DialogBackdrop']))).toBe(false)
    // Three unrelated names instead, and the same 747 names are 251 families.
    expect(looksLikeIconSet(own([...base, 'Sunrise', 'Umbrella', 'Wristwatch']))).toBe(true)
  })

  // Signal 4, the brand-prefixed pair. `@remixicon/react` is 3,227 names that
  // ALL start `Ri`, so it is three families at 1,076 names each and passes
  // signals 1 to 3 untouched. What gives it away is that every one of them
  // takes `RemixiconProps`: one props type for the whole package.
  it('catches a brand-prefixed icon set by its one shared props type', () => {
    const remixicon = comps(3227, (i) => `RiGlyph${i}${i % 2 ? 'Fill' : 'Line'}`)
    expect(looksLikeIconSet(shared(remixicon))).toBe(true)
    // Not only the huge ones: 60 `Ri*` names over one props type is icons too.
    expect(looksLikeIconSet(shared(comps(60, (i) => `RiGlyph${i}`)))).toBe(true)
  })

  // The trap: "brand-prefixed" alone is NOT the signal. `@elastic/eui` names
  // everything `Eui*` (262 names, 7 families), `@coreui/react` everything
  // `C*` (137 names, ONE family), and both are design systems. Each of their
  // components takes its own props, and that is what keeps them.
  it('keeps a brand-prefixed design system, whose components take their own props', () => {
    expect(looksLikeIconSet(own(comps(137, (i) => `CWidget${i}`)))).toBe(false)
    expect(looksLikeIconSet(own(comps(262, (i) => `EuiWidget${i}`)))).toBe(false)
    // Even the same names as the icon set above are a design system when
    // each takes its own props.
    expect(looksLikeIconSet(own(comps(3227, (i) => `RiGlyph${i}`)))).toBe(false)
  })

  // `@telekom/scale-components-react` types all 442 of its `Scale*` wrappers
  // `any`. That is 442 components saying nothing about their props, not 442
  // components sharing props, so it is not judged by this signal.
  it('does not read a props type that says nothing as shared', () => {
    expect(looksLikeIconSet(shared(comps(442, (i) => `ScaleWidget${i}`), null))).toBe(false)
    // Nor can a few informative names carry the rest: 25 shared among 442.
    const mostlyLoose = [
      ...shared(comps(25, (i) => `ScaleGlyph${i}`)),
      ...shared(comps(417, (i) => `ScaleWidget${i}`), null),
    ]
    expect(looksLikeIconSet(mostlyLoose)).toBe(false)
  })

  // Both halves of the pair are needed. A shared props type over a list that
  // is NOT brand-prefixed is not enough, and a brand-prefixed list whose
  // props are only mildly shared is not enough either.
  it('needs both halves of the brand-prefixed pair', () => {
    // 120 names over 120 families, all one props type: not brand-prefixed.
    expect(looksLikeIconSet(shared(comps(120, (i) => `Glyph${i}Widget`)))).toBe(false)
    // 9 names per family, one props type: just under the brand-prefix line.
    expect(looksLikeIconSet(shared(spread(20, 180, ICON_VARIANTS)))).toBe(false)
    // 10 per family is on it.
    expect(looksLikeIconSet(shared(spread(20, 200, ICON_VARIANTS)))).toBe(true)
    // Brand-prefixed, but 19 names per props type: under the sharing line.
    const nineteenPerType = comps(190, (i) => `RiGlyph${i}`).map((name, i) => ({ name, propsType: `#${i % 10}` }))
    expect(looksLikeIconSet(nineteenPerType)).toBe(false)
    // 20 per props type is on it.
    const twentyPerType = comps(200, (i) => `RiGlyph${i}`).map((name, i) => ({ name, propsType: `#${i % 10}` }))
    expect(looksLikeIconSet(twentyPerType)).toBe(true)
  })

  // A compound design system is dense too (Chakra: 6.8 names per family), but
  // its density comes from parts, and the parts take their own props.
  it('does not mistake a dense compound design system for a brand prefix', () => {
    const dense = spread(60, 600, DS_PARTS)
    expect(dense.length / 60).toBe(10)
    expect(looksLikeIconSet(own(dense))).toBe(false)
  })
})

describe('suggestDesignSystems (React arm) excludes icon sets', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pt-suggest-icons-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('does not offer a package whose exports are icons, however often it is imported', async () => {
    await write(root, 'package.json', JSON.stringify({ dependencies: { 'fancy-icons': '1.0.0' } }))
    await write(
      root,
      'node_modules/fancy-icons/package.json',
      JSON.stringify({ name: 'fancy-icons', version: '1.0.0', types: 'index.d.ts', peerDependencies: { react: '*' } }),
    )
    const names = Array.from({ length: 30 }, (_, i) => `Glyph${i}Icon`)
    await write(
      root,
      'node_modules/fancy-icons/index.d.ts',
      [
        'interface IconProps { size?: number }',
        ...names.map((n) => `declare const ${n}: (props: IconProps) => null;`),
        `export { ${names.join(', ')} };`,
      ].join('\n'),
    )
    for (let i = 0; i < 5; i++) await write(root, `src/P${i}.tsx`, `import { Glyph1Icon } from 'fancy-icons'`)

    expect(await suggestDesignSystems(root)).toEqual([])
  })

  /**
   * The reported defect, end to end: Chakra v3 exports 775 symbols that type
   * as React components, so the old export-count guard classified it as icons
   * and `suggestDesignSystems` returned nothing. A compound library has to
   * come back out of discovery with its real component count.
   */
  it('offers a compound design system with hundreds of exported parts', async () => {
    const names = spread(114, 775, DS_PARTS)
    await write(root, 'package.json', JSON.stringify({ dependencies: { 'compound-ui': '3.0.0' } }))
    await write(
      root,
      'node_modules/compound-ui/package.json',
      JSON.stringify({ name: 'compound-ui', version: '3.0.0', types: 'index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write(
      root,
      'node_modules/compound-ui/index.d.ts',
      [
        'interface PartProps { children?: unknown }',
        ...names.map((n) => `declare const ${n}: (props: PartProps) => null;`),
        `export { ${names.join(', ')} };`,
      ].join('\n'),
    )
    await write(root, 'src/App.tsx', `import { Stem0000 } from 'compound-ui'`)

    const out = await suggestDesignSystems(root)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      package: 'compound-ui',
      framework: 'react',
      componentCount: 775,
      confidence: 'likely',
    })
  })

  /**
   * The two changes that had to land together, end to end. A package whose
   * exports are typed with React's union `ComponentType<P>` used to count
   * ZERO components (the union has no signatures of its own), which hid
   * `@remixicon/react` from discovery entirely. Once the extractor sees
   * through the union, the guard has to catch what it sees: 3,227 `Ri*`
   * names over one props type is icons, however it is declared.
   */
  it('does not offer a brand-prefixed icon set declared through `ComponentType<P>`', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `RiGlyph${i}${i % 2 ? 'Fill' : 'Line'}`)
    await write(root, 'package.json', JSON.stringify({ dependencies: { '@brand/icons': '4.0.0' } }))
    await write(
      root,
      'node_modules/@brand/icons/package.json',
      JSON.stringify({ name: '@brand/icons', version: '4.0.0', types: 'index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write(
      root,
      'node_modules/@brand/icons/index.d.ts',
      [
        'interface ReactElement { readonly $$typeof: symbol }',
        'type ComponentType<P> = { new (props: P): { props: P } } | ((props: P) => ReactElement);',
        'interface BrandIconProps { size?: number; color?: string }',
        ...names.map((n) => `declare const ${n}: ComponentType<BrandIconProps>;`),
        `export { ${names.join(', ')} };`,
      ].join('\n'),
    )
    for (let i = 0; i < 5; i++) await write(root, `src/P${i}.tsx`, `import { RiGlyph1Fill } from '@brand/icons'`)

    expect(await suggestDesignSystems(root)).toEqual([])
  })

  /**
   * And the other side of the same line: a brand-prefixed DESIGN SYSTEM,
   * declared the same way, is offered with its real count, because each of
   * its components takes its own props.
   */
  it('offers a brand-prefixed design system declared through `ComponentType<P>`', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `EuiWidget${i}`)
    await write(root, 'package.json', JSON.stringify({ dependencies: { '@brand/ui': '9.0.0' } }))
    await write(
      root,
      'node_modules/@brand/ui/package.json',
      JSON.stringify({ name: '@brand/ui', version: '9.0.0', types: 'index.d.ts', peerDependencies: { react: '*' } }),
    )
    await write(
      root,
      'node_modules/@brand/ui/index.d.ts',
      [
        'interface ReactElement { readonly $$typeof: symbol }',
        'type ComponentType<P> = { new (props: P): { props: P } } | ((props: P) => ReactElement);',
        ...names.map((n) => `interface ${n}Props { size?: number; variant${n}?: string }`),
        ...names.map((n) => `declare const ${n}: ComponentType<${n}Props>;`),
        `export { ${names.join(', ')} };`,
      ].join('\n'),
    )
    await write(root, 'src/App.tsx', `import { EuiWidget0 } from '@brand/ui'`)

    const out = await suggestDesignSystems(root)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ package: '@brand/ui', framework: 'react', componentCount: 120 })
  })
})

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content, 'utf8')
}
