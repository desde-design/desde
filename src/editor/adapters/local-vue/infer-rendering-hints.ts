/**
 * SFC rendering-hint inference for user-authored Vue components.
 *
 * The moat: design-system library components get {@link RenderingHint}s from
 * probing (`src/editor/hints/generate-hints-run.ts`, the "Generate hints"
 * panel action) or, failing that, source inference for the same library. But
 * the prototype's OWN components — `EntityFormBlock`, `EntityFormSection`,
 * `ConfigCardItem`, etc. — have no manifest source for rendering hints, so
 * the attribution function refuses for any click landing inside one of them
 * (Phase 2e case 8: clicking an EntityFormBlock's rendered title "General
 * information" refuses instead of resolving to a `direct` prop edit at the
 * EFB call site).
 *
 * This module closes that gap WITHOUT hand-authoring per-component manifests:
 * it parses a first-party SFC's `<template>` and infers `dom` rendering hints
 * for the common "a prop is rendered as the text of an element with a stable
 * class" pattern. This is the same pattern the spec's Layer 1 source #3
 * ("inferred from SFCs for user-authored components") calls for — generalizable
 * over the prototype's shim components, not a one-off.
 *
 * ── Pattern covered (the EntityFormBlock shape) ──
 *
 *   <h2 class="header-title">
 *     <slot name="title">{{ title }}</slot>   ← slot-with-prop-fallback
 *   </h2>
 *   <div class="step">{{ step }}</div>         ← bare interpolation
 *
 * Both emit a `dom` hint:
 *   { kind: 'dom',
 *     source: { kind: 'prop', name: 'title' },
 *     domTarget: { selector: 'h2.header-title', field: 'textContent' },
 *     editability: 'literal' }
 *
 * The selector is the SAME canonical single-token form
 * `build-attribution-context.ts` composes for `selectorWithinMountRoot`:
 * `tag` + sorted dotted classes (`h2.header-title`), or `:root` when the
 * rendering element IS the component's template-root element. We match that
 * convention exactly so the shell-side `attribute()` selector-equality check
 * lines up.
 *
 * ── Why `editability: 'literal'` ──
 *
 * The hint terminates at the OWNING (first-party) component's prop. The
 * forward walk in `attribute()` then resolves it at the consumer's call
 * site — i.e. wherever `<EntityFormBlock title="General information" />`
 * was written — and `classifyPropValue` decides literal-vs-binding from
 * the consumer's vnode props. So `'literal'` here means "this surface is
 * a directly-editable prop"; the literal-vs-binding distinction at the
 * actual call site is made downstream from runtime data, not from this
 * inference. (Were we to infer the rendering element carries a non-prop
 * computed string, we'd mark it `uneditable` — but the patterns we match
 * are exactly "prop rendered verbatim".)
 *
 * ── Known limitations (deliberately bounded — see spec Phase 1h notes) ──
 *
 *  - Only the "prop rendered as element text" pattern is inferred. We do
 *    NOT infer: prop-to-attribute bindings (`:placeholder="x"`), forwards
 *    into child components (`<UiInput :label="title">` — that's the
 *    `kind: 'forward'` shape, which needs the child's name as authored,
 *    not always recoverable statically), interpolations mixed with other
 *    text/elements in the same element, computed/formatter-wrapped
 *    expressions (`{{ format(title) }}`), or v-for'd item text.
 *  - Only the FALLBACK content of a named slot (`<slot name="x">{{ x }}</slot>`)
 *    or a bare `{{ prop }}` is matched. Slot content authored by the
 *    consumer is the consumer's concern (the `direct`/slot path), not a
 *    rendering hint on the owner.
 *  - The interpolation expression must be a bare prop identifier that is
 *    declared in the component's `defineProps`. `{{ user.name }}`,
 *    `{{ title || 'x' }}`, etc. are skipped (we can't claim they render a
 *    single editable prop).
 *  - The rendering element must carry at least one class OR be the
 *    template root (`:root`). A class-less, non-root element yields a
 *    bare-tag selector (`h2`) which is too ambiguous to match safely, so
 *    it is skipped.
 *  - Multiple props rendered into the SAME selector (collision) are
 *    dropped — the selector can't disambiguate which prop a click means.
 *
 * Pure / filesystem-free: takes a template string in, returns hints out.
 * The caller (`LocalVueManifestSource`) reads the SFC and supplies both
 * the declared prop names and the `<template>` source.
 */

