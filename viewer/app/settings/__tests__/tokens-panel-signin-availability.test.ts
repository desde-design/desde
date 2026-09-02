// @vitest-environment jsdom

/**
 * `TokensPanel`'s decision order — viewer-membership Fix wave 4 (codex
 * round-4).
 *
 * `authEnabled` (`/api/v1/me`'s field, mirrored by `use-current-user.tsx`)
 * means ONLY "GitHub sign-in is configured" — it says nothing about whether
 * THIS caller is signed in, or about any OTHER sign-in method (email) this
 * deployment might have. `TokensPanel` used to check `!authEnabled` BEFORE
 * `user`, so a member signed in via an invite link or a magic link on an
 * SMTP-only instance (no GitHub App at all) saw "Sign-in isn't configured...
 * machine tokens aren't available" while sitting on a perfectly valid
 * session.
 *
 * The fix reorders the checks: `user` present wins regardless of provider
 * flags; only when NOBODY is signed in does the panel look at `signInUrl` /
 * `emailSignInEnabled` to choose between a sign-in CTA and the "not
 * configured" copy — the same ladder `AccountMenu` uses.
 *
 * Uses the gallery's fetch-override harness rather than `vi.stubGlobal
 * ("fetch", …)` — see the long note in
 * `panel-mutation-error-handling.test.ts` for why a raw global stub collides
 * with `gallery-test-setup.ts`'s shims across files sharing a worker.
 * `React.createElement` rather than JSX for the same reason that file gives:
 * this path has no JSX transform (`vitest.config.ts` only globs `.tsx`
 * under `gallery/**`).
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { TokensPanel } from "../tokens-panel"

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

afterEach(() => {
  cleanup()
})

describe("TokensPanel — signed-in wins over authEnabled", () => {
  it("renders the signed-in token UI for a user signed in on an SMTP-only instance (authEnabled: false)", async () => {
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
            "GET /api/v1/tokens": ok({ tokens: [] }),
          },
        },
        React.createElement(TokensPanel),
      ),
    )

    expect(await screen.findByText(/create token/i)).toBeTruthy()
    expect(screen.queryByText(/sign-in isn.t configured/i)).toBeNull()
  })

  it("offers a 'Sign in' CTA (not 'not configured') when signed out but email sign-in is the only method", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: true }),
          },
        },
        React.createElement(TokensPanel),
      ),
    )

    const link = (await screen.findByRole("link")) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/signin")
    expect(screen.queryByText(/sign-in isn.t configured/i)).toBeNull()
  })

  it("still shows the 'not configured' copy when neither sign-in method exists", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok({ user: null, authEnabled: false, signInUrl: null, emailSignInEnabled: false }),
          },
        },
        React.createElement(TokensPanel),
      ),
    )

    expect(await screen.findByText(/sign-in isn.t configured/i)).toBeTruthy()
  })
})
