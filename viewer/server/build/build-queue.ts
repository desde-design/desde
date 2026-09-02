/**
 * Serializes builds and owns a build's lifecycle against storage.
 *
 * Why serialize at all: two concurrent builds of the same project race on
 * `activeDeploymentId`, and the loser silently becomes the live deployment
 * depending on which finishes second. Beyond correctness, an unbounded fleet
 * of `npm ci` processes is the easiest way to take the host down.
 *
 * The policy is REJECT, not queue. A queue is the wrong shape here: builds
 * are idempotent-by-commit and a user who clicks twice wants one build, not
 * two sequential ones, while a webhook storm (3c-3) would otherwise build
 * every intermediate commit to get to the same tip. Rejecting with the
 * in-flight deployment id lets the caller watch the build that already
 * exists, which is what they actually wanted.
 */
import type { StorageAdapter } from "../storage/types"
import type { AssetStore } from "../assets/types"
import { MAX_BUILD_LOG_BYTES } from "../storage/log-append"
import { withProjectLock } from "../project-locks"
import { pruneSupersededDeploymentAssets } from "./publish-output"
import type { BuildRunner } from "./types"

// Re-exported for this module's own callers — see `log-append.ts` for why
// the constant itself lives there now (fix wave 10, item 4).
export { MAX_BUILD_LOG_BYTES }

/**
 * Hard cap on TOTAL concurrent builds across every project, not just this
 * one (K01). The per-project check below (`inFlight.get(projectId)`) stops
 * the SAME project from racing itself, but nothing stopped a webhook push to
 * a repo wired to a dozen projects — or a dozen owners clicking "Build"
 * within the same minute — from spawning a `git clone` + `npm ci` + bundler
 * child PER PROJECT, all at once, in this single Node process that is also
 * serving the API and every SSE stream on the same event loop. 2 is
 * deliberately small: a real `npm ci && vite build` can spike well past a
 * few hundred MB of RSS on its own, so even two concurrent worst-case builds
 * is already a meaningful resource commitment — this buys "my build and
 * someone else's don't have to fully serialize," not headroom for a fleet.
 */
export const MAX_GLOBAL_CONCURRENT_BUILDS = 2

export class BuildInProgressError extends Error {
  constructor(public readonly deploymentId: string) {
    super("A build is already running for this project")
    this.name = "BuildInProgressError"
  }
}

/** Thrown by `start()` when `MAX_GLOBAL_CONCURRENT_BUILDS` are already running, regardless of project. */
export class BuildQueueFullError extends Error {
  constructor() {
    super(`No more than ${MAX_GLOBAL_CONCURRENT_BUILDS} builds may run at once. Try again shortly.`)
    this.name = "BuildQueueFullError"
  }
}

export interface BuildQueueDeps {
  storage: StorageAdapter
  assets: AssetStore
  runner: BuildRunner
  onChange?: (deploymentId: string) => void
}

export interface BuildQueue {
  /** Starts a build. Resolves as soon as it is RUNNING, not when it finishes. */
  start(projectId: string, commitSha?: string | null): Promise<string>
  activeDeploymentFor(projectId: string): string | undefined
  /** Aborts every in-flight build and marks its deployment failed. */
  shutdown(): Promise<void>
}

