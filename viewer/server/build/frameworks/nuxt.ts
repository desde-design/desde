import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Nuxt writes `.output/server/index.mjs` for a server build, or
 * `.output/public/index.html` for a static generation. `.output/public/index.html`
 * is checked FIRST (codex round 11, Fix 2 — same question as the React Router
 * adapter, decided the same way): Nitro always builds a server bundle as part
 * of its pipeline, even for a prerendered `ssr: false` build (`nuxt generate`,
 * or `nuxt build --prerender`), so `.output/server/index.mjs` exists there
 * too. Nuxt's own documented static-hosting path deploys `.output/public`
 * alone, with no Node server involved — reading the server file first would
 * treat that static build as a server prototype. INFERRED from Nuxt's docs,
 * not built and measured — see the codex-r11 report.
 */
export const NUXT_ADAPTER: FrameworkAdapter = {
  id: "nuxt",
  async inspectBuild(checkoutRoot) {
    if (!(await dependsOn(checkoutRoot, "nuxt"))) return null
    if (await isFile(join(checkoutRoot, ".output", "public", "index.html"))) {
      return {
        kind: "static",
        outputDir: ".output/public",
        reason: "Nuxt static generation",
      }
    }
    if (await isFile(join(checkoutRoot, ".output", "server", "index.mjs"))) {
      return {
        kind: "server",
        start: ["node", ".output/server/index.mjs"],
        reason: "Nuxt with a server build",
      }
    }
    return null
  },
}
