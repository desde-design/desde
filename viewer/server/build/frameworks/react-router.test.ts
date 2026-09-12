import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  /** What `@react-router/dev` wrote into the server bundle for `isSpaMode`. */
  spaMode?: boolean
  clientHtml?: boolean
  /** Whether `node_modules/.bin/react-router-serve` exists in this checkout. */
  serveBinary?: boolean
  /** Whether `<parent of buildDir>/node_modules/.bin/react-router-serve` exists (codex round 30). */
  appServeBinary?: boolean
  /** What `react-router.config`'s `buildDirectory` was set to, if anything. */
  buildDir?: string
  /** What `react-router.config`'s `serverBuildFile` was set to, if anything. */
  serverFile?: string
  /** A second bundle beside the first one, so no single server bundle can be named. */
  extraServerFile?: string
  /**
   * Dependencies to write into a package.json at the PARENT of `buildDir` —
   * the app directory a workspace scan derives (codex round 29, item 1).
   * Skipped when `buildDir` has no parent.
   */
  appPackageJson?: Record<string, string>
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

  const buildDir = opts.buildDir ?? "build"
  if (opts.serverBuild) {
    await mkdir(join(root, buildDir, "server"), { recursive: true })
    await writeFile(
      join(root, buildDir, "server", opts.serverFile ?? "index.js"),
      `const isSpaMode = ${opts.spaMode === true};\nexport { isSpaMode };\nexport default null`,
    )
    if (opts.extraServerFile) {
      await writeFile(join(root, buildDir, "server", opts.extraServerFile), "export default null")
    }
  }
  if (opts.clientHtml) {
    await mkdir(join(root, buildDir, "client"), { recursive: true })
    await writeFile(join(root, buildDir, "client", "index.html"), "<html></html>")
  }
  if (opts.serveBinary) {
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(root, "node_modules", ".bin", "react-router-serve"), "#!/usr/bin/env node\n")
  }
  if (opts.appServeBinary) {
    const appDir = dirname(buildDir)
    await mkdir(join(root, appDir, "node_modules", ".bin"), { recursive: true })
    await writeFile(join(root, appDir, "node_modules", ".bin", "react-router-serve"), "#!/usr/bin/env node\n")
  }
  if (opts.appPackageJson) {
    const appDir = dirname(buildDir)
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

describe("React Router adapter", () => {
  it("ignores a checkout without react-router or @react-router/dev", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ reactRouter: false, serverBuild: true })),
    ).toBeNull()
  })
  it("reads build/server/index.js as a server build", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ serverBuild: true, serveBinary: true })),
    ).toEqual({
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
        await checkout({
          reactRouter: "@react-router/dev",
          inDevDependencies: true,
          serverBuild: true,
          serveBinary: true,
        }),
      ),
    ).toEqual({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
      reason: "React Router framework mode with a server build",
    })
  })
  /**
   * Codex round 11, Fix 2, corrected in review. `ssr: false` still writes
   * `build/server/index.js` (React Router uses it at build time for
   * pre-rendering) next to `build/client/index.html`, so the server file
   * alone does not mean a server. But `ssr: true` with a pre-rendered root
   * writes `build/client/index.html` too, so the html alone does not mean
   * an SPA either. The server bundle's own `isSpaMode` export decides.
   */
  it("reads a server bundle marked isSpaMode next to a client index.html as static", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({ serverBuild: true, spaMode: true, clientHtml: true }),
    )
    expect(shape).toEqual({
      kind: "static",
      outputDir: "build/client",
      reason: "React Router SPA mode",
    })
  })
  it("keeps a server build that pre-rendered its root as a server (isSpaMode false)", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({ serverBuild: true, spaMode: false, clientHtml: true, serveBinary: true }),
    )
    expect(shape?.kind).toBe("server")
  })
  it("answers null when the build wrote neither", async () => {
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({}))).toBeNull()
  })

  /**
   * Codex round 15, Fix 3. `node_modules/.bin/react-router-serve` used to be
   * recorded as the start command without checking it exists. A checkout
   * with a custom server, or only `@react-router/dev` installed (the
   * `react-router-serve` package `@react-router/serve` ships is a SEPARATE
   * dependency a project can omit), got marked `deployed` and then ENOENT'd
   * on every cold start, spending the restart budget for nothing.
   */
  it("reports unsupported when the server bundle exists but @react-router/serve does not", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(await checkout({ serverBuild: true, serveBinary: false }))
    expect(shape).toEqual({
      kind: "unsupported",
      reason:
        "This React Router build needs @react-router/serve to run. Add it to the project, or build a static (SPA) output.",
    })
  })

  /**
   * Codex round 20, item 2. `build/server/index.js` and `build/client/` were
   * hard-coded, so a project that set `buildDirectory` or `serverBuildFile` in
   * `react-router.config` was not recognised at all: no server build was
   * found, and the deployment fell through to the generic static default.
   */
  it("follows a configured buildDirectory and serverBuildFile", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(
        await checkout({
          serverBuild: true,
          clientHtml: true,
          serveBinary: true,
          buildDir: "dist",
          serverFile: "app.js",
        }),
      ),
    ).toEqual({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", join("dist", "server", "app.js")],
      reason: "React Router framework mode with a server build",
    })
  })

  it("reads a configured build directory's SPA output as static", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(
        await checkout({ serverBuild: true, spaMode: true, clientHtml: true, buildDir: "dist" }),
      ),
    ).toEqual({
      kind: "static",
      outputDir: join("dist", "client"),
      reason: "React Router SPA mode",
    })
  })

  /**
   * Two bundles beside each other and no `index.js`: nothing names which one
   * `react-router-serve` should be given, so the directory does not qualify as
   * a build directory at all. Answering with a guess would record a start
   * command that ENOENTs, or boots the wrong file, on every cold start.
   */
  it("answers null for a configured build directory with two server bundles and no index.js", async () => {
    expect(
      await REACT_ROUTER_ADAPTER.inspectBuild(
        await checkout({
          serverBuild: true,
          clientHtml: true,
          serveBinary: true,
          buildDir: "dist",
          serverFile: "app.js",
          extraServerFile: "other.mjs",
        }),
      ),
    ).toBeNull()
  })

  it("still reports unsupported for a server build with @react-router/dev only, when the serve binary is missing", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({ reactRouter: "@react-router/dev", inDevDependencies: true, serverBuild: true }),
    )
    expect(shape?.kind).toBe("unsupported")
  })

  /**
   * Codex round 29, item 1. `dependsOn` used to read only the workspace
   * root's `package.json`. In an npm or pnpm workspace `react-router` is
   * declared in the app package's own `package.json`, so a checkout where
   * the root lists nothing fell through to the static default.
   */
  it("recognises react-router declared only in the app package's package.json in a workspace", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({
        reactRouter: false,
        serverBuild: true,
        clientHtml: true,
        serveBinary: true,
        buildDir: "apps/web",
        appPackageJson: { "react-router": "^6.0.0" },
      }),
    )
    expect(shape?.kind).toBe("server")
  })

  it("still answers null when neither the root nor the app package lists react-router", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({ reactRouter: false, serverBuild: true, clientHtml: true, serveBinary: true, buildDir: "apps/web" }),
    )
    expect(shape).toBeNull()
  })

  it("reads a workspace app's client-only build as static when react-router is declared only in the app package (codex round 53)", async () => {
    const root = await checkout({ reactRouter: false })
    await mkdir(join(root, "apps", "web", "build", "client"), { recursive: true })
    await writeFile(join(root, "apps", "web", "build", "client", "index.html"), "<html></html>")
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { "react-router": "^6.0.0" } }))
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(root, { within: join("apps", "web") })).toEqual({
      kind: "static",
      outputDir: join("apps", "web", "build", "client"),
      reason: "React Router SPA mode",
    })
  })

  it("starts the app the configured output dir belongs to when a workspace built several (codex round 34)", async () => {
    const root = await checkout({ serverBuild: true, serveBinary: true })
    for (const rel of [join("apps", "web", "build", "server"), join("apps", "web", "build", "client")]) {
      await mkdir(join(root, rel), { recursive: true })
    }
    await writeFile(join(root, "apps", "web", "build", "server", "index.js"), "const isSpaMode = false;\nexport { isSpaMode };\nexport default null")
    await writeFile(join(root, "apps", "web", "build", "client", "index.html"), "<html></html>")
    await writeFile(join(root, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { "react-router": "^6.0.0" } }))

    expect(await REACT_ROUTER_ADAPTER.inspectBuild(root, { within: join("apps", "web") })).toMatchObject({
      kind: "server",
      start: [join("..", "..", "node_modules", ".bin", "react-router-serve"), join("build", "server", "index.js")],
      cwd: join("apps", "web"),
    })
    expect(await REACT_ROUTER_ADAPTER.inspectBuild(root, { within: null })).toMatchObject({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
    })
  })

  /**
   * Codex round 30. A workspace installs `@react-router/serve` under the app
   * package, so the launcher lives at `apps/web/node_modules/.bin/...`; the
   * root-only check reported `unsupported` for a build that runs fine.
   */
  it("prefers the app package's own react-router-serve in a workspace", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({
        reactRouter: false,
        serverBuild: true,
        clientHtml: true,
        appServeBinary: true,
        buildDir: "apps/web/build",
        appPackageJson: { "react-router": "^6.0.0" },
      }),
    )
    // Codex round 39: run from the app directory, with paths relative to it,
    // since react-router-serve resolves `build/client` and `public` against
    // its working directory.
    expect(shape).toEqual({
      kind: "server",
      start: ["node_modules/.bin/react-router-serve", join("build", "server", "index.js")],
      cwd: join("apps", "web"),
      reason: "React Router framework mode with a server build",
    })
  })

  it("falls back to the root react-router-serve when the app package has none", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({
        reactRouter: false,
        serverBuild: true,
        clientHtml: true,
        serveBinary: true,
        buildDir: "apps/web/build",
        appPackageJson: { "react-router": "^6.0.0" },
      }),
    )
    expect(shape).toMatchObject({
      kind: "server",
      start: [join("..", "..", "node_modules", ".bin", "react-router-serve"), join("build", "server", "index.js")],
      cwd: join("apps", "web"),
    })
  })

  it("reports unsupported when neither the app package nor the root has react-router-serve", async () => {
    const shape = await REACT_ROUTER_ADAPTER.inspectBuild(
      await checkout({
        reactRouter: false,
        serverBuild: true,
        clientHtml: true,
        buildDir: "apps/web/build",
        appPackageJson: { "react-router": "^6.0.0" },
      }),
    )
    expect(shape?.kind).toBe("unsupported")
  })
})
