import { describe, expect, it } from 'vitest'

import { enumerateReactRoutes } from './scaffold-react-route'
import type { ScaffoldRouteContext } from '../core/route-scaffold'

const ROUTER_FILE = 'src/router.tsx'

function ctx(source: string, routerFile = ROUTER_FILE): ScaffoldRouteContext {
  return { routerSource: source, routerFile }
}

// ── Object form: createBrowserRouter([...]) ─────────────────────────────────

describe('enumerateReactRoutes — createBrowserRouter object form', () => {
  it('reads names (id) + paths from an inline routes array', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  { path: '/', id: 'home', element: <Home /> },
  { path: '/about', id: 'about', element: <About /> },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect(r.routes).toEqual([
      { path: '/', name: 'home' },
      { path: '/about', name: 'about' },
    ])
  })

  it('resolves a routes array bound to a top-level const', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const routes = [
  { path: '/', element: <Home /> },
  { path: '/about', element: <About /> },
]
const router = createBrowserRouter(routes)
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/', '/about'])
  })

  it('joins nested children onto the parent path and dedupes the index child', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  {
    path: '/settings',
    element: <SettingsLayout />,
    children: [
      { index: true, element: <SettingsHome /> },
      { path: 'profile', element: <Profile /> },
      { path: 'team', element: <Team /> },
    ],
  },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path)
    expect(paths).toEqual(['/settings', '/settings/profile', '/settings/team'])
  })

  it('skips dynamic + catch-all routes and reports them', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  { path: '/about', element: <About /> },
  { path: '/users/:id', element: <User /> },
  { path: '*', element: <NotFound /> },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
    const skippedPaths = (r.skipped ?? []).map((s) => s.path)
    expect(skippedPaths).toContain('/users/:id')
    expect(skippedPaths).toContain('/*')
  })

  it('does not emit a grouping parent that has no element of its own', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  {
    path: '/group',
    children: [{ path: 'a', element: <A /> }],
  },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/group/a'])
  })

  it('recurses through a pathless layout wrapper into its children', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/reports', element: <Reports /> },
    ],
  },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/dashboard', '/reports'])
  })

  it('skips lazy routes and reports them', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  { path: '/about', element: <About /> },
  { path: '/lazy', lazy: () => import('./lazy') },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
    const lazySkip = (r.skipped ?? []).find((s) => s.path === '/lazy')
    expect(lazySkip).toBeDefined()
    expect(lazySkip?.why).toMatch(/lazy/i)
  })

  it('expands a shared const route array spread under every parent that reuses it', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const childRoutes = [
  { path: 'overview', element: <Overview /> },
  { path: 'settings', element: <Settings /> },
]
const router = createBrowserRouter([
  { path: '/admin', element: <AdminLayout />, children: [...childRoutes] },
  { path: '/user', element: <UserLayout />, children: [...childRoutes] },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path).sort()
    expect(paths).toEqual([
      '/admin',
      '/admin/overview',
      '/admin/settings',
      '/user',
      '/user/overview',
      '/user/settings',
    ])
  })

  it('resolves a const-bound `children` array (not just inline arrays)', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const adminRoutes = [
  { path: 'overview', element: <Overview /> },
  { path: 'settings', element: <Settings /> },
]
const router = createBrowserRouter([
  { path: '/admin', element: <AdminLayout />, children: adminRoutes },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path)
    // Previously: children: adminRoutes resolved to undefined (only inline
    // ArrayExpression was handled) → the whole subtree was silently omitted.
    expect(paths).toEqual(['/admin', '/admin/overview', '/admin/settings'])
  })

  it('refuses (rather than silently dropping the subtree) when `children` is not resolvable', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter([
  { path: '/admin', element: <AdminLayout />, children: buildAdminRoutes() },
])
export default router`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/children/i)
    expect(r.reason).toMatch(/not a plain array/i)
  })

  it('refuses when there is no createBrowserRouter/<Routes> in the file', () => {
    const r = enumerateReactRoutes(ctx('export const routes = []'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/createBrowserRouter|<Routes>/i)
  })

  it('refuses when the routes argument is not a plain array literal', () => {
    const router = `import { createBrowserRouter } from 'react-router-dom'
const router = createBrowserRouter(buildRoutes())`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not a plain array/i)
  })

  it('refuses a router file that does not parse', () => {
    const r = enumerateReactRoutes(ctx('const x = {{{ not valid'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/did not parse/i)
  })
})

// ── JSX form: <Routes><Route path=... element=... /></Routes> ──────────────

describe('enumerateReactRoutes — <Routes>/<Route> JSX form', () => {
  it('reads paths from a flat <Routes> block', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/', '/about'])
  })

  it('joins nested <Route> children and dedupes the index child', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route index element={<SettingsHome />} />
        <Route path="profile" element={<Profile />} />
        <Route path="team" element={<Team />} />
      </Route>
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    const paths = (r.routes ?? []).map((x) => x.path)
    expect(paths).toEqual(['/settings', '/settings/profile', '/settings/team'])
  })

  it('recurses through a pathless layout <Route> wrapper into its children', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/reports" element={<Reports />} />
      </Route>
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/dashboard', '/reports'])
  })

  it('skips dynamic + catch-all <Route> paths and reports them', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/about" element={<About />} />
      <Route path="/users/:id" element={<User />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
    const skippedPaths = (r.skipped ?? []).map((s) => s.path)
    expect(skippedPaths).toContain('/users/:id')
    expect(skippedPaths).toContain('/*')
  })

  it('skips lazy <Route> elements and reports them', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/about" element={<About />} />
      <Route path="/lazy" lazy={() => import('./lazy')} />
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
    const lazySkip = (r.skipped ?? []).find((s) => s.path === '/lazy')
    expect(lazySkip).toBeDefined()
    expect(lazySkip?.why).toMatch(/lazy/i)
  })

  it('does not emit a grouping <Route> that has no element of its own', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/group">
        <Route path="a" element={<A />} />
      </Route>
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/group/a'])
  })

  it('recurses into a JSX fragment wrapping top-level <Route> elements', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </>
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    // Previously: <Routes>'s only child was the JSXFragment (not a <Route>
    // itself), so childRouteElements found nothing → zero routes.
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/', '/about'])
  })

  it('recurses into a JSX fragment wrapping nested <Route> children', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <>
          <Route path="profile" element={<Profile />} />
          <Route path="team" element={<Team />} />
        </>
      </Route>
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual([
      '/settings',
      '/settings/profile',
      '/settings/team',
    ])
  })

  it('reads a `path` given as a JSX expression container string literal', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <Routes>
      <Route path={'/about'} element={<About />} />
    </Routes>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    // Previously: path={'/about'} (StringLiteral inside a JSXExpressionContainer)
    // was read as undefined → treated as a pathless layout wrapper (dropped).
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
  })

  it('reads a `path` given as a no-substitution template literal', () => {
    const router = 'import { Routes, Route } from \'react-router-dom\'\n' +
      'export default function App() {\n' +
      '  return (\n' +
      '    <Routes>\n' +
      '      <Route path={`/about`} element={<About />} />\n' +
      '    </Routes>\n' +
      '  )\n' +
      '}'
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(true)
    expect((r.routes ?? []).map((x) => x.path)).toEqual(['/about'])
  })

  it('refuses when there are multiple <Routes> blocks (ambiguous)', () => {
    const router = `import { Routes, Route } from 'react-router-dom'
export default function App() {
  return (
    <div>
      <Routes><Route path="/a" element={<A />} /></Routes>
      <Routes><Route path="/b" element={<B />} /></Routes>
    </div>
  )
}`
    const r = enumerateReactRoutes(ctx(router))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/multiple/i)
  })
})
