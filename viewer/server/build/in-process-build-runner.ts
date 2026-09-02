/**
 * The in-process `BuildRunner`: clone → install → build → publish.
 *
 * Runs the repository's own commands on this host as this process. See
 * `exec.ts` for the trust model — this is not a sandbox, and the job here is
 * to avoid widening the blast radius rather than to contain it.
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssetStore } from "../assets/types"
import type { BuildStep, DeploymentWarning, ProjectRepoConfig } from "../storage/types"
import type { GitHubAppClient } from "../github/types"
import { buildEnv, buildStepEnv, execStep, redact } from "./exec"
import {
  UnsafeOutputError,
  collectOutputFiles,
  publishOutputDir,
  requireIndexHtml,
  resolveOutputDir,
} from "./publish-output"
import { scanOutputTreeForRootAbsoluteAssets } from "./root-absolute-scan"
import type { BuildRequest, BuildResult, BuildRunner } from "./types"

export interface InProcessBuildRunnerOptions {
  assets: AssetStore
  githubApp: GitHubAppClient
  apiBaseUrl?: string
  timeoutMs?: number
  maxOutputBytes?: number
  maxTotalOutputBytes?: number
  /**
   * Overrides how a clone URL is derived from the repo config. Real reason
   * to exist: a self-hosted GitHub whose git host isn't simply its API host
   * minus the `api.` prefix. It also lets tests clone from a local path,
   * which keeps the real clone/checkout/publish code path under test with no
   * network and no GitHub App — the alternative was mocking the one step
   * whose behaviour actually matters.
   */
  cloneUrlFor?: (repo: ProjectRepoConfig) => string
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_LOG_BYTES = 512 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024

