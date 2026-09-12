import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NUXT_ADAPTER } from "./nuxt"

/**
 * Detection reads what the build WROTE, never the config: `.output/server/index.mjs`
 * means a server build happened, `.output/public/index.html` means static generation.
 */
const roots: string[] = []
async function checkout(opts: {
  nuxt?: boolean
  serverBuild?: boolean
  staticHtml?: boolean
  /** A `public/` directory in the output, with no `index.html` in it. */
  publicDir?: boolean
  /** What Nitro's `output.dir` was set to, if anything. */
  outputDir?: string
  /**
   * Dependencies to write into a package.json at the PARENT of `outputDir` —
   * the app directory a workspace scan derives (codex round 29, item 1).
   * Skipped when `outputDir` has no parent.
   */
  appPackageJson?: Record<string, string>
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-nuxt-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: opts.nuxt === false ? {} : { nuxt: "^3.0.0" } }),
  )
  const outputDir = opts.outputDir ?? ".output"
  if (opts.serverBuild) {
    await mkdir(join(root, outputDir, "server"), { recursive: true })
    await writeFile(join(root, outputDir, "server", "index.mjs"), "export default null")
  }
  if (opts.publicDir) await mkdir(join(root, outputDir, "public"), { recursive: true })
  if (opts.staticHtml) {
    await mkdir(join(root, outputDir, "public"), { recursive: true })
    await writeFile(join(root, outputDir, "public", "index.html"), "<html></html>")
  }
  if (opts.appPackageJson) {
    const appDir = dirname(outputDir)
    if (appDir !== ".") {
      await mkdir(join(root, appDir), { recursive: true })
      await writeFile(
        join(root, appDir, "package.json"),
        JSON.stringify({ name: "app", dependencies: opts.appPackageJson }),
      )
    }
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe("Nuxt adapter", () => {
  it("ignores a checkout without nuxt in its dependencies", async () => {
    expect(await NUXT_ADAPTER.inspectBuild(await checkout({ nuxt: false, serverBuild: true }))).toBeNull()
  })
  it("reads .output/server/index.mjs as a server build", async () => {
    expect(await NUXT_ADAPTER.inspectBuild(await checkout({ serverBuild: true }))).toEqual({
      kind: "server",
      start: ["node", ".output/server/index.mjs"],
      reason: "Nuxt with a server build",
    })
  })
  it("starts the app the configured output dir belongs to when a workspace built several (codex round 34)", async () => {
    const root = await checkout({ serverBuild: true })
    await mkdir(join(root, "apps", "web", ".output", "server"), { recursive: true })
    await mkdir(join(root, "apps", "web", ".output", "public"), { recursive: true })
    await writeFile(join(root, "apps", "web", ".output", "server", "index.mjs"), "export default null")
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { nuxt: "^3.0.0" } }))

    expect(await NUXT_ADAPTER.inspectBuild(root, { within: join("apps", "web") })).toMatchObject({
      kind: "server",
      start: ["node", join("apps", "web", ".output", "server", "index.mjs")],
    })
    expect(await NUXT_ADAPTER.inspectBuild(root, { within: null })).toMatchObject({
      kind: "server",
      start: ["node", ".output/server/index.mjs"],
    })
  })
  it("reads .output/public/index.html with no server build as static", async () => {
    expect(await NUXT_ADAPTER.inspectBuild(await checkout({ staticHtml: true }))).toEqual({
      kind: "static",
      outputDir: ".output/public",
      reason: "Nuxt static generation",
    })
  })
  it("prefers server build when both exist", async () => {
    const shape = await NUXT_ADAPTER.inspectBuild(await checkout({ serverBuild: true, staticHtml: true }))
    expect(shape?.kind).toBe("server")
  })
  it("answers null when the build wrote neither", async () => {
    expect(await NUXT_ADAPTER.inspectBuild(await checkout({}))).toBeNull()
  })

  /**
   * Codex round 20, item 3. `.output` was hard-coded, so a project whose
   * Nitro config sets `output.dir` was not recognised as a server build and
   * the deployment fell through to the generic static default.
   */
  it("follows a configured output.dir", async () => {
    expect(
      await NUXT_ADAPTER.inspectBuild(await checkout({ serverBuild: true, publicDir: true, outputDir: "dist" })),
    ).toEqual({
      kind: "server",
      start: ["node", join("dist", "server", "index.mjs")],
      reason: "Nuxt with a server build",
    })
  })

  it("follows a configured output.dir nested one level down", async () => {
    expect(
      await NUXT_ADAPTER.inspectBuild(
        await checkout({ serverBuild: true, publicDir: true, outputDir: join("build", "nitro") }),
      ),
    ).toEqual({
      kind: "server",
      start: ["node", join("build", "nitro", "server", "index.mjs")],
      reason: "Nuxt with a server build",
    })
  })

  it("prefers the server build in a configured output.dir when that build pre-rendered pages too", async () => {
    expect(
      await NUXT_ADAPTER.inspectBuild(await checkout({ serverBuild: true, staticHtml: true, outputDir: "dist" })),
    ).toEqual({
      kind: "server",
      start: ["node", join("dist", "server", "index.mjs")],
      reason: "Nuxt with a server build",
    })
  })

  /**
   * Codex round 29, item 1. `dependsOn` used to read only the workspace
   * root's `package.json`. In an npm or pnpm workspace `nuxt` is declared in
   * the app package's own `package.json`, so a checkout where the root
   * lists nothing fell through to the static default.
   */
  it("recognises nuxt declared only in the app package's package.json in a workspace", async () => {
    const shape = await NUXT_ADAPTER.inspectBuild(
      await checkout({
        nuxt: false,
        serverBuild: true,
        publicDir: true,
        outputDir: "apps/web",
        appPackageJson: { nuxt: "^3.0.0" },
      }),
    )
    expect(shape?.kind).toBe("server")
  })

  it("still answers null when neither the root nor the app package lists nuxt", async () => {
    const shape = await NUXT_ADAPTER.inspectBuild(
      await checkout({ nuxt: false, serverBuild: true, publicDir: true, outputDir: "apps/web" }),
    )
    expect(shape).toBeNull()
  })
})
