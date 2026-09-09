/**
 * Editor's Next build directory is its own, not the project's `.next`.
 *
 * **Why.** Next 16 holds a per-project lock at `<distDir>/lock` and exits a
 * second `next dev` for the same directory whatever port it asked for — the
 * port is not the conflict, the directory is. A designer who runs their
 * prototype in a terminal and then opens it in Editor is the ordinary case,
 * and it was a refusal: "Another next dev server is already running", naming
 * their own terminal. Turning the lock off would be worse, because both
 * servers would then write the same Turbopack cache and build manifests.
 *
 * So Editor's in-process Next builds into `.desde/next` (dev output at
 * `.desde/next/dev`, mirroring Next's own `<root>/dev` split), which gives it
 * its own lock and its own cache. `.desde/` is already kept out of the user's
 * `git status` by the branch-mode boot. Both servers watch the same source.
 *
 * **The second half, which is the dangerous one.** Next's dev bundler also
 * runs its TypeScript setup, and that setup WRITES into the project from
 * `distDir`: `tsconfig.json` gains `<distDir>/types/**\/*.ts` in `include`, and
 * `next-env.d.ts` imports `./<distDir>/types/routes.d.ts`. Left alone, Editor's
 * boot would rewrite both tracked files to point at `.desde/next`, the user's
 * own `next dev` would rewrite them back, and Editor's Commit stages whichever
 * version happened to be on disk. That is a source modification the user never
 * made. So the setup is REDIRECTED: the module Next's bundler calls is swapped
 * in Node's require cache for a wrapper that hands it the ORIGINAL `distDir`,
 * and the two files come out byte-identical to what the user's own tool
 * writes. Editor's build directory then simply never appears in the repo.
 *
 * **The third half, which the second creates.** `next-env.d.ts` keeps importing
 * `./.next/dev/types/routes.d.ts`, but the bundler writes that file (and
 * `root-params.d.ts`, `validator.ts`, …) under ITS `distDir` — now Editor's.
 * A fresh clone opened in Editor and never run through `next dev` would have
 * an import of a file nothing wrote, and a red `next-env.d.ts` in the IDE. So
 * Editor's generated `types/` directory is MIRRORED into the project's own
 * (`mirrorTypeDeclarations`): every file the bundler writes there is copied
 * to where the user's files point, and kept current through a watcher. That
 * touches no lock and no tracked file; when the user's own server runs too,
 * both write the same generated files and the newer wins.
 *
 * Both seams are private, quarantined here, and both are asserted causally in
 * `probe()` — the same discipline `prime-config.ts` documents for the config
 * memo, for the same reason: every one of these failures is silent from the
 * outside. A `distDir` write that does not land boots a healthy server that
 * collides with the user's exactly as before; a type-setup redirect that does
 * not land boots a healthy server that edits two of the user's files.
 */

import { realpathSync, watch, type Dirent, type FSWatcher } from "node:fs"
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from "node:path"
import { DesdeDirSymlinkError, desdePath } from "../../../../src/editor/worktree/desde-dir.js"
import type { HostFailure, HostSeam } from "../types.js"
import type { NextConfigObject } from "./prime-config.js"

/** Where Editor's Next builds, relative to the project root. */
export const EDITOR_NEXT_DIST_ROOT = join(".desde", "next")

/** The module the dev bundler calls for tsconfig / next-env.d.ts upkeep. */
export const NEXT_TYPE_SETUP_SUBPATH = "dist/lib/verify-typescript-setup"

export const NEXT_DIST_DIR_SEAM: HostSeam = {
  id: "next/dist/server/config memoized distDir",
  stability: "private",
  expression: `conf.distDir = "${join(EDITOR_NEXT_DIST_ROOT, "dev")}"; conf.distDirRoot = "${EDITOR_NEXT_DIST_ROOT}" on the object loadConfig memoized`,
  buys: "a build directory, lock and Turbopack cache of Editor's own, so the project's own `next dev` and Editor's can run at once",
}

export const NEXT_TYPE_SETUP_SEAM: HostSeam = {
  id: `next/${NEXT_TYPE_SETUP_SUBPATH}`,
  stability: "private",
  expression: `require.cache[require.resolve("next/${NEXT_TYPE_SETUP_SUBPATH}")].exports.verifyAndRunTypeScript`,
  buys: "tsconfig.json and next-env.d.ts written exactly as the project's own `next dev` writes them, instead of pointed at Editor's build directory",
}

