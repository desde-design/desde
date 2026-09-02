/**
 * Tests for `applySwapEdit` (Phase F2).
 */

import { describe, expect, it } from 'vitest'
import { applySwapEdit } from './apply-swap-edit'

describe('applySwapEdit — happy paths', () => {
  it('swaps a self-closing component, preserving identity props', () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>
<script setup lang="ts">
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<UiSegmentedButton variant="primary" />')
      expect(r.source).toContain(
        "import { UiSegmentedButton } from '@acme/design-system'",
      )
    }
  })

  it('swaps a non-self-closing component with children, rewriting both tags', () => {
    const source = `<template>
  <UiButton variant="primary">Save</UiButton>
</template>
<script setup lang="ts">
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'MyButton',
      toFile: './components/MyButton.vue',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<MyButton variant="primary">Save</MyButton>')
      expect(r.source).toContain(
        "import MyButton from './components/MyButton.vue'",
      )
    }
  })

  it("renames a prop via propMapping", () => {
    const source = `<template>
  <UiDropdown type="primary" />
</template>
<script setup lang="ts">
import { UiDropdown } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiDropdown',
      toComponentName: 'UiSegmentedButton',
      propMapping: { type: 'variant' },
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<UiSegmentedButton variant="primary" />')
      expect(r.source).not.toContain('type="primary"')
    }
  })

  it("drops a prop with a comment marker when propMapping value is null", () => {
    const source = `<template>
  <UiCard fullWidth header="Title" />
</template>
<script setup lang="ts">
import { UiCard } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiCard',
      toComponentName: 'SimpleCard',
      propMapping: { fullWidth: null },
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toMatch(/<!-- swap: dropped fullWidth -->/)
      expect(r.source).toContain('<SimpleCard header="Title" />')
    }
  })

  it("preserves dynamic v-bind directives, optionally renaming the bound name", () => {
    const source = `<template>
  <UiButton :type="ref('primary')" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'NewButton',
      propMapping: { type: 'variant' },
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain(`<NewButton :variant="ref('primary')" />`)
    }
  })

  it("preserves kebab-case casing when consumer used kebab-case", () => {
    const source = `<template>
  <ui-button variant="primary" />
</template>
<script setup>
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<ui-segmented-button variant="primary" />')
    }
  })

  it("removes the old import when removeFromImport is true and old is sole specifier", () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>
<script setup lang="ts">
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      removeFromImport: true,
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).not.toMatch(/import\s*\{\s*UiButton\s*\}/)
      expect(r.source).toContain(
        "import { UiSegmentedButton } from '@acme/design-system'",
      )
    }
  })

  it("removes only one specifier from a multi-specifier named import", () => {
    const source = `<template>
  <UiButton variant="primary" />
  <UiCard />
</template>
<script setup lang="ts">
import { UiButton, UiCard } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      removeFromImport: true,
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('import { UiCard } from')
      expect(r.source).not.toMatch(/\bUiButton\b/)
      expect(r.source).toContain('UiSegmentedButton')
    }
  })

  it("doesn't duplicate the import when target is already imported", () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>
<script setup lang="ts">
import { UiButton, UiSegmentedButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Already-imported guard skipped the inject; the existing
      // multi-specifier import is preserved verbatim.
      const firstIdx = r.source.indexOf('UiSegmentedButton')
      const secondIdx = r.source.indexOf('UiSegmentedButton', firstIdx + 1)
      const thirdIdx = secondIdx >= 0 ? r.source.indexOf('UiSegmentedButton', secondIdx + 1) : -1
      // First two: open and close tag of the swapped element. No third
      // (duplicate import) should appear.
      expect(thirdIdx).toBe(-1)
    }
  })
})

