/**
 * JSX rendering-hint inference for user-authored React components — the
 * `.tsx`/`.jsx` analog of
 * [local-vue/infer-rendering-hints.ts](../local-vue/infer-rendering-hints.ts).
 *
 * The moat: design-system library components get {@link RenderingHint}s from
 * probing or source inference (see `local-vue/infer-rendering-hints.ts`'s
 * doc comment); the prototype's OWN React components have no manifest
 * source for hints, so `attribute()` refuses for any click landing inside one.
 * This closes that gap WITHOUT per-component authoring by parsing a first-party
 * component's JSX and inferring `dom` hints for the common "a prop is rendered
 * as the text of an element with a stable className" pattern:
 *
 *   <h2 className="header-title">{title}</h2>   → dom hint for prop `title`
 *
 * emits:
 *   { kind: 'dom',
 *     source: { kind: 'prop', name: 'title' },
 *     domTarget: { selector: 'h2.header-title', field: 'textContent' },
 *     editability: 'literal' }
 *
 * The selector is the SAME canonical single-token form
 * `build-attribution-context.ts` composes for `selectorWithinMountRoot`:
 * `:root` when the rendering element is the component's single render root, else
 * `tag` + sorted dotted classes (`h2.header-title`). Class-less non-root
 * elements yield `null` (a bare-tag selector is too ambiguous to match safely).
 *
 * Bounded scope (mirrors the Vue inferrer): only "a bare prop identifier
 * rendered as an element's sole text child". NOT inferred: `{props.title}`
 * member access, prop→attribute, forwards into child components, mixed
 * text/expressions, computed/wrapped expressions (`{fmt(x)}`), `.map()` items.
 * A bare `{title}` requires `title` to be a declared prop name (destructured
 * props — `function C({ title })`).
 *
 * Pure / filesystem-free: source string in, hints out.
 */

import { parse } from "@babel/parser"
import type { RenderingHint } from "../../core"

export interface InferJsxRenderingHintsInput {
  /** The component module's source (`.tsx`/`.jsx`). */
  source: string
  /**
   * Declared prop names. A `{ident}` interpolation is only claimed as a prop
   * render when `ident` is one of these — prevents claiming `{someLocal}`.
   */
  propNames: ReadonlySet<string> | readonly string[]
}

interface BabelNode {
  type?: string
  // JSXElement
  openingElement?: BabelNode
  children?: BabelNode[]
  // JSXOpeningElement
  name?: BabelNode | string
  attributes?: BabelNode[]
  selfClosing?: boolean
  // JSXAttribute value is a node (StringLiteral/JSXExpressionContainer);
  // JSXText `value` and StringLiteral `value` are strings.
  value?: BabelNode | string | null
  // JSXExpressionContainer / literals
  expression?: BabelNode
  // StringLiteral / Identifier / JSXText
  [key: string]: unknown
}

export function inferJsxRenderingHints(
  input: InferJsxRenderingHintsInput,
): RenderingHint[] | undefined {
  const propSet =
    input.propNames instanceof Set ? input.propNames : new Set(input.propNames as readonly string[])
  if (propSet.size === 0) return undefined

  let ast: BabelNode
  try {
    ast = parse(input.source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    }) as unknown as BabelNode
  } catch {
    return undefined
  }

  // Collect every JSXElement, and the set of "outermost" ones (no JSXElement
  // ancestor). A single outermost element is the render root → `:root`; with
  // several (fragment, or multiple components in the file) we can't know the
  // mount root, so we never emit `:root` and fall back to class selectors.
  const allElements: BabelNode[] = []
  const outermost: BabelNode[] = []
  collectElements(ast, false, allElements, outermost)
  const rootElement = outermost.length === 1 ? outermost[0] : null

  const bySelector = new Map<string, { prop: string; collided: boolean }>()
  for (const el of allElements) {
    if (!isNativeElement(el)) continue
    const prop = directTextProp(el, propSet)
    if (!prop) continue
    const selector = selectorFor(el, rootElement)
    if (!selector) continue
    recordHint(bySelector, selector, prop)
  }

  const hints: RenderingHint[] = []
  for (const [selector, entry] of bySelector) {
    if (entry.collided) continue
    hints.push({
      kind: "dom",
      source: { kind: "prop", name: entry.prop },
      domTarget: { selector, field: "textContent" },
      editability: "literal",
    })
  }
  return hints.length > 0 ? hints : undefined
}

