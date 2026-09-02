"use client"

import { useEffect, useState } from "react"
import { Rocket } from "lucide-react"
import { EmptyState, ProjectLoader, StatusPill } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { LoadFailure } from "../load-failure"
import { GithubAppUnreachableBanner } from "../github-app-unreachable-banner"
import { formatRelativeTime } from "@/lib/relative-time"
import { failureMessage, fetchJson } from "../api-client"
import { isDeploymentView, presentStatus, type DeploymentView } from "../build-log-utils"
import { repoSourceBase, type ProjectDetail } from "./use-project-detail"
import { useBuildAccess } from "./use-build-access"
import { DeploymentDetailDialog } from "./deployment-detail-dialog"
import { Callout } from "@/components/blocks"
import { UploadBundleDialog } from "../upload-bundle-dialog"
import { useBuildControls } from "./use-build-controls"

export interface DeploymentsPanelProps {
  projectId: string
  /** Loaded once by the shell — see `useProjectDetail`. */
  detail: ProjectDetail | null
  /** The project fetch's failure, if it failed. */
  error: string | null
  className?: string
}

/**
 * "Deployments" — every build of this prototype, newest first, and the
 * repository they came from.
 *
 * This tab was called "Info" and also carried the current page's route and
 * source file. Both moved into the rail header on 2026-08-19 (Mo's call),
 * where they show on every tab rather than only on this one — the right home
 * for them, since "which page am I looking at" is context, not a topic.
 *
 * It also carries the controls that START a build: Deploy, and Upload a
 * build. They moved here on 2026-08-21 when Mo asked for settings to hold no
 * build info and no way to build, which left them with nowhere to be. This is
 * the right home anyway — the tab is already about deployments, so the button
 * that makes one belongs beside the list of them, and the original Desde
 * viewer put its Deploy button in the same relationship to its repo row.
 *
 * This file used to carry a comment refusing that mount, on the grounds that
 * "deriving who may build in a second place is exactly the kind of thing that
 * drifts apart". That objection is answered by WHERE the rule lives, not by
 * refusing the mount: the rule is `buildBlockedReason` in
 * `build-log-utils.ts`, and every surface feeds it. `useBuildAccess` derives
 * who may manage from the caller's instance role (`canManageProjects`), the
 * same predicate the repo panel and the server's `hasProjectManageAuthority`
 * use, so the surfaces cannot disagree about who may build.
 */
