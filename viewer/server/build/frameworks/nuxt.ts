import { join } from "node:path"
import { dependsOnAt, findNitroOutputDir, isFile, owningPackageDir } from "./fs-probe"
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
 *
 * `.output` is where Nitro writes by default, but `output.dir` moves it, so
 * the default location is checked by name first and a scan
 * (`findNitroOutputDir`, codex round 20, item 3) answers for everything else.
 * The default is checked first and separately because the scan needs a
 * `public/` directory beside the server bundle to be sure a directory is a
 * Nitro output at all, and a server build does not strictly have to have
 * written one.
 *
 * The STATIC case stays on `.output` alone. A `public/` directory with no
 * server bundle beside it is far too ordinary a thing for a repo to hold to
 * go scanning for, so a static generation into a configured `output.dir` is
 * left to the generic static default, which publishes the output dir the
 * prototype itself names.
 */
const DEFAULT_OUTPUT_DIR = ".output"

export const NUXT_ADAPTER: FrameworkAdapter = {
  id: "nuxt",
  async inspectBuild(checkoutRoot) {
    const outputDir = (await isFile(join(checkoutRoot, DEFAULT_OUTPUT_DIR, "server", "index.mjs")))
      ? DEFAULT_OUTPUT_DIR
      : await findNitroOutputDir(checkoutRoot)

    // Codex round 29, item 1. `dependsOn` used to read only the workspace
    // root's `package.json`. In an npm or pnpm workspace `nuxt` is declared
    // in the app package's own `package.json`, not the root's; the app
    // directory is the package that owns the found output dir (round 31).
    const appDir = outputDir !== null ? await owningPackageDir(checkoutRoot, outputDir) : null
    const hasNuxt =
      (await dependsOnAt(checkoutRoot, "nuxt")) ||
      (appDir !== null && (await dependsOnAt(join(checkoutRoot, appDir), "nuxt")))
    if (!hasNuxt) return null

    if (outputDir !== null) {
      return {
        kind: "server",
        start: ["node", join(outputDir, "server", "index.mjs")],
        reason: "Nuxt with a server build",
      }
    }
    if (await isFile(join(checkoutRoot, DEFAULT_OUTPUT_DIR, "public", "index.html"))) {
      return {
        kind: "static",
        outputDir: join(DEFAULT_OUTPUT_DIR, "public"),
        reason: "Nuxt static generation",
      }
    }
    return null
  },
}