import { parse as parseTemplate, NodeTypes } from '@vue/compiler-dom'
import type { RenderingHint } from '../../core'

/**
 * Minimal structural views of the `@vue/compiler-dom` AST nodes we touch.
 * The library's own types are broad unions; narrowing to just the fields
 * we read keeps the walk readable and avoids depending on internal shapes.
 */
interface ElementNode {
  type: typeof NodeTypes.ELEMENT
  tag: string
  /** 0 = ELEMENT, 1 = COMPONENT, 2 = SLOT, 3 = TEMPLATE. */
  tagType: number
  props: Array<AttrNode | DirectiveNode>
  children: TemplateNode[]
}

interface AttrNode {
  type: typeof NodeTypes.ATTRIBUTE
  name: string
  value?: { content: string }
}

interface DirectiveNode {
  type: typeof NodeTypes.DIRECTIVE
  name: string
}

interface InterpolationNode {
  type: typeof NodeTypes.INTERPOLATION
  content: { content: string; isStatic?: boolean }
}

interface TextNode {
  type: typeof NodeTypes.TEXT
  content: string
}

type TemplateNode =
  | ElementNode
  | InterpolationNode
  | TextNode
  | { type: number; children?: TemplateNode[]; branches?: Array<{ children?: TemplateNode[] }> }

export interface InferRenderingHintsInput {
  /** The SFC's `<template>` block source (inner content, no `<template>` tags). */
  templateSource: string
  /**
   * Names declared in the component's `defineProps`. An interpolation is
   * only claimed as a prop render when its expression is one of these —
   * prevents claiming `{{ someLocalRef }}` as an editable prop.
   */
  propNames: ReadonlySet<string> | readonly string[]
}

/**
 * Infer `dom` rendering hints from a first-party SFC template. Returns
 * `undefined` (not `[]`) when nothing is inferred, so the caller can
 * leave `ComponentManifest.rendering` unset and attribution falls back to
 * heuristic behavior — matching the `getAcme DSRenderingHints`
 * contract.
 */
