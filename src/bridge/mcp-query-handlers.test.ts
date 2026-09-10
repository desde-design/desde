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
 * Only the six members `handleMcpQuery` reaches on its inspector. The real
 * manager builds a shadow root and binds document listeners, none of which
 * this dispatcher touches.
 */
function fakeInspector(): InspectorOverlayManager {
  return {
    getSelectedElement: () => selectedElement,
    setSelectedElement: (el: Element) => {
      selectedElement = el
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
