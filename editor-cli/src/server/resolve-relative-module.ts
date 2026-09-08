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
 *   - Tries the specifier as written (only if it already ends in a resolvable
 *     extension), then with each resolvable extension, then as a directory
 *     index. `.js`/`.jsx` specifiers that point at `.ts`/`.tsx` files (the
 *     ESM-with-TS convention) are handled by stripping the extension before
 *     retrying. See `RESOLVABLE_EXTENSIONS` for why `.js` itself is out.
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
import { OUTPUT_EXTENSION_SUBSTITUTIONS } from "../../../src/editor/edit-service/import-binding.js"

/**
 * The only files this resolver will hand back. It is the intersection of
 * "where a data module lives" and "what the overwrite lane will write back"
 * (`edit-extension-gate.ts` admits `.vue`, `.ts`, `.tsx`, `.jsx`; a data
 * module is never `.vue`). `.js` / `.mjs` / `.cjs` / `.mts` are NOT here on
 * purpose: `vite.config.js` is a `.js` file, and a proposal naming a file the
 * write lane refuses is a success that fails on Save. Codex round 1 also
 * showed the as-written candidate admitting `package.json` into the model's
 * bundle; every candidate now has to end in one of these.
 */
const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".jsx"] as const
/**
 * TypeScript's output-extension substitution, shared with the page check in
 * `import-binding.ts`. This is the whole ESM-with-TS convention; nothing
 * else is tried for an extension-bearing specifier (codex round 3: appending
 * `.ts` to `./Row.jsx` found a `Row.jsx.ts` before the real `Row.tsx`).
 */
const SUBSTITUTIONS = OUTPUT_EXTENSION_SUBSTITUTIONS

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

function hasResolvableExtension(p: string): boolean {
  return RESOLVABLE_EXTENSIONS.some((ext) => p.endsWith(ext))
}

/**
 * Candidate file paths for a specifier, in the order a bundler tries them.
 * Extension-bearing specifier: the file as written, then TypeScript's
 * substitutions for that extension, nothing else. Extensionless: each
 * source extension appended, then a directory index. A candidate is
 * returned even when its extension is not resolvable, so the caller can
 * tell "the file the app really loads is one we cannot write" apart from
 * "no such file".
 */
function candidatePaths(base: string): string[] {
  const written = path.extname(base)
  if (written !== "") {
    const out = [base]
    const subs = SUBSTITUTIONS.find(([from]) => from === written)
    if (subs) {
      const stem = base.slice(0, -written.length)
      for (const ext of subs[1]) if (stem + ext !== base) out.push(stem + ext)
    }
    return out
  }
  const out: string[] = []
  for (const ext of RESOLVABLE_EXTENSIONS) out.push(base + ext)
  for (const ext of RESOLVABLE_EXTENSIONS) out.push(path.join(base, "index" + ext))
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
  // The FIRST candidate that exists is the file the bundler loads. If that
  // file's real target is not one we can write back, stop: picking a later
  // same-stem candidate would edit data the app never imports (codex round
  // 2: `./data.js` beside `data.ts` resolved to the `.ts`; round 3: the same
  // for `./data.mjs` beside `data.mts`). The check is on the REAL path, so
  // an in-root `data.js -> data.ts` symlink alias still resolves.
  for (const candidate of candidatePaths(base)) {
    if (!(await isFile(candidate))) continue
    const real = await resolveRealpathWithinRoot(candidate, root, {
      escapeReason: `"${specifier}" resolves outside the project`,
    })
    if (!real.ok) return { ok: false, reason: real.reason }
    if (hasNodeModulesSegment(real.targetPath)) {
      return { ok: false, reason: `"${specifier}" resolves into node_modules` }
    }
    if (!hasResolvableExtension(real.targetPath)) {
      return {
        ok: false,
        reason: `"${specifier}" is a ${path.extname(real.targetPath) || "non-source"} file, which the Editor cannot write back`,
      }
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
  return {
    ok: false,
    reason: `No .ts, .tsx or .jsx file found for "${specifier}" next to ${path.basename(fromFile)}`,
  }
}
