/**
 * Stylesheet discovery for the generic `css-custom-properties` token family
 * (`./index.ts`). Answers "which CSS files in this prototype are worth
 * parsing for design tokens?" — bounded, fail-soft, no `node_modules` walk.
 *
 * Two independent probes:
 *   - App CSS: a bounded depth-6 directory walk (SKIP_DIRS convention copied
 *     from the edit-service's raw-file-scanning loader — since deleted and
 *     replaced by `edit-service/load-style-grounding.ts`, which now consumes
 *     tokens from this grounding seam instead of scanning for them itself —
 *     so the small walker is duplicated here rather than imported) over
 *     `.css` files, kept only when
 *     they actually declare at least one `:root`/`html`/`@theme` custom
 *     property (parsed once via `parseCustomProperties`; parsing here is
 *     discovery-only — `CssCustomPropertiesTokenSource` re-reads and
 *     re-parses independently, so the two lifecycles never share state).
 *   - Package CSS: a small, explicitly-bounded set of candidate packages
 *     (declared deps whose NAME looks token/theme/design-ish, plus anything
 *     the user has registered via the design-system onboarding flow) — never
 *     an unbounded `node_modules` walk.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLocalRegistryStore } from '../../onboarding/registry-store'
import { parseCustomProperties } from './parser'

export interface DiscoveredStylesheets {
  /**
   * App `.css` files under the prototype (bounded walk, SKIP_DIRS like the
   * style-context walker, depth ≤ 6) that contain at least one
   * `:root`/`html`/`@theme` custom-property declaration.
   */
  appCssFiles: string[]
  /** Per-package CSS worth parsing: `{ packageName, cssFiles }` — bounded probe. */
  packageCss: Array<{ packageName: string; cssFiles: string[] }>
}

/** Candidate dependency names that are worth probing for token/theme CSS. */
const TOKEN_ISH_NAME_RE = /token|theme|design/i

const DEPTH_LIMIT = 6

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  '.turbo',
  '.cache',
  '__tests__',
  'tests',
  '.desde',
])

/**
 * Bounded depth-limited walk collecting every `.css` file under `root`.
 *
 * Exported as {@link walkAppCssFiles} so other substrate probes reuse this ONE
 * bounded walk (same SKIP_DIRS convention, same depth limit) instead of adding a
 * parallel filesystem crawl — see
 * `src/editor/adapters/tailwind/detect-important-utilities.ts`.
 */
function walkCssFiles(root: string, depth: number): string[] {
  const results: string[] = []
  function inner(dir: string, currentDepth: number): void {
    if (currentDepth > depth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        inner(abs, currentDepth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
        results.push(abs)
      }
    }
  }
  inner(root, 0)
  return results
}

/**
 * Every `.css` file under `root` worth looking at, via the shared bounded walk
 * ({@link DEPTH_LIMIT}, SKIP_DIRS — no `node_modules`, no dotfolders). UNFILTERED:
 * unlike {@link discoverTokenStylesheets}' `appCssFiles`, this does not require the
 * file to declare custom properties, because other probes care about at-rules
 * (e.g. a Tailwind entrypoint declares no tokens at all). Never throws — an
 * unreadable directory contributes nothing.
 */
export function walkAppCssFiles(root: string, depth: number = DEPTH_LIMIT): string[] {
  return walkCssFiles(root, depth)
}

interface PackageJsonDeps {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Resolve a package NAME (untrusted — sourced from package.json dependency
 * keys, or a hand-edited registry entry with no explicit `packageRoot`) to
 * its expected `node_modules` install path, rejecting any name whose `../`
 * segments would resolve the path outside `nodeModulesRoot`. A hand-edited
 * dependency name like `"../../other-design"` would otherwise escape the
 * prototype root entirely (and still trip the token-ish name heuristic via
 * "design"). Shared by the declared-deps probe below and the registry
 * fallback (no explicit `packageRoot`) branch in `discoverTokenStylesheets`.
 */
function resolveUnderNodeModules(nodeModulesRoot: string, name: string): string | null {
  const resolved = path.join(nodeModulesRoot, ...name.split('/'))
  if (resolved !== nodeModulesRoot && !resolved.startsWith(nodeModulesRoot + path.sep)) {
    return null // name escapes node_modules — reject
  }
  return resolved
}

/** Reads `package.json` deps/devDeps matching `/token|theme|design/i`. */
function tokenIshDeclaredDeps(prototypeRoot: string): Map<string, string> {
  const candidates = new Map<string, string>() // packageName -> packageRoot
  let pkg: PackageJsonDeps
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(prototypeRoot, 'package.json'), 'utf8'))
  } catch {
    return candidates // no package.json / unreadable → nothing to probe
  }
  const nodeModulesRoot = path.join(path.resolve(prototypeRoot), 'node_modules')
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const name of Object.keys(deps)) {
    if (!TOKEN_ISH_NAME_RE.test(name)) continue
    const packageRoot = resolveUnderNodeModules(nodeModulesRoot, name)
    if (!packageRoot) continue // name escapes node_modules — skip this dep
    candidates.set(name, packageRoot)
  }
  return candidates
}

