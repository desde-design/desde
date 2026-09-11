import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-nuxt-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: opts.nuxt === false ? {} : { nuxt: "^3.0.0" } }),
  )
  if (opts.serverBuild) {
    await mkdir(join(root, ".output", "server"), { recursive: true })
    await writeFile(join(root, ".output", "server", "index.mjs"), "export default null")
  }
  if (opts.staticHtml) {
    await mkdir(join(root, ".output", "public"), { recursive: true })
    await writeFile(join(root, ".output", "public", "index.html"), "<html></html>")
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
})
