/**
 * Tests for the GENERIC `.vue.d.ts` discovery walk. File-system pure (no
 * parsing) so it runs against a tiny fixture package tree.
 *
 * This used to test a hardcoded `discoverAcme DSVueDts` preset. That
 * preset is gone — `PACKAGE_OVERRIDES` + `discoverVueDtsComponents` cover
 * the same layout generically, for any package — so the cases it pinned
 * (nested `<Name>/<Name>.vue.d.ts` only, sibling helpers excluded, missing
 * declaration file skipped) are pinned here against the generic walk and
 * the `include` regex that expresses that layout.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverVueDtsComponents } from './presets'

const PKG_ROOT = path.join(__dirname, '__fixtures__/pkg')

// Tmpdir packages for the layout/collision cases — the trees are shaped
// after real installs (PrimeVue, @nuxt/ui) and would be noise as checked-in
// fixtures.
const tmpDirs: string[] = []

async function mkPackage(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-dts-presets-'))
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  )
})

/**
 * The "one directory per component, declaration named after the directory"
 * layout — the most common shape a component library ships. Expressed as an
 * `include` regex, exactly how a `PACKAGE_OVERRIDES` entry would.
 */
const NESTED_PER_COMPONENT = {
  dtsRoots: ['dist/types/components'],
  include: /^([^/\\]+)[/\\]\1\.vue\.d\.ts$/,
}

describe('discoverVueDtsComponents — nested-per-component layout', () => {
  it('finds components that ship a matching .vue.d.ts', () => {
    const found = discoverVueDtsComponents(PKG_ROOT, NESTED_PER_COMPONENT)
    const names = found.map((c) => c.componentName).sort()
    // `UiAlphaItem` (basename doesn't match its directory) and `UiGamma`
    // (ships only an `index.d.ts`) are skipped. `Helpers` IS included: by
    // this layout it is a component, and the walk has no vendor naming
    // convention to reject it with. The deleted Acme DS preset also
    // required a `K` prefix — that constraint was the vendor-specific part,
    // and a package that needs it can express it in its own `include`.
    expect(names).toEqual(['Helpers', 'UiAlpha', 'UiBeta'])
  })

  it('returns the default-export triple with an absolute declaration path', () => {
    const alpha = discoverVueDtsComponents(PKG_ROOT, NESTED_PER_COMPONENT).find(
      (c) => c.componentName === 'UiAlpha',
    )!
    expect(alpha.exportName).toBe('default')
    expect(alpha.declarationFile).toBe(
      path.join(PKG_ROOT, 'dist/types/components/UiAlpha/UiAlpha.vue.d.ts'),
    )
  })

  it('returns empty for a package without the components dir', () => {
    expect(
      discoverVueDtsComponents('/nonexistent/pkg/root', NESTED_PER_COMPONENT),
    ).toEqual([])
  })

  it('without an include filter, picks up every .vue.d.ts under the root', () => {
    const names = discoverVueDtsComponents(PKG_ROOT, {
      dtsRoots: ['dist/types/components'],
    })
      .map((c) => c.componentName)
      .sort()
    // The un-filtered walk is the default auto-scan behavior: it also finds
    // the sibling helper declarations the include regex above excludes.
    expect(names).toEqual(['Helpers', 'UiAlpha', 'UiAlphaItem', 'UiBeta'])
  })
})

/**
 * The per-component-barrel layout: `<name>/index.d.ts` beside the shipped
 * `<Name>.vue`. Shaped after PrimeVue 4.5.4, which ships 122 components
 * this way and zero `*.vue.d.ts` — before this layout was recognised the
 * package produced no manifests at all.
 */
describe('discoverVueDtsComponents — index.d.ts beside a sibling SFC', () => {
  const PRIMEVUE_SHAPED = {
    // Public component + the internal base SFC colocated with it.
    'button/index.d.ts': 'export default {} as unknown\n',
    'button/Button.vue': '<template><button /></template>\n',
    'button/BaseButton.vue': '<template><button /></template>\n',
    // Many colocated SFCs; only the directory says which one is declared.
    'datatable/index.d.ts': 'export default {} as unknown\n',
    'datatable/DataTable.vue': '<template><table /></template>\n',
    'datatable/BodyCell.vue': '<template><td /></template>\n',
    'datatable/HeaderCell.vue': '<template><th /></template>\n',
    // Directory-name *extension* rather than an exact match.
    'angledown/index.d.ts': 'export default {} as unknown\n',
    'angledown/AngleDownIcon.vue': '<template><svg /></template>\n',
    // No sibling SFC — a plugin/composable/style entry, not a component.
    'config/index.d.ts': 'export default {} as unknown\n',
    'button/style/index.d.ts': 'export default {} as unknown\n',
    // Sibling SFC unrelated to the directory: colocation, not a declaration.
    'pages/index.d.ts': 'export default {} as unknown\n',
    'pages/app.vue': '<template><div /></template>\n',
  }

  it('names the component from the SFC, not the lowercased directory', async () => {
    const root = await mkPackage(PRIMEVUE_SHAPED)
    const names = discoverVueDtsComponents(root, { dtsRoots: ['.'] })
      .map((c) => c.componentName)
      .sort()
    // `Button` not `button`, `DataTable` not `datatable` — the runtime
    // component name is unrecoverable from the directory alone, which is
    // why the sibling SFC is the name source and not just the filter.
    expect(names).toEqual(['AngleDownIcon', 'Button', 'DataTable'])
  })

  it('points at the index.d.ts and its default export', async () => {
    const root = await mkPackage(PRIMEVUE_SHAPED)
    const button = discoverVueDtsComponents(root, { dtsRoots: ['.'] }).find(
      (c) => c.componentName === 'Button',
    )!
    expect(button.declarationFile).toBe(path.join(root, 'button/index.d.ts'))
    expect(button.exportName).toBe('default')
  })

  it('ignores a nested node_modules', async () => {
    const root = await mkPackage({
      ...PRIMEVUE_SHAPED,
      'node_modules/other-lib/widget/index.d.ts': 'export default {} as unknown\n',
      'node_modules/other-lib/widget/Widget.vue': '<template><i /></template>\n',
    })
    const names = discoverVueDtsComponents(root, { dtsRoots: ['.'] }).map(
      (c) => c.componentName,
    )
    expect(names).not.toContain('Widget')
  })
})

