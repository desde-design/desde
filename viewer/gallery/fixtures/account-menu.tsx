"use client"

import { useEffect } from "react"
import { AccountMenu } from "../../app/account-menu"
import { ME_AUTH_DISABLED, ME_SIGNED_OUT, SAMPLE_USER } from "../harness/fixture-data"
import { PanelFrame, Scenario } from "../harness/scenario"
import { ok, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import {
  clickLikeUser,
  runDrivenInteraction,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The header's sign-in / account affordance.
 *
 * The signed-in states below all OPEN the menu, because as of 2026-08-19 the
 * closed trigger is a bare person glyph — the avatar photo, the display name
 * and the email all moved inside the menu, which is where they do their job
 * of confirming which account this is. A fixture that showed the closed
 * button would be showing one icon, seven times. It takes no data props — every
 * state below comes from mocking `GET /api/v1/me`, the one call
 * `useCurrentUser()` makes on mount (see `viewer/app/use-current-user.ts`).
 *
 * Reusing `SAMPLE_USER`'s identity (id/email/provider/createdAt) and varying
 * only `displayName`/`avatarUrl` per state, rather than inventing new people,
 * per the harness's reuse rule — these overrides exist to exercise the
 * chip's own branches (initials math, truncation), not to add new cast
 * members to the gallery's story.
 */

/** `.invalid` is a reserved TLD (RFC 2606) — this can never resolve, so the
 * avatar image deterministically fails and the initials fallback shows. */
const BROKEN_AVATAR_URL = "https://gallery.invalid/broken-avatar.png"

const ME_SIGNED_IN_WORKING_AVATAR = ok({ user: SAMPLE_USER, authEnabled: true })

const ME_BROKEN_AVATAR = ok({
  user: { ...SAMPLE_USER, avatarUrl: BROKEN_AVATAR_URL },
  authEnabled: true,
})

const ME_SINGLE_WORD_NAME = ok({
  user: { ...SAMPLE_USER, displayName: "Mo", avatarUrl: BROKEN_AVATAR_URL },
  authEnabled: true,
})

const ME_EMPTY_NAME = ok({
  user: { ...SAMPLE_USER, displayName: "", avatarUrl: BROKEN_AVATAR_URL },
  authEnabled: true,
})

const ME_LONG_NAME = ok({
  user: {
    ...SAMPLE_USER,
    displayName: "Alexandria Montgomery-Fitzgerald",
    avatarUrl: BROKEN_AVATAR_URL,
  },
  authEnabled: true,
})

/**
 * Opens the menu, so a state can show what is inside it.
 *
 * `waitForElement` rather than an immediate query: the trigger only mounts
 * after `useCurrentUser`'s `/api/v1/me` fetch resolves, which is a tick after
 * the first commit.
 */
function OpenMenu({ me }: { me: FetchOverrideResult }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const trigger = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="account-menu"]'),
      )
      if (cancelled || !trigger) return
      clickLikeUser(trigger)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <Scenario routes={{ "/api/v1/me": me }}>
      <PanelFrame>
        <AccountMenu />
      </PanelFrame>
    </Scenario>
  )
}

export const ACCOUNT_MENU_SURFACE: SurfaceEntry = {
  id: "account-menu",
  title: "Account chip",
  kind: "inline",
  sourceFile: "viewer/app/account-menu.tsx",
  states: [
    {
      id: "account-menu/signed-in-avatar",
      label: "Menu open — avatar, name and email",
      readyWhen: '[role="menu"]',
      render: () => <OpenMenu me={ME_SIGNED_IN_WORKING_AVATAR} />,
    },
    {
      id: "account-menu/avatar-fallback-initials",
      label: "Signed in — broken avatar, initials fallback (\"Mo Chang\" → MC)",
      readyWhen: '[role="menu"]',
      render: () => <OpenMenu me={ME_BROKEN_AVATAR} />,
    },
    {
      id: "account-menu/single-word-name",
      label: "Initials — single-word name (\"Mo\" → M)",
      readyWhen: '[role="menu"]',
      render: () => <OpenMenu me={ME_SINGLE_WORD_NAME} />,
    },
    {
      id: "account-menu/empty-name",
      label: "Initials — empty display name (→ ?)",
      readyWhen: '[role="menu"]',
      render: () => <OpenMenu me={ME_EMPTY_NAME} />,
    },
    {
      id: "account-menu/long-name-truncated",
      label: "Menu open — long name truncates",
      readyWhen: '[role="menu"]',
      render: () => <OpenMenu me={ME_LONG_NAME} />,
    },
    {
      id: "account-menu/signed-out",
      label: "Signed out — Sign in",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_OUT) }}>
          <PanelFrame>
            <AccountMenu />
          </PanelFrame>
        </Scenario>
      ),
    },
    {
      id: "account-menu/hidden-auth-disabled",
      label: "Hidden — signed out, nowhere to send them",
      render: () => (
        // `ME_AUTH_DISABLED`: `user: null` and `signInUrl: null` together —
        // the third of the component's three states. `AccountMenu` keys off
        // `signInUrl`, not `authEnabled`; this deployment has no GitHub App
        // configured, so both are set (see the fixture's own doc comment),
        // but it's `signInUrl: null` that the component actually reads.
        <Scenario routes={{ "/api/v1/me": ok(ME_AUTH_DISABLED) }}>
          <PanelFrame>
            {/* The chip renders null here — this line is the only reason
                the panel isn't empty. A fetch failure (network error,
                non-200, the 5s timeout, unparsable JSON) renders this
                exact same nothing; only a console.warn differs, so that
                path isn't built as a separate state. */}
            <p className="text-2xs text-muted-foreground">
              AccountMenu renders nothing below this line.
            </p>
            <AccountMenu />
          </PanelFrame>
        </Scenario>
      ),
    },
  ],
}
