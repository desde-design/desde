/**
 * Route-path string math shared by the per-framework route enumerators
 * (`scaffold-vue-route.ts`'s `enumerateVueRoutes`, `scaffold-react-route.ts`'s
 * `enumerateReactRoutes`). Pure, framework-neutral — Vue Router and React
 * Router v6 both use the same nested-route path-joining and `:param`/`*`
 * catch-all conventions, so this is one implementation instead of two copies.
 */

/** Join a child route path onto its parent. A child path starting with `/` is
 * absolute (replaces the parent); `''` is the index child (renders at the
 * parent path); otherwise it's relative (`parent/child`). Collapses `//` and
 * strips a trailing slash (except root). */
export function joinRoutePath(parent: string, child: string): string {
  let full: string
  if (child.startsWith('/')) full = child
  else if (child === '') full = parent
  else full = `${parent}/${child}`
  full = full.replace(/\/{2,}/g, '/')
  if (full.length > 1 && full.endsWith('/')) full = full.slice(0, -1)
  return full || '/'
}

/** A path segment is dynamic if it's a param (`:id`) or a catch-all (`*`,
 * `/:pathMatch(.*)*`). Such routes can't be navigated without a value. */
export function isDynamicPath(path: string): boolean {
  return path.split('/').some((seg) => seg.includes(':') || seg.includes('*'))
}
