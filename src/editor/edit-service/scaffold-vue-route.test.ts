import { describe, expect, it } from 'vitest'
import { babelParse } from '@vue/compiler-sfc'

import { enumerateVueRoutes, mapVueRouteComponents, scaffoldVueRoute } from './scaffold-vue-route'
import type { ScaffoldRouteContext } from '../core/route-scaffold'

const ROUTER_FILE = 'src/router/index.ts'

/** Dogfood-shaped router: a `const routes = [...]` plus a `createRouter` whose
 * inline `routes` array carries a redirect, a lazy route, and `...routes`. */
const DOGFOOD = `import { createRouter, createWebHistory } from 'vue-router'

import AIGatewayCreate from '../views/AIGatewayCreate.vue'

const routes = [
  {
    path: '/ai-gateway/create',
    name: 'ai-gateway-create',
    component: AIGatewayCreate
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/ai-gateway'
    },
    {
      path: '/proto-edit-demo',
      name: 'proto-edit-demo',
      component: () => import('../views/ProtoEditDemo.vue')
    },
    ...routes
  ]
})

export default router
`

function ctx(source: string, routerFile = ROUTER_FILE): ScaffoldRouteContext {
  return { routerSource: source, routerFile }
}

/** Assert the rewritten router still parses as valid TS. */
function assertParses(source: string): void {
  expect(() =>
    babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript'] as never,
    }),
  ).not.toThrow()
}

describe('scaffoldVueRoute', () => {
  it('inserts a lazy route as the first element of the inline createRouter array', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.componentName).toBe('About')
    expect(plan.routeName).toBe('about')
    expect(plan.routePath).toBe('/about')
    expect(plan.sfcPath).toBe('src/views/About.vue')
    // Lazy import — no separate import statement needed.
    expect(plan.routerSource).toContain(
      "component: () => import('../views/About.vue')",
    )
    expect(plan.routerSource).toContain("path: '/about'")
    // Inserted FIRST: appears before the existing redirect route.
    expect(plan.routerSource.indexOf("path: '/about'")).toBeLessThan(
      plan.routerSource.indexOf("redirect: '/ai-gateway'"),
    )
    // No extra import line added.
    expect(plan.routerSource).not.toContain("import About from")
    assertParses(plan.routerSource)
  })

  it('produces a minimal valid SFC with the heading', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.sfcContent).toContain('<template>')
    expect(plan.sfcContent).toContain('<h1>About</h1>')
    expect(plan.sfcContent).toContain('class="about-page"')
  })

  it('joins multi-segment paths into one component name + kebab route name', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: '/settings/profile' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.componentName).toBe('SettingsProfile')
    expect(plan.routeName).toBe('settings-profile')
    expect(plan.sfcPath).toBe('src/views/SettingsProfile.vue')
  })

  it('honors an explicit name + heading', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), {
      path: '/about',
      name: 'about-us',
      heading: 'About Our Team',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routeName).toBe('about-us')
    expect(plan.routerSource).toContain("name: 'about-us'")
    expect(plan.sfcContent).toContain('<h1>About Our Team</h1>')
  })

  it('escapes HTML in the heading', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: '/x', heading: '<script>&' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.sfcContent).toContain('&lt;script&gt;&amp;')
    expect(plan.sfcContent).not.toContain('<script>&')
  })

  it('normalizes a missing leading slash and a trailing slash', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: 'about/' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routePath).toBe('/about')
  })

  it('resolves routes via a `const routes` identifier reference', () => {
    const src = `import { createRouter, createWebHistory } from 'vue-router'
const routes = [
  { path: '/home', name: 'home', component: () => import('../views/Home.vue') }
]
const router = createRouter({ history: createWebHistory(), routes })
export default router
`
    const plan = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routerSource).toContain("path: '/about'")
    // Inserted into the const routes array, before /home.
    expect(plan.routerSource.indexOf("path: '/about'")).toBeLessThan(
      plan.routerSource.indexOf("path: '/home'"),
    )
    assertParses(plan.routerSource)
  })

  it('handles an empty routes array', () => {
    const src = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({ history: createWebHistory(), routes: [] })
export default router
`
    const plan = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routerSource).toContain("path: '/about'")
    assertParses(plan.routerSource)
  })

  it('detects a non-default RELATIVE views prefix (../pages/)', () => {
    const src = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/home', component: () => import('../pages/Home.vue') }
  ]
})
export default router
`
    const plan = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routerSource).toContain("import('../pages/About.vue')")
    expect(plan.sfcPath).toBe('src/pages/About.vue')
  })

  it('falls back to a relative ../views/ when the project only uses an alias prefix', () => {
    // An alias (@/pages/) can't be turned into a filesystem path by path math,
    // so import + created file must stay relative + consistent.
    const src = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/home', component: () => import('@/pages/Home.vue') }
  ]
})
export default router
`
    const plan = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // Relative import + relative-resolved file path agree (both via ../views/).
    expect(plan.routerSource).toContain("import('../views/About.vue')")
    expect(plan.sfcPath).toBe('src/views/About.vue')
    expect(plan.routerSource).not.toContain("import('@/pages/About.vue')")
  })

  it('refuses a path with characters that could break the string literal', () => {
    const r = scaffoldVueRoute(ctx(DOGFOOD), { path: "/x', evil: 1, '" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/valid in a route|characters/i)
  })

  it('sanitizes a caller-supplied name so it cannot inject into the literal', () => {
    const plan = scaffoldVueRoute(ctx(DOGFOOD), { path: '/about', name: "evil', x: 1, '" })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.routeName).toBe('evil-x-1')
    expect(plan.routerSource).toContain("name: 'evil-x-1'")
    // The injected `x: 1` must NOT appear as a real property.
    expect(plan.routerSource).not.toMatch(/name: 'evil', x: 1/)
    assertParses(plan.routerSource)
  })

  // ── Refusals ──────────────────────────────────────────────────────────────

  it('refuses a params-only / root path (no static segment)', () => {
    expect(scaffoldVueRoute(ctx(DOGFOOD), { path: '/' }).ok).toBe(false)
    expect(scaffoldVueRoute(ctx(DOGFOOD), { path: '/:id' }).ok).toBe(false)
    const r = scaffoldVueRoute(ctx(DOGFOOD), { path: '/' })
    if (!r.ok) expect(r.reason).toMatch(/no static segment/i)
  })

  it('refuses a duplicate path', () => {
    const r = scaffoldVueRoute(ctx(DOGFOOD), { path: '/proto-edit-demo' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/already exists/i)
  })

  it('refuses when there is no createRouter call', () => {
    const r = scaffoldVueRoute(ctx(`export const routes = []\n`), { path: '/about' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/createRouter/i)
  })

  it('refuses when there are multiple createRouter calls (ambiguous)', () => {
    const src = `import { createRouter, createWebHistory } from 'vue-router'
