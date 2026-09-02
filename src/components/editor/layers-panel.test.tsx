/**
 * Smoke tests for LayersPanel rendering and selection sync. Driven by
 * synthetic `OutlineNode` fixtures rather than a real bridge — the adapter
 * tests cover the postMessage round-trip separately.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { OutlineNode } from "@/types/bridge"
import { filterLayersByDensity } from "@/hooks/layers-density-filter"
import { LayersPanel } from "./layers-panel"

function makeRoots(): OutlineNode[] {
  return [
    {
      id: "n1",
      name: "div",
      type: "element",
      x: 0,
      y: 0,
      width: 800,
      height: 600,
      selector: "#root",
      children: [
        {
          id: "n2",
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
              id: "n3",
              name: "UiButton",
              type: "component",
              x: 16,
              y: 160,
              width: 100,
              height: 32,
              selector: '[data-testid="submit"]',
              componentFile: "/repo/node_modules/@acme/design-system/dist/UiButton.vue",
              packageName: "@acme/design-system",
            },
          ],
        },
      ],
    },
  ]
}

describe("LayersPanel", () => {
  it("renders a loading state when roots is null", () => {
    render(
      <LayersPanel
        roots={null}
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(screen.getByText(/Loading layers/i)).toBeInTheDocument()
  })

  it("renders an empty-state when roots is empty", () => {
    render(
      <LayersPanel
        roots={[]}
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(screen.getByText(/No elements detected/i)).toBeInTheDocument()
  })

  it("renders an error state with a Retry button when error is set and roots is null", () => {
    render(
      <LayersPanel
        roots={null}
        error
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(screen.getByText(/Couldn.t load the layer tree/i)).toBeInTheDocument()
    // The endless "Loading layers…" spinner must NOT show once we've failed.
    expect(screen.queryByText(/Loading layers/i)).not.toBeInTheDocument()
  })

  it("invokes onRefresh when the error-state Retry button is clicked", () => {
    const onRefresh = vi.fn()
    render(
      <LayersPanel
        roots={null}
        error
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={onRefresh}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }))
    expect(onRefresh).toHaveBeenCalled()
  })

  it("prefers the loading state over the error state while roots is null but no error", () => {
    render(
      <LayersPanel
        roots={null}
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(screen.getByText(/Loading layers/i)).toBeInTheDocument()
    expect(screen.queryByText(/Couldn.t load/i)).not.toBeInTheDocument()
  })

  it("renders root nodes and expands children on chevron click", () => {
    render(
      <LayersPanel
        roots={makeRoots()}
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    expect(screen.getByText("div")).toBeInTheDocument()
    // Children collapsed by default.
    expect(screen.queryByText("UiCard")).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText("Expand"))
    expect(screen.getByText("UiCard")).toBeInTheDocument()
  })

  it("invokes onSelect with the node's selector when a row is clicked", () => {
    const onSelect = vi.fn()
    render(
      <LayersPanel
        roots={makeRoots()}
        selectedSelector={null}
        onSelect={onSelect}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByText("div"))
    expect(onSelect).toHaveBeenCalledWith("#root")
  })

  it("auto-expands ancestors of the selected node", async () => {
    render(
      <LayersPanel
        roots={makeRoots()}
        selectedSelector='[data-testid="submit"]'
        onSelect={() => {}}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    // UiButton is two levels deep; both ancestors should auto-expand so it's
    // visible without manual chevron clicks.
    await waitFor(() => {
      expect(screen.getByText("UiButton")).toBeInTheDocument()
    })
  })

  it("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn()
    render(
      <LayersPanel
        roots={makeRoots()}
        selectedSelector={null}
        onSelect={() => {}}
        onRefresh={onRefresh}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Refresh layers"))
    expect(onRefresh).toHaveBeenCalled()
  })

  it("dispatches onHover with the selector on row enter and null on tree leave", () => {
    const onHover = vi.fn()
    render(
      <LayersPanel
        roots={makeRoots()}
        selectedSelector={null}
        onSelect={() => {}}
        onHover={onHover}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.mouseEnter(screen.getByText("div"))
    expect(onHover).toHaveBeenLastCalledWith("#root")

    fireEvent.mouseLeave(screen.getByRole("tree"))
    expect(onHover).toHaveBeenLastCalledWith(null)
  })

  // Drag-drop fixtures mirror the prop test shape, with editTarget set on
  // each node (V1 move dispatch requires data-desde-src-derived locations).
  function makeDraggableRoots(): OutlineNode[] {
    return [
      {
        id: "n1",
        name: "div",
        type: "element",
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children: [
          {
            id: "n2",
            name: "UiButton",
            type: "component",
            x: 0,
            y: 0,
            width: 100,
            height: 32,
            selector: "#a",
            editTarget: { file: "Demo.vue", line: 3, column: 5 },
          },
          {
            id: "n3",
            name: "UiButton",
            type: "component",
            x: 0,
            y: 32,
            width: 100,
            height: 32,
            selector: "#b",
            editTarget: { file: "Demo.vue", line: 4, column: 5 },
          },
        ],
      },
    ]
  }

  it("subtracts 1 from destIndex when same-parent and source sits before target (off-by-one regression)", () => {
    // [A, B, C] — drag A, drop AFTER B. Expected final = [B, A, C], which
    // means A's final index = 1, NOT 2 (the naive `targetIndex + 1`). Without
    // the fix, the panel would dispatch destIndex=2 → applicator places A at
    // the END → [B, C, A].
    const onMove = vi.fn()
    const roots: OutlineNode[] = [
      {
        id: "root",
        name: "div",
        type: "element",
        x: 0, y: 0, width: 100, height: 100,
        selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children: [
          { id: "a", name: "UiButton", type: "component", x: 0, y: 0, width: 50, height: 20, selector: "#a", editTarget: { file: "Demo.vue", line: 3, column: 5 } },
          { id: "b", name: "UiButton", type: "component", x: 0, y: 20, width: 50, height: 20, selector: "#b", editTarget: { file: "Demo.vue", line: 4, column: 5 } },
          { id: "c", name: "UiButton", type: "component", x: 0, y: 40, width: 50, height: 20, selector: "#c", editTarget: { file: "Demo.vue", line: 5, column: 5 } },
        ],
      },
    ]
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Expand"))
    const allUiButtons = screen.getAllByText("UiButton")
    const rowAButton = allUiButtons[0].closest("button") as HTMLButtonElement
    const rowBButton = allUiButtons[1].closest("button") as HTMLButtonElement

    rowBButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

    const dataTransfer: Partial<DataTransfer> = {
      setData: vi.fn(),
      getData: vi.fn(() => "a"),
    }
    fireEvent.dragStart(rowAButton, { dataTransfer })
    fireEvent.dragOver(rowBButton, { dataTransfer, clientY: 125 })
    fireEvent.drop(rowBButton, { dataTransfer, clientY: 125 })

    expect(onMove).toHaveBeenCalledTimes(1)
    expect(onMove.mock.calls[0][0].destIndex).toBe(1)
  })

  it("dispatches onMove with the right source/destParent/destIndex on drop-after", () => {
    const onMove = vi.fn()
    render(
      <LayersPanel
        roots={makeDraggableRoots()}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    // Expand the root so #a and #b are visible.
    fireEvent.click(screen.getByLabelText("Expand"))

    const allUiButtons = screen.getAllByText("UiButton")
    expect(allUiButtons.length).toBe(2)
    const rowAButton = allUiButtons[0].closest("button") as HTMLButtonElement
    const rowBButton = allUiButtons[1].closest("button") as HTMLButtonElement

    // Start dragging rowA, then drop AFTER rowB.
    const dataTransfer: Partial<DataTransfer> = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "n2"),
    }
    fireEvent.dragStart(rowAButton, { dataTransfer })

    // Simulate dragover on the bottom half of rowB to trigger position=after.
    rowBButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    fireEvent.dragOver(rowBButton, { dataTransfer, clientY: 125 })
    fireEvent.drop(rowBButton, { dataTransfer, clientY: 125 })

    expect(onMove).toHaveBeenCalledTimes(1)
    const payload = onMove.mock.calls[0][0]
    expect(payload.source.id).toBe("n2")
    expect(payload.destParent.id).toBe("n1")
    // Source (rowA, idx 0) is BEFORE target (rowB, idx 1) in the same parent,
    // so the post-removal final index is 1 (target's spot). The off-by-one
    // adjustment subtracts 1 from the naive `targetIndex + 1` = 2 → 1.
    expect(payload.destIndex).toBe(1)
  })

  it("refuses drop when source has no editTarget", () => {
    const onMove = vi.fn()
    const onMoveRefused = vi.fn()
    const roots = makeDraggableRoots()
    // Strip the source location off the first UiButton so drag is refused.
    delete roots[0].children![0].editTarget
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onMoveRefused={onMoveRefused}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Expand"))
    const allUiButtons = screen.getAllByText("UiButton")
    const rowAButton = allUiButtons[0].closest("button") as HTMLButtonElement
    const dataTransfer: Partial<DataTransfer> = {
      setData: vi.fn(),
      getData: vi.fn(),
    }
    fireEvent.dragStart(rowAButton, { dataTransfer })

    expect(onMoveRefused).toHaveBeenCalledWith("no-source-location")
    expect(onMove).not.toHaveBeenCalled()
  })

  it("refuses cross-file drops via onMoveRefused", () => {
    const onMove = vi.fn()
    const onMoveRefused = vi.fn()
    const roots = makeDraggableRoots()
    // Make the second UiButton's source location point at a different file.
    roots[0].children![1].editTarget = { file: "Other.vue", line: 4, column: 5 }
    // ALSO change root parent to Other.vue so that when we drop ON the second
    // button, the dest parent (root) and source (first button, Demo.vue)
    // disagree.
    roots[0].editTarget = { file: "Other.vue", line: 2, column: 3 }
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onMoveRefused={onMoveRefused}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Expand"))
    const allUiButtons = screen.getAllByText("UiButton")
    const rowAButton = allUiButtons[0].closest("button") as HTMLButtonElement
    const rowBButton = allUiButtons[1].closest("button") as HTMLButtonElement

    const dataTransfer: Partial<DataTransfer> = {
      setData: vi.fn(),
      getData: vi.fn(),
    }
    fireEvent.dragStart(rowAButton, { dataTransfer })
    rowBButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    // dragOver should be refused (different files), so drop becomes a no-op.
    fireEvent.dragOver(rowBButton, { dataTransfer, clientY: 125 })
    fireEvent.drop(rowBButton, { dataTransfer, clientY: 125 })

    // The dragOver refusal path goes silent; the drop path emits the refusal
    // because handleDrop runs the validation and calls onMoveRefused.
    expect(onMove).not.toHaveBeenCalled()
    expect(onMoveRefused).toHaveBeenCalledWith("different-file")
  })

  it("never offers position=inside on a void HTML element (e.g. <input>) — falls back to before/after", () => {
    // <input> is in the HTML void-element set, so even a cursor in the middle
    // of its row should resolve to "before"/"after", never "inside". This
    // mirrors apply-move-edit's self-closing refusal — we avoid letting the UI
    // suggest a drop that the applicator will then reject.
    const onMove = vi.fn()
    const roots: OutlineNode[] = [
      {
        id: "root", name: "div", type: "element",
        x: 0, y: 0, width: 100, height: 100,
        selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children: [
          { id: "a", name: "UiButton", type: "component", x: 0, y: 0, width: 50, height: 20, selector: "#a", editTarget: { file: "Demo.vue", line: 3, column: 5 } },
          { id: "voidInput", name: "input", type: "element", x: 0, y: 20, width: 100, height: 100, selector: "#i", editTarget: { file: "Demo.vue", line: 4, column: 5 } },
        ],
      },
    ]
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Expand"))
    const rowAButton = screen.getByText("UiButton").closest("button") as HTMLButtonElement
    const inputButton = screen.getByText("input").closest("button") as HTMLButtonElement

    // 100px-tall row, cursor in the middle (y=150 → offset=50). On a node
    // that CAN host children this would be "inside"; here it should be "after".
    inputButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

    const dataTransfer: Partial<DataTransfer> = { setData: vi.fn(), getData: vi.fn(() => "a") }
    fireEvent.dragStart(rowAButton, { dataTransfer })

    const dropEvt = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 150 })
    inputButton.dispatchEvent(dropEvt)

    expect(onMove).toHaveBeenCalledTimes(1)
    const payload = onMove.mock.calls[0][0]
    // Destination is the input's parent (root), not the input itself —
    // confirming the drop resolved as a sibling reorder, not nesting.
    expect(payload.destParent.id).toBe("root")
  })

  it("slot-aware: drop before a slot child resolves to the slot provider, not the rendered wrapper", () => {
    // Vue slot scenario:
    //   AIGatewayAgentCreate.vue authors <EntityFormBlock> with <UiInput>s
    //   inside its default slot. EntityFormBlock.vue's OWN template wraps
    //   the slot in an internal <div>. At runtime the rendered tree is:
    //     EntityFormBlock (callsite in AGAC.vue)
    //       └ div (authored in EntityFormBlock.vue) — RENDERED parent
    //         ├ UiInput (authored in AGAC.vue) ← slot content
    //         └ UiInput (authored in AGAC.vue)
    //
    // Dragging an element from AGAC.vue (the "toggle") onto position=before
    // the first UiInput must:
    //   (a) NOT refuse with "different-file" just because the rendered
    //       parent's file (EntityFormBlock.vue) doesn't match.
    //   (b) Resolve destParent UP through the wrapper to EntityFormBlock
    //       (whose editTarget IS in AGAC.vue, same as the slot children).
    //   (c) Use the target's index among same-file descendants of the
    //       effective parent — slot positional ordering, not the rendered
    //       wrapper's child index.
    const onMove = vi.fn()
    const onMoveRefused = vi.fn()
    const AGAC = "AIGatewayAgentCreate.vue"
    const EFB = "EntityFormBlock.vue"
    const roots: OutlineNode[] = [
      {
        id: "agacRoot", name: "div", type: "element",
        x: 0, y: 0, width: 100, height: 100, selector: "#root",
        editTarget: { file: AGAC, line: 2, column: 3 },
        children: [
          // The toggle — what the user drags. Authored in AGAC.vue.
          {
            id: "toggle", name: "div", type: "element",
            x: 0, y: 0, width: 100, height: 30, selector: "#toggle",
            editTarget: { file: AGAC, line: 6, column: 5 },
          },
          // EntityFormBlock — callsite in AGAC.vue. Rendered as the
          // wrapper component containing the slot.
          {
            id: "efb", name: "EntityFormBlock", type: "component",
            x: 0, y: 30, width: 100, height: 60, selector: "#efb",
            editTarget: { file: AGAC, line: 20, column: 9 },
            children: [
              // EFB's INTERNAL wrapper div — authored in EFB.vue. The
              // rendered parent of the slot children but NOT their
              // authored parent.
              {
                id: "wrap", name: "div", type: "element",
                x: 0, y: 0, width: 100, height: 60, selector: "#wrap",
                editTarget: { file: EFB, line: 3, column: 5 },
                children: [
                  // Slot children — authored in AGAC.vue.
                  {
                    id: "k1", name: "UiInput", type: "component",
                    x: 0, y: 0, width: 100, height: 30, selector: "#k1",
                    editTarget: { file: AGAC, line: 25, column: 11 },
                  },
                  {
                    id: "k2", name: "UiInput", type: "component",
                    x: 0, y: 30, width: 100, height: 30, selector: "#k2",
                    editTarget: { file: AGAC, line: 31, column: 11 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onMoveRefused={onMoveRefused}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    // Expand every level. getAllByLabelText only sees rows with a chevron
    // at the moment of the call; expanding reveals more rows with chevrons,
    // so loop until nothing collapsed remains.
    for (let pass = 0; pass < 5; pass++) {
      const collapsed = screen.queryAllByLabelText("Expand")
      if (collapsed.length === 0) break
      collapsed.forEach((btn) => fireEvent.click(btn))
    }

    const toggleButton = document.querySelector('button[title="#toggle"]') as HTMLButtonElement
    const k1Buttons = screen.getAllByText("UiInput")
    const k1Button = k1Buttons[0].closest("button") as HTMLButtonElement

    // Cursor at top quarter of k1 → position=before.
    k1Button.getBoundingClientRect = () =>
      ({ top: 100, bottom: 124, height: 24, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

    const dt: Partial<DataTransfer> = { setData: vi.fn(), getData: vi.fn(() => "toggle") }
    fireEvent.dragStart(toggleButton, { dataTransfer: dt })
    const dropEvt = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 102 })
    k1Button.dispatchEvent(dropEvt)

    expect(onMoveRefused).not.toHaveBeenCalled()
    expect(onMove).toHaveBeenCalledTimes(1)
    const payload = onMove.mock.calls[0][0]
    // destParent should resolve UP through the wrapper to EntityFormBlock,
    // NOT stop at the rendered "wrap" div.
    expect(payload.destParent.id).toBe("efb")
    // destIndex should be 0 — the toggle lands as the first slot child,
    // before k1, in EFB's source slot. Slot ordering = DOM ordering of
    // same-file descendants under EFB.
    expect(payload.destIndex).toBe(0)
  })

  it("drags across a row the density filter hid: destIndex is the source-order index, not the rendered-row index", () => {
    // The real tree shape: source-tag-plugin stamps EVERY template element,
    // so the density filter hides STAMPED rows too. Here `ghost` is a
    // stamped zero-size wrapper the `essentials` filter dissolves, hoisting
    // its two children:
    //
    //   raw:      root → [a, ghost → [x, y], c]     (source order: a, ghost, c)
    //   rendered: root → [a, x, y, c]
    //
    // Drag `a`, drop AFTER `c`. The applicator counts the destination
    // parent's SOURCE children — [a, ghost, c] — so the correct final index
    // is 2. Index math run against the rendered tree counts [a, x, y, c]
    // and dispatches 3 instead: a silent wrong-position move. This test
    // pins the raw-tree math; it fails when `parentByChildId` /
    // `collectSameFileDescendants` read `roots` instead of `rawRoots`.
    const onMove = vi.fn()
    const rawRoots: OutlineNode[] = [
      {
        id: "root", name: "div", type: "element",
        x: 0, y: 0, width: 800, height: 600, selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children: [
          { id: "a", name: "UiButton", type: "component", x: 0, y: 0, width: 100, height: 32, selector: "#a", editTarget: { file: "Demo.vue", line: 3, column: 5 } },
          {
            id: "ghost", name: "div", type: "element",
            x: 0, y: 32, width: 0, height: 0, selector: "#ghost",
            editTarget: { file: "Demo.vue", line: 4, column: 5 },
            children: [
              { id: "x", name: "span", type: "element", x: 0, y: 32, width: 50, height: 20, selector: "#x", editTarget: { file: "Demo.vue", line: 5, column: 7 } },
              { id: "y", name: "span", type: "element", x: 0, y: 52, width: 50, height: 20, selector: "#y", editTarget: { file: "Demo.vue", line: 6, column: 7 } },
            ],
          },
          { id: "c", name: "UiButton", type: "component", x: 0, y: 72, width: 100, height: 32, selector: "#c", editTarget: { file: "Demo.vue", line: 7, column: 5 } },
        ],
      },
    ]
    const roots = filterLayersByDensity(rawRoots, "essentials")
    // Precondition: the filter really did hide the stamped ghost and hoist
    // its children — otherwise this test is testing nothing.
    expect(roots[0].children!.map((n) => n.id)).toEqual(["a", "x", "y", "c"])

    render(
      <LayersPanel
        roots={roots}
        rawRoots={rawRoots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    fireEvent.click(screen.getByLabelText("Expand"))
    const uiButtons = screen.getAllByText("UiButton")
    const rowAButton = uiButtons[0].closest("button") as HTMLButtonElement
    const rowCButton = uiButtons[1].closest("button") as HTMLButtonElement

    // Cursor in the bottom band of row c → position=after.
    rowCButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect
    const dataTransfer: Partial<DataTransfer> = { setData: vi.fn(), getData: vi.fn(() => "a") }
    fireEvent.dragStart(rowAButton, { dataTransfer })
    const dropEvt = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 125 })
    rowCButton.dispatchEvent(dropEvt)

    expect(onMove).toHaveBeenCalledTimes(1)
    const payload = onMove.mock.calls[0][0]
    expect(payload.source.id).toBe("a")
    expect(payload.destParent.id).toBe("root")
    // Source-order final index: [a, ghost, c] → a after c = 2. The
    // rendered-row math would say 3.
    expect(payload.destIndex).toBe(2)
    // The destParent handed to the consumer must be the RAW node — its
    // children are the source-order child list, ghost included.
    expect(payload.destParent.children!.map((n: OutlineNode) => n.id)).toEqual([
      "a",
      "ghost",
      "c",
    ])
  })

  it("nests source as last child of target when dropped on its middle band (position=inside)", () => {
    // [root → [A, container → [X, Y]]]. Drag A onto the MIDDLE of container.
    // Expected: container becomes destParent, destIndex = container.children.length
    // = 2 (append after Y). Verifies the new 3-band "inside" drop zone.
    const onMove = vi.fn()
    const roots: OutlineNode[] = [
      {
        id: "root", name: "div", type: "element",
        x: 0, y: 0, width: 100, height: 100,
        selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children: [
          { id: "a", name: "UiButton", type: "component", x: 0, y: 0, width: 50, height: 20, selector: "#a", editTarget: { file: "Demo.vue", line: 3, column: 5 } },
          {
            id: "container", name: "UiCard", type: "component",
            x: 0, y: 20, width: 100, height: 60,
            selector: "#container",
            editTarget: { file: "Demo.vue", line: 4, column: 5 },
            children: [
              { id: "x", name: "KText", type: "component", x: 0, y: 0, width: 50, height: 20, selector: "#x", editTarget: { file: "Demo.vue", line: 5, column: 7 } },
              { id: "y", name: "KText", type: "component", x: 0, y: 20, width: 50, height: 20, selector: "#y", editTarget: { file: "Demo.vue", line: 6, column: 7 } },
            ],
          },
        ],
      },
    ]
    render(
      <LayersPanel
        roots={roots}
        selectedSelector={null}
        onSelect={() => {}}
        onMove={onMove}
        onRefresh={() => {}}
        refreshing={false}
      />,
    )
    // Expand root and container to surface the rows.
    const expandButtons = screen.getAllByLabelText("Expand")
    expandButtons.forEach((btn) => fireEvent.click(btn))

    const rowAButton = screen.getByText("UiButton").closest("button") as HTMLButtonElement
    const containerButton = screen.getByText("UiCard").closest("button") as HTMLButtonElement

    // 100px-tall row at top=100. clientY=150 → offset=50 → middle band (25..75%).
    containerButton.getBoundingClientRect = () =>
      ({ top: 100, bottom: 200, height: 100, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

    const dataTransfer: Partial<DataTransfer> = { setData: vi.fn(), getData: vi.fn(() => "a") }
    fireEvent.dragStart(rowAButton, { dataTransfer })

    // jsdom doesn't ship a working DragEvent, so testing-library's
    // fireEvent.drop strips clientY. Dispatch a MouseEvent (which jsdom DOES
    // support with clientY) of type "drop" — React's delegated listener picks
    // it up the same way.
    const dropEvt = new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 150 })
    containerButton.dispatchEvent(dropEvt)

    expect(onMove).toHaveBeenCalledTimes(1)
    const payload = onMove.mock.calls[0][0]
    expect(payload.source.id).toBe("a")
    expect(payload.destParent.id).toBe("container")
    expect(payload.destIndex).toBe(2)
  })

  describe("a rendered row absent from the raw tree", () => {
    /**
     * root → [a, b], both stamped. `a` is deliberately missing from the RAW
     * tree, which models the class of bug this guards: a rendered row whose
     * id the raw index does not know. Index math counted off the rendered
     * tree would splice at a position source never had, and say nothing.
     */
    function makeRootsWithUnmappedRow(): {
      roots: OutlineNode[]
      rawRoots: OutlineNode[]
    } {
      const a: OutlineNode = {
        id: "a", name: "UiButton", type: "component",
        x: 0, y: 0, width: 100, height: 32, selector: "#a",
        editTarget: { file: "Demo.vue", line: 3, column: 5 },
      }
      const b: OutlineNode = {
        id: "b", name: "UiButton", type: "component",
        x: 0, y: 32, width: 100, height: 32, selector: "#b",
        editTarget: { file: "Demo.vue", line: 4, column: 5 },
      }
      const root = (children: OutlineNode[]): OutlineNode => ({
        id: "root", name: "div", type: "element",
        x: 0, y: 0, width: 800, height: 600, selector: "#root",
        editTarget: { file: "Demo.vue", line: 2, column: 3 },
        children,
      })
      return { roots: [root([a, b])], rawRoots: [root([b])] }
    }

    it("REFUSES the move instead of falling back to the rendered node", () => {
      const onMove = vi.fn()
      const onMoveRefused = vi.fn()
      const { roots, rawRoots } = makeRootsWithUnmappedRow()
      render(
        <LayersPanel
          roots={roots}
          rawRoots={rawRoots}
          selectedSelector={null}
          onSelect={() => {}}
          onMove={onMove}
          onMoveRefused={onMoveRefused}
          onRefresh={() => {}}
          refreshing={false}
        />,
      )
      fireEvent.click(screen.getByLabelText("Expand"))
      const rows = screen.getAllByText("UiButton")
      const rowA = rows[0].closest("button") as HTMLButtonElement
      const rowB = rows[1].closest("button") as HTMLButtonElement
      rowB.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

      const dataTransfer: Partial<DataTransfer> = {
        setData: vi.fn(),
        getData: vi.fn(() => "a"),
      }
      fireEvent.dragStart(rowA, { dataTransfer })
      const dropEvt = new MouseEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientY: 125,
      })
      rowB.dispatchEvent(dropEvt)

      expect(onMove).not.toHaveBeenCalled()
      expect(onMoveRefused).toHaveBeenCalledWith("unmapped-row")
    })

    it("still anchors a conditional-group row through its members", () => {
      // The one rendered-only shape that is NOT a defect: a synthetic
      // `conditionalGroup` row exists in no raw tree by construction, and
      // anchors on the first member the raw tree does know.
      const onMove = vi.fn()
      const onMoveRefused = vi.fn()
      const member: OutlineNode = {
        id: "m1", name: "li", type: "element",
        x: 0, y: 32, width: 100, height: 20, selector: "#m1",
        editTarget: { file: "Demo.vue", line: 5, column: 7 },
      }
      const dragged: OutlineNode = {
        id: "drag", name: "UiButton", type: "component",
        x: 0, y: 0, width: 100, height: 32, selector: "#drag",
        editTarget: { file: "Demo.vue", line: 3, column: 5 },
      }
      const rawRoots: OutlineNode[] = [
        {
          id: "root", name: "div", type: "element",
          x: 0, y: 0, width: 800, height: 600, selector: "#root",
          editTarget: { file: "Demo.vue", line: 2, column: 3 },
          children: [dragged, member],
        },
      ]
      const roots: OutlineNode[] = [
        {
          ...rawRoots[0],
          children: [
            dragged,
            {
              id: "desde-group:Demo.vue:4:5",
              name: 'v-if="ready"',
              type: "element",
              x: 0, y: 32, width: 100, height: 20,
              selector: "__desde-group__Demo.vue:4:5",
              editTarget: { file: "Demo.vue", line: 4, column: 5 },
              conditionalGroup: { directive: "if", expression: "ready" },
              children: [member],
            },
          ],
        },
      ]
      render(
        <LayersPanel
          roots={roots}
          rawRoots={rawRoots}
          selectedSelector={null}
          onSelect={() => {}}
          onMove={onMove}
          onMoveRefused={onMoveRefused}
          onRefresh={() => {}}
          refreshing={false}
        />,
      )
      fireEvent.click(screen.getByLabelText("Expand"))
      const rowDrag = screen.getByText("UiButton").closest("button") as HTMLButtonElement
      const rowGroup = screen
        .getByText('v-if="ready"')
        .closest("button") as HTMLButtonElement
      rowGroup.getBoundingClientRect = () =>
        ({ top: 100, bottom: 130, height: 30, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect

      const dataTransfer: Partial<DataTransfer> = {
        setData: vi.fn(),
        getData: vi.fn(() => "drag"),
      }
      fireEvent.dragStart(rowDrag, { dataTransfer })
      const dropEvt = new MouseEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientY: 125,
      })
      rowGroup.dispatchEvent(dropEvt)

      expect(onMoveRefused).not.toHaveBeenCalled()
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(onMove.mock.calls[0][0].destParent.id).toBe("root")
    })

    it("gives a conditional-group row a readable tooltip, not the raw sentinel (F-07 regression)", () => {
      // A synthetic conditional-group row's `selector` is the
      // `__desde-group__<file>:<line>:<col>` sentinel (layers-conditional-groups.ts)
      // — an internal value, never meant to reach a person. It used to be
      // the row's native `title` tooltip verbatim, so hovering a `v-if`
      // cluster showed e.g. `__pt-group__src/views/AIGatewayDetails.vue:4:5`.
      // The tooltip must instead describe the row in plain terms.
      const member: OutlineNode = {
        id: "m1", name: "li", type: "element",
        x: 0, y: 32, width: 100, height: 20, selector: "#m1",
        editTarget: { file: "Demo.vue", line: 5, column: 7 },
      }
      const roots: OutlineNode[] = [
        {
          id: "root", name: "div", type: "element",
          x: 0, y: 0, width: 800, height: 600, selector: "#root",
          editTarget: { file: "Demo.vue", line: 2, column: 3 },
          children: [
            {
              id: "desde-group:Demo.vue:4:5",
              name: 'v-if="ready"',
              type: "element",
              x: 0, y: 32, width: 100, height: 20,
              selector: "__desde-group__Demo.vue:4:5",
              editTarget: { file: "Demo.vue", line: 4, column: 5 },
              conditionalGroup: { directive: "if", expression: "ready" },
              children: [member],
            },
          ],
        },
      ]
      render(
        <LayersPanel
          roots={roots}
          rawRoots={roots}
          selectedSelector={null}
          onSelect={() => {}}
          onRefresh={() => {}}
          refreshing={false}
        />,
      )
      fireEvent.click(screen.getByLabelText("Expand"))
      const groupRow = screen.getByText('v-if="ready"').closest("button") as HTMLButtonElement
      const title = groupRow.getAttribute("title") ?? ""
      expect(title).not.toContain("__desde-group__")
      expect(title).not.toContain("__pt-group__")
      expect(title).toBe("Conditional group · Demo.vue:4")
    })
  })

  describe("a selection the density filter hid", () => {
    /** raw: root → [wrapper → [leaf]]; rendered: root → [leaf's ancestor]. */
    function makeHiddenSelectionTree(): {
      roots: OutlineNode[]
      rawRoots: OutlineNode[]
    } {
      const rawRoots: OutlineNode[] = [
        {
          id: "root", name: "main", type: "element",
          x: 0, y: 0, width: 800, height: 600, selector: "#root",
          editTarget: { file: "Demo.vue", line: 2, column: 3 },
          children: [
            {
              id: "wrapper", name: "div", type: "element",
              x: 0, y: 0, width: 800, height: 600, selector: "#wrapper",
              editTarget: { file: "Demo.vue", line: 3, column: 5 },
              children: [
                {
                  id: "leaf", name: "span", type: "element",
                  x: 0, y: 0, width: 80, height: 20, selector: "#leaf",
                  editTarget: { file: "Demo.vue", line: 4, column: 7 },
                },
              ],
            },
          ],
        },
      ]
      const roots = filterLayersByDensity(rawRoots, "essentials")
      return { roots, rawRoots }
    }

    it("badges the stand-in row when the real selection is hidden", () => {
      const { roots, rawRoots } = makeHiddenSelectionTree()
      // Precondition: the wrapper really is hidden, so #wrapper is the only
      // thing left standing between #root and the (hoisted) leaf.
      expect(roots[0].children!.map((n) => n.id)).toEqual(["leaf"])
      render(
        <LayersPanel
          roots={roots}
          rawRoots={rawRoots}
          selectedSelector="#wrapper"
          onSelect={() => {}}
          onRefresh={() => {}}
          refreshing={false}
        />,
      )
      const badge = screen.getByTestId("layers-substituted-selection")
      expect(badge).toBeInTheDocument()
      // It sits on the row that IS being highlighted, not on some other row.
      expect(badge.closest("button")).toHaveAttribute("title", "#root")
    })

    it("shows no badge when the highlighted row IS the selection", () => {
      const { roots, rawRoots } = makeHiddenSelectionTree()
      render(
        <LayersPanel
          roots={roots}
          rawRoots={rawRoots}
          selectedSelector="#leaf"
          onSelect={() => {}}
          onRefresh={() => {}}
          refreshing={false}
        />,
      )
      expect(
        screen.queryByTestId("layers-substituted-selection"),
      ).not.toBeInTheDocument()
    })
  })
})