describe('applySwapEdit — codex P1: import-detection precision', () => {
  it("inserts the new import even when an unrelated default import exists", () => {
    // codex P1: previous regex matched ANY default-import branch,
    // making swap silently skip the new-import injection when the
    // file already had any default import (`import x from 'y'`).
    const source = `<template>
  <UiButton variant="primary" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import lodash from 'lodash'
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The new import IS injected — the default `import lodash` no
      // longer fools the alreadyImported check.
      expect(r.source).toContain(
        "import { UiSegmentedButton } from '@acme/design-system'",
      )
    }
  })

  it("recognizes the target name in a mixed default+named import", () => {
    // `import Foo, { Bar, Baz } from 'x'` where Bar === toComponentName
    // → no duplicate inject.
    const source = `<template>
  <UiButton />
</template>
<script setup lang="ts">
import lodash, { UiSegmentedButton, throttle } from 'lodash-utils'
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Mixed import already had UiSegmentedButton — no extra import line.
      const matches = r.source.match(/import .*UiSegmentedButton/g) ?? []
      expect(matches.length).toBe(1)
    }
  })

  it("recognizes the target as a default specifier", () => {
    const source = `<template>
  <UiButton />
</template>
<script setup lang="ts">
import UiSegmentedButton from './UiSegmentedButton.vue'
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'UiSegmentedButton',
      toPackageName: '@acme/design-system',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const matches = r.source.match(/import .*UiSegmentedButton/g) ?? []
      expect(matches.length).toBe(1)
    }
  })
})

describe('applySwapEdit — codex P2: mixed-import removal', () => {
  it("removes the named specifier from a mixed default+named import", () => {
    const source = `<template>
  <UiButton />
</template>
<script setup lang="ts">
import Lodash, { UiButton, throttle } from 'lodash-utils'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'NewBtn',
      removeFromImport: true,
      toPackageName: '@new/btn',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // UiButton removed from the named clause; default + the other
      // named specifier preserved.
      expect(r.source).toContain('import Lodash, { throttle } from')
      expect(r.source).not.toMatch(/\bUiButton\b/)
    }
  })

  it("removes the default specifier from a mixed default+named import", () => {
    const source = `<template>
  <UiButton />
</template>
<script setup lang="ts">
import UiButton, { Foo, Bar } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'NewBtn',
      removeFromImport: true,
      toPackageName: '@new/btn',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Default specifier removed; named clause preserved as a pure
      // named import.
      expect(r.source).toMatch(/import\s*\{\s*Foo,\s*Bar\s*\}\s*from/)
      expect(r.source).not.toMatch(/import\s+UiButton\s*,/)
    }
  })

  it("collapses to default-only when removing the sole named specifier", () => {
    const source = `<template>
  <UiButton />
</template>
<script setup lang="ts">
import Lodash, { UiButton } from 'lodash-utils'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'NewBtn',
      removeFromImport: true,
      toPackageName: '@new/btn',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toMatch(/import\s+Lodash\s+from\s+'lodash-utils'/)
      expect(r.source).not.toMatch(/\{\s*\}/)
    }
  })
})

describe('applySwapEdit — refusals', () => {
  it("refuses when both toPackageName and toFile are supplied", () => {
    const source = `<template>
  <UiButton />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'X',
      toPackageName: '@x/y',
      toFile: './x.vue',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/either toPackageName OR toFile/)
  })

  it("refuses when consumer SFC has no <template> block", () => {
    const r = applySwapEdit({
      consumerSource: `<script setup></script>`,
      callSiteLine: 1,
      callSiteColumn: 1,
      fromComponentName: 'UiButton',
      toComponentName: 'X',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no <template>/)
  })

  it("refuses when no element exists at the given location", () => {
    const source = `<template>
  <UiButton />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 99,
      callSiteColumn: 99,
      fromComponentName: 'UiButton',
      toComponentName: 'X',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/No call-site element found/)
  })

  it("refuses when the element at the location isn't the expected component", () => {
    const source = `<template>
  <UiCard />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton', // expecting UiButton, found UiCard
      toComponentName: 'X',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/<UiCard>, not <UiButton>/)
  })

  it("refuses when newComponentRequiredProps aren't satisfied", () => {
    const source = `<template>
  <UiButton />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'KStrictButton',
      newComponentRequiredProps: ['variant', 'size'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/Required prop\(s\) missing/)
      expect(r.reason).toMatch(/variant/)
      expect(r.reason).toMatch(/size/)
    }
  })

  it('accepts when required props are satisfied via mapping', () => {
    const source = `<template>
  <UiButton type="primary" size="md" />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'KStrictButton',
      propMapping: { type: 'variant' },
      newComponentRequiredProps: ['variant', 'size'],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.source).toContain('<KStrictButton variant="primary" size="md" />')
    }
  })

  it('refuses an empty toComponentName (must be PascalCase)', () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: '',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/must be PascalCase/)
  })

  it('refuses a non-PascalCase toComponentName', () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'lowercase-name',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/PascalCase/)
  })
})

describe('applySwapEdit — warnings (non-fatal)', () => {
  it('warns when no toPackageName/toFile provided (assumed auto-import)', () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>
<script setup>
import { UiButton } from '@acme/design-system'
</script>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'KGlobalButton',
      // No toPackageName / toFile.
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes('auto-import'))).toBe(true)
    }
  })

  it('warns when consumer has no <script setup>', () => {
    const source = `<template>
  <UiButton variant="primary" />
</template>`
    const r = applySwapEdit({
      consumerSource: source,
      callSiteLine: 2,
      callSiteColumn: 3,
      fromComponentName: 'UiButton',
      toComponentName: 'X',
      toPackageName: '@x/y',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes('no <script setup>'))).toBe(true)
    }
  })
})
