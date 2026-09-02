// @vitest-environment jsdom

/**
 * Fix wave M1 review. `handleRoleChange` / `handleRemove` / `handleRestore` /
 * `handleRegenerate` / `handleRevokeInvite` (members-panel.tsx), `handleRemove`
 * (domain-rules-panel.tsx) and `handleToggle` (instance-settings-panel.tsx)
 * each did `try { const res = await fetch(...); ... } finally { ... }` with NO
 * `catch` — a rejected `fetch` (offline, DNS failure, an aborted request)
 * propagated straight out of the `useCallback`, past the `void handler(...)`
 * at the click site, and into an unhandled promise rejection. Nothing on
 * screen ever showed it: the busy indicator cleared (the `finally` still
 * ran), but the panel's own error state — the thing a person would actually
 * see — stayed `null` forever.
 *
 * One representative handler per distinct error-state shape, not all seven —
 * the five members-panel handlers collapse to two shapes (`actionError` for
 * member-row actions, `inviteActionError` for invite-row actions), and
 * domain-rules-panel / instance-settings-panel each have their own. Covering
 * one of each proves the pattern; the other three are byte-identical copies
 * of a covered one (see the fix's own diff).
 *
 * Uses the gallery's OWN fetch-override harness
 * (`@/components/gallery/fetch-override`) rather than a raw
 * `vi.stubGlobal("fetch", …)`. This file's `@vitest-environment jsdom`
 * pragma means `gallery/gallery-test-setup.ts` — a GLOBAL vitest
 * `setupFiles` entry, guarded only on `window` existing — installs the
 * gallery's baseline mock backend on `window.fetch` before every test here
 * too. A raw `vi.stubGlobal` + `vi.unstubAllGlobals()` pair collided with
 * that across files sharing a worker (measured: it left `window.fetch`
 * inconsistent for `gallery-shell.test.tsx`, which runs the full fixture
 * catalog and threw unhandled rejections from unrelated fixtures as a
 * result). `useFetchOverride`/`routeTable` layer an override on the SAME
 * router every gallery fixture already uses (via `Scenario`,
 * `gallery/harness/scenario.tsx`), which is explicitly built to coexist
 * with exactly this vitest behavior — see that module's own doc comment.
 * `TestScenario` below is the identical 2-line body `Scenario` has; it is
 * redeclared locally (rather than imported) only so `children` can be typed
 * OPTIONAL — `React.createElement`'s typings merge a trailing child arg into
 * a required `children` prop, but not into one already spelled out in the
 * props object, and `react/no-children-prop` forbids the latter. This file
 * has no JSX transform available (`vitest.config.ts` only globs `.test.tsx`
 * under `gallery/**`), so `React.createElement` is the only option.
 */

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import React, { type ReactNode } from "react"
import { ME_SIGNED_IN } from "../../../gallery/harness/fixture-data"
import {
  fail,
  NETWORK_ERROR,
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { MembersPanel } from "../members-panel"
import { DomainRulesPanel } from "../domain-rules-panel"
import { InstanceSettingsPanel } from "../instance-settings-panel"

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

describe("a rejected fetch surfaces in the panel's error state instead of vanishing", () => {
  it("members-panel: handleRemove (the actionError shape, shared with handleRoleChange/handleRestore)", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok(ME_SIGNED_IN),
            "GET /api/v1/instance/members": ok({
              members: [
                {
                  userId: "u-target",
                  email: "b@x.com",
                  displayName: "Bea",
                  avatarUrl: "",
                  role: "editor",
                  status: "active",
                  createdAt: "2020-01-01T00:00:00.000Z",
                },
              ],
            }),
            "GET /api/v1/instance/invites": ok({ invites: [] }),
            "DELETE /api/v1/instance/members": NETWORK_ERROR,
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    const removeButton = await screen.findByRole("button", { name: /remove bea/i })
    await act(async () => {
      removeButton.click()
    })

    // `failureMessage` on a plain thrown error (not an `ApiError`) is always
    // this exact sentence — see `api-client.ts`.
    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy()
    })
  })

  // Fix wave 11, item 4. `handleRemove` returned on a non-ok DELETE without
  // reloading, so after the partial-revocation 500 (which reports the member
  // WAS removed — status flipped, only some credentials could not be swept)
  // the row kept showing the member as active. It must reload on the failure
  // branch too, so the panel reflects the server truth, while still surfacing
  // the server's error message.
  it("members-panel: handleRemove reloads on a DELETE 500 so the row reflects the server truth", async () => {
    let membersCalls = 0
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok(ME_SIGNED_IN),
            "GET /api/v1/instance/members": () => {
              membersCalls += 1
              // First load: the target is active. The reload after the failed
              // DELETE sees it as removed (the 500 still flipped status).
              const status = membersCalls === 1 ? "active" : "removed"
              return ok({
                members: [
                  {
                    userId: "u-target",
                    email: "b@x.com",
                    displayName: "Bea",
                    avatarUrl: "",
                    role: "editor",
                    status,
                    createdAt: "2020-01-01T00:00:00.000Z",
                  },
                ],
              })
            },
            "GET /api/v1/instance/invites": ok({ invites: [] }),
            "DELETE /api/v1/instance/members": fail(
              500,
              "Member was removed, but some credentials could not be revoked. Try again.",
            ),
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    const removeButton = await screen.findByRole("button", { name: /remove bea/i })
    await waitFor(() => expect(membersCalls).toBe(1))

    await act(async () => {
      removeButton.click()
    })

    // The server's error message is surfaced...
    await waitFor(() => {
      expect(
        screen.getByText("Member was removed, but some credentials could not be revoked. Try again."),
      ).toBeTruthy()
    })
    // ...AND the panel reloaded, so the list reflects the server truth: the
    // 500 reported the member WAS removed, and removed members simply
    // disappear (Mo, 2026-08-31 — the Removed/Restore row state is gone).
    await waitFor(() => expect(membersCalls).toBe(2))
    await waitFor(() => {
      expect(screen.queryByText("Bea")).toBeNull()
    })
    expect(screen.queryByRole("button", { name: /remove bea/i })).toBeNull()
  })

  it("members-panel: handleRevokeInvite (the inviteActionError shape, shared with handleRegenerate)", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok(ME_SIGNED_IN),
            "GET /api/v1/instance/members": ok({ members: [] }),
            "GET /api/v1/instance/invites": ok({
              invites: [{ id: "inv-1", email: "dana@x.com", role: "editor", state: "pending" }],
            }),
            "DELETE /api/v1/instance/invites": NETWORK_ERROR,
          },
        },
        React.createElement(MembersPanel),
      ),
    )

    // Invites live on their own tab since 2026-08-31 — open it first. A bare
    // `.click()` is not enough: Radix's TabsTrigger activates on mousedown,
    // so dispatch that half of the gesture too.
    const invitesTab = await screen.findByRole("tab", { name: /^invites$/i })
    await act(async () => {
      invitesTab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
      invitesTab.click()
    })

    const revokeButton = await screen.findByRole("button", { name: /delete invite for dana@x\.com/i })
    await act(async () => {
      revokeButton.click()
    })

    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy()
    })
  })

  it("domain-rules-panel: handleRemove (reuses the loadError slot)", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok(ME_SIGNED_IN),
            "GET /api/v1/instance/domain-rules": ok({
              domainRules: [
                { domain: "acme.com", role: "editor", createdByUserId: null, createdAt: "2020-01-01T00:00:00.000Z" },
              ],
            }),
            "DELETE /api/v1/instance/domain-rules": NETWORK_ERROR,
          },
        },
        React.createElement(DomainRulesPanel),
      ),
    )

    const removeButton = await screen.findByRole("button", { name: /remove rule for acme\.com/i })
    await act(async () => {
      removeButton.click()
    })

    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy()
    })
  })

  it("instance-settings-panel: handleToggle (rolls the switch back AND shows saveError)", async () => {
    render(
      React.createElement(
        TestScenario,
        {
          routes: {
            "/api/v1/me": ok(ME_SIGNED_IN),
            "GET /api/v1/instance/settings": ok({ allowPublicLinks: true }),
            "PATCH /api/v1/instance/settings": NETWORK_ERROR,
          },
        },
        React.createElement(InstanceSettingsPanel),
      ),
    )

    // Named, not positional: the panel carries more than one switch now, and
    // an unqualified findByRole would break again on the next one added.
    const toggle = await screen.findByRole("switch", { name: /allow public links/i })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => {
      toggle.click()
    })

    await waitFor(() => {
      expect(screen.getByText("Something went wrong. Try again.")).toBeTruthy()
    })
    // Rolled back to what the server actually has — not stuck showing the
    // optimistic flip the failed PATCH never recorded.
    expect(toggle.getAttribute("aria-checked")).toBe("true")
  })
})
