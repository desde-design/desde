// @vitest-environment jsdom

/**
 * Fix wave 3 (codex round-3). `AccessList.handleRemove` in `project-access.tsx`
 * did `try { const res = await fetch(...); ... } finally { setRemovingUserId(null) }`
 * with NO `catch` — the same shape `panel-mutation-error-handling.test.ts`
 * documents for the members/domain-rules/instance-settings panels, just missed
 * in that pass because this component lives elsewhere. A rejected `fetch`
 * (offline, DNS failure, an aborted request) propagated straight out of the
 * `useCallback`, past the `void handleRemove(...)` at the click site, and into
 * an unhandled promise rejection. Nothing on screen ever showed it: the button
 * re-enabled (the `finally` still ran), but `membersError` — the thing a
 * person would actually see — stayed `null` forever.
 *
 * Uses the gallery's fetch-override harness for the same reason
 * `project-access-list-loading.test.ts` and `panel-mutation-error-handling.test.ts`
 * do: a raw `vi.stubGlobal("fetch", …)` collides with `gallery-test-setup.ts`
 * across files sharing a worker. `React.createElement` rather than JSX for the
 * same reason those files give: this path has no JSX transform.
 */

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { NETWORK_ERROR, ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { ProjectAccess } from "../project-access"

const PROJECT_ID = "p-1"
const MEMBERS_ROUTE = `GET /api/v1/projects/${PROJECT_ID}/members`
const REMOVE_ROUTE = `DELETE /api/v1/projects/${PROJECT_ID}/members`

const MEMBERS = [
  { userId: "u-1", createdAt: "2026-01-01T00:00:00.000Z", email: "rin@x.com", displayName: "Rin", avatarUrl: "" },
]

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

afterEach(() => {
  cleanup()
})

describe("ProjectAccess — a rejected removal surfaces in the error state instead of vanishing", () => {
  it("handleRemove: an offline DELETE shows the fallback failure message, not an unhandled rejection", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            [MEMBERS_ROUTE]: ok({ members: MEMBERS }),
            [REMOVE_ROUTE]: NETWORK_ERROR,
          },
        },
        React.createElement(ProjectAccess, {
          projectId: PROJECT_ID,
          access: "invited",
          publicLinksEnabled: true,
          canManage: true,
          currentUserLoading: false,
          open: true,
        }),
      ),
    )

    const removeButton = await screen.findByRole("button", { name: /remove rin/i })
    await act(async () => {
      removeButton.click()
    })

    // `failureMessage` on a plain thrown error (not an `ApiError`) is always
    // this exact sentence — see `api-client.ts`.
    expect(await screen.findByText("Something went wrong. Try again.")).toBeTruthy()
  })
})
