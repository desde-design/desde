/**
 * Pure (filesystem-free) component-detach applicator. Inlines a
 * component's `<template>` at its call site in a consumer SFC, with prop
 * substitution and slot splicing. The Figma "Detach instance" operation,
 * code-native.
 *
 * Inputs are two SFC sources (consumer + component) plus the call-site
 * source location. Output is the rewritten consumer source. The component
 * SFC is read-only — other usages of the component are unaffected.
 *
 * # Refusals (V1 scope is intentionally narrow)
 *
 * The applicator refuses cases where naive inlining would silently break
 * behavior or produce incorrect markup:
 *
 *  - The inlined template would reference an identifier that does not
 *    resolve in the consumer's scope (see "The scope guard" below). This is
 *    the general case that subsumes reactive state, composable returns,
 *    imported helpers, and plain consts.
 *  - Component uses scoped slot props (`<template #default="{ item }">`).
 *  - Component has lifecycle hooks (`onMounted`, etc.) — they wouldn't
 *    fire after detach since there's no longer a component instance.
 *  - Component template has multiple root elements (Vue 3 fragments).
 *  - Component has no `<template>` block (pure JS render).
 *
 * Each refusal carries a specific `reason` so the UI can explain why.
 *
 * # The scope guard
 *
 * Detach moves markup into a DIFFERENT component instance, so an expression
 * that resolved against the component's own scope has to resolve against the
 * consumer's afterwards. When it can't, Vue does not fail the build — it
 * renders `undefined` and logs `Property "x" was accessed during render but
 * is not defined on instance`, which is exactly the shape of failure this
 * applicator must never produce: a silent break reported as `ok: true`.
 *
 * The guard is therefore a REFERENCE check, not a declaration check. It
 * compares the free-identifier set of the consumer template before and after
 * the splice (`template-free-identifiers.ts`) and refuses when the splice
 * introduces a name that the consumer's own template, script bindings, or
 * the app's global properties don't supply. Two properties make that the
 * right shape:
 *
 *  - It runs on the OUTPUT, so prop substitution is accounted for for free.
 *    `:variant="variant"` rewritten to the call site's `:variant="kind"`
 *    resolves (`kind` is a consumer binding); a `{{ variant }}` the rewriter
 *    did not reach does not, and is caught.
 *  - It doesn't care HOW the identifier came to exist. The predecessor
 *    matched reactivity factory calls (`/\b(ref|computed|reactive|…)\s*\(/`)
 *    over the component's `<script setup>`, which let the single most common
 *    real-world shape straight through — `const { a, b } = useThing()`
 *    matches no factory name — along with imports, plain consts, and
 *    destructured `defineProps`. Measured against primefaces/sakai-vue and
 *    nuxt-ui-templates/dashboard, both detached "successfully" and broke.
 *
 * Consumer slot content spliced into the output cancels out of the diff
 * (those identifiers are present on both sides), so the guard does not
 * penalise the consumer for its own bindings.
 *
 * Known bound: because "already referenced by the consumer template" counts
 * as resolvable, a NAME COLLISION slips through — component-internal `count`
 * inlined into a consumer that also has a `count` renders the consumer's
 * value instead of nothing. That is deliberately not chased. Closing it means
 * flagging every identifier that is also a component script binding, which
 * cannot be distinguished from the consumer's own slot content referencing a
 * same-named binding, so it buys a speculative fix with a real false-refusal
 * class. Measured over 444 detachable call sites in three real Vue repos
 * (sakai-vue, nuxt-ui dashboard, ai-gateway-prototype): 0 of the sites that
 * still detach hit the collision. Revisit if one is ever observed.
 *
 * # What gets inlined (V1)
 *
 *  1. The component's template root, with:
 *     - `v-bind` of props rewritten to literal call-site values when the
 *       call site supplied a static string/number/boolean attribute.
 *     - `v-bind` of props rewritten to the call-site's dynamic expression
 *       when the call site used `:prop="someRef"` (preserves reactivity
 *       in the consumer's scope).
 *     - Default-valued props from the manifest used when the call site
 *       didn't specify them.
 *  2. Each `<slot>` / `<slot name="X">` in the component template is
 *     replaced with the consumer's matching `<template #X>` (or default-
 *     slot fallback). Default-slot content from the call site replaces
 *     the default `<slot/>`.
 *  3. The component's `<style scoped>` rules are appended to the
 *     consumer's `<style scoped>` block (or a new one is created),
 *     marked with an origin comment.
 *  4. Sub-component imports referenced inside the inlined template
 *     (e.g. `<KIcon>`) are added to the consumer's `<script setup>`
 *     imports if not already present.
 */

import { parse as parseSfc, compileScript, type SFCDescriptor } from '@vue/compiler-sfc'
import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import { resolveTemplateTarget } from './resolve-template-target'
import {
  collectFreeIdentifiers,
  isAppGlobalIdentifier,
  isInstanceScopedIdentifier,
  INSTANCE_SCOPED_IDENTIFIERS,
} from './template-free-identifiers'

export interface ApplyDetachEditInput {
  /** Full source of the consumer SFC (the file that uses the component). */
  consumerSource: string
  /** Full source of the component SFC being detached. */
  componentSource: string
  /** Component file path — used only for the origin comment in copied styles. */
  componentFile: string
  /** Component name (e.g. `ProtoCatalogCard`). */
  componentName: string
  /** Call-site location within the consumer SFC — 1-based SFC-absolute. */
  callSiteLine: number
  callSiteColumn: number
}

