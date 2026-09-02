import { afterEach, describe, expect, it, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, within, act, cleanup } from "@testing-library/react"
import { GalleryOverlay } from "./gallery-overlay"
import { SURFACE_REGISTRY } from "./registry"

const ALL_IDS = SURFACE_REGISTRY.flatMap((e) => e.states.map((s) => s.id))
const FIRST = ALL_IDS[0]
const LAST = ALL_IDS[ALL_IDS.length - 1]

beforeEach(() => {
  document.documentElement.classList.remove("dark")
  // The swap surface (now in the registry) fetches /api/editor/catalog on
  // mount. Unstubbed, tests that reach it (e.g. stepping to the last state)
  // trigger a real network attempt that rejects after the test has already
  // finished asserting, logging an act() warning into otherwise-clean output.
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

// Every test below calls `cleanup()` explicitly, synchronously, right after
// its own assertions — instead of relying solely on testing-library's
// automatic (delayed-by-a-tick) `afterEach`. Several registry states now
// drive a real DOM interaction (fill an input, click, wait for the next
// element) from a `useEffect` — see `fixtures/dom-interaction.ts`'s
// `runDrivenInteraction`. Those fixtures guard their own continuation with a
// `cancelled` flag flipped by the effect's cleanup, but that guard only
// helps if cleanup runs BEFORE the continuation's next microtask resumes.
// The registry render test's own tight loop already gets this for free
// (`cleanup()` runs synchronously before the next `render()`), but a test
// here that renders ONE state and returns — relying on the framework's
// afterEach, which fires after Vitest's own await between the test body and
// its hooks — gives that pending microtask exactly the gap it needs to
// resume, click something for real, and produce a state update outside any
// `act()` scope. An explicit synchronous `cleanup()` closes that gap.
describe("GalleryOverlay", () => {
  it("publishes the whole payload the screenshot script depends on", () => {
    render(<GalleryOverlay initialStateId="" />)
    const published = window.__SURFACE_GALLERY_IDS__ ?? []
    // Asserting the FULL shape, not just ids: the shots script reads `kind`
    // (to pick the output directory) and `readyWhen` (to know a driven state
    // has arrived). An id-only assertion stayed green while either field was
    // dropped from the payload — verified by mutation — and the breakage would
    // only show up as a mis-filed or prematurely captured screenshot.
    const expected = SURFACE_REGISTRY.flatMap((entry) =>
      entry.states.map((state) => ({
        id: state.id,
        kind: entry.kind,
        title: entry.title,
        label: state.label,
        readyWhen: state.readyWhen,
      })),
    )
    expect(published).toEqual(expected)
    cleanup()
  })

  it("renders the selected surface and marks it ready", () => {
    render(<GalleryOverlay initialStateId={FIRST} />)
    expect(document.querySelector(`[data-gallery-ready="${FIRST}"]`)).not.toBeNull()
    cleanup()
  })

  it("does not mark ready while nothing is selected", () => {
    render(<GalleryOverlay initialStateId="" />)
    expect(document.querySelector("[data-gallery-ready]")).toBeNull()
    cleanup()
  })

  it("switches surfaces when a picker entry is clicked", () => {
    render(<GalleryOverlay initialStateId="" />)
    fireEvent.click(screen.getByTestId(`gallery-pick-${FIRST}`))
    expect(document.querySelector(`[data-gallery-ready="${FIRST}"]`)).not.toBeNull()
    cleanup()
  })

  it("exposes an in-page selector for the screenshot script", () => {
    render(<GalleryOverlay initialStateId="" />)
    // The call itself still goes through the window global from outside
    // React — exactly what Playwright's page.evaluate will do. `act()` here
    // only drains the update queue before the assertion, which is what
    // Playwright's own waitForSelector does for real in a live browser.
    act(() => {
      window.__SURFACE_GALLERY_SELECT__!(FIRST, "dark")
    })
    expect(document.querySelector(`[data-gallery-ready="${FIRST}"]`)).not.toBeNull()
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    cleanup()
  })

  it("applies the initial theme to the document element", () => {
    render(<GalleryOverlay initialStateId="" initialTheme="dark" />)
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    cleanup()
  })

  it("records callbacks the surface invokes into the action log", () => {
    render(<GalleryOverlay initialStateId="iteration-scope/delete" />)
    // Two steps now: the cards select, the footer button commits. Driving both
    // is also what proves the log captures the REAL callback rather than a
    // click handler on the card.
    fireEvent.click(screen.getByTestId("iteration-scope-all-rows"))
    fireEvent.click(screen.getByTestId("iteration-scope-confirm"))
    const log = screen.getByTestId("gallery-action-log")
    expect(within(log).getByText(/onConfirm/)).toBeInTheDocument()
    cleanup()
  })

  it("wraps to the last state when '[' is pressed with nothing selected", () => {
    render(<GalleryOverlay initialStateId="" />)
    fireEvent.keyDown(window, { key: "[" })
    expect(document.querySelector(`[data-gallery-ready="${LAST}"]`)).not.toBeNull()
    cleanup()
  })
})