const a = createRouter({ history: createWebHistory(), routes: [] })
const b = createRouter({ history: createWebHistory(), routes: [] })
export default a
`
    const r = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/exactly one createRouter/i)
  })

  it('refuses dynamically-generated routes (routes is not an array literal)', () => {
    const src = `import { createRouter, createWebHistory } from 'vue-router'
import { setupLayouts } from 'virtual:generated-layouts'
import generatedRoutes from 'virtual:generated-pages'
const router = createRouter({
  history: createWebHistory(),
  routes: setupLayouts(generatedRoutes)
})
export default router
`
    const r = scaffoldVueRoute(ctx(src), { path: '/about' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/file-based|dynamically|not a plain array/i)
  })

  it('refuses a router file that does not parse', () => {
    const r = scaffoldVueRoute(ctx('const x = {{{ not valid'), { path: '/about' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/did not parse/i)
  })
})

describe('enumerateVueRoutes', () => {
  it('enumerates the dogfood-shaped router, skipping redirect + resolving `const routes`', () => {
    const r = enumerateVueRoutes(ctx(DOGFOOD))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path)
    // The `/` route is redirect-only → skipped; the lazy + `...routes` spread
    // route + the referenced `const routes` entry are enumerated.
    expect(paths).toContain('/proto-edit-demo')
    expect(paths).toContain('/ai-gateway/create')
    expect(paths).not.toContain('/')
    expect((r.skipped ?? []).some((s) => s.path === '/')).toBe(true)
    // Names come through when declared.
    expect(r.routes?.find((x) => x.path === '/proto-edit-demo')?.name).toBe(
      'proto-edit-demo',
    )
  })

  it('reads names + paths from an inline routes array', () => {
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/about', name: 'about', component: About },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect(r.routes).toEqual([
      { path: '/', name: 'home' },
      { path: '/about', name: 'about' },
    ])
  })

  it('joins nested children onto the parent path and dedupes the index child', () => {
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/settings',
      component: SettingsLayout,
      children: [
        { path: '', name: 'settings', component: SettingsHome },
        { path: 'profile', name: 'profile', component: Profile },
        { path: 'team', name: 'team', component: Team },
      ],
    },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path)
    // Index child ('') collapses to the parent path — deduped to a single entry.
    expect(paths).toEqual(['/settings', '/settings/profile', '/settings/team'])
  })

  it('skips dynamic + catch-all routes and reports them', () => {
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/about', name: 'about', component: About },
    { path: '/users/:id', name: 'user', component: User },
    { path: '/:pathMatch(.*)*', name: 'notfound', component: NotFound },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
    const skippedPaths = (r.skipped ?? []).map((s) => s.path)
    expect(skippedPaths).toContain('/users/:id')
    expect(skippedPaths.some((p) => p.includes('pathMatch') || p.includes('*'))).toBe(true)
  })

  it('does not emit a grouping parent that has no component of its own', () => {
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/group',
      children: [
        { path: 'a', name: 'a', component: A },
      ],
    },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    // The parent (no component, only children) is a container, not a page.
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/group/a'])
  })

  it('recurses through a pathless layout/group wrapper into its children', () => {
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      component: AppLayout,
      children: [
        { path: '/dashboard', name: 'dashboard', component: Dashboard },
        { path: '/reports', name: 'reports', component: Reports },
      ],
    },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/dashboard', '/reports'])
  })

  it('expands a shared `const` route array spread under EVERY parent that reuses it', () => {
    // A single `const childRoutes` spread under two different parents must
    // enumerate under BOTH — a global cycle guard would drop the second.
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const childRoutes = [
  { path: 'overview', name: 'overview', component: Overview },
  { path: 'settings', name: 'settings', component: Settings },
]
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/admin', component: AdminLayout, children: [...childRoutes] },
    { path: '/user', component: UserLayout, children: [...childRoutes] },
  ],
})
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path).sort()
    // The layout parents render (they carry a component), and the shared
    // children expand under BOTH parents.
    expect(paths).toEqual([
      '/admin',
      '/admin/overview',
      '/admin/settings',
      '/user',
      '/user/overview',
      '/user/settings',
    ])
  })

  it('breaks a genuine spread cycle without looping forever', () => {
    // `a` spreads `b`, `b` spreads `a` — the path-scoped guard must stop.
    const router = `import { createRouter, createWebHistory } from 'vue-router'
