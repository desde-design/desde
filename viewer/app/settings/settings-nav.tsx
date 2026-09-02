"use client"

import { useState } from "react"
import { Callout, EmptyState, ListRow, ProjectLoader } from "@/components/blocks"
import { Button } from "@/components/ui/button"
import { LOCAL_OPERATOR_SENTENCE } from "../signin/sign-in-copy"
import { cn } from "@/lib/utils"
import { useCurrentUser } from "../use-current-user"
import { AccountPanel } from "./account-panel"
import { TokensPanel } from "./tokens-panel"
import { MembersPanel } from "./members-panel"
import { DomainRulesPanel } from "./domain-rules-panel"
import { GithubPanel } from "./github-panel"
import { InstanceSettingsPanel } from "./instance-settings-panel"

/**
 * The settings navigation: a left column carrying the page title and the
 * sections, with the selected section's panel beside it.
 *
 * It was a horizontal segmented tab strip under a page title until
 * 2026-08-28, when Mo asked for "a vertical left navigation, in the left nav
 * would be the settings title and then the nav items beneath it".
 *
 * ## Why the title lives in the nav column
 *
 * "Settings" names the whole surface, and every item under it is a part of
 * that surface. Stacking them in one column makes that containment the
 * layout's own statement rather than something the reader infers from a
 * heading that happens to sit above a strip. It also gives the content
 * column a single owner: everything to the right of the rule is the section
 * the reader picked, with nothing above it competing to name the page.
 *
 * ## What this bought back: the section header
 *
 * The panels dropped their own `title` on 2026-08-28 (`SettingsSection`'s
 * `title` became optional for exactly this) because a selected tab reading
 * "Members" sat directly above a heading reading "Members". A LEFT nav does
 * not stack that way: the nav item and the section heading are side by side
 * in different columns, so the heading is no longer an echo of the thing
 * immediately above it, and the content column gets a proper top edge.
 *
 * With the heading back, `SettingsSection`'s `action` returns to where it
 * belongs, beside the TITLE rather than beside the description. Mo:
 * "re-introduce the section header with the actions to the right of the
 * header instead of the description."
 *
 * ## `onNavigate`, and why a panel may move the reader
 *
 * A panel can send the reader to another section (`AccountPanel` points an
 * Admin at GitHub when this deployment has no GitHub sign-in configured).
 * The alternative was naming the section in prose and letting the reader find
 * it, which docs/design.md rules out: "check a destination exists before
 * naming it in copy", and a named destination with no control to reach it is
 * the dead end this change set exists to remove.
 *
 * ## `?section=`, for arriving from somewhere else
 *
 * This was a callback and nothing else until 2026-08-28, on the reasoning
 * that the section is `useState` with no URL to point at, and that adding one
 * was a bigger change than the single in-page pointer needed. The note ended
 * "revisit if a second surface ever has to deep-link into a section" — and
 * one did: the review rail's no-authentication banner sends people here, and
 * Mo asked for it to land on the right SECTION so it reads as a Viewer-level
 * setting rather than a project-level one.
 *
 * So `?section=` is honoured, read from the query string after mount (see
 * the effect below for why not during render). The in-page pointer stays a
 * callback: it is already on this page, and a full navigation to reach the
 * next column would be a worse version of a click.
 *
 * ## The admin sections (viewer-membership)
 *
 * Membership is INSTANCE-level in this product: an Admin manages the viewer's
 * members, its email-domain rules, and its instance-wide settings. Those
 * sections are shown ONLY to an Admin — the panels each self-gate to `null`
 * for anyone else (the server enforces the real access control via
 * `requireInstanceAdmin`), and the nav omits them entirely so a Viewer or
 * Editor never lands on a blank pane. Account and Tokens are visible to
 * everyone who can sign in.
 *
 * ## Adding a section
 *
 * Add the entry to `BASE_SECTIONS` (or `ADMIN_SECTIONS` for an admin-only
 * area) and a branch below.
 */
const BASE_SECTIONS = [
  { id: "account", label: "Account" },
  { id: "tokens", label: "Tokens" },
] as const

const ADMIN_SECTIONS = [
  { id: "members", label: "Members" },
  { id: "domains", label: "Domain rules" },
  { id: "github", label: "GitHub" },
  { id: "instance", label: "Viewer settings" },
] as const

export type SettingsSectionId =
  | (typeof BASE_SECTIONS)[number]["id"]
  | (typeof ADMIN_SECTIONS)[number]["id"]

/** Is `value` one of the section ids? Narrows an untrusted query string. */
export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return (
    typeof value === "string" &&
    [...BASE_SECTIONS, ...ADMIN_SECTIONS].some((s) => s.id === value)
  )
}

