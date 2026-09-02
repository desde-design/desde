import { parse } from "@vue/compiler-sfc"
import { collectEmbeddedJsxInsertions } from "./jsx-source-tag-plugin.js"
import type { Plugin } from "vite"
import { resolveStampPolicy, stampPathFor, type StampScope } from "../hosts/stamp-policy.js"
import { sourceVersionOf } from "./source-version.js"
import { classifyTransformInput, reportStampProblem } from "./transform-input.js"

/**
 * Which files this stamper may annotate, and what `data-desde-src` paths are
 * relative to. See {@link StampScope} for why both forms exist and
 * `hosts/stamp-policy.ts` for the rule itself.
 */
export type SourceTagPluginOptions = StampScope

/**
 * Vite plugin that stamps every concrete element in a Vue SFC's
 * `<template>` block with `data-desde-src="<file>:<line>:<col>"`. The
 * editor bridge reads this attribute at inspect time and surfaces
 * `editTarget` / `authoredAt` to the framework adapter; without them,
 * PropEdits and MoveEdits silently fail at the adapter ("edit requires
 * an editTarget").
 *
 * Implementation: AST-based via `@vue/compiler-sfc`'s parsed template.
 * Walks the AST collecting element nodes, computes an SFC-absolute
 * (line, column) from each node's `loc.start` (the parser already
 * reports SFC-absolute coordinates, including the column offset of
 * the first line — meaning `<template><div ...>` correctly reports
 * column 11+ for the `div`, not column 1).
 *
 * This replaces the regex-based stamping that shipped in the first
 * D-0 cut, which two failure modes:
 *   1. `[^>]*` for attribute matching truncated on `>` inside
 *      quoted attribute values (`title="a>b"`).
 *   2. The first-line column offset of `<template>` was dropped, so
 *      coordinates were SFC-relative on lines >1 but template-
 *      relative on line 1.
 *
 * The starter-kit's production plugin is still richer (better slot
 * handling, JSX-in-Vue support, custom directives). This is the
 * minimum-viable version that gets the smoke-test edit loop honest.
 */
