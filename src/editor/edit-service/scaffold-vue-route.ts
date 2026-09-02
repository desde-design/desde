/**
 * Vue 3 + Vue Router route scaffolder (editor-creation-navigation.md Phase 4).
 *
 * PURE (filesystem-free): given the router file's source + a request, returns
 * the rewritten router source + a new page SFC to create — or a graceful
 * refusal. All I/O (locating/reading/writing the router, creating the SFC,
 * committing) is the `scaffold_route` handler's job, mirroring the deterministic
 * edit applicators in this directory.
 *
 * Strategy: parse the router with `@vue/compiler-sfc`'s Babel parser, locate the
 * single `createRouter({ routes })` call, resolve `routes` to its array literal
 * (inline, or a `const routes = [...]` it references), and splice a new route
 * record as the FIRST element. We use a LAZY component import
 * (`component: () => import('../views/X.vue')`) so NO separate top-of-file
 * import statement is needed — the edit touches exactly one location. Inserting
 * first keeps the new (specific) route ahead of any trailing catch-all.
 *
 * Refuses (returns `{ ok: false }`) rather than guess when:
 *  - the path has no static segment to name a component after (`/`, `/:id`);
 *  - there isn't exactly one `createRouter(...)` call;
 *  - `routes` isn't an array literal or a `const` bound to one (file-based /
 *    dynamically-generated routing);
 *  - a route with the same path already exists.
 */
import { babelParse } from '@vue/compiler-sfc'
import { posix as pathPosix } from 'node:path'
import type {
  ArrayExpression,
  CallExpression,
  File,
  Node,
  ObjectExpression,
  ObjectProperty,
  SpreadElement,
} from '@babel/types'

import type {
  EnumeratedRoute,
  EnumerateRoutesResult,
  RouteComponentMapResult,
  RouteComponentRef,
  ScaffoldRouteContext,
  ScaffoldRoutePlan,
  ScaffoldRouteRequest,
  SkippedRoute,
} from '../core/route-scaffold'
import { isDynamicPath, joinRoutePath } from './route-path-utils'

/** Recursively collect every node of a given `type`. Hand-rolled to avoid the
 * heavy `@babel/traverse` dependency (same approach as array-literal-rewriter). */
function collect<T extends Node>(root: unknown, type: string): T[] {
  const out: T[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string }
    if (n.type === type) out.push(node as T)
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
      const v = (n as Record<string, unknown>)[key]
      if (Array.isArray(v)) {
        for (const item of v) visit(item)
      } else if (v && typeof v === 'object') {
        visit(v)
      }
    }
  }
  visit(root)
  return out
}

/** Read an ObjectProperty's key name (Identifier or StringLiteral). */
function propName(prop: ObjectProperty): string | undefined {
  const k = prop.key as { type?: string; name?: string; value?: unknown }
  if (k.type === 'Identifier') return k.name
  if (k.type === 'StringLiteral') return k.value as string
  return undefined
}

/** Read an ObjectProperty's string-literal value, if it is one. */
function stringValueOf(prop: ObjectProperty): string | undefined {
  const v = prop.value as { type?: string; value?: unknown }
  return v.type === 'StringLiteral' ? (v.value as string) : undefined
}

/** Find the `createRouter(...)` call (callee Identifier `createRouter`, or a
 * member expression ending in `.createRouter`). Returns null on 0 or >1. */
function findCreateRouter(file: File): CallExpression | null {
  const calls = collect<CallExpression>(file, 'CallExpression').filter((c) => {
    const callee = c.callee as { type?: string; name?: string; property?: { name?: string } }
    if (callee.type === 'Identifier') return callee.name === 'createRouter'
    if (callee.type === 'MemberExpression') return callee.property?.name === 'createRouter'
    return false
  })
  return calls.length === 1 ? calls[0] : null
}

/** Resolve the `routes:` value to its backing array literal — inline, or via a
 * `const routes = [...]` the property references. */
