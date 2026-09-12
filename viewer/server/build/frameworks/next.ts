import { cp, readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { dependsOn, dependsOnAt, findNextDistDir, findNextExportDir, isDir, isFile, parentAppDir } from "./fs-probe"
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
    // Wherever the export landed: the root's `out`, or a workspace app's
    // `apps/web/out` (codex round 30).
    const exportDir = await findNextExportDir(checkoutRoot)

    const distDir = await findNextDistDir(checkoutRoot)
    if (!distDir) {
      if (exportDir === null) return null
      const exportApp = parentAppDir(exportDir)
      const listed =
        (await dependsOn(checkoutRoot, "next")) ||
        (exportApp !== null && (await dependsOnAt(join(checkoutRoot, exportApp), "next")))
      return listed ? { kind: "static", outputDir: exportDir, reason: "Next.js static export" } : null
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

    // Codex round 29, items 2 & 3. `appDir` is nested for two different
    // reasons, and only one of them is a workspace: a custom `distDir`
    // configured at the checkout root (`distDir: "build/next"`) is still a
    // ROOT build — plain `next start` already finds it correctly, because
    // its `next.config` is the root's own. A dist dir that belongs to a
    // DIFFERENT package is told apart by that package's own `package.json`
    // declaring `next` — the same signal the gate above already reads.
    // Only THAT case routes the start command at the app directory.
    const nestedAppDir = appHasNext ? appDir : null

    // Both builds are on disk, so the question is which one the last build
    // wrote (codex round 20, item 4). A complete `out/` used to win outright,
    // which published a project that had exported once and then switched to
    // server-rendered routes as that old export for ever: every rebuild wrote
    // a fresh dist dir the stale `out/` kept outranking. The newer of the two
    // marker files is the build that just happened. A TIE keeps the old
    // answer, static: an export that leaves its dist dir behind as scratch
    // writes both at about the same moment, and that is the case the
    // preference was written for.
    if (exportDir !== null) {
      const exportedAt = await modifiedAt(join(checkoutRoot, exportDir, "index.html"))
      const builtAt = await modifiedAt(join(checkoutRoot, distDir, "BUILD_ID"))
      if (exportedAt === null || builtAt === null || exportedAt >= builtAt) {
        return { kind: "static", outputDir: exportDir, reason: "Next.js static export" }
      }
    }

    // Codex round 29, item 3. With `output: "standalone"` AND
    // `outputFileTracingRoot` set to the monorepo root, Next nests the
    // launcher one level deeper: `<distDir>/standalone/<relativeAppDir>/server.js`,
    // where `relativeAppDir` is the app's own directory relative to the
    // tracing root. `required-server-files.json` (present — `findNextDistDir`
    // requires it) carries that field; absent or empty means the app IS the
    // tracing root, and the launcher sits directly under `standalone/` with
    // no extra nesting — the plain case this replaces.
    const relativeAppDir = await readRelativeAppDir(checkoutRoot, distDir)
    const standaloneDirRel = relativeAppDir ? join(distDir, "standalone", relativeAppDir) : join(distDir, "standalone")
    const standaloneServerRel = join(standaloneDirRel, "server.js")
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
        prepare: (root) => copyStandaloneStaticAssets(root, distDir, relativeAppDir, nestedAppDir),
      }
    }

    // Codex round 29, item 2. `next start` with no directory argument reads
    // the ROOT `next.config` and `.next` — started that way against a
    // workspace app's dist dir it reads the wrong app's config, or none at
    // all. The app directory is passed as the command's positional
    // argument, and the binary preferred is the app's own
    // `node_modules/.bin/next` when the workspace installed one there,
    // falling back to the root's.
    //
    // Codex round 15, Fix 3. `next` is a dependency (checked above), but a
    // dependency in `package.json` does not prove the binary actually got
    // installed into THIS checkout's `node_modules/.bin` — recording the
    // `start` command without checking it exists marked such a checkout
    // `deployed` and then ENOENT'd on every cold start.
    const appNextBinaryRel = nestedAppDir !== null ? join(nestedAppDir, "node_modules", ".bin", "next") : null
    const nextBinaryRel =
      appNextBinaryRel !== null && (await isFile(join(checkoutRoot, appNextBinaryRel)))
        ? appNextBinaryRel
        : (await isFile(join(checkoutRoot, "node_modules", ".bin", "next")))
          ? "node_modules/.bin/next"
          : null
    if (nextBinaryRel === null) {
      return { kind: "unsupported", reason: "This Next.js build needs the next package installed to run." }
    }
    return {
      kind: "server",
      // The checkout's own next, never one the Viewer bundles. `next start`
      // reads `next.config` itself — including a custom `distDir` — so the
      // discovered dist dir does not change this recorded argv beyond the
      // app directory appended below.
      start:
        nestedAppDir !== null
          ? [nextBinaryRel, "start", "-p", "$PORT", "-H", "127.0.0.1", nestedAppDir]
          : [nextBinaryRel, "start", "-p", "$PORT", "-H", "127.0.0.1"],
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
 * `required-server-files.json`'s `relativeAppDir`: the app's own directory
 * relative to Next's `outputFileTracingRoot` (the monorepo root, when the
 * project sets one). Absent, empty, or unreadable all mean the same thing —
 * the app IS the tracing root, and the standalone launcher sits directly
 * under `<distDir>/standalone/` with no extra nesting.
 */