export function sourceTagPlugin(opts: SourceTagPluginOptions): Plugin {
  // Resolved once at construction: the policy is immutable and `transform` runs
  // per module, per HMR round.
  const policy = resolveStampPolicy(opts)
  return {
    name: "@desde/editor-source-tag-plugin",
    enforce: "pre",
    transform(code, id) {
      // Strip Vite's query suffix BEFORE the extension check.
      //
      // Vite appends `?t=<timestamp>` to every HMR re-request (and
      // `?vue&type=script&lang.tsx` to SFC sub-blocks). Matching on the raw id
      // meant the plugin skipped all of them — so a Vue file kept its stamps
      // only until its FIRST hot update, then silently lost every one and the
      // Editor went inspect-only on it, refusing edits with "No source-location
      // ancestor" until a full page reload. Measured: 15 stamps for the bare
      // id, 0 for the same file with `?t=123`.
      //
      // `jsx-source-tag-plugin.ts` has carried this guard since it was written;
      // this plugin never got it.
      const cleanId = id.split("?")[0]
      if (!cleanId.endsWith(".vue")) return null

      // A BLOCK SUB-REQUEST IS NOT THE SFC — but it IS still stampable.
      //
      // `@vitejs/plugin-vue` re-requests each block of an SFC as its own module:
      // `App.vue?vue&type=style&index=0`, `?vue&type=script&setup=true&lang.tsx`,
      // `?vue&type=template`. `code` is then that BLOCK, not the file, and the
      // path still ends `.vue` once the query is stripped, so the check above
      // admits them.
      //
      // Stamping must NOT be skipped for them: a `<script lang="tsx">` block
      // arrives this way carrying JSX that `collectEmbeddedJsxInsertions` below
      // exists to stamp. An early return costs JSX-in-Vue every stamp it has —
      // pinned by `vue-script-jsx-stamping.test.ts`'s "stamps an SFC sub-block
      // request", which is exactly how an over-broad version of this guard was
      // caught before it shipped.
      //
      // What must be skipped is the REWRITE CLASSIFICATION below, which compares
      // `code` against the file at `cleanId`. On a sub-request that diffs a block
      // against the whole file and always concludes "rewritten", emitting the
      // warning that `data-desde-src` "may name the wrong element and edits to this
      // file may land in the wrong place". MEASURED: a 36-byte style block
      // compared against a 510-byte SFC, on a boot that was otherwise 9/9
      // correct. A false alarm on the one warning that means "your edits are
      // unsafe" is worse than no warning — it teaches the reader to ignore the
      // real one.
      const isBlockSubRequest = /[?&]vue&type=/.test(id)

      // "May this be stamped?" and "what path goes in the stamp?" answered by
      // ONE call, so a caller cannot check one and emit the other — see
      // `hosts/stamp-policy.ts`. This replaces a substring
      // `id.includes("/node_modules/")` test paired with a bare
      // `relative(opts.repoRoot, cleanId)`, which was wrong twice over: it
      // stamped any file OUTSIDE the repo that had no `node_modules` segment
      // (a linked or sibling first-party module) as `../outside-lib/Card.vue`,
      // which `resolve-editable-path.ts` then 400s as "File path escapes
      // prototype root" — a selectable element whose every edit fails; and it
      // relativised against the root as typed rather than the symlink-resolved
      // root Vite actually hands us ids from.
      //
      // `cleanId`, not `id`: a `?t=` in the stamp would make every coordinate
      // unmatchable, and a query on a `node_modules` path must still be denied.
      const filePath = stampPathFor(policy, cleanId)
      if (filePath === null) return null

      // DETECTION ONLY — deliberately not a refusal, and not a realignment.
      //
      // `enforce: "pre"` does not mean "first": Vite preserves array order
      // within a bucket and every host merges the repo's plugins ahead of ours,
      // so a repo plugin that is also `pre` transforms the module before we see
      // it. When that happens the coordinates below are computed from bytes
      // that are not the file on disk, and a stamp that names the wrong element
      // is the worst failure this product has (see `transform-input.ts` for the
      // measurement that produced this guard, and `realignJsxInsertions` in
      // `jsx-source-tag-plugin.ts` for the JSX lane's repair).
      //
      // The Vue lane gets the warning and NOT the repair, on evidence rather
      // than symmetry: the edit matrix drove all thirteen Vue-applicable edit
      // kinds through plain Vite, Nuxt and Astro on 2026-08-11 and every stamp
      // corroborated (20/20 on each), so no Vue pre-transform has ever been
      // observed. Refusing would risk turning three green lanes dark to defend
      // against a case that has not occurred; building a Vue realigner would
      // mean shipping a mechanism no fixture can red-prove. Saying it out loud
      // is what a future occurrence needs, and it is all the evidence supports.
      // If this ever fires, the JSX realigner is the pattern to follow.
      const input = isBlockSubRequest
        ? { kind: "as-authored" as const }
        : classifyTransformInput(code, cleanId)
      if (input.kind === "rewritten") {
        reportStampProblem(
          cleanId,
          {
            file: filePath,
            // NOT `inspect-only`: this file DOES stamp, and that is precisely
            // what makes it the quieter failure. `verifyStamping` sees stamps
            // and says "passed"; the coordinates inside them may still name the
            // wrong element.
            outcome: "coordinates-suspect",
            detail:
              "another Vite plugin rewrote it before Editor could stamp it, and the Vue lane has no realignment for that yet",
          },
          `[stamp] ${filePath} is transformed by another Vite plugin before Editor can stamp it. ` +
            "Coordinates are being read from the transformed source, so `data-desde-src` may name " +
            "the wrong element and edits to this file may land in the wrong place. Please report " +
            "this with the plugin's name. The Vue lane has no realignment for it yet.",
        )
      }

      const { descriptor, errors } = parse(code, { filename: id })
      if (errors.length > 0) return null
      if (!descriptor.template?.ast) return null
      // Vue's RootNode children type contains expression / text node
      // shapes we don't traverse into; cast through unknown to our
      // narrower walking type (we only inspect Element nodes anyway).
      const ast = descriptor.template.ast as unknown as { children?: VueTemplateNode[] }
      const sourceVersion = sourceVersionOf(code)
      // What Vue will do with THIS template's root — see analyzeTemplateRoots.
      // Drives both the `data-desde-own` emission (fallthroughRoots) and the
      // `inheritAttrs: false` suppression (definitelyFragment).
      const rootShape = analyzeTemplateRoots(ast.children)
      const insertions = collectInsertions(
        ast,
        filePath,
        sourceVersion,
        new Set(rootShape.fallthroughRoots),
      )

      // Fragment-rooted component: Vue CANNOT inherit our stamps onto a
      // root, and says so in the dev console, by name. See
      // fragmentInheritAttrsInsertion.
      if (rootShape.definitelyFragment) {
        const suppression = fragmentInheritAttrsInsertion(descriptor, code)
        if (suppression) insertions.push(suppression)
      }

      // ALSO stamp JSX in a `<script setup lang="tsx">` block.
      //
      // Such JSX was stamped by nobody: this plugin only walks the template
      // AST, and the JSX plugin bails on any id that is not `.tsx`/`.jsx`.
      // Measured on the dogfood Vue subject: 1 stamp in a
      // `<script setup lang="tsx">` component against 24 in a template-based
      // sibling — so the bridge could not map a click to source there and the
      // Editor was inspect-only, refusing every edit with "No source-location
      // ancestor".
      //
      // The block's `loc` is SFC-absolute (compiler-sfc reports the CONTENT's
      // position), which is exactly the two shifts the stamper needs.
      for (const block of [descriptor.scriptSetup, descriptor.script]) {
        const lang = block?.lang
        if (!block || (lang !== "tsx" && lang !== "jsx")) continue
        const startLine = block.loc?.start?.line
        const offsetShift = block.loc?.start?.offset
        if (typeof startLine !== "number" || typeof offsetShift !== "number") continue
        insertions.push(
          ...collectEmbeddedJsxInsertions({
            blockCode: block.content,
            filePath,
            sourceVersion,
            startLine,
            offsetShift,
            // A Vue SFC can render a routing outlet from a TSX render
            // function, not just from a template — and the fallthrough that
            // makes an outlet steal the routed page's stamp is a Vue runtime
            // behaviour, not a template-syntax one. Without this the template
            // path skips <NuxtPage> while the script path stamps it, and the
            // coordinate lands cross-file again.
            skipTags: TRANSPARENT_ROUTING_OUTLETS,
          }),
        )
      }

      if (insertions.length === 0) return null

      const updated = applyInsertions(code, insertions)
      if (updated === code) return null
      return { code: updated, map: null }
    },
  }
}

