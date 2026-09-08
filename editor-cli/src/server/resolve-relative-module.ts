/**
 * Resolve a relative import specifier (`"../data"`, `"./rows.js"`) to a file
 * inside the prototype root, the way a bundler would, and read it.
 *
 * Used by the iteration lanes when a list's data is imported from another
 * module: the pure resolvers (`import-binding.ts`) name the specifier, and
 * this is the ONE place the filesystem hop happens, so the containment
 * guards are applied once and the same way for the deterministic hop and
 * the AI lane's bundle.
 *
 * Rules:
 *   - Only relative specifiers. A bare specifier is a dependency and is
 *     never followed (the caller filters these before calling, but this
 *     refuses too so a stray call cannot walk into `node_modules`).
 *   - Tries the specifier as written, then with each source extension, then
 *     as a directory index. `.js`/`.jsx` specifiers that point at `.ts`/`.tsx`
 *     files (the ESM-with-TS convention) are handled by stripping the
 *     extension before retrying.
 *   - The lexical candidate AND the realpath must both sit inside the root.
 *     A path with a `node_modules` segment is refused even inside the root.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import {
  isWithinRoot,
  resolveRealpathWithinRoot,
  type ResolvedRoot,
} from "./resolve-editable-path"

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"] as const

export type ResolveRelativeModuleResult =
  | {
      ok: true
      /** Realpath of the module file. */
      absolutePath: string
      /** Path relative to the prototype root, POSIX separators. */
      relativePath: string
      source: string
    }
  | { ok: false; reason: string }

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

function hasNodeModulesSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules")
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/** Candidate file paths for a specifier, in bundler order. */
function candidatePaths(base: string): string[] {
  const out: string[] = [base]
  for (const ext of SOURCE_EXTENSIONS) out.push(base + ext)
  const known = SOURCE_EXTENSIONS.find((ext) => base.endsWith(ext))
  if (known) {
    // `./rows.js` written against a `rows.ts` on disk.
    const stem = base.slice(0, -known.length)
    for (const ext of SOURCE_EXTENSIONS) out.push(stem + ext)
  }
  for (const ext of SOURCE_EXTENSIONS) out.push(path.join(base, "index" + ext))
  return out
}

/**
 * @param fromFile  absolute (real) path of the file that contains the import
 * @param specifier the import specifier as written
 * @param root      the resolved prototype root
 */
export async function resolveRelativeModule(
  fromFile: string,
  specifier: string,
  root: ResolvedRoot,
): Promise<ResolveRelativeModuleResult> {
  if (!isRelativeSpecifier(specifier)) {
    return { ok: false, reason: `"${specifier}" is a package import, not a file in this project` }
  }
  const base = path.resolve(path.dirname(fromFile), specifier)
  if (!isWithinRoot(base, root.rootReal, root.rootWithSep)) {
    return { ok: false, reason: `"${specifier}" points outside the project` }
  }
  if (hasNodeModulesSegment(base)) {
    return { ok: false, reason: `"${specifier}" points into node_modules` }
  }
  for (const candidate of candidatePaths(base)) {
    if (!(await isFile(candidate))) continue
    const real = await resolveRealpathWithinRoot(candidate, root, {
      escapeReason: `"${specifier}" resolves outside the project`,
    })
    if (!real.ok) return { ok: false, reason: real.reason }
    if (hasNodeModulesSegment(real.targetPath)) {
      return { ok: false, reason: `"${specifier}" resolves into node_modules` }
    }
    let source: string
    try {
      source = await fs.readFile(real.targetPath, "utf8")
    } catch (err) {
      return { ok: false, reason: `Could not read ${specifier}: ${(err as Error).message}` }
    }
    return {
      ok: true,
      absolutePath: real.targetPath,
      relativePath: path.relative(root.rootReal, real.targetPath).split(path.sep).join("/"),
      source,
    }
  }
  return { ok: false, reason: `No file found for "${specifier}" next to ${path.basename(fromFile)}` }
}