export type ApplyDetachEditResult =
  | { ok: true; source: string; warnings: string[] }
  | { ok: false; reason: string }

interface AttributePropLike {
  type: typeof NodeTypes.ATTRIBUTE
  name: string
  value?: { content: string }
  loc: { start: { offset: number }; end: { offset: number }; source: string }
}

interface DirectivePropLike {
  type: typeof NodeTypes.DIRECTIVE
  name: string
  arg?: { content: string } | null
  exp?: { content: string } | null
  loc: { start: { offset: number }; end: { offset: number }; source: string }
}

type PropLike = AttributePropLike | DirectivePropLike

interface ElementLike {
  type: number
  tag: string
  loc: { start: { line: number; column: number; offset: number }; end: { offset: number }; source: string }
  props: PropLike[]
  children: ElementLike[]
  isSelfClosing: boolean
}

export function applyDetachEdit(input: ApplyDetachEditInput): ApplyDetachEditResult {
  const {
    consumerSource,
    componentSource,
    componentFile,
    componentName,
    callSiteLine,
    callSiteColumn,
  } = input

  // 1. Parse both SFCs.
  let consumerDescriptor: SFCDescriptor
  let componentDescriptor: SFCDescriptor
  try {
    consumerDescriptor = parseSfc(consumerSource).descriptor
  } catch (err) {
    return { ok: false, reason: `Consumer SFC parse failed: ${(err as Error).message}` }
  }
  try {
    componentDescriptor = parseSfc(componentSource).descriptor
  } catch (err) {
    return { ok: false, reason: `Component SFC parse failed: ${(err as Error).message}` }
  }
  if (!consumerDescriptor.template) {
    return { ok: false, reason: 'Consumer SFC has no <template> block' }
  }
  if (!componentDescriptor.template) {
    return {
      ok: false,
      reason: `Component "${componentName}" has no <template> block: pure JS render components can't be detached`,
    }
  }

  // 2. Refusal checks against the component (script-setup, lifecycle, emits,
  //    scoped-slot bindings).
  const refusal = refuseUnsafeComponent(componentDescriptor, componentName)
  if (refusal) return { ok: false, reason: refusal }

  // 3. Parse component template — must have exactly one root element.
  //    Done BEFORE the consumer call-site lookup so multi-root and
  //    pure-JS-render refusals don't get masked by a "no call-site found"
  //    error when the test consumer happens not to contain the component.
  let componentAst
  try {
    componentAst = parseTemplate(componentDescriptor.template.content)
  } catch (err) {
    return { ok: false, reason: `Component template parse failed: ${(err as Error).message}` }
  }
  const componentRoots = (componentAst.children as ElementLike[]).filter(
    (c) => c.type === NodeTypes.ELEMENT,
  )
  if (componentRoots.length === 0) {
    return { ok: false, reason: `Component "${componentName}" template is empty` }
  }
  if (componentRoots.length > 1) {
    return {
      ok: false,
      reason: `Component "${componentName}" has multiple template roots (Vue 3 fragments): V1 detach requires a single root element`,
    }
  }

  // 4. Find the consumer's call-site element by source location via the
  //    shared resolver. The consumer SFC parse / template presence were
  //    already validated in step 1 (that ordering is load-bearing — see the
  //    step-3 comment), so only the template-parse and not-found failures
  //    are reachable here; map them to this applicator's historical
  //    "Consumer …" reason strings.
  const resolved = resolveTemplateTarget({
    source: consumerSource,
    line: callSiteLine,
    column: callSiteColumn,
  })
  if (!resolved.ok) {
    const f = resolved.failure
    if (f.kind === 'template-parse-error') {
      return {
        ok: false,
        reason: f.reason.replace(/^Template parse failed: /, 'Consumer template parse failed: '),
      }
    }
    if (f.kind === 'not-found') {
      return {
        ok: false,
        reason: `No call-site element found at consumer line ${callSiteLine}, column ${callSiteColumn}`,
      }
    }
    return { ok: false, reason: f.reason }
  }
  const callSite = resolved.node as unknown as ElementLike
  const consumerTemplateOffset = resolved.ctx.templateOffset
  // Verify the call-site element is actually the requested component. Vue
  // accepts both PascalCase and kebab-case in templates, so check both.
  const expectedKebab = pascalToKebab(componentName)
  if (callSite.tag !== componentName && callSite.tag !== expectedKebab) {
    return {
      ok: false,
      reason: `Element at line ${callSiteLine}, column ${callSiteColumn} is <${callSite.tag}>, not <${componentName}>; refusing to detach a different element`,
    }
  }

  // 5a. Refuse components whose template contains slot fallbacks. Naive
  //     regex-based slot replacement would strip them; AST-based slot
  //     replacement is V2 work.
  const slotWithFallback = findSlotWithFallback(componentRoots[0])
  if (slotWithFallback) {
    return {
      ok: false,
      reason: `Component "${componentName}" has a <slot> with fallback content; V1 detach requires empty self-closing <slot/> elements`,
    }
  }

  // 5b. Extract call-site props (static + dynamic) and slot content.
  const callSiteProps = extractCallSiteProps(callSite)
  const slotContents = extractSlotContents(callSite, consumerSource, consumerTemplateOffset)

  // 5c. Refuse components whose template references prop names inside
  //     non-trivial directive expressions or interpolations (anything other
  //     than a bare identifier). Regex substitution can't safely rewrite
  //     `:class="'btn btn--' + variant"` and similar; V2 needs a real JS
  //     expression AST.
  const propNamesUsed = new Set<string>([...callSiteProps.keys()])
  const complexUse = findComplexPropExpression(componentRoots[0], propNamesUsed)
  if (complexUse) {
    return {
      ok: false,
      reason: `Component "${componentName}" template references prop "${complexUse}" inside a non-trivial expression; V1 detach only handles bare prop references`,
    }
  }

  // 5d. Refuse components with relative sub-component imports. Copying
  //     `import KIcon from './KIcon.vue'` verbatim into the consumer would
  //     resolve from the consumer's directory, silently pointing at the
  //     wrong file (or nothing). V2 needs path rewriting.
  const subComponents = collectSubComponentTags(componentRoots[0])
  const badImport = findRelativeSubComponentImport(componentDescriptor, subComponents)
  if (badImport) {
    return {
      ok: false,
      reason: `Component "${componentName}" imports sub-component <${badImport}> via a relative path; V1 detach refuses these (the import would resolve from the wrong directory after inlining)`,
    }
  }

  // 6. Render the inlined template — substitute props, splice slots.
  const componentRoot = componentRoots[0]
  const componentTemplateContent = componentDescriptor.template.content
  const inlined = renderInlined({
    componentRoot,
    componentTemplateContent,
    callSiteProps,
    slotContents,
  })
  if (!inlined.ok) return { ok: false, reason: inlined.reason }

  // 7. Compute all source mutations as (start, end, replacement) ops keyed
  //    off the ORIGINAL consumer source's offsets, then apply them sorted
  //    by `start` descending so earlier offsets aren't disturbed by later
  //    splices. Naive sequential splicing breaks `mergeImports`'s
  //    `scriptSetup.loc.start.offset` because the template splice may have
  //    already shifted that offset by ±Δ when the script comes after the
  //    template in source order.
  const ops: Array<{ start: number; end: number; replacement: string }> = []

  // Template splice (always present).
  const callSiteStart = consumerTemplateOffset + callSite.loc.start.offset
  const callSiteEnd = consumerTemplateOffset + callSite.loc.end.offset
  ops.push({ start: callSiteStart, end: callSiteEnd, replacement: inlined.markup })

  // Style merge — append component's <style> blocks at end of any existing
  // consumer scoped style, or as a new block at end of file.
  if (componentDescriptor.styles.length > 0) {
    const styleOp = computeStyleMergeOp(consumerSource, componentDescriptor, componentFile)
    if (styleOp) ops.push(styleOp)
  }

  // Sub-component imports — insert at top of consumer's script-setup
  // content (or refuse already-handled relative imports).
  if (subComponents.size > 0) {
    const importOp = computeImportMergeOp(
      consumerSource,
      componentDescriptor,
      consumerDescriptor,
      subComponents,
    )
    if (importOp) ops.push(importOp)
  }

  // Apply ops highest-offset first so earlier offsets stay valid.
  ops.sort((a, b) => b.start - a.start)
  let newConsumerSource = consumerSource
  for (const op of ops) {
    newConsumerSource =
      newConsumerSource.slice(0, op.start) +
      op.replacement +
      newConsumerSource.slice(op.end)
  }

  // 10. Post-splice parse check — the inlined markup might still violate
  //     the consumer's syntax (e.g., duplicate root elements where the
  //     consumer doesn't expect them).
  const after = reparseAfterSplice(newConsumerSource)
  if (!after.ok) return { ok: false, reason: after.reason }

  // 11. Scope check — the markup parses, but does every identifier it now
  //     references still resolve? Runs LAST because it needs the actual
  //     post-substitution output, not the component template we started
  //     from. See "The scope guard" in the module header.
  const unresolved = refuseUnresolvedIdentifiers({
    componentName,
    beforeTemplate: consumerDescriptor.template.content,
    afterTemplate: after.templateContent,
    afterDescriptor: after.descriptor,
    componentDescriptor,
    typescript:
      descriptorUsesTypeScript(consumerDescriptor) ||
      descriptorUsesTypeScript(componentDescriptor),
  })
  if (unresolved) return { ok: false, reason: unresolved }

  return { ok: true, source: newConsumerSource, warnings: inlined.warnings }
}