interface Insertion {
  /** Absolute offset within the SFC source. */
  offset: number
  /** String to insert at `offset`. */
  text: string
}

interface VueTemplateNode {
  type: number
  // ELEMENT (type=1) fields
  tag?: string
  tagType?: number
  props?: VueTemplateProp[]
  /** TEXT (type=2) / COMMENT (type=3) payload. */
  content?: string
  loc?: {
    start?: { line?: number; column?: number; offset?: number }
  }
  children?: VueTemplateNode[]
}

interface VueTemplateLoc {
  start?: { line?: number; column?: number; offset?: number }
  end?: { line?: number; column?: number; offset?: number }
}

interface VueTemplateProp {
  type?: number
  /** Directive name (e.g. "bind", "on", "model") for type-7 props; attr name for type-6. */
  name?: string
  /** Directive argument — for `:placeholder` this is the static expr `placeholder`. */
  arg?: { type?: number; content?: string; isStatic?: boolean }
  /** Directive expression — for `:placeholder="expr"` this is the simple expr `expr`. */
  exp?: { type?: number; content?: string; loc?: VueTemplateLoc }
  loc?: VueTemplateLoc
}

const NODE_TYPE_ELEMENT = 1
const NODE_TYPE_TEXT = 2
const NODE_TYPE_COMMENT = 3
const TAG_TYPE_ELEMENT = 0 // plain host element: <div>
const TAG_TYPE_SLOT = 2 // <slot>
const TAG_TYPE_TEMPLATE = 3
const PROP_TYPE_ATTRIBUTE = 6 // static attribute: <div data-desde-src="x">
const PROP_TYPE_DIRECTIVE = 7 // directive (incl. v-bind shorthand): <div :data-desde-src="x">
const NODE_TYPE_SIMPLE_EXPRESSION = 4

/**
 * True if this prop is the data-desde-src attribute in either form:
 *  - static `data-desde-src="…"` -> type 6, name "data-desde-src"
 *  - bound  `:data-desde-src="…"` -> type 7 (directive "bind"), arg.content "data-desde-src"
 */
function isExistingDataPtSrc(prop: VueTemplateProp): boolean {
  if (prop.type === PROP_TYPE_ATTRIBUTE && prop.name === "data-desde-src") return true
  if (
    prop.type === PROP_TYPE_DIRECTIVE &&
    prop.name === "bind" &&
    prop.arg?.type === NODE_TYPE_SIMPLE_EXPRESSION &&
    prop.arg.content === "data-desde-src"
  ) {
    return true
  }
  return false
}