export interface DistDirs {
  /** What Next resolved for the development phase, e.g. `.next/dev`. */
  distDir: string
  /** What the config said before the phase rewrite, e.g. `.next`. */
  distDirRoot: string
}

export type IsolateDistDirResult =
  | { ok: true; original: DistDirs; isolated: DistDirs }
  | { ok: false; failure: HostFailure }

const REMEDIATION = [
  "Start the project's dev server yourself and re-run with --attach <url>. Attach mode does not use this seam.",
  "Then report the Next.js version: this seam is private and Next may move it in any release.",
]

function shapeFailure(seam: HostSeam, summary: string, cause: string): HostFailure {
  return {
    code: "seam-shape-changed",
    summary,
    seam,
    cause,
    remediation: REMEDIATION,
    attachCovers: true,
  }
}

/**
 * `.desde/next` must be an ordinary directory before Next is pointed at it.
 *
 * Every other `.desde` writer goes through `desdePath`, which `lstat`s each
 * segment and refuses a symbolic link — a repo can ship `.desde` as a link to
 * anywhere, and Next's prepare/cleanup would follow it out of the checkout with
 * every artifact write. The build directory gets the same rule, on EVERY
 * segment down to the dev suffix — `.desde/next` as a real directory with
 * `.desde/next/dev` a link back to `.next/dev` would quietly recreate the very
 * collision this isolation removes. Checked at probe and again at boot.
 */
export function guardBuildRoot(
  prototypeRoot: string,
  /** The WHOLE isolated distDir, e.g. `.desde/next/dev` — `desdePath` guards every segment it is given, and only those. */
  isolatedDistDir: string = EDITOR_NEXT_DIST_ROOT,
): { ok: true } | { ok: false; failure: HostFailure } {
  const segments = isolatedDistDir.split(sep).filter((segment) => segment.length > 0)
  if (segments[0] !== ".desde") {
    throw new Error(`guardBuildRoot: expected a path under .desde, got "${isolatedDistDir}".`)
  }
  try {
    desdePath(prototypeRoot, ...segments.slice(1))
    return { ok: true }
  } catch (err) {
    if (!(err instanceof DesdeDirSymlinkError)) throw err
    return {
      ok: false,
      failure: {
        code: "boot-failed",
        summary: `Editor will not build into ${EDITOR_NEXT_DIST_ROOT} because part of that path is a symbolic link.`,
        cause: err.message,
        remediation: [
          `Replace the link with an ordinary directory (or remove it) and open the project again.`,
          "Or start the project's dev server yourself and re-run with --attach <url>.",
        ],
        attachCovers: true,
      },
    }
  }
}

/**
 * The same rule, applied to what is ALREADY under `.desde/next` — by removing
 * the links, not by refusing over them.
 *
 * `guardBuildRoot` checks the segments it is handed and stops there. Next
 * writes a whole tree below them, and `writeFile` follows a symbolic link: a
 * checkout that ships `.desde/next/dev/types` (or `server`, or `cache`) as a
 * link leaves every artifact write under it outside the checkout, through a
 * path the segment rule never looked at.
 *
 * **Why unlink rather than refuse.** `.desde/next` is Editor's OWN build
 * output and nothing else — regenerated on demand, never a place the user
 * keeps anything. Removing a symbolic link there removes no data: the link
 * goes, the target is untouched, and Next rebuilds whatever it needed. A
 * refusal, by contrast, has a shape that cannot recover on its own: if the
 * link is ever put back by the same thing that made it, every later open is
 * refused, and the remediation ("delete the directory") recreates it.
 *
 * That is not a live case today — Next's only symbolic-link writer is
 * `copyTracedFiles` in `build/utils.js`, reached from `next build` under
 * `output: "standalone"`, and Editor runs the dev server, never a build (both
 * a real `.next/dev` and a real `.desde/next/dev` on the dogfood project carry
 * zero links across 946 files). But the failure mode of guessing wrong is a
 * project that can never be opened again, and the failure mode of unlinking is
 * one regenerated file, so the guard takes the cheaper wrong answer.
 *
 * Node's recursive `readdir` does not descend into a symbolic link, so the
 * walk cannot loop and the link itself is what comes back. What IS refused: a
 * tree that cannot be listed, and a link that cannot be removed — unreadable
 * and undeletable are both different from proven clean, and attach mode covers
 * either.
 */
