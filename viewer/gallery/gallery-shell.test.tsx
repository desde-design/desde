// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { GalleryShell } from "./harness/gallery-shell"
import { SURFACE_REGISTRY } from "./registry"

/**
 * Walk the whole catalog through the REAL picker, the way a person does.
 *
 * This is not a duplicate of `registry.test.tsx`. That one renders each state
 * on its own, so a fixture only has to be a well-formed React tree. This one
 * renders it INSIDE the shell, which is where the two can disagree — and they
 * did: seven fixtures called `ctx.log(...)` from their `render` body as an
 * annotation. Standalone that is a call to a no-op. Inside the shell it is a
 * `setState` during the shell's own render, which React answers with "Too many
 * re-renders" and an unmounted app. Every state passed the standalone sweep
 * while the gallery could be crashed by clicking one of them.
 *
 * So the assertion is deliberately crude — after visiting every state, is the
 * app still mounted? Nothing finer would have caught that, and nothing finer
 * is what this test is for.
 */
describe("GalleryShell", () => {
  it("survives selecting every state in the catalog", () => {
    const ids = SURFACE_REGISTRY.flatMap((entry) => entry.states.map((state) => state.id))
    render(<GalleryShell registry={SURFACE_REGISTRY} />)

    for (const id of ids) {
      // Through the published selector rather than a click, so this covers a
      // state whose picker button is scrolled out of view, and so a driven
      // fixture's own interaction is not what is under test here.
      act(() => {
        window.__SURFACE_GALLERY_SELECT__!(id)
      })
      expect(
        document.querySelector("[data-gallery-stage]"),
        `the shell unmounted after selecting ${id}`,
      ).not.toBeNull()
    }

    cleanup()
  }, 60_000)
})
