import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findNextDistDir, findNitroOutputDir, findReactRouterBuildDir, owningPackageDir } from "./fs-probe"

/**
 * Codex round 4, Fix 4. `BUILD_ID` alone used to be hard-coded under `.next`
 * in `next.ts`, so a checkout with a custom `distDir` (e.g. `distDir:
 * "build"` in `next.config`) fell through to static publishing and failed —
 * nothing ever looked anywhere else. This scans for the pair of files EVERY
 * non-export Next build writes together, in its own dist dir wherever that
 * is: `BUILD_ID` and `required-server-files.json`.
 */
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fs-probe-next-"))
  roots.push(dir)
  return dir
}

async function writeDistDir(base: string, rel: string): Promise<void> {
  const dir = join(base, rel)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "BUILD_ID"), "abc123")
  await writeFile(join(dir, "required-server-files.json"), "{}")
}

describe("findNextDistDir", () => {
  it("finds the default .next dist dir", async () => {
    const r = await root()
    await writeDistDir(r, ".next")
    expect(await findNextDistDir(r)).toBe(".next")
  })

  it("finds a custom depth-1 distDir (distDir: \"build\")", async () => {
    const r = await root()
    await writeDistDir(r, "build")
    expect(await findNextDistDir(r)).toBe("build")
  })

  it("finds a workspace app's dist dir three segments down (apps/web/.next)", async () => {
    const r = await root()
    await writeDistDir(r, "apps/web/.next")
    expect(await findNextDistDir(r)).toBe("apps/web/.next")
  })

  it("finds a custom nested distDir (distDir: \"build/next\")", async () => {
    const r = await root()
    await writeDistDir(r, "build/next")
    expect(await findNextDistDir(r)).toBe("build/next")
  })

  it("finds a workspace app's custom nested distDir four segments down (apps/web/build/next, codex round 31)", async () => {
    const r = await root()
    await writeDistDir(r, "apps/web/build/next")
    expect(await findNextDistDir(r)).toBe(join("apps", "web", "build", "next"))
  })

  it("does not follow a symlinked directory out of the checkout (codex round 31)", async () => {
    const outside = await root()
    await writeDistDir(outside, "app/.next")
    const r = await root()
    await symlink(outside, join(r, "dist"))
    await symlink(join(outside, "app", ".next"), join(r, ".next"))
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("stops at depth 4", async () => {
    const r = await root()
    await writeDistDir(r, "a/b/c/d/.next")
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("prefers .next when it qualifies, even alongside another qualifying directory", async () => {
    const r = await root()
    await writeDistDir(r, ".next")
    await writeDistDir(r, "build")
    expect(await findNextDistDir(r)).toBe(".next")
  })

  it("does not descend into node_modules, .git, out, or public", async () => {
    const r = await root()
    await writeDistDir(r, join("node_modules", ".next"))
    await writeDistDir(r, join(".git", ".next"))
    await writeDistDir(r, join("out", ".next"))
    await writeDistDir(r, join("public", ".next"))
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("ignores a directory with only ONE of the two required files", async () => {
    const r = await root()
    await mkdir(join(r, ".next"), { recursive: true })
    await writeFile(join(r, ".next", "BUILD_ID"), "abc123")
    // required-server-files.json missing
    expect(await findNextDistDir(r)).toBeNull()
  })

  it("answers null when nothing qualifies", async () => {
    const r = await root()
    expect(await findNextDistDir(r)).toBeNull()
  })
})

/**
 * Codex round 20, item 2. `build/server/index.js` and `build/client/` used to
 * be hard-coded in `react-router.ts`, so a project whose `react-router.config`
 * sets `buildDirectory` or `serverBuildFile` was not recognised at all. The
 * markers scanned for are the pair a framework-mode build always writes
 * together: a `client/` directory and a `server/` directory holding exactly
 * one bundle.
 */
async function writeReactRouterBuild(
  base: string,
  rel: string,
  opts: { serverFiles?: string[]; clientHtml?: boolean } = {},
): Promise<void> {
  await mkdir(join(base, rel, "server"), { recursive: true })
  for (const name of opts.serverFiles ?? ["index.js"]) {
    await writeFile(join(base, rel, "server", name), "export default null")
  }
  await mkdir(join(base, rel, "client"), { recursive: true })
  if (opts.clientHtml !== false) await writeFile(join(base, rel, "client", "index.html"), "<html></html>")
}

describe("findReactRouterBuildDir", () => {
  it("finds the default build directory and its index.js bundle", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "build")
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "build", serverFile: "index.js" })
  })

  it("finds a configured buildDirectory at depth 1", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "dist")
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "dist", serverFile: "index.js" })
  })

  it("finds a workspace app's build three segments down (apps/web/build)", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "apps/web/build")
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "apps/web/build", serverFile: "index.js" })
  })

  it("finds a configured buildDirectory at depth 2", async () => {
    const r = await root()
    await writeReactRouterBuild(r, join("out", "rr"))
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: join("out", "rr"), serverFile: "index.js" })
  })

  it("does not follow a symlinked directory out of the checkout (codex round 31)", async () => {
    const outside = await root()
    await writeReactRouterBuild(outside, "build")
    const r = await root()
    await symlink(outside, join(r, "linked"))
    await symlink(join(outside, "build"), join(r, "build"))
    expect(await findReactRouterBuildDir(r)).toBeNull()
  })

  it("finds a workspace app's nested buildDirectory four segments down (apps/web/dist/rr, codex round 31)", async () => {
    const r = await root()
    await writeReactRouterBuild(r, join("apps", "web", "dist", "rr"))
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: join("apps", "web", "dist", "rr"), serverFile: "index.js" })
  })

  it("prefers build when it qualifies, even alongside another qualifying directory", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "build")
    await writeReactRouterBuild(r, "dist")
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "build", serverFile: "index.js" })
  })

  it("names a single custom serverBuildFile", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "dist", { serverFiles: ["app.js"] })
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "dist", serverFile: "app.js" })
  })

  it("takes index.js when the server directory holds other bundles too", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "build", { serverFiles: ["index.js", "chunk.js"] })
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "build", serverFile: "index.js" })
  })

  it("takes a sole .cjs bundle, the shape serverModuleFormat cjs writes (codex round 23)", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "build", { serverFiles: ["app.cjs"] })
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: "build", serverFile: "app.cjs" })
  })

  it("answers null when the server directory holds two bundles and no index.js", async () => {
    const r = await root()
    await writeReactRouterBuild(r, "build", { serverFiles: ["app.js", "chunk.mjs"] })
    expect(await findReactRouterBuildDir(r)).toBeNull()
  })

  it("ignores a directory with a client but no server", async () => {
    const r = await root()
    await mkdir(join(r, "build", "client"), { recursive: true })
    expect(await findReactRouterBuildDir(r)).toBeNull()
  })

  it("does not descend into node_modules, .git or public", async () => {
    const r = await root()
    await writeReactRouterBuild(r, join("node_modules", "build"))
    await writeReactRouterBuild(r, join(".git", "build"))
    await writeReactRouterBuild(r, join("public", "build"))
    expect(await findReactRouterBuildDir(r)).toBeNull()
  })

  it("answers null when nothing qualifies", async () => {
    const r = await root()
    expect(await findReactRouterBuildDir(r)).toBeNull()
  })
})