/**
 * Transparent OUTLETS — tags that render an arbitrary component authored in
 * ANOTHER file and are never editable themselves. Keyed by lowercased tag name,
 * so both spellings of each (`<NuxtPage>` and `<nuxt-page>`) need an entry.
 *
 * WHY they must not be stamped: Vue's attribute fallthrough passes a
 * single-root child component's inherited attrs — including this stamp — down
 * to that component's ROOT element, OVERRIDING the root's own `data-desde-src`.
 * The routed page's root then attributes to the outlet's callsite (e.g.
 * `app.vue`) instead of the page's own file, and the deterministic applicator
 * writes the edit onto the outlet tag: wrong file, wrong element. Leaving the
 * outlet unstamped lets the routed root keep its own stamp.
 *
 * Membership is decided by reading each framework's source, not by name:
 *   `router-view` (vue-router) — `inheritAttrs: false`, then explicitly
 *      `assign({}, routeProps, attrs)` onto the routed component.
 *   `nuxt-page` (Nuxt 4) — `inheritAttrs: false`, then
 *      `h(RouterView, { name, route, ...attrs })`: the leak above, one hop
 *      later. MEASURED live on Nuxt 4.5.2 — `pages/index.vue`'s own
 *      `<main class="page-root">` carried `app.vue:4:5`, and an `id` edit
 *      landed on `<NuxtPage id="…" />` in `app.vue`.
 *   `nuxt-layout` (Nuxt 4) — `inheritAttrs: false`, then
 *      `mergeProps(context.attrs, …)` → LayoutProvider → LayoutLoader →
 *      `h(layouts[name], layoutProps)`, so `layouts/default.vue`'s root takes
 *      `app.vue`'s coordinate. Same defect, one more file.
 *
 * DELIBERATELY ABSENT — each was checked and does NOT have the defect:
 *   `<slot>` — attributes on a slot outlet are SLOT PROPS, not fallthrough
 *      attrs; they never reach the DOM. A stamped `<slot>` produced no
 *      `data-desde-src` anywhere in the rendered output.
 *   `<DevOnly>`, `<NuxtErrorBoundary>` — `inheritAttrs: false` and they forward
 *      nothing, so the stamp is simply dropped and the child keeps its own.
 *   `<NuxtLink>`, `<NuxtLoadingIndicator>`, VitePress `<Content>`, Ionic's
 *      `<ion-router-outlet>` — each renders a real DOM element of its own as
 *      the single root, so the stamp lands on that element, which is correct.
 *      (Ionic mounts routed views as CHILDREN of the outlet element and passes
 *      them none of its attrs.) Skipping these would break editing a tag the
 *      user CAN click — over-skipping is its own bug.
 *   Nuxt 2's `<Nuxt>` / `<NuxtChild>` — genuine outlets, but unreachable: this
 *      is a Vite `transform` hook and Nuxt 2 is webpack. `<Nuxt>` is also
 *      generic enough that blanket-skipping it would silently un-stamp a
 *      user's own component of that name.
 *
 * STILL UNCOVERED, knowingly: same-FILE transparent wrappers — `<component
 * :is>`, KeepAlive/Transition, and Nuxt's `<ClientOnly>` (it does
 * `cloneVNode(child, attrs)`, so the child's root takes the wrapper's line).
 * Those mis-attribute by a line WITHIN the file the user selected, not by
 * file, and a name list is the wrong instrument for them — they need
 * fallthrough-aware attribution. This list covers the cross-file case, where
 * the edit lands in a file the user never opened.
 */
const TRANSPARENT_ROUTING_OUTLETS = new Set([
  "router-view",
  "routerview",
  "nuxt-page",
  "nuxtpage",
  "nuxt-layout",
  "nuxtlayout",
])

