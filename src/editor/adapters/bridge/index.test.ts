/**
 * Integration tests for `BridgeFrameworkAdapter`.
 *
 * The adapter is wired against the comment-bridge postMessage protocol;
 * these tests stub the bridge with a fake iframe + simulated incoming
 * MessageEvents so we can exercise the request/response correlation,
 * selection-event dispatch, ESCAPE_PRESSED auto-ascend, and lifecycle
 * teardown without spinning up a real prototype.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BridgeFrameworkAdapter } from "./index"
import type { AdapterTarget, Selection } from "../../core"
import type { InspectionData } from "@/types/bridge"

interface MockIframeSetup {
  iframe: HTMLIFrameElement
  contentWindow: { postMessage: ReturnType<typeof vi.fn> }
  postMessages: unknown[]
}

function makeMockIframe(): MockIframeSetup {
  const postMessages: unknown[] = []
  const contentWindow = {
    postMessage: vi.fn((message: unknown) => {
      postMessages.push(message)
    }),
  }
  const iframe = {
    src: "https://prototype.example.com/dashboard",
    contentWindow,
  } as unknown as HTMLIFrameElement
  return { iframe, contentWindow, postMessages }
}

/** Dispatch a MessageEvent on window with `source` pointed at the mock content window. */
function emitFromBridge(
  contentWindow: { postMessage: ReturnType<typeof vi.fn> },
  message: Record<string, unknown>,
): void {
  const event = new Event("message") as MessageEvent
  // jsdom's MessageEvent doesn't let us pass `source` via the constructor in a
  // type-safe way, so we patch the dispatched event directly. The adapter
  // reads `event.source` and `event.data` only; this is the minimum surface.
  Object.defineProperty(event, "data", {
    value: { source: "desde-bridge", ...message },
  })
  Object.defineProperty(event, "source", { value: contentWindow })
  window.dispatchEvent(event)
}

function makeInspectionData(overrides: Partial<InspectionData> = {}): InspectionData {
  return {
    tagName: "button",
    id: "",
    classes: ["ui-button"],
    rect: { x: 0, y: 0, width: 100, height: 32, top: 0, right: 100, bottom: 32, left: 0 },
    styles: [],
    tokens: [],
    boxModel: {
      width: 100,
      height: 32,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      border: { top: 0, right: 0, bottom: 0, left: 0 },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      content: { width: 100, height: 32 },
    },
    selector: "[data-testid=\"submit-btn\"]",
    componentTree: [
      { name: "UiCard", elementSelector: "#card-1" },
      { name: "UiButton", elementSelector: "[data-testid=\"submit-btn\"]" },
    ],
    ...overrides,
  }
}