function reparseAfterSplice(
  source: string,
):
  | { ok: true; descriptor: SFCDescriptor; templateContent: string }
  | { ok: false; reason: string } {
  try {
    const descriptor = parseSfc(source).descriptor
    if (!descriptor.template) {
      return { ok: false, reason: 'Post-splice consumer lost its <template> block' }
    }
    parseTemplate(descriptor.template.content)
    return { ok: true, descriptor, templateContent: descriptor.template.content }
  } catch (err) {
    return {
      ok: false,
      reason: `Post-splice consumer template parse failed: ${(err as Error).message}`,
    }
  }
}

// ─────────────────────────── Refusal checks ───────────────────────────

function refuseUnsafeComponent(
  descriptor: SFCDescriptor,
  name: string,
): string | null {
  const setup = descriptor.scriptSetup
  if (setup) {
    const content = setup.content
    // NOTE: there is deliberately no reactivity-factory check here. Matching
    // `ref(` / `computed(` / `reactive(` described how a binding was CREATED,
    // which both under- and over-refused: `const { a, b } = useThing()` names
    // no factory and passed, while reactive state the template never reads is
    // harmless to leave behind. The reference-based scope guard at the end of
    // `applyDetachEdit` decides that question on the actual output instead.
    if (/\b(onMounted|onUnmounted|onBeforeMount|onBeforeUnmount|onUpdated|onBeforeUpdate|onActivated|onDeactivated|onErrorCaptured)\s*\(/.test(content)) {
      return `Component "${name}" uses lifecycle hooks; they wouldn't fire after detach`
    }
    if (/\bdefineEmits\s*\(/.test(content)) {
      // Emits are component-instance-only; inlining loses the emit binding.
      return `Component "${name}" defines emits; detaching would lose emit handlers`
    }
  }

  // Detect scoped-slot props in the template (e.g. <slot name="x" v-bind="data">).
  const template = descriptor.template?.content ?? ''
  // Look for <slot ... v-bind=... or <slot ... :foo="..." in the template —
  // a heuristic but catches the common case.
  if (/<slot\b[^>]*?(?:v-bind|:[a-zA-Z-]+=)/.test(template)) {
    return `Component "${name}" uses scoped-slot bindings; detach would lose the slot scope`
  }

  return null
}

/**
 * The scope guard (see the module header). Returns a refusal reason when the
 * splice introduces template identifiers the consumer cannot resolve, `null`
 * when every identifier lands somewhere real.
 */
/**
 * Instance-scoped names that the detach transform itself RESOLVES, so their
 * presence in the component's template is not evidence of a retarget.
 *
 * `$slots` is the load-bearing one and it is not an edge case: Vue compiles
 * every `<slot />` to `_renderSlot(_ctx.$slots, …)`, so ANY component with a
 * slot reports it. Detach replaces those slot outlets with the consumer's
 * actual slot content at inline time — resolving `$slots` is the mechanism,
 * not a hazard. `$props` likewise: call-site props are substituted into the
 * template during inlining, and anything the substitution fails to reach is
 * still caught by the before/after diff below.
 *
 * Everything else in INSTANCE_SCOPED_IDENTIFIERS survives inlining as a live
 * reference to whichever instance the markup lands in, which is the bug.
 */
const INLINE_RESOLVED_INSTANCE_IDENTIFIERS: ReadonlySet<string> = new Set(['$slots', '$props'])

/**
 * Which of the exempt names a template SPELLS OUT inside an expression.
 *
 * Scanning expression nodes rather than the raw source is what makes the
 * exemption precise in both directions:
 *
 * - Catches `this.$slots.default` and `this['$props']`. Vue emits those as
 *   `this` accesses, never as `_ctx.$slots`, so they are absent from the
 *   compiler-derived identifier set — a check that only re-included names
 *   already in that set would wave them straight through.
 * - Ignores `class="has-$slots"` and `<!-- $slots -->`. Static attribute
 *   values and comments are not expressions, so they can no longer trigger a
 *   false refusal on a component whose only real use is a `<slot />` outlet.
 *
 * A parse failure yields the empty set; the caller's own analysis of the same
 * template has already failed closed by that point.
 */
function instanceNamesInExpressions(templateSource: string): Set<string> {
  const found = new Set<string>()
  if (!templateSource.trim()) return found

  const expressions: string[] = []
  const collect = (node: { type?: number; children?: unknown[]; props?: unknown[]; content?: unknown; exp?: unknown }): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === NodeTypes.INTERPOLATION) {
      const inner = node.content as { content?: unknown } | undefined
      if (typeof inner?.content === 'string') expressions.push(inner.content)
    }
    for (const prop of (node.props ?? []) as Array<{
      type?: number
      exp?: { content?: unknown }
      arg?: { content?: unknown; isStatic?: unknown }
    }>) {
      if (prop?.type !== NodeTypes.DIRECTIVE) continue
      if (typeof prop.exp?.content === 'string') expressions.push(prop.exp.content)
      // A DYNAMIC directive argument is an expression too, and it lives on
      // `arg`, not `exp`: `:[$props.name]="x"`, `@[this.$props.event]="h"`,
      // `v-slot:[$props.name]`. A static arg (the `class` in `:class`) is a
      // plain name and must not be scanned.
      if (prop.arg && prop.arg.isStatic === false && typeof prop.arg.content === 'string') {
        expressions.push(prop.arg.content)
      }
    }
    for (const child of (node.children ?? []) as Array<Parameters<typeof collect>[0]>) {
      collect(child)
    }
  }

  try {
    collect(parseTemplate(templateSource) as Parameters<typeof collect>[0])
  } catch {
    return found
  }

  // Scan for EVERY instance-scoped name, not just the two exempt ones.
  // `this.$refs.x` / `this.$attrs` / `this.$emit(…)` are left as `this`
  // accesses by the compiler and never surface as `_ctx.$refs`, so they are
  // absent from the compiler-derived set as well — scanning only the exempt
  // names left them invisible to BOTH mechanisms.
  // Strip well-formed string literals first: `:class="'uses-$refs'"` mentions
  // the name as TEXT, and Vue reads no instance property for it. Only
  // balanced quoted runs are removed, so an unbalanced quote leaves the
  // expression intact and the scan still errs toward refusing.
  //
  // TEMPLATE LITERALS ARE DELIBERATELY NOT STRIPPED. A backtick run can
  // contain `${…}`, which is executable code, not text — removing it would
  // hide a real read (`` :title="`${$refs.inner.id}`" ``) and turn this
  // false-refusal fix into a silent-breakage bug. The cost of leaving them
  // in is a false refusal for a backtick string that merely spells the name,
  // which is the safe direction.
  const code = expressions.map((expr) =>
    expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ''),
  )

  for (const id of INSTANCE_SCOPED_IDENTIFIERS) {
    // `id` already begins with `$`, which must be escaped for the regex.
    const pattern = new RegExp(`\\${id}\\b`)
    if (code.some((expr) => pattern.test(expr))) found.add(id)
  }
  return found
}

