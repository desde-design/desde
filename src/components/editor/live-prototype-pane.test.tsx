/**
 * Smoke tests for `<LivePrototypePane>` + `useEditorEditing`. The
 * pane is now a thin iframe renderer; adapter wiring lives in the hook.
 * Tests use a `<Harness>` that wires the hook to a manually-rendered
 * iframe + status banner, mirroring how `<EditorSurface>` and the
 * project route compose them.
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { LivePrototypePane } from "./live-prototype-pane"
import { useEditorEditing } from "@/hooks/useEditorEditing"
import { useEditorStore } from "@/stores/editor-only"
import type { ComponentManifest, ComponentManifestSource } from "@/editor/core"

// Bridge-connection status is now a bottom-right toast, not a pane banner.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

// Phase 5 widening (2026-07-30): inspection-time drift detection reports
// through the SAME `useDriftReporter` hook the commit-time site uses. Mock
// it here so these tests assert "was a signal reported" directly (synchronous
// spy) instead of re-exercising `useDriftReporter`'s own debounce/POST
// plumbing, which already has dedicated coverage in useDriftReporter.test.ts.
// Return the SAME object reference on every call — matching the real
// hook's `useMemo`-stabilized return value. A fresh object per call would
// break the `useCallback`/`useEffect` dependency chain downstream
// (`reportDriftForAttribution` depends on `driftReporter`; the adapter
// lifecycle effect depends on `reportDriftForAttribution`), causing the
// effect to tear down and recreate the bridge adapter on every render.
const { driftReportSpy, driftReporterMock } = vi.hoisted(() => {
  const driftReportSpy = vi.fn()
  return { driftReportSpy, driftReporterMock: { report: driftReportSpy } }
})
vi.mock("@/hooks/useDriftReporter", () => ({
  useDriftReporter: () => driftReporterMock,
}))

// Lets one test simulate a malformed/throwing `detectDrift` (e.g. a corrupt
// on-disk manifest cache) to prove the inspection-time call site's
// advisory-first guarantee: a throw here must never affect selection
// handling. Every other test leaves this at its default (delegate to the
// real implementation).
const { detectDriftShouldThrow } = vi.hoisted(() => ({
  detectDriftShouldThrow: { current: false },
}))
vi.mock("@/editor/attribution/detect-drift", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/editor/attribution/detect-drift")>()
  return {
    ...actual,
    detectDrift: (...args: Parameters<typeof actual.detectDrift>) => {
      if (detectDriftShouldThrow.current) {
        throw new Error("simulated malformed manifest — detectDrift threw")
      }
      return actual.detectDrift(...args)
    },
  }
})

interface MockIframeSetup {
  contentWindow: { postMessage: ReturnType<typeof vi.fn> }
  postMessages: unknown[]
}

const PROTOTYPE_URL = "https://prototype.example.com/dashboard"

let activeMockSetup: MockIframeSetup | null = null

beforeEach(() => {
  activeMockSetup = installContentWindowMock()
  useEditorStore.getState().resetEditor()
})

afterEach(() => {
  uninstallContentWindowMock()
  activeMockSetup = null
})

function installContentWindowMock(): MockIframeSetup {
  const postMessages: unknown[] = []
  const contentWindow = {
    postMessage: vi.fn((message: unknown) => {
      postMessages.push(message)
    }),
  }
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get() {
      return contentWindow
    },
  })
  return { contentWindow, postMessages }
}

function uninstallContentWindowMock(): void {
  delete (HTMLIFrameElement.prototype as unknown as { contentWindow?: unknown }).contentWindow
}

function emitFromBridge(message: Record<string, unknown>): void {
  const setup = activeMockSetup
  if (!setup) throw new Error("no active mock setup")
  const event = new Event("message") as MessageEvent
  Object.defineProperty(event, "data", {
    value: { source: "desde-bridge", ...message },
  })
  Object.defineProperty(event, "source", { value: setup.contentWindow })
  window.dispatchEvent(event)
}

interface HarnessProps {
  prototypeUrl?: string
  manifestSource?: ComponentManifestSource
  /** Capture the hook's return so a test can drive it (e.g. setEditorActive). */
  onEditing?: (editing: ReturnType<typeof useEditorEditing>) => void
}