describe("BridgeFrameworkAdapter — lifecycle", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  beforeEach(() => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it("init sends PING and applies the persisted active state (defaults to inactive) once BRIDGE_READY arrives", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    // PING is the non-navigating kick that asks an already-loaded bridge
    // to re-emit BRIDGE_READY. NAVIGATE is intentionally NOT sent — that
    // caused a reload loop when the prototype's router routed away from
    // the src pathname.
    expect(setup.postMessages).toContainEqual({ type: "PING" })
    expect(setup.postMessages.find((m) => (m as { type: string }).type === "NAVIGATE")).toBeUndefined()
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise
    const types = setup.postMessages.map(
      (m) => (m as { type: string }).type,
    )
    // desiredActive defaults to false (matches the shell's Navigate
    // default), so init() must NOT force the overlays on — that was the
    // bug that leaked the hover/selection box into Navigate mode. It
    // applies the teardown set instead (inspector + table-edge band).
    expect(types).toContain("DEACTIVATE_INSPECTOR")
    expect(types).toContain("EXIT_EDITOR_MODE")
    expect(types).toContain("DISABLE_HOVER_EVENTS")
    expect(types).toContain("DEACTIVATE_TABLE_EDGE_MENU")
    expect(types).not.toContain("ACTIVATE_INSPECTOR")
    expect(types).not.toContain("ACTIVATE_TABLE_EDGE_MENU")
  })

  it("init rejects when BRIDGE_READY reports a version older than required", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-04-23b" },
    })
    await expect(initPromise).rejects.toThrow(/older than required/)
  })

  it("init re-applies the persisted active state on iframe reload (Select stays Select, Navigate stays Navigate)", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise1 = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise1

    // Enter Select mode.
    await adapter.setActive(true)
    setup.postMessages.length = 0

    // Simulate a full-document reload: a fresh bridge IIFE re-runs and
    // re-init must re-apply Select (overlay on).
    const initPromise2 = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise2
    let types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).toContain("ACTIVATE_INSPECTOR")
    expect(types).toContain("ENTER_EDITOR_MODE")
    // The table-edge band is part of the same Select-mode signal.
    expect(types).toContain("ACTIVATE_TABLE_EDGE_MENU")
    // The hover stream is NOT: HOVER_TARGET_CHANGED has no consumer, so the
    // bridge must not be asked to emit one per animation frame.
    expect(types).not.toContain("ENABLE_HOVER_EVENTS")

    // Switch to Navigate, then reload again: re-init must NOT re-activate.
    // Force-activation here was the bug — it leaked the hover/selection
    // box into Navigate mode every time the user navigated.
    await adapter.setActive(false)
    setup.postMessages.length = 0
    const initPromise3 = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise3
    types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).not.toContain("ACTIVATE_INSPECTOR")
    expect(types).not.toContain("ACTIVATE_TABLE_EDGE_MENU")
    expect(types).toContain("DEACTIVATE_INSPECTOR")
    expect(types).toContain("EXIT_EDITOR_MODE")
    expect(types).toContain("DEACTIVATE_TABLE_EDGE_MENU")
  })

  it("init aborts an in-flight handshake when called again before the previous one settles", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise1 = adapter.init(target)
    // Don't emit BRIDGE_READY for the first attempt; supersede with a second init.
    const initPromise2 = adapter.init(target)
    await expect(initPromise1).rejects.toThrow(/superseded/)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await expect(initPromise2).resolves.toBeUndefined()
  })

  it("dispose rejects a pending handshake instead of leaving the awaiter dangling", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    // Don't emit BRIDGE_READY; dispose mid-handshake.
    await adapter.dispose()
    await expect(initPromise).rejects.toThrow(/disposed before handshake/)
  })

  it("clearSelection sends CLEAR_SELECTION to the bridge before clearing local state", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise

    setup.postMessages.length = 0
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    await adapter.clearSelection()

    const types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).toContain("CLEAR_SELECTION")
    expect(listener).toHaveBeenCalledWith(null)
  })

  it("setActive(false) sends the teardown set; setActive(true) sends the activation set (inspector + table-edge)", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise

    setup.postMessages.length = 0
    await adapter.setActive(false)
    const offTypes = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(offTypes).toEqual([
      "DISABLE_HOVER_EVENTS",
      "EXIT_EDITOR_MODE",
      "DEACTIVATE_INSPECTOR",
      "DEACTIVATE_TABLE_EDGE_MENU",
    ])

    setup.postMessages.length = 0
    await adapter.setActive(true)
    const onTypes = setup.postMessages.map((m) => (m as { type: string }).type)
    // Exhaustive on purpose: ENABLE_HOVER_EVENTS was here until 2026-08-06 and
    // its stream had no consumer at all. An `.toEqual` (not `.toContain`) is
    // what stops it — or any other unconsumed stream — from being re-added by
    // reflex.
    expect(onTypes).toEqual([
      "ACTIVATE_INSPECTOR",
      "ENTER_EDITOR_MODE",
      "ACTIVATE_TABLE_EDGE_MENU",
    ])
    // The teardown DISABLE above stays: it costs one message and settles a
    // bridge another shell (or an older build) left streaming.
    expect(offTypes).toContain("DISABLE_HOVER_EVENTS")
  })

  it("setActive is a no-op when no iframe is attached", async () => {
    // No init called — no currentTarget.
    setup.postMessages.length = 0
    await adapter.setActive(true)
    await adapter.setActive(false)
    expect(setup.postMessages).toEqual([])
  })

  it("dispose sends teardown messages and clears subscribers", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise

    const selectionListener = vi.fn()
    adapter.onSelectionChange(selectionListener)

    setup.postMessages.length = 0
    await adapter.dispose()
    const types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).toContain("DISABLE_HOVER_EVENTS")
    expect(types).toContain("EXIT_EDITOR_MODE")
    expect(types).toContain("DEACTIVATE_INSPECTOR")
    expect(types).toContain("DEACTIVATE_TABLE_EDGE_MENU")

    // Subscribers cleared — re-emitting won't notify.
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
    })
    expect(selectionListener).not.toHaveBeenCalled()
  })
})

