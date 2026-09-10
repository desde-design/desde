/**
 * The selection REPLIES name the document they were produced in.
 *
 * `handleMcpQuery` answers the shell's `INSPECT_SELECTOR`, `INSPECT_MANY`,
 * `INSPECT_PARENT` and `GET_CURRENT_INSPECTION` round trips, and those replies
 * are how the shell's selection is set. The selection's `editTarget` is the
 * file, line and column a later edit writes to, so a reply that arrives after
 * the page was replaced would aim the next edit at the departed page's file.
 * The requestId alone cannot stop that: it pairs an answer with its question,
 * not with a page.
 *
 * Narrow on purpose. This file asserts the stamp and enough of each payload to
 * prove the reply is still the reply. The resolution behavior itself
 * (tiered-vs-legacy, ambiguity, toolbar elements) is covered where it is
 * implemented.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { handleMcpQuery } from "./mcp-query-handlers"
import type { InspectorOverlayManager } from "./inspector-overlay"

const TEST_DOCUMENT_ID = "doc-under-test"

const sent: { type: string; payload?: unknown; documentId?: unknown }[] = []

let selectedElement: Element | null = null
let editorMode = false
let pointTarget: Element | null = null
let parentTarget: Element | null = null

/**
 * Every element the dispatcher told the inspector to select, in order.
 *
 * `setSelectedElement` IS the overlay draw: the real manager stores the
 * element and calls `showOverlay` on it in the same method
 * (`src/bridge/inspector-overlay.ts`). So an empty list here is the assertion
 * that nothing was selected AND that no selection chrome was drawn.
 */
let selectCalls: Element[] = []
/** How many times the dispatcher cleared the selection. */
let clearCalls = 0

/**
 * Only the seven members `handleMcpQuery` reaches on its inspector. The real
 * manager builds a shadow root and binds document listeners, none of which
 * this dispatcher touches.
 */
function fakeInspector(): InspectorOverlayManager {
  return {
    getSelectedElement: () => selectedElement,
    setSelectedElement: (el: Element) => {
      selectedElement = el
      selectCalls.push(el)
    },
    clearSelectedOnly: () => {
      selectedElement = null
      clearCalls += 1
    },
    isEditorMode: () => editorMode,
    selectAtPoint: () => pointTarget,
    findParentComponent: () => parentTarget,
  } as unknown as InspectorOverlayManager
}

function query(data: Record<string, unknown>): boolean {
  return handleMcpQuery(data, { inspector: fakeInspector() })
}

beforeEach(() => {
  sent.length = 0
  selectedElement = null
  selectCalls = []
  clearCalls = 0
  editorMode = false
  pointTarget = null
  parentTarget = null
  document.body.innerHTML = `
    <div id="card">
      <button id="save">Save</button>
      <button id="cancel">Cancel</button>
    </div>`
  configureBridgeRuntime({
    sendToShell: (message: { type: string; payload?: unknown }) =>
      void sent.push(message),
    inspectElement: (node: Element) => ({ selector: `#${node.id}` }),
    attributeElement: () => undefined,
    documentId: TEST_DOCUMENT_ID,
  })
})

afterEach(() => {
  document.body.innerHTML = ""
  configureBridgeRuntime({
    sendToShell: () => {},
    inspectElement: () => ({}),
    attributeElement: () => undefined,
    documentId: "",
  })
})

