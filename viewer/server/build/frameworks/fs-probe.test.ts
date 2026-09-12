import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findNextDistDir, findReactRouterBuildDir } from "./fs-probe"

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

  it("finds a custom nested distDir (distDir: \"build/next\")", async () => {
    const r = await root()
    await writeDistDir(r, "build/next")
    expect(await findNextDistDir(r)).toBe("build/next")
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

  it("finds a configured buildDirectory at depth 2", async () => {
    const r = await root()
    await writeReactRouterBuild(r, join("out", "rr"))
    expect(await findReactRouterBuildDir(r)).toEqual({ dir: join("out", "rr"), serverFile: "index.js" })
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
