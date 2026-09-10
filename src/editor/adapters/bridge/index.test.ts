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
import type { AdapterTarget, Mutation, PendingMutation, Selection } from "../../core"
import type { BridgeMutation, InspectionData } from "@/types/bridge"

/**
 * A version the shell accepts, with the document id every accepted bridge
 * reports. `REQUIRED_BRIDGE_VERSION` is the document-id bridge (round 16 X3),
 * so a handshake fixture has to carry both.
 */
const CURRENT_BRIDGE_VERSION = "2026-09-10d-structure-document-id"

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

/**
 * The document the last handshake emitted through this helper reported.
 *
 * Selection replies name their document now, and the adapter drops one whose
 * id is not the page it handshaked with. Defaulting to the page the test just
 * connected to keeps the older fixtures about whatever they were about; a test
 * that wants a message from ANOTHER document passes `documentId` itself and
 * the spread below wins.
 */
let emittedDocumentId = "doc-a"

/** Dispatch a MessageEvent on window with `source` pointed at the mock content window. */
function emitFromBridge(
  contentWindow: { postMessage: ReturnType<typeof vi.fn> },
  message: Record<string, unknown>,
): void {
  if (message.type === "BRIDGE_READY") {
    const readyId = (message.payload as { documentId?: string } | undefined)
      ?.documentId
    if (typeof readyId === "string" && readyId.length > 0) {
      emittedDocumentId = readyId
    }
  }
  const event = new Event("message") as MessageEvent
  // jsdom's MessageEvent doesn't let us pass `source` via the constructor in a
  // type-safe way, so we patch the dispatched event directly. The adapter
  // reads `event.source` and `event.data` only; this is the minimum surface.
  Object.defineProperty(event, "data", {
    value: { source: "desde-bridge", documentId: emittedDocumentId, ...message },
  })
  Object.defineProperty(event, "source", { value: contentWindow })
  window.dispatchEvent(event)
}

