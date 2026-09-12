import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { dependsOnAt, findReactRouterBuildDir, isFile, owningPackageDir, type ReactRouterBuild } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * React Router writes `build/server/index.js` for a framework-mode build
 * and `build/client/index.html` for SPA mode. The two files do NOT tell the
 * modes apart on their own (codex round 11, Fix 2, corrected in review):
 *
 * - `ssr: false` still writes `build/server/index.js`, which React Router
 *   uses at build time to pre-render `index.html` and never again. Reading
 *   the server file alone treated every SPA build as a server prototype.
 * - `ssr: true` with `prerender: ["/"]` writes `build/client/index.html`
 *   too, and that app still needs its server for every other route.
 *   Reading `index.html` alone would have served it statically and broken
 *   every dynamic route.
 *
 * So the server bundle is asked. `@react-router/dev` writes
 * `export const isSpaMode = <boolean>` into it (`vite.js`, the server build
 * module; the type is `ServerBuild["isSpaMode"]`), and the built file keeps
 * that text. `isSpaMode = true` next to a client `index.html` is SPA mode
 * and static; anything else with a server bundle is a server build.
 */
const SPA_MODE_MARKER = /\bisSpaMode\s*=\s*true\b/

/** `react-router.config`'s default `buildDirectory`. */
const DEFAULT_BUILD_DIR = "build"

export const REACT_ROUTER_ADAPTER: FrameworkAdapter = {
  id: "react-router",
  async inspectBuild(checkoutRoot, target) {
    // The app the configured output dir belongs to is looked at first
    // (codex round 34): its own default `build`, then the scan from there.
    const within = target?.within ?? null
    const defaultDir = within === null ? DEFAULT_BUILD_DIR : join(within, DEFAULT_BUILD_DIR)
    // The default layout FIRST and by name, then the scan (codex round 20,
    // item 2). Not the scan alone: the scan needs a `client/` directory beside
    // the `server/` one to be sure a directory is a build at all, and a build
    // this manager can serve does not strictly have to have written one.
    const found: ReactRouterBuild | null = (await isFile(join(checkoutRoot, defaultDir, "server", "index.js")))
      ? { dir: defaultDir, serverFile: "index.js" }
      : await findReactRouterBuildDir(checkoutRoot, within)

    // Codex round 29, item 1. `dependsOn` used to read only the workspace
    // root's `package.json`. In an npm or pnpm workspace the framework is
    // declared in the app package's own `package.json`, not the root's; the
    // app directory is the package that owns the found build dir (round
    // 31; when any build was found at all — a bare client-only checkout has
    // no app dir to check beyond the root).
    const appDir = found ? await owningPackageDir(checkoutRoot, found.dir) : null
    const hasReactRouter =
      (await dependsOnAt(checkoutRoot, "react-router")) ||
      (appDir !== null && (await dependsOnAt(join(checkoutRoot, appDir), "react-router")))
    const hasReactRouterDev =
      (await dependsOnAt(checkoutRoot, "@react-router/dev")) ||
      (appDir !== null && (await dependsOnAt(join(checkoutRoot, appDir), "@react-router/dev")))
    if (!hasReactRouter && !hasReactRouterDev) return null

    const clientDir = join(found?.dir ?? defaultDir, "client")
    const clientHtml = await isFile(join(checkoutRoot, clientDir, "index.html"))
    if (found) {
      const serverBundleRel = join(found.dir, "server", found.serverFile)
      const serverBundle = join(checkoutRoot, serverBundleRel)
      if (clientHtml && (await isSpaModeBundle(serverBundle))) {
        return { kind: "static", outputDir: clientDir, reason: "React Router SPA mode" }
      }
      // Codex round 15, Fix 3. `@react-router/serve` is a SEPARATE package
      // from `react-router`/`@react-router/dev` — a checkout can build a
      // server bundle with only the dev package installed, or run its own
      // custom server, and never have this binary at all. Recording the
      // `start` command without checking it exists marked such a checkout
      // `deployed` and then ENOENT'd on every cold start.
      //
      // Codex round 30: in a workspace the launcher is installed under the
      // app package (`apps/web/node_modules/.bin/react-router-serve`), not
      // the root, so the app's own copy is preferred and the root's is the
      // fallback; the recorded argv names whichever one exists.
      const appServeBinaryRel = appDir !== null ? join(appDir, "node_modules", ".bin", "react-router-serve") : null
      const serveBinaryRel =
        appServeBinaryRel !== null && (await isFile(join(checkoutRoot, appServeBinaryRel)))
          ? appServeBinaryRel
          : (await isFile(join(checkoutRoot, "node_modules", ".bin", "react-router-serve")))
            ? "node_modules/.bin/react-router-serve"
            : null
      if (serveBinaryRel === null) {
        return {
          kind: "unsupported",
          reason:
            "This React Router build needs @react-router/serve to run. Add it to the project, or build a static (SPA) output.",
        }
      }
      return {
        kind: "server",
        // react-router-serve reads PORT from the environment, which the process manager sets.
        start: [serveBinaryRel, serverBundleRel],
        reason: "React Router framework mode with a server build",
      }
    }
    if (clientHtml) {
      return { kind: "static", outputDir: clientDir, reason: "React Router SPA mode" }
    }
    return null
  },
}

async function isSpaModeBundle(path: string): Promise<boolean> {
  try {
    return SPA_MODE_MARKER.test(await readFile(path, "utf8"))
  } catch {
    return false
  }
}