/**
 * Second, NON-COLLIDING stamp carrying an element's OWN coordinate.
 *
 * WHY IT EXISTS. Vue hands a single-root child component's inherited attrs
 * to that component's ROOT element, and a fallthrough attr WINS over an
 * attr of the same name already on that element (`renderComponentRoot` →
 * `cloneVNode(root, fallthroughAttrs)` → `mergeProps`, fallthrough last).
 * So `<FloatingConfigurator/>`'s `data-desde-src="Login.vue:11:5"` lands on
 * `FloatingConfigurator.vue`'s own root `<div>` and OVERWRITES that div's
 * `data-desde-src="FloatingConfigurator.vue:9:5"`. Every single-root child
 * component in the project mis-attributes its own root to the parent's
 * callsite — a click resolves to a component tag with nothing editable
 * instead of to the component's own file. (MEASURED on the sakai-vue
 * substrate: the div reported `src/views/pages/auth/Login.vue:11:5`.)
 *
 * TRANSPARENT_ROUTING_OUTLETS below is the same defect handled by a name
 * list, which by construction only ever covers the outlets someone thought
 * to name. This is the general fix: the collision is *between two stamps
 * sharing one attribute name*, so the child publishes its own coordinate
 * under a name the parent never writes onto a component tag, and the
 * bridge prefers it (`src/bridge/element-attribution.ts`). Where nothing
 * polluted the element, `data-desde-own` and `data-desde-src` are byte-identical
 * — they describe the same AST node — so preferring it is a no-op except
 * exactly where fallthrough overwrote the truth.
 *
 * WHERE IT IS EMITTED. Only on a template's fallthrough-eligible ROOT, and
 * only when that root is a HOST element:
 *   · Host root (the common case) — a DOM element; nothing inherits FROM
 *     it, so the value survives.
 *   · COMPONENT root (`<template><KButton/></template>`) — DELIBERATELY
 *     SKIPPED. A `data-desde-own` written on a component tag would fall
 *     through to *that* component's root and overwrite ITS `data-desde-own`,
 *     rebuilding the identical collision one level down. Nothing is lost:
 *     the grandchild keeps its own, and the wrapper's callsite is still
 *     reachable through the vnode-props stamp.
 *   · Fragment / multi-root — no fallthrough happens at all, so the roots
 *     were never polluted and the extra attribute would be pure noise.
 * Non-root elements need it for the same reason: nothing can overwrite
 * their `data-desde-src`.
 *
 * VALUE FORMAT. `"<file>:<line>:<col> <sourceVersion>"` — the same
 * loc + space + payload convention as `data-desde-bind:<prop>` (split on the
 * LAST space; only the file portion can contain one). The version has to
 * ride along because the sibling `data-desde-v` on a polluted root is the
 * PARENT's version — pairing the child's coordinates with it would defeat
 * the server's stale-target guard.
 */
const OWN_STAMP_DELIM = " "

/**
 * What Vue's compiled render will do with this template's root, decided
 * from the parse AST. Two consumers, two questions:
 *
 *  · `fallthroughRoots` — which root node(s) receive the parent's
 *    fallthrough attrs, i.e. which need a `data-desde-own` rescue stamp. A
 *    `v-if` / `v-else-if` / `v-else` chain is ONE root to the compiler, so
 *    every branch qualifies (whichever renders is the root that day).
 *  · `definitelyFragment` — proof that no root can ever inherit. Used to
 *    suppress Vue's console warning, so it must be certain: anything the
 *    parse AST can't settle cheaply reports `false` and we leave the SFC
 *    alone. A false positive would silently stop the user's own `class` /
 *    `style` fallthrough; a false negative only leaves a console warning.
 *
 * Comments are filtered out because Vue filters them too: a single element
 * beside a comment compiles to a DEV_ROOT_FRAGMENT and `getChildRoot`
 * unwraps it back to the element, so fallthrough still lands.
 */
interface TemplateRootShape {
  fallthroughRoots: VueTemplateNode[]
  definitelyFragment: boolean
}

function analyzeTemplateRoots(children: VueTemplateNode[] | undefined): TemplateRootShape {
  const significant = (children ?? []).filter((n) => {
    if (!n || n.type === NODE_TYPE_COMMENT) return false
    if (n.type === NODE_TYPE_TEXT) return (n.content ?? "").trim().length > 0
    return true
  })
  const none: TemplateRootShape = { fallthroughRoots: [], definitelyFragment: false }
  // Empty template renders a Comment root, which Vue explicitly excludes
  // from the warning (`root.type !== Comment`).
  if (significant.length === 0) return none

  if (significant.length === 1) {
    const only = significant[0]
    // A text / interpolation root IS the "text root" the warning names.
    if (only.type !== NODE_TYPE_ELEMENT) return { fallthroughRoots: [], definitelyFragment: true }
    // `<slot>` and a root `v-for` both render a Fragment.
    if (only.tagType === TAG_TYPE_SLOT) return { fallthroughRoots: [], definitelyFragment: true }
    if (hasDirective(only, "for")) return { fallthroughRoots: [], definitelyFragment: true }
    // `<template>` root: with `v-if` it collapses to its branch, bare it
    // renders its children as a fragment. Not worth settling — claim neither.
    if (only.tagType === TAG_TYPE_TEMPLATE) return none
    return { fallthroughRoots: [only], definitelyFragment: false }
  }

  // More than one significant root. A conditional chain is still ONE root.
  if (isConditionalChain(significant)) {
    return {
      fallthroughRoots: significant.filter(
        (n) => n.tagType !== TAG_TYPE_TEMPLATE && !hasDirective(n, "for"),
      ),
      definitelyFragment: false,
    }
  }
  return { fallthroughRoots: [], definitelyFragment: true }
}

