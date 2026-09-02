/**
 * React Router route enumerator — the React sibling of `enumerateVueRoutes`
 * in `scaffold-vue-route.ts`. PURE (source in, route list out): given the
 * router file's source, returns the statically-navigable routes it declares,
 * or a refusal. Used by route-enumeration screenshot plans
 * (`tasks/editor-screenshot-flows.md` Phase 1 / the React follow-up) to
 * "snapshot all my screens" for a React prototype with zero LLM.
 *
 * Supports BOTH common React Router v6 route-declaration shapes:
 *
 *  1. **Object form** — `createBrowserRouter([...])` (also `createHashRouter`
 *     / `createMemoryRouter`), the routes array inline or bound to a
 *     top-level `const`. Mirrors `enumerateVueRoutes`'s `createRouter({ routes })`
 *     handling: resolves `...spread`s of a shared `const` array, joins nested
 *     `children`, recurses pathless layout wrappers (`{ element, children }`
 *     with no `path`), and treats `index: true` as the parent's own path.
 *
 *  2. **JSX form** — `<Routes><Route path=… element=…>…</Route></Routes>`.
 *     Walks `<Route>` elements the same way: nested children join paths,
 *     `<Route index element=… />` collapses to the parent path, a `<Route>`
 *     with no `path`/`index` (only `element` + children) is a pathless
 *     layout wrapper.
 *
 * Both forms share the same path-join/dynamic-segment rules
 * (`route-path-utils.ts`) and the same categorization: a node is a page
 * candidate when it has an `element`/`Component` OR has no children (a bare
 * leaf); dynamic (`:id`) / catch-all (`*`) paths are skipped and reported;
 * `lazy` routes (component resolved by evaluating a dynamic import — v6.4+
 * data-router API) are skipped and reported since the target isn't
 * statically resolvable without running the module.
 *
 * Refuses (mirrors `enumerateVueRoutes`) when:
 *  - the file doesn't parse;
 *  - there's neither exactly one `createBrowserRouter(...)`-style call NOR
 *    exactly one `<Routes>` block (0 of either → unrecognized; >1 of either →
 *    ambiguous — pick a router file that isolates one router declaration);
 *  - the data-router's routes argument isn't a plain array literal (or a
 *    `const` bound to one) — e.g. file-based or dynamically-generated
 *    routing.
 *
 * Deliberately NOT supported (documented, not silently wrong): routes
 * declared via `createRoutesFromElements`, Route elements assembled through
 * conditional/dynamic JSX (`{cond && <Route .../>}`), or file-based routing
 * conventions (Remix/Next-style). These fall through to the "unrecognized"
 * refusal rather than guessing.
 */

import { parse } from '@babel/parser'

import { walkJsx, type JsxNode } from './resolve-jsx-target'
import { isDynamicPath, joinRoutePath } from './route-path-utils'

import type {
  EnumeratedRoute,
  EnumerateRoutesResult,
  ScaffoldRouteContext,
  SkippedRoute,
} from '../core/route-scaffold'

/** `createBrowserRouter`/`createHashRouter`/`createMemoryRouter` are the
 * React Router v6.4+ data-router entry points; all three take the same
 * `(routes, opts?)` shape, so any one of them counts as "the" router call. */
const REACT_DATA_ROUTER_FNS = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
])

/** Recursively collect every node of a given `type`. Reuses the generic
 * Babel-node visitor the JSX applicators share (`resolve-jsx-target.ts`) —
 * it works for plain (non-JSX) nodes too, since it only special-cases
 * `type`/`loc`/`start`/`end` keys. */
function collect<T extends JsxNode>(root: JsxNode, type: string): T[] {
  const out: T[] = []
  walkJsx(root, (n) => {
    if (n.type === type) out.push(n as T)
  })
  return out
}

// ── Object-form (`createBrowserRouter([...])`) property helpers ────────────

