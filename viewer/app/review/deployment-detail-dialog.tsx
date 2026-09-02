"use client"

import { StatusPill } from "@/components/blocks"
import { Check, ChevronDown, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatRelativeSpan } from "@/lib/relative-time"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { presentStatus, shortSha, stepDuration, type DeploymentView } from "../build-log-utils"

/**
 * One deployment, opened from its row in the list.
 *
 * The shape comes from the original Desde viewer (Mo, 2026-08-21): the
 * list shows a status, and clicking it opens the detail. The panel itself
 * does not lead with a build log, because a log is what you read when
 * something went wrong or while it is running, not the first thing you should
 * have to look past.
 *
 * ## Steps first, then the log
 *
 * The phase list is the summary and the log is the detail, which is the
 * original's shape. A build that failed at Install says so in one line here,
 * where the log says it in four hundred.
 *
 * These are REAL phases, recorded by the runner as it runs them (migration 6,
 * `BuildStep` in `storage/types.ts`), not parsed back out of log text.
 * Reconstructing structure from prose is how a UI starts describing a build
 * that did not happen.
 *
 * Steps ship to every reader while the log stays owner-only. The log carries
 * the operator's install/build command line and a private repo's toolchain
 * output; a phase list carries four fixed names and two timestamps each. So a
 * reader who cannot see the log still learns the build died at Install.
 *
 * A deployment with `steps: null` renders none — an uploaded bundle ran no
 * phases, and neither did any build from before this existed.
 *
 * ## The log may be absent, and that is not an error
 *
 * The route omits `buildLog` for anyone who is not an owner or admin (S7),
 * because it can carry install/build command lines and the full stdout of a
 * private repo's toolchain. Absent means "not shown to you", so this says
 * that, rather than rendering an empty box.
 */
export function DeploymentDetailDialog({
  deployment,
  isLive,
  onClose,
}: {
  deployment: DeploymentView | null
  /** This is the build currently being served. */
  isLive: boolean
  onClose: () => void
}) {
  if (!deployment) return null
  const status = presentStatus(deployment.status)

  /*
    The log opens closed, EXCEPT when the build failed (Mo, 2026-08-28).

    Collapsed is right for the common case: the step list above already says
    what happened in four lines where the log says it in four hundred, and a
    wall of `npm ci` output is not what a reader came to check on a build that
    worked. A failure inverts that — the log stops being detail and becomes
    the only place the reason exists, so making someone click for it hides the
    one thing they opened the dialog to read.

    Both signals are checked, not just `deployment.status`. A step can be
    recorded `failed` while the deployment row has not been moved off
    `building` yet, and in that window the reason is already in the log.
  */
  const buildFailed =
    deployment.status === "failed" ||
    (deployment.steps?.some((step) => step.status === "failed") ?? false)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl" data-testid="deployment-detail">
        <DialogHeader>
          {/* The commit's own words name the deployment when they exist (Mo,
              2026-08-30); the sha stays as the fallback identity for uploads
              and pre-field builds. */}
          <DialogTitle className="truncate">
            {deployment.commitMessage ?? `Deployment ${shortSha(deployment.commitSha)}`}
          </DialogTitle>
          {/*
            One line, not two (Mo, 2026-08-28). The description used to read
            "Deployed, 9 days ago." and a `StatusPill` under it read
            "Deployed" again, so the status was rendered twice and the dot was
            attached to the copy that carried less.

            Merged into the description slot rather than kept as a row below
            it. The status IS what this dialog says about the deployment
            before the steps, and putting it here also means a screen reader
            gets it: `DialogDescription` is announced on open, and the old
            pill sat outside the header where nothing announced it.

            `asChild` because the content is a flex row rather than a
            paragraph, and `text-base` so the pill reads at description size
            instead of its own `text-sm`.
          */}
          <DialogDescription asChild>
            <div className="flex items-center gap-2">
              <StatusPill tone={status.tone} pulse={status.active} className="text-base">
                {status.label} {formatRelativeSpan(deployment.createdAt)}
              </StatusPill>
              {/* With the commit message carrying the title, the sha still
                  has to live somewhere — it is what you paste into git. */}
              {deployment.commitMessage && deployment.commitSha ? (
                <span className="font-mono text-code text-muted-foreground">
                  {shortSha(deployment.commitSha)}
                </span>
              ) : null}
              {/* "This is the build being served." went with the merge. It
                  explained LIVE in a sentence beside the marker itself, which
                  is the same fact a third time, and the deployments list
                  already uses LIVE on its own. */}
              {isLive ? (
                <span className="text-2xs font-medium tracking-wide text-primary uppercase">
                  Live
                </span>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        {deployment.steps && deployment.steps.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-md border" data-testid="deployment-steps">
            {deployment.steps.map((step) => {
              const duration = stepDuration(step)
              return (
                <li key={step.name} className="flex items-center gap-2 px-3 py-2">
                  <StepIcon status={step.status} />
                  <span
                    className={cn(
                      "flex-1 text-sm",
                      step.status === "failed" ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {step.name}
                  </span>
                  {/* Tabular so the column of durations lines up by place
                      value — the one case docs/design.md's "right alignment
                      is for numbers" rule is actually about. */}
                  {duration ? (
                    <span className="flex-none text-xs text-muted-foreground tabular-nums">
                      {duration}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}

        {deployment.buildLog === undefined ? (
          <p className="text-sm text-muted-foreground">
            The build log is only shown to project owners.
          </p>
        ) : deployment.buildLog.length === 0 ? (
          <p className="text-sm text-muted-foreground">This build produced no output.</p>
        ) : (
          <Collapsible defaultOpen={buildFailed} className="group/log flex flex-col gap-2">
            {/* The chevron TRAILS the label, per docs/design.md: leading it
                would indent the only label in the block and make the glyph
                the first thing scanned. `w-fit` so the hit area is the words,
                not the dialog's full width. */}
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                /* `ghost` carries `aria-expanded:bg-muted`, which is right for a
                   menu trigger that stays "open" over a floating surface. Here the
                   expanded content is inline and directly below, so the fill left
                   the trigger looking selected for as long as the log was open.
                   Hover still tints; only the expanded state is cleared. */
                className="w-fit gap-1.5 px-2 aria-expanded:bg-transparent"
              >
                Build log
                <ChevronDown
                  className="transition-transform group-data-[state=open]/log:rotate-180"
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-code whitespace-pre-wrap break-words text-foreground">
                {deployment.buildLog}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}

        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One phase's status, as a glyph.
 *
 * Stroked lucide icons, per docs/design.md — and colour is doing the work
 * alongside the shape rather than instead of it, so the list still reads when
 * the icons are small. A running phase spins, which is the same signal a busy
 * Button gives and means the same thing.
 */
function StepIcon({ status }: { status: "running" | "succeeded" | "failed" }) {
  if (status === "running") {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
  }
  if (status === "failed") {
    return <X className="size-3.5 shrink-0 text-destructive" aria-hidden />
  }
  return <Check className="size-3.5 shrink-0 text-success" aria-hidden />
}
