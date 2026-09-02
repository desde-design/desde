/**
 * The shared "a directory of built files becomes the live deployment" path.
 *
 * Extracted from `api/deployments-routes.ts`, whose own docstring said the
 * bundle-upload route was the escape hatch and that "Phase 3's build runner
 * will reuse this same extract-and-activate path." Two copies of this would
 * drift: `requireIndexHtml` here is exactly that — shared from the start.
 *
 * The root-absolute-asset-reference scan is the same idea, one module over:
 * it used to live ONLY in the upload lane (an ad hoc regex keyed off the
 * bundle's own top-level directory names), so the build lane quietly had no
 * scan at all — the risk this file's own extraction was meant to prevent,
 * for one specific check. `build/root-absolute-scan.ts` closes that: both
 * lanes now call `scanOutputTreeForRootAbsoluteAssets` against the final
 * output tree, after this module's `publishOutputDir` has written it.
 *
 * The upload lane owns un-tarring (that is upload-specific); this owns
 * everything from "there is a directory on disk" onward, which is exactly
 * what the two lanes share.
 *
 * SECURITY — this module is the last thing standing between attacker-authored
 * repo content and the asset store, so the symlink rules below are load
 * bearing. See `collectOutputFiles`.
 */
import { promises as fs } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { AssetStore } from "../assets/types"
import type { Deployment, StorageAdapter } from "../storage/types"

/** Thrown when the output directory escapes, or an entry inside it does. */
export class UnsafeOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeOutputError"
  }
}

/**
 * Resolves `outputDir` against the checkout root and proves the result is
 * still inside it, following symlinks.
 *
 * Phase 3c-1 validates the REQUEST-supplied half of `outputDir` (charset
 * allowlisted, no `..` segment, no absolute path, no bare `.`). It cannot
 * validate repo CONTENT, and repo content is attacker-controlled: a repo that
 * commits `dist` as a symlink to `/` reaches outside the checkout with a
 * completely legitimate `outputDir: "dist"`. Only a post-resolution
 * `realpath` catches that, which is why this runs at build time rather than
 * being pushed back onto the connect-time validator.
 *
 * `realpath` is applied to BOTH sides: the checkout root itself may sit under
 * a symlinked temp dir (on macOS `/var` → `/private/var`, which would make a
 * naive string comparison fail on every build).
 */
export async function resolveOutputDir(checkoutRoot: string, outputDir: string): Promise<string> {
  const realRoot = await fs.realpath(checkoutRoot)
  const candidate = resolve(realRoot, outputDir)
  let realOut: string
  try {
    realOut = await fs.realpath(candidate)
  } catch {
    throw new UnsafeOutputError(`Build output directory "${outputDir}" does not exist`)
  }
  if (realOut !== realRoot && !realOut.startsWith(realRoot + sep)) {
    // Deliberately does NOT name the resolved path — that would report host
    // filesystem layout back to whoever authored the repo.
    throw new UnsafeOutputError(`Build output directory "${outputDir}" resolves outside the repository checkout`)
  }
  const stat = await fs.stat(realOut)
  if (!stat.isDirectory()) {
    throw new UnsafeOutputError(`Build output path "${outputDir}" is not a directory`)
  }
  return realOut
}

/**
 * Walks the output tree WITHOUT following symlinks and returns repo-relative
 * POSIX paths.
 *
 * Symlinks are **refused, not skipped**. Skipping is the tempting choice — it
 * keeps a build "working" — but a build whose output silently omits files
 * produces a prototype that is broken in a way nobody can explain from the
 * build log. Refusing is louder and truthful: something in the output tree
 * points somewhere it should not, and the operator gets told which entry.
 *
 * `lstat` (not `stat`) is the whole point: `stat` follows the link and would
 * happily report a symlink-to-`/etc/passwd` as an ordinary file.
 */
export async function collectOutputFiles(outputRoot: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(outputRoot, full).split(sep).join("/")
      if (entry.isSymbolicLink()) {
        throw new UnsafeOutputError(`Build output contains a symlink ("${rel}"), which is not published`)
      }
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(rel)
      // Anything else (fifo, socket, device) is silently not a publishable
      // asset; there is nothing to serve and nothing to warn about.
    }
  }
  await walk(outputRoot)
  return out.sort()
}