export async function guardBuildTree(
  prototypeRoot: string,
  /** The whole isolated distDir, e.g. `.desde/next/dev`; the walk covers all of `.desde/next`. */
  isolatedDistDir: string = EDITOR_NEXT_DIST_ROOT,
  log: (line: string) => void = () => undefined,
): Promise<{ ok: true } | { ok: false; failure: HostFailure }> {
  const segmentRule = guardBuildRoot(prototypeRoot, isolatedDistDir)
  if (!segmentRule.ok) return segmentRule
  const treeRoot = join(prototypeRoot, EDITOR_NEXT_DIST_ROOT)
  let entries: Dirent[]
  try {
    entries = await readdir(treeRoot, { recursive: true, withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true }
    return {
      ok: false,
      failure: {
        code: "boot-failed",
        summary: `Editor could not read what is already in ${EDITOR_NEXT_DIST_ROOT}, so it cannot prove nothing in there points outside your project.`,
        cause: (err as Error).message,
        remediation: [
          `Remove ${EDITOR_NEXT_DIST_ROOT} (it is Editor's own build output and is regenerated) and open the project again.`,
          "Or start the project's dev server yourself and re-run with --attach <url>.",
        ],
        attachCovers: true,
      },
    }
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    // `parentPath` is the Node >= 20.12 name; `path` the one before it.
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      treeRoot
    const full = join(parent, entry.name)
    const found = relative(prototypeRoot, full)
    try {
      // Unlink, never `recursive`: this removes the link and nothing it points at.
      await rm(full, { force: false })
    } catch (err) {
      return {
        ok: false,
        failure: {
          code: "boot-failed",
          summary: `Editor will not build into ${EDITOR_NEXT_DIST_ROOT} because something inside it is a symbolic link it could not remove.`,
          cause: `${found} is a symbolic link, and Next's build writes below it would follow it out of your project. Removing it failed: ${(err as Error).message}`,
          remediation: [
            `Remove ${found} yourself, or remove ${EDITOR_NEXT_DIST_ROOT} entirely — it is Editor's own build output and is regenerated.`,
            "Or start the project's dev server yourself and re-run with --attach <url>.",
          ],
          attachCovers: true,
        },
      }
    }
    log(
      `[host:next] Removed ${found}: it is a symbolic link inside Editor's own build directory, and Next's writes would have followed it out of your project. Nothing it pointed at was touched.`,
    )
  }
  return { ok: true }
}

/**
 * Point the memoized config at Editor's own build directory, in place.
 *
 * Mirrors the shape Next resolved rather than assuming it: the development
 * phase rewrites `distDir` to `<distDirRoot>/dev` (`config.js`, "Store the
 * distDirRoot in the config before it is modified for development mode"), and
 * that `dev` suffix is carried over verbatim so a Next that changes the suffix
 * still gets a consistent pair. Both fields are written because both are read:
 * `distDir` by the bundler and the lock, `distDirRoot` by Turbopack for its
 * persistent cache location. Leaving the root alone would isolate the lock and
 * still share the cache.
 *
 * Reads back after writing. A frozen config or an accessor that normalises
 * preserves identity and swallows the write — the shape
 * `NEXT_CONFIG_MUTABILITY_SEAM` measured for `turbopack`.
 */
export function isolateDistDir(conf: NextConfigObject, prototypeRoot: string): IsolateDistDirResult {
  const { distDir, distDirRoot } = conf
  if (typeof distDir !== "string" || typeof distDirRoot !== "string") {
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_DIST_DIR_SEAM,
        "Editor could not read where your project's Next build directory is, so it cannot give itself a separate one.",
        `Expected string distDir and distDirRoot on the resolved config; found distDir: ${typeof distDir}, distDirRoot: ${typeof distDirRoot}.`,
      ),
    }
  }
  const suffix = relative(distDirRoot, distDir)
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_DIST_DIR_SEAM,
        "Editor could not read where your project's Next build directory is, so it cannot give itself a separate one.",
        `distDir "${distDir}" is not inside distDirRoot "${distDirRoot}"; Editor mirrors that relationship and cannot when it does not hold.`,
      ),
    }
  }
  // A project that already builds inside `.desde/next` would get an "isolated"
  // pair identical to its own, and the log line would announce a separation
  // that did not happen: same lock, same Turbopack cache, same refusal as
  // before. Overlap the other way (`distDir: ".desde"`) is refused too, because
  // then the project's own Next owns the directory Editor is writing into.
  // Neither is a seam moving, so neither is reported as one.
  const overlapping = [distDirRoot, distDir].find((dir) => overlaps(prototypeRoot, dir, EDITOR_NEXT_DIST_ROOT))
  if (overlapping !== undefined) {
    return {
      ok: false,
      failure: {
        code: "boot-failed",
        summary: `Your project's Next build directory is inside ${EDITOR_NEXT_DIST_ROOT}, which is where Editor builds, so Editor cannot give itself a separate one.`,
        cause: `distDir resolved to "${overlapping}", which overlaps Editor's own build directory ${EDITOR_NEXT_DIST_ROOT}. Both dev servers would share one lock and one Turbopack cache.`,
        remediation: [
          `Set \`distDir\` in your Next config to a directory outside \`.desde/\` (the default is \`.next\`) and open the project again.`,
          "Or start the project's dev server yourself and re-run with --attach <url>.",
        ],
        attachCovers: true,
      },
    }
  }
  const isolated: DistDirs = {
    distDirRoot: EDITOR_NEXT_DIST_ROOT,
    distDir: suffix === "" ? EDITOR_NEXT_DIST_ROOT : join(EDITOR_NEXT_DIST_ROOT, suffix),
  }
  const original: DistDirs = { distDir, distDirRoot }
  const written = writeDistDirs(conf, isolated)
  if (!written.ok) return written
  return { ok: true, original, isolated }
}

