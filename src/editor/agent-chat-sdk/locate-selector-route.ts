/**
 * Selector → route resolution for the `capture_screenshot` auto-navigate
 * recovery (editor-tool-handlers.ts). When a `scope:'selector'` capture
 * reports `no-match` — the element isn't in the current page's DOM — this finds
 * WHERE it lives so the tool can navigate there and retry, instead of erroring.
 *
 * The chain (all worktree-source, no LLM):
 *   1. Reduce the selector to a class/id token and grep the worktree's `.vue`
 *      files for the SFC(s) that define it.
 *   2. Parse the router (`mapVueRouteComponents`) into route→component refs,
 *      param routes included.
 *   3. Match the SFC to a route — directly (the SFC *is* the routed view), or
 *      one level up (a routed view imports the SFC, the common nested-form case).
 *   4. Fill any `:params` in the candidate route from the CURRENT live URL by
 *      positional alignment (a create form `/ai-gateway/:id/mcp-servers/create`
 *      borrows `:id` from a current `/ai-gateway/<id>/mcp-servers`). Routes whose
 *      params can't be filled are returned for the error but not as navigable.
 *
 * Framework-specific parsing stays behind the Vue seam (`mapVueRouteComponents`,
 * `locateRouterFile`); this module is the neutral orchestration + filesystem I/O.
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename as pathBasename, join as pathJoin, relative as pathRelative } from 'node:path'

import { locateRouterFile } from '../agent-tools/locate-router-file'
import { mapVueRouteComponents } from '../edit-service/scaffold-vue-route'

export interface LocateSelectorRouteResult {
  ok: boolean
  /** Why resolution couldn't proceed (no token, no source match, unparseable router). */
  reason?: string
  /** Worktree-relative SFC paths where the selector token appears. */
  sourceFiles: string[]
  /** Candidate routes that render those SFCs (path may contain `:params`). */
  routes: Array<{ path: string; name?: string }>
  /** Concrete navigable URLs (params filled from `currentUrl`); subset of `routes`. */
  navigableUrls: string[]
}

export interface LocateSelectorRouteInput {
  /** Absolute worktree root (the edit session's branch). */
  worktreeRoot: string
  /** The CSS selector the capture targeted, e.g. `.mode-selector-wrapper`. */
  selector: string
  /** Current live pathname (for param fill), e.g. `/ai-gateway/abc/mcp-servers`. */
  currentUrl?: string
  /** Explicit router file (worktree-relative); auto-detected when omitted. */
  routerFile?: string
}

/** Directories never worth walking for prototype source. */
const PRUNE_DIRS = new Set([
  'node_modules',
  '.git',
  '.desde',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
])
const MAX_VUE_FILES = 4000
const MAX_FILE_BYTES = 512 * 1024
const MAX_SOURCE_FILES = 8

interface VueFile {
  /** Worktree-relative POSIX path. */
  repoRel: string
  /** File basename without the `.vue` extension. */
  base: string
  content: string
}

/**
 * Reduce a CSS selector to a single searchable identifier. Prefers an id
 * (`#foo` → `foo`), else the LAST class (`.a .b` → `b`, the most specific).
 * Returns null when there's no class/id to search by.
 */
export function extractSelectorToken(selector: string): string | null {
  const idMatch = selector.match(/#([A-Za-z_][A-Za-z0-9_-]*)/)
  if (idMatch) return idMatch[1]
  const classMatches = [...selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)]
  if (classMatches.length > 0) return classMatches[classMatches.length - 1][1]
  return null
}

/** Word-boundary regex for a class/id token (hyphen-aware, so `foo` doesn't
 * match inside `foo-bar`). */
