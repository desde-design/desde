import { cp } from "node:fs/promises"
import { join } from "node:path"
import { dependsOn, findNextDistDir, isDir, isFile } from "./fs-probe"
import type { FrameworkAdapter } from "./types"

/**
 * Next writes `out/` only for `output: "export"`; a server build writes
 * `BUILD_ID` and `required-server-files.json` together in its dist dir
 * (`.next` by default, or a custom `distDir` — see `findNextDistDir`, codex
 * round 4, Fix 4). `out/` wins when both exist: an export leaves its dist
 * dir behind as scratch.
 *
 * `output: "standalone"` writes the SAME two files, PLUS a self-contained
 * `<distDir>/standalone/server.js` that `next start` refuses to run against
 * — standalone mode has its own entry point. Detected FIRST, ahead of the
 * generic `next start` case below, because a standalone build recorded as
 * `next start` fails to boot (codex round 4, Fix 3).
 */
export const NEXT_ADAPTER: FrameworkAdapter = {
  id: "next",
  async inspectBuild(checkoutRoot) {
    if (!(await dependsOn(checkoutRoot, "next"))) return null
    if (await isDir(join(checkoutRoot, "out"))) {
      return { kind: "static", outputDir: "out", reason: "Next.js static export" }
    }

    const distDir = await findNextDistDir(checkoutRoot)
    if (!distDir) return null

    const standaloneServerRel = join(distDir, "standalone", "server.js")
    if (await isFile(join(checkoutRoot, standaloneServerRel))) {
      return {
        kind: "server",
        // A bare `node`, not an absolute path: the checkout has no `node`
        // of its own to invoke, and `prototype-processes.ts` resolves this
        // specific first-argv-entry value to `process.execPath` AT SPAWN
        // TIME — see its own note on `substitutePort`. Recording an
        // absolute path here instead would go stale the moment the Viewer's
        // own image ships a new Node in a different location, for every
        // deployment built before that upgrade.
        start: ["node", standaloneServerRel],
        reason: "Next.js standalone output",
        prepare: (root) => copyStandaloneStaticAssets(root, distDir),
      }
    }

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

/**
 * Next's standalone output does not include `<distDir>/static` or the root
 * `public/` — the framework's own docs say to copy both into the standalone
 * dir, or the server starts but every asset 404s. Copies build output into
 * build output, inside the checkout; never touches source.
 *
 * Skips whichever source is absent rather than throwing — a prototype with
 * no `public/` directory at all is ordinary, not an error.
 */
async function copyStandaloneStaticAssets(checkoutRoot: string, distDir: string): Promise<void> {
  const standaloneDir = join(checkoutRoot, distDir, "standalone")

  const staticSrc = join(checkoutRoot, distDir, "static")
  if (await isDir(staticSrc)) {
    await cp(staticSrc, join(standaloneDir, distDir, "static"), { recursive: true })
  }

  const publicSrc = join(checkoutRoot, "public")
  if (await isDir(publicSrc)) {
    await cp(publicSrc, join(standaloneDir, "public"), { recursive: true })
  }
}