function Harness({
  prototypeUrl = PROTOTYPE_URL,
  manifestSource,
  onEditing,
}: HarnessProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const editing = useEditorEditing({
    iframeRef,
    prototypeUrl,
    manifestSource,
  })
  onEditing?.(editing)
  return (
    <LivePrototypePane
      prototypeUrl={prototypeUrl}
      iframeRef={iframeRef}
      status={editing.status}
    />
  )
}

describe("LivePrototypePane + useEditorEditing", () => {
  it("renders an iframe pointed at the prototype URL", () => {
    render(<Harness />)
    const iframe = screen.getByTitle("Prototype") as HTMLIFrameElement
    expect(iframe.src).toBe(PROTOTYPE_URL)
  })

  it("toasts a loading status before the prototype answers, without naming the bridge", () => {
    // "bridge" is the name of our transport. What the reader is waiting on is
    // their own prototype appearing (Mo, 2026-08-18).
    render(<Harness />)
    expect(toast.loading).toHaveBeenCalledWith(
      expect.stringMatching(/^loading prototype$/i),
      expect.objectContaining({ id: expect.any(String) }),
    )
    expect(toast.loading).not.toHaveBeenCalledWith(
      expect.stringMatching(/bridge/i),
      expect.anything(),
    )
  })

  it("stays quiet on a reconnect after the bridge has connected once", () => {
    // Drive the pane directly so we can replay connecting → ready →
    // connecting (a reconnect from an iframe full-reload, e.g. an
    // `npm run build:bridge` the bridge-plugin pushes a reload for).
    const iframeRef: { current: HTMLIFrameElement | null } = { current: null }
    ;(toast.loading as ReturnType<typeof vi.fn>).mockClear()
    const { rerender } = render(
      <LivePrototypePane
        prototypeUrl={PROTOTYPE_URL}
        iframeRef={iframeRef}
        status={{ kind: "connecting" }}
      />,
    )
    // First connect surfaces the toast.
    expect(toast.loading).toHaveBeenCalledTimes(1)

    rerender(
      <LivePrototypePane
        prototypeUrl={PROTOTYPE_URL}
        iframeRef={iframeRef}
        status={{ kind: "ready" }}
      />,
    )
    ;(toast.loading as ReturnType<typeof vi.fn>).mockClear()

    // Reconnect: status returns to "connecting" — must NOT re-toast.
    rerender(
      <LivePrototypePane
        prototypeUrl={PROTOTYPE_URL}
        iframeRef={iframeRef}
        status={{ kind: "connecting" }}
      />,
    )
    expect(toast.loading).not.toHaveBeenCalled()
  })

  it("clears the connecting banner and handshakes in navigate mode on BRIDGE_READY", async () => {
    render(<Harness />)

    // The adapter no longer kicks the bridge with a NAVIGATE before
    // BRIDGE_READY (it caused a reload loop with prototypes that route
    // away from the src pathname). So no messages flow until BRIDGE_READY
    // arrives.
    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })

    // Bridge connected once the handshake messages start flowing.
    await waitFor(() => {
      expect(activeMockSetup!.postMessages.length).toBeGreaterThan(0)
    })

    const types = activeMockSetup!.postMessages.map(
      (m) => (m as { type: string }).type,
    )
    // The editor connects in NAVIGATE mode by default (iframeMode === 'navigate';
    // editor-active only flips on when the user switches to 'select' — see
    // editor-surface.tsx). So on connect the adapter handshakes and applies the
    // inactive default — it must NOT auto-activate the inspector.
    expect(types).toContain("PING")
    expect(types).toContain("GET_STRUCTURE")
    expect(types).toContain("EXIT_EDITOR_MODE")
    expect(types).toContain("DEACTIVATE_INSPECTOR")
    expect(types).not.toContain("ACTIVATE_INSPECTOR")
    expect(types).not.toContain("ENTER_EDITOR_MODE")
  })

  it("dispatches the activation triple when select (compose) mode is enabled", async () => {
    let editing: ReturnType<typeof useEditorEditing> | null = null
    render(<Harness onEditing={(e) => { editing = e }} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })
    // Bridge connected once the handshake messages start flowing.
    await waitFor(() => {
      expect(activeMockSetup!.postMessages.length).toBeGreaterThan(0)
    })

    // Switching into select/compose mode is what activates the inspector —
    // editor-surface drives this via setEditorActive(iframeMode === 'select').
    activeMockSetup!.postMessages.length = 0
    await act(async () => {
      await editing!.setEditorActive(true)
    })

    const types = activeMockSetup!.postMessages.map(
      (m) => (m as { type: string }).type,
    )
    expect(types).toContain("ACTIVATE_INSPECTOR")
    expect(types).toContain("ENTER_EDITOR_MODE")
    // And NOT the per-frame hover stream: nothing consumes HOVER_TARGET_CHANGED,
    // so enabling it only bought a selector build + component-tree walk +
    // postMessage on every animation frame the cursor moved.
    expect(types).not.toContain("ENABLE_HOVER_EVENTS")
  })

  it("looks up the manifest by component name when ELEMENT_INSPECTED arrives", async () => {
    // The source is passed EXPLICITLY. This test used to render `<Harness />`
    // bare and rely on the hook's old default being an Acme DSManifestSource
    // that happened to bundle a UiButton manifest — so it was asserting the
    // coupling rather than the behaviour. The hook now defaults to an empty
    // composite (a caller who supplies nothing gets no manifests, never another
    // substrate's catalog), and what this test is actually about — name →
    // manifest lookup on ELEMENT_INSPECTED — is unchanged and substrate-neutral.
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "test-ds",
      listComponents: async () => [],
      getComponent: async (name: string) =>
        name === "UiButton"
          ? ({
              id: "test:UiButton",
              name: "UiButton",
              framework: "vue3",
              designSystem: "test-ds",
              props: [],
            } satisfies ComponentManifest)
          : null,
    }
    render(<Harness manifestSource={manifestSource} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })

    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        payload: {
          tagName: "button",
          id: "",
          classes: [],
          rect: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
          styles: [],
          tokens: [],
          boxModel: {
            width: 0,
            height: 0,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            border: { top: 0, right: 0, bottom: 0, left: 0 },
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
            content: { width: 0, height: 0 },
          },
          selector: "[data-testid=\"submit\"]",
          componentTree: [{ name: "UiButton", elementSelector: "[data-testid=\"submit\"]" }],
        },
      })
    })

    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorSelection?.componentName).toBe("UiButton")
      expect(state.editorManifest?.name).toBe("UiButton")
    })
  })

  it("clears manifest when an unknown component name is selected", async () => {
    render(<Harness />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })

    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        payload: {
          tagName: "div",
          id: "",
          classes: [],
          rect: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
          styles: [],
          tokens: [],
          boxModel: {
            width: 0,
            height: 0,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            border: { top: 0, right: 0, bottom: 0, left: 0 },
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
            content: { width: 0, height: 0 },
          },
          selector: "#unknown",
          componentTree: [{ name: "MysteryComponent", elementSelector: "#unknown" }],
        },
      })
    })

    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorSelection?.componentName).toBe("MysteryComponent")
      expect(state.editorManifest).toBeNull()
    })
  })

  it("clears the manifest gracefully when the manifestSource throws (regression for codex P1)", async () => {
    // The V1.4 wiring uses a `RemoteManifestSource` which can reject
    // with network/5xx errors. Without explicit handling those become
    // unhandled rejections and break repeated selection. The hook must
    // catch and clear instead.
    const throwingSource: ComponentManifestSource = {
      id: "throwing",
      framework: "vue3" as const,
      designSystem: "test",
      listComponents: async () => [],
      getComponent: async () => {
        throw new Error("simulated network failure")
      },
    }
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      render(<Harness manifestSource={throwingSource} />)
      await act(async () => {
        emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
      })
      await act(async () => {
        emitFromBridge({
          type: "ELEMENT_INSPECTED",
          payload: {
            tagName: "button",
            id: "",
            classes: [],
            rect: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
            styles: [],
            tokens: [],
            boxModel: {
              width: 0,
              height: 0,
              margin: { top: 0, right: 0, bottom: 0, left: 0 },
              border: { top: 0, right: 0, bottom: 0, left: 0 },
              padding: { top: 0, right: 0, bottom: 0, left: 0 },
              content: { width: 0, height: 0 },
            },
            selector: "[data-testid=\"submit\"]",
            componentTree: [{ name: "UiButton", elementSelector: "[data-testid=\"submit\"]" }],
          },
        })
      })
      await waitFor(() => {
        const state = useEditorStore.getState()
        expect(state.editorSelection?.componentName).toBe("UiButton")
        expect(state.editorManifest).toBeNull()
      })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ──────────────── Phase 5 widening (2026-07-30): inspection-time drift ────────────────
// Carry-forward from the grounding rearchitecture's Phase 5: `detectDrift`
// used to run ONLY at text-edit commit (`handleEditTextField`). It now also
// runs off the selection-change handler's manifest prefetch, so a click
// alone can surface a signal. See `reportDriftForAttribution` in
// `useEditorEditing.ts`.

const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }
const ZERO_BOX_MODEL = {
  width: 0,
  height: 0,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  border: { top: 0, right: 0, bottom: 0, left: 0 },
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  content: { width: 0, height: 0 },
}

const KLABEL_SELECTOR = "[data-testid=\"path-label\"]"

/** Manifest with a trusted rendering hint matching `:root`, and `info` declared as a prop (so a consumer passing it doesn't itself count as `unknown-props` noise). */
function klabelManifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: "acme-ds.ui-label",
    name: "UiLabel",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    props: [{ name: "info", type: "string", required: false, control: { kind: "text" } }],
    rendering: [
      {
        kind: "dom",
        source: { kind: "slot", name: "default" },
        domTarget: { selector: ":root", field: "textContent" },
        editability: "literal",
      },
    ],
    ...overrides,
  }
}