export function DeploymentsPanel({
  projectId,
  detail,
  error,
  className,
}: DeploymentsPanelProps) {
  const [deployments, setDeployments] = useState<DeploymentView[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const buildAccess = useBuildAccess()
  const [uploadOpen, setUploadOpen] = useState(false)
  const [openDeploymentId, setOpenDeploymentId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJson<unknown>(`/api/v1/projects/${projectId}/deployments`)
      .then((body) => {
        if (cancelled) return
        // The route answers `{ deployments: [...] }`. Filtered through the
        // shared type guard rather than cast, because `buildLog` is omitted
        // for a non-owner (security audit S7) — so the shape genuinely varies
        // by caller, and an unchecked cast would be a lie about it.
        const raw = (body as { deployments?: unknown })?.deployments
        setDeployments(Array.isArray(raw) ? raw.filter(isDeploymentView) : [])
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(failureMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const repo = detail?.repoConfig ?? null
  const base = repoSourceBase(detail)
  const build = useBuildControls({
    projectId,
    hasRepo: repo !== null,
    canManage: buildAccess.canManage,
    buildsEnabled: buildAccess.buildsEnabled,
  })

  /**
   * Re-read the list when a live build finishes.
   *
   * The rows are whatever `/deployments` returned when the tab opened, and
   * nothing else re-reads them. Before this, a build you started here
   * completed, the live block unmounted, and the list underneath still said
   * "Building" until you switched tabs and back — the one moment the panel
   * is being watched is the one moment it went stale.
   *
   * Keyed on the STATUS rather than the deployment object: the hook replaces
   * that object on every poll, so an identity-keyed effect would refetch in a
   * loop.
   */
  const liveStatus = build.deployment?.status
  useEffect(() => {
    // "building" refreshes too (Mo, 2026-08-30): the separate live-build
    // block is gone, so the running build has to appear as its own card the
    // moment it starts, not only once it settles.
    if (liveStatus !== "building" && liveStatus !== "deployed" && liveStatus !== "failed") return
    let cancelled = false
    fetchJson<unknown>(`/api/v1/projects/${projectId}/deployments`)
      .then((body) => {
        if (cancelled) return
        const raw = (body as { deployments?: unknown })?.deployments
        setDeployments(Array.isArray(raw) ? raw.filter(isDeploymentView) : [])
      })
      .catch(() => {
        // Leave the last known list on screen. A stale row is better than an
        // empty panel after a build that actually succeeded.
      })
    return () => {
      cancelled = true
    }
  }, [liveStatus, projectId])


  return (
    /* `min-h-full` so the never-deployed empty state below can centre in the
       tab's height (its wrapper is `flex-1`); real content still grows past
       it and scrolls in the TabsContent as before. */
    <div className={cn("flex min-h-full flex-col", className)}>
      {/* Rendered only when the caller can actually see it. For a non-owner
          the server OMITS `repoConfig` entirely, and an "unknown" row would
          read as "this project has no repository" — a different and wrong
          claim. Silence is the honest projection of a field you were not
          shown. */}
      {/*
        The label/value recipe below is shared with the Inspect panel: rows
        ABUT and carry their own `py-0.5`, rather than being pushed apart by a
        gap on the container. Measured against Inspect before changing
        anything — it ran rows 0px apart with 2px of internal padding, this
        ran them 8px apart with none, and Mo's read was "I like the inspect
        panel better". A gap between the rows of one table makes two facts
        look like two sections.

        The SIZE stays `text-sm` where Inspect uses `text-xs`, and that is a
        deliberate split rather than a leftover (Mo, 2026-08-20): these two
        rows are the panel's standing header, read once on arrival, where
        Inspect's are thirty property rows you skim past. See docs/design.md,
        "Panel anatomy".
      */}
      {repo && base ? (
        /* No rule under this block (Mo, 2026-08-28). The deployment list
           below it is a bordered group of its own now, so the rule and that
           group's top edge were two lines saying the same thing, the same
           pair already removed under the comments filter. */
        <section className="flex flex-col px-2 py-2">
          {/*
            Repo and branch on the left, Deploy on the right (Mo,
            2026-08-28). It still acts on this repo at this branch — those two
            lines are its subject — but it no longer costs a third row to say
            so. `items-start` so a wrapped repo name grows downward and leaves
            the button on the first line, beside the thing it acts on.
          */}
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-baseline gap-2 py-0.5">
                <span className="w-14 flex-none text-sm text-muted-foreground">Repo</span>
                {/*
                  Foreground, and no glyph (Mo, 2026-08-21). It is a VALUE in
                  a label/value pair, sitting in a column with the branch
                  beside it, and teal made the one row that happens to be
                  clickable the loudest thing in the panel. The underline on
                  hover is the whole affordance it needs; a permanent
                  external-link icon states in every render something a
                  cursor states on demand.
                */}
                <a
                  href={base.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-sm text-foreground hover:underline"
                >
                  {repo.owner}/{repo.name}
                </a>
              </div>
              <div className="flex items-baseline gap-2 py-0.5">
                <span className="w-14 flex-none text-sm text-muted-foreground">Branch</span>
                <span className="min-w-0 truncate text-sm">{repo.branch}</span>
              </div>
            </div>
            {/*
              Nothing until access has SETTLED. `useBuildAccess` starts at
              `{ canManage: false, buildsEnabled: false }` and resolves a tick
              later, so rendering through the loading state showed a dead
              button explaining that you cannot manage this project, to
              someone who can. The old panel gated its whole self this way;
              the gate has to come with the button.
            */}
            {buildAccess.loading ? null : (
              /*
                Icon only, `icon-sm` (Mo, 2026-08-28). Square at 24px, the
                same height as the labelled `size="sm"` it replaces and as the
                header's own icon buttons, so the rail keeps one control
                height throughout.

                `default` while a build runs, matching how "Add comment" fills
                while placement is armed: colour and weight both carry the
                state, and the primary fill appears only while something is
                actually happening.

                Losing the word costs the blocked REASON its place beside the
                button, and that reason is not optional: "a control that does
                nothing with no explanation is the usual way this panel goes
                bad" (Mo, 2026-08-21). It moves to its own line under the
                pair, where it has the full width it never had squeezed
                against a button, and `title` carries it for anyone hovering
                the control itself.
              */
              <Button
                variant={build.starting || build.isBuilding ? "default" : "ghost"}
                size="icon-sm"
                className="flex-none"
                onClick={() => void build.startBuild()}
                disabled={Boolean(build.blocked)}
                busy={build.starting}
                aria-label={build.starting ? "Deploying" : "Deploy"}
                title={build.blocked ?? (build.starting ? "Deploying" : "Deploy")}
                data-testid="deploy-button"
              >
                {/* Spinner OR rocket, never both (Mo, 2026-08-30): `busy`
                    prepends the spinner, and on an icon-only button the two
                    glyphs said "in flight" twice. */}
                {build.starting ? null : <Rocket />}
              </Button>
            )}
          </div>
          {/* No caption line for the blocked reason (Mo, 2026-08-30): every
              cause has a better home. The role reason rides the disabled
              rocket's own `title`; a running build is its card in the list;
              the App-unreachable cause is the shared banner below; and
              no-repo never renders here, since this whole section is
              repo-gated. */}
          {!buildAccess.loading && !buildAccess.buildsEnabled ? (
            /* Only reachable with a repo attached — this whole section is
               repo-gated — which is exactly the state the banner describes:
               a connection that was made through an App this deployment no
               longer reaches. */
            <div className="mt-2">
              <GithubAppUnreachableBanner />
            </div>
          ) : null}
        </section>
      ) : null}

      {/*
        Upload a build, and ONLY when no repo is connected (Mo, 2026-08-21):
        "Projects should use one or the other. As soon as a github repo is
        connected, there is no need to allow for uploading."

        The two are different methods of getting a prototype in, not two
        buttons for one job. With a repo connected, uploading would publish a
        bundle the repo did not produce, and the next push would silently
        replace it — an outcome nobody could see coming from the button.

        So this is the escape hatch for the no-repo case, which is the case it
        exists for: on a deployment with no GitHub App there is no other way
        in at all.

        Only once deployments EXIST (Mo, 2026-08-30): for an upload-based
        project this row is the ongoing deploy control. Before the first
        deployment it duplicated the never-deployed empty state below — two
        blocks both saying "connect a repository", one of them ignoring
        upload — so there the empty state carries the one Set-up-a-deployment action instead.
      */}
      {!buildAccess.loading &&
      repo === null &&
      buildAccess.canManage &&
      deployments !== null &&
      deployments.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-border px-2 py-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => setUploadOpen(true)}
            data-testid="upload-a-build-button"
          >
            Upload a build
          </Button>
          <span className="min-w-0 text-xs text-muted-foreground">
            Or connect a repository to deploy from a branch.
          </span>
        </div>
      ) : null}

      {/* The root-absolute-asset warning moved OUT of this tab (Mo,
          2026-08-30): the shell renders it above the rail tabs, since "may
          not load fully" is about the prototype being reviewed, not about
          the deployment history. */}
      {build.error ? (
        <div className="px-2 py-2">
          <Callout tone="destructive">{build.error}</Callout>
        </div>
      ) : null}
      {/* No separate live-build block (Mo, 2026-08-30): a running build is
          its own card in the list — the start-refresh effect above puts the
          row there the moment the build starts — and its details are one
          click into that card. The pill-plus-streaming-log section here said
          the same thing a third time. */}

      <UploadBundleDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        projectId={projectId}
        onUploaded={() => void build.reload()}
      />

      {error ? (
        <LoadFailure size="sm" title="Couldn't load the project" description={error} />
      ) : listError ? (
        <LoadFailure size="sm" title="Couldn't load deployments" description={listError} />
      ) : deployments === null ? (
        /* Same wait as the Comments tab beside it: these two panels swap in
           the same rail, so a moving cat on one and a line of grey text on
           the other would read as two different surfaces. */
        <ProjectLoader size={80} label="Loading" className="py-6" />
      ) : deployments.length === 0 ? (
        /* `frame="panel"`, like the inspector's and the comment rail's empty
           states (Mo, 2026-08-30: "this empty state seems a little high —
           make sure it is consistent with the others"): centred in the
           tab's remaining height, not parked under the header. The wrapper
           supplies that height, since this panel has a header above and
           `h-full` alone would overflow past it.

           DEFENSIVE, not a designed destination (Mo, 2026-08-30, option
           2): the review page refuses a project with no active
           deployment (`resolveReviewProject`), and a never-deployed card
           on the dashboard resumes the Add wizard instead of opening
           review. A person can only meet this state if the deployments
           list answers empty for a page that just resolved an active
           deployment. It briefly carried call-to-action buttons; they were
           designed for a screen the product never routes to — exactly the
           gallery-vs-product drift this pass removes. */
        <div className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            size="sm"
            frame="panel"
            title="Never deployed"
            description="Every build will be listed here."
          />
        </div>
      ) : (
        /* The same bordered, rounded, 8px-inset group the comment list uses
           (Mo, 2026-08-28: "deployment cards should match the comment cards").
           These two lists have been built to one recipe since 2026-08-20 and
           the comment side moved first, so this is the other half of that
           change, not a new idea. `overflow-hidden` rounds the first row's top
           corners and the last row's bottom corners without either row knowing
           it is at an end. */
        <ul className="m-2 flex flex-col overflow-hidden rounded-md border border-border">
          {deployments.map((deployment) => {
            const status = presentStatus(deployment.status)
            return (
              /* Built to the comment rows' recipe (Mo, 2026-08-20): the
                 divider on the `<li>` rather than the row, the same
                 `px-3 py-2.5`, and the same two-line shape — what happened on
                 top with when it happened beside it, the detail underneath in
                 muted metadata. Two lists in one panel should not be two
                 different ideas of a list.

                 `last:border-b-0` because the group is bordered all round now:
                 the last divider and the group's own bottom edge would be two
                 lines 1px apart. */
              <li key={deployment.id} className="border-b border-border last:border-b-0">
                {/*
                  A button, because clicking a row opens its detail. That is
                  the original Desde viewer's shape (Mo, 2026-08-21): the
                  list carries a status, and the status is what you click to
                  find out what happened.

                  A `Button`, not a raw `<button>` (the lint rule is right).
                  `h-auto items-stretch whitespace-normal` is the same recipe
                  `CommentRow` uses in this rail to hold a multi-line block:
                  a Button centres and shrink-wraps by default, which would
                  undo the two-line row rather than making it clickable.
                */}
                <Button
                  variant="ghost"
                  onClick={() => setOpenDeploymentId(deployment.id)}
                  className="h-auto w-full flex-col items-stretch gap-1 rounded-none px-3 py-2.5 text-left whitespace-normal"
                  data-testid={`deployment-${deployment.id}`}
                >
                {/* Top line: status left, age right. The short sha and the
                    LIVE marker are both gone from the row (Mo, 2026-08-31):
                    neither identified anything the reader could act on here,
                    and the detail dialog still carries which build is being
                    served. */}
                <span className="flex items-center gap-2">
                  <StatusPill tone={status.tone} pulse={status.active} className="flex-none">
                    {status.label}
                  </StatusPill>
                  <span className="ml-auto flex-none text-xs text-muted-foreground">
                    {formatRelativeTime(deployment.createdAt)}
                  </span>
                </span>
                {/* The commit's own words, full width (an upload has none, so
                    the row stays single-line). */}
                {deployment.commitMessage ? (
                  <span className="min-w-0 truncate text-xs text-foreground">
                    {deployment.commitMessage}
                  </span>
                ) : null}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <DeploymentDetailDialog
        deployment={deployments?.find((d) => d.id === openDeploymentId) ?? null}
        isLive={openDeploymentId === detail?.activeDeploymentId}
        onClose={() => setOpenDeploymentId(null)}
      />
    </div>
  )
}