/**
 * Same directory, or one inside the other — either way the two trees are not
 * separate. Compared as the FILESYSTEM sees them, not as strings: `build` may
 * be a symlink to `.desde/next`, and on macOS or Windows `.DESDE/next` is the
 * same directory as `.desde/next`. Each side is resolved through `realpath`
 * where it exists (the project root always does, so a root reached through a
 * symlink cannot split the comparison), and case-folded on case-insensitive
 * platforms.
 */
function overlaps(prototypeRoot: string, a: string, b: string): boolean {
  const base = realpathOr(resolve(prototypeRoot))
  const left = comparable(realpathOr(resolve(base, a)))
  const right = comparable(realpathOr(resolve(base, b)))
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep)
}

/**
 * `realpath` of the longest EXISTING ancestor, with the rest appended. A path
 * whose last components do not exist yet still resolves through every symlink
 * above them: `build -> .desde` with `distDirRoot: "build/next"` and no
 * `.desde/next` on disk yet must still compare equal to `.desde/next`.
 */
function realpathOr(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32"

function comparable(path: string): string {
  return CASE_INSENSITIVE_FS ? path.toLowerCase() : path
}

/** Put the original pair back — `probe()` must leave the memo untouched. */
export function restoreDistDir(conf: NextConfigObject, original: DistDirs): IsolateDistDirResult {
  const written = writeDistDirs(conf, original)
  if (!written.ok) return written
  return { ok: true, original, isolated: original }
}

function writeDistDirs(conf: NextConfigObject, dirs: DistDirs): { ok: true } | { ok: false; failure: HostFailure } {
  // Two fields, one write: if the second assignment throws or is swallowed,
  // the first must not stay behind — a config carrying Editor's distDir with
  // the project's root is worse than either whole.
  const before = { distDir: conf.distDir, distDirRoot: conf.distDirRoot }
  const rollBack = () => {
    try {
      conf.distDir = before.distDir
      conf.distDirRoot = before.distDirRoot
    } catch {
      // Best effort: the failure being reported already names the object as unwritable.
    }
  }
  try {
    conf.distDir = dirs.distDir
    conf.distDirRoot = dirs.distDirRoot
  } catch (err) {
    rollBack()
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_DIST_DIR_SEAM,
        "Your project's resolved Next config refused the build-directory write Editor needs to keep its dev server separate from yours.",
        (err as Error).message,
      ),
    }
  }
  if (conf.distDir !== dirs.distDir || conf.distDirRoot !== dirs.distDirRoot) {
    rollBack()
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_DIST_DIR_SEAM,
        "Your project's resolved Next config swallowed the build-directory write Editor needs to keep its dev server separate from yours.",
        `Wrote distDir "${dirs.distDir}" and distDirRoot "${dirs.distDirRoot}"; read back distDir "${String(conf.distDir)}" and distDirRoot "${String(conf.distDirRoot)}".`,
      ),
    }
  }
  return { ok: true }
}

