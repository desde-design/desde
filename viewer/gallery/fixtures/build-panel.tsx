"use client"

import { useRef, useState } from "react"
import {
  ME_SIGNED_IN,
  SAMPLE_BUILD_LOG,
  SAMPLE_FAILED_BUILD_LOG,
  SAMPLE_PROJECT,
  SAMPLE_REPO_CONFIG,
  SAMPLE_ROOT_ABSOLUTE_WARNING,
  SAMPLE_USER,
  sampleDeployment,
} from "../harness/fixture-data"
import { ReviewShellFixture, openDeploymentsTab } from "./review-shell"
import { emitNamedEvent, hasOpenStream } from "../harness/fake-event-source"
import {
  clickLikeUser,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import { fail, ok, PENDING } from "@/components/gallery/fetch-override"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The build panel — trigger a build, watch it stream, land on deployed or
 * failed.
 *
 * There is no `isLoading` prop anywhere on this component. The pre-fetch
 * mount, a resolved-empty list, and a silently-failed GET all render the
 * identical "No builds" empty state (the hook's catch block is a
 * no-op). Since option 2 (Mo, 2026-08-30) the review page is only reachable
 * WITH a deployment, so no state here mocks an empty list any more.
 *
 * ## Rendered in the real review chrome, not on a card
 *
 * Every state below mounts the whole review screen and clicks through to the
 * Deployments tab (Mo, 2026-08-21: "I rather the iframe area become thinner
 * so that all the viewer chrome is showing"). The panel is reviewed where it
 * ships, at the width it ships, with the header and tabs above it.
 *
 * That also deleted three props. `isOwner`, `buildsEnabled` and `hasRepo` used
 * to be passed in, which ASSERTED what the derivation would conclude; the
 * states now answer the endpoints and let `useBuildAccess` and
 * `useProjectDetail` do the deriving, so a change to what counts as an owner
 * shows up here instead of quietly agreeing with a hard-coded prop.
 *
 * `route={null}` on purpose. A reported page path would mean posting
 * ROUTE_CHANGED from inside the iframe's own realm, which jsdom cannot do, so
 * every state here would need `needsBrowser` and drop out of the headless
 * sweep. The header shows its "no route yet" placeholder instead, which is a
 * real state and costs this surface nothing.
 *
 * Two internal `useState`s (`error`, `starting`) have no prop, so the only
 * honest way to reach them is to click the real "Deploy" button and
 * control what the mocked `fetch` does next — same technique as
 * `new-project-page.tsx`. A third source of un-prop-able states is the SSE
 * log stream itself: `fake-event-source.ts` stands in for the browser's
 * `EventSource`, and a driven fixture pushes named `log`/`done` events onto
 * it once the panel has actually opened a connection.
 */

/**
 * Drop `buildLog` the way the server does for a non-owner: the KEY is
 * removed, not blanked. `buildLog: undefined` would be a different fixture —
 * it survives `JSON.stringify` as an absent key but reads, in the source, as
 * "there is a log and it is empty".
 */
function omitBuildLog(d: ReturnType<typeof sampleDeployment>) {
  const { buildLog: _buildLog, ...rest } = d
  return rest
}

const PROJECT_ID = SAMPLE_PROJECT.id

/**
 * The endpoints that decide what this panel may offer.
 *
 * These used to be PROPS — `isOwner`, `buildsEnabled`, `hasRepo` — because
 * the panel was rendered bare. Now that every state goes through the real
 * review screen (Mo, 2026-08-21), the panel gets them from `useBuildAccess`
 * and `useProjectDetail` like it does in the product, so the fixture has to
 * answer the endpoints instead.
 *
 * That is a straight improvement: the props asserted what the derivation
 * WOULD conclude, and now the derivation runs.
 *
 * `canManage` is the caller's INSTANCE role (viewer-membership): an admin or
 * editor can manage, a viewer cannot. `useBuildAccess` reads it from `/me`, so
 * a can't-manage state is the same signed-in user downgraded to `viewer` — a
 * change to what counts as a manager shows up here rather than silently
 * agreeing with a hard-coded prop.
 */
function accessRoutes({
  canManage = true,
  buildsEnabled = true,
  hasRepo = true,
}: { canManage?: boolean; buildsEnabled?: boolean; hasRepo?: boolean } = {}) {
  return {
    "/api/v1/me": ok(
      canManage ? ME_SIGNED_IN : { ...ME_SIGNED_IN, user: { ...SAMPLE_USER, role: "viewer" as const } },
    ),
    "/api/v1/github/installations": ok({ configured: buildsEnabled, installations: [] }),
    [`/api/v1/projects/${PROJECT_ID}`]: ok({
      ...SAMPLE_PROJECT,
      ...(hasRepo ? { repoConfig: SAMPLE_REPO_CONFIG } : {}),
    }),
  }
}
const DEPLOYMENTS_PATH = `/api/v1/projects/${PROJECT_ID}/deployments`
const BUILD_PATH = `POST /api/v1/projects/${PROJECT_ID}/deployments/build`

// Three chunks of the same sample log, split so a streaming fixture can
// deliver it as "first event replaces, later events append" — exactly how
// the real server behaves (see `use-build-controls.ts`). Concatenated back together
// they equal SAMPLE_BUILD_LOG, so the streaming states show the same build
// the declarative `deployed-success` state shows, just arriving live.
const LOG_LINES = SAMPLE_BUILD_LOG.split("\n")
const STREAM_CHUNK_1 = `${LOG_LINES.slice(0, 5).join("\n")}\n`
const STREAM_CHUNK_2 = `${LOG_LINES.slice(5, 9).join("\n")}\n`

/**
 * Poll a predicate rather than wait for one DOM element to exist.
 *
 * The states below don't gate on an element appearing — they gate on the
 * panel having opened its `EventSource` connection, or on log TEXT growing,
 * or on a status pill's label changing. `waitForElement`
 * (`@/components/gallery/dom-interaction`) can't express any of that, so this
 * is the same polling loop with a boolean predicate instead of a finder.
 */
async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  if (predicate()) return true
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    if (predicate()) return true
  }
  console.warn("[gallery] build-panel waitForCondition timed out")
  return false
}

