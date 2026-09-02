import { Router, type RequestHandler } from "express"
import { promises as fs } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip } from "node:zlib"
import * as tar from "tar"
import type { AppDeps } from "../create-app"
import {
  hasProjectManageAuthority,
  requireReadableProject,
  resolveReadContext,
} from "../auth/authorize"
import { pruneSupersededDeploymentAssets, publishOutputDir } from "../build/publish-output"
import { scanOutputTreeForRootAbsoluteAssets } from "../build/root-absolute-scan"
import { withProjectLock } from "../project-locks"
import type { Deployment, DeploymentWarning } from "../storage/types"

/**
 * Hard cap on the COMPRESSED upload as it arrives over the wire.
 * Guards against an attacker simply holding the connection open and
 * streaming an enormous request body.
 */
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024

/**
 * Hard cap on the DECOMPRESSED tar stream. A gzip archive can expand far
 * beyond its compressed size (a "zip bomb") — a few hundred KB on the wire
 * can inflate to tens of GB once gunzipped, sailing under MAX_BUNDLE_BYTES
 * while `tar.x` happily writes the full expansion to disk. Both caps are
 * required: MAX_BUNDLE_BYTES alone does not bound what gets written.
 */
const MAX_EXTRACTED_BYTES = 200 * 1024 * 1024

/**
 * Hard cap on the number of entries in an uploaded bundle (S4). The byte caps
 * above bound TOTAL size, but the dominant cost here is per-ENTRY, not
 * per-byte: one `mkdir`+`writeFile` per file during extraction, then one more
 * `readFile`+asset-store `put` per file during publish — so a huge count of
 * near-empty files sails under both byte caps while still taking tens of
 * seconds and permanently creating one inode per file on the single-process
 * host. Measured (2026-08-09 audit): 100,001 tiny entries at 710 KiB on the
 * wire took 65s, ~1GB RSS, and 200k inodes; 20,001 entries took ~9.4s and
 * ~40k inodes. 20,000 keeps the worst case in that second, tolerable range —
 * generous for any real prototype build (a Vite/React output is typically
 * hundreds to a few thousand files; a large statically-generated docs site
 * might reach a few thousand) while bounding a single request to single-digit
 * seconds instead of over a minute.
 */
const MAX_BUNDLE_ENTRIES = 20_000

/**
 * Bound on the SUM of published file bytes, re-checked at publish time via
 * `publishOutputDir`'s own per-file `stat` — defense in depth alongside
 * `MAX_EXTRACTED_BYTES` above. That earlier cap bounds bytes flowing through
 * the tar STREAM; this one bounds what actually lands in the asset store,
 * computed from real on-disk file sizes. The two should normally agree
 * (extracted content can only be <= the decompressed stream, given tar's
 * block-padding overhead) — this is the belt to that suspenders, not a
 * separate, looser limit, so it reuses the same value.
 */
const MAX_PUBLISHED_BYTES = MAX_EXTRACTED_BYTES

/**
 * A passthrough Transform that destroys itself (and thus the whole
 * `pipeline()`) once more than `maxBytes` have flowed through it. Enforcing
 * the cap as a stage INSIDE the pipeline — rather than a side `req.on("data",
 * ...)` counter calling `req.destroy()` — makes backpressure and teardown
 * the stream machinery's job instead of a race: a side counter cannot
 * synchronously stop chunks already handed to the downstream destination.
 */
function limitStream(maxBytes: number, message: string): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > maxBytes) {
        callback(new Error(message))
        return
      }
      callback(null, chunk)
    },
  })
}

/** True if `p` is an absolute path or contains a `..` traversal segment. */
function isUnsafeRelativePath(p: string): boolean {
  return p.startsWith("/") || p.split("/").includes("..")
}

/**
 * Publish-time honesty check (design spec § Serving model, mechanism 4;
 * generalized viewer-membership row 7). HTML attribute rewriting cannot
 * reach root-absolute URLs baked inside JS/CSS, or written literally into
 * the HTML itself; those are served by the root-asset-fallback middleware
 * on a best-effort basis (Referer, or a content-hash match), which does not
 * cover every case — a non-hashed path with no Referer still 404s. Rather
 * than rewriting content (rejected as brittle — see
 * `build/root-absolute-scan.ts`'s header) or failing silently, the shared
 * scanner's result is recorded on the deployment (`Deployment.warnings`) so
 * the uploader learns at publish time instead of from a blank page.
 */