/**
 * Basename collisions. Shaped after `@nuxt/ui` 4.10, where 13 names collide
 * across 29 declaration files and last-writer-wins was silently discarding
 * 16 of 187 components — including the real `Badge`, shadowed by the MDC
 * `prose/` variant.
 */
describe('discoverVueDtsComponents — colliding basenames', () => {
  const NUXT_UI_SHAPED = {
    'runtime/components/Badge.vue.d.ts': '',
    'runtime/components/prose/Badge.vue.d.ts': '',
    'runtime/components/Icon.vue.d.ts': '',
    'runtime/components/prose/Icon.vue.d.ts': '',
    'runtime/vue/components/Icon.vue.d.ts': '',
    'runtime/components/color-mode/ColorModeSelect.vue.d.ts': '',
    'runtime/vue/components/color-mode/ColorModeSelect.vue.d.ts': '',
    'runtime/components/Link.vue.d.ts': '',
    'runtime/vue/overrides/inertia/Link.vue.d.ts': '',
    'runtime/vue/overrides/vue-router/Link.vue.d.ts': '',
    'runtime/components/Alert.vue.d.ts': '',
  }

  async function discoverNuxtShaped(): Promise<Map<string, string>> {
    const root = await mkPackage(NUXT_UI_SHAPED)
    const found = discoverVueDtsComponents(root, { dtsRoots: ['.'] })
    return new Map(
      found.map((c) => [
        c.componentName,
        path.relative(root, c.declarationFile).split(path.sep).join('/'),
      ]),
    )
  }

  it('keeps every declaration — none is silently overwritten', async () => {
    const byName = await discoverNuxtShaped()
    expect(byName.size).toBe(Object.keys(NUXT_UI_SHAPED).length)
  })

  it('gives the bare name to the shallowest path', async () => {
    const byName = await discoverNuxtShaped()
    expect(byName.get('Badge')).toBe('runtime/components/Badge.vue.d.ts')
    expect(byName.get('Icon')).toBe('runtime/components/Icon.vue.d.ts')
    expect(byName.get('Link')).toBe('runtime/components/Link.vue.d.ts')
  })

  it('qualifies the rest by their nearest distinguishing directory', async () => {
    const byName = await discoverNuxtShaped()
    // These are the names those components actually carry at runtime —
    // `@nuxt/ui` registers `runtime/components/prose` with prefix "Prose".
    expect(byName.get('ProseBadge')).toBe('runtime/components/prose/Badge.vue.d.ts')
    expect(byName.get('ProseIcon')).toBe('runtime/components/prose/Icon.vue.d.ts')
    // `components` namespaces nothing, so the qualifier walks out to `vue`.
    expect(byName.get('VueIcon')).toBe('runtime/vue/components/Icon.vue.d.ts')
    expect(byName.get('InertiaLink')).toBe(
      'runtime/vue/overrides/inertia/Link.vue.d.ts',
    )
    expect(byName.get('VueRouterLink')).toBe(
      'runtime/vue/overrides/vue-router/Link.vue.d.ts',
    )
  })

  it('does not stutter a qualifier the name already spells', async () => {
    const byName = await discoverNuxtShaped()
    expect(byName.get('ColorModeSelect')).toBe(
      'runtime/components/color-mode/ColorModeSelect.vue.d.ts',
    )
    // Not `ColorModeColorModeSelect`.
    expect(byName.get('VueColorModeSelect')).toBe(
      'runtime/vue/components/color-mode/ColorModeSelect.vue.d.ts',
    )
  })

  it('leaves an uncontested name alone', async () => {
    const byName = await discoverNuxtShaped()
    expect(byName.get('Alert')).toBe('runtime/components/Alert.vue.d.ts')
  })

  it('falls back to an ordinal when every segment is a generic container', async () => {
    const root = await mkPackage({
      'lib/Widget.vue.d.ts': '',
      'types/Widget.vue.d.ts': '',
    })
    const names = discoverVueDtsComponents(root, { dtsRoots: ['.'] })
      .map((c) => c.componentName)
      .sort()
    // Nothing in either path names anything, but neither declaration is
    // dropped — an ordinal beats a silent loss.
    expect(names).toEqual(['Widget', 'Widget2'])
  })
})