/*
 * These read the whole document rather than scoping to the gallery's own
 * stage element.
 *
 * Scoping to `[data-gallery-stage]` looks safer and is actually a trap: that
 * attribute belongs to `harness/gallery-shell.tsx`, so it exists only when the
 * gallery is RUNNING. Under the registry sweep the fixture is rendered on its
 * own, the selector matches nothing, and every driven state here waits its
 * full timeout and then silently gives up — green in the browser, dead in the
 * test, with no error either way. A fixture must not depend on the harness
 * chrome around it.
 */
function pillText(): string {
  return (
    document.querySelector('[data-slot="status-pill"]')?.textContent ?? ""
  )
}

/**
 * Hidden marker a driven fixture renders once its whole sequence — not just
 * the panel mounting, but the SSE events landing and the DOM catching up —
 * has actually finished. `readyWhen` needs a selector, and nothing the real
 * panel renders distinguishes "log has the first chunk" from "log has all
 * three": the `<pre>` is there from the first render. This is the fixture's
 * own signal, not a hook into the component under review.
 */
function ReadyMarker({ testId }: { testId: string }) {
  return <span data-testid={testId} hidden />
}

/**
 * Open the Deployments tab, then click "Deploy", over an empty list.
 *
 * ONE driver, not two. These fixtures used to run their own `useEffect`
 * alongside the shell's, which raced: the effect looked for a Deploy button
 * while the tab it lives on was still closed, found nothing, and returned
 * silently. Everything a state needs now happens in `run`, in order.
 */
/**
 * Wait for a prior build to actually load, THEN click "Deploy", so the busy
 * button sits over real old content rather than an empty panel that happened
 * to load late.
 */
