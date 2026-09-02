// @vitest-environment jsdom

/**
 * `ProjectRepoPanel`'s signed-out CTA — viewer-membership Fix wave 4 (codex
 * round-4).
 *
 * Same defect as `TokensPanel` (see
 * `settings/__tests__/tokens-panel-signin-availability.test.ts`): the
 * signed-out branch used to check `!authEnabled` — which means only "GitHub
 * sign-in is configured" — to decide between a "Sign in" CTA and "Sign-in
 * isn't configured". A deployment with email sign-in but no GitHub App
 * (`authEnabled: false`, `emailSignInEnabled: true`) got the "not
 * configured" copy even though a visitor COULD sign in. The fix reads
 * `signInUrl` / `emailSignInEnabled` instead, matching `AccountMenu`'s
 * ladder.
 *
 * `derivePanelAccess` (`project-repo-utils.ts`) itself never referenced
 * `authEnabled` — only the component's signed-out RENDER branch did — so
 * this file exercises the component directly rather than the pure helper.
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { ProjectRepoPanel } from "../project-repo-panel"

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

const PID = "p-1"

afterEach(() => {
  cleanup()
})

describe("ProjectRepoPanel — signed-out CTA follows signInUrl/emailSignInEnabled, not authEnabled", () => {
  it("offers a 'Sign in' CTA when signed out but email sign-in is the only method (authEnabled: false)", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: true }),
            [`/api/v1/projects/${PID}`]: ok({ repoConfig: null }),
          },
        },
        React.createElement(ProjectRepoPanel, { projectId: PID }),
      ),
    )

    const link = (await screen.findByRole("link", { name: /sign in/i })) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/signin")
    expect(screen.queryByText(/sign-in isn.t configured on this viewer/i)).toBeNull()
  })

  it("still shows the 'not configured' copy when neither sign-in method exists", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: false }),
            [`/api/v1/projects/${PID}`]: ok({ repoConfig: null }),
          },
        },
        React.createElement(ProjectRepoPanel, { projectId: PID }),
      ),
    )

    expect(await screen.findByText(/sign-in isn.t configured on this viewer/i)).toBeTruthy()
  })
})
