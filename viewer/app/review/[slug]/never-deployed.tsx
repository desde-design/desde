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
 * The copy is deliberately the same pair the deployments panel already uses
 * for this exact state (`../deployments-panel.tsx`, `frame="panel"` there,
 * `frame="page"` here because this owns the whole route rather than a rail).
 * One state, one wording, in both places it can be met.
 *
 * **The action is gated, the page is not.** Anyone who can read the project
 * reaches this page; only someone who can actually fix it is offered the way
 * to. The role alone answers that, so this asks `useCurrentUser` and nothing
 * else, and renders no action while that is still loading so a Viewer never
 * sees a button appear and then leave.
 */

import { ArrowLeft, Plug } from "lucide-react"
import { AppHeader, EmptyState } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { AccountMenu } from "../../account-menu"
import { canManageProjects } from "../../instance-role"
import { useCurrentUser } from "../../use-current-user"
import type { ProjectSummary } from "./page"

export function NeverDeployed({ project }: { project: ProjectSummary }) {
  // `useCurrentUser` directly, NOT `useBuildAccess`. That hook's `loading`
  // stays true until a `listInstallations()` request to GitHub resolves, and
  // this page does not care whether a GitHub App exists: it asks only whether
  // this reader may manage projects, which their role already answers. Gating
  // on the hook meant a slow or hanging GitHub call hid the action from an
  // Editor whose role was known all along. Found by a codex review.
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

      {/* `description` rather than a child: children are the ACTION slot, and
          the block spaces title/description tightly and then the action row
          apart from both. Passing the sentence as a child put it on the same
          line as the buttons. */}
      <EmptyState
        size="sm"
        frame="page"
        title="Never deployed"
        description="Every build will be listed here."
      >
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/">
              <ArrowLeft />
              Back to projects
            </a>
          </Button>
          {/* Offered only to someone who can act on it, and only once that is
              known. The href is the dashboard's existing `?connect=<id>`
              parameter, which reopens the very wizard the project card
              resumes, rather than a second entry point into it. */}
          {!loading && canManage ? (
            <Button asChild size="sm">
              <a href={`/?connect=${encodeURIComponent(project.id)}`}>
                <Plug />
                Connect a repository
              </a>
            </Button>
          ) : null}
        </div>
      </EmptyState>
    </div>
  )
}
