import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
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

export const REACT_ROUTER_ADAPTER: FrameworkAdapter = {
  id: "react-router",
  async inspectBuild(checkoutRoot) {
    const hasReactRouter = await dependsOn(checkoutRoot, "react-router")
    const hasReactRouterDev = await dependsOn(checkoutRoot, "@react-router/dev")
    if (!hasReactRouter && !hasReactRouterDev) return null

    const serverBundle = join(checkoutRoot, "build", "server", "index.js")
    const clientHtml = await isFile(join(checkoutRoot, "build", "client", "index.html"))
    if (await isFile(serverBundle)) {
      if (clientHtml && (await isSpaModeBundle(serverBundle))) {
        return { kind: "static", outputDir: "build/client", reason: "React Router SPA mode" }
      }
      return {
        kind: "server",
        // react-router-serve reads PORT from the environment, which the process manager sets.
        start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
        reason: "React Router framework mode with a server build",
      }
    }
    if (clientHtml) {
      return { kind: "static", outputDir: "build/client", reason: "React Router SPA mode" }
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
