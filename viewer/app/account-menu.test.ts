// @vitest-environment jsdom

/**
 * `AccountMenu`'s signed-out "Sign in" href — viewer-membership Task 15.
 *
 * `/signin` is an extra hop, and it is only earned once there is a real
 * choice to make there: the ladder in `account-menu.tsx` sends a visitor
 * straight to GitHub's `signInUrl` when GitHub is the only method, and to
 * `/signin` whenever email sign-in is in the mix (alongside GitHub, or on
 * its own — email has no direct link of its own, only the page's form).
 *
 * No JSX transform is available here — `vitest.config.ts` only globs
 * `app/**\/*.test.ts` for this directory (see that file's `include`), and a
 * `.test.ts` extension gets the plain TypeScript loader, not the JSX one.
 * `React.createElement` is the workaround this codebase already uses for the
 * same constraint — see `app/settings/__tests__/panel-mutation-error-handling.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import React, { type ReactNode } from "react"
import {
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { AccountMenu } from "./account-menu"

/** The 2-line body `Scenario` (`gallery/harness/scenario.tsx`) has, redeclared
 * locally so this file needs no JSX to render it — see this file's doc comment. */
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

async function signInHref(me: unknown): Promise<string | null> {
  render(
    React.createElement(
      TestScenario,
      { routes: { "/api/v1/me": ok(me) } },
      React.createElement(AccountMenu),
    ),
  )
  const link = (await screen.findByTestId("sign-in")) as HTMLAnchorElement
  return link.getAttribute("href")
}

describe("AccountMenu — signed-out 'Sign in' target", () => {
  afterEach(() => cleanup())

  it("goes straight to GitHub when GitHub is the only configured method", async () => {
    const href = await signInHref({
      user: null,
      authEnabled: true,
      signInUrl: "/api/v1/auth/github",
      emailSignInEnabled: false,
    })
    expect(href).toBe("/api/v1/auth/github")
  })

  it("goes to /signin when email is the only configured method (there is no direct link for it)", async () => {
    const href = await signInHref({
      user: null,
      authEnabled: false,
      signInUrl: null,
      emailSignInEnabled: true,
    })
    expect(href).toBe("/signin")
  })

  it("goes to /signin when both methods are configured, not straight to GitHub", async () => {
    const href = await signInHref({
      user: null,
      authEnabled: true,
      signInUrl: "/api/v1/auth/github",
      emailSignInEnabled: true,
    })
    expect(href).toBe("/signin")
  })

  it("renders nothing when neither method is configured", async () => {
    let fetched = false
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": () => {
              fetched = true
              return ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: false })
            },
          },
        },
        React.createElement(AccountMenu),
      ),
    )
    // A dead "Sign in" button (nowhere to send them) is worse than none —
    // see `AccountMenu`'s own doc comment. Folded into one `waitFor` rather
    // than a fixed delay: once the mocked `/me` has actually been called,
    // absence is a permanent fact here, not a timing accident.
    //
    // The corner is NOT empty though (Mo, 2026-08-28). Settings has no other
    // entry point in the viewer, and this deployment shape is exactly the one
    // whose way out of "no sign-in configured" is the Settings page. Asserting
    // the link is present is what keeps a future "hide it when signed out"
    // from silently stranding the operator again.
    await waitFor(() => {
      expect(fetched).toBe(true)
      expect(screen.queryByTestId("sign-in")).toBeNull()
    })
    const settings = screen.getByTestId("settings-link") as HTMLAnchorElement
    expect(settings.getAttribute("href")).toBe("/settings")
  })
})
