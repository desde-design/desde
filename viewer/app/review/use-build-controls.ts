"use client"

import { useCallback, useEffect, useState } from "react"
import {
  appendLogDelta,
  buildBlockedReason,
  isDeploymentView,
  type DeploymentView,
} from "../build-log-utils"

/**
 * Everything the Deploy control needs, minus the markup.
 *
 * Lifted out of the old `app/build-panel.tsx` (deleted 2026-08-21) because the button and the
 * build status stopped being neighbours. Mo: "Deploy button should be in the
 * same section as the Repo and Branch, not in the deployment itself." Two
 * places in one panel now read this state, and a component cannot hand its
 * own state to a sibling.
 *
 * The log streaming, the 409 handling and the sticky-refresh behaviour moved
 * verbatim — this is a relocation, not a rewrite, and the comments explaining
 * each hard-won detail came with it.
 */
export interface BuildControlsInput {
  projectId: string
  /** A GitHub repo is connected, so there is something to build FROM. */
  hasRepo: boolean
  /** Whether the current caller can manage this project — an Editor or Admin who can read it. */
  canManage: boolean
  buildsEnabled: boolean
}

export interface BuildControls {
  /** The newest deployment, or null before one loads. */
  deployment: DeploymentView | null
  /** Its log, appended live while a build streams. */
  log: string
  /** A failed start, in the reader's terms. */
  error: string | null
  /** The POST is in flight. */
  starting: boolean
  /** A build is running right now. */
  isBuilding: boolean
  /** Why Deploy cannot run, or null when it can. */
  blocked: string | null
  startBuild: () => Promise<void>
  /** Re-read the newest deployment, after an upload. */
  reload: () => Promise<void>
}

export function useBuildControls({
  projectId,
  hasRepo,
  canManage,
  buildsEnabled,
}: BuildControlsInput): BuildControls {
  const [deployment, setDeployment] = useState<DeploymentView | null>(null)
  const [log, setLog] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const isBuilding = deployment?.status === "building"

  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/deployments`)
      if (!res.ok) return
      const body: unknown = await res.json()
      const list = (body as { deployments?: unknown }).deployments
      const latest = Array.isArray(list) ? list.find(isDeploymentView) : undefined
      if (latest) {
        setDeployment(latest)
        setLog(latest.buildLog ?? "")
      }
    } catch {
      // A failed refresh leaves the last known state on screen rather than
      // blanking it — the same "sticky load error" rule the comments rail
      // needed after it blanked itself on a transient failure.
    }
  }, [projectId])

  useEffect(() => {
    void loadLatest()
  }, [loadLatest])

  // Follow the log while a build is running.
  useEffect(() => {
    if (!deployment || deployment.status !== "building") return
    const es = new EventSource(`/api/v1/deployments/${deployment.id}/log/stream`)
    // The server's `sentBytes` counter (build-routes.ts) is per-CONNECTION,
    // not per-deployment: a fresh EventSource always starts at 0 and its
    // first `log` event carries the ENTIRE log accumulated so far, not a
    // true delta. That's correct for a first mount (state starts empty,
    // "append the whole thing" is right), but `es.onerror` reconnects by
    // calling `loadLatest()` — which already synced `log` to the current
    // full log via `setLog(latest.buildLog)` — and re-opening the stream
    // (this effect keys on `deployment`, and `loadLatest`'s `setDeployment`
    // is a new object each time, so identity-driven re-runs happen). Without
    // this flag, the reconnected stream's first event would append that same
    // full log a second time. Only the first event of THIS connection is a
    // replace; every event after it is a genuine incremental delta.
    let receivedFirstEvent = false
    es.addEventListener("log", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { text?: string }
      if (typeof data.text !== "string") return
      if (!receivedFirstEvent) {
        receivedFirstEvent = true
        setLog(data.text)
      } else {
        setLog((prev) => appendLogDelta(prev, data.text as string))
      }
    })
    es.addEventListener("done", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status?: string
        commitSha?: string | null
        warnings?: DeploymentView["warnings"]
      }
      setDeployment((prev) =>
        prev
          ? {
              ...prev,
              status: data.status === "deployed" ? "deployed" : "failed",
              commitSha: data.commitSha ?? prev.commitSha,
              warnings: data.warnings !== undefined ? data.warnings : prev.warnings,
            }
          : prev,
      )
      es.close()
    })
    es.onerror = () => {
      // The stream ends normally when a build finishes, and EventSource
      // reports that as an error. Re-read the row instead of showing a
      // failure the user cannot act on.
      es.close()
      void loadLatest()
    }
    return () => {
      es.close()
    }
  }, [deployment, loadLatest])

  const blocked = buildBlockedReason({ canManage, hasRepo, buildsEnabled, isBuilding: Boolean(isBuilding) })

  async function startBuild() {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/deployments/build`, { method: "POST" })
      const body: unknown = await res.json().catch(() => ({}))
      if (res.status === 409) {
        // The server hands back the id of the build already running, so the
        // user can watch that one instead of just being told "no".
        const id = (body as { deploymentId?: unknown }).deploymentId
        if (typeof id === "string") {
          setLog("")
          setDeployment({ id, status: "building", commitSha: null, buildLog: "", warnings: null, createdAt: "" })
        }
        return
      }
      if (!res.ok) {
        setError((body as { error?: string }).error ?? "Could not start the build")
        return
      }
      const id = (body as { deploymentId?: unknown }).deploymentId
      if (typeof id === "string") {
        setLog("")
        setDeployment({ id, status: "building", commitSha: null, buildLog: "", warnings: null, createdAt: "" })
      }
    } catch {
      setError("Could not reach the server")
    } finally {
      setStarting(false)
    }
  }

  return {
    deployment,
    log,
    error,
    starting,
    isBuilding: Boolean(isBuilding),
    blocked,
    startBuild,
    reload: loadLatest,
  }
}
