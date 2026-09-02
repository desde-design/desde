// @vitest-environment jsdom

/**
 * `AccountPanel`'s decision order — the third component to carry this defect.
 *
 * `authEnabled` (`/api/v1/me`'s field, mirrored by `use-current-user.tsx`)
 * means ONLY "GitHub sign-in is configured". It says nothing about whether
 * THIS caller is signed in, and nothing about the other three ways into the
 * product: an invite link, a magic link, and the local-operator boot link.
 *
 * `AccountPanel` checked `!authEnabled` BEFORE `user` and rendered "Sign-in
 * isn't configured on this deployment, so there is no account to show". So
 * anyone signed in on an instance without a GitHub App was told they had no
 * account while holding a valid session.
 *
 * MEASURED 2026-08-28 on a real zero-config viewer: sign in with the boot
 * link, open Settings, and the Account section says there is no account while
 * the nav beside it renders all four admin-only sections — which only an
 * Admin can see. That is the DEFAULT path for a new instance.
 *
 * `TokensPanel` and `ProjectRepoPanel` were both fixed for the same defect in
 * viewer-membership Fix wave 4 (codex round-4) and have their own regression
 * tests beside this one; `AccountPanel` was missed, even though the fixture
 * that exposes it (`ME_SIGNED_IN_EMAIL_ONLY`) already existed and was pointed
 * at the Tokens section.
 *
 * Uses the gallery's fetch-override harness rather than `vi.stubGlobal
 * ("fetch", …)` — see the long note in `panel-mutation-error-handling.test.ts`
 * for why a raw global stub collides with `gallery-test-setup.ts`'s shims
 * across files sharing a worker. `React.createElement` rather than JSX for the
 * same reason that file gives: this path has no JSX transform
 * (`vitest.config.ts` only globs `.tsx` under `gallery/**`).
 */

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { AccountPanel } from "../account-panel"
import { SettingsNav } from "../settings-nav"

function TestScenario({
  routes,
  children,
}: {
  routes: Record<string, FetchOverrideResult | (() => FetchOverrideResult)>
  children?: ReactNode
}): ReactNode {
  useFetchOverride(routeTable(routes))
  return children ?? null
}

const EMAIL_USER = {
  id: "user-dana-email",
  provider: "email" as const,
  email: "dana@example.com",
  displayName: "Dana Whitfield",
  avatarUrl: "",
  role: "editor" as const,
  createdAt: "2026-08-10T09:00:00.000Z",
}

/** The local operator: Admin, signed in, on an instance with no GitHub App. */
const LOCAL_OPERATOR = {
  id: "user-local-operator",
  provider: "github" as const,
  email: "operator@localhost",
  displayName: "Local operator",
  avatarUrl: "",
  role: "admin" as const,
  createdAt: "2026-08-28T09:00:00.000Z",
}

afterEach(() => {
  cleanup()
})

describe("AccountPanel — signed in wins over authEnabled", () => {
  it("shows the account for a member signed in on an instance with no GitHub App", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: EMAIL_USER,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: true,
            }),
          },
        },
        React.createElement(AccountPanel),
      ),
    )

    expect(await screen.findByText("Dana Whitfield")).toBeTruthy()
    expect(screen.getByText("dana@example.com")).toBeTruthy()
    expect(screen.queryByText(/no account to show/i)).toBeNull()
    expect(screen.queryByText(/sign-in isn.t configured/i)).toBeNull()
  })

  it("shows the account for the local operator, the default zero-config path", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: LOCAL_OPERATOR,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: false,
            }),
          },
        },
        React.createElement(AccountPanel),
      ),
    )

    expect(await screen.findByText("Local operator")).toBeTruthy()
    expect(screen.queryByText(/no account to show/i)).toBeNull()
  })
})

/**
 * The GitHub-setup prompt moved out of `AccountPanel` on 2026-08-29: it is a
 * fact about the VIEWER, not about the account you happen to be signed in as,
 * so it is now a banner across the top of Settings (`SettingsNav`). These
 * three cases follow it, because what they pin is not where it renders but
 * WHO is offered it — and that is a server-shaped rule: `requireOperator` on
 * the manifest route accepts an admin session and refuses everyone else.
 */
describe("SettingsNav — the GitHub setup banner is gated on who the server accepts", () => {
  it("offers GitHub setup to a signed-in Admin when no GitHub sign-in exists", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: LOCAL_OPERATOR,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: false,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    expect(await screen.findByTestId("settings-setup-github")).toBeTruthy()
  })

  it("is dismissable", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: LOCAL_OPERATOR,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: false,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    const banner = await screen.findByTestId("settings-setup-github")
    const dismiss = within(banner).getByRole("button", { name: /dismiss/i })
    act(() => dismiss.click())
    expect(screen.queryByTestId("settings-setup-github")).toBeNull()
  })

  it("does NOT offer it to a non-admin: the manifest route would refuse them", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: EMAIL_USER,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: true,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    // Waits on something that DOES render for this user, so the assertion
    // below is about absence rather than about arriving early.
    expect(await screen.findByTestId("settings-nav")).toBeTruthy()
    expect(screen.queryByTestId("settings-setup-github")).toBeNull()
  })

  it("does NOT offer it once GitHub sign-in is configured", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: { ...LOCAL_OPERATOR, role: "admin" as const },
              authEnabled: true,
              signInUrl: "/api/v1/auth/github",
              emailSignInEnabled: false,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    expect(await screen.findByTestId("settings-nav")).toBeTruthy()
    expect(screen.queryByTestId("settings-setup-github")).toBeNull()
  })
})

/*
 * The signed-out states moved UP on 2026-08-31 (Mo: "collapse into one
 * signed out message"): `SettingsNav` now collapses the whole page before
 * any panel mounts, so these cases render the nav, not the panel — same
 * assertions, new owner.
 */
describe("SettingsNav — signed out collapses the page to one message", () => {
  it("offers a 'Sign in' CTA through /signin when email is the only method", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: null,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: true,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    const link = (await screen.findByRole("link", { name: /sign in/i })) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/signin")
    // The collapse is total: no section nav renders for a signed-out caller.
    expect(screen.queryByTestId("settings-nav")).toBeNull()
  })

  it("points at the local sign-in link, not a dead end, when nothing is configured", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({
              user: null,
              authEnabled: false,
              signInUrl: null,
              emailSignInEnabled: false,
            }),
          },
        },
        React.createElement(SettingsNav),
      ),
    )

    // The next step is a session, and the boot link is the only way to one.
    // Say where it comes from and what produces a fresh one, without sending
    // the reader to a terminal they may not have.
    expect(await screen.findByText(/one-time link, printed once when it starts/i)).toBeTruthy()
    // And a way out. This state cannot offer sign-in, so without a link home
    // it is a page with no control on it at all, which is what shipped until
    // 2026-09-01. The test's name has always claimed otherwise.
    expect(screen.getByRole("link", { name: /back to projects/i })).toBeTruthy()
    // And NOT a setup button: an anonymous caller is refused by
    // `requireOperator`, so offering it would navigate them to a 401.
    expect(screen.queryByRole("button", { name: /set up github sign-in/i })).toBeNull()
  })
})