function StartingFromPopulatedFixture() {
  return (
    <ReviewShellFixture
      routes={{
        ...accessRoutes(),
        [DEPLOYMENTS_PATH]: ok({ deployments: [sampleDeployment()] }),
        [BUILD_PATH]: PENDING,
      }}
      run={async (cancelled) => {
        await openDeploymentsTab(cancelled)
        if (cancelled()) return
        // Waits on the status PILL, not on log text. A finished build no
        // longer renders a log box on the tab (its log is in the row's
        // detail dialog), so `logText()` stays empty here forever.
        // Waits for a deployment ROW, which is the "old content" these two
        // states exist to sit the busy/error state over. The status pill is
        // no longer a reliable proxy: it appears on rows AND on the live
        // build block, so a pill can exist before the list has rendered.
        const loaded = await waitForElement(() =>
          document.querySelector('[data-testid^="deployment-dep"]'),
        )
        if (cancelled() || !loaded) return
        // `waitForElement`, not a bare lookup. Inside the review chrome the
        // status pill now appears on the deployment ROWS as well as on the
        // panel, so the pill wait can resolve a beat before the panel's own
        // controls have rendered, and a bare lookup returning null makes the
        // driver give up silently.
        //
        // Found by `data-testid`, not by text: Deploy became an icon button
        // on 2026-08-28 and has no text to match. The registry test caught
        // that — `findButtonByText(/^Deploy$/)` silently found nothing, so
        // the build never started and the state never reached its
        // `readyWhen`.
        const button = await waitForElement(() =>
          document.querySelector<HTMLButtonElement>('[data-testid="deploy-button"]'),
        )
        if (cancelled() || !button) return
        clickLikeUser(button)
      }}
      route={null}
    />
  )
}

/** Same wait-then-click, but the POST resolves with a server error instead of hanging. */
function ErrorOverPopulatedFixture() {
  return (
    <ReviewShellFixture
      routes={{
        ...accessRoutes(),
        [DEPLOYMENTS_PATH]: ok({ deployments: [sampleDeployment()] }),
        /* Plain words, no status code (Mo, 2026-08-30) — the panel renders a
           server error's prose verbatim, so what this mock says is what the
           reviewer grades. */
        [BUILD_PATH]: fail(502, "Couldn't reach GitHub to start the build. Try again."),
      }}
      run={async (cancelled) => {
        await openDeploymentsTab(cancelled)
        if (cancelled()) return
        // Waits for a deployment ROW, which is the "old content" these two
        // states exist to sit the busy/error state over. The status pill is
        // no longer a reliable proxy: it appears on rows AND on the live
        // build block, so a pill can exist before the list has rendered.
        const loaded = await waitForElement(() =>
          document.querySelector('[data-testid^="deployment-dep"]'),
        )
        if (cancelled() || !loaded) return
        // `waitForElement`, not a bare lookup. Inside the review chrome the
        // status pill now appears on the deployment ROWS as well as on the
        // panel, so the pill wait can resolve a beat before the panel's own
        // controls have rendered, and a bare lookup returning null makes the
        // driver give up silently.
        //
        // Found by `data-testid`, not by text: Deploy became an icon button
        // on 2026-08-28 and has no text to match. The registry test caught
        // that — `findButtonByText(/^Deploy$/)` silently found nothing, so
        // the build never started and the state never reached its
        // `readyWhen`.
        const button = await waitForElement(() =>
          document.querySelector<HTMLButtonElement>('[data-testid="deploy-button"]'),
        )
        if (cancelled() || !button) return
        clickLikeUser(button)
      }}
      route={null}
    />
  )
}

/**
 * The terminal transition Mo asked to see reviewed: a build already streaming
 * output receives `event: done` and flips live from "Building" (pulsing,
 * blocked-reason paragraph showing) to "Deployed" (steady, blocked-reason
 * gone, commit sha filled in). No `log` events are needed here — `done` only
 * touches `status`/`commitSha` — so the deployment loads with a partial log
 * already in place, as if the build had been running a while.
 */
