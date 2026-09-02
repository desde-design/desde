/**
 * Route/page scaffolding — framework-NEUTRAL types (editor-creation-navigation.md
 * Phase 4). Creating a route is genuinely framework-specific (Vue Router vs.
 * React Router vs. file-based routing), so the *act* lives behind a concrete
 * per-framework planner; these types are the neutral contract between the
 * `scaffold_route` MCP tool and whichever planner runs.
 *
 * Per the product-positioning rule (CLAUDE.md): substrate specifics stay behind
 * a named seam with one concrete impl per framework. The Vue 3 + Vue Router
 * planner is `src/editor/edit-service/scaffold-vue-route.ts`.
 *
 * Note this is a SOURCE-MUTATION seam (server-side, filesystem + AST), distinct
 * from the browser-side `FrameworkAdapter` (the bridge client). They are
 * different surfaces — the bridge adapter has no filesystem — so route
 * scaffolding gets its own neutral type rather than overloading that one.
 *
 * The planner is PURE: it takes source text in and returns the rewritten router
 * source + the new page's path/content, or a refusal. All I/O (locating the
 * router file, writing, committing) is the handler's job — mirroring the
 * deterministic edit applicators in `edit-service/`.
 */

/** What the caller (agent) asks for. */
export interface ScaffoldRouteRequest {
  /**
   * The route path to register, e.g. `/about` or `/settings/profile`. Must
   * contain at least one static (non-parameter) segment so a component name
   * can be derived; a bare `/` or a params-only path (`/:id`) is refused.
   */
  path: string
  /** Optional route `name`. Derived from the path when omitted (e.g. `about`). */
  name?: string
  /** Optional `<h1>` heading for the scaffolded page. Defaults to the humanized component name. */
  heading?: string
}

/** A successful plan: the rewritten router + the new page to create. */
export interface ScaffoldRoutePlanOk {
  ok: true
  /** Full rewritten source of the router file (route registered). */
  routerSource: string
  /** Repo-relative path of the new page SFC to create. */
  sfcPath: string
  /** Full content of the new page SFC. */
  sfcContent: string
  /** The PascalCase component name derived for the page. */
  componentName: string
  /** The resolved route `name`. */
  routeName: string
  /** The (normalized) route path that was registered. */
  routePath: string
}

export interface ScaffoldRoutePlanErr {
  ok: false
  /** Human-facing reason the scaffold was refused (surfaced to the agent). */
  reason: string
}

export type ScaffoldRoutePlan = ScaffoldRoutePlanOk | ScaffoldRoutePlanErr

/** Inputs a concrete planner needs beyond the request. */
export interface ScaffoldRouteContext {
  /** Full source text of the router config file. */
  routerSource: string
  /**
   * Repo-relative path of the router file (e.g. `src/router/index.ts`). Used to
   * resolve the new SFC's location against the views convention the router
   * already uses, and to compute the SFC's repo-relative path.
   */
  routerFile: string
}

/** A framework-specific route planner. One concrete impl per framework. */
export interface RouteScaffolder {
  /** Framework id this planner serves (e.g. `vue3`). */
  framework: string
  /** Produce a plan (rewritten router + new SFC), or a refusal. Pure. */
  plan(ctx: ScaffoldRouteContext, request: ScaffoldRouteRequest): ScaffoldRoutePlan
}

// ── Route enumeration (read existing routes) ────────────────────────────────
// The inverse of scaffolding: instead of registering a new route, read out the
// routes the router ALREADY declares. Used by route-enumeration screenshot
// plans (tasks/editor-screenshot-flows.md Phase 1) to "snapshot all my
// screens" with zero LLM. Reuses the same neutral `ScaffoldRouteContext` (the
// router source + path); the act of parsing routes is framework-specific, so it
// lives behind its own per-framework `RouteEnumerator` (Vue 3 + Vue Router impl
// is `enumerateVueRoutes` in `edit-service/scaffold-vue-route.ts`). Pure: source
// in, route list out — locating/reading the router file is the caller's I/O.

/** A statically-navigable route declared by the router. */
export interface EnumeratedRoute {
  /** Full route path, parent+child joined (e.g. `/settings/profile`). */
  path: string
  /** The route `name`, when the router declares one. */
  name?: string
}

/** A route the enumerator deliberately skipped, with a human-facing reason. */
export interface SkippedRoute {
  path: string
  why: string
}

export interface EnumerateRoutesResult {
  ok: boolean
  /** Human-facing reason when `ok` is false (ambiguous / unparseable router). */
  reason?: string
  /** Statically-navigable routes (no params / catch-all / redirect-only). */
  routes?: EnumeratedRoute[]
  /** Routes intentionally omitted (dynamic, catch-all, redirect) + why. */
  skipped?: SkippedRoute[]
}

/** A framework-specific route enumerator. One concrete impl per framework. */
export interface RouteEnumerator {
  /** Framework id this enumerator serves (e.g. `vue3`). */
  framework: string
  /** Read the routes the router declares, or refuse. Pure. */
  enumerate(ctx: ScaffoldRouteContext): EnumerateRoutesResult
}

// ── Route → component mapping ────────────────────────────────────────────────
// A third read over the same router source (alongside scaffold + enumerate):
// instead of "what routes exist" it answers "which component renders each
// route" — INCLUDING dynamic/param routes, which enumeration deliberately drops.
// Used by selector→route resolution (the capture_screenshot auto-navigate
// recovery): grep a selector to the SFC that defines it, then find the route
// whose component is — or transitively renders — that SFC. Framework-specific
// (Vue Router import + route parsing), so it lives behind this seam with one
// concrete impl per framework (`mapVueRouteComponents`).

/** A route paired with the component that renders it. */
export interface RouteComponentRef {
  /**
   * Full route path pattern, parent+child joined — MAY contain `:params`
   * (e.g. `/ai-gateway/:id/mcp-servers/create`). Unlike {@link EnumeratedRoute},
   * dynamic routes are kept: the caller fills params from the live URL.
   */
  path: string
  /** The route `name`, when the router declares one. */
  name?: string
  /** Component identifier referenced (e.g. `AIGatewayMCPServerCreate`), when the
   *  route uses `component: SomeIdentifier`. */
  componentName?: string
  /**
   * Raw module specifier for the component, when derivable — the lazy
   * `() => import('…')` arg, or the top-of-file import the identifier resolves
   * to. The caller matches it to an SFC by basename (no alias resolution).
   */
  importSpecifier?: string
}

export interface RouteComponentMapResult {
  ok: boolean
  /** Human-facing reason when `ok` is false (unparseable / unrecognized router). */
  reason?: string
  /** Every route that renders a component, dynamic routes included. */
  routes?: RouteComponentRef[]
}

/** A framework-specific route→component mapper. One concrete impl per framework. */
export interface RouteComponentMapper {
  /** Framework id this mapper serves (e.g. `vue3`). */
  framework: string
  /** Map each route to its rendering component, or refuse. Pure. */
  map(ctx: ScaffoldRouteContext): RouteComponentMapResult
}
