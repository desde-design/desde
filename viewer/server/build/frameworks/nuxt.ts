import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Nuxt writes `.output/server/index.mjs` for a server build, or
 * `.output/public/index.html` for a static generation.
 */
export const NUXT_ADAPTER: FrameworkAdapter = {
  id: "nuxt",
  async inspectBuild(checkoutRoot) {
    if (!(await dependsOn(checkoutRoot, "nuxt"))) return null
    if (await isFile(join(checkoutRoot, ".output", "server", "index.mjs"))) {
      return {
        kind: "server",
        start: ["node", ".output/server/index.mjs"],
        reason: "Nuxt with a server build",
      }
    }
    if (await isFile(join(checkoutRoot, ".output", "public", "index.html"))) {
      return {
        kind: "static",
        outputDir: ".output/public",
        reason: "Nuxt static generation",
      }
    }
    return null
  },
}