function LiveTransitionFixture() {
  const [ready, setReady] = useState(false)

  /*
    The list answers "building" until `done` is emitted, then "deployed".

    Keyed on the EVENT, not on a call count. Two consumers read this endpoint
    now — the panel for its rows and `useBuildControls` for the newest build —
    so a counter that flipped on the second request handed the hook a finished
    deployment, which meant it never opened a log stream and the driver waited
    for one forever.
  */
  const settled = useRef(false)
  const listResponse = () =>
    ok({
      deployments: [
        sampleDeployment({
          id: "dep-412",
          status: settled.current ? "deployed" : "building",
          commitSha: settled.current ? "9e21c7f4a83b6d0159eaa2317b6cd9f0483e2711" : null,
          commitMessage: settled.current ? "Tighten checkout summary spacing" : null,
          buildLog: STREAM_CHUNK_1 + STREAM_CHUNK_2,
        }),
      ],
    })

  return (
    <>
      <ReviewShellFixture
        routes={{ ...accessRoutes(), [DEPLOYMENTS_PATH]: listResponse }}
        run={async (cancelled) => {
          await openDeploymentsTab(cancelled)
          if (cancelled()) return
          const opened = await waitForCondition(() => hasOpenStream("/log/stream"))
          if (cancelled() || !opened) return

          settled.current = true
          emitNamedEvent("/log/stream", "done", {
            status: "deployed",
            commitSha: "9e21c7f4a83b6d0159eaa2317b6cd9f0483e2711",
          })
          // What proves the transition landed: no pill anywhere still says
          // Building — the `done` event flips the hook's status, the panel's
          // refresh effect refetches the list, and the row's own pill turns
          // Deployed. (The live log block this also used to watch unmount is
          // gone — a running build is its card now.)
          const done = await waitForCondition(() => !pillText().includes("Building"))
          if (cancelled() || !done) return

          setReady(true)
        }}
        route={null}
      />
      {ready ? <ReadyMarker testId="build-panel-live-transition-ready" /> : null}
    </>
  )
}

