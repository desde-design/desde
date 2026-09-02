/**
 * Integration tests for `VueComponentMetaManifestSource` against real
 * Vue SFC fixtures. The checker is heavy (builds a TS Program), so all
 * tests share one source instance per describe block; the module-level
 * checker cache amortizes the cost across describes too.
 */
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  VueComponentMetaManifestSource,
  _resetCheckerCacheForTests,
} from './index'

const FIXTURES = path.join(__dirname, '__fixtures__')
const TSCONFIG = path.join(FIXTURES, 'tsconfig.json')
const LAYOUT_ONLY = path.join(FIXTURES, 'LayoutOnly.vue')
const WITH_IMPORTED_TYPE = path.join(FIXTURES, 'WithImportedType.vue')

afterAll(() => {
  _resetCheckerCacheForTests()
})

describe('VueComponentMetaManifestSource', () => {
  const source = new VueComponentMetaManifestSource({
    tsconfigPath: TSCONFIG,
    componentFiles: [LAYOUT_ONLY, WITH_IMPORTED_TYPE],
  })

  it('extracts a manifest from a component with imported types and withDefaults', async () => {
    const manifest = await source.getComponent('WithImportedType')
    expect(manifest).not.toBeNull()
    if (!manifest) return

    expect(manifest.framework).toBe('vue3')
    expect(manifest.designSystem).toBe('first-party')
    expect(manifest.id).toBe('first-party.with-imported-type')
    expect(manifest.source?.extractor).toBe('vue-component-meta-live')
    expect(manifest.source?.declarations?.[0]?.file).toBe(WITH_IMPORTED_TYPE)

    const propNames = manifest.props.map((p) => p.name).sort()
    expect(propNames).toEqual(['description', 'disabled', 'org', 'variant'])
  })

  it('resolves an imported type alias to a finite-choice control', async () => {
    const manifest = await source.getComponent('WithImportedType')
    if (!manifest) throw new Error('WithImportedType manifest missing')

    const variant = manifest.props.find((p) => p.name === 'variant')
    expect(variant?.control.kind).toBe('finite-choice')
    expect(variant?.control.options?.map((o) => o.value).sort()).toEqual([
      'compact',
      'danger',
      'default',
    ])
  })

  it('reads withDefaults values as runtime defaults', async () => {
    const manifest = await source.getComponent('WithImportedType')
    if (!manifest) throw new Error('WithImportedType manifest missing')

    const variant = manifest.props.find((p) => p.name === 'variant')
    expect(variant?.defaultValue).toEqual({
      value: 'default',
      source: 'runtime',
    })

    const disabled = manifest.props.find((p) => p.name === 'disabled')
    expect(disabled?.defaultValue).toEqual({
      value: false,
      source: 'runtime',
    })
  })

  it('marks required props correctly when no default exists', async () => {
    const manifest = await source.getComponent('WithImportedType')
    if (!manifest) throw new Error('WithImportedType manifest missing')

    const org = manifest.props.find((p) => p.name === 'org')
    // `org: OrgSummary` has no default in withDefaults — required stays true.
    expect(org?.required).toBe(true)
    expect(org?.control.kind).toBe('object')
  })

  it('emits a manifest with empty props for a layout-only component', async () => {
    const manifest = await source.getComponent('LayoutOnly')
    expect(manifest).not.toBeNull()
    if (!manifest) return
    // The whole point of the live extractor is that layout-only
    // components still get a manifest (so the inspector knows them) —
    // they just have no editable props. This is the state that fixes
    // the "No manifest available" bug-vs-missing ambiguity.
    expect(manifest.props).toEqual([])
    expect(manifest.name).toBe('LayoutOnly')
  })

  it('listComponents returns every fixture component', async () => {
    const list = await source.listComponents()
    const names = list.map((m) => m.name).sort()
    expect(names).toEqual(['LayoutOnly', 'WithImportedType'])
  })

  it('returns null for an unknown component name', async () => {
    expect(await source.getComponent('DoesNotExist')).toBeNull()
  })
})

describe('VueComponentMetaManifestSource (degenerate inputs)', () => {
  it('returns an empty list when the tsconfig does not exist', async () => {
    const source = new VueComponentMetaManifestSource({
      tsconfigPath: '/nonexistent/tsconfig.json',
      componentFiles: [WITH_IMPORTED_TYPE],
    })
    expect(await source.listComponents()).toEqual([])
    expect(await source.getComponent('WithImportedType')).toBeNull()
  })
})