/**
 * Builds an ELEMENT_INSPECTED payload for a clicked `<UiLabel>` whose owning
 * component is `UiLabel` and whose (unmanifested) parent is
 * `AIGatewayModelCreate`. `componentTree` is ROOT-FIRST (bridge/legacy
 * convention — `inspectionDataToSelection` picks the LAST entry as
 * `primary` absent an `editTargetComponent`), while
 * `attributionContext.componentChain` is LEAF-FIRST (attribution
 * convention) — deliberately opposite orderings, matching the real bridge.
 */
function klabelInspectedPayload(clickedSelectorWithinMountRoot: string) {
  return {
    tagName: "label",
    id: "",
    classes: [],
    rect: ZERO_RECT,
    styles: [],
    tokens: [],
    boxModel: ZERO_BOX_MODEL,
    selector: KLABEL_SELECTOR,
    componentTree: [
      { name: "AIGatewayModelCreate", elementSelector: "#app" },
      { name: "UiLabel", elementSelector: KLABEL_SELECTOR, file: "form.vue" },
    ],
    attributionContext: {
      clickedElement: {
        selectorWithinMountRoot: clickedSelectorWithinMountRoot,
        textContent: "Additional base paths",
      },
      componentChain: [
        {
          name: "UiLabel",
          importPath: "@acme/design-system",
          consumerSourceLoc: { file: "form.vue", line: 70, column: 21 },
          consumerVnodeProps: { info: { kind: "literal", value: "hint" } },
        },
        { name: "AIGatewayModelCreate" },
      ],
    },
  }
}

