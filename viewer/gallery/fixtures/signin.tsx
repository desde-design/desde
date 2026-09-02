import { useEffect } from "react"
import SignInPage from "../../app/signin/page"
import { ME_AUTH_DISABLED, ME_BOTH_SIGN_IN_METHODS, ME_EMAIL_ONLY, ME_SIGNED_OUT } from "../harness/fixture-data"
import { Scenario } from "../harness/scenario"
import { ok } from "@/components/gallery/fetch-override"
import { clickLikeUser, runDrivenInteraction, setNativeValue, waitForElement } from "@/components/gallery/dom-interaction"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * `/signin` — viewer-membership Task 15.
 *
 * `SignInPage` takes no props; every state below comes from mocking
 * `GET /api/v1/me`, the one call `useCurrentUser()` makes on mount (same
 * technique `account-menu.tsx`'s fixture uses, and for the same reason: the
 * page itself has no server-rendered snapshot, so nothing else can vary it).
 *
 * `ME_SIGNED_OUT` doubles as the "GitHub-only" state and `ME_AUTH_DISABLED`
 * as "neither" — both already mean exactly that shape (see their doc
 * comments in `fixture-data.ts`), and reusing them keeps this catalog
 * agreeing with the dashboard's and the settings page's about what those two
 * shapes look like.
 */

async function fillAndSubmitEmail(cancelled: () => boolean): Promise<void> {
  const input = await waitForElement(() =>
    document.querySelector<HTMLInputElement>('[data-testid="signin-email-input"]'),
  )
  if (!input || cancelled()) return
  setNativeValue(input, "reviewer@example.com")

  const button = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="signin-email-submit"]:not(:disabled)'),
  )
  if (!button || cancelled()) return
  clickLikeUser(button)
}

/** Fills the email field and submits it; the mocked POST always succeeds. */
function SubmittedFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(() => fillAndSubmitEmail(() => cancelled))
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <Scenario
      routes={{
        "/api/v1/me": ok(ME_BOTH_SIGN_IN_METHODS),
        // `ok({ok:true})` — the server's actual 202 body — but this form
        // decides "sent" purely off the status code, never off what's in it
        // (see `SignInPage`'s doc comment on the oracle discipline it
        // mirrors). Any 2xx body would drive this state identically.
        "POST /api/v1/auth/magic-link": ok({ ok: true }),
      }}
    >
      <SignInPage />
    </Scenario>
  )
}

export const SIGNIN_SURFACE: SurfaceEntry = {
  id: "signin",
  title: "Sign in",
  kind: "page",
  sourceFile: "viewer/app/signin/page.tsx",
  states: [
    {
      id: "signin/github-only",
      label: "GitHub only",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_OUT) }}>
          <SignInPage />
        </Scenario>
      ),
    },
    {
      id: "signin/email-only",
      label: "Email only",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_EMAIL_ONLY) }}>
          <SignInPage />
        </Scenario>
      ),
    },
    {
      id: "signin/both",
      label: "GitHub and email",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_BOTH_SIGN_IN_METHODS) }}>
          <SignInPage />
        </Scenario>
      ),
    },
    {
      id: "signin/neither",
      label: "Neither configured — local-operator sentence",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_AUTH_DISABLED) }}>
          <SignInPage />
        </Scenario>
      ),
    },
    {
      id: "signin/submitted",
      label: "Email submitted — link sent",
      readyWhen: '[data-testid="signin-email-sent"]',
      render: () => <SubmittedFixture />,
    },
  ],
}