describe("mcp-query-handlers — every selection reply names its document", () => {
  it("stamps the INSPECT_SELECTOR reply", () => {
    expect(
      query({
        type: "INSPECT_SELECTOR",
        payload: { selector: "#save" },
        requestId: "req-1",
      }),
    ).toBe(true)

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect((reply!.payload as { selector?: unknown }).selector).toBe("#save")
  })

  it("stamps the INSPECT_SELECTOR no-match reply, which carries a null payload", () => {
    // The reason the id is on the MESSAGE and not inside `payload`: there is
    // no payload to put it in here.
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "#nothing" },
      requestId: "req-1",
    })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.payload).toBeNull()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_MANY reply, whose payload is an array", () => {
    query({
      type: "INSPECT_MANY",
      payload: { selectors: ["#save", "#cancel"] },
      requestId: "req-2",
    })

    const reply = sent.find((m) => m.type === "ELEMENTS_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect(reply!.payload).toHaveLength(2)
  })

  it("stamps the INSPECT_MANY empty reply", () => {
    query({ type: "INSPECT_MANY", payload: { selectors: [] }, requestId: "req-3" })

    const reply = sent.find((m) => m.type === "ELEMENTS_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect(reply!.payload).toEqual([])
  })

  it("stamps the GET_CURRENT_INSPECTION reply", () => {
    selectedElement = document.getElementById("save")
    query({ type: "GET_CURRENT_INSPECTION", requestId: "req-4" })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the GET_CURRENT_INSPECTION reply when nothing is selected", () => {
    query({ type: "GET_CURRENT_INSPECTION", requestId: "req-5" })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.payload).toBeNull()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_POINT reply", () => {
    pointTarget = document.getElementById("save")
    query({
      type: "INSPECT_POINT",
      payload: { x: 5, y: 5 },
      requestId: "req-6",
    })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect((reply!.payload as { selector?: unknown }).selector).toBe("#save")
  })

  it("stamps the GET_STRUCTURE reply, which is a tree rather than one element", () => {
    // The Layers tree is the one reply here that is not a selection, and it
    // needed the stamp for the same reason: every row carries the source
    // coordinates a Layers delete writes to.
    query({ type: "GET_STRUCTURE", requestId: "req-8" })

    const reply = sent.find((m) => m.type === "STRUCTURE_CAPTURED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect((reply!.payload as { roots?: unknown[] }).roots?.length).toBeGreaterThan(0)
  })

  it("stamps the INSPECT_PARENT reply", () => {
    parentTarget = document.getElementById("card")
    query({
      type: "INSPECT_PARENT",
      payload: { selector: "#save" },
      requestId: "req-7",
    })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect(reply).toBeDefined()
    expect(reply!.documentId).toBe(TEST_DOCUMENT_ID)
    expect((reply!.payload as { selector?: unknown }).selector).toBe("#card")
  })
})

/**
 * `ELEMENT_INSPECTION_UNRESOLVED` is the other half of the same round trip.
 *
 * It settles the same pending request the selection replies settle, so a stale
 * one clears a read the page on screen is still waiting on. There are seven
 * places that send it, across three query types, and every one of them names
 * its document now.
 */
