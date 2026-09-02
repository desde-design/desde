"use client"

import { LogOut } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/blocks"
import { avatarInitial } from "@/lib/initials"
import { useCurrentUser } from "../use-current-user"

/**
 * Who you are signed in as, and the controls that change it.
 *
 * The same three facts the account menu shows in its label — avatar, display
 * name, email — plus Sign out. It is not new information; it is the same
 * information somewhere a person can actually look at it. A dropdown that
 * closes when you move the mouse is a poor place to answer "which account am
 * I on?", which on a forwarded review link is a real question.
 *
 * `signOut` is duplicated from `account-menu.tsx` rather than shared, and
 * that is a deliberately small duplication: it is two lines, and the reload
 * is the load-bearing half. Extracting it would mean a module for one fetch
 * call.
 *
 * ## Decision order: a signed-in user wins over every provider flag
 *
 * This panel used to check `!authEnabled` FIRST and render "Sign-in isn't
 * configured, so there is no account to show". `authEnabled` means only
 * "GitHub sign-in is configured" — it says nothing about whether THIS caller
 * is signed in, and nothing about the other three ways into this product (an
 * invite link, a magic link, the local-operator boot link). So anyone signed
 * in on an instance without a GitHub App was told they had no account while
 * holding a perfectly good session.
 *
 * MEASURED 2026-08-28 on a zero-config viewer: sign in with the boot link,
 * open Settings, and the Account section says there is no account to show
 * while the nav beside it renders all four admin-only sections, which only an
 * Admin can see. That is the default path for a new instance, not an edge.
 *
 * This is the THIRD component to carry the defect. `TokensPanel` and
 * `ProjectRepoPanel` were both fixed for it in viewer-membership Fix wave 4
 * (codex round-4) and have regression tests; this one was missed, even though
 * the gallery already had the fixture that exposes it
 * (`ME_SIGNED_IN_EMAIL_ONLY`) pointed at the Tokens section. The order below
 * matches theirs, and `__tests__/account-panel-signin-availability.test.ts`
 * is its regression test.
 *
 * The GitHub-setup prompt that used to sit under the account card moved to a
 * banner across the top of Settings on 2026-08-29 (Mo: "this banner feels
 * like it is in the wrong place"). It is about the whole viewer, not about
 * the account you happen to be signed in as, so it now spans both columns
 * instead of hiding in one section — see `settings-nav.tsx`.
 *
 * ## The last state is not a dead end
 *
 * Signed out with NOTHING configured used to be a full stop: a sentence
 * naming GitHub OAuth, no control, and nowhere to go. Mo, 2026-08-28: "this
 * shouldn't be a dead end, there should be a button to set up GitHub OAuth
 * sign in, or whatever is the right next step."
 *
 * The right next step is not a setup button, and that is worth writing down
 * so it does not get "fixed" into one later. Creating the GitHub App is gated
 * server-side by `requireOperator` (`server/api/setup-routes.ts`), which
 * refuses an anonymous caller with a 401 — provisioning a private key and a
 * client secret the whole deployment builds through is deliberately not
 * something a stranger may do. A "Set up GitHub sign-in" button here would
 * navigate an anonymous visitor to a refusal, which is a worse dead end than
 * the one it replaced, because it looks like a way forward.
 *
 * What genuinely unblocks them is a session, and on this deployment shape
 * there is exactly one way to get one: the link the process printed when it
 * started. So this says that, in the same words `/signin` uses.
 *
 * Once they ARE signed in as an Admin, the setup button is real and this
 * panel offers it, because by then the server will accept it.
 */
export function AccountPanel() {
  const { user } = useCurrentUser()

  // Loading and signed-out never reach this panel any more: `SettingsNav`
  // collapses the whole page to one message before mounting any section
  // (Mo, 2026-08-31), and the copy this panel carried for those states
  // moved up there with it. The guard is defensive, not a state.
  if (!user) return null

  return (
      <SettingsSection
        frame="bare"
        title="Account"
        /*
          The subject is signing out, not the browser (Mo, 2026-08-28: "the
          text here is off, it says that the browser is logged in as"). A
          browser is not signed in as anyone; a person is, and the card below
          already names which one. What the reader cannot see, and what sits
          right beside the button that does it, is how far Sign out reaches:
          this browser, not every session on the account.

          It also no longer says "GitHub account". Three of the four ways into
          this product are not GitHub, so that word was wrong for anyone who
          arrived by invite link, magic link, or the local boot link.
        */
        description="Signing out ends this session on this browser."
        action={
          <Button variant="outline" size="sm" onClick={() => void signOut()} data-testid="account-sign-out">
            <LogOut />
            Sign out
          </Button>
        }
        data-testid="settings-section-account"
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-2">
          <Avatar className="flex-none">
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{avatarInitial(user.displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-base">{user.displayName}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </div>
        </div>

    </SettingsSection>
  )
}

async function signOut() {
  await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {})
  // Reload rather than re-fetch: every hook on the page re-reads `/me` from
  // scratch, so none can be left holding the signed-in user.
  window.location.reload()
}