async function scanUploadedBundleForWarnings(
  extractDir: string,
  files: string[],
): Promise<DeploymentWarning[] | null> {
  const { findings, summary } = await scanOutputTreeForRootAbsoluteAssets(extractDir, files)
  if (findings.length === 0 || summary === null) return null
  return [{ kind: "root-absolute-assets", summary, findings }]
}

/**
 * Strips `buildLog` for a caller who isn't project owner/admin (S7). Omits the
 * key entirely rather than blanking it, so a client can't mistake "not shown
 * to you" for "this deployment genuinely logged nothing" (same reasoning as
 * `members-routes.ts`'s `includeEmail`).
 *
 * `steps` deliberately SURVIVES this projection and goes to every reader. The
 * log is withheld because it carries the operator's install/build command line
 * and the full stdout of a private repo's toolchain; the phase list carries
 * four fixed names and two timestamps each, and nothing project-specific. A
 * reader who can see that a deployment failed is better served knowing it
 * failed at Install than being told only that it failed.
 */
function omitBuildLog(d: Deployment): Omit<Deployment, "buildLog"> {
  const { buildLog: _buildLog, ...rest } = d
  return rest
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"))
    }
  }
  await walk(root)
  return out
}

/**
 * Finder junk that must not veto re-rooting: macOS Finder drops `.DS_Store`
 * everywhere, and a default `tar` on macOS adds `._*` AppleDouble siblings
 * (`__MACOSX/` is the zip-era spelling of the same). None of it is part of
 * anyone's build output.
 */
function isBundleJunk(name: string): boolean {
  return name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._")
}

/**
 * The build-output folder names worth trying inside a project, best first:
 * Vite/Parcel/Angular publish to `dist`, CRA and SvelteKit to `build`, Next's
 * static export to `out`, Eleventy/Jekyll to `_site`, Ionic to `www`.
 * Deliberately NOT here: `public` and `src` — those are SOURCE conventions
 * (CRA's `public/index.html` is an unbuild template), and publishing them is
 * exactly the wrong-thing-silently outcome this list exists to avoid.
 */
const OUTPUT_DIR_PRIORITY = ["dist", "build", "out", "_site", "www"]

export type BundleRootResolution =
  | { root: string }
  | { root: null; reason: "no-index" | "unbuilt-project" }

/**
 * Where the bundle's real root is, as a `"dist/"`-style prefix — `""` when
 * the top level is already servable.
 *
 * Uploads come from designers, and two mistakes dominate (Mo, 2026-08-30):
 *
 * 1. **Tarred the folder instead of its contents** — `tar -czf x.tar.gz
 *    dist` puts `dist/index.html` in the archive. Handled by descending an
 *    unambiguous wrapper chain: no `index.html` here, exactly one non-junk
 *    directory, no non-junk loose files.
 * 2. **Tarred the whole project.** A `package.json` at the current level is
 *    the tell — and it also means a bare `index.html` beside it may be a
 *    SOURCE file (Vite's build entry), not something servable. So a project
 *    level prefers a known output folder (`OUTPUT_DIR_PRIORITY`, resolved
 *    recursively so Angular's `dist/<app>/browser` nesting works), and only
 *    falls back to its own `index.html` when no built output exists — which
 *    keeps a BUILD that happens to ship a `package.json` (SSR outputs do)
 *    accepted at its root exactly as before.
 *
 * `package.json`'s ONE remaining job here is arbitrating a root
 * `index.html`: beside a manifest it may be a source entry, so known outputs
 * are preferred over it; without a manifest a root `index.html` is servable
 * and wins outright. The output-folder search itself does NOT need the
 * manifest (Mo, 2026-08-30: "why still refuse?") — `dist` means "build
 * output" by name, so `tar src dist` resolves to `dist` with or without a
 * `package.json` beside them. What still refuses is a bundle with no
 * `index.html` reachable through any of the three signals — root, a known
 * output folder, or an unambiguous wrapper chain — because there a pick
 * really would be a guess (`docs/` vs `examples/`). The depth cap is a
 * runaway guard, not a real limit.
 */
export function resolveBundleRoot(files: string[]): BundleRootResolution {
  return resolveRootFrom(files, "", 0)
}

