import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { SURFACE_REGISTRY, findSurfaceState } from "./registry"

const allStates = () =>
  SURFACE_REGISTRY.flatMap((entry) => entry.states.map((state) => ({ entry, state })))

// SwapDialog fetches /api/editor/catalog on open (via the thin `editorFetch`
// wrapper around global fetch). Unstubbed, the render test would emit an
// unhandled rejection rather than a clean failure.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
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

  it("points every entry at a source file under src/components", () => {
    for (const entry of SURFACE_REGISTRY) {
      expect(entry.sourceFile, entry.id).toMatch(/^src\/.+\.tsx?$/)
    }
  })

  it("renders every modal and inline state without throwing, with visible content", async () => {
    for (const { entry, state } of allStates()) {
      if (entry.kind === "toast") continue
      expect(() => {
        render(<>{state.render!({ log: () => {} })}</>)
      }, `${state.id} threw while rendering`).not.toThrow()

      // A DRIVEN state (one that types/clicks its way to its target from an
      // effect) has not reached that target at first commit. Waiting on its
      // `readyWhen` selector is what actually exercises the interaction —
      // without it the synchronous `cleanup()` below cancels every driven
      // fixture before its first `await` resumes, so half the catalog was
      // being "swept" without ever running.
      if (state.readyWhen) {
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

      // Not enough to not-throw: a state whose props leave the dialog
      // CLOSED (e.g. a `SaveProgressDialog` combination that `derivePhase`
      // maps to `null`) renders successfully and completely blank — exactly
      // the failure mode `not.toThrow()` alone can't catch, and the one a
      // browser had to find previously. shadcn's Dialog portals its content
      // into `document.body`, outside the container `render()` returns, so
      // the check has to look at the whole document rather than the local
      // container.
      expect(
        document.body.textContent?.trim().length ?? 0,
        `${state.id} rendered no visible content`,
      ).toBeGreaterThan(0)
      cleanup()
    }
    /*
      Explicit timeout: this is a sweep over the WHOLE catalogue, and driven
      states block on real `waitFor` polling. Budget for the loaded case, not
      the isolated one.

      The 30s this used to carry was sized against "~2s standalone". That is
      no longer true and the number moved with the catalogue, not with any
      change here. MEASURED 2026-08-24 on an otherwise idle machine:

        standalone .......... 8,326ms   (28% of the old 30s budget)
        under contention .... 46,013ms  (77% of the new 60s budget)

      Standalone was never the problem. Contention is, and it is not exotic:
      it was this repo's other two suites running at the same time, which is
      routine when concurrent sessions share the checkout. At 30s this test
      fails there; at 60s it has room. 60s also matches the Viewer's identical
      sweep (`viewer/gallery/registry.test.tsx`), which has had that budget
      all along.

      This is a growing cost, not a fixed one. It scales with the number of
      gallery states, so treat a future failure here as "the catalogue got
      bigger", and split the sweep rather than raising the number again.
    */
  }, 60_000)

  it("fires every toast state, pinned open so it can be screenshotted", () => {
    // The render sweep above skips `kind: "toast"` — those states have no node
    // to render, so without this they would have no coverage at all and a typo
    // in a payload would only surface in a browser.
    //
    // The pin is the load-bearing assertion. An auto-dismissing toast may be
    // gone by the time the screenshot is taken, and the result is a blank tile
    // that reads as a broken fixture rather than a timing bug. Spying on the
    // real sonner module checks what each fixture ACTUALLY passes, rather than
    // trusting that every call site remembered the option.
    // Every level the fixtures can fire. `loading` and `message` were added
    // when the catalog grew its spinner and neutral shapes; a level missing
    // from this list makes its states look like they fired nothing at all,
    // which is how the sweep reports a fixture that is genuinely inert.
    const spies = (["error", "warning", "success", "info", "loading", "message"] as const).map((level) =>
      vi.spyOn(toast, level).mockImplementation(() => "stub-id"),
    )
    try {
      const toastStates = allStates().filter(({ entry }) => entry.kind === "toast")
      expect(toastStates.length, "expected the catalog to include toast states").toBeGreaterThan(0)

      for (const { state } of toastStates) {
        spies.forEach((s) => s.mockClear())
        expect(() => {
          state.fire!({ log: () => {} })
        }, `${state.id} threw while firing`).not.toThrow()

        const calls = spies.flatMap((s) => s.mock.calls)
        expect(calls.length, `${state.id} fired no toast`).toBeGreaterThan(0)
        for (const [, options] of calls) {
          expect(
            (options as { duration?: number } | undefined)?.duration,
            `${state.id} fired a toast that is not pinned open — it would vanish before capture`,
          ).toBe(Infinity)
        }
      }
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })

  it("gives every driven state a readyWhen selector", () => {
    // A driven fixture is one that reaches its target through a real
    // interaction rather than props. There is no way to detect that from the
    // outside, so this is the honest inverse: any state whose module drives an
    // interaction must declare how to tell when it has arrived. Kept as a
    // reminder at review time rather than a runtime check.
    const driven = allStates().filter(({ state }) => state.readyWhen)
    expect(driven.length, "expected at least one driven state to declare readyWhen").toBeGreaterThan(0)
    for (const { state } of driven) {
      expect(state.readyWhen, `${state.id} readyWhen must be a non-empty selector`).toBeTruthy()
      expect(() => document.querySelector(state.readyWhen!)).not.toThrow()
    }
  })

  it("resolves a known id and rejects an unknown one", () => {
    const known = allStates()[0].state.id
    expect(findSurfaceState(known)?.state.id).toBe(known)
    expect(findSurfaceState("no-such/state")).toBeNull()
  })
})
