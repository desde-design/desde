/**
 * React/JSX sibling of [resolve-iteration-data-vue.ts](./resolve-iteration-data-vue.ts).
 * Given the source position of an element rendered inside a `.map()` callback,
 * traces the iteratee back to its array-literal data source so the static
 * iteration applicator can add / remove / patch / reorder rows.
 *
 *   `{items.map((item) => <Row key={item.id} … />)}`
 *        │                        │
 *        │ iteratee root          │ keyProperty = "id"
 *        ▼                        ▼
 *   const items = [ … ]   ← arrayLocation (the `[`)
 *
 * Coordinate convention: the input `templateLocation` is Babel 1-based line /
 * 0-based column (the `data-desde-src` stamp). The returned `arrayLocation`, by
 * contrast, uses the array-literal rewriter's convention — 1-based line AND
 * 1-based column (what the rewriter normalizes Babel's 0-based column up to),
 * since `apply-iteration-data-edit-static.ts` feeds it straight to that rewriter
 * exactly like the Vue resolver does. So the column is `babelColumn + 1`.
 *
 * Scope (v1, the common case): the iteratee root resolves to a same-module
 * array-literal binding — `const items = [ … ]` or
 * `const [items] = useState([ … ])`. Member-chain iteratees whose root isn't a
 * literal array (props, fetched data, store selectors) refuse with a reason so
 * the caller can fall back to the LLM lane.
 */

import { parse } from "@babel/parser"

export interface ResolveIterationDataJsxInput {
  /** Full `.tsx`/`.jsx` source. */
  source: string
  /** The iterated element's opening-tag position — Babel 1-based line / 0-based column. */
  templateLocation: { line: number; column: number }
}

export type ResolveIterationDataJsxResult =
  | {
      ok: true
      /** Array-literal `[` location — Babel 1-based line / 0-based column. */
      arrayLocation: { line: number; column: number }
      /** Root identifier the `.map()` iterates (e.g. `items`). */
      iterateeRoot: string
      /** Entry count of the resolved array literal. */
      entryCount?: number
      /** Map callback parameter — `item` in `items.map((item) => …)`. */
      itemVar?: string
      /** Property the element's `key` reads off each entry, or null (positional). */
      keyProperty: string | null
    }
  | { ok: false; reason: string }

interface BabelNode {
  type?: string
  start?: number | null
  end?: number | null
  loc?: { start?: { line?: number; column?: number } } | null
  openingElement?: BabelNode
  attributes?: BabelNode[]
  name?: BabelNode | string
  value?: BabelNode | null
  expression?: BabelNode
  callee?: BabelNode
  object?: BabelNode
  property?: BabelNode
  arguments?: BabelNode[]
  params?: BabelNode[]
  body?: BabelNode
  declarations?: BabelNode[]
  id?: BabelNode
  init?: BabelNode
  elements?: Array<BabelNode | null>
  properties?: BabelNode[]
  left?: BabelNode
  argument?: BabelNode
  [key: string]: unknown
}

