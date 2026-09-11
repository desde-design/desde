"use client"

/**
 * What a project that has never been built shows on its own review route.
 *
 * Before 2026-09-01 this state had no page. `resolveReviewProject` returned
 * the same `null` for "you may not see this" and "nobody has built it yet",
 * so the route 404'd, and the dashboard compensated by rendering the card as
 * a DISABLED control. Mo's objection is the reason this file exists: a
 * disabled card reads as a permissions problem, when the truth is simply that
 * there is nothing here yet. Those are different messages and we were sending
 * the wrong one.
 *
 * **It is also where the first build is watched** (Mo, 2026-09-10). A first
 * connect starts building on the server, and the Add dialog sends the reader
 * here. This page is the only place that can show that build: the review
 * screen and its Deploy button need a FINISHED build to open. So a manager
 * sees the build running, a failure with a way to try again, or Deploy for a
 * connected repository that has no build. Both build states offer the log as
 * a button beside the other actions, and it opens in a modal (Mo,
 * 2026-09-11); it used to sit under them as a collapsible block. When
 * the build this page watched succeeds, the page reloads into the review
 * screen. Which of those shows is `decideNeverDeployedView`, pure and tested.
 *
 * **The actions are gated, the page is not.** Anyone who can read the project
 * reaches this page; only someone who can actually fix it is offered the way
 * to. The role alone answers that, so the gate asks `useCurrentUser` and
 * nothing else, and renders no action while that is still loading so a Viewer
 * never sees a button appear and then leave. A Viewer gets none of the build
 * view either: the log stream refuses them, so its hooks are never mounted
 * for them.
 *
 * No "Back to projects" button (Mo, 2026-09-10). The wordmark in the header
 * already goes there, on every full-page surface.
 */

import { useEffect, useState, type ReactNode } from "react"
import { Plug, Rocket, ScrollText } from "lucide-react"
import { AppHeader, Callout, EmptyState, ProjectLoader } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AccountMenu } from "../../account-menu"
import { GithubAppUnreachableBanner } from "../../github-app-unreachable-banner"
import { canManageProjects } from "../../instance-role"
import { LoadFailure } from "../../load-failure"
import { useCurrentUser } from "../../use-current-user"
import { useBuildAccess } from "../use-build-access"
import { useBuildControls } from "../use-build-controls"
import { useProjectDetail } from "../use-project-detail"
import { decideNeverDeployedView } from "./never-deployed-view"
import type { ProjectSummary } from "./page"

export function NeverDeployed({ project }: { project: ProjectSummary }) {
  // `useCurrentUser` directly, NOT `useBuildAccess`. That hook's `loading`
  // stays true until a `listInstallations()` request to GitHub resolves, and
  // the gate here asks only whether this reader may manage projects, which
  // their role already answers. Gating on the hook meant a slow or hanging
  // GitHub call hid the action from an Editor whose role was known all along.
  // Found by a codex review.
  const { user, loading } = useCurrentUser()
  const canManage = canManageProjects(user?.role)

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      {/* Same shell as the settings route, which is the other full-page
          surface outside the review iframe. `href="/"` so the wordmark goes
          back to the dashboard. */}
      <AppHeader href="/">
        <AccountMenu size="icon" />
      </AppHeader>

      {!loading && canManage ? <FirstBuild project={project} /> : <NeverDeployedMessage />}
    </div>
  )
}

/**
 * The manager's view: which of the build states applies, and its action.
 * Its own component so the build hooks mount only for a manager.
 */