describe("mcp-query-handlers — every unresolved reply names its document", () => {
  let warned: unknown[][]
  let restoreWarn: () => void

  beforeEach(() => {
    // The three "inspect threw" rows below log through console.warn on
    // purpose. Captured rather than printed, so the run stays readable.
    warned = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warned.push(args)
    restoreWarn = () => {
      console.warn = original
    }
    // The tiered protocol (the one that answers with this message at all) is
    // editor-only.
    editorMode = true
  })

  afterEach(() => {
    restoreWarn()
  })

  /** Re-point the runtime's element reader at one that throws. */
  function makeInspectThrow(): void {
    configureBridgeRuntime({
      sendToShell: (message: { type: string; payload?: unknown }) =>
        void sent.push(message),
      inspectElement: () => {
        throw new Error("inspect failed")
      },
      attributeElement: () => undefined,
      documentId: TEST_DOCUMENT_ID,
    })
  }

  function unresolved() {
    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTION_UNRESOLVED")
    expect(reply).toBeDefined()
    return reply!
  }

  it("stamps the INSPECT_SELECTOR no-match reply", () => {
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "#nothing" },
      requestId: "req-1",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
    expect((unresolved().payload as { reason?: unknown }).reason).toBe("not-found")
  })

  it("stamps the INSPECT_SELECTOR reply for an element the bridge injected", () => {
    document.body.innerHTML = `<div id="overlay" data-prototype-flow="1"></div>`
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "#overlay" },
      requestId: "req-2",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
    expect((unresolved().payload as { reason?: unknown }).reason).toBe("in-toolbar")
  })

  it("stamps the INSPECT_SELECTOR ambiguous reply", () => {
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "button" },
      requestId: "req-3",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
    expect((unresolved().payload as { reason?: unknown }).reason).toBe("ambiguous")
  })

  it("stamps the INSPECT_SELECTOR reply when reading the element throws", () => {
    makeInspectThrow()
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "#save" },
      requestId: "req-4",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_POINT reply when nothing is under the point", () => {
    query({ type: "INSPECT_POINT", payload: { x: 5, y: 5 }, requestId: "req-5" })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_POINT reply when reading the element throws", () => {
    pointTarget = document.getElementById("save")
    makeInspectThrow()
    query({ type: "INSPECT_POINT", payload: { x: 5, y: 5 }, requestId: "req-6" })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_PARENT reply when the source element is gone", () => {
    query({
      type: "INSPECT_PARENT",
      payload: { selector: "#gone" },
      requestId: "req-7",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_PARENT reply when there is no parent component", () => {
    query({
      type: "INSPECT_PARENT",
      payload: { selector: "#save" },
      requestId: "req-8",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })

  it("stamps the INSPECT_PARENT reply when reading the parent throws", () => {
    parentTarget = document.getElementById("card")
    makeInspectThrow()
    query({
      type: "INSPECT_PARENT",
      payload: { selector: "#save" },
      requestId: "req-9",
    })
    expect(unresolved().documentId).toBe(TEST_DOCUMENT_ID)
  })
})

/**
 * An inspect READS. Only a commit changes what the page has selected.
 *
 * The bridge used to select and draw the overlay while it handled
 * `INSPECT_SELECTOR`, `INSPECT_MANY` and `INSPECT_PARENT`, before the shell
 * had seen the answer. The shell can refuse that answer: the designer clicks
 * something else while the read is out, and the reply then describes an
 * element that is no longer the newest one. The page was left highlighting an
 * element no panel in the shell agreed with.
 *
 * One message did two things. Now the read only reads, and `COMMIT_SELECTION`
 * is how the shell says what it holds.
 */
describe("mcp-query-handlers: an inspect reads, and only a commit selects", () => {
  it("INSPECT_SELECTOR does not change the selected element", () => {
    editorMode = true
    query({
      type: "INSPECT_SELECTOR",
      payload: { selector: "#save" },
      requestId: "req-pure-1",
    })

    // The answer still comes back. Only the selection stayed put.
    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect((reply!.payload as { selector?: unknown }).selector).toBe("#save")
    expect(selectCalls).toEqual([])
    expect(selectedElement).toBeNull()
  })

  it("INSPECT_MANY does not change the selected element", () => {
    editorMode = true
    query({
      type: "INSPECT_MANY",
      payload: { selectors: ["#save", "#cancel"] },
      requestId: "req-pure-2",
    })

    const reply = sent.find((m) => m.type === "ELEMENTS_INSPECTED")
    expect((reply!.payload as unknown[]).length).toBe(2)
    expect(selectCalls).toEqual([])
    expect(selectedElement).toBeNull()
  })

  it("INSPECT_PARENT does not change the selected element", () => {
    editorMode = true
    parentTarget = document.getElementById("card")
    query({
      type: "INSPECT_PARENT",
      payload: { selector: "#save" },
      requestId: "req-pure-3",
    })

    const reply = sent.find((m) => m.type === "ELEMENT_INSPECTED")
    expect((reply!.payload as { selector?: unknown }).selector).toBe("#card")
    expect(selectCalls).toEqual([])
    expect(selectedElement).toBeNull()
  })

  it("COMMIT_SELECTION selects and highlights the one element it names", () => {
    expect(
      query({ type: "COMMIT_SELECTION", payload: { selectors: ["#save"] } }),
    ).toBe(true)

    expect(selectCalls).toEqual([document.getElementById("save")])
    expect(selectedElement).toBe(document.getElementById("save"))
  })

  it("COMMIT_SELECTION of a set highlights the first element it names", () => {
    // There is one selection overlay, and the shell pins the first resolved
    // element as its primary. So a set commits its primary, exactly as the
    // multi-select read used to pin it.
    query({
      type: "COMMIT_SELECTION",
      payload: { selectors: ["#save", "#cancel"] },
    })

    expect(selectCalls).toEqual([document.getElementById("save")])
  })

  it("COMMIT_SELECTION skips a selector that does not resolve", () => {
    query({
      type: "COMMIT_SELECTION",
      payload: { selectors: ["#gone", "#cancel"] },
    })

    expect(selectCalls).toEqual([document.getElementById("cancel")])
  })

  it("an empty COMMIT_SELECTION clears the selection", () => {
    query({ type: "COMMIT_SELECTION", payload: { selectors: ["#save"] } })
    query({ type: "COMMIT_SELECTION", payload: { selectors: [] } })

    expect(clearCalls).toBe(1)
    expect(selectedElement).toBeNull()
  })

  it("a COMMIT_SELECTION that resolves nothing clears rather than leaving another element drawn", () => {
    query({ type: "COMMIT_SELECTION", payload: { selectors: ["#save"] } })
    query({ type: "COMMIT_SELECTION", payload: { selectors: ["#gone"] } })

    expect(clearCalls).toBe(1)
    expect(selectedElement).toBeNull()
  })

  it("COMMIT_SELECTION does not reply", () => {
    // The shell already holds the inspection it committed. A reply would be an
    // unsolicited ELEMENT_INSPECTED, which the shell installs unconditionally,
    // so the two would trade selections for no reason.
    query({ type: "COMMIT_SELECTION", payload: { selectors: ["#save"] } })
    query({ type: "COMMIT_SELECTION", payload: { selectors: [] } })

    expect(sent).toEqual([])
  })

  it("COMMIT_SELECTION with no usable payload clears", () => {
    query({ type: "COMMIT_SELECTION" })

    expect(selectCalls).toEqual([])
    expect(clearCalls).toBe(1)
  })
})