async function readRelativeAppDir(checkoutRoot: string, distDir: string): Promise<string> {
  try {
    const raw = JSON.parse(
      await readFile(join(checkoutRoot, distDir, "required-server-files.json"), "utf8"),
    ) as { relativeAppDir?: string }
    return raw.relativeAppDir ?? ""
  } catch {
    return ""
  }
}

/**
 * Next's standalone output does not include `<distDir>/static` or the app's
 * own `public/` — the framework's own docs say to copy both into the
 * standalone dir, or the server starts but every asset 404s. Copies build
 * output into build output, inside the checkout; never touches source.
 *
 * With a tracing-root `relativeAppDir` (codex round 29, item 3), both land
 * one level deeper, under the app's own directory inside `standalone/`:
 * `<distDir>/standalone/<relativeAppDir>/<distDir's own name>/static` and
 * `<distDir>/standalone/<relativeAppDir>/public`. `appDir` (the app
 * directory from item 1, or `null` at the checkout root) is where the
 * `public/` source is read from — the plain case still reads the
 * checkout's own root `public/`.
 *
 * Skips whichever source is absent rather than throwing — a prototype with
 * no `public/` directory at all is ordinary, not an error.
 */
async function copyStandaloneStaticAssets(
  checkoutRoot: string,
  distDir: string,
  relativeAppDir: string,
  appDir: string | null,
): Promise<void> {
  // The standalone server keeps the FULL app-relative dist dir (`build/next`
  // for `distDir: "build/next"`), so the static copy has to land under that
  // same path; the dist dir's last segment alone put it at `next/static`
  // and every `/_next/static` request answered 404 (codex round 30).
  const distDirWithinApp = appDir !== null ? relative(appDir, distDir) : distDir
  const standaloneAppDir = relativeAppDir
    ? join(checkoutRoot, distDir, "standalone", relativeAppDir)
    : join(checkoutRoot, distDir, "standalone")

  const staticSrc = join(checkoutRoot, distDir, "static")
  if (await isDir(staticSrc)) {
    await cp(staticSrc, join(standaloneAppDir, distDirWithinApp, "static"), { recursive: true })
  }

  const publicSrc = appDir !== null ? join(checkoutRoot, appDir, "public") : join(checkoutRoot, "public")
  if (await isDir(publicSrc)) {
    await cp(publicSrc, join(standaloneAppDir, "public"), { recursive: true })
  }
}