/** Just the members we touch on the module the bundler calls. */
interface TypeSetupModule {
  verifyAndRunTypeScript?: unknown
  verifyAndRunTypeScriptInWorker?: unknown
  [key: string]: unknown
}

type TypeSetupFn = (opts: { distDir: string; [key: string]: unknown }) => unknown

export type TypeSetupRedirectResult = { ok: true; modulePath: string } | { ok: false; failure: HostFailure }

/**
 * Resolve the type-setup module INSIDE the installation `boot()` binds, and
 * hand back its cached module record. The same anchoring `resolveNextInstall`
 * documents: an absolute path under the package root, then containment on
 * what Node returned.
 */
function locateTypeSetup(
  require: NodeJS.Require,
  install: { root: string },
): { ok: true; modulePath: string; exports: TypeSetupModule } | { ok: false; failure: HostFailure } {
  const anchored = join(install.root, NEXT_TYPE_SETUP_SUBPATH)
  let modulePath: string
  let exports: TypeSetupModule
  try {
    modulePath = require.resolve(anchored)
    exports = require(modulePath) as TypeSetupModule
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "seam-missing",
        summary:
          "Editor could not load Next's TypeScript setup module, which it redirects so your tsconfig.json and next-env.d.ts are not rewritten to point at Editor's build directory.",
        seam: NEXT_TYPE_SETUP_SEAM,
        cause: (err as Error).message,
        remediation: REMEDIATION,
        attachCovers: true,
      },
    }
  }
  if (!modulePath.startsWith(install.root + sep)) {
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_TYPE_SETUP_SEAM,
        "Next's TypeScript setup module resolved outside the installation Editor is about to boot.",
        `${anchored} resolved to ${modulePath}, which is not under ${install.root}.`,
      ),
    }
  }
  if (typeof exports.verifyAndRunTypeScript !== "function") {
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_TYPE_SETUP_SEAM,
        "Next's TypeScript setup module no longer exports the function Editor redirects.",
        `${modulePath} exports verifyAndRunTypeScript as ${typeof exports.verifyAndRunTypeScript}, not a function.`,
      ),
    }
  }
  return { ok: true, modulePath, exports }
}

/**
 * Swap the cached exports for a wrapper that substitutes `distDir`.
 *
 * Node's `require` returns `Module._cache[filename].exports` fresh on every
 * call, so replacing `.exports` on the cached record is seen by the bundler's
 * own later `require("../../../lib/verify-typescript-setup")` — the relative
 * specifier resolves to this same absolute file. The original object's members
 * are SWC getters, so they are copied by value onto a plain object rather than
 * redefined (the getters are non-configurable).
 *
 * The wrapper is verified by identity: `require(modulePath)` must hand back the
 * object just installed. A Node that stopped serving from the cache record, or
 * a Next that loaded the module through another path, fails HERE rather than
 * by rewriting two of the user's files.
 */
export function redirectTypeSetup(
  require: NodeJS.Require,
  install: { root: string },
  originalDistDir: string,
): TypeSetupRedirectResult {
  const located = locateTypeSetup(require, install)
  if (!located.ok) return located
  const wrapper = buildWrapper(located.exports, originalDistDir)
  return installWrapper(require, located.modulePath, wrapper, located.exports)
}

/**
 * The probe-time causal assertion: perform the swap, prove it is what
 * `require` serves, and put the original back. `probe()` must leave the
 * process as it found it — a redirect left behind by a refused probe would
 * hand attach mode a wrapper it never asked for.
 */
export function probeTypeSetupRedirect(
  require: NodeJS.Require,
  install: { root: string },
): TypeSetupRedirectResult {
  const located = locateTypeSetup(require, install)
  if (!located.ok) return located
  const wrapper = buildWrapper(located.exports, "<probe>")
  const installed = installWrapper(require, located.modulePath, wrapper, located.exports)
  if (!installed.ok) return installed
  return installWrapper(require, located.modulePath, located.exports)
}