function refuseUnresolvedIdentifiers(args: {
  componentName: string
  beforeTemplate: string
  afterTemplate: string
  afterDescriptor: SFCDescriptor
  componentDescriptor: SFCDescriptor
  typescript: boolean
}): string | null {
  const { componentName, typescript } = args
  const before = collectFreeIdentifiers(args.beforeTemplate, { typescript })
  const after = collectFreeIdentifiers(args.afterTemplate, { typescript })
  if (!before.ok || !after.ok) {
    // Ambiguity loses: an un-analysable template is one where an unresolved
    // identifier could hide, and a clean refusal costs the user far less than
    // a component that renders blank.
    const reason = before.ok ? (after as { ok: false; reason: string }).reason : before.reason
    return `Component "${componentName}" could not be scope-checked (${reason}); refusing rather than risking a template that renders against undefined bindings`
  }

  // Instance-scoped names are checked against the COMPONENT'S OWN template,
  // never against the before/after diff.
  //
  // The diff answers "what did inlining ADD to the consumer", which is the
  // right question for ordinary bindings — a name the consumer already used
  // demonstrably resolves there. It is the WRONG question for `$refs`,
  // `$attrs`, `$emit` and friends: those resolve against whichever instance
  // the template ends up in, so the component's `$refs` and the consumer's
  // `$refs` are different objects. A consumer that happens to use the same
  // name cancels the identifier out of `after - before` while the silent
  // retarget happens anyway — the identifier is present on both sides and
  // means something different on each.
  const componentTemplateIds = collectFreeIdentifiers(
    args.componentDescriptor.template?.content ?? '',
    { typescript },
  )
  if (!componentTemplateIds.ok) {
    return `Component "${componentName}" template could not be scope-checked (${componentTemplateIds.reason}); refusing rather than risking a template that renders against undefined bindings`
  }
  // `$slots` / `$props` are exempt only for the SYNTAX the inliner actually
  // resolves. `<slot />` and an explicit `$slots.default` both compile to
  // `_ctx.$slots`, so the identifier cannot tell them apart — but the source
  // can: a slot OUTLET never spells the name, while a programmatic use
  // (`v-if="$slots.default"`, `v-bind="$props"`, `$props.someName`) always
  // does. Those forms survive inlining as live reads of the consumer's
  // instance, so they are put back into the refusal set.
  const spelledOut = instanceNamesInExpressions(
    args.componentDescriptor.template?.content ?? '',
  )
  const instanceScoped = [
    ...new Set([
      // Compiler-derived: everything the template reads off its instance.
      ...[...componentTemplateIds.identifiers].filter(
        (id) =>
          isInstanceScopedIdentifier(id) && !INLINE_RESOLVED_INSTANCE_IDENTIFIERS.has(id),
      ),
      // Source-derived: the exempt names, but only where an EXPRESSION spells
      // them. This is a union, not a filter over the compiler set, because
      // `this.$slots.default` is emitted as a `this` access and never appears
      // as `_ctx.$slots` — gating on the compiler set would let it through.
      ...spelledOut,
    ]),
  ].sort()
  if (instanceScoped.length > 0) {
    const names = instanceScoped.map((id) => `"${id}"`).join(', ')
    return `Component "${componentName}" template references ${names}, which is bound to that component's own instance. After inlining it would silently resolve against the consumer's instance instead (a different object), so detaching is refused.`
  }

  // What WILL be in scope after inlining:
  //  - anything the consumer template already referenced (it resolves today),
  //  - the consumer's own script bindings, including any import this detach
  //    just merged in,
  //  - app-level global properties ($route, $t, … — same in every component).
  const consumerBindings = scriptBindingNames(args.afterDescriptor)
  const unresolved = [...after.identifiers]
    .filter(
      (id) =>
        !before.identifiers.has(id) &&
        !consumerBindings.has(id) &&
        !isAppGlobalIdentifier(id),
    )
    .sort()
  if (unresolved.length === 0) return null

  const quoted = unresolved.map((id) => `"${id}"`).join(', ')
  const componentBindings = scriptBindingNames(args.componentDescriptor)
  const fromComponentScript = unresolved.filter((id) => componentBindings.has(id))
  const origin =
    fromComponentScript.length === 0
      ? ''
      : fromComponentScript.length === unresolved.length
        ? ` They are defined in ${componentName}'s own <script>, which detach does not copy.`
        : ` ${fromComponentScript.map((id) => `"${id}"`).join(', ')} ${fromComponentScript.length === 1 ? 'is' : 'are'} defined in ${componentName}'s own <script>, which detach does not copy.`

  return `Component "${componentName}" template references ${quoted}, which will not resolve in the consumer's scope after inlining.${origin} Detaching would render against undefined bindings, so it is refused. Define them in the consumer (or pass them in as props) and retry.`
}

