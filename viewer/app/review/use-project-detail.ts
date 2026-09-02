"use client"

import { useEffect, useState } from "react"
import { failureMessage, fetchJson } from "../api-client"
import type { DeploymentWarning } from "../build-log-utils"

/**
 * The subset of `ProjectView` (`server/api/projects-routes.ts`) the review
 * rail reads. Declared narrowly rather than importing the server type: that
 * module pulls in `node:` imports no browser bundle can follow, and a wide
 * type here would invite rendering a field that is owner-gated on the wire.
 *
 * `repoConfig` and `repoUrl` are OMITTED — not nulled — for a caller who is
 * not an owner or admin. That is why both are optional, and why "absent"
 * must never be rendered as "this project has no repository": it routinely
 * means "not shown to you". `repoConfig` also carries the GitHub App
 * installation id and the raw install/build command line (security audit
 * S2), so only `owner`, `name` and `branch` are named here — a field this
 * type does not mention is a field no panel can accidentally render.
 */
export interface ProjectDetail {
  /** Which deployment is actually being served — the "Live" marker keys on it. */
  activeDeploymentId?: string | null
  activeDeployment?: {
    status: "building" | "deployed" | "failed"
    createdAt: string
    /** Deploy-time warnings — see the server's `ActiveDeploymentView.warnings`
     * for why these, unlike `commitSha`/`buildLog`, go to every reader. The
     * shell renders the root-absolute one above the rail tabs. */
    warnings?: DeploymentWarning[] | null
  } | null
  repoConfig?: {
    owner: string
    name: string
    branch: string
  } | null
  repoUrl?: string | null
  /**
   * Whether THIS caller may write comments here. Computed by the server, not
   * derived in the browser: an anonymous visitor cannot read the instance
   * setting it depends on, and this repo has shipped the same defect three
   * times by having the client reason about auth from a narrower flag than it
   * looked. Absent (an older server, or the fetch still in flight) is treated
   * as `true` by the shell, which is what the product has always done.
   */
  canComment?: boolean
}

export interface UseProjectDetailResult {
  detail: ProjectDetail | null
  error: string | null
}

/**
 * Loads the project record the review rail's Info and Dev tabs both need.
 *
 * Called ONCE, by the shell, and the result passed down as props — rather
 * than by each panel. Radix unmounts an inactive `TabsContent`, so a
 * per-panel fetch would re-run on every tab switch, and the two panels would
 * each hold their own copy of the same record with no guarantee they agree.
 */
export function useProjectDetail(projectId: string): UseProjectDetailResult {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJson<ProjectDetail>(`/api/v1/projects/${projectId}`)
      .then((data) => {
        if (!cancelled) setDetail(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(failureMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return { detail, error }
}

/**
 * The repo coordinates a source link needs, or `null` when the caller was
 * not shown a repo config.
 *
 * Links point at the BRANCH, not at the built commit. The built commit would
 * be more precise — it is what the reviewer is actually looking at — but the
 * deployment's `commitSha` is deliberately not on the wire (see
 * `ProjectView.activeDeployment`), and widening the public projection just
 * to build a link is the wrong trade. A branch link always resolves.
 */
export function repoSourceBase(detail: ProjectDetail | null): {
  htmlUrl: string
  /** The git ref to link against — the built branch. See the note above. */
  ref: string
} | null {
  const repo = detail?.repoConfig
  if (!repo) return null
  return { htmlUrl: `https://github.com/${repo.owner}/${repo.name}`, ref: repo.branch }
}