export function createInProcessBuildRunner(opts: InProcessBuildRunnerOptions): BuildRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_LOG_BYTES
  const maxTotalOutputBytes = opts.maxTotalOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return {
    async run(request: BuildRequest): Promise<BuildResult> {
      const { repo, deployment, onLog, signal } = request
      // Populated once the installation token is minted, below. `say`
      // redacts against whatever this array holds AT CALL TIME — every
      // `say()` call in this function happens after minting, so this is a
      // forward reference, not a race. S7: `say` used to bypass `redact()`
      // entirely, so runner-authored text (which is where the operator's
      // free-text install/build command line shows up) went out unscrubbed
      // while bytes captured from the child's stdout/stderr, via the exact
      // same `redact()`, did not.
      const secrets: string[] = []
      const say = (text: string) => onLog({ stream: "runner", text: redact(text, secrets) })

      /*
        Phase tracking, for the deployment detail's step list.

        `beginStep` closes the previous phase as succeeded and opens the next
        — a build only reaches phase N+1 by completing phase N, so there is no
        way to open one without the one before it having worked. `failStep`
        closes the open phase as failed and is called from `fail()`, which is
        the single exit every failure path already goes through.

        Names are the FIXED four, never the commands that implement them. A
        step called after `repo.installCommand` would put the operator's
        install line in front of every project reader, which is the exact
        thing `buildLog` is withheld from non-owners to prevent.
      */
      const steps: BuildStep[] = []
      const publishSteps = () => request.onSteps?.(steps.map((step) => ({ ...step })))
      const closeOpenStep = (status: "succeeded" | "failed") => {
        const open = steps[steps.length - 1]
        if (open && open.status === "running") {
          open.status = status
          open.endedAt = new Date().toISOString()
        }
      }
      const beginStep = (name: BuildStep["name"]) => {
        closeOpenStep("succeeded")
        steps.push({ name, status: "running", startedAt: new Date().toISOString() })
        publishSteps()
      }
      const failStep = () => {
        closeOpenStep("failed")
        publishSteps()
      }

      // One temp root per build, removed in `finally` on every exit path —
      // success, failure, timeout, throw. It doubles as the child's HOME and
      // TMPDIR so npm/git scratch files never touch the real ones.
      const workRoot = await mkdtemp(join(tmpdir(), "viewer-build-"))
      const checkout = join(workRoot, "repo")
      const home = join(workRoot, "home")

      let token: string | null = null
      let commitSha: string | null = request.commitSha ?? null
      let commitMessage: string | null = null

      try {
        await mkdir(home, { recursive: true })
        await mkdir(checkout, { recursive: true })

        const minted = await opts.githubApp.createInstallationToken(repo.installationId)
        token = minted.token
        // Every step (runner-authored AND child-captured, now `say` too)
        // scrubs the token. The `-c http.extraHeader` form below keeps it
        // out of the URL, but assume one path leaks it anyway — git is
        // verbose and the build log is shown in the UI.
        secrets.push(token)

        const env = buildEnv(home, {
          // Nothing may prompt: a build that blocks on a credential prompt
          // would sit there until the timeout with no useful log.
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/echo",
        })
        // `NODE_ENV=production` belongs on the BUILD step only — on install it
        // makes *npm* omit devDependencies (pnpm and Yarn Berry do not —
        // measured), which is where the build
        // toolchain lives. See `buildStepEnv`.
        const buildOnlyEnv = buildStepEnv(home, {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/bin/echo",
        })
        const step = (
          command: string,
          args: string[],
          shell = false,
          stepEnv: Record<string, string> = env
        ) =>
          execStep(command, args, {
            cwd: shell ? checkout : workRoot,
            shell,
            timeoutMs,
            maxOutputBytes,
            env: stepEnv,
            secrets,
            signal,
            onLog: (stream, text) => onLog({ stream, text }),
          })

        // The token goes in a HEADER, never in the URL. The obvious
        // `https://x-access-token:TOKEN@github.com/...` form writes the
        // credential into .git/config, into `ps` output, and into git's own
        // error messages — all three outlive the build.
        const host = new URL(opts.apiBaseUrl ?? "https://api.github.com").host.replace(/^api\./, "")
        const cloneUrl = opts.cloneUrlFor
          ? opts.cloneUrlFor(repo)
          : `https://${host}/${repo.owner}/${repo.name}.git`
        const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`

        beginStep("Clone")
        say(`Cloning ${repo.owner}/${repo.name} @ ${repo.branch}\n`)
        // Shallow: a full-history clone of a large repo costs minutes for
        // nothing — a build only ever needs one tree.
        const cloneArgs = ["-c", `http.extraHeader=${authHeader}`, "clone", "--depth", "1"]
        if (!request.commitSha) cloneArgs.push("--branch", repo.branch, "--single-branch")
        cloneArgs.push(cloneUrl, checkout)
        const cloned = await step("git", cloneArgs)
        if (cloned.code !== 0) {
          return await fail(cloned.timedOut ? "Clone timed out" : "Clone failed")
        }

        if (request.commitSha) {
          // A specific commit may not be in a depth-1 clone of the branch
          // tip, so fetch it explicitly before checking out.
          const fetched = await step("git", [
            "-c",
            `http.extraHeader=${authHeader}`,
            "-C",
            checkout,
            "fetch",
            "--depth",
            "1",
            "origin",
            request.commitSha,
          ])
          if (fetched.code !== 0) return await fail(`Commit ${request.commitSha} not found`)
          const checkedOut = await step("git", ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"])
          if (checkedOut.code !== 0) return await fail(`Could not check out ${request.commitSha}`)
        }

        const rev = await step("git", ["-C", checkout, "rev-parse", "HEAD"])
        if (rev.code === 0) commitSha = rev.output.trim().split("\n").pop() ?? commitSha
        // The subject line only (`%s`), capped: it renders on a one-line
        // deployment card, and a runaway first line in someone's commit
        // must not become a runaway row. Best-effort like the sha above — a
        // failure here is not a failed build.
        const subject = await step("git", ["-C", checkout, "log", "-1", "--format=%s"])
        if (subject.code === 0) {
          const line = subject.output.trim().split("\n").pop()?.trim() ?? ""
          if (line.length > 0) commitMessage = line.slice(0, 200)
        }

        // `shell: true` from here: the repo's own commands are arbitrary
        // shell by contract. Everything ABOVE used an argv array precisely so
        // nothing derived from `branch` could reach a shell.
        //
        // S7: the command line itself is NOT echoed. `installCommand` /
        // `buildCommand` are operator-authored free text (project-repo-routes.ts
        // validates only length, not shape) — the connect-time UI already
        // shows the operator their own command, so nothing is lost by not
        // repeating it in every build's log, and it is exactly where a
        // private-registry credential inlined into the command
        // (`NPM_TOKEN=... npm ci`) would otherwise land in a log readable by
        // every project owner/admin.
        say(`\nInstalling dependencies\n`)
        beginStep("Install")
        const installed = await step(repo.installCommand, [], true)
        if (installed.code !== 0) {
          return await fail(installed.timedOut ? "Install timed out" : "Install failed")
        }

        say(`\nBuilding\n`)
        beginStep("Build")
        const built = await step(repo.buildCommand, [], true, buildOnlyEnv)
        if (built.code !== 0) {
          return await fail(built.timedOut ? "Build timed out" : "Build failed")
        }

        beginStep("Publish")
        say(`\nPublishing ${repo.outputDir}\n`)
        const outputRoot = await resolveOutputDir(checkout, repo.outputDir)
        const files = await collectOutputFiles(outputRoot)
        requireIndexHtml(files)
        const published = await publishOutputDir(
          opts.assets,
          deployment.id,
          outputRoot,
          files,
          maxTotalOutputBytes,
        )
        say(`Published ${published.fileCount} files (${Math.ceil(published.totalBytes / 1024)} KB)\n`)

        // Same shared scan the upload lane runs — see
        // `root-absolute-scan.ts`'s header comment. Never allowed to fail
        // the build: a scan bug must not turn a successful publish into a
        // reported build failure.
        let warnings: DeploymentWarning[] | null = null
        try {
          const scan = await scanOutputTreeForRootAbsoluteAssets(outputRoot, files)
          if (scan.findings.length > 0 && scan.summary !== null) {
            warnings = [{ kind: "root-absolute-assets", summary: scan.summary, findings: scan.findings }]
            say(`Warning: ${scan.summary}\n`)
          }
        } catch (scanError) {
          console.error(`[viewer] root-absolute asset scan failed for deployment ${deployment.id}:`, scanError)
        }

        // The last phase closes here rather than in `beginStep`, because
        // there is no phase after Publish to open and close it as a side
        // effect.
        closeOpenStep("succeeded")
        publishSteps()
        return { ok: true, commitSha, commitMessage, fileCount: published.fileCount, warnings }
      } catch (error) {
        // `UnsafeOutputError` is authored for a human and safe to show. Any
        // other throw may carry host detail, so it is logged server-side and
        // reported generically — the same discipline the OAuth provider uses.
        if (error instanceof UnsafeOutputError) return await fail(error.message)
        console.error(`[viewer] build ${deployment.id} threw:`, error)
        return await fail("Build failed unexpectedly. See the server log.")
      } finally {
        await rm(workRoot, { recursive: true, force: true }).catch(() => {})
      }

      async function fail(reason: string): Promise<BuildResult> {
        // Every failure path already funnels through here, so closing the
        // open phase in one place beats remembering it at each `return
        // await fail(...)` — there are six of them.
        failStep()
        say(`\n${reason}\n`)
        // K01/S5: a failure BEFORE `publishOutputDir` never wrote anything
        // under this deployment id, so this is a harmless no-op in the
        // common case (clone/install/build failed). A failure INSIDE or
        // just after publish (over the byte cap, a mid-loop I/O error) can
        // have already written some files to the asset store before
        // throwing — without this, every such failure permanently strands a
        // directory of orphaned files whose deployment never activates,
        // exactly the upload lane's `fail()` already guards against.
        try {
          await opts.assets.deleteDeployment(deployment.id)
        } catch (cleanupError) {
          console.error(`[viewer] failed to clean up assets for failed build ${deployment.id}:`, cleanupError)
        }
        return { ok: false, commitSha, commitMessage, fileCount: 0, failureReason: reason }
      }
    },
  }
}
