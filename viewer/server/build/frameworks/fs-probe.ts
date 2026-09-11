import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** True when `package.json` lists `name` under dependencies or devDependencies. */
async function dependsOn(checkoutRoot: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(checkoutRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
  } catch {
    return false
  }
}

/** Directory names never worth descending into while hunting for a Next dist dir. */
const EXCLUDED_DIST_DIR_NAMES = new Set(["node_modules", ".git", "out", "public"])

async function listDirs(p: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(p)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of names) {
    if (EXCLUDED_DIST_DIR_NAMES.has(name)) continue
    if (await isDir(join(p, name))) dirs.push(name)
  }
  return dirs
}

/** `rel` (relative to `checkoutRoot`) has BOTH files every non-export Next build writes to its own dist dir. */
async function isNextDistDir(checkoutRoot: string, rel: string): Promise<boolean> {
  return (
    (await isFile(join(checkoutRoot, rel, "BUILD_ID"))) &&
    (await isFile(join(checkoutRoot, rel, "required-server-files.json")))
  )
}

/**
 * Finds a Next.js build's dist directory (codex round 4, Fix 4).
 *
 * `next.ts` used to check only the hard-coded `.next/BUILD_ID`, so a
 * checkout with a custom `distDir` in `next.config` (`distDir: "build"`)
 * fell through to static publishing and failed to detect a server build at
 * all. This scans instead, for the two files every non-export Next build
 * writes TOGETHER, only inside its own dist dir: `BUILD_ID` and
 * `required-server-files.json`. Either alone is not enough — a stale
 * `BUILD_ID` can survive a switch to `output: "export"`, and only the pair
 * together is specific to a server-capable build.
 *
 * Scans depth 1 and depth 2 under `checkoutRoot`, skipping `node_modules`,
 * `.git`, `out` and `public` — none of those is ever a Next dist dir, and
 * `node_modules` alone can hold thousands of directories worth walking into
 * for nothing. `.next` is checked FIRST and preferred when it qualifies,
 * since that is what nearly every checkout uses and the answer should not
 * depend on directory-listing order when more than one candidate exists.
 *
 * Returns the dist dir as a path relative to `checkoutRoot` (`.next`,
 * `build`, `build/next`, …), or `null` when nothing qualifies.
 */
export async function findNextDistDir(checkoutRoot: string): Promise<string | null> {
  if (await isNextDistDir(checkoutRoot, ".next")) return ".next"

  const depth1 = await listDirs(checkoutRoot)
  for (const name of depth1) {
    if (name === ".next") continue
    if (await isNextDistDir(checkoutRoot, name)) return name
  }
  for (const name of depth1) {
    const depth2 = await listDirs(join(checkoutRoot, name))
    for (const name2 of depth2) {
      const rel = join(name, name2)
      if (await isNextDistDir(checkoutRoot, rel)) return rel
    }
  }
  return null
}

export { isDir, isFile, dependsOn }