function buildWrapper(original: TypeSetupModule, originalDistDir: string): TypeSetupModule {
  const wrapper: TypeSetupModule = { ...original }
  Object.defineProperty(wrapper, "__esModule", { value: true })
  const substitute = (fn: TypeSetupFn): TypeSetupFn => {
    return (opts) => fn({ ...opts, distDir: originalDistDir })
  }
  wrapper.verifyAndRunTypeScript = substitute(original.verifyAndRunTypeScript as TypeSetupFn)
  if (typeof original.verifyAndRunTypeScriptInWorker === "function") {
    wrapper.verifyAndRunTypeScriptInWorker = substitute(
      original.verifyAndRunTypeScriptInWorker as TypeSetupFn,
    )
  }
  return wrapper
}

function installWrapper(
  require: NodeJS.Require,
  modulePath: string,
  exports: TypeSetupModule,
  /** Put back on a failed identity check, so a refusal leaves no wrapper behind. */
  restoreTo?: TypeSetupModule,
): TypeSetupRedirectResult {
  const record = require.cache[modulePath]
  if (record === undefined) {
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_TYPE_SETUP_SEAM,
        "Node's require cache holds no record for Next's TypeScript setup module, so Editor cannot redirect it.",
        `require.cache["${modulePath}"] is undefined after the module loaded.`,
      ),
    }
  }
  record.exports = exports
  if (require(modulePath) !== exports) {
    if (restoreTo !== undefined) record.exports = restoreTo
    return {
      ok: false,
      failure: shapeFailure(
        NEXT_TYPE_SETUP_SEAM,
        "Editor's redirect of Next's TypeScript setup module did not take: require() still serves the original.",
        `Replaced require.cache["${modulePath}"].exports, but require("${modulePath}") returned a different object.`,
      ),
    }
  }
  return { ok: true, modulePath }
}

/** Just the shape of `fs.watch` the mirror uses. */
export type WatchFn = (
  dir: string,
  options: { recursive: true },
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher

export interface TypeDeclarationMirror {
  /** Stop watching. Files already mirrored stay. */
  stop(): void
}

/**
 * `lstat` each segment of `rel` under `root`; false if any existing one is a
 * symbolic link. A missing segment is fine (nothing below it can be a link).
 * The same rule `desde-dir.ts` applies to `.desde`, here for BOTH sides of the
 * mirror: the project's `.next` may be a link to a ramdisk (or anywhere), and a
 * write or a prune that follows it leaves the checkout.
 */
async function segmentsAreReal(root: string, rel: string): Promise<boolean> {
  let current = root
  for (const segment of rel.split(sep).filter((part) => part.length > 0)) {
    current = join(current, segment)
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(current)
    } catch {
      return true
    }
    if (st.isSymbolicLink()) return false
  }
  return true
}

/**
 * Keep the project's own `<distDir>/types/` current with what Editor's Next
 * generates under `.desde/next/dev/types/`.
 *
 * Best-effort by design: this is developer experience (the user's IDE resolving
 * `next-env.d.ts`), not the edit path, so a failure logs once and the session
 * goes on. Deletions ARE mirrored — a stale `validator.ts` naming a route that
 * no longer exists is a type error the user did not cause — but only ever of
 * REGULAR FILES reached through real directories, and only when the source
 * tree could actually be listed: a mirror that cannot see its source must not
 * conclude the destination is all stale.
 *
 * `fs.watch` with `recursive` is what both macOS and Linux (Node ≥ 20) offer.
 * The watcher attaches BEFORE the first full sync, and every sync runs through
 * one serial queue, so a regeneration that lands between the two is not lost.
 * A source that vanished (a route directory removed) triggers a full
 * reconciliation rather than a single unlink, since what disappeared may be a
 * whole subtree. Copies compare before writing so the user's own dev server,
 * watching the same directory, is not woken by byte-identical rewrites.
 */
