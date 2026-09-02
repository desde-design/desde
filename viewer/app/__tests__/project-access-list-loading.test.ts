// @vitest-environment jsdom

/**
 * Fix wave M2 review — the access list must not re-fetch when the user clicks
 * between the three access cards.
 *
 * `AccessList` used to own its own `members` state and fetch on mount, and it
 * is rendered only while the PENDING pick is `"invited"`. So the picker's
 * select-then-commit flow (a click selects, a footer button saves) turned
 * every trip through the cards into another `GET
 * /api/v1/projects/:id/members`: pick "Invited only", change your mind, pick
 * it again — three renders of the same list, three requests, and a visible
 * "Loading…" flash each time on a roster that had not changed.
 *
 * The fix lifts the list's data to `ProjectAccess`. This file pins the
 * OBSERVABLE consequence rather than the implementation: count the requests
 * that actually leave the component while the user toggles.
 *
 * Uses the gallery's fetch-override harness (`routeTable`/`useFetchOverride`)
 * rather than `vi.stubGlobal("fetch", …)` — see the long note in
 * `app/settings/__tests__/panel-mutation-error-handling.test.ts` for why a raw
 * global stub collides with `gallery-test-setup.ts` across files sharing a
 * worker. `React.createElement` rather than JSX for the same reason that file
 * gives: this path has no JSX transform (`vitest.config.ts` only globs `.tsx`
 * under `gallery/**`).
 */

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { clickLikeUser } from "@/components/gallery/dom-interaction"
import { ProjectAccess, type ProjectAccessValue } from "../project-access"

const PROJECT_ID = "p-1"
const MEMBERS_ROUTE = `GET /api/v1/projects/${PROJECT_ID}/members`

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

/**
 * One segment of the access picker.
 *
 * By `data-testid`, not by the control's internals: the picker was a Radix
 * radio group (`[data-slot="radio-group-item"][value=…]`) until 2026-08-29 and
 * is a segmented `ToggleGroup` now. The testid is the part that is meant to
 * survive that, and it is what these tests are actually about — the fetch
 * behaviour behind a selection, not the widget drawing it.
 */
function optionControl(value: ProjectAccessValue): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-slot="radio-group-item"][value="${value}"]`,
  )
}

/**
 * Opens the picker, which is closed at rest since 2026-08-29: the dialog
 * shows the current value with an Edit button, and the segments only exist
 * once Edit is pressed. No-op when it is already open.
 */
async function openAccessPicker(): Promise<void> {
  const edit = document.querySelector<HTMLButtonElement>('[data-testid="access-edit"]')
  if (!edit) return
  // Inside `act`, so React has committed the picker before the caller looks
  // for a segment. A bare click leaves the DOM one render behind.
  await act(async () => {
    clickLikeUser(edit)
  })
}

async function pick(value: ProjectAccessValue): Promise<void> {
  await openAccessPicker()
  const control = optionControl(value)
  expect(control, `no access segment for ${value}`).not.toBeNull()
  await act(async () => {
    clickLikeUser(control!)
  })
}

afterEach(() => {
  cleanup()
})

describe("ProjectAccess — the access list loads once per dialog opening", () => {
  function renderPanel(initial: ProjectAccessValue, onMembersRequest: () => void) {
    return render(
      React.createElement(
        TestScenario,
        {
          routes: {
            [MEMBERS_ROUTE]: () => {
              onMembersRequest()
              return ok({ members: MEMBERS })
            },
          },
        },
        React.createElement(ProjectAccess, {
          projectId: PROJECT_ID,
          access: initial,
          publicLinksEnabled: true,
          canManage: true,
          currentUserLoading: false,
          open: true,
        }),
      ),
    )
  }

  it("does not re-fetch when the user clicks between segments before saving", async () => {
    let requests = 0
    renderPanel("all-members", () => {
      requests += 1
    })

    // Nothing yet: the list is meaningless for "All members", so a dialog
    // opened there makes no request at all.
    expect(requests).toBe(0)

    await pick("invited")
    await waitFor(() => expect(requests).toBe(1))

    // Away and back, twice. Every one of these unmounted `AccessList` before
    // the fix, and every remount fetched again.
    await pick("all-members")
    await pick("invited")
    await pick("public-link")
    await pick("invited")

    // Give any stray effect a chance to fire before asserting it did not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(requests).toBe(1)
  })

  /**
   * Was "keeps the loaded rows on screen across a toggle". They are not on
   * screen across a toggle any more — the picker is its own screen since
   * 2026-08-29 and deliberately hides the roster, so "visible throughout" is
   * no longer a property this component has.
   *
   * What it was really pinning survives and is what this checks now: the rows
   * come BACK from state the parent still holds, on the first commit after
   * returning, with no second fetch and no loading flash. That is the whole
   * reason `members` lives in the parent rather than in `AccessList`.
   */
  it("restores the loaded rows from state after editing — no re-fetch, no loading flash", async () => {
    let requests = 0
    const { container } = renderPanel("invited", () => {
      requests += 1
    })

    await waitFor(() => expect(container.textContent).toContain("Rin"))
    await waitFor(() => expect(requests).toBe(1))

    // Into the picker and back out. `pick` opens it; Cancel returns.
    await pick("all-members")
    await pick("invited")
    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="access-cancel"]')
    expect(cancel, "no Cancel to return with").not.toBeNull()
    await act(async () => {
      clickLikeUser(cancel!)
    })

    expect(container.textContent).toContain("Rin")
    expect(container.textContent).not.toContain("Loading")
    expect(requests, "the roster was re-fetched on the way back").toBe(1)
  })

  it("makes no request at all when the caller cannot manage the project", async () => {
    let requests = 0
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            [MEMBERS_ROUTE]: () => {
              requests += 1
              return ok({ members: MEMBERS })
            },
          },
        },
        React.createElement(ProjectAccess, {
          projectId: PROJECT_ID,
          access: "invited" as ProjectAccessValue,
          publicLinksEnabled: true,
          canManage: false,
          currentUserLoading: false,
          open: true,
        }),
      ),
    )

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(requests).toBe(0)
  })
})
