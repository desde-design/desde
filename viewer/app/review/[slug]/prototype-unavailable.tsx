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

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ChevronDown } from "lucide-react"
import { Callout, EmptyState } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { fetchJson } from "../../api-client"
import { shouldRefreshAfterRebuild } from "../rebuild-refresh"
import { useBuildAccess } from "../use-build-access"
import { useBuildControls } from "../use-build-controls"
import type { PrototypeEmbed } from "./prototype-embed-decision"

/**
 * `useRouter().refresh`, guarded against a missing Next App Router context.
 *
 * The gallery's registry sweep (`gallery/registry.test.tsx`) renders this
 * panel directly through React Testing Library — there is no real Next app
 * around it, no `<AppRouterContext>`, nothing `useRouter()` can read — and
 * it throws synchronously there ("invariant expected app router to be
 * mounted"). The real review page always has the context (it is rendered by
 * the actual Next app), so the catch below is a gallery-only path, never a
 * product one. The `try` wraps a single unconditional call, in the same
 * position on every render — it changes what `useRouter()` DOES, not
 * whether or how many times this component calls it, so it does not trip
 * the hook-order rule the way a real conditional hook call would.
 */
function useRouterRefresh(): () => void {
  try {
    const router = useRouter()
    return () => router.refresh()
  } catch {
    return () => {}
  }
}

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
  /** True only after a fetch actually failed — distinct from "not loaded yet". */
  const [logFailed, setLogFailed] = useState(false)

  useEffect(() => {
    if (!deploymentId) return
    let cancelled = false
    async function loadLog(): Promise<void> {
      try {
        const body = await fetchJson<{ log: string }>(`/api/v1/deployments/${deploymentId}/server-log`)
        if (cancelled) return
        setLog(body.log)
        setLogFailed(false)
      } catch {
        // The log is a courtesy, not the point of this panel — a failed
        // fetch leaves Rebuild on its own, with a one-line note rather than
        // silently showing nothing where a log might have been.
        if (cancelled) return
        setLog(null)
        setLogFailed(true)
      }
    }
    void loadLog()
    return () => {
      cancelled = true
    }
  }, [deploymentId])

  const refreshRouter = useRouterRefresh()
  const access = useBuildAccess()
  const build = useBuildControls({
    projectId,
    hasRepo,
    canManage: true,
    buildsEnabled: access.buildsEnabled,
  })

  // Rebuild lands a NEW deployment; this page's `embed` decision was resolved
  // server-side, in `page.tsx`, from the OLD one. Once the rebuild actually
  // finishes (not merely starts — `deployed`, not `building`), re-resolving
  // the server component is what lets `decidePrototypeEmbed` see the new
  // deployment's process status and swap this panel for the iframe (or a
  // fresh failure) without the reader reloading the page themselves.
  //
  // NOT just "the deployment is deployed" — see `shouldRefreshAfterRebuild`'s
  // own doc comment. This panel mounts on an already-crashed prototype, and
  // its latest deployment (what `useBuildControls` reads on mount) is
  // usually ALREADY `"deployed"`: the build succeeded, the process died
  // later. Refreshing on that alone would fire the moment this panel mounts,
  // before anyone has clicked anything, and never again for a REAL rebuild.
  // So refreshing requires a transition this panel itself caused:
  // `rebuildRequestedRef` is set in the Rebuild button's own click handler,
  // before `startBuild()`, and `sawBuildingRef` is set once this panel has
  // actually observed `status === "building"` — proof the deployment
  // reaching `"deployed"` is the NEW attempt, not the stale one it mounted
  // with.
  const rebuildRequestedRef = useRef(false)
  const sawBuildingRef = useRef(false)
  useEffect(() => {
    if (build.deployment?.status === "building") sawBuildingRef.current = true
  }, [build.deployment?.status])
  useEffect(() => {
    if (
      !shouldRefreshAfterRebuild({
        requested: rebuildRequestedRef.current,
        sawBuilding: sawBuildingRef.current,
        status: build.deployment?.status,
      })
    ) {
      return
    }
    // Reset both, rather than a permanent one-shot: a reader can crash a
    // SECOND time (the same repo can fail the same way twice) and click
    // Rebuild again, and that attempt deserves its own refresh.
    rebuildRequestedRef.current = false
    sawBuildingRef.current = false
    refreshRouter()
  }, [build.deployment?.status, refreshRouter])

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-3">
      <Button
        size="sm"
        onClick={() => {
          rebuildRequestedRef.current = true
          void build.startBuild()
        }}
        disabled={Boolean(build.blocked)}
        busy={build.starting}
        title={build.blocked ?? undefined}
        data-testid="crashed-rebuild"
      >
        Rebuild
      </Button>
      {build.error ? (
        <div className="w-full">
          <Callout tone="destructive">{build.error}</Callout>
        </div>
      ) : null}
      {log ? (
        <div className="w-full">
          <ServerLog log={log} />
        </div>
      ) : logFailed ? (
        <p className="text-sm text-muted-foreground">The server log could not be loaded.</p>
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
