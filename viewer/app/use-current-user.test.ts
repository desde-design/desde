// @vitest-environment jsdom

/**
 * `useCurrentUser()`'s `refresh()` — viewer-membership Fix wave 4 (codex
 * round-4).
 *
 * Added because every panel on the settings page reads `/api/v1/me` once,
 * at mount, and never again — so after a member changes their OWN role, or
 * removes their OWN account, the client keeps acting on a role (or a
 * session) the server no longer has. `refresh()` re-fetches `/me` and
 * updates every field the hook returns; `members-panel.tsx` calls it after
 * a self-mutation (see `settings/__tests__/members-panel-self-refresh.test.ts`).
 *
 * Uses the gallery's fetch-override harness rather than `vi.stubGlobal
 * ("fetch", …)` — see the long note in
 * `settings/__tests__/panel-mutation-error-handling.test.ts` for why a raw
 * global stub collides with `gallery-test-setup.ts`'s shims across files
 * sharing a worker. `React.createElement` rather than JSX for the same
 * reason that file gives: this path has no JSX transform (`vitest.config.ts`
 * only globs `.tsx` under `gallery/**`).
 */

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ok, routeTable, useFetchOverride, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import { ME_SIGNED_IN, ME_SIGNED_OUT } from "../gallery/harness/fixture-data"
import { useCurrentUser } from "./use-current-user"

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

describe("useCurrentUser — refresh", () => {
  it("re-fetches /api/v1/me and updates every returned field", async () => {
    let meCalls = 0
    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        React.createElement(
          TestScenario,
          {
            routes: {
              "/api/v1/me": () => {
                meCalls += 1
                // First load: signed out. Second (the refresh): signed in —
                // proves `refresh()` actually re-fetches rather than
                // replaying its first response.
                return ok(meCalls === 1 ? ME_SIGNED_OUT : ME_SIGNED_IN)
              },
            },
          },
          children,
        ),
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(meCalls).toBe(1)

    await act(async () => {
      await result.current.refresh()
    })

    expect(meCalls).toBe(2)
    expect(result.current.user?.id).toBe(ME_SIGNED_IN.user.id)
    expect(result.current.user?.role).toBe(ME_SIGNED_IN.user.role)
  })
})