/**
 * Every name the SFC's script block puts in template scope: `<script setup>`
 * bindings (consts, imports, props, …) or the options-API members
 * `compileScript` recovers from a plain `<script>` (`props`, `data`,
 * `computed`, `methods`, `inject`, `setup`).
 *
 * A failure here degrades to "no bindings", which can only make the guard
 * refuse MORE — never less. That is the safe direction.
 */
function scriptBindingNames(descriptor: SFCDescriptor): Set<string> {
  if (!descriptor.script && !descriptor.scriptSetup) return new Set()
  try {
    const compiled = compileScript(descriptor, { id: 'desde-detach-scope-check' })
    return new Set(Object.keys(compiled.bindings ?? {}))
  } catch {
    return new Set()
  }
}

function descriptorUsesTypeScript(descriptor: SFCDescriptor): boolean {
  const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
  return lang === 'ts' || lang === 'tsx'
}

// ─────────────────────────── Helpers ───────────────────────────

interface CallSiteProp {
  /** Prop name (e.g. "variant"). */
  name: string
  /** When the call site used a static attribute (`variant="primary"`). */
  staticValue?: string
  /** When the call site used a v-bind (`:variant="someRef"`). */
  dynamicExpression?: string
}

function extractCallSiteProps(callSite: ElementLike): Map<string, CallSiteProp> {
  const props = new Map<string, CallSiteProp>()
  for (const prop of callSite.props) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      props.set(prop.name, { name: prop.name, staticValue: prop.value?.content ?? '' })
    } else if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.content) {
      props.set(prop.arg.content, {
        name: prop.arg.content,
        dynamicExpression: prop.exp?.content,
      })
    }
  }
  return props
}