function resolveRoutesArray(file: File, createRouter: CallExpression): ArrayExpression | null {
  const arg = createRouter.arguments[0]
  if (!arg || arg.type !== 'ObjectExpression') return null
  const routesProp = (arg as ObjectExpression).properties.find(
    (p): p is ObjectProperty => p.type === 'ObjectProperty' && propName(p) === 'routes',
  )
  if (!routesProp) return null
  const value = routesProp.value as { type?: string; name?: string }
  if (value.type === 'ArrayExpression') return routesProp.value as ArrayExpression
  if (value.type === 'Identifier') {
    // Find a top-level `const <name> = [ ... ]` declarator.
    const decls = collect<Node & { id?: { name?: string }; init?: Node }>(
      file,
      'VariableDeclarator',
    )
    for (const d of decls) {
      if (d.id?.name === value.name && d.init?.type === 'ArrayExpression') {
        return d.init as ArrayExpression
      }
    }
  }
  return null
}

/** PascalCase the static (non-param) path segments, joined. `/settings/profile`
 * → `SettingsProfile`; `/about` → `About`. Returns '' when nothing usable. */
function deriveComponentName(path: string): string {
  return staticSegments(path)
    .map((s) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim())
    .flatMap((s) => s.split(' '))
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

/** kebab-case route name from the static segments. `/settings/profile` →
 * `settings-profile`. */
function deriveRouteName(path: string): string {
  return staticSegments(path)
    .map((s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase())
    .filter(Boolean)
    .join('-')
}

/** Static (non-parameter, non-empty) path segments. */
function staticSegments(path: string): string[] {
  return path
    .split('/')
    .filter((seg) => seg.length > 0 && !seg.startsWith(':') && !seg.startsWith('*'))
}

/** Humanize a PascalCase name for a heading: `SettingsProfile` → `Settings Profile`. */
function humanize(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

/** Escape text for safe interpolation into HTML/template content. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Detect the RELATIVE views-dir prefix the router already uses for component
 * specifiers (e.g. `../views/`). Only relative (`./`, `../`) prefixes are
 * trusted: the SFC's on-disk path is computed by joining this against the router
 * dir, so an ALIAS prefix (`@/pages/`) or a bare specifier can't be turned into
 * a filesystem path by path math (the alias target isn't known here) — using it
 * would create the file in the wrong place while the import still resolved via
 * the alias. In those cases we fall back to a relative `../views/`, keeping the
 * import specifier and the created file CONSISTENT (both relative) so the page
 * always resolves, even if it doesn't honor the project's alias convention. */
function detectViewsPrefix(source: string): string {
  // Match `from '<prefix>X.vue'` and `import('<prefix>X.vue')`.
  const re = /(?:from\s*|import\(\s*)['"]([^'"]*\/)[A-Za-z0-9_]+\.vue['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const prefix = m[1]
    if (prefix && (prefix.startsWith('./') || prefix.startsWith('../'))) return prefix
  }
  return '../views/'
}

/** 1-based line/col-free byte offset of a node's start. */
function startOf(node: Node): number | null {
  const s = (node as unknown as { start?: number }).start
  return typeof s === 'number' ? s : null
}

export function scaffoldVueRoute(
  ctx: ScaffoldRouteContext,
  request: ScaffoldRouteRequest,
): ScaffoldRoutePlan {
  const rawPath = (request.path ?? '').trim()
  if (!rawPath) return { ok: false, reason: 'scaffold: route path is required.' }
  // Normalize: ensure a single leading slash, strip a trailing slash (not root).
  let routePath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (routePath.length > 1 && routePath.endsWith('/')) routePath = routePath.slice(0, -1)

  // The path is spliced into the router source as a single-quoted string
  // (`path: '<routePath>'`). Restrict it to characters that legitimately appear
  // in a route path so a quote/backslash/newline can't break out of the literal
  // and inject code into the .ts file. (vue-router paths are this charset.)
  if (!/^\/[A-Za-z0-9\-_/:.~%()*]*$/.test(routePath)) {
    return {
      ok: false,
      reason: `scaffold: route path '${routePath}' contains characters that aren't valid in a route. Use letters, digits, and / - _ : . only.`,
    }
  }

  const componentName = deriveComponentName(routePath)
  if (!componentName) {
    return {
      ok: false,
      reason: `scaffold: cannot derive a page name from '${routePath}': it has no static segment (e.g. '/' or '/:id'). Provide a path with a named segment like '/about'.`,
    }
  }
  // Sanitize any caller-supplied name to a safe identifier-ish token (same
  // reason as the path: it's spliced into `name: '<routeName>'`). Falls back to
  // the path-derived kebab name when empty/absent.
  const requestedName = (request.name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  const routeName = requestedName || deriveRouteName(routePath)
  const heading = (request.heading ?? '').trim() || humanize(componentName)

  let file: File
  try {
    file = babelParse(ctx.routerSource, {
      sourceType: 'module',
      plugins: ['typescript'] as unknown as Parameters<typeof babelParse>[1] extends {
        plugins?: infer P
      }
        ? P
        : never,
    }) as unknown as File
  } catch (err) {
    return { ok: false, reason: `scaffold: router file did not parse: ${(err as Error).message}` }
  }

  // Duplicate-path guard: scan ALL route-object literals in the file (covers
  // the inline createRouter array AND a referenced `const routes`).
  const dup = collect<ObjectExpression>(file, 'ObjectExpression').some((obj) =>
    obj.properties.some(
      (p) => p.type === 'ObjectProperty' && propName(p) === 'path' && stringValueOf(p) === routePath,
    ),
  )
  if (dup) {
    return {
      ok: false,
      reason: `scaffold: a route with path '${routePath}' already exists. Pick a different path or edit the existing page.`,
    }
  }

  const createRouter = findCreateRouter(file)
  if (!createRouter) {
    return {
      ok: false,
      reason: 'scaffold: could not find exactly one createRouter(...) call in the router file. The routing setup is unrecognized. Register the route manually with Edit.',
    }
  }
  const routesArr = resolveRoutesArray(file, createRouter)
  if (!routesArr) {
    return {
      ok: false,
      reason: "scaffold: createRouter's `routes` is not a plain array literal (or a const bound to one): likely file-based or dynamically-generated routing. Register the route manually with Edit.",
    }
  }
  const arrStart = startOf(routesArr)
  if (arrStart === null) {
    return { ok: false, reason: 'scaffold: could not locate the routes array in source.' }
  }

  // Build the new SFC's import specifier + repo-relative path from the router's
  // own views convention.
  const viewsPrefix = detectViewsPrefix(ctx.routerSource)
  const importSpec = `${viewsPrefix}${componentName}.vue`
  // Resolve the SFC's repo-relative path: routerDir + viewsPrefix + Name.vue.
  const routerDir = pathPosix.dirname(ctx.routerFile)
  const sfcPath = pathPosix.normalize(pathPosix.join(routerDir, viewsPrefix, `${componentName}.vue`))

  // Determine element indentation. Prefer the first existing element's column;
  // else derive from the `[` line indent + 2 spaces.
  const source = ctx.routerSource
  let elemIndent: string
  const firstEl = routesArr.elements.find((e) => e != null)
  const firstElStart = firstEl ? startOf(firstEl as unknown as Node) : null
  if (firstElStart !== null) {
    const lineStart = source.lastIndexOf('\n', firstElStart - 1) + 1
    elemIndent = source.slice(lineStart, firstElStart).match(/^[ \t]*/)?.[0] ?? '    '
  } else {
    const lineStart = source.lastIndexOf('\n', arrStart - 1) + 1
    const arrIndent = source.slice(lineStart, arrStart).match(/^[ \t]*/)?.[0] ?? '  '
    elemIndent = `${arrIndent}  `
  }
  const propIndent = `${elemIndent}  `

  const entry =
    `{\n` +
    `${propIndent}path: '${routePath}',\n` +
    `${propIndent}name: '${routeName}',\n` +
    `${propIndent}component: () => import('${importSpec}'),\n` +
    `${elemIndent}}`

  let routerSource: string
  if (firstElStart !== null) {
    // Insert as the first element: entry + comma + newline + indent, before it.
    routerSource =
      source.slice(0, firstElStart) + `${entry},\n${elemIndent}` + source.slice(firstElStart)
  } else {
    // Empty array: insert between `[` and `]`.
    const open = source.indexOf('[', arrStart)
    if (open < 0) {
      return { ok: false, reason: 'scaffold: malformed routes array (no opening bracket).' }
    }
    const closeIndent = elemIndent.slice(0, -2)
    routerSource =
      source.slice(0, open + 1) +
      `\n${elemIndent}${entry},\n${closeIndent}` +
      source.slice(open + 1)
  }

  const kebab = routeName || componentName.toLowerCase()
  const sfcContent =
    `<template>\n` +
    `  <div class="${kebab}-page">\n` +
    `    <h1>${escapeHtml(heading)}</h1>\n` +
    `  </div>\n` +
    `</template>\n`

  return {
    ok: true,
    routerSource,
    sfcPath,
    sfcContent,
    componentName,
    routeName,
    routePath,
  }
}

// ── Route enumeration ───────────────────────────────────────────────────────

/** Read an ObjectProperty's array-literal value, if it is one. */
function arrayValueOf(prop: ObjectProperty): ArrayExpression | undefined {
  const v = prop.value as { type?: string }
  return v.type === 'ArrayExpression' ? (prop.value as ArrayExpression) : undefined
}

/** Resolve a top-level `const <name> = [ ... ]` to its array literal. */
function resolveConstArray(file: File, name: string): ArrayExpression | undefined {
  const decls = collect<Node & { id?: { name?: string }; init?: Node }>(
    file,
    'VariableDeclarator',
  )
  for (const d of decls) {
    if (d.id?.name === name && d.init?.type === 'ArrayExpression') {
      return d.init as ArrayExpression
    }
  }
  return undefined
}

/** Whether a route-object literal declares a given property by name. */
function hasProp(obj: ObjectExpression, name: string): boolean {
  return obj.properties.some(
    (p) => p.type === 'ObjectProperty' && propName(p) === name,
  )
}

/** Find a route-object's property by name (ObjectProperty only). */
function findProp(obj: ObjectExpression, name: string): ObjectProperty | undefined {
  return obj.properties.find(
    (p): p is ObjectProperty => p.type === 'ObjectProperty' && propName(p) === name,
  )
}

/**
 * Enumerate the statically-navigable routes a Vue Router config declares —
 * the read counterpart to {@link scaffoldVueRoute}. PURE (source in, route list
 * out). Reuses the same parse + array-resolution as the scaffolder.
 *
 * Walks the routes array recursively, joining parent+child paths. Emits a route
 * for every node that renders something (`component`/`components`) or is a bare
 * leaf; recurses into `children` regardless. Skips (and reports) dynamic /
 * catch-all routes and redirect-only nodes — they aren't snapshot-able pages.
 * Pure grouping parents (no component, only children) aren't emitted as pages
 * but their children are. Dedupes by full path (first wins).
 *
 * Refuses (mirrors the scaffolder) when the router doesn't parse, has 0/>1
 * `createRouter(...)`, or `routes` isn't a plain array literal.
 */
export function enumerateVueRoutes(ctx: ScaffoldRouteContext): EnumerateRoutesResult {
  let file: File
  try {
    file = babelParse(ctx.routerSource, {
      sourceType: 'module',
      plugins: ['typescript'] as unknown as Parameters<typeof babelParse>[1] extends {
        plugins?: infer P
      }
        ? P
        : never,
    }) as unknown as File
  } catch (err) {
    return { ok: false, reason: `enumerate: router file did not parse: ${(err as Error).message}` }
  }

  const createRouter = findCreateRouter(file)
  if (!createRouter) {
    return {
      ok: false,
      reason: 'enumerate: could not find exactly one createRouter(...) call in the router file. The routing setup is unrecognized.',
    }
  }
  const routesArr = resolveRoutesArray(file, createRouter)
  if (!routesArr) {
    return {
      ok: false,
      reason: "enumerate: createRouter's `routes` is not a plain array literal (or a const bound to one): likely file-based or dynamically-generated routing.",
    }
  }

  const routes: EnumeratedRoute[] = []
  const skipped: SkippedRoute[] = []
  const seen = new Set<string>()

  // `expanding` is the set of const-array spread names currently on THIS
  // recursion path — a path-scoped cycle guard, not a global one. It prevents
  // genuine cycles (`const a = [...b]; const b = [...a]`) from looping forever,
  // while still letting a shared array (`const childRoutes`) spread under
  // multiple parents (`/admin/[...childRoutes]` AND `/user/[...childRoutes]`)
  // be expanded once per parent — a global set would silently drop the second.
  const walk = (
    arr: ArrayExpression,
    parentPath: string,
    expanding: ReadonlySet<string>,
  ): void => {
    for (const el of arr.elements) {
      if (!el) continue
      // Expand `...routes` spreads that reference a top-level const array, so a
      // router whose inline `routes` array spreads a shared list (the dogfood
      // shape) still enumerates those records.
      if (el.type === 'SpreadElement') {
        const arg = (el as SpreadElement).argument
        if (arg.type === 'Identifier' && !expanding.has(arg.name)) {
          const resolved = resolveConstArray(file, arg.name)
          if (resolved) walk(resolved, parentPath, new Set(expanding).add(arg.name))
        }
        continue
      }
      if (el.type !== 'ObjectExpression') continue
      const obj = el as ObjectExpression
      const pathProp = findProp(obj, 'path')
      const rawPath = pathProp ? stringValueOf(pathProp) : undefined
      if (rawPath === undefined) {
        // A pathless route is a layout / group wrapper — no page of its own,
        // but its children (which carry their own, usually absolute, paths)
        // are still navigable. Recurse with the parent path unchanged. A
        // record with neither a string `path` nor children (computed/spread
        // leaf) is skipped silently.
        const cp = findProp(obj, 'children')
        const ch = cp ? arrayValueOf(cp) : undefined
        if (ch) walk(ch, parentPath, expanding)
        continue
      }

      const fullPath = joinRoutePath(parentPath, rawPath)
      const childrenProp = findProp(obj, 'children')
      const children = childrenProp ? arrayValueOf(childrenProp) : undefined
      const rendersSomething = hasProp(obj, 'component') || hasProp(obj, 'components')
      const isRedirect = hasProp(obj, 'redirect')

      // Categorize: a redirect with no page of its own is skipped; a node that
      // renders or is a bare leaf is a page candidate (skipped if its path is
      // dynamic, else emitted); a pure grouping parent (only children) emits
      // nothing itself but we still recurse into its children below.
      const isRedirectOnly = isRedirect && !rendersSomething && !children
      const isPageCandidate = !isRedirectOnly && (rendersSomething || !children)

      if (isRedirectOnly) {
        skipped.push({ path: fullPath, why: 'redirect-only route: no page of its own' })
      } else if (isPageCandidate) {
        if (isDynamicPath(fullPath)) {
          skipped.push({ path: fullPath, why: 'dynamic / catch-all route: needs a param value' })
        } else if (!seen.has(fullPath)) {
          seen.add(fullPath)
          const nameProp = findProp(obj, 'name')
          const name = nameProp ? stringValueOf(nameProp) : undefined
          routes.push(name ? { path: fullPath, name } : { path: fullPath })
        }
      }

      if (children) walk(children, fullPath, expanding)
    }
  }

  walk(routesArr, '', new Set())

  return { ok: true, routes, skipped }
}

// ── Route → component mapping ────────────────────────────────────────────────

/** Build `localName → module specifier` from the file's top-level imports.
 * `import X from '../views/X.vue'` → `{ X: '../views/X.vue' }`. Covers default,
 * named, and namespace specifiers (route components are almost always default). */
function buildImportMap(file: File): Record<string, string> {
  const map: Record<string, string> = {}
  const decls = collect<
    Node & { source?: { value?: string }; specifiers?: Array<{ local?: { name?: string } }> }
  >(file, 'ImportDeclaration')
  for (const d of decls) {
    const source = d.source?.value
    if (typeof source !== 'string') continue
    for (const spec of d.specifiers ?? []) {
      const local = spec.local?.name
      if (local) map[local] = source
    }
  }
  return map
}

/**
 * Resolve a route's `component:` value to a component reference. Handles the two
 * shapes that appear in practice: a top-imported identifier
 * (`component: AIGatewayMCPServerCreate`) and a lazy import
 * (`component: () => import('../views/X.vue')`, also inside
 * `defineAsyncComponent(...)`). Returns undefined when neither is present.
 */
function componentRefOf(
  value: Node,
  importMap: Record<string, string>,
): { componentName?: string; importSpecifier?: string } | undefined {
  if ((value as { type?: string }).type === 'Identifier') {
    const name = (value as { name?: string }).name
    if (name) return { componentName: name, importSpecifier: importMap[name] }
  }
  // Lazy import: find the `import('…')` call anywhere in the value subtree.
  const calls = collect<CallExpression>(value, 'CallExpression')
  for (const c of calls) {
    if ((c.callee as { type?: string }).type !== 'Import') continue
    const arg = c.arguments[0] as { type?: string; value?: unknown } | undefined
    if (arg?.type === 'StringLiteral' && typeof arg.value === 'string') {
      return { importSpecifier: arg.value }
    }
  }
  return undefined
}

/**
 * Map each route a Vue Router config declares to the component that renders it —
 * the third read over the router source (alongside {@link scaffoldVueRoute} and
 * {@link enumerateVueRoutes}). PURE.
 *
 * Unlike enumeration, this KEEPS dynamic/param routes (the caller fills params
 * from the live URL) and resolves the rendering component (identifier → import,
 * or lazy `() => import()`). Routes with no resolvable component are omitted
 * (they can't be matched to a source file). Walks parent→child joining paths and
 * expands `...const` spreads, exactly like the enumerator.
 *
 * Refuses (mirrors the others) when the router doesn't parse, has 0/>1
 * `createRouter(...)`, or `routes` isn't a plain array literal.
 */
export function mapVueRouteComponents(ctx: ScaffoldRouteContext): RouteComponentMapResult {
  let file: File
  try {
    file = babelParse(ctx.routerSource, {
      sourceType: 'module',
      plugins: ['typescript'] as unknown as Parameters<typeof babelParse>[1] extends {
        plugins?: infer P
      }
        ? P
        : never,
    }) as unknown as File
  } catch (err) {
    return { ok: false, reason: `map: router file did not parse: ${(err as Error).message}` }
  }

  const createRouter = findCreateRouter(file)
  if (!createRouter) {
    return {
      ok: false,
      reason: 'map: could not find exactly one createRouter(...) call in the router file.',
    }
  }
  const routesArr = resolveRoutesArray(file, createRouter)
  if (!routesArr) {
    return {
      ok: false,
      reason: "map: createRouter's `routes` is not a plain array literal (or a const bound to one).",
    }
  }

  const importMap = buildImportMap(file)
  const routes: RouteComponentRef[] = []
  const seen = new Set<string>()

  const walk = (
    arr: ArrayExpression,
    parentPath: string,
    expanding: ReadonlySet<string>,
  ): void => {
    for (const el of arr.elements) {
      if (!el) continue
      if (el.type === 'SpreadElement') {
        const arg = (el as SpreadElement).argument
        if (arg.type === 'Identifier' && !expanding.has(arg.name)) {
          const resolved = resolveConstArray(file, arg.name)
          if (resolved) walk(resolved, parentPath, new Set(expanding).add(arg.name))
        }
        continue
      }
      if (el.type !== 'ObjectExpression') continue
      const obj = el as ObjectExpression
      const pathProp = findProp(obj, 'path')
      const rawPath = pathProp ? stringValueOf(pathProp) : undefined
      if (rawPath === undefined) {
        // Pathless group/layout — recurse into children at the parent path.
        const cp = findProp(obj, 'children')
        const ch = cp ? arrayValueOf(cp) : undefined
        if (ch) walk(ch, parentPath, expanding)
        continue
      }

      const fullPath = joinRoutePath(parentPath, rawPath)
      const componentProp = findProp(obj, 'component')
      if (componentProp && !seen.has(fullPath)) {
        const ref = componentRefOf(componentProp.value as Node, importMap)
        if (ref && (ref.componentName || ref.importSpecifier)) {
          seen.add(fullPath)
          const nameProp = findProp(obj, 'name')
          const name = nameProp ? stringValueOf(nameProp) : undefined
          routes.push({ path: fullPath, ...(name ? { name } : {}), ...ref })
        }
      }

      const childrenProp = findProp(obj, 'children')
      const children = childrenProp ? arrayValueOf(childrenProp) : undefined
      if (children) walk(children, fullPath, expanding)
    }
  }

  walk(routesArr, '', new Set())

  return { ok: true, routes }
}
