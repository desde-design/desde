import { AppHeader } from "@/components/blocks"
import { loadConfig } from "../server/config"
import { AccountMenu } from "./account-menu"
import { CurrentUserBoundary } from "./current-user-boundary"
import { ProjectsList } from "./projects-list"

/**
 * Required, not incidental. This page reads `process.env` (below), and Next
 * does not treat that as a dynamic input — with no `headers()`/`cookies()`
 * call to force it, the page is a static prerender and `next build` would
 * BAKE the build machine's config into it. A deployment that sets
 * `VIEWER_SERVE_DOMAIN` in its runtime environment would then still render
 * `/p/{slug}/` links, silently reproducing the exact defect (an inert serve
 * domain, security audit finding S8) this page was changed to fix. The
 * sibling `review/[slug]/page.tsx` needs no such marker — it calls
 * `headers()`, which makes it dynamic already.
 */
export const dynamic = "force-dynamic"

/**
 * The Viewer dashboard, built to the Editor launcher's shape so the two
 * surfaces read as one product (`src/editor-ui/launcher-page.tsx`).
 *
 * What is deliberately shared, and where it lives:
 *
 * - the wordmark — `blocks/wordmark.tsx`
 * - the card grid's column steps and teal row ramp — `blocks/project-grid.tsx`
 * - the relative-time wording — `lib/relative-time.ts`
 *
 * What is NOT shared is the card itself. The Editor's card is one big
 * open-this-repo button; this one is a link carrying a deploy state and two
 * destinations. Forcing one component to serve both would take more props
 * than markup. See the note on `ProjectCard` in `projects-list.tsx`.
 */
export default function DashboardPage() {
  // Read here (Server Component) and passed down, rather than added to the
  // `/api/v1/projects` response `ProjectsList` already fetches: this is
  // deployment configuration, not project data. See `prototype-origin.ts`.
  const config = loadConfig()

  return (
    // `AccountMenu` and `ProjectsList` (its delete affordance is role-gated —
    // viewer-membership Task 12) each call `useCurrentUser()`; one
    // `CurrentUserBoundary` here shares the one `GET /api/v1/me` request
    // between them instead of firing it twice per page load.
    <CurrentUserBoundary>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        {/* `width` must stay in step with <main>'s `max-w-5xl` below. */}
        <AppHeader width="5xl">
          <AccountMenu size="icon" />
        </AppHeader>

        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          {/* The "Projects" heading is rendered by `ProjectsList`, not here:
              it is suppressed when the list resolves to an empty state, and
              only that component knows. */}
          <ProjectsList serveDomain={config.serveDomain} publicUrl={config.publicUrl} />
        </main>
      </div>
    </CurrentUserBoundary>
  )
}