interface SlotContent {
  /** Slot name; undefined for the default slot. */
  name?: string
  /** Raw markup of the slot's content. */
  markup: string
}

function extractSlotContents(
  callSite: ElementLike,
  consumerSource: string,
  templateOffset: number,
): Map<string, SlotContent> {
  const slots = new Map<string, SlotContent>()
  const defaultParts: string[] = []

  for (const child of callSite.children) {
    if (
      child.type === NodeTypes.ELEMENT &&
      (child as ElementLike).tag === 'template'
    ) {
      // ONLY treat as a slot wrapper if the <template> declares a slot
      // directive — `v-slot`, `#slot`, or `v-slot:slot`. A bare
      // `<template v-if="...">` is conditional default-slot content and
      // must keep its directive; unwrapping silently changes behavior.
      const slotName = extractSlotNameFromTemplateTag(child as ElementLike)
      if (slotName === null) {
        // Treat as default-slot content — preserve the <template> tag verbatim.
        const start = templateOffset + (child as ElementLike).loc.start.offset
        const end = templateOffset + (child as ElementLike).loc.end.offset
        defaultParts.push(consumerSource.slice(start, end))
        continue
      }
      const inner = sliceTemplateInner(child as ElementLike, consumerSource, templateOffset)
      const existing = slots.get(slotName)
      if (existing) existing.markup += inner
      else slots.set(slotName, { name: slotName === 'default' ? undefined : slotName, markup: inner })
      continue
    }
    // Plain default-slot content (text, interpolation, element).
    const start = templateOffset + (child as ElementLike).loc.start.offset
    const end = templateOffset + (child as ElementLike).loc.end.offset
    defaultParts.push(consumerSource.slice(start, end))
  }
  if (defaultParts.length > 0) {
    const existing = slots.get('default')
    const markup = defaultParts.join('')
    if (existing) existing.markup += markup
    else slots.set('default', { name: undefined, markup })
  }

  return slots
}

function extractSlotNameFromTemplateTag(el: ElementLike): string | null {
  for (const prop of el.props) {
    if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'slot' && prop.arg?.content) {
      return prop.arg.content
    }
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name.startsWith('#')) {
      return prop.name.slice(1)
    }
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name.startsWith('v-slot:')) {
      return prop.name.slice('v-slot:'.length)
    }
  }
  return null
}

function sliceTemplateInner(
  el: ElementLike,
  consumerSource: string,
  templateOffset: number,
): string {
  // Find the open-tag close (`>`) and close-tag start (`</`) in the
  // element's source slice.
  const fullStart = templateOffset + el.loc.start.offset
  const fullEnd = templateOffset + el.loc.end.offset
  const fullText = consumerSource.slice(fullStart, fullEnd)
  const openClose = fullText.indexOf('>') + 1
  const closeStart = fullText.lastIndexOf('</')
  if (openClose <= 0 || closeStart < 0 || openClose > closeStart) return ''
  return fullText.slice(openClose, closeStart)
}

interface InlineRenderResult {
  ok: true
  markup: string
  warnings: string[]
}
interface InlineRenderError {
  ok: false
  reason: string
}