/**
 * Codex round 20, item 3. `.output/server/index.mjs` and `.output/public`
 * were hard-coded in `nuxt.ts`, so a project whose Nitro config sets
 * `output.dir` was not recognised as a server build. The markers are the pair
 * Nitro writes together: `server/index.mjs` and a `public/` directory.
 */
async function writeNitroOutput(base: string, rel: string, opts: { publicDir?: boolean } = {}): Promise<void> {
  await mkdir(join(base, rel, "server"), { recursive: true })
  await writeFile(join(base, rel, "server", "index.mjs"), "export default null")
  if (opts.publicDir !== false) await mkdir(join(base, rel, "public"), { recursive: true })
}

describe("findNitroOutputDir", () => {
  it("finds the default .output directory", async () => {
    const r = await root()
    await writeNitroOutput(r, ".output")
    expect(await findNitroOutputDir(r)).toBe(".output")
  })

  it("finds a configured output.dir at depth 1", async () => {
    const r = await root()
    await writeNitroOutput(r, "dist")
    expect(await findNitroOutputDir(r)).toBe("dist")
  })

  it("finds a workspace app's output three segments down (apps/web/.output)", async () => {
    const r = await root()
    await writeNitroOutput(r, "apps/web/.output")
    expect(await findNitroOutputDir(r)).toBe("apps/web/.output")
  })

  it("finds a configured output.dir at depth 2", async () => {
    const r = await root()
    await writeNitroOutput(r, join("build", "nitro"))
    expect(await findNitroOutputDir(r)).toBe(join("build", "nitro"))
  })

  it("finds a workspace app's nested output.dir four segments down (apps/web/dist/nitro, codex round 31)", async () => {
    const r = await root()
    await writeNitroOutput(r, join("apps", "web", "dist", "nitro"))
    expect(await findNitroOutputDir(r)).toBe(join("apps", "web", "dist", "nitro"))
  })

  it("prefers .output when it qualifies, even alongside another qualifying directory", async () => {
    const r = await root()
    await writeNitroOutput(r, ".output")
    await writeNitroOutput(r, "dist")
    expect(await findNitroOutputDir(r)).toBe(".output")
  })

  it("ignores a directory with a server bundle but no public directory", async () => {
    const r = await root()
    await writeNitroOutput(r, "dist", { publicDir: false })
    expect(await findNitroOutputDir(r)).toBeNull()
  })

  it("does not descend into node_modules, .git or public", async () => {
    const r = await root()
    await writeNitroOutput(r, join("node_modules", ".output"))
    await writeNitroOutput(r, join(".git", ".output"))
    await writeNitroOutput(r, join("public", ".output"))
    expect(await findNitroOutputDir(r)).toBeNull()
  })

  it("answers null when nothing qualifies", async () => {
    const r = await root()
    expect(await findNitroOutputDir(r)).toBeNull()
  })
})

