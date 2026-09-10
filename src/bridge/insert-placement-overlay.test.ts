/**
 * One test for `InsertPlacementOverlayManager`, on the same narrow footing as
 * `drag-move-overlay.test.ts`: `INSERT_AT_POINT` is a page-originated write, so
 * it names the page it came from, and that stamp needs a test that fails when
 * it is dropped. The placement UX itself stays covered by bridge-smoke and by
 * dogfood.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { InsertPlacementOverlayManager } from "./insert-placement-overlay"

const TEST_DOCUMENT_ID = "doc-under-test"

const sent: { type: string; payload?: unknown }[] = []

beforeEach(() => {
  sent.length = 0
  document.body.innerHTML = `
    <div id="list" data-desde-src="src/App.vue:2:0">
      <div id="a" data-desde-src="src/App.vue:3:2"></div>
    </div>`
  configureBridgeRuntime({
    sendToShell: (message: { type: string; payload?: unknown }) => void sent.push(message),
    inspectElement: (el: Element) => ({ selector: `#${el.id}` }),
    attributeElement: (el: Element) => {
      const stamp = el.getAttribute?.("data-desde-src")
      if (!stamp) return undefined
      const [file, line, column] = stamp.split(":")
      return {
        editTarget: { file: file!, line: Number(line), column: Number(column) },
      } as never
    },
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

describe("insert-placement-overlay — the placement click names its document", () => {
  it("stamps INSERT_AT_POINT with the runtime's document id", () => {
    const over = document.getElementById("a")!
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [over, over.parentElement!, document.body],
    })

    const overlay = new InsertPlacementOverlayManager()
    overlay.enter("Button")
    try {
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 40,
      })
      over.dispatchEvent(click)
    } finally {
      overlay.exit()
    }

    const message = sent.find((m) => m.type === "INSERT_AT_POINT")
    expect(message, "expected an INSERT_AT_POINT").toBeDefined()
    expect(message!.payload).toMatchObject({
      // `intoChildless` is on for insert, so the childless `#a` under the
      // cursor is the container — "add the first child to an empty div".
      parentSelector: "#a",
      documentId: TEST_DOCUMENT_ID,
    })
  })
})