export function inferRenderingHints(
  input: InferRenderingHintsInput,
): RenderingHint[] | undefined {
  const propSet =
    input.propNames instanceof Set
      ? input.propNames
      : new Set(input.propNames as readonly string[])
  if (propSet.size === 0) return undefined

  let root: { children?: TemplateNode[] }
  try {
    root = parseTemplate(input.templateSource) as unknown as { children?: TemplateNode[] }
  } catch {
    return undefined
  }

  // The template's single root NATIVE element (if any) is what the runtime
  // mount root resolves to; clicks on it get the `:root` selector. We
  // require a NATIVE element (tagType ELEMENT) here, not a `<template>`,
  // `<slot>`, or child-component root — those are not rendered DOM nodes
  // themselves, so assigning `:root` to one would never match the bridge's
  // `selectorWithinMountRoot` (which is the actual mounted DOM root).
  // Vue SFC templates may legally have multiple roots (fragments); in that
  // case we can't know which is the mount root, so we never emit `:root`
  // and fall back to class-based selectors. We compute the root element
  // only when there is exactly one top-level node and it is a native
  // element.
  const topNodes = root.children ?? []
  const rootElement =
    topNodes.length === 1 && isNativeElement(topNodes[0]) ? (topNodes[0] as ElementNode) : null

  // selector → prop name. Used both to build hints and to detect selector
  // collisions (two different props rendered into the same selector — we
  // drop both because a click can't disambiguate them).
  const bySelector = new Map<string, { prop: string; collided: boolean }>()

  const visit = (node: TemplateNode): void => {
    if (isElement(node)) {
      // Only NATIVE elements (tagType ELEMENT) become hint targets. The
      // other element flavors are not rendered DOM nodes whose selector
      // could match the bridge's `selectorWithinMountRoot`:
      //   - `<slot>` produces no node of its own; its fallback renders into
      //     the slot's POSITION within the PARENT's DOM. The fallback prop
      //     is attributed at the parent native element instead (see
      //     `directTextProp`, which looks THROUGH a single slot child).
      //   - `<template>` (v-if/v-for wrappers, named slot containers) is a
      //     compile-time grouping, not a DOM element.
      //   - a child COMPONENT tag (`<UiInput>`, `<MyCard>`) renders that
      //     child's OWN DOM, not a `<mycard>` element — a prop reaching a
      //     child's rendered text is a `forward` hint, not a `dom` hint,
      //     and is out of scope for this inference.
      // We still recurse into every element's children so nested native
      // elements inside slots/templates/components are visited.
      if (isNativeElement(node)) {
        const renderedProp = directTextProp(node, propSet)
        if (renderedProp) {
          const selector = selectorFor(node, rootElement)
          if (selector) {
            recordHint(bySelector, selector, renderedProp)
          }
        }
      }
      for (const child of node.children ?? []) visit(child)
      return
    }
    // v-if / v-for wrap their content in IF / FOR nodes carrying `children`
    // (and IF carries `branches`). Recurse through them so a conditional
    // `<div class="step">{{ step }}</div>` is still visited. We intentionally
    // do NOT special-case v-for item rendering as a hint (see limitations).
    const container = node as { children?: TemplateNode[]; branches?: Array<{ children?: TemplateNode[] }> }
    if (container.branches) {
      for (const branch of container.branches) {
        for (const child of branch.children ?? []) visit(child)
      }
    }
    if (container.children) {
      for (const child of container.children) visit(child)
    }
  }

  for (const child of root.children ?? []) visit(child)

  const hints: RenderingHint[] = []
  for (const [selector, entry] of bySelector) {
    if (entry.collided) continue
    hints.push({
      kind: 'dom',
      source: { kind: 'prop', name: entry.prop },
      domTarget: { selector, field: 'textContent' },
      editability: 'literal',
    })
  }
  return hints.length > 0 ? hints : undefined
}

// ──────────────── helpers ────────────────

function isElement(node: TemplateNode): node is ElementNode {
  return (node as { type: number }).type === NodeTypes.ELEMENT
}

/**
 * A NATIVE rendered HTML element (tagType ELEMENT === 0) — `<div>`, `<h2>`,
 * etc. Excludes `<slot>` (SLOT), `<template>` (TEMPLATE), and child-component
 * tags (COMPONENT). Only native elements become actual DOM nodes the bridge
 * can match a click against, so only they are eligible hint targets / `:root`.
 *
 * `@vue/compiler-dom`'s `ElementTypes` enum: ELEMENT=0, COMPONENT=1, SLOT=2,
 * TEMPLATE=3. We compare against 0 directly (the enum isn't re-exported from
 * the package's runtime entry alongside `NodeTypes`).
 */
function isNativeElement(node: TemplateNode): node is ElementNode {
  return isElement(node) && node.tagType === 0 /* ElementTypes.ELEMENT */
}

/**
 * If `el` renders exactly one declared prop as its text content — either as
 * a bare `{{ prop }}` interpolation or as the fallback of a named slot
 * (`<slot name="x">{{ x }}</slot>`) — return that prop name. Otherwise null.
 *
 * "Renders the prop as its text" requires that the prop interpolation is the
 * element's ONLY meaningful content: we ignore whitespace-only text nodes and
 * comments, but bail if the element mixes the interpolation with literal
 * text, other interpolations, or other rendered elements (a click on such an
 * element doesn't map cleanly to a single editable prop, and `textContent`
 * would over-capture the siblings).
 */