/**
 * Codex round 29, item 1, widened in round 31. The package that owns a build
 * output is its nearest ancestor with a `package.json`, not simply its
 * parent: a workspace app's custom nested dist dir (`apps/web/build/next`)
 * belongs to `apps/web`, and taking the parent named `apps/web/build`, a
 * directory that owns nothing.
 */
describe("owningPackageDir", () => {
  async function writePackage(base: string, rel: string): Promise<void> {
    await mkdir(join(base, rel), { recursive: true })
    await writeFile(join(base, rel, "package.json"), JSON.stringify({ name: rel }))
  }

  it("names the app package that owns a workspace dist dir", async () => {
    const r = await root()
    await writePackage(r, "apps/web")
    expect(await owningPackageDir(r, "apps/web/.next")).toBe(join("apps", "web"))
  })

  it("skips a custom nested output dir's own parent when it holds no package.json", async () => {
    const r = await root()
    await writePackage(r, "apps/web")
    expect(await owningPackageDir(r, "apps/web/build/next")).toBe(join("apps", "web"))
  })

  it("takes the nearest package when several ancestors hold one", async () => {
    const r = await root()
    await writePackage(r, "apps")
    await writePackage(r, "apps/web")
    expect(await owningPackageDir(r, "apps/web/.next")).toBe(join("apps", "web"))
  })

  it("answers null when no ancestor below the root holds a package.json (the root owns it)", async () => {
    const r = await root()
    await writePackage(r, ".")
    await mkdir(join(r, "build", "next"), { recursive: true })
    expect(await owningPackageDir(r, "build/next")).toBeNull()
    expect(await owningPackageDir(r, ".next")).toBeNull()
  })
})