/** True when `nodes` is a `v-if` → (`v-else-if`)* → (`v-else`)? element chain. */
function isConditionalChain(nodes: VueTemplateNode[]): boolean {
  if (nodes.length < 2) return false
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type !== NODE_TYPE_ELEMENT) return false
    const ok =
      i === 0
        ? hasDirective(n, "if")
        : hasDirective(n, "else-if") || hasDirective(n, "else")
    if (!ok) return false
  }
  return true
}

function hasDirective(node: VueTemplateNode, name: string): boolean {
  return !!node.props?.some((p) => p?.type === PROP_TYPE_DIRECTIVE && p.name === name)
}

/**
 * Suppress Vue's dev warning for a component we PROVED renders a fragment
 * (or text) root:
 *
 *   [Vue warn]: Extraneous non-props attributes (data-desde-v, data-desde-src)
 *   were passed to component but could not be automatically inherited
 *   because component renders fragment or text or teleport root nodes.
 *
 * That fires unconditionally in dev, on every load, naming OUR attributes
 * in the user's console — MEASURED on the sakai-vue substrate at
 * `<StatsWidget>` (4 sibling root divs) and `<TopbarWidget>`. We cannot
 * stop stamping the component tag to avoid it: the tag's stamp is read off
 * the component vnode's props (`getCallSiteStamp`), which is how the
 * bridge knows any component's callsite, fragment-rooted or not.
 *
 * `inheritAttrs: false` is the exact statement of what is already true —
 * Vue's own guard is `if (fallthroughAttrs && inheritAttrs !== false)`, so
 * setting it skips the whole inherit-or-warn block. For a component that
 * genuinely renders a fragment, automatic inheritance was impossible
 * anyway, so this is a semantic no-op: `$attrs` / `useAttrs()` /
 * `v-bind="$attrs"` are untouched. That is why `analyzeTemplateRoots` only
 * reports `definitelyFragment` when it is sure.
 *
 * Delivered as a sibling normal `<script>` block, which is the documented
 * way to declare `inheritAttrs` next to `<script setup>` — no
 * `defineOptions` (Vue 3.3+ only) and no surgery inside the user's code.
 *
 * NOT ATTEMPTED, knowingly — each leaves the warning in place rather than
 * risk breaking the build:
 *   · SFC already has a normal `<script>` — merging `inheritAttrs` into an
 *     arbitrary `export default` (object literal? `defineComponent(...)`?
 *     a re-exported identifier?) is string surgery on user code.
 *   · `<script setup>` calls `defineOptions` — a second one is a compile
 *     error, and compiler-sfc rejects `defineOptions` alongside a normal
 *     `<script>` default export.
 *   · Non-alphanumeric `lang` — `<script>` and `<script setup>` must
 *     declare the SAME language, and we will not build that attribute out
 *     of an unvalidated string.
 *
 * Idempotent for free: the block we add IS a normal `<script>`, so a
 * re-transform of already-stamped output takes the first bail-out above.
 */