const a = [{ path: '/a', name: 'a', component: A }, ...b]
const b = [{ path: '/b', name: 'b', component: B }, ...a]
const router = createRouter({ history: createWebHistory(), routes: [...a] })
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path).sort()).toEqual(['/a', '/b'])
  })

  it('refuses when there is no createRouter call', () => {
    const r = enumerateVueRoutes(ctx('export const routes = []'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/createRouter/i)
  })

  it('refuses when routes is not a plain array literal', () => {
    const router = `import { createRouter } from 'vue-router'
const router = createRouter({ routes: buildRoutes() })
export default router`
    const r = enumerateVueRoutes(ctx(router))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not a plain array/i)
  })

  it('refuses a router file that does not parse', () => {
    const r = enumerateVueRoutes(ctx('const x = {{{ not valid'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/did not parse/i)
  })
})

// ── mapVueRouteComponents ────────────────────────────────────────────────────

/** Router mirroring the dogfood MCP-server shape: one identifier-imported view
 * backs TWO param routes (create + edit), plus a lazy route and a nested child. */
const COMPONENT_ROUTER = `import { createRouter, createWebHistory } from 'vue-router'

import AIGatewayMCPServerCreate from '../views/AIGatewayMCPServerCreate.vue'
import AIGatewayShell from '../views/AIGatewayShell.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/ai-gateway/:id/mcp-servers/create',
      name: 'ai-gateway-mcp-server-create',
      component: AIGatewayMCPServerCreate
    },
    {
      path: '/ai-gateway/:gatewayId/mcp-servers/:mcpServerId/edit',
      name: 'ai-gateway-mcp-server-edit',
      component: AIGatewayMCPServerCreate
    },
    {
      path: '/lazy',
      component: () => import('../views/LazyView.vue')
    },
    {
      path: '/ai-gateway/:id',
      component: AIGatewayShell,
      children: [
        { path: 'tools', component: () => import('../views/Tools.vue') }
      ]
    }
  ]
})

export default router
`

describe('mapVueRouteComponents', () => {
  const ctx = (source: string): ScaffoldRouteContext => ({
    routerSource: source,
    routerFile: ROUTER_FILE,
  })

  it('maps identifier-imported components for param routes (create + edit share a view)', () => {
    const r = mapVueRouteComponents(ctx(COMPONENT_ROUTER))
    expect(r.ok).toBe(true)
    const create = r.routes?.find((x) => x.path === '/ai-gateway/:id/mcp-servers/create')
    expect(create).toBeDefined()
    expect(create?.componentName).toBe('AIGatewayMCPServerCreate')
    expect(create?.importSpecifier).toBe('../views/AIGatewayMCPServerCreate.vue')

    // The same component backs a second (param) route — both must be kept.
    const edit = r.routes?.find(
      (x) => x.path === '/ai-gateway/:gatewayId/mcp-servers/:mcpServerId/edit',
    )
    expect(edit?.componentName).toBe('AIGatewayMCPServerCreate')
  })

  it('keeps lazy import() routes and resolves their specifier', () => {
    const r = mapVueRouteComponents(ctx(COMPONENT_ROUTER))
    const lazy = r.routes?.find((x) => x.path === '/lazy')
    expect(lazy?.importSpecifier).toBe('../views/LazyView.vue')
    expect(lazy?.componentName).toBeUndefined()
  })

  it('joins nested child paths and resolves child components', () => {
    const r = mapVueRouteComponents(ctx(COMPONENT_ROUTER))
    const tools = r.routes?.find((x) => x.path === '/ai-gateway/:id/tools')
    expect(tools?.importSpecifier).toBe('../views/Tools.vue')
  })

  it('refuses an unparseable router', () => {
    const r = mapVueRouteComponents(ctx('const x = {{{ not valid'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/did not parse/i)
  })
})
