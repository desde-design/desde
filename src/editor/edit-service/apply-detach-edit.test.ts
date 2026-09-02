/**
 * Tests for the pure detach applicator. Inputs are two SFC sources (consumer
 * and component) plus the call-site location; output is the rewritten
 * consumer source with the component template inlined.
 *
 * Coverage focuses on the V1 happy paths (simple props + default slot +
 * named slot + style merge) and the documented refusal cases (script-setup
 * reactive state, lifecycle, multi-root, scoped slot props).
 */

import { describe, expect, it } from 'vitest'
import { applyDetachEdit } from './apply-detach-edit'

describe('applyDetachEdit — happy path', () => {
  it('inlines a leaf component with a static prop substitution', () => {
    const consumer = `<template>
  <div>
    <ProtoButton variant="primary">Save</ProtoButton>
  </div>
</template>
`
    // Bare prop reference only — V1 detach refuses non-trivial expressions
    // like `:class="'btn btn--' + variant"`. The applicator's refusal
    // envelope is intentionally narrow (Codex flagged the regex-substitution
    // approach as unsafe for compound expressions).
    const component = `<template>
  <button :variant="variant">
    <slot />
  </button>
</template>

<script setup>
defineProps(['variant'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/components/ProtoButton.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).not.toContain('<ProtoButton')
    expect(result.source).toContain('<button')
    expect(result.source).toContain('Save')
    // The bare `:variant="variant"` v-bind got rewritten to the literal.
    expect(result.source).toContain('variant="primary"')
  })

  it('refuses components that reference props in non-trivial expressions', () => {
    const consumer = `<template>
  <div>
    <ProtoButton variant="primary">Save</ProtoButton>
  </div>
</template>
`
    const component = `<template>
  <button :class="'btn btn--' + variant"><slot /></button>
</template>

<script setup>
defineProps(['variant'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/non-trivial expression/i)
    }
  })

  it('refuses when the call-site element tag does not match componentName', () => {
    // Call site is `<NotProtoButton>` but we request a detach of `ProtoButton`.
    const consumer = `<template>
  <div>
    <NotProtoButton variant="primary">Save</NotProtoButton>
  </div>
</template>
`
    const component = `<template>
  <button><slot /></button>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoButton.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not <ProtoButton>/i)
    }
  })

  it('refuses components whose <slot> has fallback content', () => {
    const consumer = `<template>
  <div>
    <ProtoCard>Body</ProtoCard>
  </div>
</template>
`
    const component = `<template>
  <section>
    <slot><p>fallback paragraph</p></slot>
  </section>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoCard.vue',
      componentName: 'ProtoCard',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/fallback content/i)
    }
  })

  it('refuses components with relative sub-component imports', () => {
    const consumer = `<template>
  <div>
    <ProtoCard>x</ProtoCard>
  </div>
</template>
`
    const component = `<template>
  <section><KIcon name="x" /><slot /></section>
</template>

<script setup>
import KIcon from './KIcon.vue'
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoCard.vue',
      componentName: 'ProtoCard',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/relative path/i)
    }
  })

  it('preserves <template v-if> as default-slot content (does NOT unwrap it)', () => {
    const consumer = `<template>
  <div>
    <ProtoCard>
      <template v-if="show">conditional body</template>
    </ProtoCard>
  </div>
</template>
`
    const component = `<template>
  <section><slot /></section>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoCard.vue',
      componentName: 'ProtoCard',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The <template v-if=...> wrapper must be preserved verbatim — naive
    // unwrapping (the original Phase 3 bug) would lose the v-if directive
    // and silently change behavior.
    expect(result.source).toContain('<template v-if="show">')
    expect(result.source).toContain('conditional body')
  })

  it('preserves a dynamic v-bind prop as v-bind in the inlined output', () => {
    const consumer = `<template>
  <div>
    <ProtoButton :variant="kind">Click</ProtoButton>
  </div>
</template>

<script setup>
const kind = 'danger'
</script>
`
    const component = `<template>
  <button :variant="variant"><slot /></button>
</template>

<script setup>
defineProps(['variant'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoButton.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The dynamic binding from the call site should be preserved.
    expect(result.source).toContain(':variant="kind"')
  })

  it('inlines a named-slot consumer template', () => {
    const consumer = `<template>
  <div>
    <ProtoCard>
      <template #header>Title</template>
      <template #default>Body content</template>
    </ProtoCard>
  </div>
</template>
`
    const component = `<template>
  <section class="card">
    <header><slot name="header" /></header>
    <div class="body"><slot /></div>
  </section>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoCard.vue',
      componentName: 'ProtoCard',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('<section class="card">')
    expect(result.source).toContain('Title')
    expect(result.source).toContain('Body content')
    expect(result.source).not.toContain('<slot')
  })

  it('appends component <style scoped> rules to the consumer', () => {
    const consumer = `<template>
  <div>
    <ProtoButton>Hi</ProtoButton>
  </div>
</template>

<style scoped>
.existing { color: red; }
</style>
`
    const component = `<template>
  <button class="proto-btn"><slot /></button>
</template>

<style scoped>
.proto-btn { padding: 8px; }
</style>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoButton.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('.existing')
    expect(result.source).toContain('.proto-btn')
    expect(result.source).toContain('Inlined from')
  })
})

describe('applyDetachEdit — refusals', () => {
  it('refuses a component with reactive state in <script setup>', () => {
    // Still refused, but by the scope guard rather than by a
    // `/\b(ref|computed|…)\s*\(/` match on the component's script: what makes
    // this unsafe is that the template READS `count`, not that `count` was
    // built with `ref()`. The reason now names the identifier.
    //
    // The call-site column also had to be corrected from 17 to 16 (`<X />`
    // starts at column 16). The old value was never right — the factory-call
    // refusal fired before the call-site lookup ran, so a bogus coordinate
    // could not fail the test.
    const component = `<template>
  <button>{{ count }}</button>
</template>

<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 16,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('count')
      expect(result.reason).toMatch(/will not resolve in the consumer's scope/i)
    }
  })

  it('refuses a component with lifecycle hooks', () => {
    const component = `<template>
  <button><slot /></button>
</template>

<script setup>
import { onMounted } from 'vue'
onMounted(() => console.log('hi'))
</script>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 17,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/lifecycle hooks/i)
    }
  })

  it('refuses a component with defineEmits', () => {
    const component = `<template>
  <button @click="$emit('go')"><slot /></button>
</template>

<script setup>
defineEmits(['go'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 17,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/defines emits/i)
    }
  })

  it('refuses a multi-root template', () => {
    const component = `<template>
  <div>one</div>
  <div>two</div>
</template>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 17,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/multiple template roots/i)
    }
  })

  it('refuses a component with no <template> block (pure JS render)', () => {
    const component = `<script>
import { h } from 'vue'
export default { render: () => h('div') }
</script>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 17,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/no <template>/i)
    }
  })

  it('refuses when the call-site element does not exist at the location', () => {
    const consumer = `<template><div><X /></div></template>`
    const component = `<template><span><slot /></span></template>`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 99,
      callSiteColumn: 99,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No call-site element/i)
    }
  })

  it('refuses scoped-slot bindings in the component template', () => {
    const component = `<template>
  <ul>
    <li v-for="item in items" :key="item.id">
      <slot :item="item" name="row" />
    </li>
  </ul>
</template>

<script setup>
defineProps(['items'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: '<template><div><X /></div></template>',
      componentSource: component,
      componentFile: '/repo/X.vue',
      componentName: 'X',
      callSiteLine: 1,
      callSiteColumn: 17,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/scoped-slot/i)
    }
  })
})

/**
 * The scope guard. Detach moves a component's template into a DIFFERENT
 * component instance, so every identifier the template reads has to resolve
 * against the consumer's scope afterwards. Before this suite existed the
 * guard pattern-matched reactivity FACTORY CALLS (`ref(`, `computed(`, …),
 * which meant the single most common shape in real Vue apps —
 * `const { a, b } = useThing()` — matched nothing and sailed straight
 * through, producing a template that renders against undefined bindings
 * while the applicator reported ok:true.
 *
 * Both repro cases below are reduced from real third-party apps where that
 * happened (primefaces/sakai-vue and nuxt-ui-templates/dashboard).
 */
describe('applyDetachEdit — unresolved identifiers after inlining', () => {
  it('REPRO A: refuses a destructured composable return (sakai-vue FloatingConfigurator)', () => {
    const consumer = `<script setup>
import FloatingConfigurator from '@/components/FloatingConfigurator.vue';
import { ref } from 'vue';

const email = ref('');
</script>

<template>
    <FloatingConfigurator />
    <div class="login">{{ email }}</div>
</template>
`
    const component = `<script setup>
import AppConfigurator from '@/layout/AppConfigurator.vue';
import { useLayout } from '@/layout/composables/layout';

const { toggleDarkMode, isDarkTheme } = useLayout();
</script>

<template>
    <div class="fixed flex gap-4 top-8 right-8">
        <Button type="button" @click="toggleDarkMode" rounded :icon="isDarkTheme ? 'pi pi-moon' : 'pi pi-sun'" severity="secondary" />
        <AppConfigurator />
    </div>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/src/components/FloatingConfigurator.vue',
      componentName: 'FloatingConfigurator',
      callSiteLine: 9,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The reason must NAME the identifiers, so the user (and the LLM lane)
    // knows exactly what to supply.
    expect(result.reason).toContain('toggleDarkMode')
    expect(result.reason).toContain('isDarkTheme')
  })

  it('REPRO B: refuses component-internal data referenced by v-bind (nuxt dashboard HomeSales)', () => {
    const consumer = `<script setup lang="ts">
const period = ref('daily')
const range = ref(null)
</script>

<template>
  <div>
    <HomeSales :period="period" :range="range" />
  </div>
</template>
`
    const component = `<script setup lang="ts">
const props = defineProps<{ period: string; range: unknown }>()

const { data } = await useAsyncData('sales', async () => [], {
  watch: [() => props.period, () => props.range],
  default: () => []
})

const columns = []
</script>

<template>
  <UTable :data="data" :columns="columns" class="shrink-0" />
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/app/components/home/HomeSales.vue',
      componentName: 'HomeSales',
      callSiteLine: 8,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('data')
    expect(result.reason).toContain('columns')
  })

  it('refuses a plain non-reactive const — the guard is not about factory calls', () => {
    const consumer = `<template>
  <div>
    <Widget />
  </div>
</template>
`
    const component = `<template>
  <span>{{ label }}</span>
</template>

<script setup>
const label = 'hello'
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Widget.vue',
      componentName: 'Widget',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('label')
  })

  it('refuses an imported helper referenced by the template', () => {
    const consumer = `<template>
  <div>
    <Stamp />
  </div>
</template>
`
    const component = `<template>
  <time>{{ formatDate(1700000000000) }}</time>
</template>

<script setup>
import { formatDate } from '@/utils/date'
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Stamp.vue',
      componentName: 'Stamp',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('formatDate')
  })

  it('refuses an interpolated prop that the call site bound dynamically', () => {
    // `:variant="kind"` is rewritten only in v-bind position; the
    // `{{ variant }}` interpolation is left alone and would render against
    // an undefined consumer binding.
    const consumer = `<template>
  <div>
    <ProtoButton :variant="kind" />
  </div>
</template>

<script setup>
const kind = 'danger'
</script>
`
    const component = `<template>
  <button>{{ variant }}</button>
</template>

<script setup>
defineProps(['variant'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoButton.vue',
      componentName: 'ProtoButton',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('variant')
  })

  it('refuses instance-scoped $attrs / $slots', () => {
    const consumer = `<template>
  <div>
    <Passthrough />
  </div>
</template>
`
    const component = `<template>
  <div :class="$attrs.class" />
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Passthrough.vue',
      componentName: 'Passthrough',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('$attrs')
  })
})

/**
 * The other direction. A guard that refuses everything is not a fix — these
 * pin the cases that MUST keep detaching.
 */
describe('applyDetachEdit — the scope guard does not over-refuse', () => {
  it('still detaches a component whose template uses only props, literals and slots', () => {
    const consumer = `<template>
  <div>
    <ProtoBadge tone="warning">Careful</ProtoBadge>
  </div>
</template>
`
    const component = `<template>
  <span class="badge" :tone="tone"><slot /></span>
</template>

<script setup>
defineProps(['tone'])
</script>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoBadge.vue',
      componentName: 'ProtoBadge',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('tone="warning"')
    expect(result.source).toContain('Careful')
  })

  it('still detaches when the template binds identifiers the template itself declares (v-for alias)', () => {
    const consumer = `<template>
  <div>
    <Ticks />
  </div>
</template>
`
    const component = `<template>
  <ul>
    <li v-for="(n, i) in [1, 2, 3]" :key="i">{{ n }}</li>
  </ul>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Ticks.vue',
      componentName: 'Ticks',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('v-for="(n, i) in [1, 2, 3]"')
  })

  it('still detaches when the only free identifier is a consumer binding the template did not use yet', () => {
    const consumer = `<template>
  <div>
    <Greeting />
  </div>
</template>

<script setup>
const userName = 'Mo'
</script>
`
    const component = `<template>
  <p>Hello {{ userName }}</p>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Greeting.vue',
      componentName: 'Greeting',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('{{ userName }}')
  })

  it('still detaches when the template reads an app-level global property ($route)', () => {
    const consumer = `<template>
  <div>
    <Crumb />
  </div>
</template>
`
    const component = `<template>
  <nav>{{ $route.path }}</nav>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/Crumb.vue',
      componentName: 'Crumb',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('$route.path')
  })

  it('still detaches when slot content from the consumer references consumer bindings', () => {
    const consumer = `<template>
  <div>
    <ProtoCard>
      <template #header>{{ title }}</template>
      <template #default>{{ body }}</template>
    </ProtoCard>
  </div>
</template>

<script setup>
const title = 'T'
const body = 'B'
</script>
`
    const component = `<template>
  <section class="card">
    <header><slot name="header" /></header>
    <div class="body"><slot /></div>
  </section>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoCard.vue',
      componentName: 'ProtoCard',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain('{{ title }}')
    expect(result.source).toContain('{{ body }}')
  })
})

/**
 * Regression: instance-scoped names must not be excusable by the before/after
 * diff.
 *
 * The diff asks "what did inlining ADD to the consumer", which is right for
 * ordinary bindings — a name the consumer already uses demonstrably resolves
 * there. It is wrong for `$refs`, `$emit`, `$parent` and friends, which bind
 * to whichever instance the markup ends up in. When the consumer happens to
 * use the SAME name, the identifier cancels out of `after - before` and the
 * silent retarget ships anyway: the component's `$refs.child` becomes the
 * consumer's `$refs.child`, a different object.
 */
describe('applyDetachEdit — instance-scoped identifiers are never excused by the diff', () => {
  it('refuses $refs even when the consumer template already uses $refs', () => {
    const consumer = `<template>
  <div>
    <input ref="ownField" @focus="$refs.ownField.select()" />
    <ProtoPanel />
  </div>
</template>
`
    const component = `<template>
  <section @click="$refs.child.open()"><slot /></section>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoPanel.vue',
      componentName: 'ProtoPanel',
      callSiteLine: 4,
      callSiteColumn: 5,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$refs')
  })

  it('still detaches a component whose only instance name is $slots', () => {
    // Every <slot /> compiles to _renderSlot(_ctx.$slots, …), so a blanket
    // instance-scoped refusal would reject essentially every component.
    const consumer = `<template>
  <div>
    <ProtoBox>hello</ProtoBox>
  </div>
</template>
`
    const component = `<template>
  <div class="box"><slot /></div>
</template>
`
    const result = applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoBox.vue',
      componentName: 'ProtoBox',
      callSiteLine: 3,
      callSiteColumn: 5,
    })

    expect(result.ok).toBe(true)
  })
})

/**
 * `$slots` / `$props` are exempt only for the syntax the inliner resolves.
 *
 * `<slot />` and `$slots.default` both compile to `_ctx.$slots`, so the
 * identifier alone cannot separate "the outlet detach replaces" from "a live
 * read of the instance's slots". A blanket exemption therefore reopened the
 * cancellation hole for programmatic uses. The source text is the
 * discriminator: an outlet never spells the name.
 */
describe('applyDetachEdit — $slots/$props exemption is syntax-scoped', () => {
  function detach(consumer: string, component: string, line: number) {
    return applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      callSiteLine: line,
      callSiteColumn: 5,
    })
  }

  const consumerUsingBoth = `<template>
  <div>
    <p v-if="$slots.footer">has footer</p>
    <ProtoThing />
  </div>
</template>
`

  it('refuses a component that reads $slots programmatically', () => {
    const result = detach(
      consumerUsingBoth,
      `<template>
  <div><span v-if="$slots.default">x</span><slot /></div>
</template>
`,
      4,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$slots')
  })

  it('refuses a component that spreads $props', () => {
    const result = detach(
      `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`,
      `<template>
  <div v-bind="$props"><slot /></div>
</template>
`,
      3,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$props')
  })

  it('still allows a plain <slot /> outlet even when the consumer uses $slots', () => {
    const result = detach(
      consumerUsingBoth,
      `<template>
  <div class="thing"><slot /></div>
</template>
`,
      4,
    )
    expect(result.ok).toBe(true)
  })
})

/**
 * The $slots/$props exemption is decided from EXPRESSION nodes, not raw text.
 *
 * Two failure modes a raw-source regex has, in opposite directions:
 * `this.$slots.default` is emitted by Vue as a `this` access and never as
 * `_ctx.$slots`, so gating on the compiler-derived set misses it entirely;
 * and `class="has-$slots"` or a comment mentioning the name would refuse a
 * component whose only real use is a plain outlet.
 */
describe('applyDetachEdit — exemption is decided from expressions', () => {
  function detach(consumer: string, component: string, line: number) {
    return applyDetachEdit({
      consumerSource: consumer,
      componentSource: component,
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      callSiteLine: line,
      callSiteColumn: 5,
    })
  }

  const plainConsumer = `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`

  it('refuses `this.$slots` even though the compiler never emits _ctx.$slots for it', () => {
    const result = detach(
      plainConsumer,
      `<template>
  <div><span v-if="this.$slots.default">x</span><slot /></div>
</template>
`,
      3,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$slots')
  })

  it('does NOT refuse a static class or comment that merely contains the name', () => {
    const result = detach(
      plainConsumer,
      `<template>
  <!-- $props are forwarded by the parent -->
  <div class="has-$slots"><slot /></div>
</template>
`,
      3,
    )
    expect(result.ok).toBe(true)
  })
})

/**
 * A DYNAMIC directive argument is an expression, and Vue stores it on
 * `prop.arg` rather than `prop.exp` — so scanning only `exp` left
 * `:[$props.name]="x"` as a live instance read that inlined silently.
 * A STATIC arg (the `class` in `:class`) is a plain name, not code, and must
 * not be scanned or every such component would refuse.
 */
describe('applyDetachEdit — dynamic directive arguments are expressions', () => {
  function detach(component: string, consumer?: string) {
    return applyDetachEdit({
      consumerSource:
        consumer ??
        `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`,
      componentSource: component,
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      // Both fixtures put `<ProtoThing />` on line 3 at column 5.
      callSiteLine: 3,
      callSiteColumn: 5,
    })
  }

  it('refuses a $props read that appears only in a dynamic argument', () => {
    // The consumer must ALSO reference $props, otherwise the ordinary
    // before/after diff catches it and this says nothing about the arg scan.
    // With both sides using the name the diff cancels, so the argument scan
    // is the only thing that can see the read.
    const result = detach(
      `<template>
  <div :[$props.name]="1"><slot /></div>
</template>
`,
      `<template>
  <div :[$props.own]="2">
    <ProtoThing />
  </div>
</template>
`,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$props')
  })

  it('still allows static directive arguments', () => {
    // No script bindings on purpose: a handler defined in the component's own
    // <script setup> would be refused for an unrelated (and correct) reason —
    // detach does not copy the script — which would not test the arg scan.
    const result = detach(`<template>
  <div :class="'x'" :data-kind="'card'"><slot /></div>
</template>
`)
    expect(result.ok).toBe(true)
  })
})

/**
 * `this.$refs` and friends escape BOTH mechanisms unless the expression scan
 * covers every instance-scoped name.
 *
 * Vue leaves a `this.` access as-is rather than rewriting it to `_ctx.$refs`,
 * so the compiler-derived identifier set never contains it; and an expression
 * scan restricted to the two exempt names ($slots/$props) would not look for
 * it either. The scan therefore covers the whole instance-scoped set.
 */
describe('applyDetachEdit — this.$-instance reads in expressions', () => {
  it('refuses `this.$refs` even though the compiler never reports it', () => {
    const result = applyDetachEdit({
      consumerSource: `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`,
      componentSource: `<template>
  <div @click="this.$refs.inner.focus()"><slot /></div>
</template>
`,
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$refs')
  })
})

/**
 * A name mentioned inside a string LITERAL is text, not a read — refusing it
 * is a false refusal. But stripping literals must not lose a real read that
 * sits beside one.
 */
describe('applyDetachEdit — instance names inside string literals', () => {
  function detach(component: string) {
    return applyDetachEdit({
      consumerSource: `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`,
      componentSource: component,
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
  }

  it('does NOT refuse a literal that merely spells an instance name', () => {
    const result = detach(`<template>
  <div :class="'uses-$refs'" :title="'$emit'"><slot /></div>
</template>
`)
    expect(result.ok).toBe(true)
  })

  it('still refuses a real read sitting next to such a literal', () => {
    const result = detach(`<template>
  <div :title="'$emit' + $refs.inner.id"><slot /></div>
</template>
`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$refs')
  })
})

/**
 * A template literal's `${…}` is executable code, not text. Stripping
 * backtick runs alongside quoted ones would hide a real instance read — the
 * literal-stripping fix must not become a silent-breakage bug.
 */
describe('applyDetachEdit — template literals are not stripped', () => {
  it('refuses a $refs read that lives inside a template-literal interpolation', () => {
    const result = applyDetachEdit({
      consumerSource: `<template>
  <div>
    <ProtoThing />
  </div>
</template>
`,
      // MUST be a `this.` access: a bare `$refs` is rewritten to `_ctx.$refs`
      // and caught by the compiler-derived path regardless of stripping, so it
      // would not isolate this behaviour. `this.$refs` is invisible there, so
      // only the expression scan can see it — and only if backticks survive.
      componentSource: '<template>\n  <div :title="`id-${this.$refs.inner.id}`"><slot /></div>\n</template>\n',
      componentFile: '/repo/ProtoThing.vue',
      componentName: 'ProtoThing',
      callSiteLine: 3,
      callSiteColumn: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('$refs')
  })
})
