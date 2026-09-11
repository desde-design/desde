import { join } from "node:path"
import { dependsOn, isDir, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Next writes `out/` only for `output: "export"`, and `.next/BUILD_ID` for
 * every completed build. `out/` wins when both exist: an export leaves
 * `.next` behind as scratch.
 */
export const NEXT_ADAPTER: FrameworkAdapter = {
  id: "next",
  async inspectBuild(checkoutRoot) {
    if (!(await dependsOn(checkoutRoot, "next"))) return null
    if (await isDir(join(checkoutRoot, "out"))) {
      return { kind: "static", outputDir: "out", reason: "Next.js static export" }
    }
    if (await isFile(join(checkoutRoot, ".next", "BUILD_ID"))) {
      return {
        kind: "server",
        // The checkout's own next, never one the Viewer bundles.
        start: ["node_modules/.bin/next", "start", "-p", "$PORT", "-H", "127.0.0.1"],
        reason: "Next.js with server-rendered routes",
      }
    }
    return null
  },
}
