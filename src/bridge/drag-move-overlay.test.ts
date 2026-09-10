/**
 * One test for `DragMoveOverlayManager`: the message it posts on drop names the
 * document it was produced in.
 *
 * The overlay had no colocated test at all — its round-trip is covered by the
 * live smoke harness (`tasks/scripts/bridge-smoke.mts`), and the feel of the
 * gesture is validated by dogfood. This file is deliberately narrow: it exists
 * because `DRAG_MOVE_COMMITTED` is a page-originated WRITE, and the rule that
 * such a message names its page needs a test that fails when the stamp is
 * dropped. It is not an attempt to cover the gesture.
 *
 * jsdom has no layout and no hit-testing, so `elementsFromPoint` is stubbed
 * with the stack a cursor over `#b` would really produce. Every rect is 0x0,
 * which the resolver handles: a zero-size hit falls to the "reorder beside it"
 * branch, so the destination container is `#list`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { DragMoveOverlayManager } from "./drag-move-overlay"

const TEST_DOCUMENT_ID = "doc-under-test"

const sent: { type: string; payload?: unknown }[] = []

/** Dispatch a synthetic pointer event the gesture's capture listeners see. */
function pointer(
  type: string,
  init: { clientX?: number; clientY?: number; target?: Element } = {},
): void {
  const { target, ...rest } = init
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...rest,
  }) as PointerEvent
  Object.defineProperty(event, "pointerId", { value: 1 })
  ;(target ?? document.body).dispatchEvent(event)
}

beforeEach(() => {
  sent.length = 0
  document.body.innerHTML = `
    <div id="list" data-desde-src="src/App.vue:2:0">
      <div id="a" data-desde-src="src/App.vue:3:2"></div>
      <div id="b" data-desde-src="src/App.vue:4:2"></div>
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

describe("drag-move-overlay — the drop names its document", () => {
  it("stamps DRAG_MOVE_COMMITTED with the runtime's document id", () => {
    const dragged = document.getElementById("a")!
    const over = document.getElementById("b")!
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [over, over.parentElement!, document.body],
    })

    const overlay = new DragMoveOverlayManager(() => dragged)
    overlay.activate()
    try {
      pointer("pointerdown", { clientX: 0, clientY: 0, target: dragged })
      pointer("pointermove", { clientX: 0, clientY: 40, target: dragged })
      pointer("pointerup", { clientX: 0, clientY: 40, target: dragged })
    } finally {
      overlay.deactivate()
    }

    const message = sent.find((m) => m.type === "DRAG_MOVE_COMMITTED")
    expect(message, "expected a DRAG_MOVE_COMMITTED").toBeDefined()
    expect(message!.payload).toMatchObject({
      sourceSelector: "#a",
      destParentSelector: "#list",
      documentId: TEST_DOCUMENT_ID,
    })
  })
})
