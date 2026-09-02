import { AppHeader } from "@/components/blocks"
import { AccountMenu } from "../account-menu"
import { SettingsNav } from "./settings-nav"
import { CurrentUserBoundary } from "../current-user-boundary"

/**
 * Settings, in the same format as the Editor's launcher and the Viewer's own
 * dashboard.
 *
 * The top bar is `AppHeader` — wordmark left, an underline along the bottom,
 * account chrome right — the same component all three surfaces render. It
 * replaced a muted "DESDE" eyebrow, which was this page's own invention and
 * looked like neither of the other two. Mo, 2026-08-21: "The top nav has the
 * wordmark and an underline."
 *
 * The wordmark links home, which is what the eyebrow was doing. On the
 * dashboard it does not, because there is nowhere to go.
 *
 * Below the bar, the surface is two columns: a left nav carrying the page
 * title and the sections, and the selected section's panel beside it. Both
 * live in `SettingsNav`, which owns the title too, and its doc comment has
 * why the heading belongs in the nav column rather than above both.
 *
 * `AppHeader`'s `width` and `<main>`'s `max-w-4xl` are coupled: the header's
 * contents ride the same column as the content, so the wordmark's left edge
 * lines up with the page title. Change one and change the other.
 *
 * It widened from `2xl` to `4xl` when the tab strip became a left nav
 * (2026-08-28). A nav column plus a content column does not fit in the width
 * one column needed, and taking it out of the content column instead would
 * have narrowed every panel to pay for the nav.
 *
 * Stays a Server Component: nothing here reads request state or needs
 * `headers()`/cookies at render time. Everything interactive is below.
 *
 * `CurrentUserBoundary` (viewer-membership, Fix wave M1 review) wraps the whole
 * surface so `AccountMenu` and every panel inside `SettingsNav` — including
 * the admin-only Members / Domain rules / Instance sections — share ONE
 * `GET /api/v1/me` fetch instead of firing one each.
 */
export default function SettingsPage() {
  return (
    <CurrentUserBoundary>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <AppHeader width="4xl" href="/">
          <AccountMenu size="icon" />
        </AppHeader>

        <main className="mx-auto flex w-full max-w-4xl flex-1 px-6 py-8">
          <SettingsNav />
        </main>
      </div>
    </CurrentUserBoundary>
  )
}
