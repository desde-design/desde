/**
 * `POST /projects/:id/deployments/build` — trigger a build of the connected
 * repository. Push-webhook triggering is Phase 3c-3; this is the manual lane.
 */
import { Router } from "express"
import type { AppDeps } from "../create-app"
import { requireProjectManage, requireProjectManageRead } from "../auth/authorize"
import { BuildInProgressError, BuildQueueFullError } from "../build/build-queue"

export function createBuildRoutes(deps: AppDeps): Router {
  const router = Router()

  router.post("/projects/:id/deployments/build", async (req, res) => {
    // Manage authority AND write scope. Starting a build mutates state (it
    // creates a deployment and can replace what is served at /p/{slug}/), so
    // it takes the mutating gate — Phase 3b-2's rule that scope is checked
    // wherever a credential authorizes a mutation, not only where the gate
    // happened to change. `requireProjectManage` also gives the 404 (never
    // 403) for a project the caller cannot read.
    const project = await requireProjectManage(deps, req, res, String(req.params.id), "trigger a build")
    if (!project) return

    // Read into a local before the awaits below — `buildQueue` is a mutable
    // field on the runtime (`github-runtime.ts`), so neither the narrowing nor
    // the value survives an await. Starting a build on a queue that has since
    // been replaced is the concrete failure: the old queue's shutdown would
    // mark the deployment failed under a caller that was just told 202.
    const buildQueue = deps.github.buildQueue
    if (!buildQueue) {
      res.status(503).json({ error: "Builds are not enabled on this deployment" })
      return
    }
    if (!project.repoConfig) {
      res.status(400).json({ error: "Connect a GitHub repository before building" })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const raw = body.commitSha
    // Reject rather than coerce: a malformed sha reaching the runner becomes
    // a `git fetch` argument. 3c-1 established the same posture for `branch`.
    if (raw !== undefined && (typeof raw !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw))) {
      res.status(400).json({ error: "commitSha must be a hex commit sha" })
      return
    }
    const commitSha = typeof raw === "string" ? raw : null

    try {
      const deploymentId = await buildQueue.start(project.id, commitSha)
      res.status(202).json({ deploymentId, status: "building" })
    } catch (error) {
      if (error instanceof BuildInProgressError) {
        // 409 with the id of the build already running — the caller almost
        // always wants to watch that one rather than be told only "no".
        res.status(409).json({
          error: "A build is already running for this project",
          deploymentId: error.deploymentId,
        })
        return
      }
      if (error instanceof BuildQueueFullError) {
        // K01: distinct from "builds not enabled" (503 above) and from a
        // same-project conflict (409 above) — this is transient global
        // capacity, so 503 with a message that says to retry rather than a
        // deploymentId that doesn't exist yet.
        res.status(503).json({ error: error.message })
        return
      }
      console.error(`[viewer] could not start build for project ${project.id}:`, error)
      res.status(500).json({ error: "Could not start the build" })
    }
  })

  /**
   * SSE stream of a deployment's build log.
   *
   * Follows `comments-routes.ts`'s stream handler exactly, including the
   * `closed` flag registered BEFORE the first await — a client can
   * disconnect during that await, and without the flag the handler would go
   * on to subscribe and start a heartbeat for a connection that will never
   * clean them up (a leaked listener plus a repeating timer per request).
   * `cleanup()` is idempotent so more than one path may reach it.
   */
  router.get("/deployments/:id/log/stream", async (req, res) => {
    let closed = false
    let unsubscribe: (() => void) | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const cleanup = (): void => {
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
    req.on("close", () => {
      closed = true
      cleanup()
    })
    res.on("error", () => {})

    const deploymentId = String(req.params.id)
    const deployment = await deps.storage.getDeployment(deploymentId)
    if (closed) return
    // S7: manage AUTHORITY, not merely project-read. A build log can carry
    // the operator's install/build command line and the full stdout/stderr of
    // a private repo's toolchain — a much higher-trust artifact than "this
    // project is readable", which on a public-link project is true for an
    // anonymous caller. 404 for "doesn't exist or isn't readable at all", 403
    // for "readable but you may not manage it", without a separate lookup.
    //
    // `requireProjectManageRead`, NOT `requireProjectManage`, and the
    // difference is load-bearing rather than stylistic. This route is a GET;
    // the identical bytes are also served as `Deployment.buildLog` by `GET
    // /projects/:id/deployments`, which is scope-blind like every read path.
    // Gating this one on `write` scope therefore refused a read-scoped PAT
    // here while the list handed that same caller the same log — a gate that
    // gated nothing. The two must agree, so scope follows the VERB (this
    // mutates nothing, so it does not ask) and authority follows the ROLE
    // (both check `hasProjectManageAuthority`). The manual "trigger a build"
    // route ABOVE does mutate, and keeps the write-scoped guard.
    const project = deployment
      ? await requireProjectManageRead(deps, req, res, deployment.projectId, "view the build log")
      : null
    if (closed) return
    if (!deployment) {
      res.status(404).json({ error: "Deployment not found" })
      return
    }
    if (!project) return

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()

    let sentBytes = 0
    const send = async (): Promise<void> => {
      const current = await deps.storage.getDeployment(deploymentId)
      if (closed || !current) return
      // Send only what is NEW. Re-sending the whole log on every tick would
      // make a long build quadratic in bytes over the wire, and the client
      // would have to diff it to render an append.
      if (current.buildLog.length > sentBytes) {
        const delta = current.buildLog.slice(sentBytes)
        sentBytes = current.buildLog.length
        res.write(`event: log\ndata: ${JSON.stringify({ text: delta })}\n\n`)
      }
      if (current.status !== "building") {
        res.write(
          `event: done\ndata: ${JSON.stringify({
            status: current.status,
            commitSha: current.commitSha,
            warnings: current.warnings,
          })}\n\n`,
        )
        cleanup()
        res.end()
      }
    }

    unsubscribe = deps.buildChangeBus?.subscribe(deploymentId, () => void send()) ?? null
    // Comment SSE proved this necessary: without a heartbeat an idle stream
    // is indistinguishable from a dead one to any proxy in between.
    heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n")
    }, 25_000)
    await send()
  })

  return router
}
