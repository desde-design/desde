import { join } from "node:path"
import { dependsOn, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Nuxt writes `.output/server/index.mjs` for a server build, or
 * `.output/public/index.html` for a static generation.
 *
 * The server is checked FIRST on purpose, and a build that wrote both is a
 * server (codex round 11 review). `ssr: false` writes both, so the server
 * file alone does not prove a server; but an SSR app that pre-renders its
 * root (`routeRules: { "/": { prerender: true } }`) writes both too, and
 * that one needs its server for every other route. Nuxt leaves no marker
 * in the output that tells the two apart (React Router does; see
 * `react-router.ts`), so the safe reading is the one that never breaks an
 * app: Nitro serves a client-only build correctly, at the cost of a
 * process slot for a prototype that did not strictly need one.
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
