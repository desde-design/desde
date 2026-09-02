"use client"

import { GitBranch, LogOut, SlidersHorizontal, Users } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { avatarInitial } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { useCurrentUser } from "./use-current-user"
import { visibleSettingsSections } from "./settings/settings-nav"

/**
 * The signed-in person, as one icon button with a menu behind it.
 *
 * It was an inline row until 2026-08-19 — avatar, display name, a settings
 * gear and a "Sign out" button, all always visible (`AccountChip`). Mo's
 * call: the GitHub identity and Sign out belong INSIDE the profile menu. Four
 * controls' worth of chrome for things a person touches once a session, and
 * on the 320px review rail it was what pushed the project name into an
 * ellipsis.
 *
 * One component for both surfaces, deliberately. The dashboard and the review
 * rail now show the same avatar in the same corner and open the same menu; a
 * second, wider variant for the roomier screen would be two things to keep in
 * step for no gain.
 *
 * Renders NOTHING while `GET /api/v1/me` is in flight.
 *
 * Signed out on a deployment with no provider at all (`signInUrl` is `null`
 * AND `emailSignInEnabled` is `false`), it drops the "Sign in" button — a
 * dead button on a deployment that cannot sign anyone in is worse than no
 * button — but KEEPS a link to Settings. That case covers local-mode
 * deployments, whose one way in is the boot console URL that `/me`
 * deliberately never advertises (it carries a secret, and `/me` is a public
 * endpoint). Settings is where such a deployment goes to grow a real
 * provider, and this menu's item is its only entry point anywhere, so
 * rendering nothing used to strand the operator on the one deployment shape
 * that most needed the page.
 */
export interface AccountMenuProps {
  className?: string
  /**
   * How big the trigger is.
   *
   * `icon-sm` (the default) is the dense one, for the review rail: a 320px
   * column where this sits between two other icon buttons and matching them
   * is what keeps the row a row.
   *
   * `icon` is for a full page's top nav, where there is room and this is the
   * only control on the bar — so it is sized to be found rather than to fit
   * (Mo, 2026-08-26). Deliberately NOT applied to the rail, which was tried
   * and read as one button outgrowing its neighbours.
   *
   * The default is the constrained one on purpose: a new surface that forgets
   * to choose gets the size that cannot break a dense row.
   */
  size?: "icon-sm" | "icon"
  /**
   * Project-scoped settings, folded into this menu on a surface that has a
   * project in hand (the review rail).
   *
   * The rail used to carry TWO buttons side by side: a gear for the project
   * and this avatar for the person, split "by whose settings they are". Mo
   * overruled that on 2026-08-25 — "they are pretty redundant" — and the
   * split is now a labelled section inside one menu rather than a second
   * control in a 320px row.
   */
  projectActions?: {
    onOpenAccess: () => void
    onOpenRepo: () => void
  }
}