export function resolveIterationDataJsxSameFile(
  input: ResolveIterationDataJsxInput,
): ResolveIterationDataJsxResult {
  const { source, templateLocation } = input

  let ast: BabelNode
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    }) as unknown as BabelNode
  } catch (err) {
    return { ok: false, reason: `JSX parse failed: ${(err as Error).message}` }
  }

  const el = findElementAt(ast, templateLocation.line, templateLocation.column)
  if (!el) {
    return {
      ok: false,
      reason: `No JSX element at ${templateLocation.line}:${templateLocation.column}`,
    }
  }

  // Find the enclosing `<iteratee>.map(<cb>)` CallExpression whose callback
  // returns/contains the element.
  const mapCall = findEnclosingMapCall(ast, el)
  if (!mapCall) {
    return {
      ok: false,
      reason: "Element isn't rendered by a `.map()` call: can't resolve iteration data.",
    }
  }
  const callee = mapCall.callee
  const iterateeObject = callee?.object
  if (!iterateeObject) {
    return { ok: false, reason: "Could not read the `.map()` iteratee." }
  }
  const iterateeRoot = rootIdentifier(iterateeObject)
  if (!iterateeRoot) {
    return {
      ok: false,
      reason: "The `.map()` iteratee isn't a simple identifier chain; defer to the LLM lane.",
    }
  }

  // Scope guard: if the iteratee root is bound as a parameter of any function
  // enclosing the `.map()` call (a prop like `function List({ items })`, or a
  // callback arg), it is NOT a same-file array-literal — even if a same-named
  // module const exists, that const is shadowed. Mutating it would touch the
  // wrong data, so refuse and defer to the LLM lane.
  if (isShadowedByEnclosingParam(ast, mapCall, iterateeRoot)) {
    return {
      ok: false,
      reason: `\`${iterateeRoot}\` is a function parameter/prop here, not a same-file array literal: defer to the LLM lane.`,
    }
  }

  // key property from the element's `key={item.PROP}` attribute.
  // `Array.prototype.map(callbackFn, thisArg)` — the callback is argument 0.
  // This used to read `[1] ?? [0]`, which happens to work for the common
  // one-argument call (there is no [1], so it falls back) and silently returns
  // the `thisArg` for the legal two-argument form. That only cost a positional
  // `keyProperty` before; `itemVar` made it load-bearing for `patch-text`, so
  // pick the first argument that is actually a function.
  const itemVar =
    firstParamName(mapCall.arguments?.[0]) ?? firstParamName(mapCall.arguments?.[1])
  const keyProperty = extractKeyProperty(el, itemVar)

  // Trace the iteratee root to a same-module array-literal binding.
  const arrayNode = findArrayLiteralBinding(ast, iterateeRoot)
  if (!arrayNode || typeof arrayNode.loc?.start?.line !== "number") {
    return {
      ok: false,
      reason: `Couldn't trace \`${iterateeRoot}\` to an array-literal in this file (it may be a prop, fetched data, or store selector). Defer to the LLM lane.`,
    }
  }

  return {
    ok: true,
    // +1 on column: Babel reports 0-based columns, but the array-literal
    // rewriter matches against 1-based columns (the source-tag convention).
    arrayLocation: {
      line: arrayNode.loc.start.line as number,
      column: (arrayNode.loc.start.column as number) + 1,
    },
    iterateeRoot,
    // The map CALLBACK PARAMETER (`item` in `items.map((item) => …)`), as
    // distinct from `iterateeRoot`, which is the array. See the Vue sibling's
    // note — conflating them makes the interpolation extractor refuse on every
    // well-formed row.
    itemVar: itemVar ?? undefined,
    /** Entry count of the resolved array literal — see the Vue sibling. */
    entryCount: ((arrayNode as { elements?: unknown[] }).elements ?? []).length,
    keyProperty,
  }
}

/** `items.map` → the CallExpression; the second arg of `map` is the callback
 *  (index callback uncommon). We accept `obj.map(cb)` where the element is
 *  inside the callback body. */
function findEnclosingMapCall(ast: BabelNode, el: BabelNode): BabelNode | null {
  let best: BabelNode | null = null
  let bestSpan = Infinity
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return
    const callee = node.callee
    if (
      !callee ||
      callee.type !== "MemberExpression" ||
      !isMapProperty(callee.property)
    ) {
      return
    }
    if (!within(el, node)) return
    if (typeof node.start !== "number" || typeof node.end !== "number") return
    const span = node.end - node.start
    if (span < bestSpan) {
      bestSpan = span
      best = node
    }
  })
  return best
}

function isMapProperty(prop: BabelNode | undefined): boolean {
  return !!prop && prop.type === "Identifier" && (prop as { name?: string }).name === "map"
}

/** Root identifier of a member chain: `data.rows` → `data`; `items` → `items`. */
function rootIdentifier(node: BabelNode): string | null {
  let cur: BabelNode | undefined = node
  while (cur) {
    if (cur.type === "Identifier") return (cur as { name?: string }).name ?? null
    if (cur.type === "MemberExpression") {
      cur = cur.object
      continue
    }
    return null
  }
  return null
}

function firstParamName(cb: BabelNode | undefined): string | null {
  if (!cb || (cb.type !== "ArrowFunctionExpression" && cb.type !== "FunctionExpression")) {
    return null
  }
  const p = cb.params?.[0]
  if (p?.type === "Identifier") return (p as { name?: string }).name ?? null
  return null
}

/** `key={item.id}` → `"id"` (when the object is the map item var). `key={item}`
 *  or `key={i}` → null (positional matching). */
function extractKeyProperty(el: BabelNode, itemVar: string | null): string | null {
  const attrs = el.openingElement?.attributes ?? []
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue
    const name = a.name
    const attrName = typeof name === "string" ? name : (name as BabelNode | undefined)?.name
    if (attrName !== "key") continue
    const v = a.value
    if (v?.type !== "JSXExpressionContainer") return null
    const expr = v.expression
    if (
      expr?.type === "MemberExpression" &&
      expr.object?.type === "Identifier" &&
      (!itemVar || (expr.object as { name?: string }).name === itemVar) &&
      expr.property?.type === "Identifier"
    ) {
      return (expr.property as { name?: string }).name ?? null
    }
    return null
  }
  return null
}

