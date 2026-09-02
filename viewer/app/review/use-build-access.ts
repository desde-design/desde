"use client"

import { useEffect, useState } from "react"
import { useCurrentUser } from "../use-current-user"
import { canManageProjects } from "../instance-role"
import { parseInstallationsResponse } from "../project-repo-utils"

/**
 * The two facts the Deployments tab needs: may this person build, and can this
 * deployment build at all.
 *
 * It exists because the build controls now live on the Deployments tab rather
 * than in the repo settings dialog, and deriving who may build in a second
 * place is the kind of thing that drifts apart. That objection is answered by
 * WHERE the rule lives, not by refusing the second surface: the rule is
 * `buildBlockedReason` in `build-log-utils.ts`, and both surfaces feed it.
 *
 * **Who may manage (viewer-membership): the caller's INSTANCE role — `admin`
 * or `editor` — not project membership.** Being on this review page means the
 * caller can already READ the project; an Editor or Admin who can read it can
 * manage it (`canManageProjects`, mirroring the server's
 * `hasProjectManageAuthority`). A Viewer, or a signed-out visitor, cannot.
 *
 * The installations fetch degrades to the CLOSED answer: a failed load leaves
 * `buildsEnabled` false, so Build stays out rather than appearing for a
 * deployment the server has no App configured on.
 */
export interface BuildAccess {
  /** The caller's instance role permits managing this project. Gates Upload, and Build with it. */
  canManage: boolean
  /** A GitHub App is configured on this deployment. Gates Build. */
  buildsEnabled: boolean
  /** Still resolving. Callers render nothing rather than flashing a wrong state. */
  loading: boolean
}

export function useBuildAccess(): BuildAccess {
  const { user, loading: userLoading } = useCurrentUser()
  const canManage = canManageProjects(user?.role)
  const [buildsEnabled, setBuildsEnabled] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (userLoading) return

    // Signed out: nothing to ask the server, but the answer still has to
    // settle so callers stop rendering the loading state. Resolved through
    // the same promise as the fetch, because `setState` straight from an
    // effect body is a cascading render the lint rule (rightly) refuses.
    if (!user) {
      void Promise.resolve().then(() => {
        if (cancelled) return
        setBuildsEnabled(false)
        setResolved(true)
      })
      return () => {
        cancelled = true
      }
    }

    void fetch("/api/v1/github/installations")
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((installationsBody) => {
        if (cancelled) return
        setBuildsEnabled(installationsBody ? parseInstallationsResponse(installationsBody).configured : false)
        setResolved(true)
      })

    return () => {
      cancelled = true
    }
  }, [user, userLoading])

  return { canManage, buildsEnabled, loading: userLoading || !resolved }
}
