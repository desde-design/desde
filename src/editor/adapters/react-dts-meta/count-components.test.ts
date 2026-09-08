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
    expect(names.get('@fixtures/widgets')).toEqual(['Button', 'Spacer'])
    expect(names.get('@fixtures/cards')).toEqual(['Card'])
  })

  it('builds one program for every candidate, and a package with two entries is not double-counted', () => {
    const names = listReactComponents(TSCONFIG, new Map([['@fixtures/all', [BUTTON, CARD, BUTTON]]]))
    expect(names.get('@fixtures/all')).toEqual(['Button', 'Spacer', 'Card'])
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
