/**
 * Setup for the surface-gallery render sweep.
 *
 * `viewer/`'s vitest runs `environment: "node"` for the server suites, and the
 * gallery test opts into jsdom with its own `@vitest-environment` docblock. So
 * everything here is guarded on a DOM actually existing — in a node-environment
 * file this whole module is a no-op.
 *
 * The jsdom gap-fillers are NOT duplicated. `src/jsdom-shims.ts` at the repo
 * root already carries them (pointer capture, ResizeObserver, matchMedia,
 * scrollIntoView, localStorage) with the reasoning for each, and every one is
 * additive and self-guarding. What is deliberately not imported is the root's
 * `test-setup.ts`: that adds `@testing-library/jest-dom`, which reads a global
 * `expect` at import time, and this config does not set `globals: true`.
 */
import "@/jsdom-shims"

import { installFakeEventSource } from "./harness/fake-event-source"
import { installMockBackend } from "./harness/mock-backend"

if (typeof window !== "undefined") {
  // The same two fakes the harness installs at boot, for the same reason: the
  // components under test load themselves from `/api/v1/*` and open SSE
  // streams on mount. Without these the sweep would attempt real network calls
  // and every fixture would render its error state — a green test proving
  // nothing about the state it claims to cover.
  installMockBackend()
  installFakeEventSource()

  /*
    `waitFor` carries its OWN budget, separate from vitest's `testTimeout`,
    and it defaults to 1000ms.

    The root suite was given this on 2026-08-24 and this one was not, which
    left every jsdom test here on the 1s default. MEASURED: under load,
    `panel-mutation-error-handling` failed at 1,995ms — an ASSERTION failure,
    not a timeout, because `waitFor` gave up and reported the state from
    before the update. That shape reads like a product race and is not one;
    it is a starved scheduler, and `waitFor` polls on a 50ms interval.

    5s is still finite: something that genuinely never happens still fails,
    four seconds later. `testTimeout` (20s, see vitest.config.ts) stays the
    outer bound.

    Imported lazily rather than at module scope: this file is also loaded for
    every node-environment suite here, where pulling in a DOM testing library
    at import time would be a cost those suites have no use for.
  */
  const { configure } = await import("@testing-library/react")
  configure({ asyncUtilTimeout: 5000 })
}
