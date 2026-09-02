"use client"

import { useCallback, useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/blocks"
import { LoadFailure } from "../load-failure"
import { failureMessage } from "../api-client"
import { useCurrentUser } from "../use-current-user"
import { parseInstallationsResponse } from "../project-repo-utils"
import { GithubAppSetupCard } from "../github-app-setup-card"

/**
 * Settings › GitHub (admin section) — the proactive home of the GitHub App,
 * replacing the deleted `/setup` page. Configured: which App this deployment
 * builds through, with links at THAT App on GitHub. Not configured: the
 * `GithubAppSetupCard`, the same flow the connect-repo wizard embeds.
 *
 * Admin-only as a UX courtesy, same as `InstanceSettingsPanel` — the real
 * gates are server-side (`requireOperator` on the manifest routes; the
 * installations route answers any signed-in caller, but only with their own
 * installation set).
 */
export function GithubPanel() {
  const { user, loading } = useCurrentUser()
  if (loading || user?.role !== "admin") return null
  return <AdminGithubPanel />
}

interface GithubAppView {
  configured: boolean
  appSlug: string | null
}

function AdminGithubPanel() {
  const [app, setApp] = useState<GithubAppView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/github/installations")
      if (!res.ok) throw new Error(`GET /api/v1/github/installations ${res.status}`)
      const parsed = parseInstallationsResponse(await res.json())
      setApp({ configured: parsed.configured, appSlug: parsed.appSlug })
      setLoadError(null)
    } catch (err) {
      setLoadError(failureMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <SettingsSection
      frame="bare"
      title="GitHub"
      /* No section description in EITHER state (Mo, 2026-08-31: "no need
         for the 2 different font size"): the not-configured state's setup
         card carries its own intro, and the configured state's body now
         opens with the defining sentence at the body size. */
    >
      {loadError && app === null ? (
        <LoadFailure size="sm" title="Couldn't check the GitHub App" description={loadError} />
      ) : app === null ? (
        <p className="text-xs text-muted-foreground">Checking the GitHub App</p>
      ) : app.configured ? (
        <ConfiguredApp appSlug={app.appSlug} />
      ) : (
        <GithubAppSetupCard />
      )}
    </SettingsSection>
  )
}

function ConfiguredApp({ appSlug }: { appSlug: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      {/*
        Says what the grant IS, and recommends the account-wide choice with
        the reason (Mo, 2026-08-26: "Org or account wide, not per repo").

        GitHub asks the installer to pick "All repositories" or a list, and an
        App cannot choose for them — the manifest declares what KIND of access
        it wants (`default_permissions`), never which repositories. So the
        only lever here is telling the operator which option to take and why.

        Both claims below are checked, not reassurance:

        - Read-only is the literal manifest: `contents: read` and
          `emails: read`, and nothing else (`api/setup-routes.ts`).
        - Account-wide does not widen what anyone SEES. Every repo list is
          intersected with the caller's own GitHub access
          (`github/caller-installations.ts`, security audit B4), so granting
          the App an org does not let a member browse repos they could not
          already reach.
      */}
      {/* One size, full foreground (Mo, 2026-08-31: "just use one font size,
          larger and darker one", then "no need for the 2 different font
          size"): the defining sentence opens the body on its own line
          instead of sitting in the muted section description. The manifest
          detail ("reads file contents and email addresses, can change
          nothing") compressed to "read-only" — the checked claim above is
          unchanged, only the wording shrank. */}
      <p className="text-base">
        A GitHub App connects this viewer to GitHub. It handles sign-in, reading repositories, and
        rebuilding on push.
      </p>
      <p className="text-base">
        {appSlug ? (
          <>
            Connected through the GitHub App <span className="font-medium">{appSlug}</span>, with
            read-only access to the repositories it is granted.{" "}
          </>
        ) : (
          <>A GitHub App is configured, with read-only access to the repositories it is granted. </>
        )}
        Granting a whole account or organization covers new repositories automatically, and each
        person still only sees the repositories they have access to.
      </p>
      {appSlug ? (
        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <a
              href={`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`}
              target="_blank"
              rel="noreferrer"
            >
              Grant repo access <ExternalLink />
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a
              href={`https://github.com/apps/${encodeURIComponent(appSlug)}`}
              target="_blank"
              rel="noreferrer"
            >
              View the App on GitHub <ExternalLink />
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