function renderInlined(args: {
  componentRoot: ElementLike
  componentTemplateContent: string
  callSiteProps: Map<string, CallSiteProp>
  slotContents: Map<string, SlotContent>
}): InlineRenderResult | InlineRenderError {
  const { componentRoot, componentTemplateContent, callSiteProps, slotContents } = args
  const warnings: string[] = []

  // Render the component root with substitutions. We work on a string of
  // its source slice, then run a series of regex-based replacements.
  // Tradeoff: this is FAR less correct than rebuilding from the AST, but
  // it's drastically simpler and handles the V1 leaf-component case well
  // enough for the spec'd refusal envelope. Anything weird (props inside
  // mustache expressions, computed prop refs in attributes) is V2.
  let rendered = componentTemplateContent.slice(
    componentRoot.loc.start.offset,
    componentRoot.loc.end.offset,
  )

  // 1. Replace `<slot name="X"/>` and `<slot/>` with the matching slot
  //    content from the call site.
  rendered = rendered.replace(
    /<slot\b([^/>]*)\/?>(?:<\/slot>)?/g,
    (match, attrs: string) => {
      const nameMatch = /\bname=["']([^"']+)["']/.exec(attrs)
      const slotName = nameMatch ? nameMatch[1] : 'default'
      const content = slotContents.get(slotName)
      if (content) return content.markup
      // No call-site content — leave the slot tag's own fallback content
      // (which we strip by collapsing to empty). For V1, just emit "".
      return ''
    },
  )

  // 2. Replace prop attribute references in v-bind expressions and
  //    interpolations. We replace bare identifier matches of each prop
  //    name with the call-site value.
  for (const [propName, callProp] of callSiteProps) {
    if (callProp.staticValue !== undefined) {
      // Replace v-bind:<prop>="<expr>" with <prop>="<staticValue>"
      const literalAttr = `${propName}="${escapeAttr(callProp.staticValue)}"`
      const bindRe = new RegExp(
        `(?::${escapeRegExp(propName)}|v-bind:${escapeRegExp(propName)})="([^"]*)"`,
        'g',
      )
      rendered = rendered.replace(bindRe, literalAttr)
      // Also replace bare interpolations of `props.<name>` and `<name>`
      // when they appear in {{ ... }} blocks (a heuristic — may misfire if
      // the component has a local variable with the same name).
      const interpRe = new RegExp(`\\{\\{\\s*(?:props\\.)?${escapeRegExp(propName)}\\s*\\}\\}`, 'g')
      rendered = rendered.replace(interpRe, escapeText(callProp.staticValue))
    } else if (callProp.dynamicExpression !== undefined) {
      // Preserve the v-bind binding but rewrite to the call-site expr.
      const replacement = `:${propName}="${callProp.dynamicExpression.replace(/"/g, '&quot;')}"`
      const bindRe = new RegExp(
        `(?::${escapeRegExp(propName)}|v-bind:${escapeRegExp(propName)})="([^"]*)"`,
        'g',
      )
      rendered = rendered.replace(bindRe, replacement)
      warnings.push(
        `Prop "${propName}" preserved as v-bind from call site: ensure the consumer scope defines it`,
      )
    }
  }

  return { ok: true, markup: rendered, warnings }
}

function collectSubComponentTags(root: ElementLike): Set<string> {
  const tags = new Set<string>()
  function walk(el: ElementLike): void {
    // Component tags in Vue templates are conventionally PascalCase or
    // contain a hyphen. Skip lowercase HTML elements.
    if (
      el.type === NodeTypes.ELEMENT &&
      /^[A-Z]/.test(el.tag) &&
      el.tag !== 'template'
    ) {
      tags.add(el.tag)
    }
    for (const child of el.children) {
      if (child.type === NodeTypes.ELEMENT) walk(child as ElementLike)
    }
  }
  walk(root)
  return tags
}

/**
 * Compute the splice op for merging the component's style blocks into the
 * consumer. Returns null when the component has no styles or all are empty.
 *
 * Op offsets are keyed off the ORIGINAL consumer source (the same source
 * the template-splice op uses). The caller applies all ops sorted by
 * `start` descending so they don't disturb each other.
 */
function computeStyleMergeOp(
  consumerSource: string,
  componentDescriptor: SFCDescriptor,
  componentFile: string,
): { start: number; end: number; replacement: string } | null {
  const componentStylesText = componentDescriptor.styles
    .map((s) => s.content.trim())
    .filter((s) => s.length > 0)
    .join('\n\n')
  if (!componentStylesText) return null

  const annotated = `\n/* Inlined from ${componentFile} via editor detach */\n${componentStylesText}\n`

  // Look for an existing <style scoped> block to append into.
  const styleRe = /<style\b[^>]*\bscoped\b[^>]*>([\s\S]*?)<\/style>/
  const match = styleRe.exec(consumerSource)
  if (match) {
    const insertAt = match.index + match[0].lastIndexOf('</style>')
    return { start: insertAt, end: insertAt, replacement: annotated }
  }
  // No existing <style scoped> — append a new block at end of file.
  const sfcEnd = consumerSource.length
  const prefix = consumerSource.endsWith('\n') ? '' : '\n'
  const newBlock = `${prefix}<style scoped>\n${componentStylesText}\n</style>\n`
  return { start: sfcEnd, end: sfcEnd, replacement: newBlock }
}

/**
 * Compute the splice op for merging required sub-component imports from
 * the component into the consumer. Returns null when nothing needs to be
 * added (no script setup, all imports already present, etc.).
 */