function directTextProp(
  el: ElementNode,
  propSet: ReadonlySet<string>,
): string | null {
  // Collect the meaningful (non-whitespace) renderable children, looking
  // THROUGH a single slot-fallback wrapper. The host element either contains
  // the interpolation directly, or contains a single `<slot name=…>` whose
  // fallback is the interpolation.
  const meaningful = meaningfulChildren(el)
  if (meaningful.length !== 1) return null
  const only = meaningful[0]

  if (isSlotElement(only)) {
    // `<slot name="x">{{ x }}</slot>` — descend into the slot's fallback.
    const slotMeaningful = meaningfulChildren(only as ElementNode)
    if (slotMeaningful.length !== 1) return null
    return interpolationProp(slotMeaningful[0], propSet)
  }
  return interpolationProp(only, propSet)
}

/** Children of an element with whitespace-only text and comments removed. */
function meaningfulChildren(el: ElementNode): TemplateNode[] {
  const out: TemplateNode[] = []
  for (const child of el.children ?? []) {
    const t = (child as { type: number }).type
    if (t === NodeTypes.TEXT) {
      if ((child as TextNode).content.trim().length === 0) continue
    }
    if (t === NodeTypes.COMMENT) continue
    out.push(child)
  }
  return out
}

function isSlotElement(node: TemplateNode): boolean {
  return isElement(node) && node.tag === 'slot' && node.tagType === 2 /* SLOT */
}

/**
 * If `node` is an INTERPOLATION whose expression is a bare declared prop
 * identifier, return the prop name; otherwise null. Rejects member access
 * (`user.name`), calls (`fmt(x)`), and any non-prop identifier.
 */
function interpolationProp(
  node: TemplateNode,
  propSet: ReadonlySet<string>,
): string | null {
  if ((node as { type: number }).type !== NodeTypes.INTERPOLATION) return null
  const expr = (node as InterpolationNode).content?.content?.trim() ?? ''
  if (!isBareIdentifier(expr)) return null
  return propSet.has(expr) ? expr : null
}

/** A single JS identifier — no dots, calls, operators, or whitespace. */
function isBareIdentifier(expr: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(expr)
}

/**
 * Canonical single-token selector for an element, mirroring
 * `canonicalSelectorOf` in `build-attribution-context.ts`:
 *   - the template-root element → `:root`
 *   - otherwise `tag` + sorted dotted classes (`h2.header-title`)
 *   - a class-less non-root element → null (bare-tag selector is too
 *     ambiguous to match against the live DOM safely)
 */
function selectorFor(el: ElementNode, rootElement: ElementNode | null): string | null {
  if (rootElement && el === rootElement) return ':root'
  const classes = staticClasses(el)
  if (classes.length === 0) return null
  const tag = el.tag.toLowerCase()
  return `${tag}.${classes.join('.')}`
}

/**
 * Static class tokens from the element's `class="..."` attribute, sorted to
 * match the runtime selector's `sortedClasses`. We read ONLY the static
 * `class` attribute — `:class` bindings are dynamic and can't be matched to a
 * stable authored selector. (An element with both a static `class` and a
 * `:class` binding still yields a usable selector from its static classes,
 * which is the common case for the conditional classes EntityFormBlock uses.)
 */
function staticClasses(el: ElementNode): string[] {
  const tokens: string[] = []
  for (const prop of el.props ?? []) {
    if (prop.type !== NodeTypes.ATTRIBUTE) continue
    if ((prop as AttrNode).name !== 'class') continue
    const content = (prop as AttrNode).value?.content ?? ''
    for (const tok of content.split(/\s+/)) {
      if (tok.length > 0) tokens.push(tok)
    }
  }
  tokens.sort()
  return tokens
}

function recordHint(
  bySelector: Map<string, { prop: string; collided: boolean }>,
  selector: string,
  prop: string,
): void {
  const existing = bySelector.get(selector)
  if (!existing) {
    bySelector.set(selector, { prop, collided: false })
    return
  }
  // Same selector already recorded. If it's the same prop, harmless dupe;
  // if a different prop, mark collided so we drop the ambiguous hint.
  if (existing.prop !== prop) existing.collided = true
}