export const BUILD_PANEL_SURFACE: SurfaceEntry = {
  id: "build-panel",
  title: "Build panel",
  kind: "inline",
  sourceFile: "viewer/app/review/deployments-panel.tsx",
  states: [
    {
      // The upload ROW survives only here: an upload-based project with
      // history, where re-uploading is the ongoing deploy path. Before the
      // first deployment the empty state above carries the one action
      // instead (Mo, 2026-08-30).
      id: "build-panel/no-repo-upload-history",
      label: "No repo, uploads exist — Upload a build is the deploy control",
      readyWhen: '[data-testid="upload-a-build-button"]',
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes({ hasRepo: false }), ...{ [DEPLOYMENTS_PATH]: ok({ deployments: [sampleDeployment()] }) } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      id: "build-panel/blocked-cannot-manage",
      label: "Blocked — the role can't manage this project",
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes({ canManage: false }), ...{ [DEPLOYMENTS_PATH]: ok({ deployments: [sampleDeployment()] }) } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      // A running build is its CARD, and only its card (Mo, 2026-08-30):
      // the separate pill-plus-streaming-log block and the "A build is
      // already running" caption both left the panel — the pulsing row
      // carries the state, and its details are one click into the row.
      id: "build-panel/building-fresh-empty-log",
      label: "Building — the running build is its card in the list",
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes(), ...{
            [DEPLOYMENTS_PATH]: ok({
              deployments: [
                sampleDeployment({ id: "dep-410", status: "building", commitSha: null, commitMessage: null, buildLog: "" }),
              ],
            }),
          } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      id: "build-panel/live-transition-to-deployed",
      label: "Live: \"done\" arrives mid-build, flips to Deployed",
      render: () => <LiveTransitionFixture />,
      readyWhen: '[data-testid="build-panel-live-transition-ready"]',
    },
    {
      id: "build-panel/deployed-success",
      label: "Deployed — success pill, static log, commit shown",
      render: () => (
        // The common steady state: a project that has built before, loaded
        // on mount rather than arriving live.
        <ReviewShellFixture
      routes={{ ...accessRoutes(), ...{ [DEPLOYMENTS_PATH]: ok({ deployments: [sampleDeployment()] }) } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      id: "build-panel/failed-build",
      label: "Failed — destructive pill, log ends on the error",
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes(), ...{
            [DEPLOYMENTS_PATH]: ok({
              deployments: [
                sampleDeployment({
                  id: "dep-420",
                  status: "failed",
                  buildLog: SAMPLE_FAILED_BUILD_LOG,
                  commitSha: "b7a1e02f9c34d8017e6f2a5b1c0d4e3f8a9b6c7d",
                }),
              ],
            }),
          } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      // A caller who can't manage: the server omits `buildLog` (S7), so there
      // is nothing to show and the box must not appear. This state exists
      // because the old condition rendered it anyway, reading "Waiting for
      // output" forever for a build that finished days ago. The deployment
      // HISTORY still stays visible to every project reader — only the LOG
      // content is raised to a manager.
      id: "build-panel/cannot-manage-no-log",
      label: "Can't manage: a deployment exists, but its log is not theirs to see",
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes({ canManage: false }), ...{
            [DEPLOYMENTS_PATH]: ok({
              deployments: [omitBuildLog(sampleDeployment())],
            }),
          } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
    },
    {
      // viewer-membership row 7: a deployed build whose bundle references
      // root-absolute asset URLs. The banner lives on the SHELL now, above
      // the rail tabs (Mo, 2026-08-30), read from the project GET's
      // `activeDeployment.warnings` — hence the project-route override
      // below. It shows because the default fixture project is
      // `access: "invited"` in PATH mode (`serveDomain: null`), exactly the
      // condition `shouldShowRootAbsoluteWarning` surfaces it for.
      id: "build-panel/root-absolute-warning",
      label: "Root-absolute asset warning — banner above the rail tabs",
      render: () => (
        <ReviewShellFixture
      routes={{ ...accessRoutes(), ...{
            [`/api/v1/projects/${PROJECT_ID}`]: ok({
              ...SAMPLE_PROJECT,
              repoConfig: SAMPLE_REPO_CONFIG,
              activeDeployment: {
                status: "deployed",
                createdAt: "2026-08-19T11:00:00.000Z",
                warnings: [SAMPLE_ROOT_ABSOLUTE_WARNING],
              },
            }),
            [DEPLOYMENTS_PATH]: ok({
              deployments: [sampleDeployment({ warnings: [SAMPLE_ROOT_ABSOLUTE_WARNING] })],
            }),
          } }}
      run={openDeploymentsTab}
      route={null}
    />
      ),
      readyWhen: '[data-testid="root-absolute-learn-more"]',
    },
    {
      id: "build-panel/starting-busy-from-populated",
      label: "Deploying: busy button, over a prior deployed build",
      render: () => <StartingFromPopulatedFixture />,
      readyWhen: "button[aria-busy]",
    },
    {
      id: "build-panel/error-over-populated-deployment",
      label: "Error banner stacked above an untouched prior build",
      render: () => <ErrorOverPopulatedFixture />,
      // `startBuild` sets `error` and returns without ever touching
      // `deployment` (build-panel.tsx:140-143), so the destructive Callout
      // renders above the OLD commit line, pill and log — unchanged. This one
      // composite also stands in for the plainer "error over an empty body"
      // and the two other copy variants ("Could not start the build" when
      // the server sends no `error` field; "Could not reach the server" when
      // the fetch itself throws): all three are the identical Callout with
      // different text, and this is the more informative one to review.
      readyWhen: '[data-slot="callout"]',
    },
  ],
}