function propName(prop: JsxNode): string | undefined {
  const k = prop.key as JsxNode | undefined
  if (k?.type === 'Identifier') return k.name as string | undefined
  if (k?.type === 'StringLiteral') return k.value as string | undefined
  return undefined
}

function findProp(obj: JsxNode, name: string): JsxNode | undefined {
  const props = (obj.properties as JsxNode[] | undefined) ?? []
  return props.find((p) => p.type === 'ObjectProperty' && propName(p) === name)
}

function hasProp(obj: JsxNode, name: string): boolean {
  return findProp(obj, name) !== undefined
}

function stringValueOf(prop: JsxNode): string | undefined {
  const v = prop.value as JsxNode | undefined
  return v?.type === 'StringLiteral' ? (v.value as string) : undefined
}

function booleanValueOf(prop: JsxNode): boolean | undefined {
  const v = prop.value as JsxNode | undefined
  return v?.type === 'BooleanLiteral' ? (v.value as boolean) : undefined
}

function resolveConstArray(file: JsxNode, name: string): JsxNode | undefined {
  const decls = collect<JsxNode>(file, 'VariableDeclarator')
  for (const d of decls) {
    const id = d.id as JsxNode | undefined
    const init = d.init as JsxNode | undefined
    if (id?.name === name && init?.type === 'ArrayExpression') return init
  }
  return undefined
}

/** Result of resolving a route object's `children:` property. */
type ChildrenResolution =
  | { kind: 'none' }
  /** Resolved to an array — inline, or via a const it references. `expanding`
   *  is the (possibly-extended) cycle-guard set to recurse with. */
  | { kind: 'array'; arr: JsxNode; expanding: ReadonlySet<string> }
  /** Identifier is already being expanded on this recursion path — a genuine
   *  cycle (mirrors the spread-cycle guard below). Treated as "has children"
   *  (not a bare leaf) but nothing further to walk. */
  | { kind: 'cycle' }
  /** `children:` is present but isn't an inline array or a const-bound one
   *  (e.g. a function call, a spread, a ternary) — can't be resolved without
   *  guessing. The caller REFUSES the whole enumeration rather than silently
   *  dropping the subtree. */
  | { kind: 'unresolvable' }

/** Resolve a route object's `children:` value. Mirrors the `...spread` const
 * resolution below: an inline array is used directly; an Identifier is
 * resolved against a top-level `const <name> = [...]` (so `children:
 * adminRoutes` enumerates the same as inlining `adminRoutes`, same as Vue's
 * `...routes` spread resolution). */
function resolveChildren(
  file: JsxNode,
  obj: JsxNode,
  expanding: ReadonlySet<string>,
): ChildrenResolution {
  const prop = findProp(obj, 'children')
  if (!prop) return { kind: 'none' }
  const v = prop.value as JsxNode | undefined
  if (v?.type === 'ArrayExpression') return { kind: 'array', arr: v, expanding }
  if (v?.type === 'Identifier') {
    const name = v.name as string
    if (expanding.has(name)) return { kind: 'cycle' }
    const resolved = resolveConstArray(file, name)
    if (!resolved) return { kind: 'unresolvable' }
    return { kind: 'array', arr: resolved, expanding: new Set(expanding).add(name) }
  }
  return { kind: 'unresolvable' }
}

/** Find the single data-router creation call. Returns null on 0 or >1. */
function findDataRouterCalls(file: JsxNode): JsxNode[] {
  return collect<JsxNode>(file, 'CallExpression').filter((c) => {
    const callee = c.callee as JsxNode | undefined
    if (callee?.type === 'Identifier') return REACT_DATA_ROUTER_FNS.has(callee.name as string)
    if (callee?.type === 'MemberExpression') {
      const prop = callee.property as JsxNode | undefined
      return REACT_DATA_ROUTER_FNS.has(String(prop?.name))
    }
    return false
  })
}

/** Resolve the router call's first (routes) argument to its backing array
 * literal — inline, or via a `const routes = [...]` it references. */
