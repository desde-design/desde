// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { SURFACE_REGISTRY, findSurfaceState } from "./registry"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * The catalog's own guard.
 *
 * A fixture that typechecks can still blow up at render — a required nested
 * field left out, a wire shape that fails the component's own type guard, an
 * effect that throws. `tsc` cannot see any of that, and neither can a person
 * clicking through, because nobody clicks all of it. So this renders every
 * state and asserts each one produced something.
 *
 * "Produced something" is the load-bearing half. `not.toThrow()` alone passes
 * for a state whose props leave a dialog CLOSED — it renders successfully and
 * completely blank, which is exactly the failure a catalog exists to prevent.
 */

const allStates = () =>
  SURFACE_REGISTRY.flatMap((entry) => entry.states.map((state) => ({ entry, state })))

afterEach(() => {
  cleanup()
})

describe("SURFACE_REGISTRY", () => {
  it("registers at least one state", () => {
    expect(allStates().length).toBeGreaterThan(0)
  })

  it("has a globally unique id for every state", () => {
    const ids = allStates().map(({ state }) => state.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("namespaces every state id under its entry id", () => {
    for (const { entry, state } of allStates()) {
      expect(state.id, `${state.id} must start with "${entry.id}/"`).toMatch(
        new RegExp(`^${entry.id}/`),
      )
    }
  })

  it("gives every state exactly one of render/fire", () => {
    for (const { state } of allStates()) {
      const provided = [state.render, state.fire].filter(Boolean).length
      expect(provided, `${state.id} must define exactly one of render/fire`).toBe(1)
    }
  })

  /**
   * The guard used to assert the prefix `viewer/app/` and nothing else, under
   * a title that claimed it checked for a real file. It did not: a typo or a
   * moved component passed happily as long as the path started right.
   *
   * It now checks the file EXISTS, which is what the title always promised,
   * and allows a second location — `src/components/**`. Almost every surface
   * here is one of the viewer's own screens, but a few are SHARED blocks the
   * viewer renders and which cannot be reviewed anywhere else: the loading
   * animation shows over the prototype iframe for a few hundred milliseconds,
   * so in situ it is gone before it can be looked at.
   *
   * The allowance is deliberately two prefixes rather than none. This catalog
   * is about what the VIEWER shows; it is not a second home for the shared
   * design system, which the Editor's gallery already covers.
   */
  it("points every entry at a file that exists, in the viewer or in a shared block", () => {
    // `import.meta.url` is a dev-server URL under this runner, not a file
    // URL, so `fileURLToPath` cannot resolve it. Vitest runs with `viewer/`
    // as its root, so the repo is one level up from cwd.
    const repoRoot = join(process.cwd(), "..")
    for (const entry of SURFACE_REGISTRY) {
      expect(entry.sourceFile, entry.id).toMatch(
        /^(viewer\/app|src\/components)\/.+\.tsx?$/,
      )
      expect(
        existsSync(join(repoRoot, entry.sourceFile)),
        `${entry.id} points at a file that does not exist: ${entry.sourceFile}`,
      ).toBe(true)
    }
  })

  it("renders every state without throwing, with visible content", async () => {
    for (const { state } of allStates()) {
      expect(() => {
        render(<>{state.render!({ log: () => {} })}</>)
      }, `${state.id} threw while rendering`).not.toThrow()

      // A DRIVEN state (one that types and clicks its way to its target from
      // an effect) has not arrived at first commit. Waiting on its `readyWhen`
      // selector is what actually exercises the interaction — without it the
      // synchronous `cleanup()` below cancels every driven fixture before its
      // first `await` resumes, so half the catalog would be swept without ever
      // running.
      // `needsBrowser` states cannot arrive here by construction — see that
      // field's own doc comment. They are still rendered above and still have
      // to produce visible content; only the arrival wait is skipped.
      if (state.readyWhen && !state.needsBrowser) {
        const selector = state.readyWhen
        await waitFor(
          () => {
            expect(
              document.querySelector(selector),
              `${state.id} never reached readyWhen: ${selector}`,
            ).not.toBeNull()
          },
          { timeout: 3000 },
        )
      }

      // Not enough to not-throw: a state whose props leave a dialog CLOSED,
      // or whose panel renders `null` until its own fetch resolves, renders
      // successfully and completely blank. That is the failure this catches.
      //
      // Waited for rather than asserted immediately, because most of this
      // catalog is fed by a mocked `fetch` and a fetch resolves a tick after
      // the first commit. A dialog also portals its content to
      // `document.body`, outside the container `render()` returns, so this
      // looks at the whole document rather than at that container.
      await waitFor(
        () => {
          expect(
            document.body.textContent?.trim().length ?? 0,
            `${state.id} rendered no visible content`,
          ).toBeGreaterThan(0)
        },
        { timeout: 3000 },
      )
      cleanup()
    }
    // Explicit timeout: this is a sweep over the WHOLE catalog, and driven
    // states block on real polling.
  }, 60_000)

  it("gives every browser-only state a reason and a readyWhen", () => {
    // `needsBrowser` buys a state an exemption from the arrival wait above, so
    // it has to say why in prose a person can weigh — an empty marker would be
    // a silent hole in the sweep. And it must still declare `readyWhen`: that
    // selector is what a live check has to look for, and it is the only record
    // of what "arrived" means for that state.
    const browserOnly = allStates().filter(({ state }) => state.needsBrowser)
    for (const { state } of browserOnly) {
      expect(state.needsBrowser!.length, `${state.id} needsBrowser must say why`).toBeGreaterThan(20)
      expect(
        state.readyWhen,
        `${state.id} is browser-only and must still declare readyWhen`,
      ).toBeTruthy()
    }
  })

  it("resolves a known id and rejects an unknown one", () => {
    const known = allStates()[0].state.id
    expect(findSurfaceState(known)?.state.id).toBe(known)
    expect(findSurfaceState("no-such/state")).toBeNull()
  })
})