function FirstBuild({ project }: { project: ProjectSummary }) {
  const { detail, error: detailError } = useProjectDetail(project.id)
  const access = useBuildAccess()
  const repo = detail?.repoConfig ?? null
  const build = useBuildControls({
    projectId: project.id,
    hasRepo: repo !== null,
    canManage: true,
    buildsEnabled: access.buildsEnabled,
  })
  const latestStatus = build.deployment?.status ?? null

  // Set once, and never cleared: see `NeverDeployedInput.sawBuilding`.
  // Adjusted during render rather than in an effect, which is React's own
  // shape for remembering something from an earlier render.
  const [sawBuilding, setSawBuilding] = useState(false)
  if (latestStatus === "building" && !sawBuilding) setSawBuilding(true)

  const view = decideNeverDeployedView({
    detailLoaded: detail !== null,
    detailFailed: detailError !== null,
    hasRepo: repo !== null,
    // Who may build is part of "loaded": until it answers, `buildsEnabled`
    // reads false and Deploy would flash a reason that is not true.
    deploymentsLoaded: build.loaded && !access.loading,
    latestStatus,
    sawBuilding,
  })

  const shouldReload = view.kind === "deployed" && view.reload
  useEffect(() => {
    // The server page resolves an active deployment now, so the same URL
    // renders the review screen.
    if (shouldReload) window.location.reload()
  }, [shouldReload])

  switch (view.kind) {
    case "wait":
      return <ProjectLoader size={80} label="Loading" className="flex-1 pb-20" />
    case "load-failed":
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <LoadFailure title="Couldn't load the prototype" description={detailError ?? ""} />
        </div>
      )
    case "connect":
      return (
        <NeverDeployedMessage>
          {/* The dashboard's existing `?connect=<id>` parameter, which
              reopens the very wizard the project card resumes, rather than a
              second entry point into it. */}
          <Button asChild size="sm">
            <a href={`/?connect=${encodeURIComponent(project.id)}`}>
              <Plug />
              Connect a repository
            </a>
          </Button>
        </NeverDeployedMessage>
      )
    case "deploy":
      return (
        <PageMessage
          title="Not built yet"
          description={repo ? `Deploy builds it from ${repo.owner}/${repo.name}, branch ${repo.branch}.` : undefined}
          notice={
            !access.buildsEnabled ? (
              <GithubAppUnreachableBanner />
            ) : build.error ? (
              <Callout tone="destructive">{build.error}</Callout>
            ) : null
          }
        >
          <DeployButton label="Deploy" build={build} />
        </PageMessage>
      )
    case "building":
      /* The spinning cat in a box (Mo, 2026-09-10), the same wait every
         other surface shows, rather than the empty state's still picture:
         something is happening. No label under it (Mo, same day): the
         sentence below already says what is happening. The log button sits
         under that, alone on the action row. */
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 pb-20">
          <ProjectLoader size={80} />
          <p className="max-w-md text-center text-sm text-muted-foreground">
            The first build is running. The prototype opens here when it finishes.
          </p>
          {build.log ? (
            <div className="flex items-center gap-2">
              <BuildLogButton log={build.log} />
            </div>
          ) : null}
        </div>
      )
    case "failed":
      return (
        <PageMessage
          tone="failure"
          title="Build failed"
          description="The build did not finish. The log shows why."
          notice={build.error ? <Callout tone="destructive">{build.error}</Callout> : null}
        >
          <DeployButton label="Try again" build={build} />
          {build.log ? <BuildLogButton log={build.log} /> : null}
        </PageMessage>
      )
    case "deployed":
      // Reloading: say so rather than flash the finished state first.
      if (view.reload) return <ProjectLoader size={80} label="Opening" className="flex-1 pb-20" />
      return (
        <PageMessage title="Built" description="The build finished.">
          <Button asChild size="sm">
            <a href={`/review/${encodeURIComponent(project.slug)}`}>Open the prototype</a>
          </Button>
        </PageMessage>
      )
  }
}

/**
 * The page's one message, centred, with an action row. `notice` sits above
 * the actions.
 */
function PageMessage({
  title,
  description,
  tone,
  notice,
  children,
}: {
  title: string
  description?: string
  tone?: "empty" | "failure"
  notice?: ReactNode
  children: ReactNode
}) {
  return (
    /* `description` rather than a child: children are the ACTION slot, and
       the block spaces title/description tightly and then the action row
       apart from both. Passing the sentence as a child put it on the same
       line as the buttons. */
    <EmptyState size="sm" frame="page" tone={tone} title={title} description={description}>
      <div className="flex w-full max-w-2xl flex-col items-center gap-4">
        {notice ? <div className="w-full">{notice}</div> : null}
        <div className="flex items-center gap-2">{children}</div>
      </div>
    </EmptyState>
  )
}

/**
 * The copy is deliberately the same pair the deployments panel uses for this
 * state (`../deployments-panel.tsx`). One state, one wording, in both places
 * it can be met.
 */
function NeverDeployedMessage({ children }: { children?: ReactNode }) {
  return (
    <EmptyState size="sm" frame="page" title="Never deployed" description="Every build will be listed here.">
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </EmptyState>
  )
}

function DeployButton({
  label,
  build,
}: {
  label: string
  build: ReturnType<typeof useBuildControls>
}) {
  return (
    <Button
      size="sm"
      onClick={() => void build.startBuild()}
      disabled={Boolean(build.blocked)}
      busy={build.starting}
      title={build.blocked ?? undefined}
      data-testid="first-deploy-button"
    >
      {/* Spinner OR rocket, never both: `busy` prepends the spinner. */}
      {build.starting ? null : <Rocket />}
      {label}
    </Button>
  )
}

/**
 * The build's log, behind an outline button on the action row that opens it
 * in a modal (Mo, 2026-09-11). Outline, not primary: Try again is the
 * action on the failed screen, and the log is what you read before taking
 * it. The modal reads `log` on every render, so it keeps up with a build
 * that is still writing while it is open. Same `pre` as the deployment
 * detail dialog, so a log looks the same in both places it can be read.
 */
function BuildLogButton({ log }: { log: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="build-log-button">
        <ScrollText />
        Build log
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="2xl" data-testid="build-log-dialog">
          <DialogHeader>
            <DialogTitle>Build log</DialogTitle>
            <DialogDescription>Everything the build printed, newest at the bottom.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-code whitespace-pre-wrap break-words text-foreground">
            {log}
          </pre>
          <DialogFooter>
            <Button size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
