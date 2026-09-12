import { cp, stat } from "node:fs/promises"
import { join } from "node:path"
import { dependsOn, dependsOnAt, findNextDistDir, isDir, isFile, parentAppDir } from "./fs-probe"
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
    // An export is known by what it writes, not by the folder's name: every
    // `output: "export"` build writes `out/_next/` and an `out/index.html`.
    // A bare `out/` left by another tool used to win over a valid server
    // build and get the deployment published as static (codex round 16).
    // Both, not either: a committed `out/index.html` left over from an old
    // export beside a fresh server build is a server build (codex round 19).
    const exportComplete =
      (await isDir(join(checkoutRoot, "out", "_next"))) && (await isFile(join(checkoutRoot, "out", "index.html")))

    const distDir = await findNextDistDir(checkoutRoot)
    if (!distDir) {
      if (!(await dependsOn(checkoutRoot, "next"))) return null
      return exportComplete ? { kind: "static", outputDir: "out", reason: "Next.js static export" } : null
    }

    // Codex round 29, item 1. `dependsOn` used to read only the workspace
    // root's `package.json`. In an npm or pnpm workspace `next` is declared
    // in the app package's own `package.json` (`apps/web/package.json`),
    // not the root's, so a checkout where the root lists nothing used to
    // fall through to the static default and fail on a missing
    // `index.html`. The app directory is the parent of the found dist dir;
    // either package.json listing `next` is enough.
    const appDir = parentAppDir(distDir)
    const rootHasNext = await dependsOn(checkoutRoot, "next")
    const appHasNext = appDir !== null && (await dependsOnAt(join(checkoutRoot, appDir), "next"))
    if (!rootHasNext && !appHasNext) return null

    // Both builds are on disk, so the question is which one the last build
    // wrote (codex round 20, item 4). A complete `out/` used to win outright,
    // which published a project that had exported once and then switched to
    // server-rendered routes as that old export for ever: every rebuild wrote
    // a fresh dist dir the stale `out/` kept outranking. The newer of the two
    // marker files is the build that just happened. A TIE keeps the old
    // answer, static: an export that leaves its dist dir behind as scratch
    // writes both at about the same moment, and that is the case the
    // preference was written for.
    if (exportComplete) {
      const exportedAt = await modifiedAt(join(checkoutRoot, "out", "index.html"))
      const builtAt = await modifiedAt(join(checkoutRoot, distDir, "BUILD_ID"))
      if (exportedAt === null || builtAt === null || exportedAt >= builtAt) {
        return { kind: "static", outputDir: "out", reason: "Next.js static export" }
      }
    }

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

    // Codex round 15, Fix 3. `next` is a dependency (checked above), but a
    // dependency in `package.json` does not prove the binary actually got
    // installed into THIS checkout's `node_modules/.bin` — recording the
    // `start` command without checking it exists marked such a checkout
    // `deployed` and then ENOENT'd on every cold start.
    if (!(await isFile(join(checkoutRoot, "node_modules", ".bin", "next")))) {
      return { kind: "unsupported", reason: "This Next.js build needs the next package installed to run." }
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
 * When a file was last written, in milliseconds, or `null` when it cannot be
 * read. `null` is not "long ago": a marker that cannot be stat'd leaves the
 * comparison undecided, and the caller keeps the answer it had before.
 */
async function modifiedAt(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
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
