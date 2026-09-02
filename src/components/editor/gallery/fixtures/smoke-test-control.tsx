"use client"

import { SmokeTestFailureDialog } from "@/components/editor/smoke-test-control"
import type { SurfaceEntry } from "../types"

/**
 * `SmokeTestFailureDialog` is exported standalone with a plain `{ report,
 * onClose }` prop pair — no host-driving needed. `SmokeReport` /
 * `RouteResult` / `FailedRequest` are declared but NOT exported from
 * smoke-test-control.tsx, so the literals below aren't annotated with those
 * names; TypeScript still checks them structurally against the prop the
 * real `report` parameter expects, which is the same protection an
 * explicit import would give.
 */

export const SMOKE_TEST_CONTROL_SURFACE: SurfaceEntry = {
  id: "smoke-test-control",
  title: "Smoke test: failing routes",
  kind: "modal",
  sourceFile: "src/components/editor/smoke-test-control.tsx",
  states: [
    {
      id: "smoke-test-control/single-failure",
      label: "One failing route",
      render: (ctx) => (
        <SmokeTestFailureDialog
          report={{
            ok: false,
            baseUrl: "http://localhost:5173",
            startedAt: "2026-08-09T10:00:00.000Z",
            durationMs: 4820,
            // `.desde/smoke-runs/<runId>/`, where runId is a randomUUID
            // minted per run (editor-cli/src/server/smoke-test-handler.ts:108,
            // stores/local-smoke-run-store.ts). Every route's screenshotPath
            // below is inside this directory.
            artifactsDir: "/repo/.desde/smoke-runs/6f1c2a94-6a2f-4d0a-9f1e-2b7c5d8e3a10",
            routes: [
              // Screenshotting is a run-level option (`opts.screenshot &&
              // opts.artifactsDir`), so on a run that captures, EVERY route
              // that loads gets a path — a mix of null and non-null across
              // routes of one run is not something the runner can emit.
              { route: "/", url: "http://localhost:5173/", ok: true, loadOk: true, httpStatus: 200, consoleErrors: [], pageErrors: [], failedRequests: [], bridgeVersion: "2026-08-06i", bridgeOk: true, selectorFound: true, screenshotPath: "/repo/.desde/smoke-runs/6f1c2a94-6a2f-4d0a-9f1e-2b7c5d8e3a10/route-0-root.png", durationMs: 640, error: null },
              {
                route: "/models/gpt-5",
                url: "http://localhost:5173/models/gpt-5",
                ok: false,
                loadOk: true,
                httpStatus: 200,
                consoleErrors: ["TypeError: Cannot read properties of undefined (reading 'pricing')"],
                pageErrors: [],
                failedRequests: [
                  {
                    url: "http://localhost:5173/api/models/gpt-5/pricing",
                    resourceType: "fetch",
                    status: 404,
                    failure: null,
                    critical: true,
                  },
                ],
                bridgeVersion: "2026-08-06i",
                bridgeOk: true,
                selectorFound: false,
                // `sanitizeRoute(route, index)` → `route-<index>-<slug>`, written
                // into the run's own artifactsDir. Both must agree with the
                // report's `artifactsDir` above.
                screenshotPath:
                  "/repo/.desde/smoke-runs/6f1c2a94-6a2f-4d0a-9f1e-2b7c5d8e3a10/route-1-models-gpt-5.png",
                durationMs: 1120,
                // `error` is only ever a thrown Playwright message. A selector
                // miss is reported by `selectorFound: false`, not here — the
                // runner evaluates the selector once and never waits for it.
                error: null,
              },
            ],
          }}
          onClose={() => ctx.log("onClose")}
        />
      ),
    },
    {
      id: "smoke-test-control/multiple-failures-with-overflow",
      label: "Multiple failing routes, error overflow",
      render: (ctx) => (
        <SmokeTestFailureDialog
          report={{
            ok: false,
            baseUrl: "http://localhost:5173",
            startedAt: "2026-08-09T10:05:00.000Z",
            durationMs: 9310,
            artifactsDir: null,
            routes: [
              {
                route: "/settings",
                url: "http://localhost:5173/settings",
                ok: false,
                loadOk: false,
                // `httpStatus` is assigned on the same line that sets
                // `loadOk = true`; if `goto` threw, neither happened.
                httpStatus: null,
                consoleErrors: Array.from({ length: 8 }, (_, i) => `console.error #${i + 1}: ReferenceError: acmeTheme is not defined`),
                pageErrors: ["Uncaught ReferenceError: acmeTheme is not defined"],
                failedRequests: [],
                bridgeVersion: null,
                bridgeOk: null,
                selectorFound: null,
                screenshotPath: null,
                durationMs: 210,
                error: "page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/settings",
              },
              {
                route: "/gateways/edge",
                url: "http://localhost:5173/gateways/edge",
                ok: false,
                loadOk: true,
                httpStatus: 200,
                consoleErrors: [],
                pageErrors: Array.from({ length: 6 }, (_, i) => `Uncaught Error: layout thrash #${i + 1}`),
                failedRequests: Array.from({ length: 7 }, (_, i) => ({
                  url: `http://localhost:5173/api/gateways/edge/plugin-${i + 1}`,
                  resourceType: "fetch",
                  status: 503,
                  failure: null,
                  critical: true,
                })),
                // `bridgeOk = false` is only reachable from the catch around
                // the bridge-version wait, where `bridgeVersion` was never
                // assigned — the two cannot both be truthy.
                bridgeVersion: null,
                bridgeOk: false,
                selectorFound: true,
                // artifactsDir is null on this run, and a screenshot path is
                // only assigned under `opts.screenshot && opts.artifactsDir`.
                screenshotPath: null,
                durationMs: 3040,
                error: null,
              },
            ],
          }}
          onClose={() => ctx.log("onClose")}
        />
      ),
    },
  ],
}