function resolveArrayArg(file: JsxNode, call: JsxNode): JsxNode | undefined {
  const arg = (call.arguments as JsxNode[] | undefined)?.[0]
  if (!arg) return undefined
  if (arg.type === 'ArrayExpression') return arg
  if (arg.type === 'Identifier') return resolveConstArray(file, arg.name as string)
  return undefined
}

// ── JSX-form (`<Routes><Route .../></Routes>`) attribute helpers ───────────

function isNamedJsxElement(el: JsxNode, name: string): boolean {
  if (el.type !== 'JSXElement') return false
  const opening = el.openingElement as JsxNode | undefined
  const tagName = opening?.name as JsxNode | undefined
  return tagName?.type === 'JSXIdentifier' && tagName.name === name
}

/** Direct `<Route>` children of `el` — flattening through any `<>...</>`
 * (JSXFragment) wrappers, arbitrarily nested, since a fragment is a common
 * way to group routes without adding a DOM node. A fragment isn't itself a
 * `<Route>`, so without this a `<Routes><>…routes…</></Routes>` (or
 * `<Route>` with a fragment of nested `<Route>`s) enumerates to nothing. */
function childRouteElements(el: JsxNode): JsxNode[] {
  const children = (el.children as JsxNode[] | undefined) ?? []
  const out: JsxNode[] = []
  for (const c of children) {
    if (isNamedJsxElement(c, 'Route')) {
      out.push(c)
    } else if (c.type === 'JSXFragment') {
      out.push(...childRouteElements(c))
    }
  }
  return out
}

function jsxAttr(opening: JsxNode, name: string): JsxNode | undefined {
  const attrs = (opening.attributes as JsxNode[] | undefined) ?? []
  return attrs.find(
    (a) => a.type === 'JSXAttribute' && (a.name as JsxNode | undefined)?.name === name,
  )
}

/** Read a JSX attribute's string value. Handles the plain form
 * (`path="/about"`) AND a static value wrapped in an expression container —
 * `path={'/about'}` (StringLiteral) or `path={\`/about\`}` (a template
 * literal with no `${…}` substitutions, i.e. a static string spelled with
 * backticks). Anything with actual expressions/substitutions is genuinely
 * dynamic and correctly returns undefined. */
function jsxAttrStringValue(attr: JsxNode): string | undefined {
  const v = attr.value as JsxNode | undefined
  if (v?.type === 'StringLiteral') return v.value as string
  if (v?.type === 'JSXExpressionContainer') {
    const expr = v.expression as JsxNode | undefined
    if (expr?.type === 'StringLiteral') return expr.value as string
    if (expr?.type === 'TemplateLiteral') {
      const expressions = (expr.expressions as JsxNode[] | undefined) ?? []
      const quasis = (expr.quasis as JsxNode[] | undefined) ?? []
      if (expressions.length === 0 && quasis.length === 1) {
        const cooked = (quasis[0].value as { cooked?: string } | undefined)?.cooked
        if (typeof cooked === 'string') return cooked
      }
    }
  }
  return undefined
}

/** `<Route index />` (boolean shorthand, no value) or `<Route index={true} />`. */
function jsxAttrIsTruthy(attr: JsxNode): boolean {
  const v = attr.value as JsxNode | null | undefined
  if (v == null) return true
  if (v.type === 'JSXExpressionContainer') {
    const expr = v.expression as JsxNode | undefined
    return expr?.type === 'BooleanLiteral' && expr.value === true
  }
  return false
}

// ── Shared categorization ───────────────────────────────────────────────────

/** Categorize one route node (already resolved to a full path) and, unless
 * skipped, emit it. Shared by both walkers so the object-form and JSX-form
 * classification rules can't drift apart. */
