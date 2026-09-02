/**
 * Tests for the pure prop-edit applicator. The function takes an SFC source
 * string + SFC-absolute (line, column, propName, value) and returns a new SFC
 * source. No filesystem, no Next.js — exercising the AST walk and source
 * patching in isolation.
 *
 * Coordinate convention: line/column are SFC-absolute (the same coords
 * `data-desde-src` carries from `vite-plugin-source-tag` against
 * `@vitejs/plugin-vue` v6).
 */

import { describe, expect, it } from "vitest"
import { applyPropEdit } from "./apply-prop-edit"

const sfcWithKButton = `<template>
  <div class="row">
    <KButton variant="primary">Save</KButton>
  </div>
</template>

<script setup lang="ts">
</script>
`
// SFC-absolute coords for `<KButton>` above: line 3 column 5 (the four-space
// indent puts the `<` at column 5; SFC-absolute === template-content-relative
// here because <template> is on line 1).

describe("applyPropEdit — replace existing string attribute", () => {
  it("changes the value while preserving surrounding source", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<KButton variant="danger">Save</KButton>')
      // Surrounding markup intact.
      expect(result.source).toContain('<div class="row">')
      expect(result.source).toContain("</template>")
    }
  })

  it("HTML-escapes quotes in the new string value", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      value: 'pri"mary',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('variant="pri&quot;mary"')
    }
  })
})

describe("applyPropEdit — insert new attribute", () => {
  it("adds the attribute before the open-tag close when no existing prop matches", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "disabled",
      value: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toMatch(/<KButton[^>]*:disabled="true"[^>]*>/)
      expect(result.source).toContain('variant="primary"')
    }
  })

  it("renders numbers with v-bind shorthand so Vue parses them as numbers", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "tabindex",
      value: 2,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toMatch(/<KButton[^>]*:tabindex="2"[^>]*>/)
    }
  })
})

