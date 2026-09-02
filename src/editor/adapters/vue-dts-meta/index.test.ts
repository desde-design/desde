/**
 * Tests for `VueDtsMetaManifestSource` — the TS-checker extractor that
 * reads component metadata from shipped `.vue.d.ts` declarations.
 *
 * Fixtures are hermetic (no `vue`, no `node_modules`): a synthetic
 * component declaration whose construct signature yields an instance
 * with `$props`, plus a sibling file declaring the variant aliases. This
 * exercises the load-bearing behaviors — cross-file alias resolution,
 * the global/framework-prop filter, and control classification — without
 * depending on an installed design system.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VueDtsMetaManifestSource } from './index'

const FIXTURE_DIR = path.join(__dirname, '__fixtures__')
const TSCONFIG = path.join(FIXTURE_DIR, 'tsconfig.json')
const WIDGET_DTS = path.join(FIXTURE_DIR, 'Widget.vue.d.ts')
const GENERIC_WIDGET_DTS = path.join(FIXTURE_DIR, 'GenericWidget.vue.d.ts')

// One shared instance: the source caches after the first populate(), so
// the TS program builds once for the whole suite rather than per test.
const source = new VueDtsMetaManifestSource({
  id: 'fixture-vue-dts',
  tsconfigPath: TSCONFIG,
  components: [
    { componentName: 'Widget', declarationFile: WIDGET_DTS, exportName: 'default' },
    { componentName: 'GenericWidget', declarationFile: GENERIC_WIDGET_DTS, exportName: 'default' },
  ],
  framework: 'vue3',
  designSystem: 'acme-ds',
  importPath: '@fixtures/widgets',
})

function makeSource() {
  return source
}

describe('VueDtsMetaManifestSource', () => {
  it('emits a normalized manifest for a declared component', async () => {
    const manifest = await makeSource().getComponent('Widget')
    expect(manifest).not.toBeNull()
    if (!manifest) return
    expect(manifest.name).toBe('Widget')
    expect(manifest.designSystem).toBe('acme-ds')
    expect(manifest.importPath).toBe('@fixtures/widgets')
    expect(manifest.source?.extractor).toBe('fixture-vue-dts')
  })

  it('resolves a cross-file imported variant alias to finite-choice', async () => {
    // `appearance?: WidgetAppearance` where the alias lives in `./shared`
    // and itself embeds a nested alias (`WidgetMethod`). This is the case
    // the hand-rolled `.d.ts` parser cannot resolve.
    const manifest = await makeSource().getComponent('Widget')
    if (!manifest) throw new Error('Widget missing')
    const appearance = manifest.props.find((p) => p.name === 'appearance')!
    expect(appearance.control.kind).toBe('finite-choice')
    expect(appearance.control.options?.map((o) => o.value)).toEqual([
      'info',
      'success',
      'get',
      'post',
    ])
  })

  it('classifies primitive props (boolean / string)', async () => {
    const manifest = await makeSource().getComponent('Widget')
    if (!manifest) throw new Error('Widget missing')
    expect(manifest.props.find((p) => p.name === 'disabled')!.control.kind).toBe(
      'boolean',
    )
    expect(manifest.props.find((p) => p.name === 'label')!.control.kind).toBe(
      'text',
    )
  })

  it('keeps a number|string prop as a non-editable unknown control', async () => {
    const manifest = await makeSource().getComponent('Widget')
    if (!manifest) throw new Error('Widget missing')
    expect(manifest.props.find((p) => p.name === 'width')!.control.kind).toBe(
      'unknown',
    )
  })

  it('reads @default tags as documentation defaults', async () => {
    const manifest = await makeSource().getComponent('Widget')
    if (!manifest) throw new Error('Widget missing')
    const appearance = manifest.props.find((p) => p.name === 'appearance')!
    expect(appearance.defaultValue).toEqual({
      value: 'info',
      source: 'documentation',
    })
  })

  it('filters out Vue framework + emit-handler props', async () => {
    // `onClick` (on[A-Z] emit handler) and `key` (VNode prop) live on
    // `$props` but must not appear in the editable prop panel.
    const manifest = await makeSource().getComponent('Widget')
    if (!manifest) throw new Error('Widget missing')
    const names = manifest.props.map((p) => p.name).sort()
    expect(names).toEqual(['appearance', 'disabled', 'label', 'size', 'width'])
  })

  it('extracts props from the generic VLS function shape (props on __VLS_props param, not $props)', async () => {
    // Regression: generic components (Acme DS UiTableView/UiTableData)
    // export a generic call signature returning a bare node with NO
    // `$props`. Before the first-parameter fallback these were dropped
    // entirely — `getComponent` returned null and the inspector showed no
    // props. The fallback reads the `__VLS_props` parameter type instead.
    const manifest = await makeSource().getComponent('GenericWidget')
    expect(manifest).not.toBeNull()
    if (!manifest) return
    const names = manifest.props.map((p) => p.name).sort()
    // Real editable props surface; the emit handler (`onSort`) and VNode
    // prop (`key`) are filtered, same as the DefineComponent shape.
    expect(names).toEqual(['appearance', 'label', 'loading', 'rows'])
    expect(manifest.props.find((p) => p.name === 'loading')!.control.kind).toBe(
      'boolean',
    )
    expect(manifest.props.find((p) => p.name === 'label')!.control.kind).toBe(
      'text',
    )
    // Cross-file alias still resolves to a finite choice through the param.
    expect(manifest.props.find((p) => p.name === 'appearance')!.control.kind).toBe(
      'finite-choice',
    )
  })

  it('returns null for an unknown component', async () => {
    expect(await makeSource().getComponent('DoesNotExist')).toBeNull()
  })

  it('returns empty when the tsconfig is missing', async () => {
    const source = new VueDtsMetaManifestSource({
      tsconfigPath: path.join(FIXTURE_DIR, 'nonexistent-tsconfig.json'),
      components: [
        { componentName: 'Widget', declarationFile: WIDGET_DTS },
      ],
      designSystem: 'acme-ds',
      importPath: '@fixtures/widgets',
    })
    expect(await source.listComponents()).toEqual([])
    expect(await source.getComponent('Widget')).toBeNull()
  })
})
