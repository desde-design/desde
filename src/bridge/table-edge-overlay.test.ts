/**
 * One test for `TableEdgeOverlayManager`: the message it posts on right-click
 * names the document it was produced in.
 *
 * The overlay had no colocated test. This file is deliberately narrow, the
 * same way `drag-move-overlay.test.ts` is: it exists because the menu this
 * message opens submits a chat instruction built from THIS page's selectors,
 * so an open band menu that outlives its page would hand the departed page's
 * row to a write-capable chat turn. It is not an attempt to cover the band
 * geometry, the hit test or the clustering.
 *
 * jsdom has no layout, so the hit the manager would have computed is set on it
 * by hand. The alternative was faking a rect for every cell in a table and
 * still not exercising real hit-testing, since every rect would be 0x0.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { TableEdgeOverlayManager } from "./table-edge-overlay"

const TEST_DOCUMENT_ID = "doc-under-test"

const sent: { type: string; payload?: unknown }[] = []

beforeEach(() => {
  sent.length = 0
  document.body.innerHTML = `
    <table id="people" data-desde-src="src/App.vue:2:0">
      <tbody>
        <tr id="row-1" data-desde-src="src/App.vue:4:4"><td>Ada</td></tr>
      </tbody>
    </table>`
  configureBridgeRuntime({
    sendToShell: (message: { type: string; payload?: unknown }) =>
      void sent.push(message),
    inspectElement: () => ({}),
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

describe("table-edge-overlay — the band menu names its document", () => {
  it("stamps TABLE_EDGE_CONTEXT_MENU with the runtime's document id", () => {
    const container = document.getElementById("people")!
    const row = document.getElementById("row-1")!
    const overlay = new TableEdgeOverlayManager()
    overlay.activate()
    try {
      // The hit the manager would have computed from a real layout. `TableEdgeBandHit`
      // is module-private on purpose, so the cast names only the field being set.
      ;(overlay as unknown as { currentHit: unknown }).currentHit = {
        kind: "row",
        bandRect: { top: 0, left: 0, width: 100, height: 4 },
        containerEl: container,
        index: 0,
        totalBands: 1,
        targetEl: row,
        cellEls: Array.from(row.children),
      }
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 5,
          clientY: 5,
        }),
      )
    } finally {
      overlay.deactivate()
    }

    const menu = sent.find((m) => m.type === "TABLE_EDGE_CONTEXT_MENU")
    expect(menu).toBeDefined()
    expect((menu!.payload as { documentId?: unknown }).documentId).toBe(
      TEST_DOCUMENT_ID,
    )
    // The rest of the payload still arrives: a stamp that replaced the payload
    // would pass the line above and break the menu.
    expect((menu!.payload as { kind?: unknown }).kind).toBe("row")
  })
})