function fragmentInheritAttrsInsertion(
  descriptor: { script?: { lang?: string } | null; scriptSetup?: { lang?: string; content?: string } | null },
  code: string,
): Insertion | null {
  if (descriptor.script) return null
  const setup = descriptor.scriptSetup
  if (setup && /\bdefineOptions\s*\(/.test(setup.content ?? "")) return null
  const lang = setup?.lang
  if (lang !== undefined && !/^[A-Za-z0-9]+$/.test(lang)) return null
  const langAttr = lang ? ` lang="${lang}"` : ""
  return {
    offset: code.length,
    text: `\n<script${langAttr}>\nexport default { inheritAttrs: false }\n</script>\n`,
  }
}

/** Walk the template AST collecting one Insertion per concrete element. */
function collectInsertions(
  ast: { children?: VueTemplateNode[] },
  filePath: string,
  sourceVersion: string,
  fallthroughRoots: Set<VueTemplateNode>,
): Insertion[] {
  const out: Insertion[] = []
  walkChildren(ast.children, (node) => {
    if (node.type !== NODE_TYPE_ELEMENT) return
    if (node.tagType === TAG_TYPE_TEMPLATE) return
    if (!node.tag || !node.loc?.start) return

    // Skip transparent routing outlets — see TRANSPARENT_ROUTING_OUTLETS for
    // the fallthrough mechanism, the evidence behind each member, and the
    // wrappers deliberately left out.
    if (TRANSPARENT_ROUTING_OUTLETS.has(node.tag.toLowerCase())) return

    // Skip if data-desde-src is already present (idempotent re-runs). Check
    // both the static form and the v-bind shorthand `:data-desde-src` —
    // the latter stores the attribute key in `prop.arg.content`, not
    // `prop.name`, so a single name-only check would miss it and
    // produce a duplicate stamp on a re-transform.
    const existing = node.props?.some((p) => p && isExistingDataPtSrc(p))
    if (existing) return

    const startOffset = node.loc.start.offset
    const startLine = node.loc.start.line
    const startCol = node.loc.start.column
    if (
      typeof startOffset !== "number" ||
      typeof startLine !== "number" ||
      typeof startCol !== "number"
    ) {
      return
    }

    // Insertion point: right after the tag-name. Vue's compiler reports
    // loc.start.offset at the `<` of the opening tag; tag-name follows
    // immediately, so injection at offset + 1 + tag.length lands between
    // the tag-name and the next character (a space, newline, `>` or `/>`).
    const injectAt = startOffset + 1 + node.tag.length
    const stampValue = `${filePath}:${startLine}:${startCol}`

    // NOTE on ordering: every stamp for this element injects at the SAME
    // offset, and `applyInsertions` splices descending — so among equal
    // offsets each later push lands to the LEFT of the earlier ones, i.e.
    // the rendered attribute order is the REVERSE of the push order below.
    // Pushing `data-desde-own` first therefore parks it rightmost and keeps
    // `data-desde-v` leftmost, which is what the existing output (and the
    // tests that scan for `<tag data-desde-v=`) already assume. Cosmetic —
    // but a silent re-order shows up as a test failure two files away.

    // Fallthrough-proof duplicate of the two stamps below, on the ONE
    // element a parent's fallthrough can overwrite — see OWN_STAMP_DELIM.
    // Host elements only: on a component tag this would fall through and
    // collide all over again.
    if (fallthroughRoots.has(node) && node.tagType === TAG_TYPE_ELEMENT) {
      out.push({
        offset: injectAt,
        text: ` data-desde-own=${JSON.stringify(
          `${stampValue}${OWN_STAMP_DELIM}${sourceVersion}`,
        )}`,
      })
    }

    out.push({
      offset: injectAt,
      text: ` data-desde-src=${JSON.stringify(stampValue)}`,
    })
    // Sibling per-file version stamp — see sourceVersionOf. Same offset as
    // data-desde-src (order among same-offset insertions is cosmetic).
    out.push({
      offset: injectAt,
      text: ` data-desde-v=${JSON.stringify(sourceVersion)}`,
    })

    // Layer-0 bind stamps (Phase 2c): for every static-named `:prop="expr"`
    // binding on this tag, emit a sibling `data-desde-bind:<prop>` attribute
    // encoding the bound expression's source loc AND its raw text. The
    // shell-side attribution reads these off the consumer's vnode props to
    // route a binding-to-simple-identifier to `cross-file: ref` instead of
    // the LLM lane. All bind stamps for this element inject at the SAME
    // offset (right after the tag-name, before data-desde-src's text); since
    // applyInsertions splices descending-by-offset, same-offset insertions
    // preserve push order, so data-desde-src lands closest to the tag-name and
    // the bind stamps follow it — order is cosmetic, both are valid attrs.
    for (const bind of collectBindStamps(node, filePath)) {
      out.push({ offset: injectAt, text: bind })
    }
  })
  return out
}

/**
 * Delimiter between the `file:line:col` loc and the base64-encoded
 * expression inside a `data-desde-bind:<prop>` value. The line, column,
 * and base64 payload never contain a space — only the FILE portion can
 * (a path like `ui drafts/Foo.vue`). So the delimiter is unambiguously
 * the LAST space in the value: decoders must split on `lastIndexOf(' ')`
 * (NOT the first space) to keep paths-with-spaces intact. The base64
 * encoding then lets the expression carry colons, quotes, and operators
 * without escaping ambiguity.
 */
const BIND_STAMP_DELIM = " "

/**
 * Collect `data-desde-bind:<prop>` insertion text for each eligible bound
 * prop on `node`. Eligible = a static-named v-bind directive whose
 * expression is present (`:prop="expr"` / `v-bind:prop="expr"`).
 *
 * Deliberately SKIPPED (these stay on the LLM lane):
 *   - event handlers (`@click` / `v-on:click`)  — directive name "on"
 *   - `v-model`                                  — directive name "model"
 *   - v-bind spread (`v-bind="obj"`)             — no `arg`
 *   - dynamic-key bind (`:[name]="x"`)           — `arg.isStatic === false`
 *   - any other directive (`v-if`, `v-for`, …)   — not name "bind"
 *
 * Idempotent: re-running over an already-stamped element is a no-op
 * because the emitted `data-desde-bind:<prop>` shows up as a static
 * attribute (type 6) on the re-parse, which `arg`-based detection
 * never matches as a bindable directive.
 *
 * Encoding: `data-desde-bind:<prop>="<file>:<line>:<col> <base64(expr)>"`.
 * The loc is the bound EXPRESSION's start position (where `expr` is
 * written in source), matching the `data-desde-src` "file:line:col"
 * convention so the bridge reuses the same loc parser (the file is the
 * consumer's SFC — the binding text lives in the same template the tag
 * does). The expression is base64-encoded so colons, quotes, and
 * operators survive the HTML attribute + the loc/expr split without
 * escaping ambiguity.
 */
function collectBindStamps(node: VueTemplateNode, filePath: string): string[] {
  if (!node.props) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const prop of node.props) {
    if (!isStaticBindDirective(prop)) continue
    const propName = prop.arg?.content
    const expr = prop.exp?.content
    const exprStart = prop.exp?.loc?.start
    if (!propName || expr === undefined) continue
    if (
      typeof exprStart?.line !== "number" ||
      typeof exprStart?.column !== "number"
    ) {
      continue
    }
    // Guard against duplicate prop names on the same tag (invalid SFC,
    // but be defensive): first wins, matching Vue's own resolution.
    if (seen.has(propName)) continue
    seen.add(propName)

    const encodedExpr = Buffer.from(expr, "utf8").toString("base64")
    const stampValue = `${filePath}:${exprStart.line}:${exprStart.column}${BIND_STAMP_DELIM}${encodedExpr}`
    out.push(` data-desde-bind:${propName}=${JSON.stringify(stampValue)}`)
  }
  return out
}

