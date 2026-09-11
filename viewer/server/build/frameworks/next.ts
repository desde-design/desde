import { join } from "node:path"
import { dependsOn, findNextDistDir, isDir } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Next writes `out/` only for `output: "export"`; a server build writes
 * `BUILD_ID` and `required-server-files.json` together in its dist dir
 * (`.next` by default, or a custom `distDir` — see `findNextDistDir`, codex
 * round 4, Fix 4). `out/` wins when both exist: an export leaves its dist
 * dir behind as scratch.
 */
export const NEXT_ADAPTER: FrameworkAdapter = {
  id: "next",
  async inspectBuild(checkoutRoot) {
    if (!(await dependsOn(checkoutRoot, "next"))) return null
    if (await isDir(join(checkoutRoot, "out"))) {
      return { kind: "static", outputDir: "out", reason: "Next.js static export" }
    }
    if (!(await findNextDistDir(checkoutRoot))) return null
    return {
      kind: "server",
      // The checkout's own next, never one the Viewer bundles. `next start`
      // reads `next.config` itself — including a custom `distDir` — so the
      // discovered dist dir does not change this recorded argv.
      start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
      reason: "Next.js with server-rendered routes",
    }
  },
}
