/**
 * Tests for `ReactDtsMetaManifestSource` — the React TS-checker extractor.
 *
 * Hermetic fixtures (no `@types/react`, no `node_modules`): a function
 * component whose call signature returns a locally-declared `ReactElement`,
 * and a class component with an instance `props`. This exercises the
 * load-bearing behaviors — both props-recovery shapes, cross-file enum
 * resolution, the framework-prop filter, component-vs-non-component
 * discovery, and that the output flows through the SAME normalizer as the
 * Vue extractor — without an installed React library.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReactDtsMetaManifestSource } from './index'

const FIXTURE_DIR = path.join(__dirname, '__fixtures__')
const TSCONFIG = path.join(FIXTURE_DIR, 'tsconfig.json')

const source = new ReactDtsMetaManifestSource({
  id: 'fixture-react-dts',
  tsconfigPath: TSCONFIG,
  entryFiles: [
    path.join(FIXTURE_DIR, 'Button.d.ts'),
    path.join(FIXTURE_DIR, 'Card.d.ts'),
  ],
  framework: 'react',
  designSystem: 'fixture-ds',
  importPath: '@fixtures/react-widgets',
})

describe('ReactDtsMetaManifestSource', () => {
  it('extracts a function component (forwardRef-style call signature)', async () => {
    const button = await source.getComponent('Button')
    expect(button).not.toBeNull()
    expect(button!.framework).toBe('react')
    expect(button!.designSystem).toBe('fixture-ds')
    expect(button!.importPath).toBe('@fixtures/react-widgets')
  })

  it('resolves a cross-file string-literal union into a finite-choice control', async () => {
    const button = await source.getComponent('Button')
    const tone = button!.props.find((p) => p.name === 'tone')!
    expect(tone.control.kind).toBe('finite-choice')
    // 'primary' | 'danger' | ('solid' | 'ghost') — nested alias resolved.
    const options = (tone.control as { options: { value: string }[] }).options
    expect(options.map((o) => o.value).sort()).toEqual([
      'danger',
      'ghost',
      'primary',
      'solid',
    ])
  })

  it('keeps library callback props (React surfaces events as props)', async () => {
    const button = await source.getComponent('Button')
    expect(button!.props.map((p) => p.name)).toContain('onPress')
  })

  it('drops framework props (key / ref) by name', async () => {
    const button = await source.getComponent('Button')
    const names = button!.props.map((p) => p.name)
    expect(names).not.toContain('key')
    expect(names).not.toContain('ref')
  })

  it('classifies boolean / number / string controls', async () => {
    const button = await source.getComponent('Button')
    const byName = Object.fromEntries(button!.props.map((p) => [p.name, p]))
    expect(byName.disabled.control.kind).toBe('boolean')
    expect(byName.count.control.kind).toBe('number')
    expect(byName.label.control.kind).toBe('text')
  })

  it('extracts a class component via its instance props', async () => {
    const card = await source.getComponent('Card')
    expect(card).not.toBeNull()
    const variant = card!.props.find((p) => p.name === 'variant')!
    expect(variant.control.kind).toBe('finite-choice')
    const options = (variant.control as { options: { value: string }[] }).options
    expect(options.map((o) => o.value).sort()).toEqual(['elevated', 'outlined'])
  })

  it('detects components by PascalCase + object props, not return type', async () => {
    const all = (await source.listComponents()).map((m) => m.name).sort()
    // Button, Card, Spacer are components; Spacer returns `null` yet is kept.
    expect(all).toEqual(['Button', 'Card', 'Spacer'])
  })

  it('skips non-components: primitive-arg callables, hooks, values, types', async () => {
    // PascalCase but first arg is a number, not props → not a component.
    expect(await source.getComponent('RenderValue')).toBeNull()
    // camelCase hook → not a component name.
    expect(await source.getComponent('useToggle')).toBeNull()
    // plain value + type-only export.
    expect(await source.getComponent('BUTTON_VERSION')).toBeNull()
    expect(await source.getComponent('Tone')).toBeNull()
  })
})

/**
 * A prototype with NO tsconfig and NO jsconfig — a plain-JavaScript React app,
 * which is an ordinary shape rather than a broken one.
 *
 * Until 2026-08-16 `build-manifest-source.ts` skipped the whole
 * `react-dts-auto-scan` step for such a prototype, and MEASURED on a real
 * `.jsx` React + Vite + MUI app the catalog came back holding ONE component —
 * the user's own `App` — while the auto-scan found `@mui/material` perfectly
 * well (`tasks/react-hint-generation-phase0.md` § 7.7). `buildProgram` now
 * falls back to `DEFAULT_DTS_OPTIONS` instead of refusing.
 *
 * The same fixture and the same assertions as the configured source above, so
 * the two paths are held to one contract: a null config must cost nothing in
 * extraction quality, only in whose compiler options were used.
 */
const nullConfigSource = new ReactDtsMetaManifestSource({
  id: 'fixture-react-dts-no-tsconfig',
  tsconfigPath: null,
  entryFiles: [
    path.join(FIXTURE_DIR, 'Button.d.ts'),
    path.join(FIXTURE_DIR, 'Card.d.ts'),
  ],
  framework: 'react',
  designSystem: 'fixture-ds',
  importPath: '@fixtures/react-widgets',
})

describe('ReactDtsMetaManifestSource — no tsconfig', () => {
  it('still extracts components when the prototype ships no config at all', async () => {
    const button = await nullConfigSource.getComponent('Button')
    expect(button).not.toBeNull()
    expect(button!.framework).toBe('react')
    expect(button!.importPath).toBe('@fixtures/react-widgets')
  })

  it('recovers the same props as the configured source — a null config is not a downgrade', async () => {
    const withConfig = await source.getComponent('Button')
    const without = await nullConfigSource.getComponent('Button')
    expect(without!.props.map((p) => p.name).sort()).toEqual(
      withConfig!.props.map((p) => p.name).sort(),
    )
  })

  it('still resolves a cross-file union into a finite-choice control', async () => {
    const button = await nullConfigSource.getComponent('Button')
    const tone = button!.props.find((p) => p.name === 'tone')!
    expect(tone.control.kind).toBe('finite-choice')
    const options = (tone.control as { options: { value: string }[] }).options
    expect(options.map((o) => o.value).sort()).toEqual([
      'danger',
      'ghost',
      'primary',
      'solid',
    ])
  })
})