function tokenRegex(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`)
}

/** Walk the worktree collecting `.vue` files (pruned, capped, read once). */
async function indexVueFiles(root: string): Promise<VueFile[]> {
  const out: VueFile[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < MAX_VUE_FILES) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const abs = pathJoin(dir, ent.name)
      if (ent.isDirectory()) {
        if (!PRUNE_DIRS.has(ent.name) && !ent.name.startsWith('.')) stack.push(abs)
      } else if (ent.isFile() && ent.name.endsWith('.vue')) {
        let content: string
        try {
          content = await readFile(abs, 'utf8')
        } catch {
          continue
        }
        if (content.length > MAX_FILE_BYTES) continue
        out.push({
          repoRel: pathRelative(root, abs).split('\\').join('/'),
          base: pathBasename(ent.name, '.vue'),
          content,
        })
      }
    }
  }
  return out
}

/** Module-specifier basename without extension. `../views/X.vue` → `X`. */
function specifierBase(spec: string): string {
  return pathBasename(spec).replace(/\.(vue|ts|tsx|js|jsx)$/i, '')
}

/** Whether `content` imports a module whose basename is `base` (default/named
 * import or lazy `import('…')`). Matches `from '…/Base.vue'` and `import('…/Base')`. */
function importsBase(content: string, base: string): boolean {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `(?:from|import)\\s*\\(?\\s*['"][^'"]*\\b${esc}(?:\\.(?:vue|ts|tsx|js|jsx))?['"]`,
  )
  return re.test(content)
}

/**
 * Fill a route pattern's `:params` from the current pathname by POSITIONAL
 * alignment. Static segments of the pattern must match the current path at the
 * same index (so a sibling subtree can't donate params); each `:param` borrows
 * the current path's segment at that index. Returns null when a param has no
 * value to borrow or a static segment mismatches.
 */
export function fillRouteParams(pattern: string, currentPath: string): string | null {
  const segs = (s: string): string[] => s.split('/').filter((p) => p.length > 0)
  const ps = segs(pattern)
  const cs = segs(currentPath)
  const isCatchAllSeg = (seg: string): boolean =>
    seg.includes('*') || (seg.startsWith(':') && seg.includes('('))
  if (ps.some(isCatchAllSeg)) return null
  // No params → the pattern is already a concrete, navigable path. There's
  // nothing to borrow from `currentPath`, so the subtree-alignment guard (which
  // only protects param borrowing) doesn't apply.
  if (!ps.some((seg) => seg.startsWith(':'))) return '/' + ps.join('/')

  const out: string[] = []
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i]
    const isParam = seg.startsWith(':')
    if (isParam) {
      const value = cs[i]
      // A param must borrow a non-empty, non-param value from the live URL.
      if (!value || value.startsWith(':')) return null
      out.push(value)
    } else {
      // Static segment: if the live URL reaches this index it must agree (we're
      // still inside the shared subtree); past the live URL's end it's the new
      // trailing path the pattern adds (e.g. `/create`), kept verbatim.
      if (i < cs.length && cs[i] !== seg) return null
      out.push(seg)
    }
  }
  return '/' + out.join('/')
}

/** Normalize a URL or path to just its pathname (drop origin / query / hash). */
function toPathname(urlOrPath: string): string {
  let p = urlOrPath
  try {
    if (/^[a-z]+:\/\//i.test(p)) p = new URL(p).pathname
  } catch {
    // keep as-is
  }
  const q = p.search(/[?#]/)
  if (q >= 0) p = p.slice(0, q)
  return p || '/'
}

export async function locateSelectorRoute(
  input: LocateSelectorRouteInput,
): Promise<LocateSelectorRouteResult> {
  const empty: LocateSelectorRouteResult = {
    ok: false,
    sourceFiles: [],
    routes: [],
    navigableUrls: [],
  }

  const token = extractSelectorToken(input.selector)
  if (!token) {
    return { ...empty, reason: `no class/id to search by in selector "${input.selector}"` }
  }

  const vueFiles = await indexVueFiles(input.worktreeRoot)
  if (vueFiles.length === 0) {
    return { ...empty, reason: 'no .vue files found in the worktree' }
  }

  const re = tokenRegex(token)
  const sourceVueFiles = vueFiles.filter((f) => re.test(f.content)).slice(0, MAX_SOURCE_FILES)
  if (sourceVueFiles.length === 0) {
    return { ...empty, reason: `selector token "${token}" not found in any .vue source` }
  }
  const sourceFiles = sourceVueFiles.map((f) => f.repoRel)
  const sourceBases = new Set(sourceVueFiles.map((f) => f.base))

  // Parse the router into route→component refs.
  const router = await locateRouterFile(input.worktreeRoot, input.routerFile)
  if (!router.ok) {
    return { ...empty, sourceFiles, reason: `selector lives in ${sourceFiles.join(', ')} but the router couldn't be read: ${router.reason}` }
  }
  const mapped = mapVueRouteComponents({ routerSource: router.source, routerFile: router.repoRel })
  if (!mapped.ok || !mapped.routes) {
    return { ...empty, sourceFiles, reason: `selector lives in ${sourceFiles.join(', ')} but the router couldn't be parsed: ${mapped.reason}` }
  }

  // A route's component basename: prefer the import specifier, else the identifier.
  const routeBase = (r: { componentName?: string; importSpecifier?: string }): string | undefined =>
    r.importSpecifier ? specifierBase(r.importSpecifier) : r.componentName

  // (1) Direct: the SFC defining the selector IS a routed view.
  const candidates = mapped.routes.filter((r) => {
    const b = routeBase(r)
    return b !== undefined && sourceBases.has(b)
  })

  // (2) One level up: a routed view IMPORTS the SFC (the nested-form case). Only
  // when no direct match — keeps the cheap path cheap.
  if (candidates.length === 0) {
    const byBase = new Map(vueFiles.map((f) => [f.base, f] as const))
    for (const r of mapped.routes) {
      const b = routeBase(r)
      if (b === undefined) continue
      const viewFile = byBase.get(b)
      if (!viewFile) continue
      if ([...sourceBases].some((sb) => importsBase(viewFile.content, sb))) {
        candidates.push(r)
      }
    }
  }

  // Dedupe candidate routes by path (a component can back several routes).
  const seenPath = new Set<string>()
  const routes: Array<{ path: string; name?: string }> = []
  for (const r of candidates) {
    if (seenPath.has(r.path)) continue
    seenPath.add(r.path)
    routes.push(r.name ? { path: r.path, name: r.name } : { path: r.path })
  }

  if (routes.length === 0) {
    return {
      ...empty,
      sourceFiles,
      reason: `selector "${input.selector}" is defined in ${sourceFiles.join(', ')}, but no route renders that component (it may be a child of a non-routed component).`,
    }
  }

  // Fill params from the current URL; param-free routes are always navigable.
  const currentPath = input.currentUrl ? toPathname(input.currentUrl) : undefined
  const navigableUrls: string[] = []
  for (const r of routes) {
    if (!/[:*]/.test(r.path)) {
      navigableUrls.push(r.path)
    } else if (currentPath) {
      const filled = fillRouteParams(r.path, currentPath)
      if (filled) navigableUrls.push(filled)
    }
  }

  return { ok: true, sourceFiles, routes, navigableUrls: [...new Set(navigableUrls)] }
}