interface PackageJsonCssProbe {
  style?: string
  exports?: unknown
}

/**
 * Pull a `.css` path out of an `exports` map. One level of nesting, mirroring
 * `react-dts-meta/presets.ts`'s `typesFromExports` visitor (same shape, but
 * hunting a `.css` string suffix instead of `.d.ts`, and over every exports
 * entry rather than only `"."`).
 */
function cssFromExports(exportsField: unknown): string | null {
  const isCss = (v: unknown): v is string => typeof v === 'string' && v.endsWith('.css')
  if (isCss(exportsField)) return exportsField
  if (!exportsField || typeof exportsField !== 'object') return null
  for (const value of Object.values(exportsField as Record<string, unknown>)) {
    if (isCss(value)) return value
    if (Array.isArray(value)) {
      const hit = value.find(isCss)
      if (hit) return hit
    } else if (value && typeof value === 'object') {
      const hit = Object.values(value as Record<string, unknown>).find(isCss)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Collect up to 3 CSS files for one package root, in priority order:
 * `package.json` `style` field → a `.css` value under `exports` → the
 * conventional `dist/tokens/css/custom-properties.css` path, falling back to
 * the first `dist/*.css` (readdir, sorted for determinism — not a glob dep)
 * when that convention isn't present. Each of the three slots contributes at
 * most one file, and only files that actually exist are kept.
 *
 * Security: the `style` field and `exports` values are UNTRUSTED content read
 * out of the candidate package's own `package.json` — a malicious/malformed
 * package could set `style` to an absolute path or a `../../` escape to get
 * an arbitrary file read into the LLM prompt. Both candidates are rejected
 * unless they (a) end in `.css` and (b) resolve to a path INSIDE
 * `packageRoot`. The conventional/dist-glob paths are built internally from
 * `packageRoot` + fixed literal segments, so the lexical join can't escape —
 * but ANY of these candidates (including the conventional/dist ones) could
 * still be a SYMLINK whose target lives outside `packageRoot`, which the
 * lexical check above can't see (`fs.statSync` follows symlinks silently).
 * `addResolved` closes that gap: it resolves the REAL path of both the
 * package root and the candidate file (`fs.realpathSync`) and requires the
 * candidate's real path to be equal-or-under the package root's OWN real
 * path. Comparing against the package root's own realpath (not the
 * prototype root's) matters for pnpm installs, where the package root itself
 * is commonly a symlink into the pnpm store — that's a legitimate case and
 * must still be accepted, since its CSS resolves under its real store dir.
 * Any realpath failure (dangling symlink, permission error) rejects the
 * candidate rather than risking a false accept.
 */
function probePackageCss(packageRoot: string): string[] {
  const files: string[] = []
  const realPackageRoot = path.resolve(packageRoot)

  let realPackageRootTarget: string | null
  try {
    realPackageRootTarget = fs.realpathSync(realPackageRoot)
  } catch {
    realPackageRootTarget = null // package root itself unresolvable — nothing can be trusted
  }

  const addResolved = (abs: string): void => {
    if (files.includes(abs)) return
    if (!realPackageRootTarget) return
    try {
      if (!fs.statSync(abs).isFile()) return
    } catch {
      return // doesn't exist — skip
    }
    let realAbs: string
    try {
      realAbs = fs.realpathSync(abs)
    } catch {
      return // symlink target unresolvable — reject rather than risk a false accept
    }
    if (
      realAbs !== realPackageRootTarget &&
      !realAbs.startsWith(realPackageRootTarget + path.sep)
    ) {
      return // candidate resolves outside the package root's real location — reject
    }
    files.push(abs)
  }

  /** Untrusted candidate from package.json content — must stay inside packageRoot. */
  const addUntrusted = (candidate: string | null): void => {
    if (!candidate) return
    if (path.isAbsolute(candidate)) return // reject — must be relative to packageRoot
    if (!candidate.toLowerCase().endsWith('.css')) return
    const abs = path.resolve(realPackageRoot, candidate)
    if (abs !== realPackageRoot && !abs.startsWith(realPackageRoot + path.sep)) return
    addResolved(abs)
  }

  let pkg: PackageJsonCssProbe = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return files // no package.json readable → nothing to probe
  }

  addUntrusted(pkg.style ?? null)
  addUntrusted(cssFromExports(pkg.exports))

  const conventional = path.join(packageRoot, 'dist', 'tokens', 'css', 'custom-properties.css')
  let hasConventional = false
  try {
    hasConventional = fs.statSync(conventional).isFile()
  } catch {
    hasConventional = false
  }
  if (hasConventional) {
    addResolved(conventional)
  } else {
    const distDir = path.join(packageRoot, 'dist')
    try {
      const entries = fs
        .readdirSync(distDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.css'))
        .map((e) => e.name)
        .sort()
      if (entries.length > 0) addResolved(path.join(distDir, entries[0]))
    } catch {
      /* no dist dir — skip */
    }
  }

  return files.slice(0, 3)
}

/**
 * Discover the CSS worth parsing for design tokens: the prototype's own
 * stylesheets, plus a bounded set of installed/registered token/theme/design
 * packages. Async because registered design systems are read via
 * `createLocalRegistryStore(root).list()` (fail-soft, matches the manifest
 * onboarding registry's own read contract).
 */
export async function discoverTokenStylesheets(
  prototypeRoot: string,
): Promise<DiscoveredStylesheets> {
  const appCssFiles = walkCssFiles(prototypeRoot, DEPTH_LIMIT).filter((file) => {
    try {
      const text = fs.readFileSync(file, 'utf8')
      return parseCustomProperties(text).length > 0
    } catch {
      return false
    }
  })

  const candidates = tokenIshDeclaredDeps(prototypeRoot)

  // Registered design systems (self-serve onboarding) are additive over the
  // declared-dep name match — a registered entry may live outside
  // `node_modules` (`packageRoot`) or not match the token-ish name heuristic
  // at all (the user explicitly told us it's a design system).
  //
  // Containment guard on `packageRoot`: mirrors
  // `build-registered-sources.ts`'s guard on the same field — a hand-edited
  // or corrupted registry entry could otherwise point the CSS probe at any
  // path on disk (e.g. `../../../etc`). Resolve then require the result to be
  // (or live under) the prototype root; escaping entries contribute nothing.
  const realRoot = path.resolve(prototypeRoot)
  const registry = await createLocalRegistryStore(prototypeRoot).list()
  for (const entry of registry) {
    let packageRoot: string
    if (entry.packageRoot) {
      const resolved = path.resolve(realRoot, entry.packageRoot)
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
        continue // packageRoot escapes the prototype root — skip this entry
      }
      packageRoot = resolved
    } else {
      // No packageRoot given → fall back to the node_modules install path.
      // Same containment guard as the packageRoot branch above (and the
      // declared-deps probe in `tokenIshDeclaredDeps`), scoped to
      // node_modules specifically: a hand-edited `package` field like
      // `../../outside-pkg` must not escape `<realRoot>/node_modules`.
      const resolved = resolveUnderNodeModules(path.join(realRoot, 'node_modules'), entry.package)
      if (!resolved) {
        continue // package escapes node_modules — skip this entry
      }
      packageRoot = resolved
    }
    candidates.set(entry.package, packageRoot)
  }

  const packageCss: Array<{ packageName: string; cssFiles: string[] }> = []
  for (const [packageName, packageRoot] of candidates) {
    const cssFiles = probePackageCss(packageRoot)
    if (cssFiles.length > 0) packageCss.push({ packageName, cssFiles })
  }

  return { appCssFiles, packageCss }
}
