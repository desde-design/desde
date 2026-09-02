// @vitest-environment jsdom

/**
 * Fix wave 6 (codex round 6) — saving a new access value must reload the
 * review page.
 *
 * The thing under review is an `<iframe>` whose `src` and `sandbox` were
 * resolved ONCE, server-side, from the access the page was rendered under
 * (`resolvePrototypeEmbed`, driven by `project.access` and
 * `project.capability`).
 * Changing access in the dialog updated the badge and nothing else, so the
 * frame kept running the old policy: a project just made private went on
 * serving through the capability minted while it was public-link, and the rail
 * said one thing while the page did another.
 *
 * Only the SERVER can re-mint that capability for the new policy, so the fix
 * is a full reload and this test pins exactly that observable.
 *
 * Uses the gallery's fetch-override harness rather than `vi.stubGlobal("fetch")`
 * for the reason `project-access-list-loading.test.ts` records: a raw global
 * stub collides with `gallery-test-setup.ts` across files sharing a worker.
 * JSX here (not `React.createElement`) because this file is `.tsx`, which
 * `vitest.config.ts` collects under `app/**` and transforms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { clickLikeUser, waitForElement } from "@/components/gallery/dom-interaction"
import { ReviewShell, type ReviewShellProject } from "../[slug]/review-shell"
import type { ProjectAccessValue } from "../../project-access-copy"

const PROJECT_ID = "proj-reload"

const PROJECT: ReviewShellProject = {
  id: PROJECT_ID,
  slug: "ai-gateway",
  name: "AI Gateway",
  access: "all-members",
  publicLinksEnabled: true,
  serveDomain: null,
  capability: null,
  shellOrigin: "http://localhost:3100",
  prototypeOrigin: null,
  mode: "fallback",
}

const ROUTES: Record<string, FetchOverrideResult | (() => FetchOverrideResult)> = {
  [`GET /api/v1/projects/${PROJECT_ID}/comments`]: ok({ comments: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/members`]: ok({ members: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}/participants`]: ok({ participants: [] }),
  [`GET /api/v1/projects/${PROJECT_ID}`]: ok({ project: { id: PROJECT_ID, name: PROJECT.name } }),
  [`PATCH /api/v1/projects/${PROJECT_ID}`]: ok({ project: { id: PROJECT_ID } }),
}

function Scenario({ children }: { children: ReactNode }): ReactNode {
  useFetchOverride(routeTable(ROUTES))
  return children
}

/**
 * `window.location.reload` is not writable in jsdom, so the whole `location`
 * is replaced with a stand-in carrying the two fields anything under test
 * reads (`origin`, `href`) plus the spy. Restored in `afterEach`.
 */
function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  const { origin, href } = window.location
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { origin, href, reload, assign: vi.fn(), replace: vi.fn() },
  })
  return reload
}

let originalLocation: Location

beforeEach(() => {
  originalLocation = window.location
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  })
})

async function click(selector: string): Promise<void> {
  const el = await waitForElement(() => document.querySelector<HTMLElement>(selector))
  expect(el, `never found ${selector}`).not.toBeNull()
  await act(async () => {
    clickLikeUser(el!)
  })
}

/**
 * Rail menu → Access, then pick `value` and press Save.
 *
 * The opener is the ACCOUNT menu: the rail's separate project-settings gear
 * was folded into it on 2026-08-25, so there is one control carrying both the
 * project's settings and the person's.
 */
async function changeAccessTo(value: ProjectAccessValue): Promise<void> {
  await click('[data-testid="account-menu"]')
  await click('[data-testid="rail-settings-access"]')
  // The picker is closed at rest since 2026-08-29 — the dialog shows the
  // current value with an Edit button beside it.
  await click('[data-testid="access-edit"]')
  await click(`[data-slot="radio-group-item"][value="${value}"]`)
  await waitForElement(() =>
    document.querySelector<HTMLElement>('[data-testid="access-save"]:not(:disabled)'),
  )
  await click('[data-testid="access-save"]')
}

describe("ReviewShell — access change reloads the page", () => {
  it("reloads after a successful save so the iframe is re-minted under the new policy", async () => {
    const reload = stubReload()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    await changeAccessTo("invited")

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it("does not reload before the save — picking a segment alone changes nothing", async () => {
    const reload = stubReload()
    render(
      <Scenario>
        <ReviewShell project={PROJECT} />
      </Scenario>,
    )

    await click('[data-testid="account-menu"]')
    await click('[data-testid="rail-settings-access"]')
    await click('[data-testid="access-edit"]')
    await click('[data-slot="radio-group-item"][value="invited"]')

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(reload).not.toHaveBeenCalled()
  })
})