// The default above is per-test state, so it is reset like any other.
beforeEach(() => {
  emittedDocumentId = "doc-a"
})

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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    await expect(initPromise2).resolves.toBeUndefined()
  })

  it("reports the document the bridge says it is running in, and changes it only when the page does", async () => {
    // The shell reads this right after `init()` resolves to decide whether a
    // handshake is a NEW page or the page it is already on answering again.
    // A late `load` (slow image) re-handshakes the same document, and reading
    // that as a reload used to throw the designer's in-progress edits away.
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    expect(adapter.bridgeDocumentId).toBeNull()

    const first = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    await first
    expect(adapter.bridgeDocumentId).toBe("doc-a")

    // The same document answering a second PING.
    const second = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    await second
    expect(adapter.bridgeDocumentId).toBe("doc-a")

    // A reload: a fresh bridge IIFE, so a fresh id.
    const third = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-b" },
    })
    await third
    expect(adapter.bridgeDocumentId).toBe("doc-b")
  })

  it("refuses a handshake from a bridge that sends no document id", async () => {
    // Round 16 X3. The id is what the shell's session boundary is decided by,
    // and the fallback for a bridge without one could not decide the case it
    // existed for. There is no installed base of such bridges, so the handshake
    // is refused rather than guessed at — and the version gate alone would not
    // catch a ready that carries no version either.
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION },
    })
    await expect(initPromise).rejects.toThrow(/no document id/)
    // And nothing was adopted: a refused bridge must not be able to move the
    // document the shell thinks it is on.
    expect(adapter.bridgeDocumentId).toBeNull()
  })

  it("refuses a handshake that reports no version at all", async () => {
    const target: AdapterTarget = { iframe: setup.iframe, origin: "*" }
    const initPromise = adapter.init(target)
    emitFromBridge(setup.contentWindow, { type: "BRIDGE_READY", payload: {} })
    await expect(initPromise).rejects.toThrow(/no document id/)
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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

  // There is no "selectMany rejects on a too-old bridge" case any more. Round
  // 16 X3 raised `REQUIRED_BRIDGE_VERSION` past the multi-select threshold, so
  // a bridge that would fail that feature gate is refused at the handshake and
  // never reaches it — the refusal is covered by "init rejects when BRIDGE_READY
  // reports a version older than required". The gate itself stays: it is the
  // pattern every later feature gate copies, and it costs one comparison.

  it("selectMany rejects before any bridge is attached", async () => {
    const fresh = new BridgeFrameworkAdapter()
    try {
      await expect(fresh.selectMany(["#btn"])).rejects.toThrow(/not initialized/)
      expect(
        setup.postMessages.some((m) => (m as { type: string }).type === "INSPECT_MANY"),
      ).toBe(false)
    } finally {
      await fresh.dispose()
    }
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

  it("drops a STRUCTURE_CAPTURED from another document and settles the read (read continuation)", async () => {
    // The Layers tree is a READ, and its reply outlives the page that built
    // it exactly as an inspection does. Every row carries `authoredAt` and
    // `editTarget`, which is where a Layers delete writes, so a tree from the
    // departed page would point Delete at a file the page on screen may not
    // render. The requestId cannot tell them apart: it pairs an answer with a
    // question, not with a page.
    const promise = adapter.getStructure()
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "GET_STRUCTURE",
    ) as { type: string; requestId: string }
    const rejection = expect(promise).rejects.toThrow(/another document/)
    emitFromBridge(setup.contentWindow, {
      type: "STRUCTURE_CAPTURED",
      payload: { roots: [{ id: "n1", name: "Departed", type: "component", x: 0, y: 0, width: 10, height: 10, selector: "#departed" }] },
      requestId: sent.requestId,
      documentId: "doc-b",
    })
    // Settled, not left dangling: the caller takes the path it already has for
    // a reply that never came, instead of waiting out the whole bounded wait.
    await rejection
  })

  it("accepts a STRUCTURE_CAPTURED stamped with the document on screen", async () => {
    const promise = adapter.getStructure()
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === "GET_STRUCTURE",
    ) as { type: string; requestId: string }
    emitFromBridge(setup.contentWindow, {
      type: "STRUCTURE_CAPTURED",
      payload: { roots: [{ id: "n1", name: "OnScreen", type: "component", x: 0, y: 0, width: 10, height: 10, selector: "#on-screen" }] },
      requestId: sent.requestId,
      documentId: "doc-a",
    })
    const roots = await promise
    expect(roots.map((r) => r.name)).toEqual(["OnScreen"])
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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
        documentId: "doc-a",
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
      payload: {
        selector: "#input",
        attrName: "placeholder",
        ok: false,
        documentId: "doc-a",
      },
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
        documentId: "doc-a",
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
      payload: {
        selector: "#btn",
        propName: "appearance",
        ok: true,
        documentId: "doc-a",
      },
    })
    emitFromBridge(setup.contentWindow, {
      type: "ATTR_OVERRIDE_RESULT",
      payload: {
        selector: "#input",
        attrName: "placeholder",
        ok: true,
        documentId: "doc-a",
      },
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
      payload: {
        selector: "#btn",
        propName: "appearance",
        ok: false,
        // Stamped with the handshaked document on purpose: without it the
        // adapter would drop the message as foreign and this test would pass
        // for the wrong reason, proving nothing about `unsubscribe`.
        documentId: "doc-a",
      },
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
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
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

describe("BridgeFrameworkAdapter — applyEdit carries the caller's abort signal", () => {
  // Round 14 V3. An edit request is a WRITE, and it outlives the thing that
  // asked for it. When the caller is a bridge session and the page is replaced
  // mid-request, the shell's per-identity in-flight markers have already been
  // emptied by the session end, so an edit on the SAME element in the new
  // document would start a second write alongside the first. The signal is
  // what settles the first one.
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup
  let fetchMock: ReturnType<typeof vi.fn>
  const originalFetch = globalThis.fetch

  const editTargetLoc = { file: "src/Demo.vue", line: 4, column: 6 }
  const target = {
    targetId: '[data-testid="submit-btn"]',
    selector: '[data-testid="submit-btn"]',
    componentName: "UiButton",
    authoredAt: editTargetLoc,
    editTarget: editTargetLoc,
  }
  const propEdit = {
    kind: "prop" as const,
    id: "edit-signal-1",
    target,
    propName: "variant",
    value: "danger",
  }

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    await initPromise
    setup.postMessages.length = 0
  })

  afterEach(async () => {
    await adapter.dispose()
    globalThis.fetch = originalFetch
  })

  it("hands the signal to the transport", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const controller = new AbortController()

    await adapter.applyEdit(propEdit, { signal: controller.signal })

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(controller.signal)
  })

  it("sends no signal when the caller passes none, so an ordinary edit is unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    await adapter.applyEdit(propEdit)

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeUndefined()
  })

  it("settles an aborted request as a plain failed result, not as an unreachable service", async () => {
    // Every lane already reads `failed` as "nothing landed", so an abort needs
    // no new outcome shape. It must not read as a transport failure though:
    // "unreachable" sends the reader looking for a network problem that never
    // happened.
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted.")
            err.name = "AbortError"
            reject(err)
          })
        }),
    )

    const pending = adapter.applyEdit(propEdit, { signal: controller.signal })
    controller.abort()
    const result = await pending

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toBe("edit request cancelled")
      expect(result.needsChat).toBeUndefined()
    }
  })
})

