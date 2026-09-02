// @vitest-environment jsdom

/**
 * `MembersPanel` self-mutation — viewer-membership Fix wave 4 (codex
 * round-4).
 *
 * `handleRoleChange` / `handleRemove` used to update ONLY this panel's own
 * `members` list on success — never the shared `useCurrentUser()` state
 * every other panel on the settings page reads. So a caller who changed
 * their OWN role kept acting under the OLD role (a demoted admin still saw
 * admin-only sections) until the next full page load, and a caller who
 * removed their OWN account kept seeing the whole settings page as if
 * nothing had happened, sitting on a session the server had just killed.
 *
 * The fix: `SignedInMembersPanel` calls `useCurrentUser()`'s `refresh()`
 * after a successful role change or removal of the CALLER'S OWN row (never
 * another member's), and after a self-REMOVAL specifically, navigates to
 * `/` — there is no page left to update in place once the account is gone.
 *
 * Uses the gallery's fetch-override harness — see the long note in
 * `panel-mutation-error-handling.test.ts` for why a raw `vi.stubGlobal
 * ("fetch", …)` collides with `gallery-test-setup.ts`'s global jsdom shims
 * across files sharing a worker. `React.createElement` rather than JSX for
 * the same reason that file gives: no JSX transform for `.test.ts` outside
 * `gallery/**`.
 *
 * Renders `MembersPanel` inside `CurrentUserProvider` — matching how
 * `settings/page.tsx` actually mounts it (wrapped in `CurrentUserBoundary`)
 * — because `SignedInMembersPanel` now calls `useCurrentUser()` a SECOND
 * time (alongside `MembersPanel`'s own admin-gating call). Without a shared
 * provider, each call falls back to its OWN independent fetch (see
 * `use-current-user.tsx`'s "no provider ancestor" fallback), which would
 * make every `/me` count below off by one from what production ever does.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ME_SIGNED_IN } from "../../../gallery/harness/fixture-data"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { clickLikeUser, findByText, waitForElement } from "@/components/gallery/dom-interaction"
import { CurrentUserProvider } from "../../use-current-user"
import { MembersPanel } from "../members-panel"

function TestScenario({
  routes,
  children,
}: {
  routes: Record<string, FetchOverrideResult | (() => FetchOverrideResult)>
  children?: ReactNode
}): ReactNode {
  useFetchOverride(routeTable(routes))
  return React.createElement(CurrentUserProvider, null, children ?? null)
}

// `ME_SIGNED_IN.user.id` is "user-mo" — the caller these tests act as.
const CALLER_ID = ME_SIGNED_IN.user.id

const SELF_MEMBER = {
  userId: CALLER_ID,
  email: ME_SIGNED_IN.user.email,
  displayName: ME_SIGNED_IN.user.displayName,
  avatarUrl: "",
  role: "admin",
  status: "active",
  createdAt: "2020-01-01T00:00:00.000Z",
}

const OTHER_MEMBER = {
  userId: "u-other",
  email: "dana@example.com",
  displayName: "Dana Whitfield",
  avatarUrl: "",
  role: "viewer",
  status: "active",
  createdAt: "2020-01-01T00:00:00.000Z",
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("MembersPanel — self-mutation refreshes the shared current-user state", () => {
  it("refetches /me and navigates to / after removing the CALLER'S OWN row", async () => {
    let meCalls = 0
    const assign = vi.fn()
    vi.stubGlobal("location", { ...window.location, assign })

    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": () => {
              meCalls += 1
              return ok(ME_SIGNED_IN)
            },
            "GET /api/v1/instance/members": ok({ members: [SELF_MEMBER, OTHER_MEMBER] }),
            "GET /api/v1/instance/invites": ok({ invites: [] }),
            "DELETE /api/v1/instance/members": ok({}),
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    const removeButton = await screen.findByRole("button", {
      name: new RegExp(`remove ${SELF_MEMBER.displayName}`, "i"),
    })
    await waitFor(() => expect(meCalls).toBe(1))

    await act(async () => {
      removeButton.click()
    })

    await waitFor(() => {
      expect(meCalls).toBe(2)
      expect(assign).toHaveBeenCalledWith("/")
    })
  })

  it("does NOT refetch /me after removing a DIFFERENT member's row", async () => {
    let meCalls = 0
    let membersCalls = 0

    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": () => {
              meCalls += 1
              return ok(ME_SIGNED_IN)
            },
            "GET /api/v1/instance/members": () => {
              membersCalls += 1
              return ok({ members: [SELF_MEMBER, OTHER_MEMBER] })
            },
            "GET /api/v1/instance/invites": ok({ invites: [] }),
            "DELETE /api/v1/instance/members": ok({}),
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    const removeButton = await screen.findByRole("button", {
      name: new RegExp(`remove ${OTHER_MEMBER.displayName}`, "i"),
    })
    await waitFor(() => expect(membersCalls).toBe(1))
    expect(meCalls).toBe(1)

    await act(async () => {
      removeButton.click()
    })

    // Waits for the DELETE's own follow-up `load()` (which re-fetches the
    // member list) to settle before asserting `/me` silence — otherwise this
    // could pass simply because the mutation hadn't finished yet.
    await waitFor(() => expect(membersCalls).toBe(2))
    expect(meCalls).toBe(1)
  })

  it("refetches /me after changing the CALLER'S OWN role via the row Select, not another member's", async () => {
    let meCalls = 0

    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": () => {
              meCalls += 1
              return ok(ME_SIGNED_IN)
            },
            "GET /api/v1/instance/members": ok({ members: [SELF_MEMBER, OTHER_MEMBER] }),
            "GET /api/v1/instance/invites": ok({ invites: [] }),
            "PATCH /api/v1/instance/members": ok({}),
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    await screen.findByText(SELF_MEMBER.displayName)
    await waitFor(() => expect(meCalls).toBe(1))

    // Scoped to `[data-slot="list-row"]`: the page ALSO has a role `Select`
    // in the "Invite by email" form below, which is a third `combobox` a
    // plain `getAllByRole` would catch. Document order within the member
    // rows: `SELF_MEMBER` renders before `OTHER_MEMBER` (list order mirrors
    // the fixture's `members` array), so the first row combobox is the
    // caller's OWN row.
    const triggers = document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="list-row"] [role="combobox"]',
    )
    expect(triggers).toHaveLength(2)
    clickLikeUser(triggers[0])

    const editorOption = await waitForElement(() =>
      findByText<HTMLElement>('[role="option"]', /^editor$/i),
    )
    expect(editorOption, "role picker never opened").not.toBeNull()
    await act(async () => {
      if (editorOption) clickLikeUser(editorOption)
    })

    await waitFor(() => expect(meCalls).toBe(2))
  })
})