describe("applyPropEdit — directive (v-bind shorthand) match", () => {
  it("replaces a `:variant=\"...\"` shorthand attribute", () => {
    const sfc = `<template>
  <KButton :variant="'primary'">Save</KButton>
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('variant="danger"')
      expect(result.source).not.toContain(":variant=\"'primary'\"")
    }
  })

  it("refuses to overwrite a `:label=\"title\"` variable binding with a literal", () => {
    // Codex review P0: silently rewriting `:label="title"` as `label="X"`
    // destroys the binding to `title` and changes runtime behavior. The
    // applicator must refuse and surface a clear reason so the caller can
    // direct the user to edit the bound expression at its source instead.
    const sfc = `<template>
  <KLabel :label="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/bound prop "label"/)
      expect(result.reason).toMatch(/title/)
      // Fallback marker drives the route's source-aware LLM retry.
      expect(result.fallback).toEqual({
        kind: 'bound-binding',
        expression: 'title',
      })
    }
  })

  it("refuses to overwrite `:text=\"user.name\"` with a literal", () => {
    const sfc = `<template>
  <KLabel :text="user.name" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "text",
      value: "Hello",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/user\.name/)
    }
  })

  it("refuses to overwrite `:disabled=\"isDisabled\"` with a boolean", () => {
    // Codex review P0 round-7: the bound-prop guard must apply to ALL
    // replacement value types, not just strings. Rewriting
    // `:disabled="isDisabled"` to `:disabled="false"` silently drops the
    // dependency on `isDisabled`.
    const sfc = `<template>
  <KButton :disabled="isDisabled" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "disabled",
      value: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/bound prop "disabled"/)
      expect(result.reason).toMatch(/isDisabled/)
    }
  })

  it("refuses to overwrite `:count=\"total\"` with a number", () => {
    const sfc = `<template>
  <KBadge :count="total" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "count",
      value: 5,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/total/)
    }
  })

  it("allows literal-number binding to be overwritten with a literal string", () => {
    // `:count="42"` has no external dependency, so converting to a static
    // attribute is safe. This preserves Variants & Props' ability to
    // change a number-typed prop to a string-typed one without complaint.
    const sfc = `<template>
  <KButton :count="42">Save</KButton>
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "count",
      value: "many",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('count="many"')
    }
  })

  it("attaches a v-model fallback marker on v-model refusal", () => {
    const sfc = `<template>
  <KInput v-model="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: 'modelValue',
      value: 'Welcome',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fallback).toEqual({ kind: 'v-model' })
    }
  })

  it("refuses to insert a literal next to a v-bind spread", () => {
    // Codex review P0 follow-up: when `v-bind="labelProps"` is in source,
    // the runtime prop value may have been supplied via the spread. The
    // applicator can't statically prove the prop isn't covered, so it
    // must refuse rather than insert a duplicate/overriding literal.
    const sfc = `<template>
  <KLabel v-bind="labelProps" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/dynamic v-bind/)
      expect(result.fallback).toEqual({ kind: 'dynamic-vbind' })
    }
  })

  it("refuses to overwrite an explicit prop when a v-bind spread is also present", () => {
    // Codex review P0 round-3: when both `label="Static"` and
    // `v-bind="labelProps"` are present, the runtime `label` may have
    // come from the spread. Rewriting `label="Static"` to `label="New"`
    // would change a non-rendered source value, masking the real edit
    // target. Refuse regardless of which one is "first" in source —
    // Vue's order-dependent merge is too subtle to safely emulate here.
    const sfc = `<template>
  <KLabel label="Static" v-bind="labelProps" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/dynamic v-bind/)
    }
  })

  it("refuses to set `modelValue` next to a `v-model` directive", () => {
    // Codex review P0 round-4: `v-model="title"` is sugar for
    // `:modelValue="title" @update:modelValue="title = $event"`. The
    // runtime `modelValue` prop comes from the binding; inserting
    // `modelValue="…"` next to it would break two-way data flow.
    const sfc = `<template>
  <KInput v-model="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "modelValue",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/v-model/)
    }
  })

  it("refuses to set the matching named v-model prop", () => {
    // `v-model:label="title"` binds the `label` prop specifically.
    const sfc = `<template>
  <KLabel v-model:label="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/v-model/)
    }
  })

  it("refuses to set the matching kebab-case v-model prop with a camelCase request", () => {
    // Codex review P0 round-6: `v-model:label-text="title"` binds the
    // `labelText` runtime prop. Without kebab equivalence on the v-model
    // guard, an edit request for "labelText" would insert beside the
    // v-model and break the binding.
    const sfc = `<template>
  <KLabel v-model:label-text="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "labelText",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/v-model/)
    }
  })

  it("refuses to insert next to a kebab-case bound prop (camelCase request)", () => {
    // Codex review P0 round-5: Vue accepts both camelCase and kebab-case
    // at the callsite and normalizes to camelCase at runtime
    // (`instance.props.labelText`). Without kebab matching, an edit
    // request for "labelText" would skip the existing `:label-text` and
    // insert a duplicate, breaking the binding. With kebab matching the
    // bound-prop guard correctly fires and refuses.
    const sfc = `<template>
  <KLabel :label-text="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "labelText",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/bound prop "labelText"/)
    }
  })

  it("replaces a static kebab-case attribute when the request is camelCase", () => {
    // Static `label-text="Hi"` is safe to rewrite — semantics survive
    // either spelling. The resulting source uses camelCase (matches the
    // request name); preserving source spelling is a polish for later.
    const sfc = `<template>
  <KLabel label-text="Hi" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "labelText",
      value: "Welcome",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('Welcome')
      expect(result.source).not.toContain('"Hi"')
    }
  })

  it("allows setting a non-conflicting prop next to a v-model on a different prop", () => {
    // `v-model:foo="x"` only binds `foo`; setting `label` is unaffected.
    const sfc = `<template>
  <KLabel v-model:foo="x" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('label="Welcome"')
    }
  })

  it("refuses to insert a literal next to a dynamic-arg v-bind", () => {
    // `:[name]="value"` — the arg expression could evaluate to any prop
    // name at runtime, so we can't prove the target prop isn't covered.
    // Refuse for the same reason as spread v-bind.
    const sfc = `<template>
  <KLabel :[propName]="title" />
</template>
`
    const result = applyPropEdit({
      source: sfc,
      line: 2,
      column: 3,
      propName: "label",
      value: "Welcome",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/dynamic v-bind/)
    }
  })
})

describe("applyPropEdit — no-op guard", () => {
  // Mirrors apply-jsx-prop-edit.ts's okOrNoop: a patched result byte-identical
  // to the input source must refuse, not report ok:true, so the CLI handler
  // never writes an unchanged file and reports "committed" for nothing.
  it("refuses a same-value string prop edit as a no-op", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      value: "primary", // same as the existing value in sfcWithKButton
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/unchanged/i)
      // No-op refusals are not a fallback-eligible case — the reason is
      // purely "nothing to do," not "the binding is too complex."
      expect(result.fallback).toBeUndefined()
    }
  })

  it("still applies a genuinely-changing edit to the same attribute", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<KButton variant="danger">Save</KButton>')
    }
  })
})

describe("applyPropEdit — script-first SFC (regression)", () => {
  // `<script>` before `<template>` is legal Vue. data-desde-src carries
  // SFC-absolute lines, so the lookup must shift the AST's
  // template-content-relative loc by the template block's start.
  const scriptFirst = `<script setup lang="ts">
const x = 1
</script>

<template>
  <KButton variant="primary">Save</KButton>
</template>
`
  it("matches the SFC-absolute (line, column) of the element", () => {
    // <KButton> in scriptFirst is on SFC line 6 column 3.
    const result = applyPropEdit({
      source: scriptFirst,
      line: 6,
      column: 3,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toContain('<KButton variant="danger">Save</KButton>')
      // The leading <script> block is left intact.
      expect(result.source).toContain('<script setup lang="ts">')
    }
  })

  it("rejects the old template-content-relative coords (negative test)", () => {
    // Used to succeed with line:2,column:3 under the previous (wrong) convention.
    const result = applyPropEdit({
      source: scriptFirst,
      line: 2,
      column: 3,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(false)
  })
})

describe("applyPropEdit — input validation", () => {
  it("refuses propName that doesn't match the safe identifier pattern", () => {
    // Codex review P0: the attr-mutation fast-path passes `m.target`
    // straight through after a bare typeof === 'string' check. Without
    // an in-applicator guard, a malformed target could be spliced
    // verbatim into source.
    const sfc = `<template>
  <KLabel label="Foo" />
</template>
`
    for (const badName of [
      'foo bar',
      'foo>',
      '<script>',
      '"onerror=alert(1)',
      '',
      '1starts-with-digit',
    ]) {
      const result = applyPropEdit({
        source: sfc,
        line: 2,
        column: 3,
        propName: badName,
        value: 'Welcome',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(/Refused: propName/)
      }
    }
  })

  it("allows kebab + camel + underscore names (the typed-PropEdit happy path)", () => {
    const sfc = `<template>
  <KLabel label="X" />
</template>
`
    for (const name of ['label', 'labelText', 'label-text', '_internal']) {
      const result = applyPropEdit({
        source: sfc,
        line: 2,
        column: 3,
        propName: name,
        value: 'Y',
      })
      // Either applied successfully OR refused for a NON-validation
      // reason (e.g. attribute not found in source). Validation gate
      // never fires for these.
      if (!result.ok) {
        expect(result.reason).not.toMatch(/Refused: propName/)
      }
    }
  })
})

describe("applyPropEdit — failure modes", () => {
  it("returns ok:false when the line/column does not match any element", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 99,
      column: 1,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/No element/)
    }
  })

  it("returns ok:false when the SFC has no <template> block", () => {
    const result = applyPropEdit({
      source: `<script>export default {}</script>`,
      line: 1,
      column: 1,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(false)
  })

  it("returns ok:false for unsupported value types", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      // @ts-expect-error — exercising the runtime guard with a deliberately wrong type.
      value: { nested: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/value type/)
    }
  })
})

describe("applyPropEdit — post-splice validation (WS2 defense-in-depth)", () => {
  // tasks/edit-pipeline-rearchitecture.md WS2: apply-prop-edit had no
  // backstop re-parse/compile after splicing, unlike apply-move-edit.ts /
  // apply-detach-edit.ts. `SAFE_PROP_NAME_RE` (`/^[A-Za-z_][A-Za-z0-9_-]*$/`)
  // exists to stop arbitrary-character injection, but it does NOT exclude
  // Vue's `v-`-prefixed structural directive names — so a caller asking to
  // set prop `"v-else"` (a legitimate-looking prop name matching the regex)
  // splices in a real `v-else` directive with no adjacent `v-if`, which
  // Vue's compiler rejects. This is a genuinely reachable corruption case
  // through the public API, not a hypothetical — it demonstrates the
  // backstop is load-bearing here, not just decorative.
  it("refuses when propName is a structural directive with no matching v-if (v-else)", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "v-else",
      value: "true",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Post-splice template compile failed/)
      expect(result.reason).toMatch(/v-else/i)
    }
  })

  it("refuses when propName is v-for with an invalid iteration expression", () => {
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "v-for",
      value: "true",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Post-splice template compile failed/)
    }
  })

  it("still returns ok:true for a normal edit that compiles cleanly", () => {
    // Baseline: the backstop must not false-positive on ordinary edits.
    const result = applyPropEdit({
      source: sfcWithKButton,
      line: 3,
      column: 5,
      propName: "variant",
      value: "danger",
    })
    expect(result.ok).toBe(true)
  })
})