describe("BridgeFrameworkAdapter — selection ops", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise
    setup.postMessages.length = 0
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it("selectMany dispatches INSPECT_MANY and resolves with an array of Selections (Phase 6)", async () => {
    // selectMany feature-gates on the multi-select bridge version.
    // Re-init the adapter with the new version handshake before
    // calling.
    await adapter.dispose()
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    const initP = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-13a-multi-select" },
    })
    await initP
    setup.postMessages.length = 0

    const promise = adapter.selectMany(['#btn', '[data-testid="x"]'])
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "INSPECT_MANY",
    ) as { type: string; payload: { selectors: string[] }; requestId: string }
    expect(sent).toBeDefined()
    expect(sent.payload.selectors).toEqual(['#btn', '[data-testid="x"]'])
    expect(sent.requestId).toMatch(/^many-/)
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENTS_INSPECTED",
      payload: [makeInspectionData(), makeInspectionData()],
      requestId: sent.requestId,
    })
    const selections = await promise
    expect(selections).toHaveLength(2)
    expect(selections[0].componentName).toBe("UiButton")
  })

  it("selectMany returns an empty array on an empty selectors list (no INSPECT_MANY sent)", async () => {
    const result = await adapter.selectMany([])
    expect(result).toEqual([])
    expect(
      setup.postMessages.some((m) => (m as { type: string }).type === "INSPECT_MANY"),
    ).toBe(false)
  })

  it("selectMany rejects when the bridge version is too old (feature gate)", async () => {
    // Default test bridge version (2026-05-06a) is below the multi-
    // select gate, so this should throw without sending INSPECT_MANY.
    await expect(adapter.selectMany(["#btn"])).rejects.toThrow(/does not support multi-select/)
    expect(
      setup.postMessages.some((m) => (m as { type: string }).type === "INSPECT_MANY"),
    ).toBe(false)
  })

  it("selectBySelector resolves null when bridge responds with ELEMENT_INSPECTION_UNRESOLVED", async () => {
    const promise = adapter.selectBySelector("#missing")
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "INSPECT_SELECTOR",
    ) as { requestId: string }
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTION_UNRESOLVED",
      payload: { targetId: "", reason: "not-found" },
      requestId: sent.requestId,
    })
    const selection = await promise
    expect(selection).toBeNull()
  })

  it("selectParent dispatches INSPECT_PARENT keyed off the current selection's selector", async () => {
    // Establish a current selection first.
    const initialPromise = adapter.selectBySelector('[data-testid="submit-btn"]')
    const initialReq = setup.postMessages.find(
      (m) => (m as { type: string }).type === "INSPECT_SELECTOR",
    ) as { requestId: string }
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
      requestId: initialReq.requestId,
    })
    await initialPromise
    setup.postMessages.length = 0

    // Now ascend.
    const promise = adapter.selectParent()
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "INSPECT_PARENT",
    ) as { type: string; payload: { selector: string }; requestId: string }
    expect(sent).toBeDefined()
    expect(sent.payload.selector).toBe('[data-testid="submit-btn"]')

    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData({
        selector: "#card-1",
        componentTree: [{ name: "UiCard", elementSelector: "#card-1" }],
      }),
      requestId: sent.requestId,
    })
    const parent = await promise
    expect(parent?.componentName).toBe("UiCard")
  })

  it("selectParent returns null when there is no current selection", async () => {
    const result = await adapter.selectParent()
    expect(result).toBeNull()
    // No INSPECT_PARENT message dispatched.
    const types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).not.toContain("INSPECT_PARENT")
  })

  it("getStructure dispatches GET_STRUCTURE and resolves with STRUCTURE_CAPTURED roots", async () => {
    const promise = adapter.getStructure()
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "GET_STRUCTURE",
    ) as { type: string; requestId: string }
    expect(sent).toBeDefined()
    expect(sent.requestId).toMatch(/^struct-/)

    emitFromBridge(setup.contentWindow, {
      type: "STRUCTURE_CAPTURED",
      payload: {
        roots: [
          {
            id: "n1",
            name: "UiCard",
            type: "component",
            x: 0,
            y: 0,
            width: 320,
            height: 200,
            selector: "#card-1",
            componentFile: "/repo/node_modules/@acme/design-system/dist/UiCard.vue",
            packageName: "@acme/design-system",
            children: [
              {
                id: "n2",
                name: "UiButton",
                type: "component",
                x: 16,
                y: 160,
                width: 100,
                height: 32,
                selector: '[data-testid="submit-btn"]',
                componentFile: "/repo/node_modules/@acme/design-system/dist/UiButton.vue",
                packageName: "@acme/design-system",
              },
            ],
          },
        ],
      },
      requestId: sent.requestId,
    })

    const roots = await promise
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe("UiCard")
    expect(roots[0].selector).toBe("#card-1")
    expect(roots[0].packageName).toBe("@acme/design-system")
    expect(roots[0].children?.[0].name).toBe("UiButton")
  })

  it("getStructure rejects pending requests on dispose", async () => {
    const promise = adapter.getStructure()
    await adapter.dispose()
    await expect(promise).rejects.toThrow(/disposed/)
  })

  it("getStructure rejects on timeout when STRUCTURE_CAPTURED never arrives", async () => {
    // The post-handshake GET_STRUCTURE races the iframe reload on refresh; a
    // dropped reply must reject rather than hang forever (which stuck the
    // Layers panel on "Loading layers…").
    vi.useFakeTimers()
    try {
      const promise = adapter.getStructure()
      const rejection = expect(promise).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(10_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it("getStructure clears its timeout when STRUCTURE_CAPTURED arrives in time", async () => {
    vi.useFakeTimers()
    try {
      const promise = adapter.getStructure()
      const sent = setup.postMessages.find(
        (m) => (m as { type: string }).type === "GET_STRUCTURE",
      ) as { type: string; requestId: string }
      emitFromBridge(setup.contentWindow, {
        type: "STRUCTURE_CAPTURED",
        payload: { roots: [] },
        requestId: sent.requestId,
      })
      await expect(promise).resolves.toEqual([])
      // Advancing past the timeout must not produce an unhandled rejection —
      // the timer was cleared on resolve.
      await vi.advanceTimersByTimeAsync(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it("previewHighlight dispatches PREVIEW_HIGHLIGHT with the selector and is fire-and-forget", () => {
    adapter.previewHighlight('[data-testid="submit"]')
    expect(setup.postMessages).toContainEqual({
      type: "PREVIEW_HIGHLIGHT",
      payload: { selector: '[data-testid="submit"]' },
    })
  })

  it("previewHighlight(null) clears the active preview", () => {
    adapter.previewHighlight(null)
    expect(setup.postMessages).toContainEqual({
      type: "PREVIEW_HIGHLIGHT",
      payload: { selector: null },
    })
  })
})

describe("BridgeFrameworkAdapter — incoming events", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it("unsolicited ELEMENT_INSPECTED becomes the current selection and notifies subscribers", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const selection = listener.mock.calls[0][0] as Selection | null
    expect(selection?.componentName).toBe("UiButton")
  })

  it("flags element-level selections (selector inside a component, not its render root) so the inspector can branch", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    // Selected element is a div INSIDE ProtoCatalogCard, not its render
    // root — the layers panel's `type === "element"` rows hit this case.
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData({
        tagName: "div",
        selector: "div.entity-name",
        componentTree: [
          { name: "ProtoCatalogCard", elementSelector: "#card-1" },
        ],
        editTargetComponent: { framework: "vue", name: "ProtoCatalogCard" },
      }),
    })

    const selection = listener.mock.calls[0][0] as Selection | null
    expect(selection?.selectedAsElement).toBe(true)
    expect(selection?.tagName).toBe("div")
    expect(selection?.componentName).toBeUndefined()
    // The enclosing component drops into ancestry so the inspector can
    // still show "inside ProtoCatalogCard".
    expect(selection?.ancestry.map((a) => a.componentName)).toEqual([
      "ProtoCatalogCard",
    ])
  })

  it("keeps the component view for library-internal markup (selfStamped: false), so a wrapper-nested library component still gets Variants & Props (F-08)", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    // The measured F-08 shape: the user clicked KDropdown's trigger button.
    // The button carries no stamp of its own (KButton lives in KDropdown's
    // node_modules template), the stamp sits on the k-dropdown root div, and
    // the bridge resolved the CALLSITE component (KDropdown) as the edit
    // target. The clicked selector matches no tree node's render root — the
    // old selector-equality rule demoted this to a bare element selection
    // with no componentName, which made Variants & Props unreachable from
    // both the canvas and the layers tree.
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData({
        tagName: "button",
        selector: '[data-testid="dropdown-trigger-button"]',
        selfStamped: false,
        componentTree: [
          { name: "ActionMenu", elementSelector: "#menu-root" },
          {
            name: "KDropdown",
            elementSelector: "#menu-root",
            props: { appearance: "primary" },
          },
          {
            name: "KButton",
            elementSelector: '[data-testid="dropdown-trigger-button"]',
          },
        ],
        editTargetComponent: { framework: "vue", name: "KDropdown" },
      }),
    })

    const selection = listener.mock.calls[0][0] as Selection | null
    expect(selection?.selectedAsElement).toBeFalsy()
    expect(selection?.componentName).toBe("KDropdown")
    expect(selection?.currentProps).toEqual({ appearance: "primary" })
  })

  it("still flags an element view for first-party internal markup when the bridge says the element is stamped (selfStamped: true)", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData({
        tagName: "div",
        selector: "div.entity-name",
        selfStamped: true,
        componentTree: [
          { name: "ProtoCatalogCard", elementSelector: "#card-1" },
        ],
        editTargetComponent: { framework: "vue", name: "ProtoCatalogCard" },
      }),
    })

    const selection = listener.mock.calls[0][0] as Selection | null
    expect(selection?.selectedAsElement).toBe(true)
    expect(selection?.componentName).toBeUndefined()
  })

  it("does NOT flag selectedAsElement when the selector matches the component's render root", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    // The default makeInspectionData uses selector that matches UiButton's
    // elementSelector — i.e. the user clicked the component root itself.
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
    })

    const selection = listener.mock.calls[0][0] as Selection | null
    expect(selection?.selectedAsElement).toBeFalsy()
    expect(selection?.componentName).toBe("UiButton")
  })

  it("ELEMENT_DESELECTED clears the current selection", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
    })
    listener.mockClear()
    emitFromBridge(setup.contentWindow, { type: "ELEMENT_DESELECTED" })
    expect(listener).toHaveBeenLastCalledWith(null)
  })

  it("ESCAPE_PRESSED does NOT dispatch INSPECT_PARENT (Escape deselects completely, 2026-08-04)", () => {
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
    })
    setup.postMessages.length = 0

    emitFromBridge(setup.contentWindow, { type: "ESCAPE_PRESSED" })

    // The old parent-ascend ladder is gone: the bridge clears its own
    // selection and emits ELEMENT_DESELECTED; the adapter must not turn
    // Escape into a re-selection round-trip.
    const types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).not.toContain("INSPECT_PARENT")
  })

  it("ESCAPE_PRESSED with no current selection is a no-op", () => {
    setup.postMessages.length = 0
    emitFromBridge(setup.contentWindow, { type: "ESCAPE_PRESSED" })
    const types = setup.postMessages.map((m) => (m as { type: string }).type)
    expect(types).not.toContain("INSPECT_PARENT")
  })

  // PROP_OVERRIDE_RESULT / ATTR_OVERRIDE_RESULT used to hit `default:` — the
  // bridge reported that a live preview didn't apply and the shell discarded it,
  // so a control that visibly did nothing looked broken.
  it("a failed PROP_OVERRIDE_RESULT reaches onOverridePreviewFailed with the bridge's reason", () => {
    const listener = vi.fn()
    adapter.onOverridePreviewFailed(listener)

    emitFromBridge(setup.contentWindow, {
      type: "PROP_OVERRIDE_RESULT",
      payload: {
        selector: "#btn",
        propName: "appearance",
        ok: false,
        reason: "The prototype exposes no component instance for this element.",
        kind: "no-component-instance",
      },
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({
      kind: "prop",
      selector: "#btn",
      name: "appearance",
      reason: "The prototype exposes no component instance for this element.",
      cause: "no-component-instance",
    })
  })

  it("a failed ATTR_OVERRIDE_RESULT folds into the same failure shape", () => {
    const listener = vi.fn()
    adapter.onOverridePreviewFailed(listener)

    emitFromBridge(setup.contentWindow, {
      type: "ATTR_OVERRIDE_RESULT",
      payload: { selector: "#input", attrName: "placeholder", ok: false },
    })

    // No `reason` OR `cause` key at all when the bridge didn't send them — the
    // notice's fallback handles the wording, and an absent cause must read as
    // "genuine failure" (so it still surfaces); an explicit `undefined` would
    // defeat the `?.trim()` / `=== undefined` checks downstream.
    expect(listener).toHaveBeenCalledWith({
      kind: "attr",
      selector: "#input",
      name: "placeholder",
    })
  })

  it("relays the substrate-gap cause instead of filtering it in the adapter", () => {
    const listener = vi.fn()
    adapter.onOverridePreviewFailed(listener)

    emitFromBridge(setup.contentWindow, {
      type: "PROP_OVERRIDE_RESULT",
      payload: {
        selector: "#btn",
        propName: "appearance",
        ok: false,
        reason: "Live prop and attribute preview needs Vue instance data.",
        kind: "unsupported-substrate",
      },
    })

    // Dispatch stays "every failure reaches the listener" — the decision NOT to
    // toast a capability gap belongs to the presentation layer, so a future
    // consumer (capability badge, telemetry) still sees the event.
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0]).toMatchObject({
      cause: "unsupported-substrate",
    })
  })

  it("a SUCCESSFUL poke result notifies nobody", () => {
    const listener = vi.fn()
    adapter.onOverridePreviewFailed(listener)

    emitFromBridge(setup.contentWindow, {
      type: "PROP_OVERRIDE_RESULT",
      payload: { selector: "#btn", propName: "appearance", ok: true },
    })
    emitFromBridge(setup.contentWindow, {
      type: "ATTR_OVERRIDE_RESULT",
      payload: { selector: "#input", attrName: "placeholder", ok: true },
    })

    // Every keystroke of a slider drag produces one of these; waking shell
    // listeners for the ones that worked is pure noise.
    expect(listener).not.toHaveBeenCalled()
  })

  it("unsubscribing stops delivery", () => {
    const listener = vi.fn()
    const unsubscribe = adapter.onOverridePreviewFailed(listener)
    unsubscribe()

    emitFromBridge(setup.contentWindow, {
      type: "PROP_OVERRIDE_RESULT",
      payload: { selector: "#btn", propName: "appearance", ok: false },
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it("messages without source: 'desde-bridge' are ignored", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    const event = new Event("message") as MessageEvent
    Object.defineProperty(event, "data", {
      value: { type: "ELEMENT_INSPECTED", payload: makeInspectionData() },
    })
    Object.defineProperty(event, "source", { value: setup.contentWindow })
    window.dispatchEvent(event)

    expect(listener).not.toHaveBeenCalled()
  })

  it("messages from a different source window are ignored", () => {
    const listener = vi.fn()
    adapter.onSelectionChange(listener)

    const otherWindow = { postMessage: vi.fn() }
    const event = new Event("message") as MessageEvent
    Object.defineProperty(event, "data", {
      value: { source: "desde-bridge", type: "ELEMENT_INSPECTED", payload: makeInspectionData() },
    })
    Object.defineProperty(event, "source", { value: otherWindow })
    window.dispatchEvent(event)

    expect(listener).not.toHaveBeenCalled()
  })
})

describe("BridgeFrameworkAdapter — applyEdit (V1.3)", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2026-05-06a" },
    })
    await initPromise
    setup.postMessages.length = 0
  })

  afterEach(async () => {
    await adapter.dispose()
    globalThis.fetch = originalFetch
  })

  const editTargetLoc = { file: "src/Demo.vue", line: 4, column: 6 }
  // Base test target: a simple component selection where the bytes
  // live at the same position the edit dispatches to (the common case).
  const target = {
    targetId: "[data-testid=\"submit-btn\"]",
    selector: "[data-testid=\"submit-btn\"]",
    componentName: "UiButton",
    authoredAt: editTargetLoc,
    editTarget: editTargetLoc,
  }

  it("posts a PropEdit to /api/editor/edit and does NOT auto-dispatch RELOAD_PROTOTYPE", async () => {
    // V1.3.1 dropped the auto-RELOAD_PROTOTYPE on success. Vite's HMR
    // handles the iframe update in dev; forcing a reload was tearing down
    // the inspector's local PropControl state and causing inspector drift.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const result = await adapter.applyEdit({
      kind: "prop",
      id: "edit-1",
      target,
      propName: "variant",
      value: "danger",
    })

    expect(result.kind).toBe("applied")
    if (result.kind === "applied") {
      expect(result.appliedEditId).toBe("edit-1")
      expect(result.affectedTargetIds).toEqual([target.targetId])
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/editor/edit")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "prop",
      file: "src/Demo.vue",
      line: 4,
      column: 6,
      propName: "variant",
      value: "danger",
    })
    // The verification-join key (Task 4b): `body.edit` above never looks at
    // this sibling field, so a regression here has shipped past this exact
    // `toMatchObject` before. It's what makes the Activity panel's
    // verification pill reachable at all — see build-edit-request.test.ts's
    // dedicated "correlationId join key" suite for the rest of the kinds.
    expect(body.correlationId).toBe("edit-1")

    const reload = setup.postMessages.find(
      (m) => (m as { type: string }).type === "RELOAD_PROTOTYPE",
    )
    expect(reload).toBeUndefined()
  })

  it("posts a PropEdit for a React .tsx editTarget unchanged (framework-neutral; server routes by extension)", async () => {
    // The adapter has no framework branching — it relays the editTarget the
    // bridge surfaced. A React selection (.tsx editTarget) flows through the
    // same path; the server's edit-handler picks applyJsxPropEdit by extension.
    // Coordinate reused from the M1.4 live drive (button at App.tsx:9:6).
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const reactTarget = {
      targetId: "button.cta",
      selector: "button.cta",
      componentName: "App",
      authoredAt: { file: "src/App.tsx", line: 9, column: 6 },
      editTarget: { file: "src/App.tsx", line: 9, column: 6 },
    }
    const result = await adapter.applyEdit({
      kind: "prop",
      id: "edit-react-1",
      target: reactTarget,
      propName: "className",
      value: "cta-active",
    })
    expect(result.kind).toBe("applied")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/editor/edit")
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "prop",
      file: "src/App.tsx",
      line: 9,
      column: 6,
      propName: "className",
      value: "cta-active",
    })
  })

  it("returns failed when target.editTarget is missing", async () => {
    const result = await adapter.applyEdit({
      kind: "prop",
      id: "edit-2",
      target: { ...target, editTarget: undefined },
      propName: "variant",
      value: "danger",
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/editTarget/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns failed for non-prop edit kinds", async () => {
    // Note: prop / move / detach / delete are all wired now;
    // pick a kind whose applyEdit dispatch hasn't been added yet.
    // `wrap` is type-system-defined but not adapter-wired (Phase F+).
    const result = await adapter.applyEdit({
      kind: "wrap",
      id: "edit-3",
      target,
      wrapper: { designSystem: "acme-ds", componentName: "UiCard" },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/not implemented/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("propagates the service's reason on a non-2xx response and skips RELOAD_PROTOTYPE", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, reason: "No element at line 4" }), {
        status: 422,
      }),
    )

    const result = await adapter.applyEdit({
      kind: "prop",
      id: "edit-4",
      target,
      propName: "variant",
      value: "danger",
    })

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toBe("No element at line 4")
    }
    const reload = setup.postMessages.find(
      (m) => (m as { type: string }).type === "RELOAD_PROTOTYPE",
    )
    expect(reload).toBeUndefined()
  })

  it("returns failed when the edit service is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))

    const result = await adapter.applyEdit({
      kind: "prop",
      id: "edit-5",
      target,
      propName: "variant",
      value: "danger",
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/unreachable/)
    }
  })

  it("posts a MoveEdit with destFile/destParent fields wired through", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const result = await adapter.applyEdit({
      kind: "move",
      id: "edit-move-1",
      target,
      destination: {
        parentId: "#row",
        index: 2,
        parentEditTarget: { file: "src/Demo.vue", line: 2, column: 3 },
      },
    })

    expect(result.kind).toBe("applied")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "move",
      file: "src/Demo.vue",
      line: 4,
      column: 6,
      destFile: "src/Demo.vue",
      destParentLine: 2,
      destParentColumn: 3,
      destIndex: 2,
    })
  })

  it("refuses cross-file MoveEdits", async () => {
    const result = await adapter.applyEdit({
      kind: "move",
      id: "edit-move-2",
      target,
      destination: {
        parentId: "#row",
        index: 0,
        parentEditTarget: { file: "src/Other.vue", line: 5, column: 3 },
      },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/Cross-file/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses MoveEdits with no destination.parentEditTarget", async () => {
    const result = await adapter.applyEdit({
      kind: "move",
      id: "edit-move-3",
      target,
      destination: { parentId: "#row", index: 0 },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/parentEditTarget/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("posts a DetachEdit with file/line/column + componentFile/componentName", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const result = await adapter.applyEdit({
      kind: "detach",
      id: "edit-detach-1",
      target: { ...target, componentName: "ProtoCard", componentFile: "src/ProtoCard.vue" },
      componentFile: "src/ProtoCard.vue",
    })
    expect(result.kind).toBe("applied")
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "detach",
      file: "src/Demo.vue",
      line: 4,
      column: 6,
      componentFile: "src/ProtoCard.vue",
      componentName: "ProtoCard",
    })
  })

  it("refuses DetachEdit without target.componentName", async () => {
    const result = await adapter.applyEdit({
      kind: "detach",
      id: "edit-detach-2",
      target: { ...target, componentName: undefined },
      componentFile: "src/ProtoCard.vue",
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/componentName/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Same-parent reorder is the degenerate MoveEdit: the destination parent is
  // the target's own parent, and `destination.index` is the new sibling index.
  // (The separate `reorder` wire kind was removed 2026-08-08 — never sent.)
  it("posts a same-parent MoveEdit using destination.index as destIndex", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const result = await adapter.applyEdit({
      kind: "move",
      id: "edit-reorder-1",
      target,
      destination: {
        parentId: "#row",
        index: 1,
        parentEditTarget: { file: "src/Demo.vue", line: 2, column: 3 },
      },
    })

    expect(result.kind).toBe("applied")
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edit.kind).toBe("move")
    expect(body.edit.destIndex).toBe(1)
  })

  // Distinct callsite editTarget (consumer's `<Tag>` in a different file
  // from where the element is authored) — the element lives in
  // src/Demo.vue:4 but is wrapped at src/pages/Dashboard.vue:12.
  const distinctEditTarget = { file: "src/pages/Dashboard.vue", line: 12, column: 5 }

  it("posts a 'definition'-scoped DeleteEdit using target.authoredAt", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const result = await adapter.applyEdit({
      kind: "delete",
      id: "edit-del-def",
      // No `scope` → defaults to 'definition'.
      target: { ...target, editTarget: distinctEditTarget },
    })

    expect(result.kind).toBe("applied")
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "delete",
      file: "src/Demo.vue",
      line: 4,
      column: 6,
    })
  })

  it("posts a 'callsite'-scoped DeleteEdit using target.editTarget", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const result = await adapter.applyEdit({
      kind: "delete",
      id: "edit-del-cs",
      scope: "callsite",
      target: { ...target, editTarget: distinctEditTarget },
    })

    expect(result.kind).toBe("applied")
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.edit).toMatchObject({
      kind: "delete",
      file: "src/pages/Dashboard.vue",
      line: 12,
      column: 5,
    })
  })

  it("returns failed for a 'callsite'-scoped DeleteEdit with no editTarget", async () => {
    const result = await adapter.applyEdit({
      kind: "delete",
      id: "edit-del-cs-missing",
      scope: "callsite",
      target: { ...target, editTarget: undefined },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/editTarget/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns failed for a 'definition'-scoped DeleteEdit with no authoredAt", async () => {
    const result = await adapter.applyEdit({
      kind: "delete",
      id: "edit-del-def-missing",
      target: { ...target, authoredAt: undefined },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/authoredAt/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a DeleteEdit whose chosen scope resolves into node_modules", async () => {
    const result = await adapter.applyEdit({
      kind: "delete",
      id: "edit-del-lib",
      target: {
        ...target,
        authoredAt: {
          file: "node_modules/@acme/design-system/UiButton.vue",
          line: 5,
          column: 7,
        },
      },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toMatch(/node_modules/)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
