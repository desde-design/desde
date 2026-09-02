/**
 * Unit coverage for the source-tag plugin's `transform` step. Focuses
 * on the Phase 2c `data-desde-bind:<prop>` compile stamp: that a static
 * `:prop="expr"` binding gets a sibling stamp encoding the bound
 * expression's source loc AND its base64-encoded text, and that the
 * skipped shapes (v-model, event handlers, spread, dynamic key) get no
 * bind stamp. Also re-asserts the existing `data-desde-src` behavior is
 * intact and that the transform is in-memory (idempotent on re-run).
 * Each element also gets a `data-desde-v="<12-hex-hash>"` version stamp.
 *
 * Plus the transparent-outlet skip-list: stamping an outlet makes the
 * routed/layout component's ROOT element attribute to the outlet's
 * callsite instead of its own file (see the comment on
 * TRANSPARENT_ROUTING_OUTLETS in the plugin).
 */
import { describe, it, expect } from "vitest"
import { sourceTagPlugin } from "./source-tag-plugin"
import { sourceVersionOf } from "./source-version"

const REPO_ROOT = "/repo"

/** Run the plugin's transform on `code` for a synthetic `.vue` file. */
function transform(code: string, file = "src/Test.vue"): string {
  const plugin = sourceTagPlugin({ repoRoot: REPO_ROOT })
  // `transform` is declared as a Vite hook object/function; call it
  // with a minimal `this` (the plugin doesn't use the Rollup context).
  const t = plugin.transform as (
    this: unknown,
    code: string,
    id: string,
  ) => { code: string } | null
  const out = t.call({}, code, `${REPO_ROOT}/${file}`)
  return out ? out.code : code
}

/**
 * Tag names that carried a stamp, in source order. Both stamps inject at the
 * same offset — immediately after the tag-name — and `applyInsertions` splices
 * descending, so `data-desde-v` always ends up leftmost on a stamped tag.
 */