/**
 * A message outlives the page that sent it by however long the queue is. The
 * departed page's capture used to be delivered and stamped with the session
 * that had replaced it, which is a write aimed at a file the new page may not
 * even render (round 15 RULING). The id on the message is what closes it.
 */
describe("BridgeFrameworkAdapter — a message names the document it came from", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup
  /** Every line the adapter warned, so a drop can be asserted on. */
  const warnings: string[] = []
  let restoreWarn: () => void

  /** A wire-shape mutation from `documentId`. */
  function wireMutation(documentId: string): BridgeMutation {
    return {
      id: "m-1",
      kind: "text",
      sourceLoc: "src/components/Card.vue:12:4",
      resolutionKind: "direct",
      scope: "definition",
      callsiteLoc: null,
      instancePath: "App>HomePage>Card",
      selector: "[data-testid=\"card-title\"]",
      before: "Hello",
      after: "Hi",
      documentId,
    }
  }

  /** Init the adapter and answer with a handshake from `documentId`. */
  async function handshake(documentId: string): Promise<void> {
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId },
    })
    await initPromise
  }

  beforeEach(() => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    warnings.length = 0
    // The drop writes one line naming both ids. Silenced so a passing run is
    // quiet, and asserted on below.
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "))
      })
    restoreWarn = () => spy.mockRestore()
  })

  afterEach(async () => {
    restoreWarn()
    await adapter.dispose()
  })

  it("drops a mutation message from a document that is no longer the one on screen", async () => {
    const captured: Mutation[] = []
    adapter.onMutationCaptured((m) => captured.push(m))

    await handshake("doc-a")
    emitFromBridge(setup.contentWindow, {
      type: "MUTATION_CAPTURED",
      payload: wireMutation("doc-a"),
    })
    expect(captured).toHaveLength(1)

    await handshake("doc-b")
    emitFromBridge(setup.contentWindow, {
      type: "MUTATION_CAPTURED",
      payload: wireMutation("doc-a"),
    })
    expect(captured).toHaveLength(1)
    // The drop is not silent: one line names the message's document and the one
    // on screen.
    expect(warnings.some((line) => line.includes("doc-a") && line.includes("doc-b"))).toBe(true)
  })

  it("delivers a message whose document is the accepted one", async () => {
    // The mirror of the case above: same two handshakes, and a capture from the
    // page that is actually on screen still lands.
    const captured: Mutation[] = []
    adapter.onMutationCaptured((m) => captured.push(m))

    await handshake("doc-a")
    await handshake("doc-b")
    emitFromBridge(setup.contentWindow, {
      type: "MUTATION_CAPTURED",
      payload: wireMutation("doc-b"),
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.id).toBe("m-1")
  })

  it("drops a held draft and a resolution failure from the departed document too", async () => {
    // All three mutation messages ride the same channel, so all three carry the
    // id and all three are filtered. A held draft that survived would open a
    // dialog about an element the new page does not have.
    const pending: PendingMutation[] = []
    const failures: { id: string }[] = []
    adapter.onMutationAwaitingDisambiguation((p) => pending.push(p))
    adapter.onResolutionFailed((f) => failures.push(f))

    await handshake("doc-a")
    await handshake("doc-b")

    const { instancePath: _instancePath, documentId: _documentId, ...draft } =
      wireMutation("doc-a")
    void _instancePath
    void _documentId
    emitFromBridge(setup.contentWindow, {
      type: "MUTATION_AWAITING_DISAMBIGUATION",
      payload: {
        pendingId: "pending-1",
        draft,
        candidates: [
          { instancePath: "0", selector: "#one", origin: true },
        ],
        documentId: "doc-a",
      },
    })
    emitFromBridge(setup.contentWindow, {
      type: "MUTATION_RESOLUTION_FAILED",
      payload: {
        id: "f-1",
        reason: "No source-location ancestor.",
        selector: "div.unanchored",
        documentId: "doc-a",
      },
    })

    expect(pending).toEqual([])
    expect(failures).toEqual([])
  })
})