/**
 * True for a static-named v-bind directive (`:prop="x"` /
 * `v-bind:prop="x"`) — the only shape we stamp. Rejects v-on,
 * v-model, spread binds, and dynamic-key binds (see collectBindStamps).
 */
function isStaticBindDirective(prop: VueTemplateProp): boolean {
  if (prop.type !== PROP_TYPE_DIRECTIVE) return false
  if (prop.name !== "bind") return false
  // Skip the source-stamp attrs themselves if they ever arrive as binds.
  if (prop.arg?.content === "data-desde-src") return false
  if (typeof prop.arg?.content === "string" && prop.arg.content.startsWith("data-desde-bind")) {
    return false
  }
  // Static arg required: `:[dynamic]` has isStatic === false; spread
  // `v-bind="obj"` has no arg at all.
  if (prop.arg?.type !== NODE_TYPE_SIMPLE_EXPRESSION) return false
  if (prop.arg.isStatic === false) return false
  // Expression must be a simple/compound expression node (type 4).
  if (prop.exp?.type !== NODE_TYPE_SIMPLE_EXPRESSION) return false
  return true
}

function walkChildren(
  children: VueTemplateNode[] | undefined,
  visit: (node: VueTemplateNode) => void,
): void {
  if (!children) return
  for (const child of children) {
    visit(child)
    walkChildren(child.children, visit)
  }
}

/**
 * Apply a list of insertions to source. Insertions are sorted in
 * descending offset order before splicing so each splice doesn't
 * shift the offsets of insertions that haven't been applied yet.
 */
function applyInsertions(source: string, insertions: Insertion[]): string {
  const sorted = [...insertions].sort((a, b) => b.offset - a.offset)
  let out = source
  for (const ins of sorted) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset)
  }
  return out
}