function stampedTags(code: string): string[] {
  return [...code.matchAll(/<([A-Za-z][\w.-]*)\s+data-desde-v="/g)].map((m) => m[1])
}

/** Pull the value of `data-desde-bind:<prop>` out of transformed output. */
function bindStampValue(code: string, prop: string): string | null {
  const re = new RegExp(`data-desde-bind:${prop}="([^"]*)"`)
  const m = code.match(re)
  return m ? m[1] : null
}

/** Decode a bind stamp `"<file>:<line>:<col> <base64(expr)>"`. Splits on
 * the LAST space so a file path containing spaces stays intact. */
function decodeBindStamp(value: string): { file: string; line: number; column: number; expr: string } {
  const spaceIdx = value.lastIndexOf(" ")
  const loc = value.slice(0, spaceIdx)
  const b64 = value.slice(spaceIdx + 1)
  const lastColon = loc.lastIndexOf(":")
  const secondLast = loc.lastIndexOf(":", lastColon - 1)
  return {
    file: loc.slice(0, secondLast),
    line: Number(loc.slice(secondLast + 1, lastColon)),
    column: Number(loc.slice(lastColon + 1)),
    expr: Buffer.from(b64, "base64").toString("utf8"),
  }
}

describe("source-tag-plugin — data-desde-bind compile stamp (Phase 2c)", () => {
  it("stamps a simple-identifier :prop binding with its loc + expression", () => {
    const code = `<template>
  <KInput
    label="Name"
    :placeholder="providerNamePlaceholder"
  />
</template>
`
    const out = transform(code)
    const stamp = bindStampValue(out, "placeholder")
    expect(stamp).not.toBeNull()
    const decoded = decodeBindStamp(stamp as string)
    expect(decoded.file).toBe("src/Test.vue")
    expect(decoded.expr).toBe("providerNamePlaceholder")
    // Loc is the bound expression's start position. `:placeholder="…"`
    // is on line 4; the expression begins after `:placeholder="`.
    expect(decoded.line).toBe(4)
    expect(decoded.column).toBeGreaterThan(0)
    // The static literal prop is NOT bound → no bind stamp for it.
    expect(bindStampValue(out, "label")).toBeNull()
  })

  it("handles the v-bind:prop long form identically", () => {
    const code = `<template>
  <KInput v-bind:placeholder="defaultPath" />
</template>
`
    const out = transform(code)
    const decoded = decodeBindStamp(bindStampValue(out, "placeholder") as string)
    expect(decoded.expr).toBe("defaultPath")
  })

  it("base64-encodes a complex expression so colons/quotes/operators round-trip", () => {
    const expr = `index === 0 ? getPlaceholder('a:b') : "x"`
    const code = `<template>
  <KInput :placeholder="${expr.replace(/"/g, "&quot;")}" />
</template>
`
    const out = transform(code)
    const decoded = decodeBindStamp(bindStampValue(out, "placeholder") as string)
    // Vue normalizes &quot; back to " in the parsed expression content.
    expect(decoded.expr).toBe(expr)
  })

  it("skips event handlers (@x / v-on)", () => {
    const code = `<template>
  <KButton @click="onClick" v-on:focus="onFocus" />
</template>
`
    const out = transform(code)
    expect(bindStampValue(out, "click")).toBeNull()
    expect(bindStampValue(out, "focus")).toBeNull()
    expect(out).not.toContain("data-desde-bind:")
  })

  it("skips v-model", () => {
    const code = `<template>
  <KInput v-model="providerName" />
</template>
`
    const out = transform(code)
    expect(out).not.toContain("data-desde-bind:")
  })

  it("skips the v-bind spread form (v-bind=\"obj\")", () => {
    const code = `<template>
  <KInput v-bind="inputAttrs" />
</template>
`
    const out = transform(code)
    expect(out).not.toContain("data-desde-bind:")
  })

  it("skips dynamic-key binds (:[name]=\"x\")", () => {
    const code = `<template>
  <KInput :[dynamicProp]="value" />
</template>
`
    const out = transform(code)
    expect(out).not.toContain("data-desde-bind:")
  })

  it("stamps multiple bindings on one tag", () => {
    const code = `<template>
  <KInput :placeholder="ph" :error="hasError" :label="lbl" />
</template>
`
    const out = transform(code)
    expect(decodeBindStamp(bindStampValue(out, "placeholder") as string).expr).toBe("ph")
    expect(decodeBindStamp(bindStampValue(out, "error") as string).expr).toBe("hasError")
    expect(decodeBindStamp(bindStampValue(out, "label") as string).expr).toBe("lbl")
  })

  it("round-trips a file path containing spaces (split on last space, not first)", () => {
    const code = `<template>
  <KInput :placeholder="ph" />
</template>
`
    // A repo-relative path with a space — e.g. a `ui drafts/` folder.
    const out = transform(code, "src/ui drafts/Form.vue")
    const decoded = decodeBindStamp(bindStampValue(out, "placeholder") as string)
    expect(decoded.file).toBe("src/ui drafts/Form.vue")
    expect(decoded.expr).toBe("ph")
    expect(Number.isFinite(decoded.line)).toBe(true)
    expect(Number.isFinite(decoded.column)).toBe(true)
  })

  it("is idempotent on re-run (already-stamped element gets no duplicate)", () => {
    const code = `<template>
  <KInput :placeholder="ph" />
</template>
`
    const once = transform(code)
    const twice = transform(once)
    expect(twice).toBe(once)
    const count = (twice.match(/data-desde-bind:placeholder=/g) ?? []).length
    expect(count).toBe(1)
  })
})

describe("source-tag-plugin — data-desde-src unchanged by Phase 2c", () => {
  it("still stamps every concrete element with data-desde-src", () => {
    const code = `<template>
  <div>
    <KInput :placeholder="ph" />
  </div>
</template>
`
    const out = transform(code)
    expect((out.match(/data-desde-src=/g) ?? []).length).toBe(2)
  })

  it("does not transform non-.vue files", () => {
    const plugin = sourceTagPlugin({ repoRoot: REPO_ROOT })
    const t = plugin.transform as (this: unknown, code: string, id: string) => unknown
    expect(t.call({}, "<KInput :placeholder=\"ph\" />", `${REPO_ROOT}/foo.ts`)).toBeNull()
  })
})

describe("source-tag-plugin — data-desde-v version stamp", () => {
  it("stamps each element with data-desde-v equal to sourceVersionOf(input)", () => {
    const code = `<template>
  <div>
    <KInput :placeholder="ph" />
  </div>
</template>
`
    const out = transform(code)
    const expectedVersion = sourceVersionOf(code)
    const versionMatches = [...out.matchAll(/data-desde-v="([^"]*)"/g)]
    expect(versionMatches).toHaveLength(2)
    expect(versionMatches[0][1]).toBe(expectedVersion)
    expect(versionMatches[1][1]).toBe(expectedVersion)
  })

  it("stamps data-desde-v with exactly 12 lowercase hex chars", () => {
    const code = `<template>
  <div>test</div>
</template>
`
    const out = transform(code)
    const versionMatches = [...out.matchAll(/data-desde-v="([^"]*)"/g)]
    expect(versionMatches).toHaveLength(1)
    const hash = versionMatches[0][1]
    expect(hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it("is idempotent — re-running does not duplicate data-desde-v", () => {
    const code = `<template>
  <div>
    <span>test</span>
  </div>
</template>
`
    const once = transform(code)
    const twice = transform(once)
    expect(twice).toBe(once)
    const versionMatches = [...twice.matchAll(/data-desde-v="[^"]*"/g)]
    expect(versionMatches).toHaveLength(2)
  })
})

describe("source-tag-plugin — transparent routing outlets are never stamped", () => {
  // vue-router. Pre-existing behaviour that had no colocated coverage; the
  // Nuxt entries below were missing because nothing pinned this rule.
  it("skips <router-view> and <RouterView>", () => {
    const code = `<template>
  <div class="app-shell">
    <router-view />
    <RouterView name="aside" />
  </div>
</template>
`
    expect(stampedTags(transform(code))).toEqual(["div"])
  })

  // The measured Nuxt 4.5.2 defect: `<NuxtPage />` at app.vue:4:5 put
  // `app.vue:4:5` onto `pages/index.vue`'s own `<main class="page-root">`, and a
  // prop edit then wrote onto `<NuxtPage>` in app.vue — wrong file, wrong element.
  it("skips <NuxtPage> — the routed page's root must keep its own stamp", () => {
    const code = `<template>
  <div class="app-shell">
    <NuxtPage />
  </div>
</template>
`
    const out = transform(code)
    expect(stampedTags(out)).toEqual(["div"])
    expect(out).toContain("<NuxtPage />")
  })

  it("skips the kebab-case <nuxt-page> spelling too", () => {
    const code = `<template>
  <div class="app-shell">
    <nuxt-page />
  </div>
</template>
`
    expect(stampedTags(transform(code))).toEqual(["div"])
  })

  // NuxtLayout forwards `context.attrs` through LayoutProvider -> LayoutLoader
  // -> h(layouts[name], layoutProps), so the stamp lands on the root element of
  // `layouts/<name>.vue` — a different file again.
  it("skips <NuxtLayout> and <nuxt-layout>, while still stamping their children", () => {
    const code = `<template>
  <NuxtLayout>
    <nuxt-layout name="custom">
      <p>content</p>
    </nuxt-layout>
  </NuxtLayout>
</template>
`
    expect(stampedTags(transform(code))).toEqual(["p"])
  })

  it("skips an outlet carrying bindings (no data-desde-bind stamp either)", () => {
    const code = `<template>
  <NuxtPage :page-key="routeKey" />
</template>
`
    const out = transform(code)
    expect(stampedTags(out)).toEqual([])
    expect(out).not.toContain("data-desde-bind:")
  })

  // Over-skipping is its own bug: these are NOT outlets. NuxtLink renders a real
  // <a>, and a `<slot>`'s attributes are slot props that never reach the DOM —
  // both are deliberately still stamped.
  it("still stamps non-outlet Nuxt components and <slot>", () => {
    const code = `<template>
  <div>
    <NuxtLink to="/x">Go</NuxtLink>
    <NuxtLoadingIndicator />
    <slot />
  </div>
</template>
`
    expect(stampedTags(transform(code))).toEqual([
      "div",
      "NuxtLink",
      "NuxtLoadingIndicator",
      "slot",
    ])
  })
})

/** Value of `data-desde-own` on the first element carrying one. */
function ownStamp(code: string): string | null {
  const m = code.match(/data-desde-own="([^"]*)"/)
  return m ? m[1] : null
}

/** All `data-desde-own` values, in source order. */
function ownStamps(code: string): string[] {
  return [...code.matchAll(/data-desde-own="([^"]*)"/g)].map((m) => m[1])
}

/**
 * The general fix for the fallthrough collision that
 * TRANSPARENT_ROUTING_OUTLETS only patched by name. Vue applies a
 * single-root child's inherited attrs to its ROOT element LAST, so the
 * parent's `data-desde-src` OVERWRITES the root's own — measured on the
 * sakai-vue substrate, where `FloatingConfigurator.vue`'s own root `<div>`
 * (9:5) reported `src/views/pages/auth/Login.vue:11:5`.
 */
describe("source-tag-plugin — data-desde-own (fallthrough-proof own coordinate)", () => {
  it("stamps a single HOST root with its own coordinate + own file version", () => {
    const code = `<template>
  <div class="root">
    <span>hi</span>
  </div>
</template>
`
    const out = transform(code)
    const stamps = ownStamps(out)
    expect(stamps).toHaveLength(1)
    // `"<file>:<line>:<col> <sourceVersion>"` — the loc half is byte-identical
    // to this element's data-desde-src, because they describe the same AST node.
    expect(stamps[0]).toBe(`src/Test.vue:2:3 ${sourceVersionOf(code)}`)
    expect(out).toContain('data-desde-src="src/Test.vue:2:3"')
  })

  it("stamps ONLY the root — descendants can't be overwritten, so they don't need it", () => {
    const code = `<template>
  <div><span><i>x</i></span></div>
</template>
`
    expect(ownStamps(transform(code))).toHaveLength(1)
  })

  it("does NOT stamp a COMPONENT root — it would fall through and collide one level down", () => {
    // `<template><KButton/></template>`: a data-desde-own here would be inherited
    // by KButton's own root and overwrite ITS data-desde-own, rebuilding the
    // identical defect. The grandchild keeps its own instead.
    const code = `<template>
  <KButton label="Go" />
</template>
`
    const out = transform(code)
    expect(ownStamps(out)).toEqual([])
    // The ordinary callsite stamp is still there — that's what the bridge
    // reads off the component vnode's props.
    expect(out).toContain('data-desde-src="src/Test.vue:2:3"')
  })

  it("does not stamp a multi-root template — nothing inherits, so nothing is polluted", () => {
    const code = `<template>
  <div>a</div>
  <div>b</div>
</template>
`
    expect(ownStamps(transform(code))).toEqual([])
  })

  it("stamps every branch of a v-if / v-else-if / v-else chain — the compiler treats it as ONE root", () => {
    const code = `<template>
  <div v-if="a">a</div>
  <section v-else-if="b">b</section>
  <span v-else>c</span>
</template>
`
    const out = transform(code)
    const version = sourceVersionOf(code)
    expect(ownStamps(out)).toEqual([
      `src/Test.vue:2:3 ${version}`,
      `src/Test.vue:3:3 ${version}`,
      `src/Test.vue:4:3 ${version}`,
    ])
  })

  it("ignores comments and whitespace when deciding the root is single", () => {
    // Vue does too: one element beside a comment compiles to a
    // DEV_ROOT_FRAGMENT that `getChildRoot` unwraps, so fallthrough lands.
    const code = `<template>
  <!-- leading note -->
  <div class="root">x</div>
  <!-- trailing note -->
</template>
`
    expect(ownStamps(transform(code))).toHaveLength(1)
  })

  it("does not stamp a root carrying v-for (renders a Fragment, never inherits)", () => {
    const code = `<template>
  <li v-for="x in xs" :key="x">{{ x }}</li>
</template>
`
    expect(ownStamps(transform(code))).toEqual([])
  })

  it("does not stamp a <slot> root", () => {
    const code = `<template>
  <slot />
</template>
`
    expect(ownStamps(transform(code))).toEqual([])
  })

  it("round-trips a file path containing spaces (value splits on the LAST space)", () => {
    const code = `<template>
  <div>x</div>
</template>
`
    const value = ownStamp(transform(code, "src/ui drafts/Card.vue")) as string
    const sep = value.lastIndexOf(" ")
    expect(value.slice(0, sep)).toBe("src/ui drafts/Card.vue:2:3")
    expect(value.slice(sep + 1)).toMatch(/^[0-9a-f]{12}$/)
  })

  it("is idempotent — a re-transform adds no second data-desde-own", () => {
    const code = `<template>
  <div class="root"><span>x</span></div>
</template>
`
    const once = transform(code)
    const twice = transform(once)
    expect(twice).toBe(once)
    expect(ownStamps(twice)).toHaveLength(1)
  })
})

/**
 * Stamping a fragment-rooted component makes Vue log, unconditionally in
 * dev, `Extraneous non-props attributes (data-desde-v, data-desde-src) were
 * passed to component but could not be automatically inherited…` — our
 * attribute names, in the user's console, on every load. We cannot stop
 * stamping the tag (the bridge reads the callsite off the component
 * vnode's props), so we state what is already true about that component.
 */
describe("source-tag-plugin — inheritAttrs:false suppresses Vue's fragment-root warning", () => {
  const INJECTED = "export default { inheritAttrs: false }"

  it("appends a normal <script> block for a multi-root, script-less SFC", () => {
    const code = `<template>
  <div>a</div>
  <div>b</div>
</template>
`
    const out = transform(code)
    expect(out).toContain(`<script>\n${INJECTED}\n</script>`)
  })

  it("matches <script setup>'s lang — the two blocks must declare the same language", () => {
    const code = `<script setup lang="ts">
const label: string = 'x'
</script>

<template>
  <div>{{ label }}</div>
  <div>b</div>
</template>
`
    const out = transform(code)
    expect(out).toContain(`<script lang="ts">\n${INJECTED}\n</script>`)
  })

  it("injects for a text/interpolation root too", () => {
    const code = `<template>{{ msg }}</template>
`
    expect(transform(code)).toContain(INJECTED)
  })

  it("injects for a v-for root and a <slot> root", () => {
    expect(transform(`<template>\n  <li v-for="x in xs" :key="x">{{ x }}</li>\n</template>\n`)).toContain(INJECTED)
    expect(transform(`<template>\n  <slot />\n</template>\n`)).toContain(INJECTED)
  })

  it("does NOT inject for a single-root SFC — that would kill real attr fallthrough", () => {
    const code = `<template>
  <div class="root">x</div>
</template>
`
    expect(transform(code)).not.toContain("inheritAttrs")
  })

  it("does NOT inject for a v-if/v-else chain — the compiler sees ONE root", () => {
    const code = `<template>
  <div v-if="a">a</div>
  <div v-else>b</div>
</template>
`
    expect(transform(code)).not.toContain("inheritAttrs")
  })

  it("does NOT inject for an empty template (Vue exempts a Comment root anyway)", () => {
    expect(transform(`<template>\n  <!-- nothing -->\n</template>\n`)).not.toContain("inheritAttrs")
  })

  it("leaves an SFC that already has a normal <script> alone", () => {
    // Merging into an arbitrary `export default` is string surgery on user
    // code; the warning is the cheaper thing to live with.
    const code = `<script>
export default { name: 'Thing' }
</script>

<template>
  <div>a</div>
  <div>b</div>
</template>
`
    const out = transform(code)
    expect(out).not.toContain("inheritAttrs")
    expect(out).toContain("export default { name: 'Thing' }")
  })

  it("leaves an SFC whose <script setup> already calls defineOptions alone", () => {
    // A second defineOptions() is a compile error.
    const code = `<script setup>
defineOptions({ name: 'Thing' })
</script>

<template>
  <div>a</div>
  <div>b</div>
</template>
`
    expect(transform(code)).not.toContain("inheritAttrs")
  })

  it("refuses to build the lang attribute out of a non-alphanumeric value", () => {
    const code = `<script setup lang="ts&quot;><b>">
const x = 1
</script>

<template>
  <div>a</div>
  <div>b</div>
</template>
`
    expect(transform(code)).not.toContain("inheritAttrs")
  })

  it("is idempotent — the injected block IS a normal <script>, so a re-run bails", () => {
    const code = `<template>
  <div>a</div>
  <div>b</div>
</template>
`
    const once = transform(code)
    const twice = transform(once)
    expect(twice).toBe(once)
    expect((twice.match(/inheritAttrs/g) ?? []).length).toBe(1)
  })

  it("still stamps the elements it injects alongside", () => {
    const code = `<template>
  <div>a</div>
  <div>b</div>
</template>
`
    expect(stampedTags(transform(code))).toEqual(["div", "div"])
  })
})
