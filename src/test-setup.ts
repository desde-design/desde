import "@testing-library/jest-dom"

/**
 * Root vitest setup: jest-dom's matchers, plus the jsdom gap-fillers.
 *
 * The gap-fillers live in their own module because the viewer's gallery sweep
 * needs them WITHOUT jest-dom — see `./jsdom-shims.ts` for why.
 */
import "./jsdom-shims"

import { configure } from "@testing-library/react"

/*
  `waitFor` carries its OWN budget, separate from vitest's `testTimeout`, and
  it defaults to 1000ms. Raising `testTimeout` alone does not help a jsdom
  test: it just converts a timeout into an assertion failure reporting the
  PREVIOUS value, which reads like a product race rather than a starved
  scheduler.

  MEASURED 2026-08-24, running this suite while the other two ran:

    inspector-panel "refreshes on every successive edit to the same selection"
      idle .... 278ms, passes
      loaded .. 5,585ms, and before this setting it failed with
                `Expected bg-violet-500 / Received bg-green-500`

  That received value is the value from BEFORE the edit. `waitFor` polls on a
  50ms interval, so under CPU starvation a re-render that would take 50ms on
  an idle machine can miss a 1000ms wall-clock window without anything being
  wrong with it.

  5s is still finite: a render that genuinely never happens still fails, four
  seconds later than it used to. `testTimeout` (20s, see vitest.config.ts)
  remains the outer bound.
*/
configure({ asyncUtilTimeout: 5000 })
