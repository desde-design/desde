import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildComponentFileIndex, inferRenderingHintsFromSource } from './infer-from-source'
import type { ComponentManifest, ComponentPropManifest } from '../core/manifest'

function prop(over: Partial<ComponentPropManifest> = {}): ComponentPropManifest {
  return {
    name: 'label',
    type: 'string',
    required: false,
    control: { kind: 'text' },
    ...over,
  }
}

function manifest(over: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: 'acme:Widget',
    name: 'Widget',
    framework: 'vue3',
    designSystem: '@acme/ui',
    importPath: '@acme/ui',
    props: [prop()],
    ...over,
  }
}

describe('buildComponentFileIndex + inferRenderingHintsFromSource', () => {
  let dir: string
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'infer-from-source-'))
    return dir
  }
  const teardown = () => rmSync(dir, { recursive: true, force: true })

  it('finds a nested .vue file and infers a dom hint for a sole-text prop, stamped inferred/unverified', async () => {
    setup()
    try {
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(
        join(dir, 'src/components/Widget.vue'),
        [
          '<template>',
          '  <h2 class="title">{{ label }}</h2>',
          '</template>',
          '<script setup lang="ts">',
          "defineProps<{ label: string }>()",
          '</script>',
        ].join('\n'),
      )

      const index = buildComponentFileIndex(dir)
      expect(index.get('Widget')).toEqual([join(dir, 'src/components/Widget.vue')])

      const outcome = await inferRenderingHintsFromSource(
        manifest({ name: 'Widget', props: [prop({ name: 'label' })] }),
        index,
      )
      expect(outcome.ok).toBe(true)
      // The `<h2>` is the template's single root element, so the inferrer
      // assigns it `:root` (not `h2.title`) — that's the mount root the
      // bridge's `selectorWithinMountRoot` would also resolve to.
      expect(outcome.hints).toEqual([
        {
          kind: 'dom',
          source: { kind: 'prop', name: 'label' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
          provenance: 'inferred',
          verified: false,
        },
      ])
    } finally {
      teardown()
    }
  })

  it('infers a dom hint from a .tsx component using the JSX inferrer', async () => {
    setup()
    try {
      writeFileSync(
        join(dir, 'Card.tsx'),
        [
          "export function Card({ title }: { title: string }) {",
          '  return <h2 className="title">{title}</h2>',
          '}',
        ].join('\n'),
      )

      const index = buildComponentFileIndex(dir)
      const outcome = await inferRenderingHintsFromSource(
        manifest({ name: 'Card', framework: 'react', props: [prop({ name: 'title' })] }),
        index,
      )
      expect(outcome.ok).toBe(true)
      // The single JSX element is the component's outermost (render root),
      // so it gets `:root` — same rule as the Vue case above.
      expect(outcome.hints).toEqual([
        {
          kind: 'dom',
          source: { kind: 'prop', name: 'title' },
          domTarget: { selector: ':root', field: 'textContent' },
          editability: 'literal',
          provenance: 'inferred',
          verified: false,
        },
      ])
    } finally {
      teardown()
    }
  })

  it('uses ONLY the manifest-supplied propNames, not the source file\'s own declared props', async () => {
    setup()
    try {
      writeFileSync(
        join(dir, 'Widget.vue'),
        [
          '<template>',
          '  <h2 class="title">{{ label }}</h2>',
          '  <p class="sub">{{ subtitle }}</p>',
          '</template>',
          '<script setup lang="ts">',
          "defineProps<{ label: string; subtitle: string }>()",
          '</script>',
        ].join('\n'),
      )
      const index = buildComponentFileIndex(dir)
      // Manifest declares only `label` — `subtitle` must NOT be inferred even
      // though the template renders it too and the SFC's own script declares it.
      const outcome = await inferRenderingHintsFromSource(
        manifest({ name: 'Widget', props: [prop({ name: 'label' })] }),
        index,
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.hints).toHaveLength(1)
      expect(outcome.hints[0].source).toEqual({ kind: 'prop', name: 'label' })
    } finally {
      teardown()
    }
  })

  it('reports "no source file" when no basename matches the component name', async () => {
    setup()
    try {
      writeFileSync(join(dir, 'Other.vue'), '<template><div /></template>')
      const index = buildComponentFileIndex(dir)
      const outcome = await inferRenderingHintsFromSource(manifest({ name: 'Widget' }), index)
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toMatch(/no source file/)
      expect(outcome.hints).toEqual([])
    } finally {
      teardown()
    }
  })

  it('refuses as ambiguous when two files share the same basename (different extensions, different dirs)', async () => {
    setup()
    try {
      mkdirSync(join(dir, 'vue-version'), { recursive: true })
      mkdirSync(join(dir, 'react-version'), { recursive: true })
      writeFileSync(join(dir, 'vue-version/Widget.vue'), '<template><div>{{ label }}</div></template>')
      writeFileSync(
        join(dir, 'react-version/Widget.tsx'),
        'export function Widget({ label }: { label: string }) { return <div>{label}</div> }',
      )
      const index = buildComponentFileIndex(dir)
      expect(index.get('Widget')).toHaveLength(2)

      const outcome = await inferRenderingHintsFromSource(manifest({ name: 'Widget' }), index)
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toMatch(/ambiguous/)
      expect(outcome.hints).toEqual([])
    } finally {
      teardown()
    }
  })

  it('skips node_modules (and other SKIP_DIRS) during the walk, so a decoy same-name file inside is never picked up', async () => {
    setup()
    try {
      mkdirSync(join(dir, 'node_modules/some-dep'), { recursive: true })
      writeFileSync(
        join(dir, 'node_modules/some-dep/Widget.vue'),
        '<template><div>{{ decoy }}</div></template>',
      )
      writeFileSync(
        join(dir, 'Widget.vue'),
        '<template><h2 class="title">{{ label }}</h2></template>',
      )
      const index = buildComponentFileIndex(dir)
      // Only the real, top-level file is indexed — the node_modules decoy is skipped
      // entirely, so there's no ambiguity.
      expect(index.get('Widget')).toEqual([join(dir, 'Widget.vue')])

      const outcome = await inferRenderingHintsFromSource(
        manifest({ name: 'Widget', props: [prop({ name: 'label' })] }),
        index,
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.hints).toHaveLength(1)
    } finally {
      teardown()
    }
  })

  it('does not descend past the depth bound', async () => {
    setup()
    try {
      // 9 levels of single-child nesting — beyond the depth-6 walk bound.
      let deep = dir
      for (let i = 0; i < 9; i++) {
        deep = join(deep, `d${i}`)
      }
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'TooDeep.vue'), '<template><div /></template>')

      // A shallower component (3 levels) IS found.
      mkdirSync(join(dir, 'a/b/c'), { recursive: true })
      writeFileSync(join(dir, 'a/b/c/Shallow.vue'), '<template><div /></template>')

      const index = buildComponentFileIndex(dir)
      expect(index.has('TooDeep')).toBe(false)
      expect(index.has('Shallow')).toBe(true)
    } finally {
      teardown()
    }
  })

  it('returns ok:true with empty hints when the matched file parses but infers nothing', async () => {
    setup()
    try {
      writeFileSync(join(dir, 'Empty.vue'), '<template><div class="static">Nothing here</div></template>')
      const index = buildComponentFileIndex(dir)
      const outcome = await inferRenderingHintsFromSource(
        manifest({ name: 'Empty', props: [prop({ name: 'label' })] }),
        index,
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.hints).toEqual([])
    } finally {
      teardown()
    }
  })
})