function resolveRootFrom(files: string[], prefix: string, depth: number): BundleRootResolution {
  if (depth > 8) return { root: null, reason: "no-index" }
  const scoped = files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
  const dirs = new Set<string>()
  let looseFiles = false
  for (const f of scoped) {
    const slash = f.indexOf("/")
    if (slash === -1) {
      if (!isBundleJunk(f)) looseFiles = true
    } else {
      const top = f.slice(0, slash)
      if (!isBundleJunk(top)) dirs.add(top)
    }
  }

  const hasManifest = scoped.includes("package.json")
  const hasIndex = scoped.includes("index.html")

  // A servable root, with no manifest casting doubt on it, wins outright.
  if (hasIndex && !hasManifest) return { root: prefix }

  for (const candidate of OUTPUT_DIR_PRIORITY) {
    if (!dirs.has(candidate)) continue
    const inner = resolveRootFrom(files, `${prefix}${candidate}/`, depth + 1)
    if (inner.root !== null) return inner
  }

  // A manifest beside index.html with no built output: an SSR-style BUILD
  // that ships its own package.json — accepted at its root, as ever.
  if (hasIndex) return { root: prefix }
  if (hasManifest) return { root: null, reason: "unbuilt-project" }
  if (looseFiles || dirs.size !== 1) return { root: null, reason: "no-index" }
  return resolveRootFrom(files, `${prefix}${[...dirs][0]}/`, depth + 1)
}