describe("BridgeFrameworkAdapter reports a new document's own ready", () => {
  /**
   * The bridge sends BRIDGE_READY as soon as its script runs, which is before
   * the iframe's `load` event. The adapter adopts the new id there, so a
   * capture made in the window between the two passes its document gate. The
   * shell needs to hear about the change at the ready, or it stamps that
   * capture with the departed page's session and then retires it at `load`.
   */
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  async function handshake(documentId: string): Promise<void> {
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId },
    })
    await initPromise
  }

  beforeEach(() => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  it("tells the listener once when a new document announces itself", async () => {
    const seen: string[] = []
    // What the getter read DURING each call, not after the fact. The shell's
    // listener moves the session boundary onto `adapter.bridgeDocumentId`
    // synchronously, in this very call, so "the id moved first" has to hold
    // while the listener is on the stack. Asserting it afterwards would pass
    // for an adapter that adopted the id on the line below the notify, and the
    // shell would then start its new session on the DEPARTED document.
    const readDuringCall: (string | null)[] = []
    adapter.onDocumentChanged((documentId) => {
      seen.push(documentId)
      readDuringCall.push(adapter.bridgeDocumentId)
    })

    await handshake("doc-a")
    // Nothing yet: that ready was one this adapter asked for.
    expect(seen).toEqual([])

    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-b" },
    })
    expect(seen).toEqual(["doc-b"])
    expect(readDuringCall).toEqual(["doc-b"])
    // The id moved with it, so a listener that re-handshakes reads the new
    // document rather than the one that went away.
    expect(adapter.bridgeDocumentId).toBe("doc-b")
  })

  it("says nothing when the SAME document announces itself again", async () => {
    // A page whose bridge re-emits its ready, which is the shape a PING
    // answers. Nothing changed, so there is no boundary to report.
    const seen: string[] = []
    adapter.onDocumentChanged((documentId) => seen.push(documentId))

    await handshake("doc-a")
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    expect(seen).toEqual([])
  })

  it("says nothing for the ready that resolves a handshake it asked for", async () => {
    // The other half of "once". A handshake reports its document through
    // `init()` resolving, and the shell re-handshakes there; announcing the
    // change as well would run two handshakes for one ready.
    const seen: string[] = []
    adapter.onDocumentChanged((documentId) => seen.push(documentId))

    await handshake("doc-a")
    await handshake("doc-b")
    expect(seen).toEqual([])
    expect(adapter.bridgeDocumentId).toBe("doc-b")
  })

  it("stops telling a listener that unsubscribed", async () => {
    const seen: string[] = []
    const unsubscribe = adapter.onDocumentChanged((id) => seen.push(id))
    await handshake("doc-a")
    unsubscribe()
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-b" },
    })
    expect(seen).toEqual([])
  })

  it("says nothing for a ready the version gate refused", async () => {
    // A bridge the shell will not talk to must not be able to move the
    // document, and so must not be able to end the live session either.
    const seen: string[] = []
    adapter.onDocumentChanged((id) => seen.push(id))
    await handshake("doc-a")
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: "2020-01-01a", documentId: "doc-b" },
    })
    expect(seen).toEqual([])
    expect(adapter.bridgeDocumentId).toBe("doc-a")
  })
})

/**
 * The same rule as the mutation family, applied to every OTHER message the
 * page originates that leads to a write or an override change: the three
 * direct-manipulation commits, and the four override events.
 *
 * None of these could land wrong bytes today — each one re-enters a path that
 * checks the live session again before anything is written. That is defence in
 * depth, not the reason to stamp them. The reason is that "a page-originated
 * write names its page" has to be a rule with no exceptions, or the next
 * message added to this family inherits the exception instead of the rule.
 */
