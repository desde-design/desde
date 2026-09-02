/**
 * Tests for `StorybookManifestSource`. Mix of pure-function tests against
 * `parseStoryFile` (covers AST traversal and edge cases without I/O) and
 * integration tests against fixtures in `__fixtures__/`.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { StorybookManifestSource, parseStoryFile } from './index'

const FIXTURES = path.join(__dirname, '__fixtures__')
const BUTTON_STORY = path.join(FIXTURES, 'Button.stories.ts')
const SEPARATE_META_STORY = path.join(FIXTURES, 'SeparateMeta.stories.ts')
const NO_COMPONENT_STORY = path.join(FIXTURES, 'NoComponent.stories.ts')
const NOT_A_STORY = path.join(FIXTURES, 'NotAStory.ts')

describe('parseStoryFile', () => {
  it('returns null for a file with no default export', () => {
    const source = `export const x = 1`
    expect(parseStoryFile('foo.ts', source)).toBeNull()
  })

  it('returns null for a default export that is not an object literal', () => {
    expect(parseStoryFile('foo.ts', `export default 42`)).toBeNull()
    expect(parseStoryFile('foo.ts', `export default 'hi'`)).toBeNull()
  })

  it('extracts title from a literal `export default { ... }` meta', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default { title: 'Lib/Card' } as Meta`,
    )
    expect(parsed?.title).toBe('Lib/Card')
  })

  it('follows `export default identifier` to the variable initializer', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `const meta = { title: 'X' }; export default meta`,
    )
    expect(parsed?.title).toBe('X')
  })

  it('handles `satisfies` cast on the default export', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `const meta = { title: 'Sat' } satisfies Meta; export default meta`,
    )
    expect(parsed?.title).toBe('Sat')
  })

  it('resolves component import path from the import statement', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `
        import Btn from './Button.vue'
        const meta = { component: Btn, title: 'B' }
        export default meta
      `,
    )
    expect(parsed?.componentImportName).toBe('Btn')
    expect(parsed?.componentImportPath).toBe('./Button.vue')
  })

  it('resolves named-import component path', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `
        import { Card } from '@acme/design-system'
        export default { component: Card, title: 'C' }
      `,
    )
    expect(parsed?.componentImportName).toBe('Card')
    expect(parsed?.componentImportPath).toBe('@acme/design-system')
  })

  it('parses string-shorthand controls', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        argTypes: { x: { control: 'text' } }
      }`,
    )
    expect(parsed?.argTypes).toEqual([
      { name: 'x', control: { type: 'text' } },
    ])
  })

  it('parses object-form controls with options', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        argTypes: { x: { control: { type: 'select', options: ['a', 'b'] } } }
      }`,
    )
    expect(parsed?.argTypes[0]?.control).toEqual({
      type: 'select',
      options: ['a', 'b'],
    })
  })

  it('parses argType.options separately from control', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        argTypes: { x: { options: ['a', 'b'] } }
      }`,
    )
    expect(parsed?.argTypes[0]?.options).toEqual(['a', 'b'])
  })

  it('parses meta.args as the runtime defaults map', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        args: { label: 'Hi', count: 3, on: true, off: false, none: null },
      }`,
    )
    expect(parsed?.args).toEqual({
      label: 'Hi',
      count: 3,
      on: true,
      off: false,
      none: null,
    })
  })

  it('parses negated numeric args', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default { args: { offset: -42 } }`,
    )
    expect(parsed?.args).toEqual({ offset: -42 })
  })

  it('extracts component description from parameters.docs.description.component', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        parameters: {
          docs: {
            description: {
              component: 'A friendly card.',
            },
          },
        },
      }`,
    )
    expect(parsed?.description).toBe('A friendly card.')
  })

  it('does not crash on argTypes whose value is not an object literal', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default { argTypes: { x: someComputed() } }`,
    )
    expect(parsed?.argTypes).toEqual([])
  })

  it('handles shorthand property assignments for component (`{ component }`)', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `
        import Btn from './Btn.vue'
        const component = Btn
        export default { component, title: 'X' }
      `,
    )
    expect(parsed?.componentImportName).toBe('component')
    // Note: shorthand resolution is identifier-name-based, not value-
    // tracing — the import map is keyed by the bound name. This is a
    // deliberate simplification; real CSF authors typically write
    // `{ component: Btn }` when the import is named differently.
  })

  it('treats argType.type object form with required:true as required', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default {
        argTypes: { x: { type: { name: 'string', required: true } } }
      }`,
    )
    expect(parsed?.argTypes[0]?.required).toBe(true)
    expect(parsed?.argTypes[0]?.type).toBe('string')
  })

  it('silently skips spread elements in argTypes (cannot statically resolve)', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `
        const baseTypes = { y: { control: 'text' } }
        export default {
          argTypes: { x: { control: 'boolean' }, ...baseTypes }
        }
      `,
    )
    expect(parsed?.argTypes.map((a) => a.name)).toEqual(['x'])
  })

  it('skips computed-key argTypes', () => {
    const parsed = parseStoryFile(
      'a.ts',
      `export default { argTypes: { [dynamic]: { control: 'text' } } }`,
    )
    expect(parsed?.argTypes).toEqual([])
  })
})

describe('StorybookManifestSource (default options)', () => {
  it('produces a manifest for a fixture story file', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
      designSystem: 'acme-ds',
    })
    const manifest = await source.getComponent('Button')
    expect(manifest).not.toBeNull()
    if (!manifest) return
    expect(manifest.name).toBe('Button')
    expect(manifest.id).toBe('acme-ds.button')
    expect(manifest.framework).toBe('vue3')
    expect(manifest.designSystem).toBe('acme-ds')
    expect(manifest.importPath).toBe('./Button.vue')
    expect(manifest.description).toBe(
      'A basic button used across the design system.',
    )
  })

  it('infers finite-choice control from argType.options', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
    })
    const manifest = await source.getComponent('Button')
    const appearance = manifest?.props.find((p) => p.name === 'appearance')
    expect(appearance?.control.kind).toBe('finite-choice')
    expect(appearance?.control.options?.map((o) => o.value)).toEqual([
      'primary',
      'secondary',
      'tertiary',
      'danger',
    ])
    expect(appearance?.description).toBe('Visual style.')
  })

  it('handles control.options nested inside control object', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
    })
    const manifest = await source.getComponent('Button')
    const size = manifest?.props.find((p) => p.name === 'size')
    expect(size?.control.kind).toBe('finite-choice')
    expect(size?.control.options?.map((o) => o.value)).toEqual([
      'sm',
      'md',
      'lg',
    ])
  })

  it('maps control: "text" → kind:text', async () => {
    const source = new StorybookManifestSource({ storyFiles: [BUTTON_STORY] })
    const manifest = await source.getComponent('Button')
    const label = manifest?.props.find((p) => p.name === 'label')
    expect(label?.control.kind).toBe('text')
    expect(label?.description).toBe('The visible button text.')
  })

  it('maps control: "boolean" → kind:boolean', async () => {
    const source = new StorybookManifestSource({ storyFiles: [BUTTON_STORY] })
    const manifest = await source.getComponent('Button')
    const disabled = manifest?.props.find((p) => p.name === 'disabled')
    expect(disabled?.control.kind).toBe('boolean')
  })

  it('maps control: "number" → kind:number', async () => {
    const source = new StorybookManifestSource({ storyFiles: [BUTTON_STORY] })
    const manifest = await source.getComponent('Button')
    const count = manifest?.props.find((p) => p.name === 'count')
    expect(count?.control.kind).toBe('number')
  })

  it('maps control object form { type: "object" } → kind:object', async () => {
    const source = new StorybookManifestSource({ storyFiles: [BUTTON_STORY] })
    const manifest = await source.getComponent('Button')
    const advanced = manifest?.props.find((p) => p.name === 'advanced')
    expect(advanced?.control.kind).toBe('object')
  })

  it('populates default values from meta.args (provenance: runtime)', async () => {
    const source = new StorybookManifestSource({ storyFiles: [BUTTON_STORY] })
    const manifest = await source.getComponent('Button')
    const label = manifest?.props.find((p) => p.name === 'label')
    expect(label?.defaultValue).toEqual({
      value: 'Click me',
      source: 'runtime',
    })
    const disabled = manifest?.props.find((p) => p.name === 'disabled')
    expect(disabled?.defaultValue).toEqual({
      value: false,
      source: 'runtime',
    })
  })

  it('falls back to title last-segment when component is not declared', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [NO_COMPONENT_STORY],
    })
    const list = await source.listComponents()
    expect(list.map((m) => m.name)).toEqual(['Untitled'])
    expect(list[0]?.importPath).toBeUndefined()
  })

  it('parses the `const meta = ... satisfies` shape', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [SEPARATE_META_STORY],
    })
    const card = await source.getComponent('Card')
    expect(card).not.toBeNull()
    if (!card) return
    expect(card.name).toBe('Card')
    expect(card.importPath).toBe('@acme/design-system')
    const variant = card.props.find((p) => p.name === 'variant')
    expect(variant?.control.kind).toBe('finite-choice')
    expect(variant?.control.options?.map((o) => o.value)).toEqual([
      'plain',
      'outlined',
      'shadowed',
    ])
  })

  it('skips files without a default-export meta object', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [NOT_A_STORY, BUTTON_STORY],
    })
    const list = await source.listComponents()
    expect(list.map((m) => m.name).sort()).toEqual(['Button'])
  })

  it('returns null for unknown component names', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
    })
    expect(await source.getComponent('DoesNotExist')).toBeNull()
  })

  it('uses cached results across calls within a session', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
    })
    const first = await source.getComponent('Button')
    const second = await source.getComponent('Button')
    expect(first).toBe(second)
  })

  it('invalidate() forces a re-parse', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
    })
    const first = await source.getComponent('Button')
    source.invalidate()
    const second = await source.getComponent('Button')
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
  })

  it('honors a custom componentNameResolver', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
      componentNameResolver: (ctx) =>
        ctx.metaComponentName ? `Forced${ctx.metaComponentName}` : null,
    })
    const list = await source.listComponents()
    expect(list.map((m) => m.name)).toEqual(['ForcedButton'])
  })

  it('honors a custom importPath override', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
      importPath: '@my-corp/ui',
    })
    const m = await source.getComponent('Button')
    expect(m?.importPath).toBe('@my-corp/ui')
  })

  it('prop-level source metadata inherits the configured framework + designSystem', async () => {
    const source = new StorybookManifestSource({
      storyFiles: [BUTTON_STORY],
      framework: 'react',
      designSystem: 'mui',
    })
    const m = await source.getComponent('Button')
    expect(m?.source?.framework).toBe('react')
    expect(m?.source?.designSystem).toBe('mui')
    for (const prop of m?.props ?? []) {
      expect(prop.source?.framework).toBe('react')
      expect(prop.source?.designSystem).toBe('mui')
    }
  })

  it('non-existent file paths are silently skipped', async () => {
    const source = new StorybookManifestSource({
      storyFiles: ['/this/path/does/not/exist.stories.ts', BUTTON_STORY],
    })
    const list = await source.listComponents()
    expect(list.map((m) => m.name)).toEqual(['Button'])
  })
})
