/**
 * One test for `ResizeOverlayManager`, on the same narrow footing as the other
 * two direct-manipulation overlays: `RESIZE_COMMITTED` is a page-originated
 * write, so it names the page it came from, and that stamp needs a test that
 * fails when it is dropped. Handle placement and quantization stay covered by
 * `resize-quantize.test.ts` and by bridge-smoke.
 *
 * The press must land on the overlay's own host element: a closed-shadow
 * pointerdown on the handle retargets to the host, which is how `arm` reads
 * "pressed the handle".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configureBridgeRuntime } from "./bridge-runtime"
import { ResizeOverlayManager } from "./resize-overlay"

const TEST_DOCUMENT_ID = "doc-under-test"

const sent: { type: string; payload?: unknown }[] = []

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
  document.body.innerHTML = `<div id="a" data-desde-src="src/App.vue:3:2"></div>`
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

describe("resize-overlay — the width commit names its document", () => {
  it("stamps RESIZE_COMMITTED with the runtime's document id", () => {
    const selected = document.getElementById("a") as HTMLElement
    const overlay = new ResizeOverlayManager(() => selected)
    overlay.activate()
    const host = document.querySelector('[data-prototype-flow="resize-overlay"]')!
    try {
      pointer("pointerdown", { clientX: 0, clientY: 0, target: host })
      pointer("pointermove", { clientX: 40, clientY: 0, target: host })
      pointer("pointerup", { clientX: 40, clientY: 0, target: host })
    } finally {
      overlay.deactivate()
    }

    const message = sent.find((m) => m.type === "RESIZE_COMMITTED")
    expect(message, "expected a RESIZE_COMMITTED").toBeDefined()
    expect(message!.payload).toMatchObject({
      selector: "#a",
      documentId: TEST_DOCUMENT_ID,
    })
  })
})
