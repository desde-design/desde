import { lstat, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/**
 * A directory that is not a symbolic link. The scans below walk with this,
 * never {@link isDir}, so a link a repository committed (`dist ->
 * /somewhere`) cannot lead them out of the checkout: they would otherwise
 * read another checkout's, or the host's, build output as this one's
 * (codex round 31, found by the build runner's own escape test).
 */
async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory()
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

/** True when `<dir>/package.json` lists `name` under dependencies or devDependencies. */
async function dependsOnAt(dir: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
  } catch {
    return false
  }
}

/**
 * True when the checkout root's own `package.json` lists `name`. A thin
 * alias over {@link dependsOnAt} for the common case of asking about the
 * checkout root itself, kept so every existing call site did not need to
 * change name.
 */
async function dependsOn(checkoutRoot: string, name: string): Promise<boolean> {
  return dependsOnAt(checkoutRoot, name)
}

/**
 * The package that owns a found build output (codex round 29, item 1;
 * widened in round 31): the nearest ancestor of `rel` (a path relative to
 * the checkout root, such as a dist dir, a build dir, or a Nitro output
 * dir) that holds a `package.json`, relative to the root, or `null` when no
 * ancestor below the root does and the root's own package is the owner.
 *
 * In an npm or pnpm workspace this is the app package's own directory
 * (`apps/web`), the one whose `package.json`, not the workspace root's,
 * declares the framework. It stays `apps/web` for a custom nested output
 * dir too (`apps/web/build/next`): round 29 took the output's parent, which
 * named `apps/web/build`, a directory that owns nothing.
 */
async function owningPackageDir(checkoutRoot: string, rel: string): Promise<string | null> {
  for (let dir = dirname(rel); dir !== "." && dir !== "/" && dir !== ""; dir = dirname(dir)) {
    if (await isFile(join(checkoutRoot, dir, "package.json"))) return dir
  }
  return null
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
    if (await isRealDir(join(p, name))) dirs.push(name)
  }
  return dirs
}

/**
 * How deep the output scans look: a workspace app two segments down
 * (`apps/web`) with a custom nested output dir two segments below that
 * (`build/next`, `dist/rr`). Depth 3 covered either alone and missed the
 * two together, so such a build fell through to static publishing (codex
 * round 31).
 */
const MAX_SCAN_DEPTH = 4

/**
 * Every directory under `checkoutRoot` down to {@link MAX_SCAN_DEPTH},
 * shallowest level first, as paths relative to the root. Names in
 * `excluded` are neither listed nor entered.
 */
async function walkDirs(checkoutRoot: string, excluded: Set<string>, base = ""): Promise<string[]> {
  const found: string[] = []
  let level = (await listDirs(join(checkoutRoot, base), excluded)).map((name) => join(base, name))
  for (let depth = 1; depth <= MAX_SCAN_DEPTH && level.length > 0; depth++) {
    found.push(...level)
    if (depth === MAX_SCAN_DEPTH) break
    const next: string[] = []
    for (const rel of level) {
      for (const name of await listDirs(join(checkoutRoot, rel), excluded)) next.push(join(rel, name))
    }
    level = next
  }
  return found
}

/**
 * The one scan every framework's finder runs: the preferred name first,
 * then every directory {@link walkDirs} lists, shallowest first, each
 * handed to `qualifies`, which answers what that framework wants to know
 * about it.
 *
 * The preferred name is checked first so the answer never depends on
 * directory-listing order when more than one candidate would qualify.
 */