const KBUTTON_SELECTOR = "[data-testid=\"submit-button\"]"

/** Same shape as `klabelManifest`, distinct component name — used by the superseded-selection race test so selection B's signal is unmistakably distinguishable from selection A's. */
function kbuttonManifest(overrides: Partial<ComponentManifest> = {}): ComponentManifest {
  return {
    id: "acme-ds.ui-button",
    name: "UiButton",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    props: [],
    rendering: [
      {
        kind: "dom",
        source: { kind: "slot", name: "default" },
        domTarget: { selector: ":root", field: "textContent" },
        editability: "literal",
      },
    ],
    ...overrides,
  }
}

/** Same shape/conventions as `klabelInspectedPayload`, for a clicked `<UiButton>`. */
function kbuttonInspectedPayload(clickedSelectorWithinMountRoot: string) {
  return {
    tagName: "button",
    id: "",
    classes: [],
    rect: ZERO_RECT,
    styles: [],
    tokens: [],
    boxModel: ZERO_BOX_MODEL,
    selector: KBUTTON_SELECTOR,
    componentTree: [
      { name: "AIGatewayModelCreate", elementSelector: "#app" },
      { name: "UiButton", elementSelector: KBUTTON_SELECTOR, file: "form.vue" },
    ],
    attributionContext: {
      clickedElement: {
        selectorWithinMountRoot: clickedSelectorWithinMountRoot,
        textContent: "Submit",
      },
      componentChain: [
        {
          name: "UiButton",
          importPath: "@acme/design-system",
          consumerSourceLoc: { file: "form.vue", line: 90, column: 5 },
        },
        { name: "AIGatewayModelCreate" },
      ],
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  // A real (not fake) zero-delay timeout guarantees every pending
  // microtask — including the `prefetch().then()` chain, which is a
  // SEPARATE promise chain from the one `waitFor` below synchronizes on
  // (`manifestSource.getComponent` for the panel) — has had a chance to
  // settle before we assert on `driftReportSpy`.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("inspection-time drift detection (2026-07-30 widening)", () => {
  beforeEach(() => {
    driftReportSpy.mockClear()
    detectDriftShouldThrow.current = false
  })

  afterEach(() => {
    detectDriftShouldThrow.current = false
  })

  it("reports nothing when the manifest and the click agree (healthy component)", async () => {
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async (name: string) => (name === "UiLabel" ? klabelManifest() : null),
    }
    render(<Harness manifestSource={manifestSource} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })
    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        // Clicked element's selector-within-mount-root matches the
        // manifest's `:root` dom hint — attribute() resolves `direct`,
        // no rule in detectDrift fires.
        payload: klabelInspectedPayload(":root"),
      })
    })

    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorSelection?.componentName).toBe("UiLabel")
      expect(state.editorManifest?.name).toBe("UiLabel")
    })
    await flushMicrotasks()

    expect(driftReportSpy).not.toHaveBeenCalled()
  })

  it("reports a hint-miss purely from a click — no edit involved", async () => {
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async (name: string) => (name === "UiLabel" ? klabelManifest() : null),
    }
    render(<Harness manifestSource={manifestSource} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })
    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        // Clicked element's selector does NOT match the manifest's
        // `:root` hint — attribute() refuses, detectHintMiss fires.
        payload: klabelInspectedPayload(".unmatched-selector"),
      })
    })

    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorManifest?.name).toBe("UiLabel")
    })
    await flushMicrotasks()

    expect(driftReportSpy).toHaveBeenCalledTimes(1)
    const [signals] = driftReportSpy.mock.calls[0] as [Array<{ kind: string; component: string }>]
    expect(signals).toContainEqual(
      expect.objectContaining({ kind: "hint-miss", component: "UiLabel" }),
    )
  })

  it("never lets a throw inside detection affect selection handling (advisory-first)", async () => {
    detectDriftShouldThrow.current = true
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async (name: string) => (name === "UiLabel" ? klabelManifest() : null),
    }
    render(<Harness manifestSource={manifestSource} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })
    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        payload: klabelInspectedPayload(":root"),
      })
    })

    // Selection handling — including the manifest-panel lookup, a
    // completely separate concern from drift — must complete normally
    // even though detectDrift threw.
    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorSelection?.componentName).toBe("UiLabel")
      expect(state.editorManifest?.name).toBe("UiLabel")
    })
    await flushMicrotasks()

    expect(driftReportSpy).not.toHaveBeenCalled()
  })

  it("suppresses unknown-component when the prefetch fetch itself failed (not a confirmed miss)", async () => {
    // Simulates a transient manifest-source failure (network/5xx) for
    // EVERY component in the chain — including the owning UiLabel, whose
    // importPath (`@acme/design-system`) looks exactly like the package
    // evidence `detectUnknownComponent` gates on. Without the
    // `hasFailedFetch` guard in `reportDriftForAttribution`, this would
    // read as "confirmed no manifest for UiLabel" and falsely report
    // unknown-component on the very first click of a session.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async () => {
        throw new Error("simulated network failure")
      },
    }
    try {
      render(<Harness manifestSource={manifestSource} />)

      await act(async () => {
        emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
      })
      await act(async () => {
        emitFromBridge({
          type: "ELEMENT_INSPECTED",
          payload: klabelInspectedPayload(":root"),
        })
      })

      await waitFor(() => {
        const state = useEditorStore.getState()
        expect(state.editorSelection?.componentName).toBe("UiLabel")
        // The panel lookup failed too (same throwing source) — expected,
        // and irrelevant to the drift assertion below.
        expect(state.editorManifest).toBeNull()
      })
      await flushMicrotasks()

      expect(driftReportSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("supersedes a still-pending prefetch — selection B before selection A's prefetch settles means A never reports", async () => {
    // Pins the exact race the staleness guard exists for (flagged in
    // review as asserted only by hand-traced reasoning, not a test):
    // selection A's manifest fetch is still in flight when selection B
    // arrives and supersedes it; only once A's fetch FINALLY settles does
    // its `.then()` callback run — and by then `latestSelector` points at
    // B, so A must be silently dropped rather than reporting stale drift.
    let resolveUiLabel!: (manifest: ComponentManifest | null) => void
    const klabelPending = new Promise<ComponentManifest | null>((resolve) => {
      resolveUiLabel = resolve
    })
    const manifestSource: ComponentManifestSource = {
      id: "test",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async (name: string) => {
        // UiLabel (selection A) hangs until the test explicitly resolves
        // it — simulating a fetch still in flight when B arrives. UiButton
        // (selection B) and every ancestor resolve immediately.
        if (name === "UiLabel") return klabelPending
        if (name === "UiButton") return kbuttonManifest()
        return null
      },
    }
    render(<Harness manifestSource={manifestSource} />)

    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-05-06a" } })
    })

    // Selection A: UiLabel, clicked selector deliberately mismatched so —
    // WERE it ever evaluated — it would produce a hint-miss. Its prefetch
    // (and the parallel manifest-panel lookup) both hang on `klabelPending`.
    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        payload: klabelInspectedPayload(".unmatched-label-selector"),
      })
    })
    await flushMicrotasks()
    expect(useEditorStore.getState().editorSelection?.componentName).toBe("UiLabel")
    expect(driftReportSpy).not.toHaveBeenCalled() // A's prefetch hasn't settled yet

    // Selection B arrives BEFORE A's prefetch resolves — supersedes A.
    // UiButton's clicked selector is also mismatched, so its own detection
    // (once ITS prefetch settles, which happens immediately) produces a
    // hint-miss too — proving B's detection proceeds normally rather than
    // being collaterally suppressed by A's still-pending fetch.
    await act(async () => {
      emitFromBridge({
        type: "ELEMENT_INSPECTED",
        payload: kbuttonInspectedPayload(".unmatched-button-selector"),
      })
    })
    await waitFor(() => {
      const state = useEditorStore.getState()
      expect(state.editorSelection?.componentName).toBe("UiButton")
      expect(state.editorManifest?.name).toBe("UiButton")
    })
    await flushMicrotasks()

    expect(driftReportSpy).toHaveBeenCalledTimes(1)
    const [bSignals] = driftReportSpy.mock.calls[0] as [Array<{ kind: string; component: string }>]
    expect(bSignals).toContainEqual(
      expect.objectContaining({ kind: "hint-miss", component: "UiButton" }),
    )

    // NOW resolve A's long-pending fetch — its `.then()` finally runs,
    // but `latestSelector` has moved on to B, so the staleness guard must
    // drop it silently: no second report, and definitely nothing for UiLabel.
    await act(async () => {
      resolveUiLabel(klabelManifest())
    })
    await flushMicrotasks()

    expect(driftReportSpy).toHaveBeenCalledTimes(1) // still just B's — A never reported
    expect(driftReportSpy).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ component: "UiLabel" })]),
    )
  })
})

