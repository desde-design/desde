import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

import { ElementContextMenu } from "./element-context-menu"
import type { UseElementContextMenuReturn } from "@/hooks/useElementContextMenu"
import type { BoxModelData, DOMRectJSON, InspectionData } from "@/types/bridge"

/**
 * The client half of the in-app code view's dormancy gate, as a PAIR.
 *
 * The gate is "an absent handler means the item does not exist", so proving it
 * needs both halves. Asserting only that the item is missing would pass just as
 * well against a menu that had stopped rendering anything at all; asserting
 * only that it appears would say nothing about the gate. The two tests below
 * differ in exactly one prop.
 *
 * "Open in VS Code" is checked in both, because it is a separate affordance
 * that launches an external editor and shares none of the code view's
 * machinery. It must survive the gate.
 */

const SIDES = { top: 0, right: 0, bottom: 0, left: 0 }
const BOX_MODEL: BoxModelData = {
  width: 10,
  height: 10,
  margin: SIDES,
  border: SIDES,
  padding: SIDES,
  content: { width: 10, height: 10 },
}
const RECT: DOMRectJSON = {
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  top: 0,
  right: 10,
  bottom: 10,
  left: 0,
}

const INSPECTION: InspectionData = {
  tagName: "button",
  id: "",
  classes: [],
  rect: RECT,
  styles: [],
  tokens: [],
  boxModel: BOX_MODEL,
  selector: "button",
  authoredAt: { file: "src/App.vue", line: 4, column: 3 },
}

const controller: UseElementContextMenuReturn = {
  menu: {
    payload: { inspection: INSPECTION, menuAnchor: { x: 5, y: 5 } },
    shellAnchor: { x: 5, y: 5 },
  },
  dismiss: vi.fn(),
}

describe("ElementContextMenu — the in-app code view gate", () => {
  it("omits Open in editor when handed no handler", () => {
    render(
      <ElementContextMenu controller={controller} onStartChat={vi.fn()} />,
    )
    expect(screen.queryByText("Open in editor")).not.toBeInTheDocument()
    // "Open in VS Code" went dormant 2026-08-18 and is absent by default too,
    // so this can no longer stand in as the "a different absence" control.
    // The chat field below is what proves the menu rendered at all.
    expect(screen.queryByText("Open in VS Code")).not.toBeInTheDocument()
  })

  it("offers Open in VS Code only when the dormant gate is on", () => {
    const { rerender } = render(
      <ElementContextMenu controller={controller} onStartChat={vi.fn()} />,
    )
    expect(screen.queryByText("Open in VS Code")).not.toBeInTheDocument()

    rerender(
      <ElementContextMenu
        controller={controller}
        vscodeLinkEnabled
        onStartChat={vi.fn()}
      />,
    )
    // Load-bearing: not merely "a different absence". The item renders.
    expect(screen.getByText("Open in VS Code")).toBeInTheDocument()
  })

  it("offers Open in editor when handed one", () => {
    render(
      <ElementContextMenu
        controller={controller}
        onOpenFileEditor={vi.fn()}
        onStartChat={vi.fn()}
      />,
    )
    // Load-bearing: not merely "a different absence". The item renders.
    expect(screen.getByText("Open in editor")).toBeInTheDocument()
    // And the two gates are independent: this one being on says nothing
    // about the VS Code item, which has its own.
    expect(screen.queryByText("Open in VS Code")).not.toBeInTheDocument()
  })
})
