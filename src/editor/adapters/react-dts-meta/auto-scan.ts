/**
 * Auto-scan: find installed React libraries a prototype can extract manifests
 * from, so onboarding a React design system needs zero per-library code (the
 * React analogue of `vue-dts-meta/auto-scan.ts`).
 *
 * React has no `.vue.d.ts`-style per-component marker to walk toward, so an
 * unbounded `node_modules` walk (the Vue strategy) would mean building a TS
 * program's worth of work over every typed package in the tree just to find
 * out most of them aren't UI libraries. Instead this scan is BOUNDED to the
 * prototype's own declared dependencies: read the prototype's `package.json`
 * `dependencies` + `devDependencies`, and for each declared package (skipping
 * `@types/*`, and skipping anything not actually installed under
 * `node_modules`) check whether ITS OWN `package.json` lists `react` in
 * `dependencies` or `peerDependencies` — that's the signal a package is a
 * React component library, not an unrelated tool. Only packages that pass
 * that check AND resolve a `.d.ts` entry via `discoverReactDtsEntries` are
 * returned.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { discoverReactDtsEntries } from './presets'

export interface ScannedReactPackage {
  /** npm name including scope when applicable (`@acme/react-ui`). */
  packageName: string
  /** Absolute path to the package root inside `node_modules`. */
  packageRoot: string
  /** Absolute path(s) to the resolved type-declaration entry file(s). */
  entryFiles: string[]
}

interface PackageJsonDeps {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function readPackageJson(file: string): Promise<PackageJsonDeps | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PackageJsonDeps
  } catch {
    return null
  }
}

/**
 * Bounded scan: reads the PROTOTYPE's package.json dependencies/devDependencies
 * (never a full node_modules walk — React has no .vue.d.ts-style marker, so an
 * unbounded walk would build TS programs over every typed package). A dep
 * qualifies when its own package.json lists react in dependencies or
 * peerDependencies AND discoverReactDtsEntries finds a .d.ts entry.
 * Skips @types/*. Sorted by packageName.
 */
export async function scanInstalledReactLibraries(
  prototypeRoot: string,
): Promise<ScannedReactPackage[]> {
  const rootPkg = await readPackageJson(path.join(prototypeRoot, 'package.json'))
  if (!rootPkg) return []

  const declared = new Set([
    ...Object.keys(rootPkg.dependencies ?? {}),
    ...Object.keys(rootPkg.devDependencies ?? {}),
  ])
  if (declared.size === 0) return []

  const nm = path.join(prototypeRoot, 'node_modules')
  if (!existsSync(nm)) return []

  const out: ScannedReactPackage[] = []
  for (const packageName of declared) {
    if (packageName.startsWith('@types/')) continue

    const packageRoot = path.join(nm, ...packageName.split('/'))
    const depPkg = await readPackageJson(path.join(packageRoot, 'package.json'))
    if (!depPkg) continue // declared but not installed / unreadable

    const hasReact =
      'react' in (depPkg.dependencies ?? {}) || 'react' in (depPkg.peerDependencies ?? {})
    if (!hasReact) continue

    const entryFiles = discoverReactDtsEntries(packageRoot)
    if (entryFiles.length === 0) continue

    out.push({ packageName, packageRoot, entryFiles })
  }

  out.sort((a, b) => a.packageName.localeCompare(b.packageName))
  return out
}