/**
 * The wired class-edit lane's SEQUENCING (final-review C1). The pure evaluator
 * and the bridge walker each had good coverage; what nothing checked was the
 * order the shell runs them in — and that is where the critical defect lived.
 *
 * The live class preview stamps its declarations inline with `!important`
 * (bridge `applyClassOverride`), so a cascade walk performed while the override
 * is still held measures editor's OWN shim and reports every successful edit
 * as "overridden by inline style !important". The fix is release-then-verify:
 * `RESOLVE_OVERRIDE { confirmed }` goes out as soon as the write lands (which
 * also fires the bridge retire hook that strips the shim), and verification runs
 * afterwards, diagnostically. These tests pin that: the release must NOT wait on
 * any verification read, and it must happen exactly once.
 */
describe("class-edit lane — release-then-verify sequencing", () => {
  const CLASS_MUTATION = {
    id: "dom-mut-1",
    kind: "class" as const,
    sourceLoc: "src/components/Card.vue:9:4",
    sourceVersion: "abc123",
    resolutionKind: "direct" as const,
    scope: "definition" as const,
    callsiteLoc: null,
    callsiteVersion: null,
    instancePath: "0",
    selector: "#card",
    before: "card",
    after: "card bg-red-500",
  }

  function resolveOverrideMessages(): Array<{
    type: string
    payload: { id: string; outcome: string }
  }> {
    return activeMockSetup!.postMessages.filter(
      (m) => (m as { type: string }).type === "RESOLVE_OVERRIDE",
    ) as Array<{ type: string; payload: { id: string; outcome: string } }>
  }

  async function driveClassEdit(): Promise<void> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // The edit dispatch POSTs /api/editor/edit; answer "applied" so the lane
    // reaches its success branch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, newHashes: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    render(<Harness />)
    await act(async () => {
      emitFromBridge({ type: "BRIDGE_READY", payload: { version: "2026-06-08a-style-provenance" } })
    })
    await waitFor(() => {
      expect(activeMockSetup!.postMessages.length).toBeGreaterThan(0)
    })
    await act(async () => {
      emitFromBridge({ type: "MUTATION_CAPTURED", payload: CLASS_MUTATION })
    })
    // Past the dispatch debounce, then let the POST + its continuation settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("releases the override as confirmed without waiting for any verification read", async () => {
    await driveClassEdit()

    // Released — and note that NO provenance/value reply has been emitted, and
    // the verification budget (settle 250ms + up to 3s of polling) has not been
    // satisfied by anything. If the release were gated on the verdict, this
    // would still be empty.
    const released = resolveOverrideMessages()
    expect(released).toHaveLength(1)
    expect(released[0].payload).toEqual({
      id: CLASS_MUTATION.id,
      outcome: "confirmed",
      reason: undefined,
    })
  })

  it("does not re-resolve the override when verification later times out", async () => {
    await driveClassEdit()
    // Let the whole verification budget lapse with no bridge answers at all —
    // provenance reads time out, the cascade lane reports a skip/failure, and
    // NOTHING may resolve the override a second time (a double-resolve is how
    // an `ineffective` could clobber an already-released preview).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(resolveOverrideMessages()).toHaveLength(1)
    expect(resolveOverrideMessages()[0].payload.outcome).toBe("confirmed")
  })

  it("keys the cascade-verification record under the SAME id the ledger receives as correlationId (P2-1)", async () => {
    await driveClassEdit()

    // `buildStyleEdit` (`style-edit-builders.ts`) mints a FRESH id for the
    // dispatched edit (`makeEditId()`), distinct from `CLASS_MUTATION.id` —
    // so the true join key can never equal the mutation's own id. Recover
    // it from the actual POST body the (stubbed) fetch received, which is
    // exactly what the server records as the ledger row's `correlationId`
    // (`build-edit-request.ts`'s single choke point).
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    const requestBody = JSON.parse(requestInit.body as string) as {
      correlationId?: string
    }
    expect(requestBody.correlationId).toBeTruthy()
    expect(requestBody.correlationId).not.toBe(CLASS_MUTATION.id)

    // P2-1 (codex review round 5, 2026-08-20): before the fix,
    // `dispatchBranchClassMutation` called `verifyEditRef.current({editId:
    // current.id, ...})` — the captured Mutation's OWN id, not the id of
    // the edit actually dispatched. That recorded the verification under
    // `CLASS_MUTATION.id`, which `activity-verification-join.ts` can never
    // match against `row.correlationId` (the id above) — so a class/style
    // edit's cascade-verification result could never join to its Activity
    // row and silently never appeared.
    const verifications = useEditorStore.getState().verifications
    expect(verifications).toHaveLength(1)
    expect(verifications[0].editId).toBe(requestBody.correlationId)
    expect(verifications[0].editId).not.toBe(CLASS_MUTATION.id)
  })
})