// ──────────────── helpers ────────────────

/** Walk the AST collecting JSXElements; `inJsx` tracks whether we're already
 *  inside a JSXElement (to find the outermost ones). */
function collectElements(
  node: BabelNode | null | undefined,
  inJsx: boolean,
  all: BabelNode[],
  outermost: BabelNode[],
): void {
  if (!node || typeof node !== "object") return
  let childInJsx = inJsx
  if (node.type === "JSXElement") {
    all.push(node)
    if (!inJsx) outermost.push(node)
    childInJsx = true
  }
  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const item of v) collectElements(item as BabelNode, childInJsx, all, outermost)
    } else if (v && typeof v === "object" && typeof (v as BabelNode).type === "string") {
      collectElements(v as BabelNode, childInJsx, all, outermost)
    }
  }
}

/** A native host element — JSXIdentifier tag starting lowercase (`div`, `h2`).
 *  Capitalized / member-expression tags are components (their prop reaching
 *  rendered text would be a `forward` hint, out of scope). */
function isNativeElement(el: BabelNode): boolean {
  const name = el.openingElement?.name
  if (!name || typeof name === "string") return false
  if ((name as BabelNode).type !== "JSXIdentifier") return false
  const tag = (name as BabelNode).name
  return typeof tag === "string" && /^[a-z]/.test(tag)
}

/** If `el` renders exactly one declared prop as its text (`<h2>{title}</h2>`),
 *  return the prop name; otherwise null. Ignores whitespace-only JSXText. */
function directTextProp(el: BabelNode, propSet: ReadonlySet<string>): string | null {
  const meaningful = (el.children ?? []).filter((c) => {
    if (c.type === "JSXText") return typeof c.value === "string" && c.value.trim().length > 0
    return true
  })
  if (meaningful.length !== 1) return null
  const only = meaningful[0]
  if (only.type !== "JSXExpressionContainer") return null
  const expr = only.expression
  if (!expr || expr.type !== "Identifier") return null
  const ident = expr.name
  return typeof ident === "string" && propSet.has(ident) ? ident : null
}

/** Canonical single-token selector: `:root` for the render root, else
 *  `tag.sortedClasses`, else null (class-less non-root is too ambiguous). */
function selectorFor(el: BabelNode, rootElement: BabelNode | null): string | null {
  const tag = (el.openingElement?.name as BabelNode | undefined)?.name
  if (typeof tag !== "string") return null
  if (rootElement && el === rootElement) return ":root"
  const classes = staticClasses(el)
  if (classes.length === 0) return null
  return `${tag.toLowerCase()}.${classes.join(".")}`
}

/** Static class tokens from a literal `className="..."` (ignores
 *  `className={…}` dynamic bindings — like the Vue inferrer ignores `:class`). */
function staticClasses(el: BabelNode): string[] {
  const tokens: string[] = []
  for (const attr of el.openingElement?.attributes ?? []) {
    if (attr.type !== "JSXAttribute") continue
    const attrName = (attr.name as BabelNode | undefined)?.name
    if (attrName !== "className") continue
    // JSXAttribute.value is always a node (StringLiteral / JSXExpressionContainer).
    const val = attr.value as BabelNode | null | undefined
    if (val?.type !== "StringLiteral") continue
    const content = typeof val.value === "string" ? val.value : ""
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
  if (existing.prop !== prop) existing.collided = true
}
