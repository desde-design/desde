import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * React Router writes `build/server/index.js` for a server build, or
 * `build/client/index.html` for SPA mode. `build/client/index.html` is
 * checked FIRST (codex round 11, Fix 2): with `ssr: false`, React Router
 * still writes `build/server/index.js` next to `build/client/index.html` —
 * it uses that server bundle at BUILD time, for pre-rendering, and never
 * again after that. Reading the server file first used to treat every SPA
 * build as a server prototype, which needs an isolated origin and a running
 * process for a build that has no server to run.
 */
export const REACT_ROUTER_ADAPTER: FrameworkAdapter = {
  id: "react-router",
  async inspectBuild(checkoutRoot) {
    // Check for react-router or @react-router/dev in dependencies or devDependencies.
    const hasReactRouter = await dependsOn(checkoutRoot, "react-router")
    const hasReactRouterDev = await dependsOn(checkoutRoot, "@react-router/dev")
    if (!hasReactRouter && !hasReactRouterDev) return null

    if (await isFile(join(checkoutRoot, "build", "client", "index.html"))) {
      return {
        kind: "static",
        outputDir: "build/client",
        reason: "React Router SPA mode",
      }
    }
    if (await isFile(join(checkoutRoot, "build", "server", "index.js"))) {
      return {
        kind: "server",
        // react-router-serve reads PORT from the environment, which the process manager sets.
        start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
        reason: "React Router framework mode with a server build",
      }
    }
    return null
  },
}
