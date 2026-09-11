"use client"

/**
 * What sits in the review iframe's slot when there is nothing to embed.
 *
 * `review-shell.tsx` computes `decidePrototypeEmbed(...)` and renders this
 * instead of the `<iframe>` whenever the answer is not `{ kind: "embed" }` —
 * see that pure function's own doc comment for the three reasons this can
 * happen: a server prototype with no origin of its own to run on, every
 * loopback port already in use, or a server prototype whose process crashed.
 *
 * Same slot the iframe would have taken (`flex-1` in `review-shell.tsx`), so
 * this always renders at `frame="panel"` — the rail's "fill the height and
 * centre" layout, same as the comment rail's own empty/failure states.
 */

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { EmptyState } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { fetchJson } from "../../api-client"
import { useBuildAccess } from "../use-build-access"
import { useBuildControls } from "../use-build-controls"
import type { PrototypeEmbed } from "./prototype-embed-decision"

export interface PrototypeUnavailableProps {
  /** Never `{ kind: "embed" }` — the caller only renders this panel otherwise. */
  embed: Exclude<PrototypeEmbed, { kind: "embed" }>
  projectId: string
  /** The active deployment's id, so a crash panel can fetch its server log. Null before it loads. */
  deploymentId: string | null
  /** Whether this caller may manage the project — gates the server log and Rebuild. */
  canManage: boolean
  /** A GitHub repository is connected. Rebuild needs one. */
  hasRepo: boolean
}

export function PrototypeUnavailable({
  embed,
  projectId,
  deploymentId,
  canManage,
  hasRepo,
}: PrototypeUnavailableProps) {
  switch (embed.kind) {
    case "needs-origin":
      return (
        <EmptyState
          size="sm"
          frame="panel"
          title="This prototype needs an origin of its own"
          description="It runs as a server, so its pages and links start at the root of an origin. Open the viewer on localhost, or set VIEWER_SERVE_DOMAIN so each prototype gets its own subdomain."
          data-testid="prototype-needs-origin"
        />
      )
    case "ports-exhausted":
      return (
        <EmptyState
          size="sm"
          frame="panel"
          title="All prototype ports are in use"
          description="Close some reviews, or widen VIEWER_LOOPBACK_PORT_RANGE."
          data-testid="prototype-ports-exhausted"
        />
      )
    case "crashed":
      return (
        <EmptyState
          size="sm"
          frame="panel"
          tone="failure"
          title="The prototype's server stopped"
          description={embed.reason}
          data-testid="prototype-crashed"
        >
          {/* Only a manager sees the log and Rebuild — same gate the server log
              route itself enforces, so this is a courtesy, not the real fence. */}
          {canManage ? (
            <CrashedControls projectId={projectId} deploymentId={deploymentId} hasRepo={hasRepo} />
          ) : null}
        </EmptyState>
      )
  }
}

/**
 * The manager's actions on a crashed server prototype: Rebuild, and the
 * server log underneath it. Its own component so the log fetch and the
 * build hooks mount only for a manager, same split `never-deployed.tsx` uses
 * for its own manager-only `FirstBuild`.
 */
function CrashedControls({
  projectId,
  deploymentId,
  hasRepo,
}: {
  projectId: string
  deploymentId: string | null
  hasRepo: boolean
}) {
  const [log, setLog] = useState<string | null>(null)

  useEffect(() => {
    if (!deploymentId) return
    let cancelled = false
    fetchJson<{ log: string }>(`/api/v1/deployments/${deploymentId}/server-log`)
      .then((body) => {
        if (!cancelled) setLog(body.log)
      })
      .catch(() => {
        // The log is a courtesy, not the point of this panel — a failed
        // fetch just leaves Rebuild on its own, same as no log at all.
        if (!cancelled) setLog(null)
      })
    return () => {
      cancelled = true
    }
  }, [deploymentId])

  const access = useBuildAccess()
  const build = useBuildControls({
    projectId,
    hasRepo,
    canManage: true,
    buildsEnabled: access.buildsEnabled,
  })

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-3">
      <Button
        size="sm"
        onClick={() => void build.startBuild()}
        disabled={Boolean(build.blocked)}
        busy={build.starting}
        title={build.blocked ?? undefined}
        data-testid="crashed-rebuild"
      >
        Rebuild
      </Button>
      {log ? (
        <div className="w-full">
          <ServerLog log={log} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The crashed process's stdout/stderr, open by default — copied from
 * `never-deployed.tsx`'s `BuildLog`. Open rather than closed, unlike that
 * one: a build failure has a step list above the log that already says
 * where it died, but a crashed process has nothing else on this panel, so
 * the log is the only place the reason lives beyond the one sentence above.
 */
function ServerLog({ log }: { log: string }) {
  return (
    <Collapsible defaultOpen className="group/log flex w-full flex-col items-center gap-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-fit gap-1.5 px-2 aria-expanded:bg-transparent">
          Server log
          <ChevronDown className="transition-transform group-data-[state=open]/log:rotate-180" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full">
        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-2 text-left font-mono text-code whitespace-pre-wrap break-words text-foreground">
          {log}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