describe("BridgeFrameworkAdapter — every page-originated write names its document", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup
  const warnings: string[] = []
  let restoreWarn: () => void

  async function handshake(documentId: string): Promise<void> {
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId },
    })
    await initPromise
  }

  /** Handshake doc-a, then doc-b: doc-a is now the departed page. */
  async function handshakeTwice(): Promise<void> {
    await handshake("doc-a")
    await handshake("doc-b")
  }

  const loc = { file: "src/App.vue", line: 3, column: 2 }

  function dragMovePayload(documentId: string) {
    return {
      sourceSelector: "#card",
      sourceEditTarget: loc,
      destParentSelector: "#list",
      destParentEditTarget: loc,
      destIndex: 1,
      sourceIsIterated: false,
      destIsIterated: false,
      documentId,
    }
  }

  function insertPayload(documentId: string) {
    return {
      parentSelector: "#list",
      parentEditTarget: loc,
      destIndex: 0,
      parentIsIterated: false,
      documentId,
    }
  }

  function resizePayload(documentId: string) {
    return {
      selector: "#card",
      editTarget: loc,
      widthClass: "w-1/2",
      documentId,
    }
  }

  function propResultPayload(documentId: string) {
    return {
      selector: "#btn",
      propName: "appearance",
      ok: false,
      reason: "The prototype exposes no component instance for this element.",
      kind: "no-component-instance",
      documentId,
    }
  }

  function attrResultPayload(documentId: string) {
    return {
      selector: "#input",
      attrName: "placeholder",
      ok: false,
      documentId,
    }
  }

  function revertedPayload(documentId: string) {
    return {
      id: "o-1",
      kind: "text",
      selector: "#title",
      reason: "Edit failed",
      documentId,
    }
  }

  function unverifiedPayload(documentId: string) {
    return { id: "o-1", kind: "text", selector: "#title", documentId }
  }

  beforeEach(() => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    warnings.length = 0
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(" "))
      })
    restoreWarn = () => spy.mockRestore()
  })

  afterEach(async () => {
    restoreWarn()
    await adapter.dispose()
  })

  /**
   * One table, seven rows: the type, how to subscribe to it, and the payload
   * builder. Written as a table rather than fourteen hand-built cases because
   * the whole point of the change is that these seven behave identically — a
   * hand-built case per type is where an accidental exception hides.
   */
  const cases: {
    type: string
    subscribe: (a: BridgeFrameworkAdapter, seen: unknown[]) => void
    payload: (documentId: string) => Record<string, unknown>
  }[] = [
    {
      type: "DRAG_MOVE_COMMITTED",
      subscribe: (a, seen) => void a.onDragMoveCommitted((m) => seen.push(m)),
      payload: dragMovePayload,
    },
    {
      type: "INSERT_AT_POINT",
      subscribe: (a, seen) => void a.onInsertAtPoint((m) => seen.push(m)),
      payload: insertPayload,
    },
    {
      type: "RESIZE_COMMITTED",
      subscribe: (a, seen) => void a.onResizeCommitted((m) => seen.push(m)),
      payload: resizePayload,
    },
    {
      type: "PROP_OVERRIDE_RESULT",
      subscribe: (a, seen) => void a.onOverridePreviewFailed((m) => seen.push(m)),
      payload: propResultPayload,
    },
    {
      type: "ATTR_OVERRIDE_RESULT",
      subscribe: (a, seen) => void a.onOverridePreviewFailed((m) => seen.push(m)),
      payload: attrResultPayload,
    },
    {
      type: "OVERRIDE_REVERTED",
      subscribe: (a, seen) => void a.onOverrideReverted((m) => seen.push(m)),
      payload: revertedPayload,
    },
    {
      type: "OVERRIDE_UNVERIFIED",
      subscribe: (a, seen) => void a.onOverrideUnverified((m) => seen.push(m)),
      payload: unverifiedPayload,
    },
  ]

  for (const testCase of cases) {
    it(`${testCase.type} from another document is dropped`, async () => {
      const seen: unknown[] = []
      testCase.subscribe(adapter, seen)
      await handshakeTwice()

      emitFromBridge(setup.contentWindow, {
        type: testCase.type,
        payload: testCase.payload("doc-a"),
      })

      expect(seen).toEqual([])
      // Not a silent drop: one line names the message's document and the one
      // on screen, exactly as the mutation family already does.
      expect(
        warnings.some(
          (line) =>
            line.includes(testCase.type) &&
            line.includes("doc-a") &&
            line.includes("doc-b"),
        ),
      ).toBe(true)
    })

    it(`${testCase.type} from the current document still lands`, async () => {
      const seen: unknown[] = []
      testCase.subscribe(adapter, seen)
      await handshakeTwice()

      emitFromBridge(setup.contentWindow, {
        type: testCase.type,
        payload: testCase.payload("doc-b"),
      })

      expect(seen).toHaveLength(1)
    })
  }
})

/**
 * The selection replies name their page, and a page change clears what they
 * left behind.
 *
 * `ELEMENT_INSPECTED` and `ELEMENTS_INSPECTED` SET THE SELECTION, and the
 * selection's `editTarget` is the file, line and column every later edit
 * writes to. A reply from the page that has just been replaced therefore aims
 * the next edit at the departed page's file, and it does that inside the
 * awaited request, before the calling lane's own session check can say the
 * answer is stale.
 */
