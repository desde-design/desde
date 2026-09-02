"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { Callout } from "@/components/blocks"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { DeploymentWarning } from "./build-log-utils"

/** Matches the server's cap on how many sample findings the copy asks for. */
const MAX_SAMPLES = 3

export interface RootAbsoluteWarningCalloutProps {
  warning: DeploymentWarning
  className?: string
  /** Renders the Callout's dismiss X (top right). The caller owns the state. */
  onDismiss?: () => void
}

/**
 * The root-absolute-asset warning Callout (viewer-membership row 7).
 *
 * Rendered only where the caller has already decided it's worth showing —
 * see `shouldShowRootAbsoluteWarning` in `build-log-utils.ts`, which is
 * computed from the project's CURRENT access + serve mode, not baked in at
 * scan time.
 */
export function RootAbsoluteWarningCallout({
  warning,
  className,
  onDismiss,
}: RootAbsoluteWarningCalloutProps) {
  const [open, setOpen] = useState(false)
  const samples = warning.findings.slice(0, MAX_SAMPLES)

  return (
    /* The column layout lives on the inner wrapper, NOT the Callout: with
       `onDismiss` the Callout lays itself out as a row (content beside the
       X), and a `flex-col` here would push the X under the content instead
       of the top-right corner. */
    <Callout tone="warning" className={className} onDismiss={onDismiss}>
      <div className="flex flex-col gap-1.5">
      {/* One sentence and a Learn more (Mo, 2026-08-30: "it is very long") —
          the example URL and both fixes moved to the docs page the link
          opens. An inline link, not a filled button, per how every other
          banner here handles its action. */}
      <p className="font-medium text-foreground">This prototype may not load fully for signed-in members</p>
      <p className="text-muted-foreground">
        Its build links assets from the site root, which doesn&apos;t resolve for prototypes
        served behind sign-in.{" "}
        <a
          href="https://desde.design/docs/viewer/serving#root-absolute-asset-urls"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:no-underline"
          data-testid="root-absolute-learn-more"
        >
          Learn more
        </a>
      </p>
      {samples.length > 0 ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
            {warning.summary}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 flex flex-col gap-1 pl-5">
              {samples.map((finding, i) => (
                <li key={i} className="truncate font-mono text-code text-muted-foreground">
                  {finding.file}: <span className="text-foreground">{finding.sample}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      </div>
    </Callout>
  )
}
