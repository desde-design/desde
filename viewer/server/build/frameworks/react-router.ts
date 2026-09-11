import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * React Router writes `build/server/index.js` for a server build, or
 * `build/client/index.html` for SPA mode.
 */
export const REACT_ROUTER_ADAPTER: FrameworkAdapter = {
  id: "react-router",
  async inspectBuild(checkoutRoot) {
    // Check for react-router or @react-router/dev in dependencies or devDependencies.
    const hasReactRouter = await dependsOn(checkoutRoot, "react-router")
    const hasReactRouterDev = await dependsOn(checkoutRoot, "@react-router/dev")
    if (!hasReactRouter && !hasReactRouterDev) return null

    if (await isFile(join(checkoutRoot, "build", "server", "index.js"))) {
      return {
        kind: "server",
        // react-router-serve reads PORT from the environment, which the process manager sets.
        start: ["node_modules/.bin/react-router-serve", "build/server/index.js"],
        reason: "React Router framework mode with a server build",
      }
    }
    if (await isFile(join(checkoutRoot, "build", "client", "index.html"))) {
      return {
        kind: "static",
        outputDir: "build/client",
        reason: "React Router SPA mode",
      }
    }
    return null
  },
}