/**
 * The sections a caller of this role can open. Exported for `AccountMenu`,
 * whose per-section deep-link items (Mo, 2026-08-30) must never drift from
 * the page's own nav — one list, two renderings.
 */
export function visibleSettingsSections(
  isAdmin: boolean,
): ReadonlyArray<{ id: SettingsSectionId; label: string }> {
  return isAdmin ? [...BASE_SECTIONS, ...ADMIN_SECTIONS] : [...BASE_SECTIONS]
}

export function SettingsNav() {
  const { user, authEnabled, loading, signInUrl, emailSignInEnabled } = useCurrentUser()
  const isAdmin = user?.role === "admin"
  const sections = visibleSettingsSections(isAdmin)
  /*
    `?section=` read in a lazy initializer, which needs justifying twice over.

    Why not on the server, in `page.tsx`: Next hands a page its
    `searchParams` as a Promise, which makes the component async, and the
    gallery renders that page directly through `react-dom` (see
    `gallery/README.md`). An async component cannot be rendered there, and
    twelve fixture states import it. `useSearchParams()` is out for the
    mirror-image reason: it needs Next's router, which the gallery has no
    part of.

    Why reading `window` during render is SAFE here, when it usually is not:
    this component server-renders, so the server sees "account" and the
    client may see "github" — but the two produce the SAME DOM. `user` is
    null on the server AND on the client's first render (its fetch has not
    resolved), so `sections` holds only the base pair and `activeSection`
    below resolves to "account" either way. React hydrates against markup,
    not state, and the markup is identical. The requested section takes
    effect one render later, when the role arrives and makes it available.

    That also rules out the obvious alternative: an effect that corrects the
    state after mount trips `react-hooks/set-state-in-effect`, and would be
    doing the same job a frame later for no gain.
  */
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [section, setSection] = useState<SettingsSectionId>(() => {
    if (typeof window === "undefined") return "account"
    const requested = new URLSearchParams(window.location.search).get("section")
    return isSettingsSectionId(requested) ? requested : "account"
  })

  /*
    What is SHOWN, as opposed to what was asked for.

    The two differ for a whole render or more, and in two directions. `user`
    arrives asynchronously, so on the first paint nobody is an Admin yet and
    the four admin sections do not exist — a deep link to `?section=github`
    would fall back to Account and then never recover, because the state was
    already decided. And a Viewer or Editor who types that URL must not land
    on a section their role does not include: the panels self-gate to `null`,
    so they would get a blank pane beside a nav with nothing selected.

    Keeping the REQUEST in state and deriving what to render from the current
    section list handles both: the deep link resolves the moment the role
    does, and a section the caller may not have quietly reads as Account.
  */
  const activeSection: SettingsSectionId = sections.some((s) => s.id === section)
    ? section
    : "account"

  /*
    "Nobody else can sign in yet", across the top of the whole surface.

    It sat under the account card until 2026-08-29 (Mo: "this banner feels
    like it is in the wrong place... let's make it a banner across the top of
    settings left nav and content"). It was in the wrong place: it is a fact
    about the VIEWER, not about the account you happen to be signed in as, so
    burying it in one section made the reader's own identity look like its
    subject. Spanning both columns is what says its scope.

    Shown only to an Admin, because `requireOperator` on the manifest route
    accepts an admin session and refuses everyone else — a Viewer or Editor
    seeing this would be seeing a 403 with a label on it. It also disappears
    once GitHub sign-in exists, since then there is nothing to set up.

    Dismissable, and in component state like the review rail's public-link
    notice: it comes back on reload, which is right for a standing condition
    that has not been fixed yet. Dismiss says "I have read this", not "stop
    telling me".
  */
  const showSetupBanner = isAdmin && !authEnabled && !setupDismissed

  /*
    Signed out, the whole page collapses to ONE message (Mo, 2026-08-31) —
    it used to render the nav with Account and Tokens, both of which
    dead-ended in their own "sign in first" states: a nav of locked rooms.
    The two variants and their copy moved up here from `AccountPanel`, whose
    own signed-out branches are gone with them (one copy, one place).

    Gated on `loading` so the collapse never flashes for a signed-in person
    whose session is still resolving; the loader is the same wait every
    panel used to show for the same moment.
  */
  if (loading) {
    return <ProjectLoader size={80} label="Loading" className="flex-1 py-6" />
  }
  if (!user) {
    const canSignIn = signInUrl !== null || emailSignInEnabled
    const href = emailSignInEnabled ? "/signin" : signInUrl
    return canSignIn ? (
      /* `tone="denied"`: the cat at the portal — the reader is not through
         the door yet, which is a different fact from "this list is empty". */
      <EmptyState
        size="sm"
        tone="denied"
        frame="page"
        title="You're signed out"
        description="Sign in to see settings."
        data-testid="settings-signed-out"
      >
        <Button asChild size="sm">
          {/* `?? undefined`: `canSignIn` above already rules out `href`
              being null here. */}
          <a href={href ?? undefined}>Sign in</a>
        </Button>
      </EmptyState>
    ) : (
      /* The reader cannot sign in here and cannot be given a way to: the
         only credential is a one-time link printed where the process
         started, and putting a token on a page anyone can load would defeat
         the point of printing it out of band. So this state offers the one
         action that does exist. Without it the page was a dead end with no
         control at all, which is how Mo landed on it (2026-09-01) with
         nothing to click. */
      <EmptyState
        size="sm"
        frame="page"
        title="No sign-in is configured"
        description={LOCAL_OPERATOR_SENTENCE}
        data-testid="account-no-signin"
      >
        <Button asChild variant="outline" size="sm">
          <a href="/">Back to projects</a>
        </Button>
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      {showSetupBanner ? (
        <Callout
          tone="info"
          onDismiss={() => setSetupDismissed(true)}
          data-testid="settings-setup-github"
        >
          {/*
            An inline link in the sentence, not a filled button (Mo,
            2026-08-29: "the button shouldn't be the primary aqua, see how
            other banners and toasts are handled"). The review rail's
            public-link notice is the shape this follows: one sentence, the
            action running on in the same face and size, and a dismiss X.

            A primary fill inside a tinted banner is two levels of emphasis
            stacked on a thing the reader has not asked for yet.

            Raw `<button>` because it moves the section rather than
            navigating, and because `Button` is inline-flex with a fixed
            height and its own font-size, none of which wraps mid-sentence.
          */}
          Nobody else can sign in to this viewer yet.{" "}
          {/* eslint-disable-next-line react/forbid-elements -- inline text link inside a running sentence; Button is inline-flex with a fixed height, its own font-size and whitespace-nowrap, so it cannot wrap mid-paragraph. Inherits every type property from the Callout by design. */}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-2 hover:no-underline"
            onClick={() => setSection("github")}
            data-testid="settings-setup-github-link"
          >
            Set up a GitHub App
          </button>{" "}
          to let other people in.
        </Callout>
      ) : null}

      {/* `items-start` so the nav column keeps its own height instead of
          stretching to the panel's: a stretched column puts nothing on screen
          but makes the eventual border/background of a nav item ambiguous
          about where the list ends. */}
      <div className="flex flex-1 items-start gap-10">
      <nav
        aria-label="Settings"
        className="flex w-44 flex-none flex-col gap-4"
        data-testid="settings-nav"
      >
        {/*
          `text-lg`, matching the section heading beside it (Mo, 2026-08-29:
          "make it so that the settings and the section header, e.g. Account,
          are aligned horizontally").

          Their box tops were ALREADY identical — MEASURED at 80px each. What
          read as misaligned was the baseline, 3px apart, because a 17px
          `text-xl` and a 15px `text-lg` have different ascents inside their
          line boxes. No amount of top-aligning fixes that; the two have to be
          the same size, or one needs a magic offset that breaks the moment
          either size changes.

          The page title gives way rather than the section heading, because
          `SettingsSection`'s bare title is shared with the Editor and this is
          a Viewer layout decision. The hierarchy survives on position and on
          the nav's own selected styling, which is what was carrying it
          anyway — two points of type scale were doing very little.
        */}
        <h1 className="px-2 text-lg font-medium">Settings</h1>
        <ul className="flex flex-col gap-0.5">
          {sections.map((s) => (
            <li key={s.id}>
              <ListRow
                selected={activeSection === s.id}
                aria-current={activeSection === s.id ? "page" : undefined}
                onClick={() => setSection(s.id)}
                data-testid={`settings-nav-${s.id}`}
                className={cn(
                  "text-base",
                  activeSection === s.id ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {s.label}
              </ListRow>
            </li>
          ))}
        </ul>
      </nav>

      {/* `min-w-0` so a long unbroken value inside a panel (a token, a URL)
          shrinks its own container instead of widening this column and
          pushing the layout sideways. */}
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        {activeSection === "account" ? <AccountPanel /> : null}
        {activeSection === "tokens" ? <TokensPanel /> : null}
        {activeSection === "members" ? <MembersPanel /> : null}
        {activeSection === "domains" ? <DomainRulesPanel /> : null}
        {activeSection === "github" ? <GithubPanel /> : null}
        {activeSection === "instance" ? <InstanceSettingsPanel /> : null}
        </div>
      </div>
    </div>
  )
}