async function scanForOutputDir<T>(
  checkoutRoot: string,
  preferred: string,
  qualifies: (rel: string) => Promise<T | null>,
  excluded: Set<string> = EXCLUDED_OUTPUT_DIR_NAMES,
  within: string | null = null,
): Promise<T | null> {
  // The target app first, when the caller named one (codex round 34): its
  // own preferred name, then everything under it. Then the whole checkout
  // in the usual order. Each candidate is asked once.
  const candidates: string[] = []
  if (within !== null) candidates.push(join(within, preferred), ...(await walkDirs(checkoutRoot, excluded, within)))
  candidates.push(preferred, ...(await walkDirs(checkoutRoot, excluded)))
  const asked = new Set<string>()
  for (const rel of candidates) {
    if (asked.has(rel)) continue
    asked.add(rel)
    if (!(await isRealDir(join(checkoutRoot, rel)))) continue
    const found = await qualifies(rel)
    if (found !== null) return found
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
 * Scans depth 1 to 4 under `checkoutRoot`, skipping `node_modules`,
 * `.git`, `out` and `public` — none of those is ever a Next dist dir, and
 * `node_modules` alone can hold thousands of directories worth walking into
 * for nothing. `.next` is checked FIRST and preferred when it qualifies,
 * since that is what nearly every checkout uses and the answer should not
 * depend on directory-listing order when more than one candidate exists.
 *
 * Returns the dist dir as a path relative to `checkoutRoot` (`.next`,
 * `build`, `build/next`, …), or `null` when nothing qualifies.
 */
export async function findNextDistDir(checkoutRoot: string, within: string | null = null): Promise<string | null> {
  return scanForOutputDir(
    checkoutRoot,
    ".next",
    async (rel) => ((await isNextDistDir(checkoutRoot, rel)) ? rel : null),
    EXCLUDED_DIST_DIR_NAMES,
    within,
  )
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
 * Otherwise a single `.js`, `.mjs` or `.cjs` file is taken as the configured one. Two
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
    // `.cjs` too: `serverModuleFormat: "cjs"` names its bundle that way
    // (codex round 23).
    if (!/\.(?:js|mjs|cjs)$/.test(name)) continue
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
 * Scans depth 1 to 4 under `checkoutRoot`, skipping `node_modules`,
 * `.git` and `public`, and prefers `build` (the default) when it qualifies.
 */
export async function findReactRouterBuildDir(
  checkoutRoot: string,
  within: string | null = null,
): Promise<ReactRouterBuild | null> {
  return await scanForOutputDir(
    checkoutRoot,
    "build",
    async (rel) => {
      const dir = join(checkoutRoot, rel)
      if (!(await isDir(join(dir, "client")))) return null
      if (!(await isDir(join(dir, "server")))) return null
      const serverFile = await soleServerBundle(join(dir, "server"))
      return serverFile === null ? null : { dir: rel, serverFile }
    },
    EXCLUDED_OUTPUT_DIR_NAMES,
    within,
  )
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
 * Scans depth 1 to 4 under `checkoutRoot`, skipping `node_modules`,
 * `.git` and `public`, and prefers `.output` (the default) when it qualifies.
 * Returns the output dir relative to `checkoutRoot`, or `null`.
 */
export async function findNitroOutputDir(checkoutRoot: string, within: string | null = null): Promise<string | null> {
  return await scanForOutputDir(
    checkoutRoot,
    ".output",
    async (rel) => {
      const dir = join(checkoutRoot, rel)
      if (!(await isFile(join(dir, "server", "index.mjs")))) return null
      if (!(await isDir(join(dir, "public")))) return null
      return rel
    },
    EXCLUDED_OUTPUT_DIR_NAMES,
    within,
  )
}

/**
 * Where a Next `output: "export"` landed: a directory named `out` holding
 * both export markers (`_next/` and `index.html`), the root's first, then
 * the same walk as the other scans, so a workspace app's `apps/web/out` is
 * found (codex round 30: only the root `out` was checked, so an exported
 * workspace app whose `.next` was found was recorded as a server and
 * `next start` refused it). Relative to `checkoutRoot`, or `null`.
 */
export async function findNextExportDir(checkoutRoot: string, within: string | null = null): Promise<string | null> {
  return scanForOutputDir(
    checkoutRoot,
    "out",
    async (rel) => {
      if (rel.split("/").pop() !== "out") return null
      const complete =
        (await isDir(join(checkoutRoot, rel, "_next"))) && (await isFile(join(checkoutRoot, rel, "index.html")))
      return complete ? rel : null
    },
    EXCLUDED_OUTPUT_DIR_NAMES,
    within,
  )
}

export { isDir, isFile, dependsOn, dependsOnAt, owningPackageDir }
