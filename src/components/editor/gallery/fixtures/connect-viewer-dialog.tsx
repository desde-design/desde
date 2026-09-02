"use client"

import { useEffect } from "react"
import { ConnectViewerDialog } from "@/components/editor/connect-viewer-dialog"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import {
  clickLikeUser,
  findButtonByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "./dom-interaction"
import { useFetchOverride } from "./fetch-override"

/**
 * Final-state selectors for the driven states below. A failed probe renders a
 * destructive `Callout`; a successful one renders the project `ListRow`s.
 * Both carry a `data-slot` from the block primitives, which is the stable
 * hook — the copy inside them is what a redesign is expected to change.
 */
// Both are scoped to the dialog. The ambient self-host chrome renders its own
// `[data-slot="option-card"]` (the Layers panel's "App" row), which an unscoped
// selector matches in ~3ms — the ready gate would pass while the driven
// interaction was still in flight, and the script would capture the idle form
// and write it as `projects-found`, exiting 0. `registry.test.tsx` cannot catch
// that, because jsdom has no ambient chrome.
// The probe failure is no longer a Callout: it is destructive text inside the
// dialog description (section-count pass, 2026-08-09). Scoped to the dialog so
// it cannot match an ambient status region elsewhere on the page.
const PROBE_ERROR = '[role="dialog"] [data-testid="connect-viewer-error"]'
const PROBE_PROJECT_LIST = '[role="dialog"] [data-slot="option-card"]'
/**
 * The empty picker has no option cards by definition, so it cannot share the
 * list's readiness selector. Waiting on the wrong one is not a flake, it is a
 * permanent hang that the registry test reports as "never reached readyWhen".
 */
const PROBE_EMPTY_LIST = '[role="dialog"] [data-slot="empty-state"]'

/**
 * `ConnectViewerDialog`'s interesting states — an unreachable base URL, a
 * rejected token, a read-only token refused at connect time — live behind
 * its own internal `probe()` call. There is no prop that sets `error`
 * directly, so this fixture drives the SAME interaction a user would (type
 * a URL + token, click "Connect") with `window.fetch` stubbed for
 * exactly the probe request. That reaches the state honestly, through the
 * real code path, instead of inventing a prop the component doesn't have.
 *
 * The canned response bodies below are copied VERBATIM from the server that
 * produces them, `editor-cli/src/server/viewer-probe.ts` (lines ~51, 81,
 * 109-113), not invented. `connect-viewer-dialog.test.tsx` only exercises a
 * SHORTENED placeholder string for the "rejected" case (its own regex just
 * checks `/rejected/i`) — the real production copy a user actually sees for
 * all four outcomes lives in `viewer-probe.ts`, so that's the source used
 * here per the task's "use the real shapes, don't invent them" instruction.
 */

const PROBE_PATH = "/api/editor/viewer-auth/probe"
const FAKE_BASE_URL = "https://viewer.example.com"
const FAKE_TOKEN = `dsv_${"a".repeat(16)}_${"b".repeat(43)}`

interface ProbeResponse {
  status: number
  body: unknown
}

const UNREACHABLE: ProbeResponse = {
  status: 502,
  body: {
    ok: false,
    reason: `Could not reach a viewer at ${FAKE_BASE_URL}. Check the URL and that the server is running.`,
  },
}

const REJECTED_TOKEN: ProbeResponse = {
  status: 401,
  body: {
    ok: false,
    reason: "That token was rejected. It may have been revoked, or belong to a different viewer.",
  },
}

const READ_ONLY_TOKEN: ProbeResponse = {
  status: 400,
  body: {
    ok: false,
    reason:
      "That token is read-only, so comments could be read but never posted. " +
      "Create a new token in the viewer under Settings with the WRITE scope ticked, and paste that one.",
  },
}

const PROJECTS_FOUND: ProbeResponse = {
  status: 200,
  body: {
    ok: true,
    origin: FAKE_BASE_URL,
    projects: [
      { id: "proj-1", slug: "ai-gateway", name: "AI Gateway Prototype" },
      { id: "proj-2", slug: "design-system-demo", name: "Design System Demo" },
    ],
  },
}

/**
 * A viewer that authenticates fine and has nothing on it.
 *
 * The probe SUCCEEDS here, which is why this is a distinct state and not a
 * variant of the error ones: credentials are good, so the dialog advances to
 * the picker and the picker is empty. It had no fixture until 2026-08-17, so
 * the one surface in this dialog with no controls on it was also the one
 * nobody had looked at.
 */
const NO_PROJECTS: ProbeResponse = {
  status: 200,
  body: { ok: true, origin: FAKE_BASE_URL, projects: [] },
}

/**
 * Types a URL + token into the open dialog and clicks "Connect", with
 * the probe endpoint stubbed to `probeResponse`. Layers on top of whatever
 * `window.fetch` currently is (the self-host harness's own mock backend, or
 * the registry test's stub) rather than replacing it outright, so every
 * OTHER endpoint the surrounding chrome depends on keeps working.
 */
function ProbeFixture({
  ctx,
  probeResponse,
}: {
  ctx: SurfaceRenderContext
  probeResponse: ProbeResponse
}) {
  // Claimed through the shared router rather than by swapping `window.fetch`
  // here: React renders an incoming keyed state BEFORE running the outgoing
  // one's cleanup, so a save-and-restore version put the stale fetch back over
  // the next fixture's patch. See `./fetch-override`.
  useFetchOverride({
    match: (url) => url.includes(PROBE_PATH),
    respond: () => ({ status: probeResponse.status, body: probeResponse.body }),
  })

  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const urlInput = await waitForElement(
        () => document.getElementById("viewer-url") as HTMLInputElement | null,
      )
      const tokenInput = await waitForElement(
        () => document.getElementById("viewer-token") as HTMLInputElement | null,
      )
      if (cancelled || !urlInput || !tokenInput) return
      setNativeValue(urlInput, FAKE_BASE_URL)
      setNativeValue(tokenInput, FAKE_TOKEN)
      const submit = await waitForElement(() => findButtonByText(/^connect$/i))
      if (cancelled || !submit) return
      clickLikeUser(submit)
    })

    return () => {
      cancelled = true
    }
  }, [probeResponse])

  return (
    <ConnectViewerDialog
      open
      onOpenChange={(next) => ctx.log("onOpenChange", next)}
      onConnected={() => ctx.log("onConnected")}
    />
  )
}