describe("BridgeFrameworkAdapter — a selection cannot outlive its page", () => {
  let adapter: BridgeFrameworkAdapter
  let setup: MockIframeSetup

  beforeEach(async () => {
    adapter = new BridgeFrameworkAdapter()
    setup = makeMockIframe()
    const initPromise = adapter.init({ iframe: setup.iframe, origin: "*" })
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-a" },
    })
    await initPromise
    setup.postMessages.length = 0
  })

  afterEach(async () => {
    await adapter.dispose()
  })

  /** The requestId the adapter minted for the one message of this type. */
  function requestIdOf(type: string): string {
    const sent = setup.postMessages.find(
      (m) => (m as { type: string }).type === type,
    ) as { requestId: string } | undefined
    if (!sent) throw new Error(`no ${type} was sent`)
    return sent.requestId
  }

  /** An unsolicited handshake from another page, i.e. the page being replaced. */
  function replacePage(documentId: string): void {
    emitFromBridge(setup.contentWindow, {
      type: "BRIDGE_READY",
      payload: { version: CURRENT_BRIDGE_VERSION, documentId },
    })
  }

  it("settles selectBySelector with null when the reply names another document", async () => {
    const seen: (Selection | null)[] = []
    adapter.onSelectionChange((s) => seen.push(s))

    const promise = adapter.selectBySelector("#panel")
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
      requestId: requestIdOf("INSPECT_SELECTOR"),
      documentId: "doc-x",
    })

    // Null, not a rejection: an unresolved selector already answers null, so
    // the caller keeps the handling it has.
    await expect(promise).resolves.toBeNull()
    // And the selection itself never moved, which is the whole point: no
    // listener ran, so nothing shell-side is aiming at the departed page.
    expect(seen).toEqual([])
  })

  it("ignores an unsolicited ELEMENT_INSPECTED from another document", async () => {
    const seen: (Selection | null)[] = []
    adapter.onSelectionChange((s) => seen.push(s))

    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
      documentId: "doc-x",
    })

    expect(seen).toEqual([])
    expect(await adapter.selectParent()).toBeNull()
  })

  it("settles selectMany with an empty list when the reply names another document", async () => {
    const promise = adapter.selectMany(["#a", "#b"])
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENTS_INSPECTED",
      payload: [makeInspectionData(), makeInspectionData()],
      requestId: requestIdOf("INSPECT_MANY"),
      documentId: "doc-x",
    })

    await expect(promise).resolves.toEqual([])
  })

  it("settles a parked selectBySelector and clears the selection when the page is replaced", async () => {
    // A real selection on the page that is about to go, so the clear has
    // something to clear. Without it the deselect below would be
    // indistinguishable from nothing happening.
    const established = adapter.selectBySelector("#panel")
    emitFromBridge(setup.contentWindow, {
      type: "ELEMENT_INSPECTED",
      payload: makeInspectionData(),
      requestId: requestIdOf("INSPECT_SELECTOR"),
    })
    expect(await established).not.toBeNull()
    setup.postMessages.length = 0

    const seen: (Selection | null)[] = []
    adapter.onSelectionChange((s) => seen.push(s))

    // The second read is still out when the page changes.
    const parked = adapter.selectBySelector("#panel")
    replacePage("doc-b")

    await expect(parked).resolves.toBeNull()
    // The deselect the shell's own listener writes through, so `editorSelection`
    // cannot outlive the page.
    expect(seen).toEqual([null])
  })

  it("settles a parked selectMany with an empty list when the page is replaced", async () => {
    const parked = adapter.selectMany(["#a"])
    replacePage("doc-b")
    await expect(parked).resolves.toEqual([])
  })

  it("does not clear the selection on the FIRST handshake of a page", async () => {
    // The control. `previousDocumentId` is null before any handshake, and on a
    // re-attach with the same page still on screen; treating that as a
    // replacement would take the designer's selection away for no reason.
    const fresh = new BridgeFrameworkAdapter()
    const freshSetup = makeMockIframe()
    const seen: (Selection | null)[] = []
    fresh.onSelectionChange((s) => seen.push(s))
    try {
      const initPromise = fresh.init({ iframe: freshSetup.iframe, origin: "*" })
      emitFromBridge(freshSetup.contentWindow, {
        type: "BRIDGE_READY",
        payload: { version: CURRENT_BRIDGE_VERSION, documentId: "doc-first" },
      })
      await initPromise
      expect(seen).toEqual([])
    } finally {
      await fresh.dispose()
    }
  })
})