export async function mirrorTypeDeclarations(opts: {
  prototypeRoot: string
  /** Editor's distDir, relative to the project root. */
  from: string
  /** The project's own distDir, relative to the project root. */
  to: string
  log?: (line: string) => void
  /**
   * The watcher, injected only by tests. Which events a recursive watcher
   * emits is the platform's business — macOS reports children of a directory
   * renamed into place, Linux need not — so the shapes this must survive are
   * driven directly rather than provoked. Defaults to `node:fs.watch`.
   */
  watch?: WatchFn
  /** How often to full-sync once the watcher has died (tests shorten it). */
  pollIntervalMs?: number
}): Promise<TypeDeclarationMirror> {
  // `resolve`, not `join`: a config may carry an absolute `distDir`, and
  // joining would prefix it with the project root a second time.
  const fromDir = resolve(opts.prototypeRoot, opts.from, "types")
  const toDir = resolve(opts.prototypeRoot, opts.to, "types")
  const fromRel = relative(opts.prototypeRoot, fromDir)
  const toRel = relative(opts.prototypeRoot, toDir)
  const log = opts.log ?? (() => undefined)
  let stopped = false
  let watcher: FSWatcher | null = null
  let poll: NodeJS.Timeout | null = null
  const inert: TypeDeclarationMirror = { stop: () => undefined }

  // Both ends must sit INSIDE the project: a config may legitimately say
  // `distDir: "../shared-build"`, and a mirror that followed it would copy and
  // prune in a directory this checkout does not own. Then both must be real
  // directories all the way down, or the mirror stays off. Checked once here
  // for the fixed part of the path, and again per file for the part Next
  // creates underneath.
  const rootPrefix = resolve(opts.prototypeRoot) + sep
  if (!resolve(fromDir).startsWith(rootPrefix) || !resolve(toDir).startsWith(rootPrefix)) {
    log(`[host:next] Not mirroring generated types into ${toRel}: it resolves outside the project.`)
    return inert
  }
  if (!(await segmentsAreReal(opts.prototypeRoot, fromRel)) || !(await segmentsAreReal(opts.prototypeRoot, toRel))) {
    log(
      `[host:next] Not mirroring generated types into ${toRel}: a segment of ${fromRel} or ${toRel} is a symbolic link.`,
    )
    return inert
  }

  /** Files only, relative to `dir`; null when the tree could not be listed. */
  const listFiles = async (dir: string): Promise<string[] | null> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      return null
    }
    const files: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      // `parentPath` is the Node ≥ 20.12 name; `path` the one before it.
      const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? dir
      files.push(relative(dir, join(parent, entry.name)))
    }
    return files
  }

  /**
   * Copy one file. "missing" when the source is gone and "directory" when it
   * is a directory — both mean the caller must reconcile rather than copy,
   * because what changed is a subtree, not a file.
   */
  const copyOne = async (rel: string): Promise<"copied" | "missing" | "directory" | "skipped"> => {
    const source = join(fromDir, rel)
    const target = join(toDir, rel)
    let content: Buffer
    try {
      content = await readFile(source)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return "missing"
      // A recursive watcher may report only the directory when a populated
      // subtree appears at once (a rename into place), with no separate event
      // for the children already in it. Reconcile, or those declarations stay
      // absent until something else happens to touch them.
      if (code === "EISDIR") return "directory"
      // A transient read: nothing to copy this round.
      return "skipped"
    }
    // Generated declarations import the project's own files by a path
    // RELATIVE TO THEMSELVES (`validator.ts`: `typeof import("../../../../src/app/page.js")`
    // from `.desde/next/dev/types`). Copied a level shallower unchanged, every
    // one of those would resolve outside the project. Rebase them.
    if (/\.(?:d\.ts|ts|tsx|js|mjs)$/.test(rel)) {
      content = Buffer.from(rebaseRelativeSpecifiers(content.toString("utf8"), source, target, fromDir))
    }
    if (!(await segmentsAreReal(toDir, rel))) return "skipped"
    let existing: Buffer | null = null
    try {
      existing = await readFile(target)
    } catch {
      existing = null
    }
    if (existing !== null && existing.equals(content)) return "copied"
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    return "copied"
  }

  /** Remove one destination-only file — a regular file, through real directories, or nothing. */
  const pruneOne = async (rel: string): Promise<void> => {
    if (!(await segmentsAreReal(toDir, rel))) return
    const target = join(toDir, rel)
    let st: Awaited<ReturnType<typeof lstat>>
    try {
      st = await lstat(target)
    } catch {
      return
    }
    if (!st.isFile()) return
    await rm(target, { force: false })
  }

  // Copy everything Editor's Next generated, then reconcile: a declaration
  // present only on the project's side belongs to a route that no longer
  // exists, and would keep type-checking as if it did. One retry when a
  // source vanished mid-walk, so the reconciliation sees the settled tree.
  const syncAll = async (retry = true): Promise<void> => {
    const sources = await listFiles(fromDir)
    if (sources === null) return
    let vanished = false
    for (const rel of sources) {
      if ((await copyOne(rel)) === "missing") vanished = true
    }
    if (vanished) {
      if (retry) await syncAll(false)
      return
    }
    const wanted = new Set(sources)
    const present = await listFiles(toDir)
    if (present === null) return
    for (const rel of present) {
      if (!wanted.has(rel)) await pruneOne(rel)
    }
  }

  // A serial queue: events arrive faster than copies finish, and two copies of
  // one file racing would be a torn mirror.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((err: unknown) => {
      log(`[host:next] could not mirror generated types into ${opts.to}: ${(err as Error).message}`)
    })
    return queue
  }

  // Full syncs coalesce. Generating a route tree creates many directories, and
  // one full walk per directory event would be N walks of the same tree for
  // one burst; at most one is ever pending, and it runs after the burst.
  let fullSyncPending = false
  const queueFullSync = (): void => {
    if (fullSyncPending) return
    fullSyncPending = true
    void enqueue(async () => {
      fullSyncPending = false
      await syncAll()
    })
  }

  // Editor's Next owns `fromDir`; creating it empty is harmless and lets the
  // watcher attach before the first route type is written.
  try {
    await mkdir(fromDir, { recursive: true })
  } catch (err) {
    log(`[host:next] could not mirror generated types into ${opts.to}: ${(err as Error).message}`)
    return inert
  }
  // Continuous watching is the nice-to-have; the initial copy is the part
  // `next-env.d.ts` depends on. A watcher that cannot be established (inotify
  // exhausted, a filesystem without recursive watch) logs, and the one-time
  // sync below still runs.
  try {
    const watchFn: WatchFn = opts.watch ?? watch
    watcher = watchFn(fromDir, { recursive: true }, (_event, filename) => {
      if (stopped) return
      if (filename === null) {
        queueFullSync()
        return
      }
      void enqueue(async () => {
        const outcome = await copyOne(filename.toString())
        if (outcome === "missing" || outcome === "directory") queueFullSync()
      })
    })
    watcher.on("error", (err) => {
      // Node can hand back a watcher and only THEN report that the
      // descriptor or inotify budget is gone (EMFILE / ENOSPC). A watcher
      // that has said so is dead; from here the mirror polls with full syncs
      // instead, so route changes keep reaching `next-env.d.ts`'s directory.
      watcher?.close()
      watcher = null
      startPolling()
      log(`[host:next] watching generated types failed (${err.message}); mirroring ${opts.to} by polling instead.`)
    })
  } catch (err) {
    watcher = null
    startPolling()
    log(
      `[host:next] watching generated types failed (${(err as Error).message}); mirroring ${opts.to} by polling instead.`,
    )
  }
  await enqueue(() => syncAll())

  function startPolling(): void {
    if (stopped || poll !== null) return
    poll = setInterval(() => {
      if (stopped) return
      queueFullSync()
    }, opts.pollIntervalMs ?? 2000)
    // Never the reason the CLI stays alive.
    poll.unref()
  }

  return {
    stop() {
      stopped = true
      watcher?.close()
      watcher = null
      if (poll !== null) clearInterval(poll)
      poll = null
    },
  }
}

