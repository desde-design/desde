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

/**
 * Directory names never worth descending into while hunting for a framework's
 * build output.
 *
 * Shorter than {@link EXCLUDED_DIST_DIR_NAMES} by `out`: an `out/` directory
 * means something specific to Next and nothing at all to the others, so a
 * React Router build configured to land there stays findable.
 */
const EXCLUDED_OUTPUT_DIR_NAMES = new Set(["node_modules", ".git", "public"])

async function listDirs(p: string, excluded: Set<string>): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(p)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const name of names) {
    if (excluded.has(name)) continue
    if (await isDir(join(p, name))) dirs.push(name)
  }
  return dirs
}

/**
 * Walks the same ground {@link findNextDistDir} does — the preferred name
 * first, then depth 1, then depth 2 — and hands each candidate to `qualifies`,
 * which answers what that framework's scan wants to know about it.
 *
 * The preferred name is checked first so the answer never depends on
 * directory-listing order when more than one candidate would qualify.
 */
async function scanForOutputDir<T>(
  checkoutRoot: string,
  preferred: string,
  qualifies: (rel: string) => Promise<T | null>,
): Promise<T | null> {
  const first = await qualifies(preferred)
  if (first !== null) return first

  const depth1 = await listDirs(checkoutRoot, EXCLUDED_OUTPUT_DIR_NAMES)
  for (const name of depth1) {
    if (name === preferred) continue
    const found = await qualifies(name)
    if (found !== null) return found
  }
  for (const name of depth1) {
    for (const name2 of await listDirs(join(checkoutRoot, name), EXCLUDED_OUTPUT_DIR_NAMES)) {
      const found = await qualifies(join(name, name2))
      if (found !== null) return found
    }
  }
  return null
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

  const depth1 = await listDirs(checkoutRoot, EXCLUDED_DIST_DIR_NAMES)
  for (const name of depth1) {
    if (name === ".next") continue
    if (await isNextDistDir(checkoutRoot, name)) return name
  }
  for (const name of depth1) {
    const depth2 = await listDirs(join(checkoutRoot, name), EXCLUDED_DIST_DIR_NAMES)
    for (const name2 of depth2) {
      const rel = join(name, name2)
      if (await isNextDistDir(checkoutRoot, rel)) return rel
    }
  }
  return null
}

/** Where a React Router framework-mode build landed, and which file is its server bundle. */
export interface ReactRouterBuild {
  /** The build directory, relative to the checkout root (`build`, `dist`, `out/rr`, …). */
  dir: string
  /** The server bundle's own file name, directly under `<dir>/server/`. */
  serverFile: string
}

/**
 * The one server bundle directly under `serverDir`, or `null`.
 *
 * `index.js` is the default `serverBuildFile` and wins whenever it is there.
 * Otherwise a single `.js` or `.mjs` file is taken as the configured one. Two
 * or more, with no `index.js` to prefer, is not a guess worth making: the
 * recorded start command would ENOENT or boot the wrong file on every cold
 * start, so the directory simply does not qualify.
 */
async function soleServerBundle(serverDir: string): Promise<string | null> {
  if (await isFile(join(serverDir, "index.js"))) return "index.js"
  let names: string[]
  try {
    names = await readdir(serverDir)
  } catch {
    return null
  }
  const bundles: string[] = []
  for (const name of names) {
    if (!/\.(?:js|mjs)$/.test(name)) continue
    if (await isFile(join(serverDir, name))) bundles.push(name)
  }
  return bundles.length === 1 ? (bundles[0] ?? null) : null
}

/**
 * Finds a React Router framework-mode build (codex round 20, item 2).
 *
 * `react-router.ts` used to hard-code `build/server/index.js` and
 * `build/client/`, so a project whose `react-router.config` sets
 * `buildDirectory` or `serverBuildFile` was not recognised at all — no server
 * build was found and the deployment fell through to static publishing.
 *
 * The markers are the pair a framework-mode build always writes together: a
 * `client/` directory and a `server/` directory holding exactly one bundle.
 * Both, not either — a lone `client/` or `server/` directory is a common
 * enough name in a repo that either one alone would match something that is
 * not a build at all.
 *
 * Scans depth 1 and depth 2 under `checkoutRoot`, skipping `node_modules`,
 * `.git` and `public`, and prefers `build` (the default) when it qualifies.
 */
export async function findReactRouterBuildDir(checkoutRoot: string): Promise<ReactRouterBuild | null> {
  return await scanForOutputDir(checkoutRoot, "build", async (rel) => {
    const dir = join(checkoutRoot, rel)
    if (!(await isDir(join(dir, "client")))) return null
    if (!(await isDir(join(dir, "server")))) return null
    const serverFile = await soleServerBundle(join(dir, "server"))
    return serverFile === null ? null : { dir: rel, serverFile }
  })
}

/**
 * Finds a Nitro server build's output directory (codex round 20, item 3).
 *
 * `nuxt.ts` used to hard-code `.output`, so a project whose Nitro config sets
 * `output.dir` was not recognised as a server build and fell through to
 * static publishing.
 *
 * The markers are the pair Nitro writes together: `server/index.mjs` and a
 * `public/` directory. Both, not either — `server/index.mjs` on its own is a
 * plausible file name in a source tree, and a `public/` directory is an
 * ordinary thing for a repo to have.
 *
 * Scans depth 1 and depth 2 under `checkoutRoot`, skipping `node_modules`,
 * `.git` and `public`, and prefers `.output` (the default) when it qualifies.
 * Returns the output dir relative to `checkoutRoot`, or `null`.
 */
export async function findNitroOutputDir(checkoutRoot: string): Promise<string | null> {
  return await scanForOutputDir(checkoutRoot, ".output", async (rel) => {
    const dir = join(checkoutRoot, rel)
    if (!(await isFile(join(dir, "server", "index.mjs")))) return null
    if (!(await isDir(join(dir, "public")))) return null
    return rel
  })
}

export { isDir, isFile, dependsOn }