// No explicit `Request`/`Response` annotations on the handlers below — same
// note as projects-routes.ts: typing the params that way widens `req.params`
// to Express 5's generic `ParamsDictionary`, which fails strict typecheck.
// Leaving the callbacks untyped lets TS infer the precise per-route params.
export function createDeploymentsRoutes(
  deps: AppDeps,
  requireWrite: RequestHandler,
): Router {
  const router = Router()

  router.get("/projects/:id/deployments", async (req, res) => {
    // Resolves the caller itself, then hands the read gate to
    // `requireReadableProject` (auth/authorize.ts) — the one implementation of
    // the byte-identical-404 disclosure rule. This route used to inline a COPY
    // of that rule (as did `members-routes.ts`), because it needs the resolved
    // `ctx` after the gate for field scoping; the shared function takes an
    // already-resolved context precisely so a caller in that position does not
    // have to hand-write the disclosure rule a third time.
    //
    // What the scoping decides here is whether `buildLog` is included at all
    // (S7): it can carry the operator's install/build command line and the
    // full stdout/stderr of a private repo's toolchain, a much higher-trust
    // artifact than "this project has a deployment history" — which stays
    // visible to every project reader. Only the LOG CONTENT is raised to the
    // manage set, matching the dedicated log-stream route's gate.
    const projectId = String(req.params.id)
    const ctx = await resolveReadContext(deps, req)
    if ("error" in ctx) {
      res.status(401).json({ error: ctx.error })
      return
    }
    const project = await requireReadableProject(deps, res, ctx, projectId)
    if (!project) return

    // The same rule the log-STREAM route enforces with `requireProjectManage`
    // (`build-routes.ts`). These two must agree: a caller who is refused the
    // stream but handed the identical bytes in this list has not been gated
    // at all. Applied downstream of the read gate above, which is the
    // precondition `hasProjectManageAuthority` cannot check for itself.
    const includeBuildLog = hasProjectManageAuthority(ctx)

    const deployments = await deps.storage.listDeployments(project.id)
    res.json({
      deployments: includeBuildLog ? deployments : deployments.map(omitBuildLog),
    })
  })

  /**
   * Bundle upload — the no-GitHub escape hatch (spec §5). The request
   * body is a gzipped tar of the build output; Phase 3's build runner
   * will reuse this same extract-and-activate path.
   */
  router.post("/projects/:id/deployments", requireWrite, async (req, res) => {
    // Composing the plain `RequestHandler`-typed guard (`requireWrite`) with
    // this route handler widens the inferred `req.params` for the whole
    // handler array back to Express 5's generic `ParamsDictionary` (`string
    // | string[]`) — same as the PATCH route in projects-routes.ts. A single
    // named `:id` segment is never an array, so this is a safe, non-widening
    // coercion, not a cast past a real ambiguity.
    const projectId = String(req.params.id)
    const commitShaParam = req.query.commitSha
    // Fix wave 10, item 2: only the "does the project still exist, create a
    // deployment row" start is serialized against a concurrent project
    // DELETE (`project-locks.ts`) — same split as the build queue's own
    // start path. The extraction/publish work below is the long-running
    // part and runs OUTSIDE the lock.
    const started = await withProjectLock(projectId, async () => {
      const project = await deps.storage.getProject(projectId)
      if (!project) return null
      const deployment = await deps.storage.createDeployment({
        projectId: project.id,
        commitSha: typeof commitShaParam === "string" ? commitShaParam : null,
      })
      return { project, deployment }
    })
    if (!started) {
      res.status(404).json({ error: "Project not found" })
      return
    }
    const { project, deployment } = started

    const workDir = await mkdtemp(join(tmpdir(), "viewer-upload-"))
    const extractDir = join(workDir, "out")
    await fs.mkdir(extractDir, { recursive: true })

    // Guards against responding twice: the no-index.html branch below calls
    // `fail()` from inside the `try`, whose `catch` also calls `fail()` on
    // any thrown error. If `fail()` itself throws partway through (e.g.
    // `updateDeployment` rejects), the `catch` would otherwise re-run it and
    // fire a second `res.status(...).json(...)` after headers are already
    // sent. Setting the guard as the very first step — before any of
    // `fail()`'s own async work — means a re-entrant call always short-
    // circuits, even if the first call fails before reaching `res.json`.
    let responded = false
    const fail = async (message: string): Promise<void> => {
      if (responded) return
      responded = true
      await deps.storage.updateDeployment(deployment.id, {
        status: "failed",
        buildLog: message,
      })
      await rm(workDir, { recursive: true, force: true })
      // Best-effort: if any files from this upload were already written to
      // the asset store (a mid-loop `assets.put` failure partway through),
      // don't leave them orphaned under a deployment that never activated.
      // A cleanup failure here must not mask the original error/response.
      try {
        await deps.assets.deleteDeployment(deployment.id)
      } catch (cleanupError) {
        console.error(
          `[viewer] failed to clean up assets for deployment ${deployment.id}:`,
          cleanupError,
        )
      }
      res.status(400).json({ error: message, deploymentId: deployment.id })
    }

    // S4: counted OUTSIDE the pipeline so the `catch` below can tell "too
    // many entries" apart from every other extraction failure and report a
    // clear reason instead of whatever message `AbortError` happens to carry.
    let entryCount = 0
    let tooManyEntries = false
    const abortController = new AbortController()

    try {
      await pipeline(
        req,
        limitStream(MAX_BUNDLE_BYTES, "Bundle too large"),
        createGunzip(),
        limitStream(MAX_EXTRACTED_BYTES, "Extracted contents too large"),
        tar.x({
          cwd: extractDir,
          // App-level defense-in-depth: reject an entry path or symlink/
          // hardlink target that is absolute or contains a `..` segment,
          // before anything is written. node-tar's own extraction defaults
          // independently guard against symlink/hardlink escapes too — this
          // filter does not stand alone as the only protection, it adds a
          // second, explicit check ahead of the library's.
          filter: (path, entry) => {
            // Never extracted, never counted: a whole-project tar (the
            // designer case `resolveBundleRoot` exists for) drags
            // `node_modules` and `.git` along, and neither is publishable.
            // Skipping them BEFORE the entry count keeps a legitimate
            // project under MAX_BUNDLE_ENTRIES; the gunzip-stream byte cap
            // above still bounds the work a huge node_modules costs, and
            // fails with "Extracted contents too large" when it is truly
            // enormous.
            const segments = path.split("/")
            if (segments.includes("node_modules") || segments.includes(".git")) return false
            entryCount += 1
            if (entryCount > MAX_BUNDLE_ENTRIES) {
              // Abort the whole pipeline rather than merely skipping this
              // entry (returning `false` alone) — silently truncating would
              // still extract and publish a broken, partial bundle. The
              // abort propagates through `pipeline`'s stream chain and
              // rejects it, landing in the `catch` below like any other
              // extraction failure.
              tooManyEntries = true
              abortController.abort()
              return false
            }
            if (isUnsafeRelativePath(path)) return false
            const linkpath = "linkpath" in entry ? entry.linkpath : undefined
            if (linkpath && isUnsafeRelativePath(linkpath)) return false
            return true
          },
        }),
        { signal: abortController.signal },
      )

      const files = await collectFiles(extractDir)

      // Second, INDEPENDENT check (S4): the `filter` above counts tar
      // entries as the parser walks the incoming stream and aborts once
      // that count is exceeded, but the abort racing already-in-flight
      // writes means a few entries can land on disk before extraction
      // actually stops (measured: aborting at entry 11 of a MAX=10 test
      // still let 9 files finish writing). Recomputing the count from what
      // ACTUALLY got extracted closes that race instead of trusting the
      // streaming counter alone.
      if (files.length > MAX_BUNDLE_ENTRIES) {
        await fail(`Bundle has more than ${MAX_BUNDLE_ENTRIES} files`)
        return
      }

      // The forgiving root check — see `resolveBundleRoot`: handles the
      // tarred-the-folder and tarred-the-whole-project mistakes, refuses
      // anything ambiguous.
      const resolved = resolveBundleRoot(files)
      if (resolved.root === null) {
        await fail(
          resolved.reason === "unbuilt-project"
            ? "This looks like a whole project, not a build. Build it, then upload the output folder (usually dist or build)."
            : "Bundle has no index.html at its root",
        )
        return
      }
      const bundleRoot = resolved.root
      // Everything downstream — publish, the asset scan, the served paths —
      // works from the RESOLVED root, so a re-rooted bundle serves exactly
      // as if it had been tarred correctly. Junk outside the root
      // (`.DS_Store`, `._*`) is simply not published. `join` is safe here:
      // the prefix is built from paths the extraction filter already
      // rejected `..` segments from.
      const publishDir = bundleRoot === "" ? extractDir : join(extractDir, bundleRoot)
      const publishFiles =
        bundleRoot === ""
          ? files
          : files.filter((f) => f.startsWith(bundleRoot)).map((f) => f.slice(bundleRoot.length))

      // Reuses the build lane's shared publish step (S4's total-published-
      // bytes bound, checked via a `stat` per file) instead of a bespoke
      // read+put loop — the two lanes converge here on purpose, see this
      // module's own header comment ("Phase 3's build runner will reuse
      // this same extract-and-activate path").
      await publishOutputDir(deps.assets, deployment.id, publishDir, publishFiles, MAX_PUBLISHED_BYTES)

      // Never allowed to fail the upload — a scan bug must not turn a
      // successful publish into a reported failure. See this function's own
      // doc comment above for why the RESULT still matters.
      let warnings: DeploymentWarning[] | null = null
      try {
        warnings = await scanUploadedBundleForWarnings(publishDir, publishFiles)
      } catch (scanError) {
        console.error(
          `[viewer] root-absolute asset scan failed for deployment ${deployment.id} (continuing without warnings):`,
          scanError,
        )
      }
      const deployed = await deps.storage.updateDeployment(deployment.id, {
        status: "deployed",
        // The re-root is stated in the log so an unexpected serving layout
        // is diagnosable from the deployment record, not a mystery.
        buildLog: `Uploaded ${publishFiles.length} files${bundleRoot ? ` (bundle root: ${bundleRoot})` : ""}\n${warnings ? `Warning: ${warnings[0].summary}\n` : ""}`,
        warnings,
      })
      await deps.storage.updateProject(project.id, {
        activeDeploymentId: deployment.id,
      })
      await rm(workDir, { recursive: true, force: true })

      // S5: this project just got a new active deployment — reclaim
      // whatever fell off the retained-history window. See
      // `pruneSupersededDeploymentAssets` for why this is asset-only and
      // best-effort (it never throws, so it can't turn a successful upload
      // into a failed response).
      await pruneSupersededDeploymentAssets(deps.storage, deps.assets, project.id, deployment.id)

      res.status(201).json({ ...deployed, fileCount: publishFiles.length })
    } catch (error) {
      // If we're already past a `fail()` call (the no-index.html branch
      // above, or a prior iteration of this same catch), `fail()` itself
      // must have thrown to land us here a second time — re-running it
      // would just short-circuit on the guard and silently swallow the
      // error, leaving the request unanswered. Rethrow instead so
      // Express's default error handling (create-app.ts) sends a generic
      // 5xx rather than hanging the connection.
      if (responded) throw error
      if (tooManyEntries) {
        await fail(`Bundle has more than ${MAX_BUNDLE_ENTRIES} entries`)
        return
      }
      await fail(`Bundle upload failed: ${(error as Error).message}`)
    }
  })

  return router
}