export function createBuildQueue(deps: BuildQueueDeps): BuildQueue {
  const inFlight = new Map<string, { deploymentId: string; controller: AbortController; done: Promise<void> }>()

  async function finish(deploymentId: string, status: "deployed" | "failed", tailLog: string): Promise<void> {
    if (tailLog) {
      await deps.storage.appendDeploymentLog(deploymentId, tailLog, MAX_BUILD_LOG_BYTES).catch(() => {})
    }
    // `updateDeployment` only sets status here — the log was written by the
    // append path, and passing `buildLog` would clobber everything the
    // runner streamed.
    await deps.storage.updateDeployment(deploymentId, { status }).catch((err) => {
      console.error(`[viewer] could not finalize deployment ${deploymentId}:`, err)
    })
    deps.onChange?.(deploymentId)
  }

  return {
    async start(projectId, commitSha) {
      const existing = inFlight.get(projectId)
      if (existing) throw new BuildInProgressError(existing.deploymentId)
      // Checked BEFORE any storage write (K01): a rejected build must never
      // create a deployment row — under a webhook fan-out to many projects,
      // that would itself grow storage unboundedly for builds that never ran.
      if (inFlight.size >= MAX_GLOBAL_CONCURRENT_BUILDS) throw new BuildQueueFullError()

      // Fix wave 10, item 2: only this "does the project still exist, create
      // a deployment row" start is serialized against a concurrent project
      // DELETE (`project-locks.ts`) — the build kicked off below runs
      // OUTSIDE the lock, because it can take minutes and nothing else
      // (including a delete waiting behind it) should have to block for the
      // whole build just because it briefly shared this project's lock.
      const { project, repo, deployment } = await withProjectLock(projectId, async () => {
        const project = await deps.storage.getProject(projectId)
        if (!project) throw new Error("Project not found")
        const repo = project.repoConfig
        if (!repo) throw new Error("Project has no connected repository")

        const deployment = await deps.storage.createDeployment({
          projectId,
          status: "building",
          commitSha: commitSha ?? null,
        })
        return { project, repo, deployment }
      })

      const controller = new AbortController()
      // Buffered so a burst of chunks becomes one write per tick rather than
      // one per line — a chatty `npm ci` otherwise turns into thousands of
      // UPDATEs and starves everything else on the single SQLite connection.
      let buffer = ""
      let flushing: Promise<void> = Promise.resolve()
      /*
        Serialized like `flushing`, and for the same reason: two overlapping
        `updateDeployment` calls are a read-modify-write race, and this one
        would lose a phase rather than a log chunk. Awaited before the
        terminal update below so the final phase list is on disk before the
        deployment flips to deployed/failed.
      */
      let stepWrites: Promise<void> = Promise.resolve()
      const flush = () => {
        if (!buffer) return
        const chunk = buffer
        buffer = ""
        flushing = flushing
          .then(() => deps.storage.appendDeploymentLog(deployment.id, chunk, MAX_BUILD_LOG_BYTES))
          .then(() => deps.onChange?.(deployment.id))
          .catch(() => {})
      }
      const timer = setInterval(flush, 300)

      const done = (async () => {
        try {
          const result = await deps.runner.run({
            project,
            repo,
            deployment,
            commitSha,
            signal: controller.signal,
            onLog: (chunk) => {
              buffer += chunk.text
            },
            // Written straight through, not buffered like the log. There are
            // four phase boundaries in a build against thousands of log
            // chunks, so the batching that keeps the log off the single
            // SQLite connection would buy nothing here and would risk the
            // final phase never landing if a build ends between flushes.
            onSteps: (steps) => {
              stepWrites = stepWrites
                .then(() => deps.storage.updateDeployment(deployment.id, { steps }))
                .then(() => deps.onChange?.(deployment.id))
                .catch(() => {})
            },
          })
          clearInterval(timer)
          flush()
          await flushing
          await stepWrites
          if (result.ok) {
            await deps.storage.updateDeployment(deployment.id, {
              status: "deployed",
              // The RESOLVED sha, not the requested one: a branch build
              // creates its deployment before the clone knows what it is.
              ...(result.commitSha ? { commitSha: result.commitSha } : {}),
              ...(result.commitMessage ? { commitMessage: result.commitMessage } : {}),
              // Always written (even `null`/absent → `null`), same "always
              // record" rule the upload lane follows — see
              // `Deployment.warnings`'s doc comment.
              warnings: result.warnings ?? null,
            })
            await deps.storage.updateProject(projectId, { activeDeploymentId: deployment.id })
            // S5: the build lane leaked identically to the upload lane —
            // every push-triggered rebuild strands the previous deployment's
            // assets forever. Same asset-only, best-effort sweep as the
            // upload route.
            await pruneSupersededDeploymentAssets(deps.storage, deps.assets, projectId, deployment.id)
            deps.onChange?.(deployment.id)
          } else {
            await finish(deployment.id, "failed", "")
          }
        } catch (err) {
          // A throw here is a runner BUG (its contract is to return a failed
          // result, not reject). Without this the deployment would sit at
          // `building` forever and the project would be permanently
          // unbuildable, since `inFlight` is only cleared in the finally.
          clearInterval(timer)
          console.error(`[viewer] build queue caught a runner throw for ${deployment.id}:`, err)
          await finish(deployment.id, "failed", "\nBuild failed unexpectedly\n")
        } finally {
          clearInterval(timer)
          inFlight.delete(projectId)
        }
      })()

      inFlight.set(projectId, { deploymentId: deployment.id, controller, done })
      return deployment.id
    },

    activeDeploymentFor(projectId) {
      return inFlight.get(projectId)?.deploymentId
    },

    async shutdown() {
      // Without this a deployment interrupted by a restart stays `building`
      // forever — visible in the UI as a spinner that never resolves, and
      // blocking nothing (the in-memory lock died with the process) so the
      // state is purely misleading.
      const entries = [...inFlight.values()]
      for (const e of entries) e.controller.abort()
      await Promise.allSettled(entries.map((e) => e.done))
    },
  }
}
