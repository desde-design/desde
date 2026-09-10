/**
 * First tests for `dom-edit-mode` — 930 lines that MUTATE the user's live page
 * and, until 2026-08-09, had no colocated coverage at all. CLAUDE.md says so
 * explicitly: "exercised only via the live smoke harness (bridge-smoke-gated,
 * not unit-tested)."
 *
 * Scoped deliberately to the debounce/exit contract rather than attempting the
 * whole module. That is where the bug was, and it is the part with the worst
 * failure signature: the DOM keeps the user's typed text while the shell is
 * never told, so the preview shows a change no source file explains and no
 * save can capture. Nothing throws and nothing logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { createDomEditMode } from "./dom-edit-mode"
import type { FrameworkRuntimeAdapter } from "./leaf-prop-attribution"
import type { InspectorOverlayManager } from "./inspector-overlay"
import { createOverridePreview } from "./override-preview"

const sent: { type: string; payload?: unknown }[] = []

/** The document id the runtime is configured with for these tests. */
const TEST_DOCUMENT_ID = "doc-under-test"

/** Inspector stub: DOM-edit mode only suspends/restores it. */
const inspector = {
  isActive: () => false,
  activate: () => {},
  deactivate: () => {},
} as unknown as InspectorOverlayManager

/**
 * The REAL override preview, not a stub.
 *
 * Stubbing it meant chasing each member the emit path happened to touch
 * (`chainRegister`, then `store.register`, …) — a stub that keeps growing is a
 * stub that will eventually diverge from the thing it imitates and start
 * passing tests the real object would fail. It has no I/O and no framework
 * dependency, so there is no reason not to use it.
 */
const overridePreview = createOverridePreview()

/** Minimal adapter — only `computeCallsiteLoc` consults it, via the chain. */
const adapter = {
  name: "stub",
  hasOwnInstancePointer: () => false,
  getComponentName: () => null,
  getOwningInstance: () => null,
  isLibraryInstance: () => false,
  getCallSiteStamp: () => null,
  readDeclaredProps: () => ({}),
  wasRenderedByInstanceTemplate: () => true,
  getInstanceMountRoot: () => null,
  getParentInstance: () => null,
  getInstanceFile: () => null,
  getInstanceIterationKey: () => null,
  readConsumerVnodeProps: () => null,
} as unknown as FrameworkRuntimeAdapter

beforeEach(() => {
  sent.length = 0
  vi.useFakeTimers()
  document.body.innerHTML = ""
  configureBridgeRuntime({
    sendToShell: (msg: { type: string; payload?: unknown }) => void sent.push(msg),
    inspectElement: () => ({}) as never,
    attributeElement: () => undefined,
    documentId: TEST_DOCUMENT_ID,
  })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ""
})

function mountEditable(text: string): HTMLElement {
  document.body.innerHTML = `<p data-desde-src="src/App.vue:3:2" data-desde-v="v1">${text}</p>`
  return document.body.querySelector("p")!
}

const captured = () => sent.filter((m) => m.type === "MUTATION_CAPTURED")

describe("dom-edit-mode — a typed edit is never silently dropped", () => {
  it("emits the edit when exit happens INSIDE the debounce window", () => {
    // The regression. `flushDebounced` only cleared the timers despite its
    // name, so leaving DOM-edit mode within 400 ms of the last keystroke
    // discarded the mutation while the DOM kept the new text.
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")
    mode.enter({})

    el.textContent = "After"
    el.dispatchEvent(new Event("input", { bubbles: true }))

    // Exit before the 400 ms debounce elapses.
    vi.advanceTimersByTime(50)
    mode.exit()

    expect(captured(), "the typed edit must reach the shell").toHaveLength(1)
  })

  it("emits exactly once — the flush must not double up with the timer", () => {
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")
    mode.enter({})

    el.textContent = "After"
    el.dispatchEvent(new Event("input", { bubbles: true }))
    vi.advanceTimersByTime(50)
    mode.exit()
    // Run out any timer the flush failed to cancel.
    vi.advanceTimersByTime(1000)

    expect(captured()).toHaveLength(1)
  })

  it("still emits normally when the debounce is allowed to elapse", () => {
    // Control: proves the assertions above are about the exit path, not about
    // emission being broken generally.
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")
    mode.enter({})

    el.textContent = "After"
    el.dispatchEvent(new Event("input", { bubbles: true }))
    vi.advanceTimersByTime(500)

    expect(captured()).toHaveLength(1)
    mode.exit()
    expect(captured(), "exit must not re-emit an already-flushed edit").toHaveLength(1)
  })

  it("emits nothing when the text was never changed", () => {
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")
    mode.enter({})

    // An input event with identical text — focus/blur churn produces these.
    el.dispatchEvent(new Event("input", { bubbles: true }))
    vi.advanceTimersByTime(500)
    mode.exit()

    expect(captured()).toHaveLength(0)
  })

  it("stamps every mutation message with the document it came from", () => {
    // The shell cannot tell a capture from the departed page apart from one made
    // in the page in front of the designer: both arrive as postMessages on one
    // channel, and the shell stamped them with whichever session was live when
    // they were READ. The window is small and the outcome is a write into the
    // wrong file, so the page says who it is.
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")
    mode.enter({})

    el.textContent = "After"
    el.dispatchEvent(new Event("input", { bubbles: true }))
    vi.advanceTimersByTime(500)

    const message = captured()[0] as { payload: { documentId?: string } }
    expect(message.payload.documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps a shell-pinned capture too", () => {
    // The SECOND of the three paths that leave this module. Shell-initiated
    // edits (SET_ELEMENT_TEXT / SET_ELEMENT_CLASSES) skip the typing debounce
    // and the v-for question entirely, so a stamp on the typing path says
    // nothing about them. An unstamped capture is one the shell attributes to
    // whichever session was live when it read the message.
    const mode = createDomEditMode(inspector, overridePreview, adapter)
    const el = mountEditable("Before")

    mode.captureDirectMutationPinned(el, "text", undefined, "Before", "After")

    expect(captured()).toHaveLength(1)
    const message = captured()[0] as { payload: { documentId?: string } }
    expect(message.payload.documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the resolution failure too", () => {
    // The THIRD path, and the one easiest to forget: it carries no mutation, so
    // it is not built by `buildMutation` and does not inherit anything from it.
    // The shell routes this into a status line for the document it names; named
    // wrongly, the designer is told an edit failed on a page they are no longer
    // looking at.
    document.body.innerHTML = "<p>Before</p>"
    const el = document.body.querySelector("p")!
    const mode = createDomEditMode(inspector, overridePreview, adapter)

    mode.captureDirectMutation(el, "text", undefined, "Before", "After")

    const failures = sent.filter((m) => m.type === "MUTATION_RESOLUTION_FAILED")
    expect(failures).toHaveLength(1)
    const message = failures[0] as { payload: { documentId?: string } }
    expect(message.payload.documentId).toBe(TEST_DOCUMENT_ID)
  })
})