function classify(
  fullPath: string,
  hasElement: boolean,
  hasLazy: boolean,
  hasChildren: boolean,
  routes: EnumeratedRoute[],
  skipped: SkippedRoute[],
  seen: Set<string>,
  name?: string,
): void {
  if (hasLazy) {
    skipped.push({
      path: fullPath,
      why: 'lazy route: component resolved by evaluating a dynamic import, not statically resolvable',
    })
    return
  }
  const isPageCandidate = hasElement || !hasChildren
  if (!isPageCandidate) return
  if (isDynamicPath(fullPath)) {
    skipped.push({ path: fullPath, why: 'dynamic / catch-all route: needs a param value' })
    return
  }
  if (seen.has(fullPath)) return
  seen.add(fullPath)
  routes.push(name ? { path: fullPath, name } : { path: fullPath })
}

// ── Object-form walk ─────────────────────────────────────────────────────────

/** Walks the object-form routes array. Returns a refusal reason string when
 * a node's `children:` can't be resolved deterministically (see
 * {@link resolveChildren}); `undefined` on success. Short-circuits on the
 * first refusal — the caller turns it into `{ ok: false }` for the whole
 * enumeration (an honest failure beats a silently-incomplete route list). */
function walkObjectRoutes(
  file: JsxNode,
  arr: JsxNode,
  parentPath: string,
  expanding: ReadonlySet<string>,
  routes: EnumeratedRoute[],
  skipped: SkippedRoute[],
  seen: Set<string>,
): string | undefined {
  const elements = (arr.elements as (JsxNode | null)[] | undefined) ?? []
  for (const el of elements) {
    if (!el) continue
    if (el.type === 'SpreadElement') {
      const arg = el.argument as JsxNode | undefined
      if (arg?.type === 'Identifier' && !expanding.has(arg.name as string)) {
        const resolved = resolveConstArray(file, arg.name as string)
        if (resolved) {
          const err = walkObjectRoutes(
            file,
            resolved,
            parentPath,
            new Set(expanding).add(arg.name as string),
            routes,
            skipped,
            seen,
          )
          if (err) return err
        }
      }
      continue
    }
    if (el.type !== 'ObjectExpression') continue

    const pathProp = findProp(el, 'path')
    const rawPath = pathProp ? stringValueOf(pathProp) : undefined
    const indexProp = findProp(el, 'index')
    const isIndex = indexProp ? booleanValueOf(indexProp) === true : false
    const hasElement = hasProp(el, 'element') || hasProp(el, 'Component')
    const hasLazy = hasProp(el, 'lazy')
    const idProp = findProp(el, 'id')
    const name = idProp ? stringValueOf(idProp) : undefined

    const childrenRes = resolveChildren(file, el, expanding)
    if (childrenRes.kind === 'unresolvable') {
      const near = rawPath ?? (parentPath || '/')
      return `enumerate: a route's \`children\` (near path '${near}') is not a plain array literal (or a const bound to one). Cannot enumerate its subtree without silently dropping routes.`
    }
    const childrenArr = childrenRes.kind === 'array' ? childrenRes.arr : undefined
    const hasChildren = childrenRes.kind !== 'none'
    const nextExpanding = childrenRes.kind === 'array' ? childrenRes.expanding : expanding

    if (rawPath === undefined && !isIndex) {
      // Pathless layout/group wrapper — no page of its own, but its children
      // (which carry their own paths) are still navigable.
      if (childrenArr) {
        const err = walkObjectRoutes(file, childrenArr, parentPath, nextExpanding, routes, skipped, seen)
        if (err) return err
      }
      continue
    }

    const fullPath = isIndex ? parentPath : joinRoutePath(parentPath, rawPath as string)
    classify(fullPath, hasElement, hasLazy, hasChildren, routes, skipped, seen, name)

    if (!isIndex && childrenArr) {
      const err = walkObjectRoutes(file, childrenArr, fullPath, nextExpanding, routes, skipped, seen)
      if (err) return err
    }
  }
  return undefined
}

// ── JSX-form walk ────────────────────────────────────────────────────────────