/** Find a same-module `const X = [ … ]` or `const [X] = useState([ … ])` whose
 *  initializer is an array literal. Returns the single ArrayExpression node, or
 *  null when there are zero OR MULTIPLE matches (ambiguous → don't guess). */
function findArrayLiteralBinding(ast: BabelNode, name: string): BabelNode | null {
  const matches: BabelNode[] = []
  walk(ast, (node) => {
    if (node.type !== "VariableDeclarator") return
    const id = node.id
    const init = node.init
    if (!init) return

    // `const X = [ … ]`
    if (
      id?.type === "Identifier" &&
      (id as { name?: string }).name === name &&
      init.type === "ArrayExpression"
    ) {
      matches.push(init)
      return
    }
    // `const [X, setX] = useState([ … ])` / `useState<T[]>([ … ])`
    if (
      id?.type === "ArrayPattern" &&
      (id.elements ?? []).some(
        (e) => e?.type === "Identifier" && (e as { name?: string }).name === name,
      ) &&
      init.type === "CallExpression" &&
      isUseStateCallee(init.callee) &&
      init.arguments?.[0]?.type === "ArrayExpression"
    ) {
      matches.push(init.arguments[0])
    }
  })
  return matches.length === 1 ? matches[0] : null
}

/** Whether `name` is bound as a parameter of any function whose body encloses
 *  the `.map()` call — covers props (`function List({ items })`), plain params,
 *  and destructured/rest patterns. Such a binding shadows any same-named
 *  module-scope const. */
function isShadowedByEnclosingParam(
  ast: BabelNode,
  mapCall: BabelNode,
  name: string,
): boolean {
  let shadowed = false
  walk(ast, (node) => {
    if (shadowed) return
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    ) {
      return
    }
    if (!within(mapCall, node)) return
    for (const p of node.params ?? []) {
      if (patternBindsName(p, name)) {
        shadowed = true
        return
      }
    }
  })
  return shadowed
}

/** Collect-and-test: does a param pattern bind `name`? Handles Identifier,
 *  ObjectPattern (incl. shorthand + rest), ArrayPattern, AssignmentPattern
 *  (defaults), and TS-annotated params. */
function patternBindsName(node: BabelNode | undefined, name: string): boolean {
  if (!node) return false
  switch (node.type) {
    case "Identifier":
      return (node as { name?: string }).name === name
    case "AssignmentPattern":
      return patternBindsName(node.left, name)
    case "RestElement":
      return patternBindsName(node.argument as BabelNode | undefined, name)
    case "ArrayPattern":
      return (node.elements ?? []).some((e) => patternBindsName(e ?? undefined, name))
    case "ObjectPattern":
      return (node.properties ?? []).some((pr) => {
        if (pr.type === "RestElement") {
          return patternBindsName(pr.argument as BabelNode | undefined, name)
        }
        // ObjectProperty: the BOUND name is the value (`{ items: renamed }`
        // binds `renamed`; shorthand `{ items }` binds `items`).
        return patternBindsName(pr.value as BabelNode | undefined, name)
      })
    default:
      return false
  }
}

function isUseStateCallee(callee: BabelNode | undefined): boolean {
  if (!callee) return false
  if (callee.type === "Identifier") return (callee as { name?: string }).name === "useState"
  // React.useState
  if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
    return (callee.property as { name?: string }).name === "useState"
  }
  return false
}

function within(node: BabelNode, container: BabelNode): boolean {
  if (
    typeof node.start !== "number" ||
    typeof node.end !== "number" ||
    typeof container.start !== "number" ||
    typeof container.end !== "number"
  ) {
    return false
  }
  return node.start >= container.start && node.end <= container.end
}

function findElementAt(ast: BabelNode, line: number, column: number): BabelNode | null {
  let found: BabelNode | null = null
  walk(ast, (node) => {
    if (found) return
    if (node.type !== "JSXElement") return
    const s = node.openingElement?.loc?.start
    if (s?.line === line && s?.column === column) found = node
  })
  return found
}

function walk(node: BabelNode | null | undefined, visit: (n: BabelNode) => void): void {
  if (!node || typeof node !== "object") return
  if (typeof node.type === "string") visit(node)
  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const item of v) walk(item as BabelNode, visit)
    } else if (v && typeof v === "object" && typeof (v as BabelNode).type === "string") {
      walk(v as BabelNode, visit)
    }
  }
}
