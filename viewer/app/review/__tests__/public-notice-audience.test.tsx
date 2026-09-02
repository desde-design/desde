// @vitest-environment jsdom

/**
 * The "No authentication" banner is for members, not for visitors.
 *
 * It fires on a `public-link` project while the instance kill switch is on,
 * and it says: "No authentication. Anyone with the link can view this
 * project." followed by a link to Settings.
 *
 * That is useful to someone who signed in and may not realise the project is
 * open. It is not useful to an anonymous visitor, who reached this page
 * WITHOUT signing in and has therefore just demonstrated the fact the banner
 * is reporting. Worse, its one action goes to Settings, which an anonymous
 * visitor cannot open, so it is a warning aimed at the wrong person with a
 * link they cannot follow. Same shape as the disabled project card fixed
 * earlier the same day.
 *
 * MEASURED on the public demo at demo.desde.design, which is deliberately
 * open with no sign-in configured at all: every visitor's first sight of the
 * product was a warning that its intended configuration was a mistake.
 *
 * The first test below fails against the pre-fix code, which showed the
 * banner to everyone.
 */

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { ReviewShell, type ReviewShellProject } from "../[slug]/review-shell"
import { PROTOTYPE_ORIGIN } from "./fake-bridge-frame"

const PROJECT_ID = "proj-public"

/** Open to anyone with the link, and the instance allows that. */
const PUBLIC_PROJECT: ReviewShellProject = {
  id: PROJECT_ID,
  slug: "demo",
  name: "Demo",
  access: "public-link",
  publicLinksEnabled: true,
  serveDomain: null,
  capability: null,
  shellOrigin: "https://demo.desde.design",
  prototypeOrigin: PROTOTYPE_ORIGIN,
  mode: "loopback",
}

function signedInAs(role: "admin" | "editor" | "viewer") {
  return {
    user: {
      id: "u1",
      email: "member@example.com",
      displayName: "A Member",
      role,
      status: "active",
      provider: "github",
      providerUserId: "1",
      avatarUrl: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    authEnabled: true,
  }
}

/** What `/api/v1/me` answers for a visitor who never signed in. */
const ANONYMOUS = { user: null, authEnabled: false }

function routes(me: unknown): Record<string, FetchOverrideResult | (() => FetchOverrideResult)> {
  return {
    [`GET /api/v1/projects/${PROJECT_ID}/comments`]: ok({ comments: [] }),
    [`GET /api/v1/projects/${PROJECT_ID}/members`]: ok({ members: [] }),
    [`GET /api/v1/projects/${PROJECT_ID}/participants`]: ok({ participants: [] }),
    "GET /api/v1/me": ok(me),
  }
}

function Scenario({ me, children }: { me: unknown; children: ReactNode }): ReactNode {
  useFetchOverride(routeTable(routes(me)))
  return children
}

afterEach(() => {
  cleanup()
})

describe("the public-link notice", () => {
  it("is NOT shown to an anonymous visitor, who already knows no sign-in was needed", async () => {
    render(
      <Scenario me={ANONYMOUS}>
        <ReviewShell project={PUBLIC_PROJECT} />
      </Scenario>,
    )

    // `/api/v1/me` resolves on a later tick, so wait for the shell to settle
    // rather than asserting on the first frame, which would pass trivially.
    await waitFor(() => {
      expect(screen.queryByTestId("public-notice")).toBeNull()
    })
    // And stays absent once everything has settled.
    expect(screen.queryByTestId("public-notice")).toBeNull()
  })

  it("is NOT shown to a signed-in EDITOR, whose only action would 404", async () => {
    // The banner's one action links to `?section=github`, which lives in
    // SettingsNav's ADMIN_SECTIONS. An editor deep-linking there does not get
    // that section. Gating on "signed in" alone fixed the anonymous dead end
    // and left the identical one here, one role along. Found by a codex review
    // of that first fix.
    render(
      <Scenario me={signedInAs("editor")}>
        <ReviewShell project={PUBLIC_PROJECT} />
      </Scenario>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId("public-notice")).toBeNull()
    })
    expect(screen.queryByTestId("public-notice")).toBeNull()
  })

  it("IS shown to an admin, the one reader who can act on it", async () => {
    // The control. Without this, every case above would also pass if the
    // banner had simply been deleted.
    render(
      <Scenario me={signedInAs("admin")}>
        <ReviewShell project={PUBLIC_PROJECT} />
      </Scenario>,
    )

    await waitFor(() => {
      expect(screen.queryByTestId("public-notice")).not.toBeNull()
    })
  })
})