/**
 * Rewrite the relative module specifiers in a generated declaration so they
 * resolve from `targetFile` to the same files they resolved to from
 * `sourceFile`. Bare specifiers (`next/...`) are untouched, and so is anything
 * that stays inside `sourceTree` (`./routes.js` beside `validator.ts`), since
 * the whole tree moves together. Covers the forms
 * Next emits: `from "./x"`, `import "./x"`, `import("./x")`, `typeof import("./x")`.
 */
export function rebaseRelativeSpecifiers(
  content: string,
  sourceFile: string,
  targetFile: string,
  /** The tree being mirrored: a specifier that stays inside it names a sibling that is mirrored too, and is left alone. */
  sourceTree: string,
): string {
  const fromBase = dirname(sourceFile)
  const toBase = dirname(targetFile)
  if (fromBase === toBase) return content
  return content.replace(
    /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\2/g,
    (match, lead: string, quote: string, spec: string) => {
      const absolute = resolve(fromBase, spec)
      if (absolute === sourceTree || absolute.startsWith(sourceTree + sep)) return match
      let rebased = relative(toBase, absolute).split(sep).join("/")
      if (!rebased.startsWith(".")) rebased = `./${rebased}`
      return `${lead}${quote}${rebased}${quote}`
    },
  )
}
