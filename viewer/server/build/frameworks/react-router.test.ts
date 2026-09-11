import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { REACT_ROUTER_ADAPTER } from "./react-router"

/**
 * Detection reads what the build WROTE: `build/server/index.js` means a server
 * build happened, `build/client/index.html` means SPA mode.
 */
const roots: string[] = []
async function checkout(opts: {
  reactRouter?: "react-router" | "@react-router/dev" | false
  inDevDependencies?: boolean
  serverBuild?: boolean
  clientHtml?: boolean
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fw-react-router-"))
  roots.push(root)

  const pkg: {
    name: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } = { name: "x" }

  if (opts.reactRouter === false) {
    pkg.dependencies = {}
  } else if (opts.reactRouter) {
    const key = opts.inDevDependencies ? "devDependencies" : "dependencies"
    if (!pkg[key]) pkg[key] = {}
    pkg[key]![opts.reactRouter] = opts.reactRouter === "react-router" ? "^6.0.0" : "^2.0.0"
  } else {
    pkg.dependencies = { "react-router": "^6.0.0" }
  }

  await writeFile(join(root, "package.json"), JSON.stringify(pkg))

  if (opts.serverBuild) {
    await mkdir(join(root, "build", "server"), { recursive: true })
    await writeFile(join(root, "build", "server", "index.js"), "export default null")
  }
  if (opts.clientHtml) {
    await mkdir(join(root, "build", "client"), { recursive: true })
    await writeFile(join(root, "build", "client", "index.html"), "<html></html>")
  }
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe("React Router adapter", () => {
  it("ignores a checkout without react-router or @react-router/dev", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ reactRouter: false, serverBuild: true })),
    ).toBeNull()
  })
  it("reads build/server/index.js as a server build", async () => {
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ serverBuild: true }))).toEqual({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
      reason: "React Router framework mode with a server build",
    })
  })
  it("reads build/client/index.html with no server build as static SPA", async () => {
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ clientHtml: true }))).toEqual({
      kind: "static",
      outputDir: "build/client",
      reason: "React Router SPA mode",
    })
  })
  it("recognises @react-router/dev in devDependencies", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(
        await checkout({ reactRouter: "@react-router/dev", inDevDependencies: true, serverBuild: true }),
      ),
    ).toEqual({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
      reason: "React Router framework mode with a server build",
    })
  })
  it("prefers server build when both exist", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({ serverBuild: true, clientHtml: true }),
    )
    expect(shape?.kind).toBe("server")
  })
  it("answers null when the build wrote neither", async () => {
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({}))).toBeNull()
  })
})
