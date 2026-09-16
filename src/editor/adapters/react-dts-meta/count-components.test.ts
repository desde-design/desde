/**
 * The suggester's React component count must agree with the extractor: the
 * fixtures here are the extractor's own, and the expected numbers are the
 * components `ReactDtsMetaManifestSource` lists for them (Button + Spacer
 * accepted, RenderValue / useToggle / BUTTON_VERSION rejected; Card accepted
 * through the class-component path).
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listReactComponents } from './count-components'

const FIXTURE_DIR = path.join(__dirname, '__fixtures__')
const TSCONFIG = path.join(FIXTURE_DIR, 'tsconfig.json')
const BUTTON = path.join(FIXTURE_DIR, 'Button.d.ts')
const CARD = path.join(FIXTURE_DIR, 'Card.d.ts')

describe('listReactComponents', () => {
  it('counts function AND class components, rejecting helpers, hooks and values', () => {
    const names = listReactComponents(
      TSCONFIG,
      new Map([
        ['@fixtures/widgets', [BUTTON]],
        ['@fixtures/cards', [CARD]],
      ]),
    )
    expect(names.get('@fixtures/widgets')!.map((c) => c.name)).toEqual(['Button', 'Spacer'])
    expect(names.get('@fixtures/cards')!.map((c) => c.name)).toEqual(['Card'])
  })

  it('builds one program for every candidate, and a package with two entries is not double-counted', () => {
    const names = listReactComponents(TSCONFIG, new Map([['@fixtures/all', [BUTTON, CARD, BUTTON]]]))
    expect(names.get('@fixtures/all')!.map((c) => c.name)).toEqual(['Button', 'Spacer', 'Card'])
  })

  it('keeps a key whose entry does not exist, empty', () => {
    const names = listReactComponents(
      TSCONFIG,
      new Map([
        ['@fixtures/widgets', [BUTTON]],
        ['@fixtures/missing', [path.join(FIXTURE_DIR, 'Nope.d.ts')]],
      ]),
    )
    expect(names.get('@fixtures/missing')).toEqual([])
    expect(names.get('@fixtures/widgets')).toHaveLength(2)
  })

  it('a null tsconfig is a plain-JavaScript prototype, not a failure', () => {
    const names = listReactComponents(null, new Map([['@fixtures/widgets', [BUTTON]]]))
    expect(names.get('@fixtures/widgets')).toHaveLength(2)
  })

  it('answers every key even when there is nothing to build', () => {
    expect(listReactComponents(TSCONFIG, new Map([['@fixtures/none', []]])).get('@fixtures/none')).toEqual([])
  })
})

// The suggester's count and the extractor share one predicate, so a shape
// the extractor learns to see must count here too. `Chip.d.ts` declares its
// components as class-or-function unions, React's `ComponentType<P>` shape.
describe('listReactComponents — union-typed components', () => {
  it('counts components declared as `ComponentClass | FunctionComponent` unions', () => {
    const names = listReactComponents(
      TSCONFIG,
      new Map([['@fixtures/unions', [path.join(FIXTURE_DIR, 'Chip.d.ts')]]]),
    )
    expect(names.get('@fixtures/unions')!.map((c) => c.name)).toEqual(['Chip', 'Tag', 'Badge'])
  })
})

/**
 * The props-type key the icon guard reads. An icon set declares every
 * component over ONE props type; a design system declares one per
 * component. The key has to say which, at no member-resolution cost.
 */
describe('listReactComponents — props-type keys', () => {
  const listed = listReactComponents(
    TSCONFIG,
    new Map([['@fixtures/keys', [path.join(FIXTURE_DIR, 'Keys.d.ts')]]]),
  ).get('@fixtures/keys')!
  const key = (name: string) => listed.find((c) => c.name === name)!.propsType

  it('lists every component in the fixture', () => {
    expect(listed.map((c) => c.name)).toEqual([
      'RiAlarmFill', 'RiAlarmLine', 'RiAlignLeft', 'HeroOne', 'HeroTwo',
      'Button', 'Card', 'LooseOne', 'LooseTwo', 'EmptyOne', 'EmptyTwo',
      'ReadonlyOne', 'MutableOne', 'CallOne', 'CallTwo',
    ])
  })

  // Codex, delta review 1: a literal key that drops modifiers and signatures
  // would merge these, and twenty such collisions in a brand-prefixed
  // package would read as one shared props type.
  it('keeps a literal distinct when only a modifier or a signature differs', () => {
    expect(key('ReadonlyOne')).not.toBeNull()
    expect(key('ReadonlyOne')).not.toBe(key('MutableOne'))
    expect(key('CallOne')).not.toBeNull()
    expect(key('CallOne')).not.toBe(key('CallTwo'))
  })

  it('gives components that share a props interface the same key', () => {
    expect(key('RiAlarmFill')).not.toBeNull()
    expect(key('RiAlarmLine')).toBe(key('RiAlarmFill'))
    expect(key('RiAlignLeft')).toBe(key('RiAlarmFill'))
  })

  it('gives components with their own props interfaces different keys', () => {
    expect(key('Button')).not.toBeNull()
    expect(key('Card')).not.toBeNull()
    expect(key('Button')).not.toBe(key('Card'))
    expect(key('Button')).not.toBe(key('RiAlarmFill'))
  })

  it('keys a hand-written type literal by its text, so identical literals in different declarations share', () => {
    expect(key('HeroOne')).not.toBeNull()
    expect(key('HeroTwo')).toBe(key('HeroOne'))
  })

  it('gives no key to props that say nothing (`any`, `{}`)', () => {
    expect(key('LooseOne')).toBeNull()
    expect(key('LooseTwo')).toBeNull()
    expect(key('EmptyOne')).toBeNull()
    expect(key('EmptyTwo')).toBeNull()
  })
})

/**
 * The same type-literal TEXT in two files. Codex (whole-branch review,
 * 2026-09-15): keying a hand-written literal by its source text merges
 * `{ value: Value }` across files where `Value` is a different local alias in
 * each, which would push a brand-prefixed design system of that shape toward
 * "icons". The key is built from the literal's members instead, so the
 * heroicons shape still shares and the bound-alias shape does not.
 */
describe('listReactComponents — type literals across files', () => {
  const listed = listReactComponents(
    TSCONFIG,
    new Map([['@fixtures/literals', [path.join(FIXTURE_DIR, 'LiteralA.d.ts'), path.join(FIXTURE_DIR, 'LiteralB.d.ts')]]]),
  ).get('@fixtures/literals')!
  const key = (name: string) => listed.find((c) => c.name === name)!.propsType

  it('shares a key for identical literals that mean the same thing', () => {
    expect(key('HeroA')).not.toBeNull()
    expect(key('HeroB')).toBe(key('HeroA'))
  })

  it('does not share a key for identical text bound to different local aliases', () => {
    expect(key('BoundA')).not.toBeNull()
    expect(key('BoundB')).not.toBeNull()
    expect(key('BoundB')).not.toBe(key('BoundA'))
  })
})