export interface PublishResult {
  fileCount: number
  totalBytes: number
}

/**
 * Writes an already-validated output directory into the `AssetStore` under a
 * deployment id.
 *
 * `maxTotalBytes` is a real bound, not a formality: without it a repo whose
 * build emits a multi-gigabyte artifact fills the viewer's disk. Exceeding it
 * throws rather than truncating — a half-published deployment that serves an
 * `index.html` with missing chunks looks like a working deploy and is worse
 * than a failed one.
 */
export async function publishOutputDir(
  assets: AssetStore,
  deploymentId: string,
  outputRoot: string,
  files: string[],
  maxTotalBytes: number,
): Promise<PublishResult> {
  let totalBytes = 0
  for (const relPath of files) {
    const full = join(outputRoot, relPath)
    // `stat` BEFORE `readFile` (K01): `readFile` buffers the whole file into
    // memory before this loop gets a chance to reject it, so a single
    // artifact bigger than `maxTotalBytes` (a stray video, an unminified
    // source map) would still spike RSS by that file's full size before the
    // cap could ever fire. Sizing from `stat` means an oversized file is
    // refused without ever being read.
    const stat = await fs.stat(full)
    totalBytes += stat.size
    if (totalBytes > maxTotalBytes) {
      throw new UnsafeOutputError(
        `Build output exceeds the ${Math.floor(maxTotalBytes / (1024 * 1024))}MB limit`,
      )
    }
    const body = await fs.readFile(full)
    await assets.put(deploymentId, relPath, body)
  }
  return { fileCount: files.length, totalBytes }
}

/**
 * How many of a project's most-recent deployments (any status) keep their
 * asset directory once a NEW deployment has activated. S5: before this,
 * nothing ever reclaimed a superseded deployment's assets — every upload and
 * every build left a full, permanent copy on disk, forever. 5 keeps a short
 * rollback/compare window ("what did we ship last time") while turning
 * unbounded growth into a small fixed multiple of one deployment's size
 * instead of one-per-deploy-ever.
 */
export const DEPLOYMENT_RETENTION_COUNT = 5

/**
 * Reclaims the asset directories of a project's deployments beyond the
 * `DEPLOYMENT_RETENTION_COUNT` most recent, run right after a new deployment
 * activates. `keepActiveId` is always kept regardless of its position in the
 * list, so re-activating an OLD deployment (a future rollback feature) can
 * never have its own assets swept out from under it by the very activation
 * that keeps it alive.
 *
 * Best-effort and asset-only: a single directory's cleanup failure is
 * logged and does not fail (or partially fail) the deploy that triggered
 * it, and one failure does not stop the rest of the sweep — the
 * alternative (a garbage-collection hiccup turning an otherwise-successful
 * deploy into a 5xx) is worse than a directory that gets swept again next
 * time. This reclaims the ASSET DIRECTORY only, not the deployment ROW —
 * the row (status, commitSha, a length-bounded build log) is a few KB,
 * orders of magnitude smaller than the disk/inode cost this closes (S5's
 * headline number: a single upload alone produced 100k+ files/inodes). Row
 * pruning needs its own `StorageAdapter.deleteDeployment`, which does not
 * exist yet — a natural follow-up, not a blocker to closing the dominant
 * disk-growth path.
 */
export async function pruneSupersededDeploymentAssets(
  storage: Pick<StorageAdapter, "listDeployments">,
  assets: Pick<AssetStore, "deleteDeployment">,
  projectId: string,
  keepActiveId: string,
): Promise<void> {
  // Documented newest-first — see `StorageAdapter.listDeployments`.
  const deployments: Pick<Deployment, "id">[] = await storage.listDeployments(projectId)
  const rest = deployments.filter((d) => d.id !== keepActiveId)
  const stale = rest.slice(DEPLOYMENT_RETENTION_COUNT - 1)
  for (const d of stale) {
    try {
      await assets.deleteDeployment(d.id)
    } catch (error) {
      console.error(`[viewer] failed to prune superseded deployment ${d.id}:`, error)
    }
  }
}

/**
 * The one structural requirement on build output, shared with the upload
 * lane: something has to be served at `/p/{slug}/`.
 */
export function requireIndexHtml(files: string[]): void {
  if (!files.includes("index.html")) {
    throw new UnsafeOutputError("Build output has no index.html at its root")
  }
}
