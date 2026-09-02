/**
 * Auto-scan: walk a prototype's `node_modules` and return every
 * installed Vue library that ships per-component declarations. Each
 * result is enough to instantiate a `VueDtsMetaManifestSource` via
 * `discoverVueDtsComponents(...)`.
 *
 * Why auto-scan: per the onboarding plan, the registry-per-library
 * approach doesn't scale to arbitrary customer packages. The shipped
 * declaration layouts are convergent enough that a one-strategy walk
 * picks up every prototype-installed package the manifest pipeline
 * cares about — validated live against the dogfood substrate's eight
 * installed Vue libraries, none of which needs per-package code.
 *
 * "Per-component declarations" means either layout
 * `discoverVueDtsComponents` recognises: `<Name>.vue.d.ts`, or an
 * `index.d.ts` beside a sibling `<Name>.vue`. The probe here and the
 * discovery walk there must agree, since a root rejected here is never
 * offered to discovery.
 *
 * Scope: scans top-level + scoped (`@org/<pkg>`) entries only. Nested
 * package nesting (`node_modules/<a>/node_modules/<b>`) is not
 * resolved — the prototype's hoisted tree is the source of truth.
 * Symlinks (workspace / pnpm) are followed by the underlying `fs`
 * calls; we never read inside a package, only its declared `dist/types`
 * tree.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Common declaration roots seen across the major Vue libraries. Tried in
 * order; the first that exists AND contains at least one component
 * declaration (anywhere underneath) wins.
 *
 * Probes deepest-first so a package that ships *both*
 * `dist/types/components/<Name>.vue.d.ts` and a top-level barrel `.d.ts`
 * gets the components root, not the broader `dist/types` (which would
 * include non-component `.d.ts` files we'd then have to filter).
 *
 * `'.'` — the package root — is the last resort, and it is not decorative:
 * PrimeVue ships no `dist` at all (`primevue/button/index.d.ts` beside
 * `primevue/button/Button.vue`), so without it the whole package is
 * invisible to the scan. It is only reached when none of the `dist` roots
 * matched, and the probe below skips nested `node_modules`, so the extra
 * walk is bounded by the package's own tree.
 */
const DEFAULT_DTS_ROOTS = [
  'dist/types/components',
  'dist/types',
  'dist',
  '.',
]

export interface ScannedPackage {
  /** npm name including scope when applicable (`@acme/design-system`). */
  packageName: string
  /** Absolute path to the package root inside `node_modules`. */
  packageRoot: string
  /**
   * Absolute path to the `dist/types` sub-root that contained
   * `*.vue.d.ts`. Pass `path.relative(packageRoot, dtsRoot)` to
   * `discoverVueDtsComponents` as its single `dtsRoots` entry.
   */
  dtsRoot: string
}

/**
 * Walk `<prototypeRoot>/node_modules` and return every installed
 * package that has at least one `*.vue.d.ts` under a known dts root.
 *
 * Pure read-only: never writes, never opens packages without `.vue.d.ts`
 * declarations, follows symlinks (so pnpm/workspace links work).
 */
export async function scanInstalledVueLibraries(
  prototypeRoot: string,
): Promise<ScannedPackage[]> {
  const nm = path.join(prototypeRoot, 'node_modules')
  if (!existsSync(nm)) return []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(nm, { withFileTypes: true })
  } catch {
    return []
  }

  const out: ScannedPackage[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.')) continue
    const full = path.join(nm, name)

    if (name.startsWith('@')) {
      // Scoped: iterate sub-packages.
      let scoped: import('node:fs').Dirent[]
      try {
        scoped = await fs.readdir(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of scoped) {
        if (sub.name.startsWith('.')) continue
        await consider(`${name}/${sub.name}`, path.join(full, sub.name))
      }
    } else {
      await consider(name, full)
    }
  }

  // Stable order — callers (manifest composite) get deterministic
  // priority across scans.
  out.sort((a, b) => a.packageName.localeCompare(b.packageName))
  return out

  async function consider(
    packageName: string,
    packageRoot: string,
  ): Promise<void> {
    for (const candidate of DEFAULT_DTS_ROOTS) {
      const dtsRoot = path.join(packageRoot, candidate)
      if (!existsSync(dtsRoot)) continue
      if (await containsComponentDts(dtsRoot)) {
        out.push({ packageName, packageRoot, dtsRoot })
        return
      }
    }
  }
}

/**
 * Cheap "does this tree contain a component declaration?" probe. Walks
 * eagerly and bails on first match — the goal is to gate auto-scan
 * inclusion, not to enumerate everything (that's `discoverVueDtsComponents`'s
 * job). Cost is proportional to the depth of the first match in
 * common cases (`dist/types/components/<Pkg>.vue.d.ts` → 2 readdirs).
 *
 * Both layouts `discoverVueDtsComponents` recognises count, and they must
 * stay in step: a root that this probe rejects is never handed to discovery
 * at all. The second layout — `index.d.ts` beside a sibling `<Name>.vue` —
 * is what PrimeVue ships, and its absence here is why a PrimeVue install
 * scanned to zero packages.
 *
 * Nested `node_modules` is skipped: a dependency's components are not this
 * package's, and with the package root now a probe root, descending would
 * make the walk unbounded.
 */
async function containsComponentDts(root: string): Promise<boolean> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const dirKey = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '')
    let hasIndexDts = false
    let hasMatchingSfc = false
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.vue.d.ts')) return true
      if (entry.name === 'index.d.ts') {
        hasIndexDts = true
      } else if (dirKey && entry.name.endsWith('.vue')) {
        const stem = entry.name.slice(0, -'.vue'.length)
        if (stem.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(dirKey)) {
          hasMatchingSfc = true
        }
      }
    }
    if (hasIndexDts && hasMatchingSfc) return true
  }
  return false
}