export function AccountMenu({ className, size = "icon-sm", projectActions }: AccountMenuProps) {
  const { user, loading, signInUrl, emailSignInEnabled } = useCurrentUser()

  if (loading) return null
  // Signed in: the menu. Signed out with somewhere to go: the button.
  // Signed out with nowhere to sign in: the settings link, because this
  // corner is not only about signing in.
  //
  // It used to render nothing here, on the reasoning that a dead sign-in
  // button is worse than an empty corner. That reasoning was sound about the
  // BUTTON and wrong about the corner (Mo, 2026-08-28: "that would be where
  // the settings icon is, not just sign-in"). Settings has no other entry
  // point anywhere in the viewer — this menu's item is the only one — so
  // hiding the whole control took the page with it.
  //
  // The deployment that lands here is precisely the zero-config one, where
  // Settings is where the operator goes to set up the GitHub App and stop
  // being in this state. Emptying the corner removed the way out of exactly
  // the situation the corner was empty for.
  //
  // A plain link, not a menu: the two items behind the trigger are the
  // account label and Sign out, and neither exists without a user. A
  // dropdown holding one item asks for a click to reveal the click.
  if (!user && !signInUrl && !emailSignInEnabled) {
    return (
      <Button
        asChild
        variant="ghost"
        size={size}
        aria-label="Settings"
        title="Settings"
        className={cn(className)}
        data-testid="settings-link"
      >
        <a href="/settings">
          <SlidersHorizontal />
        </a>
      </Button>
    )
  }

  if (!user) {
    // `/signin` (Task 15) only earns the extra click when it has a CHOICE to
    // show — email sign-in configured alongside, or in place of, GitHub.
    // With exactly one method, sending the visitor straight to it (GitHub's
    // `signInUrl`, or nowhere when only email exists — email has no direct
    // link, it needs the page's form) is one fewer hop for the same outcome.
    const href = emailSignInEnabled ? "/signin" : signInUrl
    return (
      <Button asChild variant="outline" size="xs" className={className} data-testid="sign-in">
        {/* Just "Sign in" (Mo, 2026-08-19). Naming a specific provider only
            makes sense once there's a choice among several — see `href`
            above for when that choice exists.

            GitHub's `signInUrl` is a real page navigation (a 302), not client
            routing; `/signin` is this app's own route either way. */}
        {/* `?? undefined`: TypeScript can't see that the guard above already
            rules out `href` being null here (it's a disjunctive fact across
            `signInUrl`/`emailSignInEnabled`, not a per-variable narrowing) —
            but at runtime, reaching this branch with `!user` true means at
            least one of them is truthy, so `href` is too. */}
        <a href={href ?? undefined}>
          {/* Text alone, no glyph (Mo, 2026-08-26). A cat sat here briefly as
              the pair to a cat-headed account button; that button became a
              settings glyph, and the cat outlived the thing it was paired
              with. "Sign in" is two words that say exactly what the button
              does, and an icon beside them would have to earn its place by
              adding something they do not. */}
          Sign in
        </a>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          aria-label={`Account: ${user.displayName}`}
          title={user.displayName}
          className={cn(className)}
          data-testid="account-menu"
        >
          {/*
            Sliders, not a face (Mo, 2026-08-26). This one control carries the
            project's settings AND the account, so the glyph names what is
            behind it rather than who is holding it.

            It replaced a cat's head with the person's initial, which was
            tried and dropped: see `docs/design.md` for the sizes it survived
            and the one it did not.

            Still NOT the signed-in user's photo. That comes from GitHub, and
            GitHub's placeholder for a user with no picture IS the octocat —
            an account button showing "the real avatar" renders a vendor logo
            for anyone who never set one, reading as "sign in with GitHub"
            rather than "this is you". The photo is not lost: it sits beside
            the name inside the menu, where it does its actual job of
            confirming WHICH account this is, at a size where a face reads.

            `title` and `aria-label` still carry the name, so the one thing
            the initial bought — telling two accounts apart on one machine —
            survives without spending the glyph on it.
          */}
          <SlidersHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-56">
        {/* Name AND email. On a review link that may have been forwarded
            twice, "which account am I signed in as" is a real question, and a
            display name alone does not answer it. */}
        <DropdownMenuLabel className="flex items-center gap-2">
          <Avatar size="sm" className="flex-none">
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{avatarInitial(user.displayName)}</AvatarFallback>
          </Avatar>
          {/* No gap: the two lines' own leading is spacing enough (Mo,
              2026-08-30) — with gap-0.5 on top they read as separate rows
              rather than one identity. */}
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{user.displayName}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {projectActions ? (
          <>
            {/* The project's settings come FIRST: on the rail you are looking
                at one project, and what it is built from is nearer to hand
                than what your account is. The label is what keeps "Access"
                from reading as your own. */}
            <DropdownMenuLabel>Project</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={projectActions.onOpenAccess}
              data-testid="rail-settings-access"
            >
              <Users />
              Access
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={projectActions.onOpenRepo}
              data-testid="rail-settings-repo"
            >
              <GitBranch />
              Repository
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {/* One item per Settings section, deep-linked (Mo, 2026-08-30) — the
            page keeps its tabs; these land on the right one via `?section=`.
            The list comes from the page's own nav (`visibleSettingsSections`)
            so the two can never drift, role gating included. */}
        <DropdownMenuLabel>Settings</DropdownMenuLabel>
        {visibleSettingsSections(user.role === "admin").map((s) => (
          <DropdownMenuItem asChild key={s.id} data-testid={`account-menu-settings-${s.id}`}>
            <a href={`/settings?section=${s.id}`}>{s.label}</a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} data-testid="sign-out">
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

async function signOut() {
  await fetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {})
  // Reload rather than re-fetch: every hook on the page re-reads `/me` from
  // scratch, so none can be left holding the signed-in user.
  window.location.reload()
}