function computeImportMergeOp(
  consumerSource: string,
  componentDescriptor: SFCDescriptor,
  consumerDescriptor: SFCDescriptor,
  subComponents: Set<string>,
): { start: number; end: number; replacement: string } | null {
  const componentSetup = componentDescriptor.scriptSetup
  const consumerSetup = consumerDescriptor.scriptSetup
  if (!componentSetup || !consumerSetup) return null

  const importsToAdd: string[] = []
  for (const tag of subComponents) {
    const directRe = new RegExp(
      `import\\s+${escapeRegExp(tag)}\\s+from\\s+(['"][^'"]+['"])`,
    )
    const namedRe = new RegExp(
      `import\\s*\\{[^}]*\\b${escapeRegExp(tag)}\\b[^}]*\\}\\s*from\\s+(['"][^'"]+['"])`,
    )
    const direct = directRe.exec(componentSetup.content)
    const named = namedRe.exec(componentSetup.content)
    let importLine: string | null = null
    if (direct) importLine = `import ${tag} from ${direct[1]}`
    else if (named) importLine = `import { ${tag} } from ${named[1]}`
    if (importLine && !consumerSetup.content.includes(importLine)) {
      const consumerHasIt = new RegExp(
        `\\b${escapeRegExp(tag)}\\b`,
      ).test(consumerSetup.content)
      if (!consumerHasIt) importsToAdd.push(importLine)
    }
  }
  if (importsToAdd.length === 0) return null

  // Insert at the start of the consumer's script setup CONTENT (offset
  // returned by `consumerSetup.loc.start.offset` per @vue/compiler-sfc —
  // points just past `<script setup [lang=...]>`). Operating on the
  // original source's offset is correct because we apply ops sorted by
  // offset descending; if the template splice has a lower offset it gets
  // applied AFTER this op, leaving our offset untouched.
  const setupStart = consumerSetup.loc.start.offset
  const insertion = `\n${importsToAdd.join('\n')}`
  return { start: setupStart, end: setupStart, replacement: insertion }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pascalToKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Walk the component template looking for a <slot> element with non-empty
 * fallback content (children other than whitespace text). Returns the slot
 * name (or 'default') if found, null otherwise.
 */
function findSlotWithFallback(root: ElementLike): string | null {
  function check(el: ElementLike): string | null {
    if (el.tag === 'slot') {
      // Find non-whitespace children.
      const meaningful = el.children.some((c) => {
        if (c.type === NodeTypes.ELEMENT) return true
        // `{{ x }}` is meaningful fallback content, and its `content` is an
        // expression NODE, not a string — the previous `content ?? ''` then
        // `.trim()` threw `text.trim is not a function` and escaped this pure
        // applicator as an uncaught exception (a 500 at the CLI edit handler)
        // instead of the refusal it was computing.
        if (c.type === NodeTypes.INTERPOLATION) return true
        const text = (c as unknown as { content?: unknown }).content
        return typeof text === 'string' && text.trim().length > 0
      })
      if (meaningful) {
        const nameAttr = el.props.find((p) =>
          p.type === NodeTypes.ATTRIBUTE && p.name === 'name',
        ) as AttributePropLike | undefined
        return nameAttr?.value?.content ?? 'default'
      }
    }
    for (const child of el.children) {
      if (child.type === NodeTypes.ELEMENT) {
        const found = check(child)
        if (found) return found
      }
    }
    return null
  }
  return check(root)
}

/**
 * Walk the component template looking for prop-name references inside
 * non-trivial expressions. A "trivial" reference is a directive value or
 * interpolation whose entire expression is a bare identifier matching one
 * of the prop names (e.g. `:variant="variant"` or `{{ name }}`). Anything
 * with operators, member access, template literals, or method calls is
 * non-trivial — regex substitution can't safely rewrite it.
 *
 * Returns the offending prop name when a non-trivial reference exists,
 * null when the template is detach-safe.
 */
function findComplexPropExpression(
  root: ElementLike,
  propNames: Set<string>,
): string | null {
  function checkExpression(expr: string): string | null {
    const trimmed = expr.trim()
    // Bare identifier — trivial.
    if (/^[a-zA-Z_$][\w$]*$/.test(trimmed)) return null
    // Non-trivial — check if any prop name appears as a word inside.
    for (const propName of propNames) {
      const re = new RegExp(`\\b${escapeRegExp(propName)}\\b`)
      if (re.test(trimmed)) return propName
    }
    return null
  }

  function walk(el: ElementLike): string | null {
    for (const prop of el.props) {
      if (prop.type === NodeTypes.DIRECTIVE) {
        const exp = (prop as DirectivePropLike).exp?.content
        if (exp) {
          const found = checkExpression(exp)
          if (found) return found
        }
      }
    }
    for (const child of el.children) {
      if (child.type === NodeTypes.ELEMENT) {
        const found = walk(child as ElementLike)
        if (found) return found
        continue
      }
      // Vue's INTERPOLATION node (NodeTypes.INTERPOLATION === 5). Its
      // `content` is a SimpleExpressionNode with `.content` holding the
      // expression text.
      if ((child as unknown as { type: number }).type === 5) {
        const expr = ((child as unknown as { content?: { content?: string } }).content?.content) ?? ''
        const found = checkExpression(expr)
        if (found) return found
      }
    }
    return null
  }

  return walk(root)
}

/**
 * Inspect the component's <script setup> for sub-component imports that
 * use a relative specifier (`./` or `../`). Returns the first such tag;
 * null if all imports are bare specifiers (npm packages, aliases) or no
 * sub-components are referenced.
 */
function findRelativeSubComponentImport(
  componentDescriptor: SFCDescriptor,
  subComponents: Set<string>,
): string | null {
  const setup = componentDescriptor.scriptSetup
  if (!setup || subComponents.size === 0) return null
  for (const tag of subComponents) {
    const directRe = new RegExp(
      `import\\s+${escapeRegExp(tag)}\\s+from\\s+['"](\\.\\.?\\/[^'"]+)['"]`,
    )
    const namedRe = new RegExp(
      `import\\s*\\{[^}]*\\b${escapeRegExp(tag)}\\b[^}]*\\}\\s*from\\s+['"](\\.\\.?\\/[^'"]+)['"]`,
    )
    if (directRe.test(setup.content) || namedRe.test(setup.content)) {
      return tag
    }
  }
  return null
}