function walkJsxRoute(
  routeEl: JsxNode,
  parentPath: string,
  routes: EnumeratedRoute[],
  skipped: SkippedRoute[],
  seen: Set<string>,
): void {
  const opening = routeEl.openingElement as JsxNode | undefined
  if (!opening) return

  const pathAttr = jsxAttr(opening, 'path')
  const rawPath = pathAttr ? jsxAttrStringValue(pathAttr) : undefined
  const indexAttr = jsxAttr(opening, 'index')
  const isIndex = !!indexAttr && jsxAttrIsTruthy(indexAttr)
  const hasElement = !!jsxAttr(opening, 'element') || !!jsxAttr(opening, 'Component')
  const hasLazy = !!jsxAttr(opening, 'lazy')
  const idAttr = jsxAttr(opening, 'id')
  const name = idAttr ? jsxAttrStringValue(idAttr) : undefined
  const childRoutes = childRouteElements(routeEl)

  if (rawPath === undefined && !isIndex) {
    // Pathless layout wrapper — recurse into children at the parent path.
    for (const c of childRoutes) walkJsxRoute(c, parentPath, routes, skipped, seen)
    return
  }

  const fullPath = isIndex ? parentPath : joinRoutePath(parentPath, rawPath as string)
  classify(fullPath, hasElement, hasLazy, childRoutes.length > 0, routes, skipped, seen, name)

  if (!isIndex) {
    for (const c of childRoutes) walkJsxRoute(c, fullPath, routes, skipped, seen)
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Enumerate the statically-navigable routes a React Router config declares —
 * the React sibling of {@link enumerateVueRoutes}. PURE (source in, route
 * list out). See the module doc for the two supported shapes and what's
 * deliberately unsupported.
 */
export function enumerateReactRoutes(ctx: ScaffoldRouteContext): EnumerateRoutesResult {
  let file: JsxNode
  try {
    file = parse(ctx.routerSource, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    }) as unknown as JsxNode
  } catch (err) {
    return { ok: false, reason: `enumerate: router file did not parse: ${(err as Error).message}` }
  }

  const dataRouterCalls = findDataRouterCalls(file)
  const routesElements = collect<JsxNode>(file, 'JSXElement').filter((el) =>
    isNamedJsxElement(el, 'Routes'),
  )

  if (dataRouterCalls.length > 1) {
    return {
      ok: false,
      reason:
        'enumerate: found multiple createBrowserRouter(...)-style calls in the router file. Ambiguous. The routing setup is unrecognized.',
    }
  }

  if (dataRouterCalls.length === 1) {
    const routesArr = resolveArrayArg(file, dataRouterCalls[0])
    if (!routesArr) {
      return {
        ok: false,
        reason:
          "enumerate: createBrowserRouter's routes argument is not a plain array literal (or a const bound to one). Likely file-based or dynamically-generated routing.",
      }
    }
    const routes: EnumeratedRoute[] = []
    const skipped: SkippedRoute[] = []
    const seen = new Set<string>()
    const err = walkObjectRoutes(file, routesArr, '', new Set(), routes, skipped, seen)
    if (err) return { ok: false, reason: err }
    return { ok: true, routes, skipped }
  }

  if (routesElements.length > 1) {
    return {
      ok: false,
      reason:
        'enumerate: found multiple <Routes> blocks in the router file. Ambiguous. Isolate the route declarations in one file, or register routes with createBrowserRouter(...) instead.',
    }
  }

  if (routesElements.length === 1) {
    const routes: EnumeratedRoute[] = []
    const skipped: SkippedRoute[] = []
    const seen = new Set<string>()
    for (const child of childRouteElements(routesElements[0])) {
      walkJsxRoute(child, '', routes, skipped, seen)
    }
    return { ok: true, routes, skipped }
  }

  return {
    ok: false,
    reason:
      'enumerate: could not find a createBrowserRouter(...)-style call or a <Routes> block in the router file. The routing setup is unrecognized.',
  }
}