export const CONNECT_VIEWER_DIALOG_SURFACE: SurfaceEntry = {
  id: "connect-viewer-dialog",
  title: "Connect to a viewer",
  kind: "modal",
  sourceFile: "src/components/editor/connect-viewer-dialog.tsx",
  states: [
    {
      id: "connect-viewer-dialog/idle",
      label: "Idle: nothing probed yet",
      render: (ctx) => (
        <ConnectViewerDialog
          open
          onOpenChange={(next) => ctx.log("onOpenChange", next)}
          onConnected={() => ctx.log("onConnected")}
        />
      ),
    },
    {
      id: "connect-viewer-dialog/unreachable",
      label: "Probe failed: unreachable base URL",
      readyWhen: PROBE_ERROR,
      render: (ctx) => <ProbeFixture ctx={ctx} probeResponse={UNREACHABLE} />,
    },
    {
      id: "connect-viewer-dialog/rejected-token",
      label: "Probe failed: rejected token",
      readyWhen: PROBE_ERROR,
      render: (ctx) => <ProbeFixture ctx={ctx} probeResponse={REJECTED_TOKEN} />,
    },
    {
      id: "connect-viewer-dialog/read-only-token",
      label: "Probe refused: read-only token",
      readyWhen: PROBE_ERROR,
      render: (ctx) => <ProbeFixture ctx={ctx} probeResponse={READ_ONLY_TOKEN} />,
    },
    {
      id: "connect-viewer-dialog/projects-found",
      label: "Probe succeeded: projects listed",
      readyWhen: PROBE_PROJECT_LIST,
      render: (ctx) => <ProbeFixture ctx={ctx} probeResponse={PROJECTS_FOUND} />,
    },
    {
      id: "connect-viewer-dialog/no-projects",
      label: "Probe succeeded: the viewer has no projects",
      readyWhen: PROBE_EMPTY_LIST,
      render: (ctx) => <ProbeFixture ctx={ctx} probeResponse={NO_PROJECTS} />,
    },
  ],
}
